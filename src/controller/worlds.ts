// Worlds (docs/plans/2026-10-12-hosted-control-plane.md §3): listing, and moving runs from before worlds into the
// world layout. The DB side of that migration is in db/index.ts (runsToWorlds); this moves the files, once per run.
import type { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDirs, runDir, worldAgentDirs, worldDirs, type RunRow, type WorldAgentRow, type WorldRow } from "../db/index.ts";
import { runnerAgentDirs } from "../runner/runner.ts";
import { runnerDataDir } from "../runner/main.ts";
import { CODEX_AUTH_PATH } from "./index.ts";
import { seedBackup } from "./host-files.ts";
import { codexAgentAuthPath } from "./wake.ts";

const MARKER = ".moved-to-world";

function move(from: string, to: string): boolean {
  if (!existsSync(from) || existsSync(to)) return false;
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
  return true;
}

/**
 * Move each pre-world run's files into its world (same id): the forge, the relay logs, each agent's forge token and
 * Codex login, and its home: a first backup generation from it, and (with the runner on this machine) the dirs
 * themselves into the runner's data dir, marked as that generation. Returns what it did, one line per run.
 */
export async function migrateWorldDirs(db: Database, o: { localRunner?: boolean; codexAuthPath?: string } = {}): Promise<string[]> {
  const local = o.localRunner ?? !process.env.SLOPSWARM_RUNNER_URL?.trim();
  const out: string[] = [];
  const runs = db.query<RunRow, []>("SELECT * FROM runs WHERE world_id = id").all();
  for (const run of runs) {
    const base = runDir(run.id);
    if (!existsSync(base) || existsSync(join(base, MARKER))) continue;
    const world = run.id;
    const done: string[] = [];
    if (move(join(base, "forge"), worldDirs(world).forge)) done.push("forge");
    const logs = join(base, "search", "log");
    if (move(join(logs, "search.jsonl"), worldDirs(world).relayLog)) done.push("search log");
    if (move(join(logs, "fetch.jsonl"), worldDirs(world).fetchLog)) done.push("fetch log");
    const agents = db.query<{ name: string }, [string]>("SELECT name FROM agents WHERE run_id = ?").all(run.id);
    for (const { name } of agents) {
      const legacy = agentDirs(run.id, name).legacy;
      if (!existsSync(legacy.base)) continue;
      const token = join(legacy.runtime, "forge", "token");
      const wa = worldAgentDirs(world, name);
      if (existsSync(token) && !existsSync(wa.forgeToken)) {
        mkdirSync(dirname(wa.forgeToken), { recursive: true, mode: 0o700 });
        writeFileSync(wa.forgeToken, readFileSync(token), { mode: 0o600 });
        chmodSync(wa.forgeToken, 0o600);
      }
      const auth = join(legacy.runtime, "auth.json");
      const agentAuth = codexAgentAuthPath(o.codexAuthPath ?? CODEX_AUTH_PATH, world, name);
      if (existsSync(auth) && !existsSync(agentAuth)) {
        mkdirSync(dirname(agentAuth), { recursive: true, mode: 0o700 });
        copyFileSync(auth, agentAuth);
        chmodSync(agentAuth, 0o600);
      }
      mkdirSync(legacy.home, { recursive: true });
      mkdirSync(legacy.runtime, { recursive: true });
      const gen = await seedBackup({ world, agent: name, home: legacy.home, runtime: legacy.runtime });
      db.query("UPDATE world_agents SET home_generation = ? WHERE world_id = ? AND name = ?").run(gen, world, name);
      if (local) {
        const r = runnerAgentDirs(runnerDataDir(), world, name);
        if (move(legacy.home, r.home) && move(legacy.runtime, r.runtime)) {
          writeFileSync(r.generation, String(gen));
        }
      }
      rmSync(legacy.base, { recursive: true, force: true });
      done.push(name);
    }
    rmSync(join(base, "search"), { recursive: true, force: true });
    writeFileSync(join(base, MARKER), new Date().toISOString() + "\n");
    if (done.length) out.push(`run ${run.id} moved into world ${world}: ${done.join(", ")}`);
  }
  return out;
}

export interface WorldSummary extends WorldRow {
  runs: number;
  lastRunAt: number | null;
  activeRun: string | null;
  agents: WorldAgentRow[];
}

export function listWorlds(db: Database): WorldSummary[] {
  const worlds = db.query<WorldRow, []>("SELECT * FROM worlds ORDER BY created_at DESC").all();
  return worlds.map((w) => {
    const r = db
      .query<{ n: number; last: number | null }, [string]>("SELECT COUNT(*) AS n, MAX(started_at) AS last FROM runs WHERE COALESCE(world_id, id) = ?")
      .get(w.id)!;
    const active = db.query<{ id: string }, [string]>("SELECT id FROM runs WHERE COALESCE(world_id, id) = ? AND status IN ('running', 'stopping') LIMIT 1").get(w.id);
    const agents = db.query<WorldAgentRow, [string]>("SELECT * FROM world_agents WHERE world_id = ? ORDER BY added_at, name").all(w.id);
    return { ...w, runs: r.n, lastRunAt: r.last, activeRun: active?.id ?? null, agents };
  });
}
