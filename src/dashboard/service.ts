// Host-side data service. Database/file handles never enter SvelteKit load results.
import { agentDirs, enqueueControl, getRun, type AgentRow, type ControlAction, type EventRow, type RequestRow, type RunRow, type WakeRow } from '../db/index.ts';
import type { AgentEvent, Harness, StreamParser } from '../types.ts';
import type { DashboardOptions } from './server.ts';
import { activity, agentsOf, fileTree, overviewState, readSafeFile, runLive, wakesOf, type TreeNode, type Activity } from './data.ts';
import { bytes, isMarkdown } from './format.ts';

const ACTIONS: readonly ControlAction[] = ['pause', 'unpause', 'wake', 'stop', 'kill'];
const AGENT_ACTIONS: readonly ControlAction[] = ['pause', 'unpause', 'wake'];
function visibleTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.filter(n => n.kind === 'file' || n.kind === 'dir' || n.truncated).map(n => n.children ? { ...n, children: visibleTree(n.children) } : n);
}
const countFiles = (nodes: TreeNode[]): number => nodes.reduce((n, x) => n + (x.kind === 'file' ? 1 : x.kind === 'dir' ? countFiles(x.children ?? []) : 0), 0);

// Send only display fields to the browser, never config/seed snapshots or host log paths.
function publicRun(run: RunRow) {
  const { id, name, status, started_at, deadline_at, ended_at, stop_reason } = run;
  return { id, name, status, started_at, deadline_at, ended_at, stop_reason };
}
function publicWake(wake: WakeRow) {
  const { raw_log_path, container_name, ...display } = wake;
  return display;
}
function publicActivity(items: Activity[]) {
  return items.map(a => a.kind === 'wake' ? { ...a, wake: publicWake(a.wake) } : a);
}
export type DashboardActivity = ReturnType<typeof publicActivity>[number];

async function defaultParser(harness: Harness): Promise<StreamParser> {
  const { getAdapter } = await import('../harnesses/index.ts');
  return getAdapter(harness).newParser();
}

