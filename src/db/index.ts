// SQLite access (bun:sqlite, WAL). Row types mirror schema.sql.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Harness } from "../types.ts";
import schemaSql from "./schema.sql" with { type: "text" };

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * The data folder (DB, runs, transcripts). Set SLOPSWARM_DATA_DIR in .env or the shell to use another
 * one, e.g. another worktree's data; relative paths are relative to the repo root, and a leading `~/` is
 * your home. Default: ./data.
 */
export function dataDir(): string {
  const v = process.env.SLOPSWARM_DATA_DIR?.trim();
  if (!v) return join(REPO_ROOT, "data");
  return resolve(REPO_ROOT, v === "~" || v.startsWith("~/") ? join(homedir(), v.slice(1)) : v);
}

export const DATA_DIR = dataDir();
export const DB_PATH = join(DATA_DIR, "swarm.db");
/** Where a running controller service says where it is (src/service.ts, src/api-client.ts). Read at call time (tests). */
export const serviceFile = () => join(dataDir(), "service.json");

export function openDb(path = DB_PATH, { readonly = false } = {}): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = readonly ? new Database(path, { readonly: true }) : new Database(path, { create: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  if (!readonly) {
    db.exec(schemaSql);
    migrate(db);
  }
  return db;
}

/** Columns added or renamed after a table was first created (CREATE TABLE IF NOT EXISTS doesn't change it). */
function migrate(db: Database): void {
  const has = (table: string, col: string) => db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (has("agents", "runtime")) db.exec("ALTER TABLE agents RENAME COLUMN runtime TO harness");
  if (!has("controls", "detail")) db.exec("ALTER TABLE controls ADD COLUMN detail TEXT");
  if (!has("controls", "result")) db.exec("ALTER TABLE controls ADD COLUMN result TEXT");
  if (!has("requests", "vendor_cost_usd")) db.exec("ALTER TABLE requests ADD COLUMN vendor_cost_usd REAL");
  if (!has("requests", "vendor_provider")) db.exec("ALTER TABLE requests ADD COLUMN vendor_provider TEXT");
  for (const col of ["world_id", "brief", "host_hash"]) if (!has("runs", col)) db.exec(`ALTER TABLE runs ADD COLUMN ${col} TEXT`);
  if (!has("worlds", "forge_port")) db.exec("ALTER TABLE worlds ADD COLUMN forge_port INTEGER");
  // Named seeds: every version before them is the `default` seed (the column's default), and its active one stays active.
  if (!has("seeds", "name")) db.exec("ALTER TABLE seeds ADD COLUMN name TEXT NOT NULL DEFAULT 'default'");
  db.exec("CREATE INDEX IF NOT EXISTS seeds_name ON seeds (name, active)");
  // Launch controls have no run yet: controls.run_id became nullable (SQLite can't drop NOT NULL in place).
  const runIdCol = db.query<{ name: string; notnull: number }, []>("PRAGMA table_info(controls)").all().find((c) => c.name === "run_id");
  if (runIdCol?.notnull) {
    db.transaction(() => {
      db.exec(`CREATE TABLE controls_new (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, agent TEXT, action TEXT NOT NULL,
        created_at INTEGER NOT NULL, consumed_at INTEGER, source TEXT, detail TEXT, result TEXT)`);
      db.exec("INSERT INTO controls_new (id, run_id, agent, action, created_at, consumed_at, source, detail, result) SELECT id, run_id, agent, action, created_at, consumed_at, source, detail, result FROM controls");
      db.exec("DROP TABLE controls");
      db.exec("ALTER TABLE controls_new RENAME TO controls");
    })();
  }
  runsToWorlds(db);
}

/**
 * Runs from before worlds (docs/plans/2026-10-12-hosted-control-plane.md §3.7) become worlds with the run's id, so
 * their forge hostnames don't change. Rows only; their dirs move with migrateWorldDirs.
 */
function runsToWorlds(db: Database): void {
  const orphans = db.query<RunRow, []>("SELECT * FROM runs WHERE world_id IS NULL").all();
  if (!orphans.length) return;
  db.transaction(() => {
    for (const r of orphans) {
      let image = DEFAULT_FORGE_IMAGE_FOR_MIGRATION;
      const m = /^\s*image:\s*(\S+)/m.exec(r.config_yaml.split(/^forge:/m)[1] ?? "");
      if (m) image = m[1]!;
      db.query("INSERT OR IGNORE INTO worlds (id, name, created_at, forge_image, status) VALUES (?, ?, ?, ?, 'idle')").run(r.id, r.name, r.started_at, image);
      db.query("UPDATE runs SET world_id = ? WHERE id = ?").run(r.id, r.id);
      for (const a of db.query<AgentRow, [string]>("SELECT * FROM agents WHERE run_id = ?").all(r.id))
        db.query("INSERT OR IGNORE INTO world_agents (world_id, name, harness, last_session_id, continue_next, home_generation, added_at) VALUES (?, ?, ?, ?, ?, 0, ?)").run(
          r.id, a.name, a.harness, a.last_session_id, a.continue_next, r.started_at,
        );
    }
  })();
}
const DEFAULT_FORGE_IMAGE_FOR_MIGRATION = "codeberg.org/forgejo/forgejo:16.0.4-rootless";

export interface RunRow {
  id: string;
  name: string;
  /** Null only between opening an old DB and its migration. */
  world_id: string | null;
  brief: string | null;
  host_hash: string | null;
  config_yaml: string;
  seed_sha256: string;
  seed_text: string;
  pricing_yaml: string;
  cli_versions: string | null;
  image_digest: string | null;
  status: "running" | "stopping" | "stopped" | "finished";
  stop_reason: string | null;
  started_at: number;
  deadline_at: number;
  ended_at: number | null;
}

export interface AgentRow {
  run_id: string;
  name: string;
  harness: Harness;
  model: string;
  effort: string;
  budget_usd: number;
  spent_usd: number;
  status: "active" | "sleeping" | "waking" | "paused" | "depleted" | "failed";
  next_wake_at: number | null;
  next_trigger: string | null;
  continue_next: number;
  last_session_id: string | null;
  last_wake_end: number | null;
  wake_count: number;
  consecutive_failures: number;
}

export interface WakeRow {
  id: number;
  run_id: string;
  agent: string;
  seq: number;
  trigger: string;
  started_at: number;
  ended_at: number | null;
  slept_ms: number | null;
  exit_reason: string | null;
  exit_code: number | null;
  turns: number | null;
  resumed: number;
  session_id: string | null;
  cost_usd: number;
  reported_cost_usd: number | null;
  requests: number;
  fresh_input: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  output: number;
  reasoning: number;
  web_searches: number;
  tool_calls: number;
  home_bytes: number | null;
  msgs_in: number;
  next_in_minutes: number | null;
  continue_requested: number | null;
  raw_log_path: string | null;
  container_name: string | null;
}

export interface RequestRow {
  id: number;
  wake_id: number;
  run_id: string;
  agent: string;
  seq: number;
  request_id: string;
  model: string;
  ts: string | null;
  fresh_input: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  output: number;
  reasoning: number;
  web_searches: number;
  prompt_tokens: number;
  tier: number;
  cost_usd: number;
  /** OpenRouter's charged cost and serving provider (cross-check); null when not looked up. */
  vendor_cost_usd: number | null;
  vendor_provider: string | null;
}

export interface EventRow {
  id: number;
  run_id: string;
  agent: string | null;
  wake_id: number | null;
  ts: number;
  kind: string;
  name: string | null;
  detail: string | null;
  ok: number | null;
}

export interface WorldRow {
  id: string;
  name: string;
  created_at: number;
  forge_image: string;
  status: "idle" | "active" | "archived";
  forge_port: number | null;
}

export interface WorldAgentRow {
  world_id: string;
  name: string;
  harness: Harness;
  last_session_id: string | null;
  continue_next: number;
  home_generation: number;
  added_at: number;
  removed_at: number | null;
}

export interface ExtensionRow {
  id: number;
  run_id: string;
  ts: number;
  source: string | null;
  time_ms: number;
  old_deadline: number;
  new_deadline: number;
  swarm_usd: number;
  agent_usd_json: string;
}

export type ControlAction = "pause" | "unpause" | "wake" | "stop" | "kill" | "extend" | "launch";

export function latestRun(db: Database): RunRow | null {
  return db.query<RunRow, []>("SELECT * FROM runs ORDER BY started_at DESC LIMIT 1").get();
}

export function getRun(db: Database, id?: string): RunRow | null {
  if (!id) return latestRun(db);
  return db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id);
}

