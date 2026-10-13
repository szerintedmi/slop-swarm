// The HTTP API (docs/plans/2026-10-12-hosted-control-plane.md §5) and the controller service: auth and CSRF, controls,
// launches, config endpoints, worlds and homes, and a whole launch -> wakes -> stop cycle through the service.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi, type ApiService } from "../src/api.ts";
import { buildSnapshot, loadSwarm, parseSwarm, type SwarmConfig } from "../src/config.ts";
import { ensureConfigDefaults, savePreset } from "../src/config-db.ts";
import { createRun } from "../src/controller/run.ts";
import { enqueueControl, getRun, openDb, serviceFile, worldAgentDirs, type ControlRow, type RunRow } from "../src/db/index.ts";
import type { ForgeClient } from "../src/forge.ts";
import { ControllerService, type LaunchRequest } from "../src/service.ts";
import { fakeAgentHost, silentLogger, TEST_HOST } from "./helpers/agent-host.ts";

const dataDir = mkdtempSync(join(tmpdir(), "slopswarm-api-"));
process.env.SLOPSWARM_DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const T0 = Date.now();
const FIXTURE = readFileSync("test/fixtures/claude-tools.synthetic.jsonl", "utf8");

function config(): SwarmConfig {
  const base = loadSwarm("config/smoke.yaml");
  const parsed = parseSwarm(
    {
      run: { name: "api", max_duration_min: 60 },
      agents: ["bramble", "thistle"],
      budgets: { swarm_usd: 1, per_agent_usd: 0.5, per_wake: { max_usd: 0.1, max_turns: 10, timeout_min: 5 } },
      scheduler: { max_sleep_min: 15 },
    },
    (name) => ({ name, harness: "claude", model: "claude-haiku-5-5", effort: "medium" }),
  );
  return { ...parsed, paths: base.paths, snapshot: "# --- test\nbudgets: {swarm_usd: 1}\n" };
}

/** Like config(), with a real snapshot: a resume rebuilds the config from it. */
function resumable(): SwarmConfig {
  const swarm = { run: { name: "api", max_duration_min: 60 }, agents: ["bramble", "thistle"], budgets: { swarm_usd: 1, per_agent_usd: 0.5, per_wake: { max_usd: 0.1, max_turns: 10, timeout_min: 5 } }, scheduler: { max_sleep_min: 15 } };
  const agent = (name: string) => ({ name, harness: "claude", model: "claude-haiku-5-5", effort: "medium" });
  const snapshot = buildSnapshot("test.yaml", Bun.YAML.stringify(swarm, null, 2), swarm.agents.map((n) => [n, Bun.YAML.stringify(agent(n), null, 2)] as [string, string]));
  return { ...parseSwarm(swarm, agent), paths: loadSwarm("config/smoke.yaml").paths, snapshot };
}

