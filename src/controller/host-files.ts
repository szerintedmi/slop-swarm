// Files the controller keeps from the agent host (docs/plans/2026-10-12-hosted-control-plane.md §2.6):
// - mirrors by offset: a wake's session files (costing re-reads them every 5 s) and the world relay's logs;
// - the home backup: one complete copy per generation, swapped in only after a complete pull, pushed back to an
//   agent host whose generation is behind (a new VM, a lost disk).
import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { worldAgentDirs } from "../db/index.ts";
import type { AgentHost } from "../host/agent-host.ts";
import type { FileRef } from "../runner/protocol.ts";
import { RUNTIME_SYNC_DIRS } from "../runner/protocol.ts";
import { extractSnapshot, snapshotStream } from "../runner/snapshot.ts";

/** Generations kept on the VPS per agent (the current one included). */
export const KEEP_GENERATIONS = 2;

/**
 * Bring `local` up to the remote file: append what is new; if the remote file is shorter than the copy (it was
 * replaced), copy it again from the start. Returns false when the remote file doesn't exist.
 */
export function mirrorFile(host: AgentHost, ref: FileRef, local: string): Promise<boolean> {
  // One mirror per local file at a time: concurrent wakes share the world's relay log, and two appends of the same
  // bytes would duplicate lines.
  const prev = mirrors.get(local) ?? Promise.resolve(true);
  const next = prev.then(() => mirrorOnce(host, ref, local));
  // The queued tail never rejects (the caller handles `next`'s failure); otherwise a failed mirror would also be an
  // unhandled rejection here.
  const tail: Promise<boolean> = next.then(
    () => true,
    () => true,
  ).finally(() => {
    if (mirrors.get(local) === tail) mirrors.delete(local);
  });
  mirrors.set(local, tail);
  return next;
}
const mirrors = new Map<string, Promise<boolean>>();

async function mirrorOnce(host: AgentHost, ref: FileRef, local: string): Promise<boolean> {
  let have = statSync(local, { throwIfNoEntry: false })?.size ?? 0;
  for (;;) {
    const r = await host.read(ref, have);
    if (!r) return false;
    if (r.size < have) {
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, "");
      have = 0;
      continue;
    }
    if (r.data.length) {
      mkdirSync(dirname(local), { recursive: true });
      appendFileSync(local, r.data);
      have += r.data.length;
    }
    if (have >= r.size || !r.data.length) return true;
  }
}

/**
 * Mirror the session files of `sessionId` (every harness names its files after the session) from the agent's runtime
 * `sessionDir` into `liveDir/<sessionDir>/…`, the runtime dir `finalizeUsage` then reads.
 */
export async function mirrorSessionFiles(host: AgentHost, o: { world: string; agent: string; sessionDir: string; sessionId: string; liveDir: string }): Promise<number> {
  const entries = await host.list({ world: o.world, agent: o.agent, area: "runtime", path: o.sessionDir }, { depth: 6 });
  let n = 0;
  for (const e of entries) {
    if (e.kind !== "file" || !basename(e.path).includes(o.sessionId)) continue;
    const rel = `${o.sessionDir}/${e.path}`;
    const local = join(o.liveDir, rel);
    if ((statSync(local, { throwIfNoEntry: false })?.size ?? -1) === e.size) continue;
    if (await mirrorFile(host, { world: o.world, agent: o.agent, area: "runtime", path: rel }, local)) n++;
  }
  return n;
}

/** The generation the VPS copy is at (0: none yet), from the `current` link. */
export function backupGeneration(world: string, agent: string): number {
  try {
    const n = Number(basename(readlinkSync(worldAgentDirs(world, agent).current)));
    return Number.isInteger(n) ? n : 0;
  } catch {
    return 0;
  }
}

export interface PullResult {
  generation: number;
  bytes: number;
  warnings: string[];
}

/**
 * Pull the agent's home and session dirs into a new generation: extract into a temp dir, rename it to `gens/<N>`,
 * then swap `current` (the marker, written last). The agent host is told its generation only after that.
 */
