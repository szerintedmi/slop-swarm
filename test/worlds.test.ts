// Worlds and the agent host split (docs/plans/2026-10-12-hosted-control-plane.md §2, §3): runs in new and continued
// worlds, sessions carrying over, home pulls with generations (an interrupted one too) and pushes to a fresh agent
// host, the per-agent Codex login round trip, re-following a wake after a controller restart, and moving runs from
// before worlds into the world layout.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSwarm, parseSwarm, type SwarmConfig } from "../src/config.ts";
import { backupGeneration, mirrorFile, pullHome, pushHomeIfBehind } from "../src/controller/host-files.ts";
import { Controller, type ControllerOptions } from "../src/controller/index.ts";
import { createRun, WorldError } from "../src/controller/run.ts";
import { codexAgentAuthPath } from "../src/controller/wake.ts";
import { listWorlds, migrateWorldDirs } from "../src/controller/worlds.ts";
import { agentDirs, getWorld, openDb, worldAgentDirs, worldAgents, type AgentRow, type EventRow, type WakeRow } from "../src/db/index.ts";
import { RunnerHost, type AgentHost } from "../src/host/agent-host.ts";
import { runnerAgentDirs } from "../src/runner/runner.ts";
import { fakeAgentHost, silentLogger } from "./helpers/agent-host.ts";

const dataDir = mkdtempSync(join(tmpdir(), "slopswarm-worlds-"));
process.env.SLOPSWARM_DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
beforeEach(() => {
  for (const d of readdirSync(dataDir)) rmSync(join(dataDir, d), { recursive: true, force: true });
});

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);
const FIXTURE = readFileSync("test/fixtures/claude-tools.synthetic.jsonl", "utf8");
const SESSION = "11111111-2222-3333-4444-555555555555";
const CODEX = readFileSync("test/fixtures/codex-hi-rollout.jsonl", "utf8");

function config(agents: Record<string, "claude" | "codex"> = { bramble: "claude" }): SwarmConfig {
  const base = loadSwarm("config/smoke.yaml");
  const parsed = parseSwarm(
    {
      run: { name: "w", max_duration_min: 120 },
      agents: Object.keys(agents),
      budgets: { swarm_usd: 1, per_agent_usd: 0.5, per_wake: { max_usd: 0.1, max_turns: 10, timeout_min: 5 } },
      scheduler: { max_sleep_min: 15, max_concurrent_wakes: 1 },
    },
    (name) => (agents[name] === "codex" ? { name, harness: "codex", model: "gpt-6-luna", effort: "low" } : { name, harness: "claude", model: "claude-haiku-5-5", effort: "medium" }),
  );
  return { ...parsed, paths: base.paths, snapshot: "# --- test\n" };
}

function controller(db: ReturnType<typeof openDb>, runId: string, cfg: SwarmConfig, host: AgentHost, extra: Partial<ControllerOptions> = {}, wakeDeps: ControllerOptions["wakeDeps"] = {}) {
  const clock = { t: T0 };
  const ctl = new Controller(db, runId, cfg, {
    forge: { unread: async () => 0 },
    host,
    image: "slopswarm-agent:test",
    logger: silentLogger,
    now: () => clock.t,
    wakeDeps: { forgeToken: () => "forge-token", outputPollMs: 1, ...wakeDeps },
    ...extra,
  });
  return { ctl, clock };
}

const wakes = (db: ReturnType<typeof openDb>, runId: string, agent: string) =>
  db.query<WakeRow, [string, string]>("SELECT * FROM wakes WHERE run_id = ? AND agent = ? ORDER BY seq").all(runId, agent);
const agentRow = (db: ReturnType<typeof openDb>, runId: string, agent: string) =>
  db.query<AgentRow, [string, string]>("SELECT * FROM agents WHERE run_id = ? AND name = ?").get(runId, agent)!;

