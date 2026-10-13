// The runner (src/runner/) through its HTTP API, with a fake container runtime: files by offset, prepare,
// secrets by name, hard timeout, watchdog, reattach after a restart, home pull/push with generations.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerHost } from "../src/host/agent-host.ts";
import { parseHostConfig, type HostConfig } from "../src/hostconfig.ts";
import type { ContainerRuntime, OutputFiles, RunnerInfra, WakeContainer } from "../src/runner/containers.ts";
import type { WakeStartRequest } from "../src/runner/protocol.ts";
import { Runner, runnerAgentDirs, runnerRelayDirs } from "../src/runner/runner.ts";
import { extractSnapshot, snapshotStream } from "../src/runner/snapshot.ts";

const root = mkdtempSync(join(tmpdir(), "slopswarm-runner-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const TOKEN = "t0ken-for-tests";

const HOST: HostConfig = parseHostConfig({
  network: { name: "slopswarm-internal", proxy: "http://slopswarm-proxy:8888", allowlist: ["api.anthropic.com"] },
  container: { cpus: 1, memory_gb: 2, pids_limit: 256 },
  runner: { watchdog_s: 60, home_cap_mb: 1, home_excludes: ["node_modules"] },
});

/** A container: writes `out` to stdout and exits, or (out null) waits until killed. */
class FakeRuntime implements ContainerRuntime {
  launched: { argv: string[]; env: Record<string, string | undefined> }[] = [];
  live = new Map<string, { finish: (code: number) => void; exited: Promise<number> }>();
  behave: (argv: string[]) => string | null = () => '{"ok":true}\n';
  /** Output a reattach replays (what `docker logs` would give). */
  logs = new Map<string, string>();

  private container(name: string, out: OutputFiles, text: string | null): WakeContainer {
    let finish!: (code: number) => void;
    const exited = new Promise<number>((r) => (finish = r));
    writeFileSync(out.stdout, text ?? "partial\n");
    this.logs.set(name, text ?? "partial\n");
    this.live.set(name, { finish, exited });
    if (text !== null) queueMicrotask(() => finish(0));
    return { exited: exited.then((c) => (this.live.delete(name), c)) };
  }
  async launch(argv: string[], env: Record<string, string | undefined>, out: OutputFiles) {
    this.launched.push({ argv, env });
    const name = argv[argv.indexOf("--name") + 1]!;
    return this.container(name, out, this.behave(argv));
  }
  async reattach(name: string, out: OutputFiles) {
    const c = this.live.get(name);
    if (!c) return null;
    writeFileSync(out.stdout, this.logs.get(name) ?? "");
    return { exited: c.exited.then((code) => (this.live.delete(name), code)) };
  }
  async present() {
    return [...this.live.keys()];
  }
  async kill(name: string) {
    this.live.get(name)?.finish(137);
  }
}

class FakeInfra implements RunnerInfra {
  calls: string[] = [];
  async ensureProxy(allowlist: string[]) {
    this.calls.push(`proxy ${allowlist.join(",")}`);
  }
  async ensureImage(ref: string) {
    this.calls.push(`image ${ref}`);
    return { digest: "sha256:abc", claude: "2.1.296" };
  }
  async relayUp(o: { world: string; exaKey?: string }) {
    this.calls.push(`relay ${o.world} key=${o.exaKey ? "yes" : "no"}`);
  }
  async relayDown(world: string) {
    this.calls.push(`relay-down ${world}`);
  }
  async forgeForwarderUp(o: { world: string; target: string }) {
    this.calls.push(`forwarder ${o.world} ${o.target}`);
  }
  async forgeForwarderDown(world: string) {
    this.calls.push(`forwarder-down ${world}`);
  }
  killed: string[] = [];
  async killAll() {
    const names = [...this.rt.live.keys()];
    for (const n of names) await this.rt.kill(n);
    return names;
  }
  constructor(private rt: FakeRuntime) {}
}

function setup(o: { dataDir?: string; rt?: FakeRuntime; now?: () => number } = {}) {
  const dataDir = o.dataDir ?? mkdtempSync(join(root, "r-"));
  const rt = o.rt ?? new FakeRuntime();
  const infra = new FakeInfra(rt);
  const logs: string[] = [];
  const runner = new Runner({
    dataDir,
    token: TOKEN,
    runtime: rt,
    infra,
    watchdog: false,
    now: o.now,
    log: { log: () => {}, info: (b) => logs.push(b), warn: (b) => logs.push(b), error: (b) => logs.push(b), with() { return this; } },
  });
  const host = new RunnerHost({ url: "http://runner.test", token: TOKEN, fetch: (req) => runner.handle(req) });
  return { dataDir, rt, infra, runner, host, logs };
}

const wake = (id: string, over: Partial<WakeStartRequest> = {}): WakeStartRequest => ({
  id, world: "w1", run: "r1", agent: "bramble", wakeId: 1, image: "slopswarm-agent:test",
  env: { FORGE_URL: "http://slopswarm-forge-w1:3000" }, secretEnv: [], argv: ["claude", "-p", "hi"], noProxy: ["slopswarm-forge-w1"], hardTimeoutMs: 60_000, ...over,
});

async function until(f: () => Promise<boolean> | boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}
const exited = (host: RunnerHost, id: string) => until(async () => (await host.wakeStatus(id))?.state === "exited");
const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("runner", () => {
  test("auth: health is open, everything else needs the token", async () => {
    const { runner } = setup();
    expect((await runner.handle(new Request("http://x/v1/health"))).status).toBe(200);
    expect((await runner.handle(new Request("http://x/v1/wakes"))).status).toBe(401);
    expect((await runner.handle(new Request("http://x/v1/wakes", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    expect((await runner.handle(new Request("http://x/v1/wakes", { headers: { authorization: `Bearer ${TOKEN}` } }))).status).toBe(200);
  });

  test("ensure-up applies the host config and reports its hash; wakes need it first", async () => {
    const { host, infra } = setup();
    await expect(host.startWake(wake("w-1"))).rejects.toThrow(/ensure-up first/);
    const up = await host.ensureUp({ host: HOST, image: "slopswarm-agent:test", relaySecrets: { EXA_API_KEY: "k" } });
    expect(up.appliedHash).toMatch(/^[0-9a-f]{16}$/);
    expect(up.image.claude).toBe("2.1.296");
    expect(infra.calls).toEqual(["proxy api.anthropic.com", "image slopswarm-agent:test"]);
    await host.worldUp("w1", { relay: {}, forgeTarget: "100.64.0.1:3301" });
    expect(infra.calls.slice(2)).toEqual(["relay w1 key=yes", "forwarder w1 100.64.0.1:3301"]);
  });

  test("prepare: files with modes, ifMissing, no escape through symlinks or ..", async () => {
    const { host, dataDir } = setup();
    const d = runnerAgentDirs(dataDir, "w1", "bramble");
    // The agent turned its forge dir into a link to somewhere outside.
    mkdirSync(d.runtime, { recursive: true });
    const outside = mkdtempSync(join(root, "outside-"));
    symlinkSync(outside, join(d.runtime, "forge"));
    writeFileSync(join(d.runtime, "auth.json"), "rotated");
    const r = await host.prepare("w1", "bramble", {
      files: [
        { area: "runtime", path: "forge/token", content: b64("tok\n"), mode: 0o600 },
        { area: "runtime", path: "auth.json", content: b64("seed"), mode: 0o600, ifMissing: true },
        { area: "self", path: "usage.jsonl", content: b64("") },
      ],
      env: { CLAUDE_CODE_OAUTH_TOKEN: "secret" },
    });
    expect(r.kept).toEqual(["auth.json"]);
    expect(lstatSync(join(d.runtime, "forge")).isDirectory()).toBe(true);
    expect(readFileSync(join(d.runtime, "forge", "token"), "utf8")).toBe("tok\n");
    expect(statSync(join(d.runtime, "forge", "token")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(outside, "token"))).toBe(false);
    expect(readFileSync(join(d.runtime, "auth.json"), "utf8")).toBe("rotated");
    await expect(host.prepare("w1", "bramble", { files: [{ area: "runtime", path: "../x", content: "" }], env: {} })).rejects.toThrow(/bad file/);
    await expect(host.prepare("w1", "bramble", { files: [{ area: "home" as "self", path: "x", content: "" }], env: {} })).rejects.toThrow(/bad file/);
    await expect(host.prepare("../w", "bramble", { files: [], env: {} })).rejects.toThrow();
  });

  test("a wake: docker run -d with labels, secrets by name only, output by offset, exit code", async () => {
    const { host, rt } = setup();
    await host.ensureUp({ host: HOST, image: "img", relaySecrets: {} });
    await host.prepare("w1", "bramble", { files: [], env: { CLAUDE_CODE_OAUTH_TOKEN: "s3cret" } });
    rt.behave = () => "line one\nline two\n";
    await host.startWake(wake("slopswarm-r1-bramble-1", { secretEnv: ["CLAUDE_CODE_OAUTH_TOKEN"] }));
    await exited(host, "slopswarm-r1-bramble-1");
    const { argv, env } = rt.launched[0]!;
    expect(argv.slice(0, 3)).toEqual(["docker", "run", "-d"]);
    expect(argv).not.toContain("--rm");
    expect(argv.join(" ")).not.toContain("s3cret");
    expect(argv).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("s3cret");
    expect(argv).toContain("slopswarm.world=w1");
    expect(argv).toContain("slopswarm.wake=slopswarm-r1-bramble-1");
    expect(argv[argv.indexOf("--network") + 1]).toBe("slopswarm-internal");
    expect(argv[argv.indexOf("--memory") + 1]).toBe("2048m");
    const s = (await host.wakeStatus("slopswarm-r1-bramble-1"))!;
    expect(s.exitCode).toBe(0);
    expect(s.homeBytes).toBe(0);
    expect(s.timings.containerStartMs).toBeGreaterThanOrEqual(0);
    const all = await host.read({ wake: "slopswarm-r1-bramble-1", file: "stdout" });
    expect(new TextDecoder().decode(all!.data)).toBe("line one\nline two\n");
    const tail = await host.read({ wake: "slopswarm-r1-bramble-1", file: "stdout" }, 9);
    expect(new TextDecoder().decode(tail!.data)).toBe("line two\n");
    expect(tail!.size).toBe(18);
    // Starting the same wake again returns it (a retried call), not a second container.
    await host.startWake(wake("slopswarm-r1-bramble-1"));
    expect(rt.launched).toHaveLength(1);
    await host.release("slopswarm-r1-bramble-1");
    expect(await host.wakeStatus("slopswarm-r1-bramble-1")).toBeNull();
  });

  test("a secret that wasn't prepared refuses the wake", async () => {
    const { host } = setup();
    await host.ensureUp({ host: HOST, image: "img", relaySecrets: {} });
    await host.prepare("w1", "bramble", { files: [], env: {} });
    await expect(host.startWake(wake("x-1", { secretEnv: ["OPENROUTER_API_KEY"] }))).rejects.toThrow(/not prepared/);
  });

  test("hard timeout and explicit kill", async () => {
    const { host, rt } = setup();
    await host.ensureUp({ host: HOST, image: "img", relaySecrets: {} });
    await host.prepare("w1", "bramble", { files: [], env: {} });
    rt.behave = () => null;
    await host.startWake(wake("t-1", { hardTimeoutMs: 30 }));
    await exited(host, "t-1");
    const s = (await host.wakeStatus("t-1"))!;
    expect(s.killed).toBe("hard timeout");
    expect(s.exitCode).toBe(137);
    await host.prepare("w1", "thistle", { files: [], env: {} });
    await host.startWake(wake("k-1", { agent: "thistle" }));
    await until(async () => (await host.wakeStatus("k-1"))?.state === "running");
    await host.kill("k-1");
    await exited(host, "k-1");
    expect((await host.wakeStatus("k-1"))!.killed).toBe("kill requested");
  });

  test("one wake per agent at a time", async () => {
    const { host, rt } = setup();
    await host.ensureUp({ host: HOST, image: "img", relaySecrets: {} });
    await host.prepare("w1", "bramble", { files: [], env: {} });
    rt.behave = () => null;
    await host.startWake(wake("a-1"));
    await expect(host.startWake(wake("a-2"))).rejects.toThrow(/already in a wake/);
    await host.killAll();
    await exited(host, "a-1");
  });

  test("watchdog: silence while wakes run kills them", async () => {
    let t = 1_000_000;
    const { host, runner, rt } = setup({ now: () => t });
    await host.ensureUp({ host: HOST, image: "img", relaySecrets: {} });
    await host.prepare("w1", "bramble", { files: [], env: {} });
    rt.behave = () => null;
    await host.startWake(wake("wd-1"));
    await until(async () => (await host.wakeStatus("wd-1"))?.state === "running");
    t += 59_000;
    expect(await runner.watchdogCheck()).toEqual([]);
    t += 2_000; // 61 s since the last call (watchdog_s: 60)
    expect(await runner.watchdogCheck()).toEqual(["wd-1"]);
    await exited(host, "wd-1");
    expect((await host.wakeStatus("wd-1"))!.killed).toBe("watchdog");
  });

  test("a restarted runner reattaches to a running wake and replays its output", async () => {
    const first = setup();
    await first.host.ensureUp({ host: HOST, image: "img", relaySecrets: {} });
    await first.host.prepare("w1", "bramble", { files: [], env: {} });
    first.rt.behave = () => null;
    await first.host.startWake(wake("re-1"));
    await until(async () => (await first.host.wakeStatus("re-1"))?.state === "running");
    first.runner.close();
    // The old runner process is gone; the container (fake runtime) is not.
    const second = setup({ dataDir: first.dataDir, rt: first.rt });
    await second.runner.init();
    const s = (await second.host.wakeStatus("re-1"))!;
    expect(s.state).toBe("running");
    expect(new TextDecoder().decode((await second.host.read({ wake: "re-1", file: "stdout" }))!.data)).toBe("partial\n");
    await second.host.kill("re-1");
    await exited(second.host, "re-1");
    // A wake whose container vanished while the runner was down is closed with an error.
    const third = setup({ dataDir: first.dataDir });
    await third.host.ensureUp({ host: HOST, image: "img", relaySecrets: {} });
    await third.host.prepare("w1", "thistle", { files: [], env: {} });
    third.rt.behave = () => null;
    await third.host.startWake(wake("gone-1", { agent: "thistle" }));
    await until(async () => (await third.host.wakeStatus("gone-1"))?.state === "running");
    third.runner.close();
    const fourth = setup({ dataDir: first.dataDir }); // a fresh runtime: no containers
    await fourth.runner.init();
    const g = (await fourth.host.wakeStatus("gone-1"))!;
    expect(g.state).toBe("exited");
    expect(g.error).toMatch(/container gone/);
  });

  test("a restarted runner keeps the applied host config (nothing secret), so wakes go on before the next ensure-up", async () => {
    const first = setup();
    await first.host.ensureUp({ host: HOST, image: "img", relaySecrets: { EXA_API_KEY: "exa-secret" } });
    first.runner.close();
    expect(readFileSync(join(first.dataDir, "host-config.json"), "utf8")).not.toContain("exa-secret");
    const second = setup({ dataDir: first.dataDir });
    await second.host.prepare("w1", "bramble", { files: [], env: {} });
    await second.host.startWake(wake("after-restart-1"));
    await exited(second.host, "after-restart-1");
    expect(second.rt.launched[0]!.argv[second.rt.launched[0]!.argv.indexOf("--network") + 1]).toBe("slopswarm-internal");
  });

  test("reads stay inside the home; runtime reads only session files and auth.json", async () => {
    const { host, dataDir } = setup();
    const d = runnerAgentDirs(dataDir, "w1", "bramble");
    for (const p of [join(d.home, "notes"), join(d.runtime, "projects", "-home-agent"), join(d.runtime, "forge")]) mkdirSync(p, { recursive: true });
    writeFileSync(join(d.home, "notes", "a.md"), "hello");
    writeFileSync(join(d.runtime, "projects", "-home-agent", "s1.jsonl"), "{}\n");
    writeFileSync(join(d.runtime, "forge", "token"), "secret");
    writeFileSync(join(d.runtime, "auth.json"), "{}");
    symlinkSync("/etc/hosts", join(d.home, "escape"));
    symlinkSync("notes/a.md", join(d.home, "inside"));
    const read = async (area: "home" | "runtime", path: string) => {
      const r = await host.read({ world: "w1", agent: "bramble", area, path });
      return r ? new TextDecoder().decode(r.data) : null;
    };
    expect(await read("home", "notes/a.md")).toBe("hello");
    expect(await read("home", "inside")).toBe("hello");
    expect(await read("home", "escape")).toBeNull();
    expect(await read("home", "../runtime/forge/token")).toBeNull();
    expect(await read("runtime", "projects/-home-agent/s1.jsonl")).toBe("{}\n");
    expect(await read("runtime", "auth.json")).toBe("{}");
    expect(await read("runtime", "forge/token")).toBeNull();
    const ls = await host.list({ world: "w1", agent: "bramble", area: "home", path: "" }, { depth: 3 });
    expect(ls.map((e) => `${e.kind} ${e.path}`)).toEqual(["symlink escape", "symlink inside", "dir notes", "file notes/a.md"]);
    const rt = await host.list({ world: "w1", agent: "bramble", area: "runtime", path: "" }, { depth: 3 });
    expect(rt.map((e) => e.path)).toEqual(["auth.json", "projects", "projects/-home-agent", "projects/-home-agent/s1.jsonl"]);
    expect((await host.stat({ world: "w1", agent: "bramble", area: "home", path: "notes/a.md" }))!.size).toBe(5);
  });

  test("relay tokens: prepare registers the hash, revoke drops it", async () => {
    const { host, dataDir } = setup();
    const hash = "a".repeat(64);
    await host.prepare("w1", "wren", { files: [{ area: "runtime", path: "search/token", content: b64("tok"), mode: 0o600 }], env: {}, relayToken: { hash, wake: 7, search: true } });
    const file = runnerRelayDirs(dataDir, "w1").tokensFile;
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ [hash]: { agent: "wren", wake: 7, search: true } });
    await host.revokeRelayToken("w1", 7);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  });

  test("home pull and push: generations, excludes, unknown runtime entries, never during a wake", async () => {
    const { host, dataDir, rt } = setup();
    await host.ensureUp({ host: HOST, image: "img", relaySecrets: {} });
    const d = runnerAgentDirs(dataDir, "w1", "bramble");
    for (const p of [join(d.home, "proj", "node_modules", "x"), join(d.runtime, "sessions"), join(d.runtime, "forge")]) mkdirSync(p, { recursive: true });
    writeFileSync(join(d.home, "MEMORY.md"), "remember");
    writeFileSync(join(d.home, "proj", "node_modules", "x", "big.js"), "x".repeat(1000));
    writeFileSync(join(d.runtime, "sessions", "s.jsonl"), "{}\n");
    writeFileSync(join(d.runtime, "forge", "token"), "secret");
    writeFileSync(join(d.runtime, "mystery.db"), "?");
    symlinkSync("MEMORY.md", join(d.home, "link"));

    const info = await host.homeInfo("w1", "bramble");
    expect(info.generation).toBeNull();
    expect(info.bytes).toBe("remember".length + 3);
    expect(info.unknownRuntime).toEqual(["mystery.db"]);

    const pulled = mkdtempSync(join(root, "pull-"));
    const { stream } = await host.pullHome("w1", "bramble");
    await extractSnapshot(stream, pulled, ["home", "runtime/projects", "runtime/sessions"]);
    expect(readFileSync(join(pulled, "home", "MEMORY.md"), "utf8")).toBe("remember");
    expect(lstatSync(join(pulled, "home", "link")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(pulled, "home", "proj", "node_modules"))).toBe(false);
    expect(readFileSync(join(pulled, "runtime", "sessions", "s.jsonl"), "utf8")).toBe("{}\n");
    expect(existsSync(join(pulled, "runtime", "forge"))).toBe(false);
    await host.setGeneration("w1", "bramble", 1);
    expect((await host.homeInfo("w1", "bramble")).generation).toBe(1);

    // Push it to a fresh agent host (a new VM): home and sessions arrive, logins don't.
    const other = setup();
    writeFileSync(join(pulled, "home", "MEMORY.md"), "remember more");
    await other.host.pushHome("w1", "bramble", 2, snapshotStream([{ prefix: "home", dir: join(pulled, "home") }, { prefix: "runtime/sessions", dir: join(pulled, "runtime", "sessions") }], new Set()));
    const od = runnerAgentDirs(other.dataDir, "w1", "bramble");
    expect(readFileSync(join(od.home, "MEMORY.md"), "utf8")).toBe("remember more");
    expect(readFileSync(join(od.runtime, "sessions", "s.jsonl"), "utf8")).toBe("{}\n");
    expect((await other.host.homeInfo("w1", "bramble")).generation).toBe(2);

    // An interrupted push (truncated stream) changes nothing.
    const full = new Uint8Array(await new Response(snapshotStream([{ prefix: "home", dir: join(pulled, "home") }], new Set())).arrayBuffer());
    const cut = new Blob([full.slice(0, full.length - 10)]).stream();
    await expect(other.host.pushHome("w1", "bramble", 3, cut)).rejects.toThrow(/truncated/);
    expect(readFileSync(join(od.home, "MEMORY.md"), "utf8")).toBe("remember more");
    expect((await other.host.homeInfo("w1", "bramble")).generation).toBe(2);

    // Over the cap (1 MB here): refused.
    writeFileSync(join(d.home, "huge.bin"), Buffer.alloc(1_100_000));
    await expect(host.pullHome("w1", "bramble")).rejects.toThrow(/413/);
    rmSync(join(d.home, "huge.bin"));

    // Never during the agent's wake.
    await host.prepare("w1", "bramble", { files: [], env: {} });
    rt.behave = () => null;
    await host.startWake(wake("busy-1"));
    await until(async () => (await host.wakeStatus("busy-1"))?.state === "running");
    await expect(host.pullHome("w1", "bramble")).rejects.toThrow(/409/);
    await host.kill("busy-1");
    await exited(host, "busy-1");
  });

  test("snapshots refuse paths outside the roots and writes through links", async () => {
    const frame = (h: object, body = "") => {
      const j = new TextEncoder().encode(JSON.stringify(h));
      const out = new Uint8Array(4 + j.length + body.length);
      new DataView(out.buffer).setUint32(0, j.length);
      out.set(j, 4);
      out.set(new TextEncoder().encode(body), 4 + j.length);
      return out;
    };
    const stream = (...parts: Uint8Array[]) => new Blob([...parts, new Uint8Array(4)]).stream();
    const t1 = mkdtempSync(join(root, "x-"));
    await expect(extractSnapshot(stream(frame({ p: "home/../../etc/x", t: "f", m: 420, s: 1, mt: 0 }, "x")), t1, ["home"])).rejects.toThrow(/refused/);
    await expect(extractSnapshot(stream(frame({ p: "runtime/forge/token", t: "f", m: 420, s: 1, mt: 0 }, "x")), t1, ["home", "runtime/sessions"])).rejects.toThrow(/refused/);
    const t2 = mkdtempSync(join(root, "x-"));
    await expect(
      extractSnapshot(stream(frame({ p: "home", t: "d", m: 493, s: 0, mt: 0 }), frame({ p: "home/l", t: "l", m: 511, s: 0, mt: 0, l: "/tmp" }), frame({ p: "home/l/evil", t: "f", m: 420, s: 1, mt: 0 }, "x")), t2, ["home"]),
    ).rejects.toThrow(/symlink/);
  });
});

beforeEach(() => {});