export async function pullHome(host: AgentHost, db: Database, o: { world: string; agent: string; warnBytes?: number }): Promise<PullResult> {
  const d = worldAgentDirs(o.world, o.agent);
  const warnings: string[] = [];
  const info = await host.homeInfo(o.world, o.agent);
  if (info.unknownRuntime.length) warnings.push(`runtime has unknown entries (not synced): ${info.unknownRuntime.join(", ")}`);
  if (info.skipped?.length) warnings.push(`left out of the home sync (names that can't be synced): ${info.skipped.slice(0, 10).join(", ")}`);
  if (o.warnBytes !== undefined && info.bytes > o.warnBytes) warnings.push(`home is ${(info.bytes / 1048576).toFixed(1)} MB (warning above ${(o.warnBytes / 1048576).toFixed(0)} MB)`);
  const generation = Math.max(backupGeneration(o.world, o.agent), info.generation ?? 0) + 1;
  mkdirSync(d.gens, { recursive: true });
  const tmp = join(d.gens, `.pull-${generation}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp);
  let bytes: number;
  try {
    const { stream } = await host.pullHome(o.world, o.agent);
    bytes = await extractSnapshot(stream, tmp, ["home", ...RUNTIME_SYNC_DIRS.map((s) => `runtime/${s}`)]);
    mkdirSync(join(tmp, "home"), { recursive: true });
    // The VPS layout calls the synced runtime subset runtime-state.
    if (existsSync(join(tmp, "runtime"))) renameSync(join(tmp, "runtime"), join(tmp, "runtime-state"));
    else mkdirSync(join(tmp, "runtime-state"));
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  const final = join(d.gens, String(generation));
  rmSync(final, { recursive: true, force: true });
  renameSync(tmp, final);
  swapCurrent(d.current, `gens/${generation}`);
  db.query("UPDATE world_agents SET home_generation = ? WHERE world_id = ? AND name = ?").run(generation, o.world, o.agent);
  pruneGenerations(d.gens, generation);
  await host.setGeneration(o.world, o.agent, generation);
  return { generation, bytes, warnings };
}

/** Point `link` at `target` atomically (a new link renamed over the old one). */
function swapCurrent(link: string, target: string): void {
  const tmp = `${link}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

function pruneGenerations(gens: string, current: number): void {
  const all = readdirSync(gens)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n <= current)
    .sort((a, b) => b - a);
  for (const n of all.slice(KEEP_GENERATIONS)) rmSync(join(gens, String(n)), { recursive: true, force: true });
  // Pulls that never finished.
  for (const e of readdirSync(gens)) if (e.startsWith(".pull-")) rmSync(join(gens, e), { recursive: true, force: true });
}

/**
 * Push the VPS copy to the agent host when the host's generation is behind (or it has none: a new VM). Returns what
 * was done: null when nothing was needed.
 */
export async function pushHomeIfBehind(host: AgentHost, o: { world: string; agent: string }): Promise<{ generation: number } | null> {
  const ours = backupGeneration(o.world, o.agent);
  if (ours === 0) return null;
  const info = await host.homeInfo(o.world, o.agent);
  if (info.generation !== null && info.generation >= ours) return null;
  const d = worldAgentDirs(o.world, o.agent);
  const sources = [{ prefix: "home", dir: d.home }, ...RUNTIME_SYNC_DIRS.map((s) => ({ prefix: `runtime/${s}`, dir: join(d.runtimeState, s) }))];
  await host.pushHome(o.world, o.agent, ours, snapshotStream(sources, new Set()));
  return { generation: ours };
}

/** Make a generation from local dirs (migrating a run from before the runner): copies `home` and the runtime's session dirs. */
export async function seedBackup(o: { world: string; agent: string; home: string; runtime: string }): Promise<number> {
  const d = worldAgentDirs(o.world, o.agent);
  if (backupGeneration(o.world, o.agent) > 0) return backupGeneration(o.world, o.agent);
  mkdirSync(d.gens, { recursive: true });
  const tmp = join(d.gens, ".pull-seed");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  const sources = [{ prefix: "home", dir: o.home }, ...RUNTIME_SYNC_DIRS.map((s) => ({ prefix: `runtime/${s}`, dir: join(o.runtime, s) }))];
  await extractSnapshot(snapshotStream(sources, new Set()), tmp, ["home", ...RUNTIME_SYNC_DIRS.map((s) => `runtime/${s}`)]);
  mkdirSync(join(tmp, "home"), { recursive: true });
  if (existsSync(join(tmp, "runtime"))) renameSync(join(tmp, "runtime"), join(tmp, "runtime-state"));
  else mkdirSync(join(tmp, "runtime-state"));
  renameSync(tmp, join(d.gens, "1"));
  swapCurrent(d.current, "gens/1");
  return 1;
}

/** Whether `p` is a directory (not following a final symlink). */
export const isDir = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