function setup(o: { token?: string; readonly?: boolean; service?: Partial<ApiService>; hostKills?: string[] } = {}) {
  const db = openDb(":memory:");
  const runId = createRun(db, config(), {}, T0);
  const launches: LaunchRequest[] = [];
  const service: ApiService = {
    enqueueLaunch: (r) => (launches.push(r), enqueueControl(db, null, "launch", null, "api", JSON.stringify(r))),
    activeRun: () => getRun(db, runId),
    ...o.service,
  };
  const killed = o.hostKills ?? [];
  const host = { killAll: async (world?: string) => (killed.push(world ?? "*"), ["c1"]) } as never;
  const call = createApi({ db, token: o.token, readonly: o.readonly, service: o.readonly ? undefined : service, host });
  const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { ...(method === "GET" ? {} : { "x-slopswarm": "test" }), ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    const res = (await call(new Request(`http://localhost/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })))!;
    const text = await res.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* text */
    }
    return { status: res.status, json };
  };
  return { db, runId, req, launches, killed, call };
}

describe("api", () => {
  test("only /api/v1 is the API's", async () => {
    const { call } = setup();
    expect(await call(new Request("http://localhost/agents"))).toBeNull();
  });

  test("auth: a bearer token must be the right one; no token is fine (the network is the boundary)", async () => {
    const { req } = setup({ token: "s3cret" });
    expect((await req("GET", "/runs")).status).toBe(200);
    expect((await req("GET", "/runs", undefined, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await req("GET", "/runs", undefined, { authorization: "Bearer s3cret" })).status).toBe(200);
    const open = setup();
    expect((await open.req("GET", "/runs", undefined, { authorization: "Bearer anything" })).status).toBe(401);
  });

  test("csrf: mutating requests need X-Slopswarm and are refused cross-site", async () => {
    const { req, runId } = setup();
    expect((await req("POST", `/runs/${runId}/stop`, {}, { "x-slopswarm": "" })).status).toBe(403);
    expect((await req("POST", `/runs/${runId}/stop`, {}, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await req("POST", `/runs/${runId}/stop`, {}, { "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  test("read-only dashboards refuse every change", async () => {
    const { req, runId } = setup({ readonly: true });
    expect((await req("GET", `/runs/${runId}`)).status).toBe(200);
    const r = await req("POST", `/runs/${runId}/stop`, {});
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/read-only/);
  });

  test("run controls are checked and queued; extend is validated; kill without a controller stops the run here", async () => {
    const { req, runId, db, killed } = setup({ service: { activeRun: () => null } });
    expect((await req("POST", `/runs/${runId}/agents/bramble/pause`, {})).status).toBe(200);
    expect((await req("POST", `/runs/${runId}/agents/ghost/pause`, {})).status).toBe(404);
    expect((await req("POST", `/runs/${runId}/agents/bramble/stop`, {})).status).toBe(404); // not an agent action
    expect((await req("POST", `/runs/${runId}/extend`, { timeMs: -1 })).status).toBe(400);
    expect((await req("POST", `/runs/${runId}/extend`, { agentUsd: { ghost: 1 } })).json.error).toMatch(/unknown agent ghost/);
    const ext = await req("POST", `/runs/${runId}/extend`, { timeMs: 60_000, agentUsd: { "*": 0.5 } });
    expect(ext.json.applied).toBe("when the run is resumed");
    const queued = db.query<ControlRow, [string]>("SELECT * FROM controls WHERE run_id = ? ORDER BY id").all(runId);
    expect(queued.map((c) => [c.action, c.agent, c.source])).toEqual([["pause", "bramble", "api"], ["extend", null, "api"]]);
    const st = await req("GET", `/status?run=${runId}`);
    expect(st.json.queued.map((q: { detail: string | null }) => q.detail)).toEqual([null, "world +1m; every agent +$0.50"]);
    const k = await req("POST", `/runs/${runId}/kill`, {});
    expect(k.json.killed).toEqual(["c1"]);
    expect(killed).toEqual([runId]);
    expect(getRun(db, runId)).toMatchObject({ status: "stopped", stop_reason: "kill (no controller)" });
  });

  test("kill of an older run never touches the newer run active in its world", async () => {
    const { req, runId, db, killed } = setup({ service: { activeRun: () => null } });
    db.query("UPDATE runs SET status = 'finished', ended_at = ? WHERE id = ?").run(T0 + 1, runId);
    const newer = createRun(db, config(), { world: runId }, T0 + 60_000);
    // Finished: nothing to kill.
    const k = await req("POST", `/runs/${runId}/kill`, {});
    expect(k.status).toBe(409);
    expect(k.json.error).toMatch(/not running/);
    // Still marked running, but a newer run is active in the same world: refused rather than killing that run's wakes.
    db.query("UPDATE runs SET status = 'running', ended_at = NULL WHERE id = ?").run(runId);
    const k2 = await req("POST", `/runs/${runId}/kill`, {});
    expect(k2.status).toBe(409);
    expect(k2.json.error).toContain(newer);
    expect(killed).toEqual([]);
    expect(db.query<ControlRow, [string]>("SELECT * FROM controls WHERE run_id = ?").all(runId)).toEqual([]);
    expect(getRun(db, newer)!.status).toBe("running");
    expect(db.query<{ status: string }, [string]>("SELECT status FROM worlds WHERE id = ?").get(runId)!.status).toBe("active");
  });

  test("launches: queued for the service, then pending, done or failed", async () => {
    const { req, db, launches } = setup();
    expect((await req("POST", "/launches", {})).status).toBe(400);
    const r = await req("POST", "/launches", { preset: " smoke ", world: "w1", brief: " hi " });
    expect(r.status).toBe(202);
    expect(launches).toEqual([{ preset: "smoke", world: "w1", brief: "hi" }]);
    expect((await req("GET", `/launches/${r.json.id}`)).json).toMatchObject({ status: "pending", request: { preset: "smoke" } });
    db.query("UPDATE controls SET result = ? WHERE id = ?").run(JSON.stringify({ error: "a run is active" }), r.json.id);
    expect((await req("GET", `/launches/${r.json.id}`)).json).toMatchObject({ status: "failed", error: "a run is active" });
  });

  test("status, runs, wakes, report: display fields only", async () => {
    const { req, runId } = setup();
    const s = await req("GET", "/status");
    expect(s.json.run.id).toBe(runId);
    expect(s.json.run.world).toBe(runId);
    expect(JSON.stringify(s.json)).not.toContain("config_yaml");
    expect(JSON.stringify(s.json)).not.toContain("seed_text");
    expect((await req("GET", "/runs")).json.map((r: RunRow) => r.id)).toEqual([runId]);
    expect((await req("GET", `/runs/${runId}/wakes`)).json).toEqual([]);
    expect((await req("GET", `/runs/${runId}/report`)).json).toContain("## Totals");
    expect((await req("GET", "/runs/nope")).status).toBe(404);
  });

  test("config: presets and agents validated on save, seeds versioned, the bundle", async () => {
    const { req, db } = setup();
    ensureConfigDefaults(db);
    expect((await req("GET", "/presets")).json.map((p: { name: string }) => p.name)).toEqual(["shock", "smoke", "swarm"]);
    const bad = await req("PUT", "/agents/bramble", { yaml: "name: bramble\nharness: gemini\nmodel: m\n" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/harness/);
    const ok = await req("PUT", "/agents/zed", { yaml: "name: zed\nharness: claude\nmodel: claude-haiku-5-5\n" });
    expect(ok.status).toBe(200);
    expect((await req("PUT", "/presets/mine", { yaml: "agents: [zed]\n" })).json.error).toMatch(/run: expected a mapping/);
    const seeds = (await req("GET", "/seeds")).json;
    expect(seeds.map((s: { name: string; id: number }) => [s.name, s.id])).toEqual([["default", 1], ["shock", 2]]);
    expect(seeds[0].text).toBeUndefined();
    expect((await req("GET", "/seeds?name=shock")).json.map((s: { id: number }) => s.id)).toEqual([2]);
    // A new version of the default seed (no name given), then the old one active again.
    const v3 = await req("POST", "/seeds", { text: "You are {name} at {forge_url}.\n", note: "short" });
    expect(v3.json).toMatchObject({ name: "default", active: 1, note: "short" });
    expect((await req("POST", `/seeds/${seeds[0].id}/activate`, {})).json.id).toBe(seeds[0].id);
    // A new named seed, a preset on it, and the delete guards.
    expect((await req("POST", "/seeds", { name: "calm", text: "You are {name} at {forge_url}. Calm.\n" })).json).toMatchObject({ name: "calm", id: 4, active: 1 });
    expect((await req("POST", "/seeds", { name: "Bad", text: "You are {name} at {forge_url}.\n" })).status).toBe(400);
    const smoke = (await req("GET", "/presets/smoke")).json.yaml;
    expect((await req("PUT", "/presets/calmer", { yaml: smoke.replace("seed: default", "seed: calm") })).status).toBe(200);
    expect((await req("PUT", "/presets/ghostly", { yaml: smoke.replace("seed: default", "seed: ghost") })).json.error).toMatch(/no seed ghost/);
    expect((await req("DELETE", "/seeds/calm", undefined)).json.error).toMatch(/preset\(s\) calmer/);
    expect((await req("DELETE", "/seeds/default", undefined)).status).toBe(400);
    expect((await req("DELETE", "/presets/calmer", undefined)).status).toBe(200);
    expect((await req("DELETE", "/seeds/calm", undefined)).json).toEqual({ ok: true });
    const bundle = (await req("GET", "/config")).json;
    expect(Object.keys(bundle.agents)).toContain("zed");
    expect(Object.keys(bundle.seeds)).toEqual(["default", "shock"]);
    expect((await req("DELETE", "/agents/fern", undefined)).json.error).toMatch(/smoke/);
  });

  test("worlds and homes: the VPS copy when there is no agent host", async () => {
    const { req, runId } = setup();
    const wa = worldAgentDirs(runId, "bramble");
    mkdirSync(join(wa.gens, "1", "home"), { recursive: true });
    Bun.spawnSync(["ln", "-s", "gens/1", wa.current]);
    writeFileSync(join(wa.home, "NOTES.md"), "hello");
    const w = await req("GET", `/worlds/${runId}`);
    expect(w.json).toMatchObject({ id: runId, status: "active" });
    expect(w.json.agents.map((a: { name: string }) => a.name)).toEqual(["bramble", "thistle"]);
    const home = await req("GET", `/worlds/${runId}/agents/bramble/home`);
    expect(home.json.source).toEqual({ live: false, generation: 1 });
    expect(home.json.tree.map((n: { name: string }) => n.name)).toEqual(["NOTES.md"]);
    expect((await req("GET", `/worlds/${runId}/agents/bramble/file?path=NOTES.md`)).json.file.text).toBe("hello");
    expect((await req("GET", `/worlds/${runId}/agents/bramble/file?path=../x`)).status).toBe(400);
    expect((await req("GET", `/worlds/${runId}/agents/ghost/home`)).status).toBe(404);
  });
});

describe("host check", () => {
  test("requests for a Host the server isn't refuse (DNS rebinding)", async () => {
    const { hostAllowed } = await import("../src/dashboard/server.ts");
    const o = { hostname: "127.0.0.1", allowedHosts: ["100.64.0.5", "vps"] };
    for (const h of ["localhost:7777", "127.0.0.1:7777", "[::1]:7777", "100.64.0.5:7777", "VPS:7777"]) expect([h, hostAllowed(h, o)]).toEqual([h, true]);
    for (const h of ["evil.example:7777", null, "127.0.0.1.evil.example"]) expect([h, hostAllowed(h, o)]).toEqual([h, false]);
  });
});

describe("controller service", () => {
  test("launch through the API, wakes on the agent host, stop through the API; one run at a time; a restart resumes the run", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "test-token";
    process.env.FORGE_ADMIN_PASSWORD ||= "test-admin";
    const db = openDb(":memory:");
    ensureConfigDefaults(db);
    const smoke = readFileSync("config/smoke.yaml", "utf8");
    savePreset(db, "tiny", smoke.replace("agents: [bramble, sorrel, wren, fern]", "agents: [bramble]").replace("tick_s: 5", "tick_s: 1").replace(/^webfetch:[\s\S]*?(?=^forge:)/m, ""));
    const agentHost = fakeAgentHost({ dataDir, behave: () => FIXTURE });
    const forge = { baseUrl: "http://127.0.0.1:1", unread: async () => 0, ensureAgent: async () => "tok" } as unknown as ForgeClient;
    const started: string[] = [];
    const make = () =>
      new ControllerService({
        db,
        agentHost: { host: agentHost.host, url: "fake", local: true, stop: () => {} },
        hostCfg: TEST_HOST,
        log: silentLogger,
        port: 0,
        bind: ["127.0.0.1"],
        forgeBasePort: 3300,
        forgePublish: [],
        allForges: false,
        startForge: async (o) => (started.push(o.world), forge),
      });
    const service = make();
    await service.start();
    const base = service.urls[0]!;
    expect(JSON.parse(readFileSync(serviceFile(), "utf8")).url).toBe(base);
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}/api/v1${path}`, { method, headers: { "x-slopswarm": "t", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return (await res.json()) as any;
    };
    const { id } = await api("POST", "/launches", { preset: "tiny", brief: "be brief" });
    let l: any;
    while ((l = await api("GET", `/launches/${id}`)).status === "pending") await Bun.sleep(20);
    expect(l.status).toBe("done");
    const runId = l.run as string;
    expect(started).toEqual([runId]);
    // A second launch while one is active fails.
    const second = await api("POST", "/launches", { preset: "tiny" });
    while ((l = await api("GET", `/launches/${second.id}`)).status === "pending") await Bun.sleep(20);
    expect(l).toMatchObject({ status: "failed", error: expect.stringMatching(/a run is active/) });
    // The first wake runs on the (fake) agent host.
    while (!agentHost.argvs.length) await Bun.sleep(20);
    const note = agentHost.argvs[0]![agentHost.argvs[0]!.indexOf("-p") + 1]!;
    expect(note).toContain("[Note from the operator: be brief]");
    expect(getRun(db, runId)!.config_yaml).toContain("# --- host.yaml\n");
    // A restart (a deploy): the run stays running; the new service resumes it.
    await service.close();
    expect(getRun(db, runId)!.status).toBe("running");
    const again = make();
    await again.start();
    expect(again.activeRun()!.id).toBe(runId);
    const b2 = again.urls[0]!;
    await fetch(`${b2}/api/v1/runs/${runId}/stop`, { method: "POST", headers: { "x-slopswarm": "t" } });
    await again.whenRunEnds();
    expect(getRun(db, runId)!.status).toBe("stopped");
    await again.close();
  }, 30_000);

  test("a launch whose world doesn't come up leaves no run marked running", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||= "test-token";
    process.env.FORGE_ADMIN_PASSWORD ||= "test-admin";
    const db = openDb(":memory:");
    ensureConfigDefaults(db);
    const smoke = readFileSync("config/smoke.yaml", "utf8");
    savePreset(db, "tiny", smoke.replace("agents: [bramble, sorrel, wren, fern]", "agents: [bramble]").replace(/^webfetch:[\s\S]*?(?=^forge:)/m, ""));
    const agentHost = fakeAgentHost({ dataDir, behave: () => FIXTURE });
    const service = new ControllerService({
      db, agentHost: { host: agentHost.host, url: "fake", local: true, stop: () => {} }, hostCfg: TEST_HOST, log: silentLogger,
      port: 0, bind: ["127.0.0.1"], forgeBasePort: 3300, forgePublish: [], allForges: false,
      startForge: async () => {
        throw new Error("port 3300 is in use");
      },
    });
    await service.start();
    await expect(service.launch({ preset: "tiny" })).rejects.toThrow(/in use/);
    const run = db.query<RunRow, []>("SELECT * FROM runs").get()!;
    expect(run.status).toBe("stopped");
    expect(run.stop_reason).toMatch(/did not start/);
    expect(db.query<{ status: string }, []>("SELECT status FROM worlds").get()!.status).toBe("idle");
    expect(service.activeRun()).toBeNull();
    await service.close();
  });

  test("concurrent resumes: one run at a time, even while the first is still coming up", async () => {
    process.env.FORGE_ADMIN_PASSWORD ||= "test-admin";
    const db = openDb(":memory:");
    const r1 = createRun(db, resumable(), {}, T0);
    const r2 = createRun(db, resumable(), {}, T0 + 60_000);
    const agentHost = fakeAgentHost({ dataDir, behave: () => FIXTURE });
    const forge = { baseUrl: "http://127.0.0.1:1", unread: async () => 0, ensureAgent: async () => "tok" } as unknown as ForgeClient;
    const started: string[] = [];
    const service = new ControllerService({
      db,
      agentHost: { host: agentHost.host, url: "fake", local: true, stop: () => {} },
      hostCfg: TEST_HOST,
      log: silentLogger,
      port: 0,
      bind: ["127.0.0.1"],
      forgeBasePort: 3300,
      forgePublish: [],
      allForges: false,
      startForge: async (o) => (started.push(o.world), forge),
    });
    const results = await Promise.allSettled([service.resumeRun(r1), service.resumeRun(r2)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason.message).toMatch(/a run is active/);
    expect(started).toEqual([r1]);
    expect(service.activeRun()!.id).toBe(r1);
    service.controller()!.requestStop("test");
    await service.whenRunEnds();
    await service.close();
    expect(getRun(db, r1)!.status).toBe("stopped");
    expect(getRun(db, r2)!.status).toBe("running"); // nothing drove it; the next service start sorts it out
  });
});