export function enqueueControl(db: Database, runId: string | null, action: ControlAction, agent: string | null, source: string, detail: string | null = null): number {
  const r = db.query("INSERT INTO controls (run_id, agent, action, created_at, source, detail) VALUES (?, ?, ?, ?, ?, ?)").run(
    runId,
    agent,
    action,
    Date.now(),
    source,
    detail,
  );
  return Number(r.lastInsertRowid);
}

export interface ControlRow {
  id: number;
  run_id: string | null;
  agent: string | null;
  action: ControlAction;
  created_at: number;
  consumed_at: number | null;
  source: string | null;
  detail: string | null;
  result: string | null;
}

/** The world of a run (its own id for runs from before worlds). */
export const worldOf = (run: Pick<RunRow, "id" | "world_id">) => run.world_id ?? run.id;

/** Host directory layout for a run (plan §4.1): per run only transcripts (`raw/`) and pi's model entries. */
export function runDir(runId: string) {
  // Read the env at call time so tests can point runs at a temp dir.
  return join(dataDir(), "runs", runId);
}
export function agentDirs(runId: string, agent: string) {
  const base = join(runDir(runId), "agents", agent);
  return {
    /** Before worlds and the runner, the agent's dirs lived here (migrateWorldDirs moves them). */
    legacy: { base, home: join(base, "home"), self: join(base, "self"), runtime: join(base, "runtime") },
    raw: join(runDir(runId), "raw", agent),
  };
}

