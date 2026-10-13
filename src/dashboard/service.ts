// Host-side data service. Database/file handles never enter SvelteKit load results.
import { queueControl } from '../api.ts';
import { getRun, worldDirs, worldOf, type AgentRow, type ControlAction, type EventRow, type RequestRow, type RunRow, type WakeRow } from '../db/index.ts';
import type { AgentEvent, Harness, StreamParser } from '../types.ts';
import type { DashboardOptions } from './server.ts';
import { activity, agentsOf, overviewState, runLive, wakesOf, type TreeNode, type Activity } from './data.ts';
import { homeFile, homeTree } from './homes.ts';
import { diskUse } from '../backup.ts';
import { listWorlds } from '../controller/worlds.ts';
import { listAgentProfiles, listPresets, listSeeds } from '../config-db.ts';
import { DEFAULT_SEED } from '../config.ts';
import { bytes, isMarkdown } from './format.ts';
import { readFetchLog } from '../webfetch.ts';

const ACTIONS: readonly ControlAction[] = ['pause', 'unpause', 'wake', 'stop', 'kill'];
const AGENT_ACTIONS: readonly ControlAction[] = ['pause', 'unpause', 'wake'];
function visibleTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.filter(n => n.kind === 'file' || n.kind === 'dir' || n.truncated).map(n => n.children ? { ...n, children: visibleTree(n.children) } : n);
}
const countFiles = (nodes: TreeNode[]): number => nodes.reduce((n, x) => n + (x.kind === 'file' ? 1 : x.kind === 'dir' ? countFiles(x.children ?? []) : 0), 0);

