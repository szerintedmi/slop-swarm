// Controller end to end with a fake `docker run` that replays CLI fixtures.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSwarm, parseSwarm, type SwarmConfig } from "../src/config.ts";
import { Controller, type ControllerOptions } from "../src/controller/index.ts";
import { createRun } from "../src/controller/run.ts";
import type { ProcessHandle } from "../src/controller/wake.ts";
import { agentDirs, enqueueControl, getRun, openDb, type AgentRow, type EventRow, type ExtensionRow, type RequestRow, type WakeRow } from "../src/db/index.ts";
import { forgeHost, type ForgeApi } from "../src/forge.ts";
import { parsePricing } from "../src/pricing/index.ts";
import { renderReport } from "../src/report.ts";

const dataDir = mkdtempSync(join(tmpdir(), "slopswarm-test-"));
process.env.SLOPSWARM_DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const MIN = 60_000;
const FIXTURE = readFileSync("test/fixtures/claude-tools.synthetic.jsonl", "utf8");
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);

function config(over: { perWakeMaxUsd?: number; worldEndGraceS?: number } = {}): SwarmConfig {
  const base = loadSwarm("config/smoke.yaml");
  const parsed = parseSwarm(
    {
      run: { name: "ctl-test", max_duration_min: 120, world_end_grace_s: over.worldEndGraceS ?? 60 },
      agents: ["bramble", "thistle"],
      budgets: { swarm_usd: 1, per_agent_usd: 0.5, per_wake: { max_usd: over.perWakeMaxUsd ?? 0.1, max_turns: 10, timeout_min: 5 } },
      // One slot so wakes happen in a deterministic order.
      scheduler: { max_sleep_min: 15, max_concurrent_wakes: 1 },
      controller: { tick_s: 1 },
      network: { name: "slopswarm-internal", proxy: "http://slopswarm-proxy:8888", allowlist: ["api.anthropic.com"] },
    },
    (name) => ({ name, runtime: "claude", model: "claude-haiku-5-5", effort: "medium" }),
  );
  return { ...parsed, paths: base.paths, snapshot: "# --- test\n" };
}

/** Notifications by recipient; `unread()` filters like the Forgejo API (unread, updated after `since`). */
class FakeForge implements ForgeApi {
  notes: { user: string; ts: number; read: boolean }[] = [];
  notify(user: string, ts: number) {
    this.notes.push({ user, ts, read: false });
  }
  markRead(user: string) {
    for (const n of this.notes) if (n.user === user) n.read = true;
  }
  async unread(user: string, since?: number) {
    return this.notes.filter((n) => n.user === user && !n.read && (since === undefined || n.ts > since)).length;
  }
}

interface Harness {
  ctl: Controller;
  forge: FakeForge;
  db: ReturnType<typeof openDb>;
  runId: string;
  clock: { t: number };
  argvs: string[][];
  /** The env each `docker run` got. */
  envs: Record<string, string | undefined>[];
  kills: string[];
  /** For a second controller on the same run (a resume). */
  ctlOpts: ControllerOptions;
}

/** `behave(agent, argv)` returns the stdout text, or null to hang until killed. */
function harness(
  cfg: SwarmConfig,
  behave: (agent: string, argv: string[]) => string | null,
  opts: { killMisses?: number; pricingYaml?: string; wakeDeps?: ControllerOptions["wakeDeps"] } = {},
): Harness {
  const db = openDb(":memory:");
  const clock = { t: T0 };
  const runId = createRun(db, cfg, { cliVersions: { claude: "2.1.296" }, pricingYaml: opts.pricingYaml }, T0);
  const argvs: string[][] = [];
  const envs: Record<string, string | undefined>[] = [];
  const kills: string[] = [];
  const pending = new Map<string, () => void>();
  const startProcess = (argv: string[], _stderr: string, env: Record<string, string | undefined>): ProcessHandle => {
    argvs.push(argv);
    envs.push(env);
    const name = argv[argv.indexOf("--name") + 1]!;
    const agent = argv.find((a) => a.startsWith("slopswarm.agent="))!.split("=")[1]!;
    const out = behave(agent, argv);
    let finish!: (code: number) => void;
    const exited = new Promise<number>((r) => (finish = r));
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        if (out !== null) {
          c.enqueue(new TextEncoder().encode(out));
          c.close();
          finish(0);
        } else {
          // Emit the first usage-bearing lines, then hang until killed.
          c.enqueue(new TextEncoder().encode(FIXTURE.split("\n").slice(0, 3).join("\n") + "\n"));
          pending.set(name, () => {
            c.close();
            finish(137);
          });
        }
      },
    });
    return { stdout, exited };
  };
  let misses = opts.killMisses ?? 0;
  const killContainer = async (name: string) => {
    kills.push(name);
    // A miss is `docker kill` before `docker run` has created the container.
    if (misses > 0) misses--;
    else pending.get(name)?.();
  };
  const forge = new FakeForge();
  const ctlOpts: ControllerOptions = { forge, log: () => {}, now: () => clock.t, wakeDeps: { startProcess, killContainer, ...opts.wakeDeps } };
  const ctl = new Controller(db, runId, cfg, ctlOpts);
  return { ctl, forge, db, runId, clock, argvs, envs, kills, ctlOpts };
}

