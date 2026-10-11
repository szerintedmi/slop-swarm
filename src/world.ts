// A run's world time and budget, extensions included (docs/plans/2026-10-10-run-extension.md). Read-only helpers
// shared by the controller, CLI, dashboard and report; the controller applies extensions (controller/index.ts).
import type { Database } from "bun:sqlite";
import type { ExtensionRow, RunRow } from "./db/index.ts";

/** The `extend` control's arguments. All amounts are additions. `agentUsd["*"]` goes to every agent. */
export interface ExtendDetail {
  timeMs: number;
  swarmUsd: number;
  agentUsd: Record<string, number>;
}

/** "1h", "30m", "90s", "1h30m". */
export function parseDuration(text: string): number {
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(text.trim());
  const ms = m ? Number(m[1] ?? 0) * 3_600_000 + Number(m[2] ?? 0) * 60_000 + Number(m[3] ?? 0) * 1000 : 0;
  if (!(ms > 0)) throw new Error(`bad duration ${JSON.stringify(text)} (e.g. 1h, 30m, 1h30m)`);
  return Math.round(ms);
}

function usdAmount(text: string, flag: string): number {
  const v = Number(text);
  if (!text.trim() || !Number.isFinite(v) || v <= 0) throw new Error(`${flag}: expected a positive dollar amount, got ${JSON.stringify(text)}`);
  return v;
}

/** `[run] --time 1h --swarm-usd 2 --agent-usd 0.5 --agent-usd bramble=1` (also `--flag=value`). */
export function parseExtendArgs(args: string[]): { runId?: string; detail: ExtendDetail } {
  const detail: ExtendDetail = { timeMs: 0, swarmUsd: 0, agentUsd: {} };
  let runId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      if (runId !== undefined) throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
      runId = arg;
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--time") detail.timeMs += parseDuration(value);
    else if (flag === "--swarm-usd") detail.swarmUsd += usdAmount(value, flag);
    else if (flag === "--agent-usd") {
      const at = value.indexOf("=");
      const who = at >= 0 ? value.slice(0, at) : "*";
      detail.agentUsd[who] = (detail.agentUsd[who] ?? 0) + usdAmount(at >= 0 ? value.slice(at + 1) : value, flag);
    } else throw new Error(`unknown option ${flag}`);
  }
  if (!detail.timeMs && !detail.swarmUsd && !Object.keys(detail.agentUsd).length) throw new Error("nothing to extend: give --time, --swarm-usd and/or --agent-usd");
  return { runId, detail };
}

/** Parse a stored `extend` control detail; throws on anything malformed. */
export function parseExtendDetail(json: string | null): ExtendDetail {
  const d = JSON.parse(json ?? "null") as Partial<ExtendDetail> | null;
  const nonNeg = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!d || typeof d !== "object" || !nonNeg(d.timeMs ?? 0) || !nonNeg(d.swarmUsd ?? 0)) throw new Error("bad extend detail");
  const agentUsd = d.agentUsd ?? {};
  if (typeof agentUsd !== "object" || !Object.values(agentUsd).every(nonNeg)) throw new Error("bad extend detail: agentUsd");
  return { timeMs: d.timeMs ?? 0, swarmUsd: d.swarmUsd ?? 0, agentUsd };
}

const hm = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}` : m > 0 ? `${m}m` : `${Math.round(ms / 1000)}s`;
};

/** "world +1h; swarm +$2.00; every agent +$0.50; bramble +$1.00" */
export function describeExtension(d: ExtendDetail): string {
  const parts: string[] = [];
  if (d.timeMs) parts.push(`world +${hm(d.timeMs)}`);
  if (d.swarmUsd) parts.push(`swarm +$${d.swarmUsd.toFixed(2)}`);
  for (const [who, v] of Object.entries(d.agentUsd)) parts.push(`${who === "*" ? "every agent" : who} +$${v.toFixed(2)}`);
  return parts.join("; ");
}

export function extensionsOf(db: Database, runId: string): ExtensionRow[] {
  return db.query<ExtensionRow, [string]>("SELECT * FROM extensions WHERE run_id = ? ORDER BY id").all(runId);
}

/** Swarm budget added by extensions. */
export function extraSwarmUsd(db: Database, runId: string): number {
  return db.query<{ s: number }, [string]>("SELECT COALESCE(SUM(swarm_usd), 0) AS s FROM extensions WHERE run_id = ?").get(runId)!.s;
}

/**
 * The effective swarm budget: `budgets.swarm_usd` from the config snapshot (its first `# --- ` chunk is the
 * swarm file; read leniently so older snapshots still show it) plus extensions. Null if the snapshot has none.
 */
export function swarmBudgetUsd(db: Database, run: RunRow): number | null {
  let base: unknown;
  try {
    const chunks = run.config_yaml.split(/^# --- .*$/m).filter((c) => c.trim());
    base = (Bun.YAML.parse(chunks[0] ?? "") as { budgets?: { swarm_usd?: unknown } } | null)?.budgets?.swarm_usd;
  } catch {
    return null;
  }
  return typeof base === "number" ? base + extraSwarmUsd(db, run.id) : null;
}

export interface Segment {
  start: number;
  end: number;
}

/**
 * When the world was running: one segment per controller session, from `run_created`/`run_resumed` to
 * `run_finished`/`run_stopped` (after a crash, its last event). A live run's last segment ends now.
 */
export function worldSegments(db: Database, run: RunRow, now = Date.now()): Segment[] {
  const events = db.query<{ ts: number; kind: string; name: string | null }, [string]>("SELECT ts, kind, name FROM events WHERE run_id = ? ORDER BY ts, id").all(run.id);
  const segs: Segment[] = [];
  let cur: Segment | null = null;
  for (const e of events) {
    const marker = e.kind === "lifecycle" ? e.name : null;
    if (marker === "run_created" || marker === "run_resumed") {
      if (cur) segs.push(cur);
      cur = { start: e.ts, end: e.ts };
    } else if (cur) {
      cur.end = Math.max(cur.end, e.ts);
      if (marker === "run_finished" || marker === "run_stopped") {
        segs.push(cur);
        cur = null;
      }
    }
  }
  const live = run.status === "running" || run.status === "stopping";
  if (cur) segs.push({ start: cur.start, end: live ? Math.max(cur.end, now) : Math.max(cur.end, run.ended_at ?? cur.end) });
  if (!segs.length) segs.push({ start: run.started_at, end: live ? now : (run.ended_at ?? now) });
  return segs;
}

/** World time so far, and in total (so far plus what is left until the deadline). Gaps while stopped don't count. */
export function worldTime(db: Database, run: RunRow, now = Date.now()): { elapsedMs: number; totalMs: number; segments: Segment[] } {
  const segments = worldSegments(db, run, now);
  const elapsedMs = segments.reduce((s, g) => s + (g.end - g.start), 0);
  const lastEnd = segments.at(-1)!.end;
  return { elapsedMs, totalMs: elapsedMs + Math.max(0, run.deadline_at - lastEnd), segments };
}

/** The stretches between segments (the world was stopped). */
export function worldGaps(segments: Segment[]): Segment[] {
  return segments.slice(1).map((g, i) => ({ start: segments[i]!.end, end: g.start })).filter((g) => g.end > g.start);
}
