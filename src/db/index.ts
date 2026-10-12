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
  if (!has("requests", "vendor_cost_usd")) db.exec("ALTER TABLE requests ADD COLUMN vendor_cost_usd REAL");
  if (!has("requests", "vendor_provider")) db.exec("ALTER TABLE requests ADD COLUMN vendor_provider TEXT");
}

export interface RunRow {
  id: string;
  name: string;
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

export type ControlAction = "pause" | "unpause" | "wake" | "stop" | "kill" | "extend";

export function latestRun(db: Database): RunRow | null {
  return db.query<RunRow, []>("SELECT * FROM runs ORDER BY started_at DESC LIMIT 1").get();
}

export function getRun(db: Database, id?: string): RunRow | null {
  if (!id) return latestRun(db);
  return db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id);
}

export function enqueueControl(db: Database, runId: string, action: ControlAction, agent: string | null, source: string, detail: string | null = null) {
  db.query("INSERT INTO controls (run_id, agent, action, created_at, source, detail) VALUES (?, ?, ?, ?, ?, ?)").run(
    runId,
    agent,
    action,
    Date.now(),
    source,
    detail,
  );
}

/** Host directory layout for a run (plan §4.1). */
export function runDir(runId: string) {
  // Read the env at call time so tests can point runs at a temp dir.
  return join(dataDir(), "runs", runId);
}
export function agentDirs(runId: string, agent: string) {
  const base = join(runDir(runId), "agents", agent);
  return {
    base,
    home: join(base, "home"),
    self: join(base, "self"),
    runtime: join(base, "runtime"),
    raw: join(runDir(runId), "raw", agent),
  };
}