const agentRow = (h: Harness, name: string) => h.db.query<AgentRow, [string, string]>("SELECT * FROM agents WHERE run_id = ? AND name = ?").get(h.runId, name)!;
const extend = (h: Harness, d: { timeMs?: number; swarmUsd?: number; agentUsd?: Record<string, number> }) =>
  enqueueControl(h.db, h.runId, "extend", null, "cli", JSON.stringify({ timeMs: 0, swarmUsd: 0, agentUsd: {}, ...d }));
const wakesOf = (h: Harness, name: string) => h.db.query<WakeRow, [string, string]>("SELECT * FROM wakes WHERE run_id = ? AND agent = ? ORDER BY seq").all(h.runId, name);

describe("controller", () => {
  beforeEach(() => {
    for (const d of readdirSync(dataDir)) rmSync(join(dataDir, d), { recursive: true, force: true });
  });

  test("wake: cost, forge env, notifications, next_wake, resume, report", async () => {
    const h = harness(config(), (agent, argv) => {
      const home = agentDirs(h.runId, agent).home;
      // Bramble mentions thistle on the forge in each wake.
      if (agent === "bramble") h.forge.notify("thistle", h.clock.t);
      if (agent === "bramble" && !argv.includes("--resume")) writeFileSync(join(home, "next_wake.yaml"), "in_minutes: 10\ncontinue_session: true\n");
      return FIXTURE;
    });

    expect(h.ctl.tick()).toBe(true);
    await h.ctl.whenIdle();

    const [w] = wakesOf(h, "bramble");
    expect(w!.exit_reason).toBe("completed");
    expect(w!.trigger).toBe("initial");
    expect(w!.requests).toBe(3);
    expect(w!.turns).toBe(3);
    expect(w!.session_id).toBe("11111111-2222-3333-4444-555555555555");
    expect(w!.tool_calls).toBeGreaterThan(0);
    expect(w!.msgs_in).toBe(0);
    expect(w!.next_in_minutes).toBe(10);
    const reqs = h.db.query<RequestRow, [number]>("SELECT * FROM requests WHERE wake_id = ? ORDER BY seq").all(w!.id);
    expect(reqs).toHaveLength(3);
    expect(w!.cost_usd).toBeCloseTo(reqs.reduce((s, r) => s + r.cost_usd, 0), 10);
    // Our per-request costing agrees with the vendor's total within 1%.
    expect(Math.abs(w!.cost_usd / w!.reported_cost_usd! - 1)).toBeLessThan(0.01);

    // The container reaches the run's forge directly and is logged in as the agent; nothing shared is mounted.
    const argv1 = h.argvs[0]!;
    const env = (k: string) => argv1.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);
    expect(env("FORGE_URL")).toBe(`http://${forgeHost(h.runId)}:3000`);
    expect(env("GIT_CONFIG_GLOBAL")).toBe("/runtime/forge/gitconfig");
    expect(env("XDG_CONFIG_HOME")).toBe("/runtime/xdg");
    expect(env("NO_PROXY")!.split(",")).toContain(forgeHost(h.runId));
    expect(argv1.join(" ")).not.toContain("/commons");
    const system1 = argv1[argv1.indexOf("--system-prompt") + 1]!;
    expect(system1).toContain(`Everyone shares a git forge at http://${forgeHost(h.runId)}:3000, private to this world; your account is bramble.`);
    expect(system1).toStartWith("You are bramble.");
    const note1 = argv1[argv1.indexOf("-p") + 1]!;
    expect(note1).toStartWith("[Wake 1 at ");
    expect(note1).toContain(": your first wake.");
    expect(note1).not.toContain("Unread"); // nothing unread: no inbox line

    // /self was written and is consistent.
    const self = agentDirs(h.runId, "bramble").self;
    expect(existsSync(join(self, "STATUS.md"))).toBe(false);
    const selfPricing = readFileSync(join(self, "pricing.yaml"), "utf8");
    expect(selfPricing).toContain("claude-haiku-5-5");
    expect(selfPricing).not.toContain("gpt-6-luna"); // only its own model's prices
    expect(selfPricing).toStartWith("# API-equivalent list prices");

    // Thistle was already due (initial, waiting for the slot), so the mention moves nothing.
    await h.ctl.pollForge();
    expect(agentRow(h, "thistle").next_trigger).toBe("initial");

    // Bramble: self-scheduled in 10 minutes, wants to continue.
    const b = agentRow(h, "bramble");
    expect(b.status).toBe("sleeping");
    expect(b.next_wake_at).toBe(T0 + 10 * MIN);
    expect(b.next_trigger).toBe("self");
    expect(b.continue_next).toBe(1);
    expect(b.spent_usd).toBeCloseTo(w!.cost_usd, 10);

    // t=+1m: thistle's first wake sees the unread notification.
    h.clock.t = T0 + MIN;
    h.ctl.tick();
    await h.ctl.whenIdle();
    const [tw] = wakesOf(h, "thistle");
    expect(tw!.trigger).toBe("initial");
    expect(tw!.msgs_in).toBe(1);
    const tArgv = h.argvs.at(-1)!;
    expect(tArgv[tArgv.indexOf("-p") + 1]).toContain("Unread forge notifications: 1 (");
    expect(tArgv[tArgv.indexOf("--system-prompt") + 1]).toStartWith("You are thistle.");
    // It left the notification unread, but it predates this wake: no pull. No next_wake.yaml -> max_sleep.
    expect(agentRow(h, "thistle")).toMatchObject({ next_trigger: "timer", next_wake_at: T0 + MIN + 15 * MIN });
    await h.ctl.pollForge();
    expect(agentRow(h, "thistle").next_trigger).toBe("timer");

    // t=+10m: bramble resumes its session. Lean harness: the seed is the system prompt, the user turn is the wake note.
    h.clock.t = T0 + 10 * MIN;
    h.ctl.tick();
    await h.ctl.whenIdle();
    const argv = h.argvs.at(-1)!;
    expect(argv[argv.indexOf("--resume") + 1]).toBe("11111111-2222-3333-4444-555555555555");
    expect(argv[argv.indexOf("-p") + 1]).toStartWith("[Wake 2 at");
    const system = argv[argv.indexOf("--system-prompt") + 1]!;
    expect(system).toStartWith("You are bramble. You live in a shared world");
    expect(system).not.toMatch(/\{[a-z_]+\}/);
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Bash,Read,Write,Edit,WebSearch");
    expect(readFileSync(join(agentDirs(h.runId, "bramble").runtime, "system-prompt.md"), "utf8")).toBe(system);
    const w2 = wakesOf(h, "bramble")[1]!;
    expect(w2.resumed).toBe(1);
    expect(w2.slept_ms).toBe(10 * MIN);
    // The replayed fixture reports the same cumulative modelUsage / total_cost_usd as wake 1, so
    // (as a resumed session) nothing is unattributed and the vendor-reported share of this wake is 0.
    expect(w2.requests).toBe(3);
    expect(w2.reported_cost_usd).toBe(0);
    // The stale next_wake.yaml from wake 1 is ignored -> max_sleep.
    expect(agentRow(h, "bramble").next_trigger).toBe("timer");
    // Its new mention pulls sleeping thistle forward to now.
    await h.ctl.pollForge();
    expect(agentRow(h, "thistle")).toMatchObject({ next_trigger: "message", next_wake_at: T0 + 10 * MIN });
    const pulls = h.db.query<EventRow, [string]>("SELECT * FROM events WHERE run_id = ? AND name = 'forge_pull'").all(h.runId);
    expect(pulls).toMatchObject([{ agent: "thistle", detail: "1 unread" }]);
    expect(readFileSync(join(agentDirs(h.runId, "bramble").self, "usage.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);

    const report = renderReport(h.db, h.runId, T0 + 20 * MIN);
    expect(report).toContain("## Totals");
    expect(report).toContain("Sleeping agents pulled by the poller: 1");
    expect(report).toContain("Cross-check on 2 wake(s)");
  });

  test("/self/pricing.yaml lists the agent's own model plus models it was billed for", async () => {
    const h = harness(config(), () => FIXTURE);
    h.ctl.repo.updateAgent("bramble", { status: "paused" });
    // An earlier wake of thistle's billed an extra model, and one the pricing table doesn't know.
    const wid = h.ctl.repo.startWake({ agent: "thistle", seq: 0, trigger: "initial", started_at: T0 - MIN, slept_ms: null, resumed: 0, msgs_in: 0, raw_log_path: null, container_name: null });
    h.ctl.repo.updateWake(wid, { ended_at: T0 - MIN / 2 });
    const ins = h.db.query(
      `INSERT INTO requests (wake_id, run_id, agent, seq, request_id, model, fresh_input, cache_read, cache_write_5m, cache_write_1h, output, reasoning, web_searches, prompt_tokens, tier, cost_usd)
       VALUES (?, ?, 'thistle', ?, ?, ?, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0)`,
    );
    ins.run(wid, h.runId, 1, "unattributed:gpt-6-luna", "gpt-6-luna");
    ins.run(wid, h.runId, 2, "r2", "mystery-model");
    expect(h.ctl.repo.agentModels("thistle")).toEqual(["claude-haiku-5-5", "gpt-6-luna", "mystery-model"]);
    h.ctl.tick();
    await h.ctl.whenIdle();
    const pricing = readFileSync(join(agentDirs(h.runId, "thistle").self, "pricing.yaml"), "utf8");
    expect(Object.keys(parsePricing(pricing).models).sort()).toEqual(["claude-haiku-5-5", "gpt-6-luna"]);
    // The controller still costs with the full run table.
    expect(Object.keys(parsePricing(getRun(h.db, h.runId)!.pricing_yaml).models)).toContain("gpt-6-luna");
  });

  test("notifications that arrive during a wake pull the next one, unless marked read", async () => {
    let markRead = false;
    const h = harness(config(), (agent) => {
      h.forge.notify(agent, h.clock.t + 1000); // someone mentions it while it is awake
      if (markRead) h.forge.markRead(agent);
      return FIXTURE;
    });
    h.ctl.repo.updateAgent("thistle", { status: "paused" });
    h.ctl.tick();
    await h.ctl.whenIdle();
    // Left unread: the next wake is pulled from max_sleep to right after this one.
    expect(agentRow(h, "bramble")).toMatchObject({ next_trigger: "message", next_wake_at: T0 });

    markRead = true;
    h.clock.t = T0 + 2 * MIN;
    h.ctl.tick();
    await h.ctl.whenIdle();
    expect(agentRow(h, "bramble")).toMatchObject({ next_trigger: "timer", next_wake_at: T0 + 2 * MIN + 15 * MIN });
  });

  test("a forge error is logged and counts as no notifications", async () => {
    const h = harness(config(), () => FIXTURE);
    h.forge.unread = async () => {
      throw new Error("forge down");
    };
    h.ctl.repo.updateAgent("thistle", { status: "paused" });
    h.ctl.tick();
    await h.ctl.whenIdle();
    expect(wakesOf(h, "bramble")[0]!.exit_reason).toBe("completed");
    const errs = h.db.query<EventRow, [string]>("SELECT * FROM events WHERE run_id = ? AND kind = 'error' AND name = 'forge'").all(h.runId);
    expect(errs.length).toBeGreaterThan(0);
  });

  test("per-wake budget kills the container", async () => {
    const h = harness(config({ perWakeMaxUsd: 0.0001 }), () => null);
    h.ctl.tick();
    await h.ctl.whenIdle();
    const [w] = wakesOf(h, "bramble");
    expect(h.kills).toHaveLength(1);
    expect(w!.exit_reason).toBe("budget_wake");
    expect(w!.cost_usd).toBeGreaterThan(0.0001);
    expect(agentRow(h, "bramble").status).toBe("sleeping");
  });

  test("a wake still running at the world end is stopped after the grace period, even if the first kill misses", async () => {
    const h = harness(config({ worldEndGraceS: 0 }), () => null, { killMisses: 1 });
    h.ctl.repo.updateAgent("thistle", { status: "paused" });
    h.clock.t = T0 + 2 * 60 * MIN - 200; // 200 ms before the world ends
    h.ctl.tick();
    h.clock.t = T0 + 2 * 60 * MIN + 1000; // it is still running 1 s after
    await h.ctl.whenIdle();
    const wArgv = h.argvs[0]!;
    // The note gives the real stop time (world end + grace) without mentioning the world end.
    expect(wArgv[wArgv.indexOf("-p") + 1]).toContain(`is still running at ${new Date(T0 + 2 * 60 * MIN).toISOString().replace(/\.\d+Z$/, "Z")}.`);
    expect(wArgv[wArgv.indexOf("-p") + 1]).not.toContain("world");
    const [w] = wakesOf(h, "bramble");
    expect(w!.exit_reason).toBe("world_end");
    expect(h.kills).toHaveLength(2); // retried until the process was gone
    expect(w!.cost_usd).toBeGreaterThan(0); // the partial wake is still billed
    expect(renderReport(h.db, h.runId, h.clock.t)).toContain("World end: 1 wake(s) were still running when the world ended");
  });

  test("controls: pause, wake, stop", async () => {
    const h = harness(config(), () => FIXTURE);
    enqueueControl(h.db, h.runId, "pause", "bramble", "cli");
    enqueueControl(h.db, h.runId, "wake", "thistle", "cli");
    h.ctl.tick();
    await h.ctl.whenIdle();
    expect(agentRow(h, "bramble").status).toBe("paused");
    expect(wakesOf(h, "bramble")).toHaveLength(0);
    expect(wakesOf(h, "thistle")[0]!.trigger).toBe("manual");

    enqueueControl(h.db, h.runId, "stop", null, "cli");
    expect(h.ctl.tick()).toBe(false);
    expect(h.db.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?").get(h.runId)!.status).toBe("stopped");
  });

  test("run ends at its deadline", () => {
    const h = harness(config(), () => FIXTURE);
    h.clock.t = T0 + 3 * 60 * MIN;
    expect(h.ctl.tick()).toBe(false);
    const run = h.db.query<{ status: string; stop_reason: string }, [string]>("SELECT status, stop_reason FROM runs WHERE id = ?").get(h.runId)!;
    expect(run).toEqual({ status: "finished", stop_reason: "max_duration reached" });
  });

  test("bad auth (zero-usage synthetic reply) counts as a failure", async () => {
    const synthetic = [
      '{"type":"system","subtype":"init","session_id":"s1","model":"claude-haiku-5-5","apiKeySource":"none"}',
      '{"type":"assistant","message":{"model":"<synthetic>","id":"m1","role":"assistant","content":[{"type":"text","text":"Invalid API key"}],"usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"session_id":"s1"}',
      '{"type":"result","subtype":"success","is_error":true,"num_turns":1,"session_id":"s1","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}',
    ].join("\n");
    const h = harness(config(), () => synthetic);
    enqueueControl(h.db, h.runId, "pause", "thistle", "cli"); // only bramble wakes
    for (let i = 0; i < 3; i++) {
      h.clock.t = T0 + i * 10 * MIN;
      enqueueControl(h.db, h.runId, "wake", "bramble", "cli");
      h.ctl.tick();
      await h.ctl.whenIdle();
    }
    const ws = wakesOf(h, "bramble");
    expect(ws.map((w) => w.exit_reason)).toEqual(["error", "error", "error"]);
    expect(ws.every((w) => w.cost_usd === 0)).toBe(true);
    expect(agentRow(h, "bramble").status).toBe("failed");
  });

  test("recover() tolerates a zero-usage synthetic reply (unknown model, nothing to bill)", async () => {
    const h = harness(config(), () => FIXTURE);
    const d = agentDirs(h.runId, "bramble");
    const raw = join(d.raw, "0001.jsonl");
    writeFileSync(raw, '{"type":"assistant","message":{"model":"<synthetic>","id":"m1","role":"assistant","content":[],"usage":{"input_tokens":0,"output_tokens":0}},"session_id":"s1"}\n');
    h.ctl.repo.startWake({ agent: "bramble", seq: 1, trigger: "initial", started_at: T0, slept_ms: null, resumed: 0, msgs_in: 0, raw_log_path: raw, container_name: "x" });
    h.ctl.repo.updateAgent("bramble", { status: "waking", next_wake_at: null });
    await h.ctl.recover();
    const [w] = wakesOf(h, "bramble");
    expect(w!.ended_at).not.toBeNull();
    expect(w!.cost_usd).toBe(0);
    expect(w!.requests).toBe(0);
  });

  test("emergency kill before the container starts does not start it", async () => {
    const h = harness(config(), () => FIXTURE);
    // A wake awaits the forge's unread count before spawning: that is the window.
    h.ctl.repo.updateAgent("bramble", { continue_next: 1, last_session_id: "s-prev" });
    enqueueControl(h.db, h.runId, "pause", "thistle", "cli");
    h.ctl.tick();
    await h.ctl.emergencyKill("test");
    await h.ctl.whenIdle();
    expect(h.argvs).toHaveLength(0);
    const [w] = wakesOf(h, "bramble");
    expect(w!.exit_reason).toBe("stopped");
    expect(w!.cost_usd).toBe(0);
    expect(agentRow(h, "bramble").consecutive_failures).toBe(0);
  });

  test("recover() closes wakes left open by a crash", async () => {
    const h = harness(config(), () => FIXTURE);
    // Simulate a crash mid-wake: an open wake row with a partial raw log.
    const d = agentDirs(h.runId, "bramble");
    const raw = join(d.raw, "0001.jsonl");
    writeFileSync(raw, FIXTURE.split("\n").slice(0, 4).join("\n") + "\n");
    h.ctl.repo.startWake({ agent: "bramble", seq: 1, trigger: "initial", started_at: T0, slept_ms: null, resumed: 0, msgs_in: 0, raw_log_path: raw, container_name: "x" });
    h.ctl.repo.updateAgent("bramble", { status: "waking", next_wake_at: null });
    await h.ctl.recover();
    const [w] = wakesOf(h, "bramble");
    expect(w!.ended_at).not.toBeNull();
    expect(w!.cost_usd).toBeGreaterThan(0);
    const b = agentRow(h, "bramble");
    expect(b.status).toBe("sleeping");
    expect(b.spent_usd).toBeCloseTo(w!.cost_usd, 10);
    expect(existsSync(raw)).toBe(true);
  });
  test("extend while running: time from the old deadline; a depleted agent revives, a failed one doesn't", async () => {
    const h = harness(config(), () => FIXTURE);
    const deadline = T0 + 120 * MIN;
    h.ctl.repo.updateAgent("bramble", { status: "depleted", spent_usd: 0.5, next_wake_at: null, next_trigger: null });
    h.ctl.repo.updateAgent("thistle", { status: "failed", next_wake_at: null, next_trigger: null });
    h.clock.t = T0 + 10 * MIN;
    extend(h, { timeMs: 30 * MIN, agentUsd: { "*": 0.25, bramble: 0.25 } });
    expect(h.ctl.tick()).toBe(true); // not "no agent can wake": bramble has budget again
    await h.ctl.whenIdle();

    expect(getRun(h.db, h.runId)!.deadline_at).toBe(deadline + 30 * MIN);
    expect(agentRow(h, "bramble").budget_usd).toBeCloseTo(1.0);
    expect(wakesOf(h, "bramble")[0]).toMatchObject({ trigger: "timer", started_at: T0 + 10 * MIN });
    expect(agentRow(h, "thistle")).toMatchObject({ status: "failed", budget_usd: 0.75 });
    expect(wakesOf(h, "thistle")).toHaveLength(0);
    const [ext] = h.db.query<ExtensionRow, [string]>("SELECT * FROM extensions WHERE run_id = ?").all(h.runId);
    expect(ext).toMatchObject({ ts: T0 + 10 * MIN, source: "cli", time_ms: 30 * MIN, old_deadline: deadline, new_deadline: deadline + 30 * MIN });
    const ev = h.db.query<EventRow, [string]>("SELECT * FROM events WHERE run_id = ? AND name = 'run_extended'").get(h.runId)!;
    expect(ev.detail).toBe("world +30m; every agent +$0.25; bramble +$0.25");
  });

  test("extend a finished run: resume applies it before the first scheduling step, time counts from now", async () => {
    const h = harness(config(), () => FIXTURE);
    h.clock.t = T0 + 3 * 60 * MIN;
    expect(h.ctl.tick()).toBe(false); // finished at the deadline
    expect(getRun(h.db, h.runId)).toMatchObject({ status: "finished", stop_reason: "max_duration reached" });

    extend(h, { timeMs: 60 * MIN });
    h.clock.t = T0 + 4 * 60 * MIN;
    const resumed = new Controller(h.db, h.runId, config(), h.ctlOpts);
    await resumed.begin();
    expect(getRun(h.db, h.runId)).toMatchObject({ status: "running", stop_reason: null, ended_at: null });
    expect(resumed.tick()).toBe(true);
    await resumed.whenIdle();
    expect(getRun(h.db, h.runId)!.deadline_at).toBe(T0 + 5 * 60 * MIN);
    // Both agents were overdue since the end: they keep their trigger, one slot at a time.
    expect(wakesOf(h, "bramble")[0]).toMatchObject({ trigger: "initial", started_at: T0 + 4 * 60 * MIN });
    const markers = h.db.query<EventRow, [string]>("SELECT * FROM events WHERE run_id = ? AND name LIKE 'run_%' ORDER BY id").all(h.runId).map((e) => e.name);
    expect(markers).toEqual(["run_created", "run_stopping", "run_finished", "run_resumed", "run_extended"]);
  });

  test("the swarm budget stop rule uses the extended budget", async () => {
    const spend = (h: Harness) => {
      h.ctl.repo.updateAgent("bramble", { budget_usd: 5, spent_usd: 1 }); // swarm budget is 1
      h.ctl.repo.updateAgent("thistle", { status: "paused" });
    };
    const plain = harness(config(), () => FIXTURE);
    spend(plain);
    expect(plain.ctl.tick()).toBe(false);
    expect(getRun(plain.db, plain.runId)!.stop_reason).toBe("swarm budget exhausted");

    const h = harness(config(), () => FIXTURE);
    spend(h);
    extend(h, { swarmUsd: 0.5 });
    expect(h.ctl.tick()).toBe(true);
    await h.ctl.whenIdle();
    expect(wakesOf(h, "bramble")).toHaveLength(1);
    expect(getRun(h.db, h.runId)!.status).toBe("running");
  });

  test("a wake running when the world end moves is stopped against the new end", async () => {
    const h = harness(config({ worldEndGraceS: 0 }), () => null);
    h.ctl.repo.updateAgent("thistle", { status: "paused" });
    h.clock.t = T0 + 2 * 60 * MIN - 200; // 200 ms before the world ends
    h.ctl.tick();
    extend(h, { timeMs: 60 * MIN });
    h.ctl.tick();
    await Bun.sleep(400);
    expect(h.kills).toHaveLength(0);
    expect(wakesOf(h, "bramble")[0]!.ended_at).toBeNull();
    await h.ctl.emergencyKill("test");
    await h.ctl.whenIdle();
    expect(wakesOf(h, "bramble")[0]!.exit_reason).toBe("stopped");
  });

  test("an extension during the drain after the end carries the run on", async () => {
    const h = harness(config({ worldEndGraceS: 0 }), () => null);
    h.ctl.repo.updateAgent("thistle", { status: "paused" });
    h.clock.t = T0 + 2 * 60 * MIN - 200;
    h.ctl.tick();
    h.clock.t = T0 + 2 * 60 * MIN + 100; // past the end: stopping, the wake drains
    expect(h.ctl.tick()).toBe(true);
    expect(getRun(h.db, h.runId)!.status).toBe("stopping");
    extend(h, { timeMs: 30 * MIN });
    expect(h.ctl.tick()).toBe(true);
    expect(getRun(h.db, h.runId)).toMatchObject({ status: "running", stop_reason: null });
    await h.ctl.emergencyKill("test");
    await h.ctl.whenIdle();
  });

  test("recover() honours a next_wake.yaml written during the crashed wake", async () => {
    const h = harness(config(), () => FIXTURE);
    const d = agentDirs(h.runId, "bramble");
    const raw = join(d.raw, "0001.jsonl");
    writeFileSync(raw, FIXTURE.split("\n").slice(0, 4).join("\n") + "\n");
    const nw = join(d.home, "next_wake.yaml");
    writeFileSync(nw, "in_minutes: 7\ncontinue_session: true\n");
    utimesSync(nw, (T0 + MIN) / 1000, (T0 + MIN) / 1000);
    h.ctl.repo.startWake({ agent: "bramble", seq: 1, trigger: "initial", started_at: T0, slept_ms: null, resumed: 0, msgs_in: 0, raw_log_path: raw, container_name: "x" });
    h.ctl.repo.updateAgent("bramble", { status: "waking", next_wake_at: null, next_trigger: null });
    h.clock.t = T0 + 2 * MIN;
    await h.ctl.recover();
    expect(agentRow(h, "bramble")).toMatchObject({ status: "sleeping", next_wake_at: T0 + 9 * MIN, next_trigger: "self", continue_next: 1 });
    expect(wakesOf(h, "bramble")[0]).toMatchObject({ next_in_minutes: 7, continue_requested: 1 });
  });
  test("pi on OpenRouter: key passed by name, preset priced as its slug, max turns from the stream, vendor cross-check", async () => {
    const base = loadSwarm("config/smoke.yaml");
    const parsed = parseSwarm(
      {
        run: { name: "pi-test", max_duration_min: 120 },
        agents: ["fern"],
        budgets: { swarm_usd: 1, per_agent_usd: 0.5, per_wake: { max_usd: 0.1, max_turns: 1, timeout_min: 5 } },
        scheduler: { max_sleep_min: 15 },
        network: { name: "slopswarm-internal", proxy: "http://slopswarm-proxy:8888", allowlist: ["openrouter.ai"] },
      },
      (name) => ({ name, runtime: "pi", provider: "openrouter", model: "z-ai/glm-5.3-flash@preset/sw-glm-5-3-flash", key_env: "TEST_OR_KEY", effort: "low" }),
    );
    const cfg = { ...parsed, paths: base.paths, snapshot: "# --- test\n" };
    const pricingYaml = readFileSync(base.paths.pricing, "utf8").replace(
      /^models:\n/m,
      `models:\n  "z-ai/glm-5.3-flash":\n    provider: openrouter\n    per_mtok: { input: 0.15, output: 0.5, cache_read: 0.03 }\n`,
    );
    process.env.TEST_OR_KEY = "sk-test-not-real";
    const looked: string[][] = [];
    const vendorCosts = async (ids: string[], key: string) => {
      expect(key).toBe("sk-test-not-real");
      looked.push(ids);
      return new Map(ids.map((id) => [id, { costUsd: 0.00001, provider: "StreamLake" }]));
    };
    // Two assistant turns (a tool call, then the reply): one more than max_turns.
    const h = harness(cfg, () => readFileSync("test/fixtures/pi-resume-wake2.jsonl", "utf8"), { pricingYaml, wakeDeps: { vendorCosts } });
    h.ctl.tick();
    await h.ctl.whenIdle();
    delete process.env.TEST_OR_KEY;

    const argv = h.argvs[0]!;
    expect(argv[argv.indexOf("OPENROUTER_API_KEY") - 1]).toBe("-e");
    expect(argv.join(" ")).not.toContain("sk-test-not-real");
    expect(h.envs[0]!.OPENROUTER_API_KEY).toBe("sk-test-not-real");
    expect(argv).toContain("z-ai/glm-5.3-flash@preset/sw-glm-5-3-flash");

    const [w] = wakesOf(h, "fern");
    expect(w!.exit_reason).toBe("max_turns");
    expect(h.kills).toHaveLength(1);
    const reqs = h.db.query<RequestRow, [number]>("SELECT * FROM requests WHERE wake_id = ? ORDER BY seq").all(w!.id);
    expect(reqs.map((r) => r.model)).toEqual(["z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash"]);
    expect(w!.cost_usd).toBeCloseTo((585 * 0.15 + 768 * 0.03 + 19 * 0.5 + 34 * 0.15 + 1344 * 0.03 + 3 * 0.5) / 1e6, 12);
    expect(looked).toEqual([reqs.map((r) => r.request_id)]);
    expect(reqs.every((r) => r.vendor_cost_usd === 0.00001 && r.vendor_provider === "StreamLake")).toBe(true);
    expect(w!.reported_cost_usd).toBeCloseTo(0.00002, 12);
    // The agent sees its model's price under the slug.
    expect(readFileSync(join(agentDirs(h.runId, "fern").self, "pricing.yaml"), "utf8")).toContain("z-ai/glm-5.3-flash");
    expect(renderReport(h.db, h.runId)).toContain("| StreamLake | 2 |");
  });
});