describe("worlds", () => {
  test("a new world takes the first run's id; continuing it carries sessions over and refuses a second active run", async () => {
    const db = openDb(":memory:");
    const cfg = config({ bramble: "claude", thistle: "claude" });
    const run1 = createRun(db, cfg, {}, T0);
    expect(getWorld(db, run1)).toMatchObject({ id: run1, status: "active", forge_image: cfg.forge.image });
    expect(worldAgents(db, run1).map((a) => a.name)).toEqual(["bramble", "thistle"]);
    expect(() => createRun(db, cfg, { world: run1 }, T0)).toThrow(WorldError);
    expect(() => createRun(db, cfg, { world: "nope" }, T0)).toThrow(/not found/);

    // Run 1: bramble's wake asks to continue its session.
    const host = fakeAgentHost({
      dataDir,
      behave: (agent) => {
        if (agent === "bramble") writeFileSync(join(host.dirs(run1, agent).home, "next_wake.yaml"), "in_minutes: 5\ncontinue_session: true\n");
        return FIXTURE;
      },
    });
    const a = controller(db, run1, cfg, host.host);
    a.ctl.repo.updateAgent("thistle", { status: "paused" });
    a.ctl.tick();
    await a.ctl.whenIdle();
    expect(worldAgents(db, run1).find((w) => w.name === "bramble")).toMatchObject({ last_session_id: SESSION, continue_next: 1, home_generation: 1 });
    a.ctl.repo.setRunStatus("stopped", "test");
    expect(getWorld(db, run1)!.status).toBe("idle");

    // Run 2 continues the world without thistle, with a brief: bramble resumes its session from run 1.
    const cfg2 = config({ bramble: "claude", wren: "claude" });
    const run2 = createRun(db, cfg2, { world: run1, brief: "bramble/pubrepo has open PRs" }, T0 + 60 * MIN);
    expect(agentRow(db, run2, "bramble")).toMatchObject({ last_session_id: SESSION, continue_next: 1 });
    expect(agentRow(db, run2, "wren")).toMatchObject({ last_session_id: null, continue_next: 0 });
    expect(worldAgents(db, run1).map((w) => [w.name, w.removed_at !== null])).toEqual([["bramble", false], ["thistle", true], ["wren", false]]);
    const b = controller(db, run2, cfg2, host.host);
    b.clock.t = T0 + 60 * MIN;
    b.ctl.repo.updateAgent("wren", { status: "paused" });
    b.ctl.tick();
    await b.ctl.whenIdle();
    const argv = host.argvs.at(-1)!;
    expect(argv[argv.indexOf("--resume") + 1]).toBe(SESSION);
    const note = argv[argv.indexOf("-p") + 1]!;
    expect(note).toStartWith("[Wake 1 at "); // the wake seq restarts per run
    expect(note).toContain("[Note from the operator: bramble/pubrepo has open PRs]");
    // The same forge hostname: saved git remotes in homes stay valid.
    expect(argv.find((x) => x.startsWith("FORGE_URL="))).toBe(`FORGE_URL=http://slopswarm-forge-${run1}:3000`);
    // Resumed across runs: the previous wake's totals (run 1) are the baseline, and run 1's request ids count as billed.
    const [w] = wakes(db, run2, "bramble");
    expect(w).toMatchObject({ resumed: 1, reported_cost_usd: 0 });
    expect(listWorlds(db)[0]).toMatchObject({ id: run1, runs: 2, activeRun: run2 });
  });

  test("home pulls: one generation per wake, two kept; an interrupted pull changes nothing; a fresh agent host gets the home pushed", async () => {
    const db = openDb(":memory:");
    const cfg = config();
    const runId = createRun(db, cfg, {}, T0);
    let n = 0;
    const host = fakeAgentHost({
      dataDir,
      behave: (agent) => {
        writeFileSync(join(host.dirs(runId, agent).home, "MEMORY.md"), `wake ${++n}\n`);
        // Claude Code's session transcript in the runtime dir.
        const projects = join(host.dirs(runId, agent).runtime, "projects", "-home-agent");
        mkdirSync(projects, { recursive: true });
        writeFileSync(join(projects, `${SESSION}.jsonl`), '{"type":"noop"}\n');
        return FIXTURE;
      },
    });
    const { ctl, clock } = controller(db, runId, cfg, host.host);
    for (let i = 0; i < 3; i++) {
      clock.t = T0 + i * 20 * MIN;
      ctl.tick();
      await ctl.whenIdle();
    }
    const wa = worldAgentDirs(runId, "bramble");
    expect(backupGeneration(runId, "bramble")).toBe(3);
    expect(readFileSync(join(wa.home, "MEMORY.md"), "utf8")).toBe("wake 3\n");
    expect(readdirSync(wa.gens).sort()).toEqual(["2", "3"]);
    // The session file came along (runtime-state), the forge login did not.
    expect(readFileSync(join(wa.runtimeState, "projects", "-home-agent", `${SESSION}.jsonl`), "utf8")).toBe('{"type":"noop"}\n');
    expect(existsSync(join(wa.runtimeState, "forge"))).toBe(false);
    const syncs = db.query<EventRow, []>("SELECT * FROM events WHERE name = 'home_sync' AND ok = 1").all();
    expect(syncs.map((e) => JSON.parse(e.detail!).generation)).toEqual([1, 2, 3]);
    expect((await host.host.homeInfo(runId, "bramble")).generation).toBe(3);

    // An interrupted pull: the stream is cut. Nothing changes, no temp dirs stay.
    const cut: AgentHost = Object.create(host.host);
    cut.pullHome = async (w, a) => {
      const full = new Uint8Array(await new Response((await host.host.pullHome(w, a)).stream).arrayBuffer());
      return { stream: new Blob([full.slice(0, full.length - 5)]).stream(), bytes: full.length };
    };
    writeFileSync(join(host.dirs(runId, "bramble").home, "MEMORY.md"), "unsynced\n");
    await expect(pullHome(cut, db, { world: runId, agent: "bramble" })).rejects.toThrow(/truncated/);
    expect(backupGeneration(runId, "bramble")).toBe(3);
    expect(readFileSync(join(wa.home, "MEMORY.md"), "utf8")).toBe("wake 3\n");
    expect(readdirSync(wa.gens).filter((e) => e.startsWith("."))).toEqual([]);
    expect((await host.host.homeInfo(runId, "bramble")).generation).toBe(3);

    // A new agent host (a fresh VM): its generation is behind, so the VPS copy is pushed; then nothing more.
    const fresh = fakeAgentHost({ dataDir: mkdtempSync(join(dataDir, "vm-")), behave: () => FIXTURE });
    expect(await pushHomeIfBehind(fresh.host, { world: runId, agent: "bramble" })).toEqual({ generation: 3 });
    expect(readFileSync(join(fresh.dirs(runId, "bramble").home, "MEMORY.md"), "utf8")).toBe("wake 3\n");
    expect(await pushHomeIfBehind(fresh.host, { world: runId, agent: "bramble" })).toBeNull();
    // The old agent host is ahead in content but at the same generation: not overwritten.
    expect(await pushHomeIfBehind(host.host, { world: runId, agent: "bramble" })).toBeNull();
    expect(readFileSync(join(host.dirs(runId, "bramble").home, "MEMORY.md"), "utf8")).toBe("unsynced\n");
  });

  test("codex: each agent gets its own copy of the login, kept on the agent host, fetched back after each wake", async () => {
    const db = openDb(":memory:");
    const cfg = config({ sorrel: "codex", wren: "codex" });
    const runId = createRun(db, cfg, {}, T0);
    const master = join(mkdtempSync(join(dataDir, "codex-")), "auth.json");
    writeFileSync(master, '{"v":"master"}');
    const seen: Record<string, string[]> = {};
    const host = fakeAgentHost({
      dataDir,
      behave: (agent) => {
        const auth = join(host.dirs(runId, agent).runtime, "auth.json");
        (seen[agent] ??= []).push(readFileSync(auth, "utf8"));
        // Codex rotates its token during the wake.
        writeFileSync(auth, `{"v":"${agent}-${seen[agent]!.length}"}`);
        return CODEX;
      },
    });
    const { ctl, clock } = controller(db, runId, cfg, host.host, {}, { codexAuthPath: master });
    for (let i = 0; i < 4; i++) {
      clock.t = T0 + i * 20 * MIN;
      ctl.tick();
      await ctl.whenIdle();
    }
    // Each saw the master first, then its own rotated copy (the agent host kept it; prepare sends it only if missing).
    expect(seen).toEqual({ sorrel: ['{"v":"master"}', '{"v":"sorrel-1"}'], wren: ['{"v":"master"}', '{"v":"wren-1"}'] });
    expect(readFileSync(codexAgentAuthPath(master, runId, "sorrel"), "utf8")).toBe('{"v":"sorrel-2"}');
    expect(readFileSync(codexAgentAuthPath(master, runId, "wren"), "utf8")).toBe('{"v":"wren-2"}');
    expect(readFileSync(master, "utf8")).toBe('{"v":"master"}');
    // A new VM gets the agent's latest copy, not the master.
    const fresh = fakeAgentHost({ dataDir: mkdtempSync(join(dataDir, "vm-")), behave: (agent) => ((seen[`vm-${agent}`] ??= []).push(readFileSync(join(fresh.dirs(runId, agent).runtime, "auth.json"), "utf8")), CODEX) });
    const c2 = controller(db, runId, cfg, fresh.host, {}, { codexAuthPath: master });
    c2.clock.t = T0 + 100 * MIN;
    c2.ctl.repo.updateAgent("wren", { status: "paused" });
    c2.ctl.repo.updateAgent("sorrel", { next_wake_at: c2.clock.t });
    c2.ctl.tick();
    await c2.ctl.whenIdle();
    expect(seen["vm-sorrel"]).toEqual(['{"v":"sorrel-2"}']);
  });

  test("a controller restart follows a running wake again instead of killing it", async () => {
    const db = openDb(":memory:");
    const cfg = config();
    const runId = createRun(db, cfg, {}, T0);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const agentHost = fakeAgentHost({ dataDir, behave: () => gate.then(() => FIXTURE) });
    // The first controller dies mid-wake: its runner calls hang from then on.
    let dead = false;
    const dying = new RunnerHost({ url: "http://runner.test", token: "test-runner-token", fetch: (req) => (dead ? new Promise<Response>(() => {}) : agentHost.runner.handle(req)) });
    const first = controller(db, runId, cfg, dying);
    first.ctl.tick();
    while (!agentHost.argvs.length) await Bun.sleep(1);
    dead = true;
    expect(wakes(db, runId, "bramble")[0]!.ended_at).toBeNull();

    // The new controller (a deploy): the runner still runs the wake, so it is followed, not killed or billed blind.
    const second = controller(db, runId, cfg, agentHost.host);
    await second.ctl.begin();
    release();
    await second.ctl.whenIdle();
    const [w] = wakes(db, runId, "bramble");
    expect(w).toMatchObject({ exit_reason: "completed", requests: 3, session_id: SESSION });
    expect(agentHost.kills).toEqual([]);
    expect(agentHost.argvs).toHaveLength(1);
    const names = db.query<EventRow, []>("SELECT * FROM events WHERE agent = 'bramble' AND kind = 'lifecycle' ORDER BY id").all().map((e) => e.name);
    expect(names).toContain("wake_refollow");
    expect(names).not.toContain("wake_recovered");
    expect(readFileSync(w!.raw_log_path!, "utf8")).toBe(FIXTURE.endsWith("\n") ? FIXTURE : FIXTURE + "\n");
  });

  test("runs from before worlds move into worlds of the same id: forge, relay logs, logins, a first home generation", async () => {
    const path = join(dataDir, "old.db");
    const db = openDb(path);
    const run = "20261010-0933-smoke-ab12";
    db.query(
      `INSERT INTO runs (id, name, config_yaml, seed_sha256, seed_text, pricing_yaml, status, started_at, deadline_at)
       VALUES (?, 'smoke', ?, 'x', 'seed', 'models: {}', 'finished', ?, ?)`,
    ).run(run, "# --- config/smoke.yaml\nforge:\n  image: forgejo:old\n", T0, T0 + MIN);
    db.query("UPDATE runs SET world_id = NULL WHERE id = ?").run(run);
    db.query(`INSERT INTO agents (run_id, name, harness, model, effort, budget_usd, status, last_session_id) VALUES (?, 'sorrel', 'codex', 'm', 'low', 1, 'sleeping', 'thread-1')`).run(run);
    db.close();
    // The old layout on disk.
    const legacy = agentDirs(run, "sorrel").legacy;
    for (const p of [join(legacy.home, "notes"), join(legacy.runtime, "forge"), join(legacy.runtime, "sessions"), join(dataDir, "runs", run, "forge"), join(dataDir, "runs", run, "search", "log")]) mkdirSync(p, { recursive: true });
    writeFileSync(join(legacy.home, "notes", "a.md"), "hello");
    writeFileSync(join(legacy.runtime, "forge", "token"), "tok\n");
    writeFileSync(join(legacy.runtime, "auth.json"), '{"v":"sorrel"}');
    writeFileSync(join(legacy.runtime, "sessions", "rollout-thread-1.jsonl"), "{}\n");
    writeFileSync(join(dataDir, "runs", run, "forge", "app.ini"), "x");
    writeFileSync(join(dataDir, "runs", run, "search", "log", "search.jsonl"), "{}\n");

    const db2 = openDb(path); // the DB side: a world row per run
    expect(getWorld(db2, run)).toMatchObject({ id: run, forge_image: "forgejo:old", status: "idle" });
    expect(worldAgents(db2, run)).toMatchObject([{ name: "sorrel", harness: "codex", last_session_id: "thread-1" }]);
    const codexAuthPath = join(dataDir, "secrets", "codex", "auth.json");
    const lines = await migrateWorldDirs(db2, { localRunner: true, codexAuthPath });
    expect(lines).toEqual([`run ${run} moved into world ${run}: forge, search log, sorrel`]);
    const wa = worldAgentDirs(run, "sorrel");
    expect(readFileSync(join(wa.home, "notes", "a.md"), "utf8")).toBe("hello");
    expect(readFileSync(join(wa.runtimeState, "sessions", "rollout-thread-1.jsonl"), "utf8")).toBe("{}\n");
    expect(existsSync(join(wa.runtimeState, "forge"))).toBe(false);
    expect(readFileSync(wa.forgeToken, "utf8")).toBe("tok\n");
    expect(readFileSync(codexAgentAuthPath(codexAuthPath, run, "sorrel"), "utf8")).toBe('{"v":"sorrel"}');
    expect(existsSync(join(dataDir, "worlds", run, "forge", "app.ini"))).toBe(true);
    expect(worldAgents(db2, run)[0]!.home_generation).toBe(1);
    // The local runner got the dirs, at that generation.
    const r = runnerAgentDirs(join(dataDir, "runner"), run, "sorrel");
    expect(readFileSync(join(r.home, "notes", "a.md"), "utf8")).toBe("hello");
    expect(readFileSync(join(r.runtime, "forge", "token"), "utf8")).toBe("tok\n");
    expect(readFileSync(r.generation, "utf8")).toBe("1");
    expect(existsSync(legacy.base)).toBe(false);
    expect(lstatSync(wa.current).isSymbolicLink()).toBe(true);
    // Once only.
    expect(await migrateWorldDirs(db2, { localRunner: true, codexAuthPath })).toEqual([]);
  });
});

