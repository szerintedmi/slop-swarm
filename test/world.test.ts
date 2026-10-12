// Run extension: argument parsing, world time without the stopped gaps, the report's view of both.
import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db/index.ts";
import { renderReport } from "../src/report.ts";
import { parseDuration, parseExtendArgs, parseExtendDetail, swarmBudgetUsd, worldGaps, worldTime } from "../src/world.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const RUN = "20261010-1200-ext";

describe("extend arguments", () => {
  test("durations", () => {
    expect(parseDuration("1h")).toBe(60 * MIN);
    expect(parseDuration("30m")).toBe(30 * MIN);
    expect(parseDuration("1h30m")).toBe(90 * MIN);
    expect(parseDuration("90s")).toBe(90_000);
    for (const bad of ["", "10", "-1h", "0m", "1d"]) expect(() => parseDuration(bad)).toThrow();
  });

  test("flags add up; --agent-usd without a name goes to every agent", () => {
    expect(parseExtendArgs(["run-x", "--time", "1h", "--swarm-usd=2", "--agent-usd", "0.5", "--agent-usd", "bramble=1", "--time", "15m"])).toEqual({
      runId: "run-x",
      detail: { timeMs: 75 * MIN, swarmUsd: 2, agentUsd: { "*": 0.5, bramble: 1 } },
    });
    expect(parseExtendArgs(["--agent-usd=bramble=0.25"]).detail.agentUsd).toEqual({ bramble: 0.25 });
    expect(() => parseExtendArgs([])).toThrow("nothing to extend");
    expect(() => parseExtendArgs(["--agent-usd", "-1"])).toThrow("positive");
    expect(() => parseExtendArgs(["--swarm-usd"])).toThrow("needs a value");
    expect(() => parseExtendArgs(["--bogus", "1"])).toThrow("unknown option");
    expect(() => parseExtendArgs(["a", "b", "--time", "1h"])).toThrow("unexpected argument");
  });

  test("stored detail is validated", () => {
    expect(parseExtendDetail('{"timeMs":60000}')).toEqual({ timeMs: 60_000, swarmUsd: 0, agentUsd: {} });
    expect(() => parseExtendDetail(null)).toThrow();
    expect(() => parseExtendDetail('{"swarmUsd":-1}')).toThrow();
    expect(() => parseExtendDetail('{"agentUsd":{"x":"1"}}')).toThrow();
  });
});

describe("world time", () => {
  /** A 1-hour run that finished, was extended by an hour two hours later, and finished again. */
  function seed() {
    const db = openDb(":memory:");
    db.query(
      `INSERT INTO runs (id, name, config_yaml, seed_sha256, seed_text, pricing_yaml, status, started_at, deadline_at, ended_at)
       VALUES (?, 'ext', ?, 'abc', 'seed', 'models: {}', 'finished', ?, ?, ?)`,
    ).run(RUN, "# --- config/swarm.yaml\nbudgets: {swarm_usd: 4}\n", T0, T0 + 240 * MIN, T0 + 240 * MIN);
    const ev = db.query("INSERT INTO events (run_id, ts, kind, name, detail) VALUES (?, ?, 'lifecycle', ?, ?)");
    for (const [ts, name] of [
      [T0, "run_created"],
      [T0 + 30 * MIN, "wake_end"],
      [T0 + 60 * MIN, "run_finished"],
      [T0 + 170 * MIN, "forge_pull"], // after the end, before the resume: not world time
      [T0 + 180 * MIN, "run_resumed"],
      [T0 + 180 * MIN, "run_extended"],
      [T0 + 240 * MIN, "run_finished"],
    ] as const)
      ev.run(RUN, ts, name, null);
    db.query(
      `INSERT INTO extensions (run_id, ts, source, time_ms, old_deadline, new_deadline, swarm_usd, agent_usd_json)
       VALUES (?, ?, 'cli', ?, ?, ?, 2, '{"*":0.5}')`,
    ).run(RUN, T0 + 180 * MIN, 60 * MIN, T0 + 60 * MIN, T0 + 240 * MIN);
    db.query(
      `INSERT INTO agents (run_id, name, harness, model, effort, budget_usd, spent_usd, status, wake_count)
       VALUES (?, 'bramble', 'claude', 'claude-haiku-5-5', 'medium', 1.5, 0.4, 'sleeping', 2)`,
    ).run(RUN);
    const wake = db.query(
      `INSERT INTO wakes (run_id, agent, seq, trigger, started_at, ended_at, slept_ms, exit_reason, cost_usd, requests, fresh_input)
       VALUES (?, 'bramble', ?, 'timer', ?, ?, ?, 'completed', 0.2, 1, 100)`,
    );
    wake.run(RUN, 1, T0, T0 + 5 * MIN, null);
    // Went to sleep at +5m, woke after the resume: its sleep spans the gap.
    wake.run(RUN, 2, T0 + 181 * MIN, T0 + 185 * MIN, 176 * MIN);
    return db;
  }

  test("segments leave out the stretch while the run was stopped", () => {
    const db = seed();
    const run = db.query<import("../src/db/index.ts").RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(RUN)!;
    const w = worldTime(db, run, T0 + 300 * MIN);
    expect(w.segments).toEqual([
      { start: T0, end: T0 + 60 * MIN },
      { start: T0 + 180 * MIN, end: T0 + 240 * MIN },
    ]);
    expect(w.elapsedMs).toBe(120 * MIN);
    expect(w.totalMs).toBe(120 * MIN);
    expect(worldGaps(w.segments)).toEqual([{ start: T0 + 60 * MIN, end: T0 + 180 * MIN }]);
    expect(swarmBudgetUsd(db, run)).toBe(6);
  });

  test("a live run counts to now and shows what is left until the deadline", () => {
    const db = seed();
    db.query("UPDATE runs SET status = 'running', ended_at = NULL, deadline_at = ? WHERE id = ?").run(T0 + 300 * MIN, RUN);
    db.query("DELETE FROM events WHERE run_id = ? AND ts = ?").run(RUN, T0 + 240 * MIN);
    const run = db.query<import("../src/db/index.ts").RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(RUN)!;
    const w = worldTime(db, run, T0 + 200 * MIN);
    expect(w.elapsedMs).toBe(80 * MIN);
    expect(w.totalMs).toBe(80 * MIN + 100 * MIN);
  });

  test("report: world time, extensions, the effective budget, gap-spanning wakes flagged", () => {
    const report = renderReport(seed(), RUN, T0 + 300 * MIN);
    expect(report).toContain("world time 2.00 h (4.00 h wall clock; stopped 1 time(s) in between)");
    expect(report).toContain("## Extensions");
    expect(report).toContain("world +1h; swarm +$2.00; every agent +$0.50");
    expect(report).toContain("| **run** |  | 2 | $0.4000 | $6.00 | $0.2000 | finished |"); // $/hour over world time
    expect(report).toContain("1 wake(s) slept across a stop of the run");
  });
});