export function createDashboardService(opts: DashboardOptions) {
  const { db } = opts;
  const readonly = !!opts.readonly;
  function selectedRun(url: URL): RunRow | null {
    const wm = /^\/wake\/(\d+)$/.exec(url.pathname);
    const wake = wm ? db.query<WakeRow, [number]>('SELECT * FROM wakes WHERE id = ?').get(Number(wm[1])) : null;
    return getRun(db, wake?.run_id ?? url.searchParams.get('run') ?? opts.runId);
  }
  function nav(url: URL) {
    const run = selectedRun(url);
    return {
      runId: run?.id ?? null,
      runs: db.query<{ id: string; status: string }, []>('SELECT id, status FROM runs ORDER BY started_at DESC LIMIT 100').all(),
      readonly,
      live: !!run && runLive(run),
      forgeUrl: run && opts.forge?.runId === run.id ? opts.forge.url : null,
    };
  }
  // The raw log is parsed into the page but served on its own (GET /wake/<id>/raw) when opened.
  async function readRaw(wake: WakeRow): Promise<{ raw: string; rawNote: string }> {
    const cap = 2 * 1024 * 1024;
    if (!wake.raw_log_path) return { raw: '', rawNote: 'no raw log recorded' };
    try {
      const f = Bun.file(wake.raw_log_path);
      if (!await f.exists()) return { raw: '', rawNote: 'raw log file not found' };
      return { raw: await f.slice(0, cap).text(), rawNote: f.size > cap ? `showing first ${bytes(cap)} of ${bytes(f.size)}` : '' };
    } catch (err) { return { raw: '', rawNote: `could not read raw log: ${String(err)}` }; }
  }
  async function rawLog(id: number) {
    const wake = db.query<WakeRow, [number]>('SELECT * FROM wakes WHERE id = ?').get(id);
    if (!wake) return new Response(`wake ${id} not found`, { status: 404 });
    const { raw, rawNote } = await readRaw(wake);
    return new Response(raw || rawNote, { headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } });
  }
  async function page(url: URL) {
    const path = url.pathname;
    const run = selectedRun(url);
    const wm = /^\/wake\/(\d+)$/.exec(path);
    if (wm) {
      const wake = db.query<WakeRow, [number]>('SELECT * FROM wakes WHERE id = ?').get(Number(wm[1]));
      if (!wake) return { kind: 'missing' as const, status: 404, message: `wake ${wm[1]}` };
      const agent = agentsOf(db, wake.run_id).find(a => a.name === wake.agent);
      const requests = db.query<RequestRow, [number]>('SELECT * FROM requests WHERE wake_id = ? ORDER BY seq').all(wake.id);
      const { raw, rawNote } = await readRaw(wake);
      let parserError = '';
      let events: AgentEvent[] = [];
      if (raw && agent) {
        try {
          const parser = await (opts.parserFor ?? defaultParser)(agent.harness);
          for (const line of raw.split('\n')) if (line.trim()) events.push(...parser.push(line));
        } catch (err) { events = []; parserError = `transcript parser unavailable: ${String(err)}`; }
      }
      // Stream usage is an upsert: retain its final values and display once, at the first occurrence.
      const lastUsage = new Map(events.flatMap(e => e.kind === 'usage' ? [[e.usage.requestId, e] as const] : []));
      const seen = new Set<string>();
      events = events.flatMap<AgentEvent>(e => {
        if (e.kind !== 'usage') return [e];
        if (seen.has(e.usage.requestId)) return [];
        seen.add(e.usage.requestId);
        return [lastUsage.get(e.usage.requestId)!];
      });
      return { kind: 'wake' as const, wake: publicWake(wake), requests, unseen: requests.filter(r => !seen.has(r.request_id)), events, rawNote, parserError, live: wake.ended_at == null };
    }
    if (!run) return path === '/' ? { kind: 'empty' as const } : { kind: 'missing' as const, status: 404, message: 'no runs yet' };
    if (path === '/') return { kind: 'overview' as const, run: publicRun(run), state: overviewState(db, run), feed: publicActivity(activity(db, run, 80)), readonly, live: runLive(run) };
    if (path === '/agents') return { kind: 'agents' as const, run: publicRun(run), state: overviewState(db, run), live: runLive(run) };
    if (path === '/events') return { kind: 'events' as const, run: publicRun(run), events: db.query<EventRow, [string]>('SELECT * FROM events WHERE run_id = ? ORDER BY ts DESC, id DESC LIMIT 500').all(run.id), live: runLive(run) };
    if (path === '/file') {
      const name = url.searchParams.get('agent');
      if (!name || !agentsOf(db, run.id).some(a => a.name === name)) return { kind: 'missing' as const, status: 404, message: `agent ${name ?? '(none)'}` };
      const selected = url.searchParams.get('path') ?? '';
      const file = readSafeFile(agentDirs(run.id, name).home, selected);
      return { kind: 'file' as const, run: publicRun(run), name, selected, file, live: false };
    }
    const am = /^\/agent\/([^/]+)$/.exec(path);
    if (am) {
      const name = decodeURIComponent(am[1]!);
      const agent = db.query<AgentRow, [string, string]>('SELECT * FROM agents WHERE run_id = ? AND name = ?').get(run.id, name);
      if (!agent) return { kind: 'missing' as const, status: 404, message: `agent ${name}` };
      const wakes = wakesOf(db, run.id, name);
      const home = agentDirs(run.id, name).home;
      const tree = visibleTree(fileTree(home, 6, 1000, ['.git']) ?? []);
      const top = tree.filter(n => n.kind === 'file').sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
      const selected = url.searchParams.get('path') || (top.find(n => isMarkdown(n.name)) ?? top[0])?.name || '';
      const t = url.searchParams.get('tab');
      const tab = t === 'wakes' || t === 'memory' ? t : 'summary';
      // Only the summary tab shows the cost curve, last words and feed.
      const summary = tab === 'summary';
      let cum = 0;
      const done = summary ? [...wakes].reverse().filter(w => w.ended_at != null) : [];
      const points = summary ? [{ t: run.started_at, v: 0 }, ...done.map(w => ({ t: w.ended_at!, v: cum += w.cost_usd }))] : [];
      return { kind: 'agent' as const, run: publicRun(run), agent, wakes: wakes.map(publicWake), tree: tab === 'memory' ? tree : [], fileCount: countFiles(tree), selected, tab, file: tab === 'memory' && selected ? readSafeFile(home, selected) : null,
        points, lastSaid: summary ? overviewState(db, run).agents.find(a => a.name === name)?.lastSaid : undefined,
        feed: summary ? publicActivity(activity(db, run, 400).filter(a => 'agent' in a && a.agent === name).slice(0, 40)) : [], readonly, live: runLive(run) };
    }
    return { kind: 'missing' as const, status: 404, message: path };
  }
  async function control(req: Request) {
    if (readonly) return new Response('dashboard is read-only', { status: 403 });
    const url = new URL(req.url), site = req.headers.get('sec-fetch-site'), origin = req.headers.get('origin');
    if ((site && site !== 'same-origin' && site !== 'none') || (origin && (origin === 'null' || new URL(origin).origin !== url.origin))) return new Response('cross-site request refused', { status: 403 });
    const form = await req.formData();
    const action = String(form.get('action') ?? '') as ControlAction;
    const agent = form.get('agent') ? String(form.get('agent')) : null;
    const run = getRun(db, String(form.get('run') ?? '') || opts.runId);
    if (!run) return new Response('unknown run', { status: 400 });
    if (!ACTIONS.includes(action)) return new Response('unknown action', { status: 400 });
    if (agent) {
      if (!AGENT_ACTIONS.includes(action)) return new Response('action does not take an agent', { status: 400 });
      if (!agentsOf(db, run.id).some(a => a.name === agent)) return new Response('unknown agent', { status: 400 });
    } else if (AGENT_ACTIONS.includes(action)) return new Response('action needs an agent', { status: 400 });
    enqueueControl(db, run.id, action, agent, 'dashboard');
    const back = req.headers.get('referer');
    const fallback = agent ? `/agent/${encodeURIComponent(agent)}?run=${encodeURIComponent(run.id)}` : `/?run=${encodeURIComponent(run.id)}`;
    const ref = back ? new URL(back) : null;
    return new Response(null, { status: 303, headers: { location: ref?.origin === url.origin ? ref.pathname + ref.search : fallback } });
  }
  function state(url: URL) {
    const run = getRun(db, url.searchParams.get('run') ?? opts.runId);
    return run ? overviewState(db, run) : { run: null, agents: [], events: [] };
  }
  return { nav, page, rawLog, control, state };
}
export type DashboardService = ReturnType<typeof createDashboardService>;
export type DashboardPage = Awaited<ReturnType<DashboardService['page']>>;
export type PageOf<K extends DashboardPage['kind']> = Extract<DashboardPage, { kind: K }>;