// Send only display fields to the browser, never config/seed snapshots or host log paths.
function publicRun(run: RunRow) {
  const { id, name, status, started_at, deadline_at, ended_at, stop_reason, brief } = run;
  return { id, name, status, started_at, deadline_at, ended_at, stop_reason, brief, world: worldOf(run) };
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

/**
 * The forge link for the browser. The controller reaches a world's forge on its own loopback (`http://127.0.0.1:<port>`);
 * a browser elsewhere (the VPS's dashboard over the tailnet) gets the dashboard's own host with the forge's port, where
 * the forwarder also publishes it (SLOPSWARM_FORGE_PUBLISH).
 */
export function forgeLink(req: URL, local: string | null | undefined): string | null {
  if (!local) return null;
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (loopback.has(req.hostname) || !req.hostname) return local;
  try {
    const u = new URL(local);
    if (!loopback.has(u.hostname)) return local;
    u.hostname = req.hostname;
    return u.toString().replace(/\/$/, '');
  } catch { return local; }
}

export function createDashboardService(opts: DashboardOptions) {
  const { db } = opts;
  const readonly = !!opts.readonly;
  /** Launching and editing config need the controller service behind the API (not `just dash`). */
  const canWrite = !readonly && !!opts.api?.service;
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
      forgeUrl: run ? forgeLink(url, opts.forgeFor?.(worldOf(run)) ?? (opts.forge?.runId === run.id ? opts.forge.url : null)) : null,
      // Under 10% free on the data dir's disk: the header warns.
      diskLow: (() => { const d = diskUse(); return d && d.freeRatio < 0.1 ? { freeBytes: d.freeBytes, freeRatio: d.freeRatio } : null; })(),
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
      // Web fetches are free and not in the DB; the relay's log has them (src/webfetch.ts).
      const wakeRun = getRun(db, wake.run_id);
      const webFetches = wakeRun ? readFetchLog(worldDirs(worldOf(wakeRun)).fetchLog, wake.id).length : 0;
      return { kind: 'wake' as const, wake: publicWake(wake), webFetches, requests, unseen: requests.filter(r => !seen.has(r.request_id)), events, rawNote, parserError, live: wake.ended_at == null };
    }
    // Pages that aren't about one run: worlds, a world and its homes, config.
    if (path === '/worlds') {
      const worlds = listWorlds(db).map(w => ({ ...w, forgeUrl: forgeLink(url, opts.forgeFor?.(w.id)) }));
      return { kind: 'worlds' as const, worlds, presets: listPresets(db).map(p => p.name), readonly: !canWrite, live: false };
    }
    const wm2 = /^\/world\/([^/]+)$/.exec(path);
    if (wm2) {
      const id = decodeURIComponent(wm2[1]!);
      const world = listWorlds(db).find(w => w.id === id);
      if (!world) return { kind: 'missing' as const, status: 404, message: `world ${id}` };
      const runs = db.query<RunRow, [string]>('SELECT * FROM runs WHERE COALESCE(world_id, id) = ? ORDER BY started_at DESC').all(id).map(publicRun);
      const agent = url.searchParams.get('agent');
      let home = null;
      if (agent && world.agents.some(a => a.name === agent)) {
        const t = await homeTree(opts.host, id, agent);
        const tree = visibleTree(t.tree);
        const top = tree.filter(n => n.kind === 'file').sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
        const selected = url.searchParams.get('path') || (top.find(n => isMarkdown(n.name)) ?? top[0])?.name || '';
        const file = selected ? (await homeFile(t.source.live ? opts.host : undefined, id, agent, selected)).file : null;
        home = { agent, tree, fileCount: countFiles(tree), selected, file, source: t.source };
      }
      return { kind: 'world' as const, world: { ...world, forgeUrl: forgeLink(url, opts.forgeFor?.(id)) }, runs, home, presets: listPresets(db).map(p => p.name), readonly: !canWrite, live: !!world.activeRun };
    }
    if (path === '/config') {
      const t = url.searchParams.get('tab');
      const tab = t === 'agents' || t === 'seeds' ? t : 'presets';
      const edit = url.searchParams.get('edit');
      // Seeds: ?seed=<version id>, or ?name=<seed> (its active version; `+` is the new-seed form), else the default seed.
      const seedId = Number(url.searchParams.get('seed') ?? 0);
      const seedName = url.searchParams.get('name');
      const seeds = listSeeds(db);
      const seed = seeds.find(x => x.id === seedId)
        ?? (seedName ? seeds.find(x => x.name === seedName && x.active) : undefined)
        ?? seeds.find(x => x.name === DEFAULT_SEED && x.active) ?? seeds.find(x => x.active) ?? null;
      return {
        kind: 'config' as const, tab, edit,
        presets: listPresets(db), agents: listAgentProfiles(db),
        seeds: seeds.map(({ text: _t, ...x }) => x), seed, newSeed: seedName === '+',
        readonly: !canWrite, live: false,
      };
    }
    if (!run) return path === '/' ? { kind: 'empty' as const } : { kind: 'missing' as const, status: 404, message: 'no runs yet' };
    if (path === '/') return { kind: 'overview' as const, run: publicRun(run), state: overviewState(db, run), feed: publicActivity(activity(db, run, 80)), readonly, live: runLive(run) };
    if (path === '/agents') return { kind: 'agents' as const, run: publicRun(run), state: overviewState(db, run), live: runLive(run) };
    if (path === '/events') return { kind: 'events' as const, run: publicRun(run), events: db.query<EventRow, [string]>('SELECT * FROM events WHERE run_id = ? ORDER BY ts DESC, id DESC LIMIT 500').all(run.id), live: runLive(run) };
    if (path === '/file') {
      const name = url.searchParams.get('agent');
      if (!name || !agentsOf(db, run.id).some(a => a.name === name)) return { kind: 'missing' as const, status: 404, message: `agent ${name ?? '(none)'}` };
      const selected = url.searchParams.get('path') ?? '';
      const { file, source } = await homeFile(opts.host, worldOf(run), name, selected);
      return { kind: 'file' as const, run: publicRun(run), name, selected, file, homeSource: source, live: false };
    }
    const am = /^\/agent\/([^/]+)$/.exec(path);
    if (am) {
      const name = decodeURIComponent(am[1]!);
      const agent = db.query<AgentRow, [string, string]>('SELECT * FROM agents WHERE run_id = ? AND name = ?').get(run.id, name);
      if (!agent) return { kind: 'missing' as const, status: 404, message: `agent ${name}` };
      const wakes = wakesOf(db, run.id, name);
      const t = url.searchParams.get('tab');
      const tab = t === 'wakes' || t === 'memory' ? t : 'summary';
      const home = await homeTree(tab === 'memory' || tab === 'summary' ? opts.host : undefined, worldOf(run), name);
      const tree = visibleTree(home.tree);
      const top = tree.filter(n => n.kind === 'file').sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
      const selected = url.searchParams.get('path') || (top.find(n => isMarkdown(n.name)) ?? top[0])?.name || '';
      // Only the summary tab shows the cost curve, last words and feed.
      const summary = tab === 'summary';
      let cum = 0;
      const done = summary ? [...wakes].reverse().filter(w => w.ended_at != null) : [];
      const points = summary ? [{ t: run.started_at, v: 0 }, ...done.map(w => ({ t: w.ended_at!, v: cum += w.cost_usd }))] : [];
      const file = tab === 'memory' && selected ? (await homeFile(home.source.live ? opts.host : undefined, worldOf(run), name, selected)).file : null;
      return { kind: 'agent' as const, run: publicRun(run), agent, wakes: wakes.map(publicWake), tree: tab === 'memory' ? tree : [], fileCount: countFiles(tree), selected, tab, file, homeSource: home.source,
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
    // The no-JavaScript fallback of the dashboard's controls: the same checks and queue as the API (src/api.ts).
    try {
      queueControl(db, { run, action, agent, source: 'dashboard' });
    } catch (e) {
      return new Response((e as Error).message, { status: 400 });
    }
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
