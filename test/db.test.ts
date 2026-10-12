import { afterEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dataDir, openDb } from "../src/db/index.ts";

const saved = process.env.SLOPSWARM_DATA_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.SLOPSWARM_DATA_DIR;
  else process.env.SLOPSWARM_DATA_DIR = saved;
});

test("SLOPSWARM_DATA_DIR: ~ is the home dir, relative paths are relative to the repo root", () => {
  process.env.SLOPSWARM_DATA_DIR = "~/somewhere/data";
  expect(dataDir()).toBe(join(homedir(), "somewhere/data"));
  process.env.SLOPSWARM_DATA_DIR = "../other/data";
  expect(dataDir()).toBe(join(import.meta.dir, "..", "..", "other/data"));
  process.env.SLOPSWARM_DATA_DIR = "/abs/data";
  expect(dataDir()).toBe("/abs/data");
});

test("opening a DB from before the harness rename renames agents.runtime to harness, keeping the data", () => {
  const path = join(mkdtempSync(join(tmpdir(), "slopswarm-db-")), "swarm.db");
  const old = new Database(path, { create: true });
  old.exec(`CREATE TABLE agents (run_id TEXT NOT NULL, name TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL,
    budget_usd REAL NOT NULL, spent_usd REAL NOT NULL DEFAULT 0, status TEXT NOT NULL, next_wake_at INTEGER, next_trigger TEXT,
    continue_next INTEGER NOT NULL DEFAULT 0, last_session_id TEXT, last_wake_end INTEGER, wake_count INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (run_id, name))`);
  old.exec(`INSERT INTO agents (run_id, name, runtime, model, effort, budget_usd, status) VALUES ('r1', 'wren', 'codex', 'm', 'low', 1, 'active')`);
  old.close();
  openDb(path).close();
  const db = openDb(path, { readonly: true }); // what `just dash` opens after the migrating open
  expect(db.query("SELECT name, harness FROM agents").all()).toEqual([{ name: "wren", harness: "codex" }]);
  db.close();
  openDb(path).close(); // idempotent
});