/** A world on the controller's side (§3.2): its forge, the agents' home backups, relay logs, forge logins. */
export function worldDir(world: string) {
  return join(dataDir(), "worlds", world);
}
export function worldDirs(world: string) {
  const base = worldDir(world);
  return {
    base,
    forge: join(base, "forge"),
    /** Mirrors of the relay's logs on the agent host (search.jsonl is billed; fetch.jsonl is counted). */
    relayLog: join(base, "relay", "search.jsonl"),
    fetchLog: join(base, "relay", "fetch.jsonl"),
    /** Agents' forge tokens (0600); never in a home backup. */
    secrets: join(base, "secrets"),
  };
}
/**
 * An agent's backup copy (§2.6): `current` is a symlink to `gens/<N>`, swapped in only after a complete pull, so an
 * interrupted pull never counts. `live/` mirrors the session files during a wake, for costing.
 */
export function worldAgentDirs(world: string, agent: string) {
  const base = join(worldDir(world), "agents", agent);
  return {
    base,
    current: join(base, "current"),
    gens: join(base, "gens"),
    home: join(base, "current", "home"),
    runtimeState: join(base, "current", "runtime-state"),
    live: join(base, "live"),
    forgeToken: join(worldDir(world), "secrets", "forge", `${agent}.token`),
  };
}

export function getWorld(db: Database, id: string): WorldRow | null {
  return db.query<WorldRow, [string]>("SELECT * FROM worlds WHERE id = ?").get(id);
}
export function worldAgents(db: Database, world: string): WorldAgentRow[] {
  return db.query<WorldAgentRow, [string]>("SELECT * FROM world_agents WHERE world_id = ? ORDER BY added_at, name").all(world);
}