describe("review fixes", () => {
  test("concurrent mirrors of one file append each byte once", async () => {
    const { mirrorFile } = await import("../src/controller/host-files.ts");
    const remote = new TextEncoder().encode('{"id":"s1"}\n{"id":"s2"}\n');
    const host = {
      read: async (_r: unknown, offset = 0) => {
        await Bun.sleep(5);
        return { data: remote.subarray(offset), size: remote.length };
      },
    } as unknown as AgentHost;
    const local = join(dataDir, "mirror-test.jsonl");
    await Promise.all([mirrorFile(host, { world: "w", relay: "search" }, local), mirrorFile(host, { world: "w", relay: "search" }, local), mirrorFile(host, { world: "w", relay: "search" }, local)]);
    expect(readFileSync(local, "utf8")).toBe('{"id":"s1"}\n{"id":"s2"}\n');
  });

  test("a runner that doesn't answer at restart: the wake is followed again, not closed", async () => {
    const db = openDb(":memory:");
    const cfg = config();
    const runId = createRun(db, cfg, {}, T0);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const agentHost = fakeAgentHost({ dataDir, behave: () => gate.then(() => FIXTURE) });
    let dead = false;
    const dying = new RunnerHost({ url: "http://runner.test", token: "test-runner-token", fetch: (req) => (dead ? new Promise<Response>(() => {}) : agentHost.runner.handle(req)) });
    const first = controller(db, runId, cfg, dying);
    first.ctl.tick();
    while (!agentHost.argvs.length) await Bun.sleep(1);
    dead = true;
    // The new controller's first status call fails (502), later ones work.
    let calls = 0;
    const flaky = new RunnerHost({
      url: "http://runner.test",
      token: "test-runner-token",
      fetch: async (req) => (new URL(req.url).pathname.startsWith("/v1/wakes/") && req.method === "GET" && calls++ === 0 ? new Response("{}", { status: 502 }) : agentHost.runner.handle(req)),
    });
    const second = controller(db, runId, cfg, flaky);
    await second.ctl.begin();
    release();
    await second.ctl.whenIdle();
    expect(wakes(db, runId, "bramble")[0]).toMatchObject({ exit_reason: "completed", requests: 3 });
  });

  test("a runner lost for good while a wake is followed again: the saved transcript stays and is billed", async () => {
    const db = openDb(":memory:");
    const cfg = config();
    const runId = createRun(db, cfg, {}, T0);
    const agentHost = fakeAgentHost({ dataDir, behave: () => null, hangOutput: FIXTURE });
    let dead = false;
    const dying = new RunnerHost({ url: "http://runner.test", token: "test-runner-token", fetch: (req) => (dead ? new Promise<Response>(() => {}) : agentHost.runner.handle(req)) });
    const first = controller(db, runId, cfg, dying);
    first.ctl.tick();
    const saved = FIXTURE.endsWith("\n") ? FIXTURE : FIXTURE + "\n";
    const rawLog = () => wakes(db, runId, "bramble")[0]?.raw_log_path;
    while (!rawLog() || !existsSync(rawLog()!) || readFileSync(rawLog()!, "utf8") !== saved) await Bun.sleep(1);
    dead = true;

    // The new controller never reaches the runner, past the wake's hard timeout.
    const gone = new RunnerHost({ url: "http://runner.test", token: "test-runner-token", fetch: async () => { throw new TypeError("connect ECONNREFUSED"); } });
    const second = controller(db, runId, cfg, gone);
    second.clock.t = T0 + 60 * MIN;
    await second.ctl.begin();
    await second.ctl.whenIdle();
    const [w] = wakes(db, runId, "bramble");
    expect(w!.ended_at).not.toBeNull();
    expect(readFileSync(w!.raw_log_path!, "utf8")).toBe(saved);
    expect(existsSync(`${w!.raw_log_path}.refollow`)).toBe(false);
    expect(w).toMatchObject({ requests: 3, session_id: SESSION });
    expect(w!.cost_usd).toBeGreaterThan(0);
  });

  test("continuing a world keeps its forge image (an upgrade isn't undone by the preset's)", () => {
    const db = openDb(":memory:");
    const cfg = config();
    const run1 = createRun(db, cfg, {}, T0);
    db.query("UPDATE runs SET status = 'stopped' WHERE id = ?").run(run1);
    db.query("UPDATE worlds SET status = 'idle', forge_image = 'codeberg.org/forgejo/forgejo:99.0.0-rootless' WHERE id = ?").run(run1);
    createRun(db, cfg, { world: run1 }, T0 + MIN);
    expect(getWorld(db, run1)).toMatchObject({ status: "active", forge_image: "codeberg.org/forgejo/forgejo:99.0.0-rootless" });
  });

  test("a file the snapshot can't carry is left out with a warning, not a failed pull", async () => {
    const db = openDb(":memory:");
    const cfg = config();
    const runId = createRun(db, cfg, {}, T0);
    const host = fakeAgentHost({
      dataDir,
      behave: (agent) => {
        writeFileSync(join(host.dirs(runId, agent).home, "C:\\tmp\\x"), "odd");
        writeFileSync(join(host.dirs(runId, agent).home, "ok.md"), "fine");
        return FIXTURE;
      },
    });
    const { ctl } = controller(db, runId, cfg, host.host);
    ctl.tick();
    await ctl.whenIdle();
    expect(backupGeneration(runId, "bramble")).toBe(1);
    expect(readFileSync(join(worldAgentDirs(runId, "bramble").home, "ok.md"), "utf8")).toBe("fine");
    const warn = db.query<EventRow, []>("SELECT * FROM events WHERE name = 'home_sync' AND ok = 0").all();
    expect(warn.map((e) => e.detail).join()).toContain("left out of the home sync");
  });
});

describe("runner outages (review follow-ups)", () => {
  const CODEX_STREAM_HEAD = '{"type":"thread.started","thread_id":"01a12507-767d-7fb1-bfb5-ede93d67f174"}\n{"type":"turn.started"}\n';
  const CODEX_SESSION = "01a12507-767d-7fb1-bfb5-ede93d67f174";
  /** Before the rollout fixture's timestamps, so its records count as this wake's. */
  const T1 = Date.UTC(2026, 9, 10, 8, 50, 0);

  test("a lost start response: the wake is followed, not closed with a container left running", async () => {
    const db = openDb(":memory:");
    const cfg = config();
    const runId = createRun(db, cfg, {}, T0);
    const agentHost = fakeAgentHost({ dataDir, behave: () => FIXTURE });
    // The runner gets the start, but its reply never arrives.
    const lossy = new RunnerHost({
      url: "http://runner.test",
      token: "test-runner-token",
      fetch: async (req) => {
        if (req.method === "POST" && new URL(req.url).pathname === "/v1/wakes") {
          await agentHost.runner.handle(req);
          throw new TypeError("socket hang up");
        }
        return agentHost.runner.handle(req);
      },
    });
    const { ctl } = controller(db, runId, cfg, lossy);
    ctl.tick();
    await ctl.whenIdle();
    expect(agentHost.argvs).toHaveLength(1);
    expect(agentHost.kills).toEqual([]);
    const [w] = wakes(db, runId, "bramble");
    expect(w).toMatchObject({ exit_reason: "completed", requests: 3 });
    expect(w!.cost_usd).toBeGreaterThan(0);
    expect(db.query<EventRow, [number]>("SELECT * FROM events WHERE wake_id = ? AND name = 'runner'").all(w!.id).map((e) => e.detail)).toEqual([expect.stringContaining("start not confirmed")]);
  });

  test("a start that never reached the runner: the wake ends as an error, nothing runs", async () => {
    const db = openDb(":memory:");
    const cfg = config();
    const runId = createRun(db, cfg, {}, T0);
    const agentHost = fakeAgentHost({ dataDir, behave: () => FIXTURE });
    const dropped = new RunnerHost({
      url: "http://runner.test",
      token: "test-runner-token",
      fetch: async (req) => {
        if (req.method === "POST" && new URL(req.url).pathname === "/v1/wakes") throw new TypeError("connect ECONNREFUSED");
        return agentHost.runner.handle(req);
      },
    });
    const { ctl } = controller(db, runId, cfg, dropped);
    ctl.tick();
    await ctl.whenIdle();
    expect(agentHost.argvs).toHaveLength(0);
    const [w] = wakes(db, runId, "bramble");
    expect(w).toMatchObject({ exit_reason: "error", requests: 0 });
    expect(agentRow(db, runId, "bramble")).toMatchObject({ status: "sleeping", consecutive_failures: 1 });
  });

  test("a runner lost right after the wake: the session files mirrored during it are still billed", async () => {
    const db = openDb(":memory:");
    const cfg = config({ sorrel: "codex" });
    const runId = createRun(db, cfg, {}, T1);
    const master = join(mkdtempSync(join(dataDir, "codex-")), "auth.json");
    writeFileSync(master, "{}");
    // Codex hangs mid-turn (no streamed totals yet), with its rollout on the agent host.
    const agentHost = fakeAgentHost({
      dataDir,
      hangOutput: CODEX_STREAM_HEAD,
      behave: (agent) => {
        const sessions = join(agentHost.dirs(runId, agent).runtime, "sessions");
        mkdirSync(sessions, { recursive: true });
        writeFileSync(join(sessions, `rollout-2026-10-10T08-56-49-${CODEX_SESSION}.jsonl`), CODEX);
        return null;
      },
    });
    let cut = false;
    const flaky = new RunnerHost({
      url: "http://runner.test",
      token: "test-runner-token",
      fetch: async (req) => {
        const u = new URL(req.url);
        if (cut && (u.pathname === "/v1/list" || (u.pathname === "/v1/read" && u.searchParams.get("area") === "runtime"))) throw new TypeError("connect ECONNREFUSED");
        return agentHost.runner.handle(req);
      },
    });
    const { ctl, clock } = controller(db, runId, cfg, flaky, {}, { codexAuthPath: master, livePollMs: 5 });
    clock.t = T1;
    ctl.tick();
    const mirrored = join(worldAgentDirs(runId, "sorrel").live, "sessions", `rollout-2026-10-10T08-56-49-${CODEX_SESSION}.jsonl`);
    while (!existsSync(mirrored) || readFileSync(mirrored, "utf8") !== CODEX) await Bun.sleep(1);
    cut = true;
    await ctl.emergencyKill("test");
    await ctl.whenIdle();
    const [w] = wakes(db, runId, "sorrel");
    expect(w!.exit_reason).toBe("stopped");
    expect(w!.requests).toBeGreaterThan(0);
    expect(w!.cost_usd).toBeGreaterThan(0);
    expect(db.query<EventRow, [number]>("SELECT * FROM events WHERE wake_id = ? AND name = 'mirror'").all(w!.id)).toHaveLength(1);
  });

  test("a failed mirror rejects its caller only, never as an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const host = { read: async () => { throw new Error("boom"); } } as unknown as AgentHost;
      await expect(mirrorFile(host, { world: "w", relay: "search" }, join(dataDir, "mirror.log"))).rejects.toThrow("boom");
      await Bun.sleep(10);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
