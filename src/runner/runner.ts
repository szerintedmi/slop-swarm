// The runner (docs/plans/2026-10-12-hosted-control-plane.md §2.3): a daemon on the agent host that runs wakes for
// the controller. It owns the agent dirs, the egress proxy, the world relays and (for a remote forge) the forge
// forwarders. The controller starts every call; the runner holds no controller credentials, only a shared token.
//
// Bounds without the controller: every wake is killed at the hard timeout it came with, and every wake container
// is killed once the controller has been silent for the watchdog time while wakes run.
import { chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { dockerProcessEnv, dockerRunArgs } from "../docker.ts";
import { hostConfigHash, type HostConfig } from "../hostconfig.ts";
import { createLogger, readLogs, type Logger } from "../log.ts";
import { registerRelayToken, revokeSearchToken, searchDirs } from "../search.ts";
import { AGENT_NAME_RE } from "../config.ts";
import type { ContainerRuntime, RunnerInfra, WakeContainer } from "./containers.ts";
import {
  knownRuntimeEntry,
  RUNNER_API,
  RUNTIME_SYNC_DIRS,
  runtimeReadable,
  safeRelPath,
  WAKE_ID_RE,
  WORLD_ID_RE,
  type EnsureUpRequest,
  type FileRef,
  type FileStat,
  type HomeInfo,
  type PrepareRequest,
  type WakeStartRequest,
  type WakeStatus,
  type WorldUpRequest,
} from "./protocol.ts";
import { extractSnapshot, snapshotBytes, snapshotStream, type SnapshotSource } from "./snapshot.ts";

export const RUNNER_VERSION = "1";
const WATCHDOG_TICK_MS = 5_000;
const DEFAULT_WATCHDOG_MS = 300_000;
const READ_MAX = 4 * 1024 * 1024;
const LIST_MAX = 5000;

export interface RunnerOptions {
  dataDir: string;
  token: string;
  runtime: ContainerRuntime;
  infra: RunnerInfra;
  log?: Logger;
  now?: () => number;
  /** Start the watchdog timer (off in tests that drive `watchdogCheck` themselves). */
  watchdog?: boolean;
  /** Host config before the first ensure-up (tests). */
  initialHost?: HostConfig;
  /** How often a kill is repeated until the container is gone (default 1 s). */
  killRetryMs?: number;
}

interface Wake {
  status: WakeStatus;
  /** Set once the container exists; kills before that are applied right after. */
  container?: WakeContainer;
  pendingKill: boolean;
  timer?: ReturnType<typeof setTimeout>;
  done: Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** Constant-time string compare (the bearer token). */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function runnerDirs(dataDir: string) {
  return {
    worlds: join(dataDir, "worlds"),
    wakes: join(dataDir, "wakes"),
    logs: join(dataDir, "logs"),
    logFile: join(dataDir, "logs", "runner.jsonl"),
    /** The last applied host config (nothing secret), so a restarted runner can take wakes before the next ensure-up. */
    hostFile: join(dataDir, "host-config.json"),
  };
}

/** An agent's dirs on the agent host (mounted into its wakes) and its home generation marker. */
export function runnerAgentDirs(dataDir: string, world: string, agent: string) {
  const base = join(dataDir, "worlds", world, "agents", agent);
  return { base, home: join(base, "home"), self: join(base, "self"), runtime: join(base, "runtime"), generation: join(base, "generation") };
}

export const runnerRelayDirs = (dataDir: string, world: string) => searchDirs(join(dataDir, "worlds", world, "relay"));

export function runnerWakeDir(dataDir: string, id: string) {
  const base = join(dataDir, "wakes", id);
  return { base, meta: join(base, "meta.json"), status: join(base, "status.json"), stdout: join(base, "stdout"), stderr: join(base, "stderr") };
}

function checkWorld(w: string | null | undefined): string {
  if (!w || !WORLD_ID_RE.test(w)) throw new HttpError(400, `bad world ${JSON.stringify(w)}`);
  return w;
}
function checkAgent(a: string | null | undefined): string {
  if (!a || !AGENT_NAME_RE.test(a)) throw new HttpError(400, `bad agent ${JSON.stringify(a)}`);
  return a;
}
function checkWake(id: string | null | undefined): string {
  if (!id || !WAKE_ID_RE.test(id)) throw new HttpError(400, `bad wake id ${JSON.stringify(id)}`);
  return id;
}

/** Total bytes of regular files under `dir` (symlinks are not followed). */
export function dirBytes(dir: string, exclude: ReadonlySet<string> = new Set()): number {
  let total = 0;
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (exclude.has(e)) continue;
      const p = join(d, e);
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) total += st.size;
    }
  };
  walk(dir);
  return total;
}

/**
 * Make `rel`'s parent dirs under `root` real directories: a symlink on the way (the agent can put one in its
 * runtime dir) is removed, so a write never lands outside `root`.
 */
function realParents(root: string, rel: string): void {
  const parts = rel.split("/");
  let cur = root;
  for (const p of parts.slice(0, -1)) {
    cur = join(cur, p);
    const st = lstatSync(cur, { throwIfNoEntry: false });
    if (st?.isSymbolicLink() || (st && !st.isDirectory())) rmSync(cur, { force: true, recursive: false });
    if (!st || st.isSymbolicLink() || !st.isDirectory()) mkdirSync(cur);
  }
}

/** Write a file atomically (tmp + rename, which replaces a symlink instead of following it). */
function writeAtomic(path: string, data: Uint8Array | string, mode: number): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export class Runner {
  private readonly wakes = new Map<string, Wake>();
  /** Per (world/agent): container env secrets from the last prepare. Memory only. */
  private readonly secrets = new Map<string, Record<string, string>>();
  private relaySecrets: Record<string, string> = {};
  private host: HostConfig | null = null;
  private lastContact: number;
  private watchdogTimer?: ReturnType<typeof setInterval>;
  readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly o: RunnerOptions) {
    this.now = o.now ?? Date.now;
    this.lastContact = this.now();
    this.log = o.log ?? createLogger("runner", { file: runnerDirs(o.dataDir).logFile });
    const dirs = runnerDirs(o.dataDir);
    for (const d of [dirs.worlds, dirs.wakes, dirs.logs]) mkdirSync(d, { recursive: true });
    this.host = o.initialHost ?? null;
    if (!this.host && existsSync(dirs.hostFile)) {
      try {
        this.host = JSON.parse(readFileSync(dirs.hostFile, "utf8")) as HostConfig;
      } catch {
        /* ensure-up writes it again */
      }
    }
  }

  /** Reattach to wake containers left by an earlier runner process; close out wakes whose container is gone. */
  async init(): Promise<void> {
    const present = new Set(await this.o.runtime.present());
    const dir = runnerDirs(this.o.dataDir).wakes;
    for (const id of readdirSync(dir)) {
      if (!WAKE_ID_RE.test(id)) continue;
      const d = runnerWakeDir(this.o.dataDir, id);
      let status: WakeStatus;
      try {
        status = JSON.parse(readFileSync(d.status, "utf8")) as WakeStatus;
      } catch {
        continue;
      }
      if (status.state === "exited") {
        this.wakes.set(id, { status, pendingKill: false, done: Promise.resolve() });
        continue;
      }
      const c = present.has(id) ? await this.o.runtime.reattach(id, { stdout: d.stdout, stderr: d.stderr }) : null;
      if (!c) {
        status.state = "exited";
        status.endedAt = this.now();
        status.error = status.error ?? "container gone while the runner was down";
        this.saveStatus(status);
        this.wakes.set(id, { status, pendingKill: false, done: Promise.resolve() });
        this.log.warn("wake container gone after restart", this.ctx(status));
        continue;
      }
      status.state = "running";
      this.saveStatus(status);
      const w: Wake = { status, container: c, pendingKill: false, done: Promise.resolve() };
      this.wakes.set(id, w);
      w.done = this.follow(w);
      const left = status.startedAt + this.hardTimeoutOf(id) - this.now();
      w.timer = setTimeout(() => void this.kill(id, "hard timeout"), Math.max(0, left));
      this.log.info("reattached to wake", this.ctx(status));
    }
    for (const name of present) if (!this.wakes.has(name)) {
      this.log.warn("unknown wake container: killing it", { container: name });
      await this.o.runtime.kill(name);
    }
    if (this.o.watchdog !== false) this.watchdogTimer = setInterval(() => void this.watchdogCheck(), WATCHDOG_TICK_MS);
  }

  close(): void {
    clearInterval(this.watchdogTimer);
    for (const w of this.wakes.values()) clearTimeout(w.timer);
  }

  private ctx(s: Pick<WakeStatus, "world" | "run" | "agent" | "wakeId">) {
    return { world: s.world, run: s.run, agent: s.agent, wake_id: s.wakeId };
  }

  private hardTimeoutOf(id: string): number {
    try {
      return (JSON.parse(readFileSync(runnerWakeDir(this.o.dataDir, id).meta, "utf8")) as WakeStartRequest).hardTimeoutMs;
    } catch {
      return 0;
    }
  }

  private saveStatus(s: WakeStatus): void {
    writeAtomic(runnerWakeDir(this.o.dataDir, s.id).status, JSON.stringify(s), 0o600);
  }

  /** Watchdog: with wakes running and no word from the controller for watchdogMs, kill them all. */
  async watchdogCheck(): Promise<string[]> {
    const limit = this.host?.runner.watchdogMs ?? DEFAULT_WATCHDOG_MS;
    const running = [...this.wakes.values()].filter((w) => w.status.state !== "exited");
    if (!running.length || this.now() - this.lastContact < limit) return [];
    this.log.error(`watchdog: no controller contact for ${Math.round((this.now() - this.lastContact) / 1000)}s; killing ${running.length} wake(s)`);
    for (const w of running) await this.kill(w.status.id, "watchdog");
    return running.map((w) => w.status.id);
  }

  private async follow(w: Wake): Promise<void> {
    const code = await w.container!.exited;
    clearTimeout(w.timer);
    const s = w.status;
    s.state = "exited";
    s.exitCode = code;
    s.endedAt = this.now();
    s.timings.runMs = s.endedAt - (s.startedAt + (s.timings.imageCheckMs ?? 0) + (s.timings.containerStartMs ?? 0));
    s.homeBytes = dirBytes(runnerAgentDirs(this.o.dataDir, s.world, s.agent).home);
    this.saveStatus(s);
    this.log.info(`wake exited ${code}${s.killed ? ` (killed: ${s.killed})` : ""}`, { ...this.ctx(s), exit_code: code, run_ms: s.timings.runMs });
  }

  async kill(id: string, reason: string): Promise<void> {
    const w = this.wakes.get(id);
    if (!w || w.status.state === "exited") return;
    const first = !w.status.killed;
    w.status.killed = w.status.killed ?? reason;
    this.saveStatus(w.status);
    if (!w.container) {
      w.pendingKill = true;
      return;
    }
    await this.o.runtime.kill(id);
    // `docker kill` can miss (a container still being created, a daemon hiccup): repeat until it is gone.
    if (first) void this.keepKilling(w);
  }

  private async keepKilling(w: Wake): Promise<void> {
    const every = this.o.killRetryMs ?? 1_000;
    for (;;) {
      const gone = await Promise.race([w.container!.exited.then(() => true), Bun.sleep(every).then(() => false)]);
      if (gone || w.status.state === "exited") return;
      await this.o.runtime.kill(w.status.id);
    }
  }

  // ---- HTTP ----

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === `${RUNNER_API}/health`) return json({ ok: true, version: RUNNER_VERSION });
      const auth = req.headers.get("authorization") ?? "";
      if (!this.o.token || !sameSecret(auth, `Bearer ${this.o.token}`)) return json({ error: "unauthorized" }, 401);
      this.lastContact = this.now();
      return await this.route(req, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      this.log.error(`runner: ${req.method} ${url.pathname}: ${String((e as Error)?.stack ?? e).slice(0, 800)}`);
      return json({ error: String((e as Error)?.message ?? e).slice(0, 500) }, 500);
    }
  }

  private async body<T>(req: Request): Promise<T> {
    try {
      return (await req.json()) as T;
    } catch {
      throw new HttpError(400, "expected a JSON body");
    }
  }

  private async route(req: Request, url: URL): Promise<Response> {
    const p = url.pathname.slice(RUNNER_API.length).split("/").filter(Boolean).map(decodeURIComponent);
    const m = req.method;
    const is = (method: string, ...segs: (string | null)[]) => m === method && p.length === segs.length && segs.every((s, i) => s === null || s === p[i]);

    if (is("POST", "ping")) return json({ ok: true });
    if (is("POST", "ensure-up")) return json(await this.ensureUp(await this.body<EnsureUpRequest>(req)));
    if (is("POST", "worlds", null, "up")) return json(await this.worldUp(checkWorld(p[1]), await this.body<WorldUpRequest>(req)));
    if (is("POST", "worlds", null, "down")) return json(await this.worldDown(checkWorld(p[1])));
    if (is("POST", "worlds", null, "relay", "revoke")) {
      const { wake } = await this.body<{ wake: number }>(req);
      revokeSearchToken(runnerRelayDirs(this.o.dataDir, checkWorld(p[1])), Number(wake));
      return json({ ok: true });
    }
    if (is("POST", "worlds", null, "agents", null, "prepare")) return json(this.prepare(checkWorld(p[1]), checkAgent(p[3]), await this.body<PrepareRequest>(req)));
    if (is("GET", "worlds", null, "agents", null, "home", "info")) return json(this.homeInfo(checkWorld(p[1]), checkAgent(p[3])));
    if (is("GET", "worlds", null, "agents", null, "home")) return this.pullHome(checkWorld(p[1]), checkAgent(p[3]));
    if (is("PUT", "worlds", null, "agents", null, "home")) return json(await this.pushHome(checkWorld(p[1]), checkAgent(p[3]), Number(url.searchParams.get("generation")), req));
    if (is("POST", "worlds", null, "agents", null, "generation")) {
      const { generation } = await this.body<{ generation: number }>(req);
      return json(this.setGeneration(checkWorld(p[1]), checkAgent(p[3]), generation));
    }
    if (is("POST", "wakes")) return json(await this.startWake(await this.body<WakeStartRequest>(req)));
    if (is("GET", "wakes")) return json([...this.wakes.values()].map((w) => w.status));
    if (is("GET", "wakes", null)) {
      const w = this.wakes.get(checkWake(p[1]));
      return w ? json(w.status) : json({ error: "unknown wake" }, 404);
    }
    if (is("POST", "wakes", null, "kill")) {
      await this.kill(checkWake(p[1]), "kill requested");
      return json({ ok: true });
    }
    if (is("POST", "wakes", null, "release")) return json(this.release(checkWake(p[1])));
    if (is("POST", "kill-all")) {
      const { world } = await this.body<{ world?: string }>(req);
      return json({ killed: await this.killAll(world ? checkWorld(world) : undefined) });
    }
    if (is("GET", "read")) return this.read(url);
    if (is("GET", "stat")) {
      const st = this.statRef(this.fileRef(url));
      return st ? json(st) : json({ error: "not found" }, 404);
    }
    if (is("GET", "list")) return json(this.list(url));
    if (is("GET", "logs")) return json(this.logs(Number(url.searchParams.get("since") ?? 0) || 0, Number(url.searchParams.get("limit") ?? 1000) || 1000));
    throw new HttpError(404, `no route ${m} ${url.pathname}`);
  }

  /** The runner's log merged with every world relay's own log (docker/search/relay.ts), by time. */
  private logs(since: number, limit: number) {
    const worlds = existsSync(runnerDirs(this.o.dataDir).worlds) ? readdirSync(runnerDirs(this.o.dataDir).worlds).filter((w) => WORLD_ID_RE.test(w)) : [];
    return readLogs([runnerDirs(this.o.dataDir).logFile, ...worlds.map((w) => runnerRelayDirs(this.o.dataDir, w).processLogFile)], since, limit);
  }

  // ---- host and worlds ----

  private async ensureUp(r: EnsureUpRequest) {
    if (!r?.host?.network || !r.image) throw new HttpError(400, "ensure-up needs host and image");
    const t0 = this.now();
    await this.o.infra.ensureProxy(r.host.network.allowlist);
    const image = await this.o.infra.ensureImage(r.image);
    this.host = r.host;
    writeAtomic(runnerDirs(this.o.dataDir).hostFile, JSON.stringify(r.host), 0o644);
    this.relaySecrets = { ...(r.relaySecrets ?? {}) };
    const appliedHash = hostConfigHash(r.host);
    this.log.info(`host config applied (${appliedHash}), image ${r.image}`, { applied_hash: appliedHash, ms: this.now() - t0 });
    return { appliedHash, image: { ref: r.image, ...image }, runnerVersion: RUNNER_VERSION };
  }

  private requireHost(): HostConfig {
    if (!this.host) throw new HttpError(409, "runner has no host config yet (ensure-up first)");
    return this.host;
  }

  private async worldUp(world: string, r: WorldUpRequest) {
    const host = this.requireHost();
    if (r.relay) {
      const dirs = runnerRelayDirs(this.o.dataDir, world);
      await this.o.infra.relayUp({ world, dir: dirs.base, network: host.network.name, webfetch: r.relay.webfetch, exaKey: this.relaySecrets.EXA_API_KEY });
    }
    if (r.forgeTarget) await this.o.infra.forgeForwarderUp({ world, network: host.network.name, target: r.forgeTarget });
    this.log.info(`world up${r.relay ? " (relay)" : ""}${r.forgeTarget ? ` (forge via ${r.forgeTarget})` : ""}`, { world });
    return { ok: true };
  }

  private async worldDown(world: string) {
    await this.o.infra.relayDown(world);
    await this.o.infra.forgeForwarderDown(world);
    this.log.info("world down", { world });
    return { ok: true };
  }

  private async killAll(world?: string): Promise<string[]> {
    for (const w of this.wakes.values()) if (w.status.state !== "exited" && (!world || w.status.world === world)) {
      w.status.killed = w.status.killed ?? "kill-all";
      this.saveStatus(w.status);
      if (!w.container) w.pendingKill = true;
    }
    const killed = await this.o.infra.killAll(world);
    this.log.warn(`kill-all: ${killed.length} container(s)`, { world: world ?? null });
    return killed;
  }

  // ---- agents ----

  private prepare(world: string, agent: string, r: PrepareRequest) {
    const d = runnerAgentDirs(this.o.dataDir, world, agent);
    this.agentDirsReady(d);
    const kept: string[] = [];
    for (const rel of r.remove ?? []) {
      if (!safeRelPath(rel)) throw new HttpError(400, `bad path ${JSON.stringify(rel)}`);
      rmSync(join(d.runtime, rel), { force: true, recursive: true });
    }
    for (const f of r.files ?? []) {
      if ((f.area !== "runtime" && f.area !== "self") || !safeRelPath(f.path)) throw new HttpError(400, `bad file ${f.area}:${JSON.stringify(f.path)}`);
      const root = f.area === "runtime" ? d.runtime : d.self;
      realParents(root, f.path);
      const abs = join(root, f.path);
      if (f.ifMissing && lstatSync(abs, { throwIfNoEntry: false })?.isFile()) {
        kept.push(f.path);
        continue;
      }
      writeAtomic(abs, Buffer.from(f.content, "base64"), (f.mode ?? 0o644) & 0o777);
    }
    this.secrets.set(`${world}/${agent}`, { ...(r.env ?? {}) });
    if (r.relayToken) registerRelayToken(runnerRelayDirs(this.o.dataDir, world), r.relayToken.hash, { agent, wake: r.relayToken.wake, search: !!r.relayToken.search });
    return { kept };
  }

  /** The agent's dirs exist. They belong to the runner's user, which on Linux is the agents' uid (main.ts checks). */
  private agentDirsReady(d: ReturnType<typeof runnerAgentDirs>): void {
    for (const p of [d.home, d.self, d.runtime]) mkdirSync(p, { recursive: true });
  }

  private homeInfo(world: string, agent: string): HomeInfo {
    const d = runnerAgentDirs(this.o.dataDir, world, agent);
    const excludes = new Set(this.host?.runner.homeExcludes ?? []);
    const unknownRuntime = existsSync(d.runtime) ? readdirSync(d.runtime).filter((n) => !knownRuntimeEntry(n)).sort() : [];
    const skipped: string[] = [];
    const bytes = snapshotBytes(this.syncSources(world, agent), excludes, skipped);
    return { generation: this.generationOf(world, agent), bytes, unknownRuntime, skipped };
  }

  private generationOf(world: string, agent: string): number | null {
    try {
      const n = Number(readFileSync(runnerAgentDirs(this.o.dataDir, world, agent).generation, "utf8").trim());
      return Number.isInteger(n) ? n : null;
    } catch {
      return null;
    }
  }

  private setGeneration(world: string, agent: string, generation: unknown) {
    if (!Number.isInteger(generation) || (generation as number) < 0) throw new HttpError(400, "generation: expected an integer >= 0");
    const d = runnerAgentDirs(this.o.dataDir, world, agent);
    mkdirSync(d.base, { recursive: true });
    writeAtomic(d.generation, String(generation), 0o644);
    return { generation };
  }

  private syncSources(world: string, agent: string): SnapshotSource[] {
    const d = runnerAgentDirs(this.o.dataDir, world, agent);
    return [{ prefix: "home", dir: d.home }, ...RUNTIME_SYNC_DIRS.map((s) => ({ prefix: `runtime/${s}`, dir: join(d.runtime, s) }))];
  }

  private agentBusy(world: string, agent: string): boolean {
    return [...this.wakes.values()].some((w) => w.status.state !== "exited" && w.status.world === world && w.status.agent === agent);
  }

  /** The home and the runtime's session dirs as a snapshot stream. Never during the agent's wake. */
  private pullHome(world: string, agent: string): Response {
    if (this.agentBusy(world, agent)) throw new HttpError(409, `${agent} is in a wake`);
    const host = this.host;
    const excludes = new Set(host?.runner.homeExcludes ?? []);
    const sources = this.syncSources(world, agent);
    const bytes = snapshotBytes(sources, excludes);
    if (host && bytes > host.runner.homeCapBytes) throw new HttpError(413, `home is ${bytes} bytes, over the cap of ${host.runner.homeCapBytes}`);
    const gen = this.generationOf(world, agent);
    return new Response(snapshotStream(sources, excludes), {
      headers: { "content-type": "application/octet-stream", "x-home-bytes": String(bytes), "x-generation": gen === null ? "" : String(gen) },
    });
  }

  /** Replace the home and session dirs with a snapshot from the controller, then set the generation. */
  private async pushHome(world: string, agent: string, generation: number, req: Request) {
    if (!Number.isInteger(generation) || generation < 0) throw new HttpError(400, "generation: expected an integer >= 0");
    if (this.agentBusy(world, agent)) throw new HttpError(409, `${agent} is in a wake`);
    if (!req.body) throw new HttpError(400, "expected a snapshot body");
    const d = runnerAgentDirs(this.o.dataDir, world, agent);
    mkdirSync(d.base, { recursive: true });
    const tmp = join(d.base, `.push-${Math.random().toString(36).slice(2, 10)}`);
    mkdirSync(tmp);
    try {
      const bytes = await extractSnapshot(req.body, tmp, ["home", ...RUNTIME_SYNC_DIRS.map((s) => `runtime/${s}`)]);
      mkdirSync(join(tmp, "home"), { recursive: true });
      rmSync(d.home, { recursive: true, force: true });
      renameSync(join(tmp, "home"), d.home);
      mkdirSync(d.runtime, { recursive: true });
      for (const s of RUNTIME_SYNC_DIRS) {
        rmSync(join(d.runtime, s), { recursive: true, force: true });
        if (existsSync(join(tmp, "runtime", s))) renameSync(join(tmp, "runtime", s), join(d.runtime, s));
      }
      this.setGeneration(world, agent, generation);
      this.log.info(`home pushed: generation ${generation}, ${bytes} bytes`, { world, agent, generation, bytes });
      return { generation, bytes };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ---- wakes ----

  private async startWake(r: WakeStartRequest): Promise<WakeStatus> {
    const host = this.requireHost();
    const id = checkWake(r.id);
    const world = checkWorld(r.world);
    const agent = checkAgent(r.agent);
    const existing = this.wakes.get(id);
    if (existing) return existing.status; // a retried start
    if (this.agentBusy(world, agent)) throw new HttpError(409, `${agent} is already in a wake`);
    if (!Array.isArray(r.argv) || !r.argv.length || typeof r.image !== "string") throw new HttpError(400, "wake needs argv and image");
    const secrets = this.secrets.get(`${world}/${agent}`) ?? {};
    for (const name of r.secretEnv ?? []) if (!(name in secrets)) throw new HttpError(409, `secret ${name} was not prepared for ${agent}`);
    const d = runnerAgentDirs(this.o.dataDir, world, agent);
    this.agentDirsReady(d);
    const wd = runnerWakeDir(this.o.dataDir, id);
    mkdirSync(wd.base, { recursive: true });
    writeAtomic(wd.meta, JSON.stringify({ ...r, env: r.env, secretEnv: r.secretEnv }), 0o600);
    const status: WakeStatus = {
      id, world, run: r.run, agent, wakeId: r.wakeId, state: "starting", exitCode: null, killed: null,
      startedAt: this.now(), endedAt: null, homeBytes: null, error: null, timings: {},
    };
    this.saveStatus(status);
    for (const f of [wd.stdout, wd.stderr]) writeFileSync(f, "");
    const w: Wake = { status, pendingKill: false, done: Promise.resolve() };
    this.wakes.set(id, w);
    w.timer = setTimeout(() => void this.kill(id, "hard timeout"), Math.max(0, r.hardTimeoutMs));

    const argv = dockerRunArgs({
      name: id,
      image: r.image,
      runId: r.run,
      agent,
      world,
      wake: id,
      detach: true,
      mounts: { home: d.home, self: d.self, runtime: d.runtime },
      env: r.env ?? {},
      passEnv: r.secretEnv ?? [],
      argv: r.argv,
      network: host.network.name,
      proxy: host.network.proxy,
      noProxy: r.noProxy ?? [],
      limits: host.container,
    });
    const env = dockerProcessEnv({ passEnv: [] }, { ...process.env, ...Object.fromEntries((r.secretEnv ?? []).map((k) => [k, secrets[k]])) });
    // Launch in the background: the controller follows the status and the output files.
    w.done = (async () => {
      const t0 = this.now();
      try {
        await this.o.infra.ensureImage(r.image);
        status.timings.imageCheckMs = this.now() - t0;
        if (w.pendingKill || status.killed) throw new Error(`killed before start (${status.killed})`);
        const t1 = this.now();
        w.container = await this.o.runtime.launch(argv, env, { stdout: wd.stdout, stderr: wd.stderr });
        status.timings.containerStartMs = this.now() - t1;
        status.state = "running";
        this.saveStatus(status);
        this.log.info("wake started", { ...this.ctx(status), image_check_ms: status.timings.imageCheckMs, container_start_ms: status.timings.containerStartMs });
        if (w.pendingKill) {
          await this.o.runtime.kill(id);
          void this.keepKilling(w);
        }
        await this.follow(w);
      } catch (e) {
        clearTimeout(w.timer);
        status.state = "exited";
        status.exitCode = null;
        status.endedAt = this.now();
        status.error = String((e as Error)?.message ?? e).slice(0, 500);
        this.saveStatus(status);
        this.log.error(`wake did not start: ${status.error}`, this.ctx(status));
      }
    })();
    return status;
  }

  /** Forget a finished wake: its output files go (the controller has copied them). */
  private release(id: string) {
    const w = this.wakes.get(id);
    if (w && w.status.state !== "exited") throw new HttpError(409, "wake still running");
    this.wakes.delete(id);
    rmSync(runnerWakeDir(this.o.dataDir, id).base, { recursive: true, force: true });
    return { ok: true };
  }

  // ---- files ----

  private fileRef(url: URL): FileRef {
    const q = url.searchParams;
    if (q.has("wake")) {
      const file = q.get("file");
      if (file !== "stdout" && file !== "stderr") throw new HttpError(400, "file: stdout or stderr");
      return { wake: checkWake(q.get("wake")), file };
    }
    const world = checkWorld(q.get("world"));
    if (q.has("relay")) {
      const relay = q.get("relay");
      if (relay !== "search" && relay !== "fetch") throw new HttpError(400, "relay: search or fetch");
      return { world, relay };
    }
    const area = q.get("area");
    if (area !== "home" && area !== "runtime") throw new HttpError(400, "area: home or runtime");
    const path = q.get("path") ?? "";
    return { world, agent: checkAgent(q.get("agent")), area, path };
  }

  /** Host path of a ref, or null when it isn't allowed or doesn't resolve inside its root. */
  private resolve(ref: FileRef): string | null {
    if ("wake" in ref) {
      const d = runnerWakeDir(this.o.dataDir, ref.wake);
      return ref.file === "stdout" ? d.stdout : d.stderr;
    }
    if ("relay" in ref) {
      const d = runnerRelayDirs(this.o.dataDir, ref.world);
      return ref.relay === "search" ? d.logFile : d.fetchLogFile;
    }
    if (ref.path !== "" && !safeRelPath(ref.path)) return null;
    const d = runnerAgentDirs(this.o.dataDir, ref.world, ref.agent);
    if (ref.area === "runtime" && ref.path !== "" && !runtimeReadable(ref.path)) return null;
    const root = ref.area === "home" ? d.home : d.runtime;
    const abs = ref.path ? join(root, ref.path) : root;
    // Symlinks may point anywhere: the resolved path must stay inside the root.
    try {
      const real = realpathSync(abs);
      const realRoot = realpathSync(root);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
      return real;
    } catch {
      return null;
    }
  }

  private statRef(ref: FileRef): FileStat | null {
    const abs = this.resolve(ref);
    if (!abs) return null;
    const st = statSync(abs, { throwIfNoEntry: false });
    if (!st) return null;
    return { path: "path" in ref ? ref.path : "", kind: st.isFile() ? "file" : st.isDirectory() ? "dir" : "other", size: st.size, mtimeMs: st.mtimeMs };
  }

  private async read(url: URL): Promise<Response> {
    const ref = this.fileRef(url);
    const abs = this.resolve(ref);
    if (!abs) return json({ error: "not found" }, 404);
    // The agent can swap files under its home while we read: open without following a final symlink (and without
    // blocking on a FIFO), then make sure the open file is still the one that resolved inside the root.
    let fd: number;
    try {
      fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch {
      return json({ error: "not found" }, 404);
    }
    try {
      const st = fstatSync(fd);
      const again = this.resolve(ref);
      const now = again ? statSync(again, { throwIfNoEntry: false }) : null;
      if (!st.isFile() || again !== abs || !now || now.ino !== st.ino || now.dev !== st.dev) return json({ error: "not found" }, 404);
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
      const limit = Math.min(READ_MAX, Math.max(0, Number(url.searchParams.get("limit") ?? READ_MAX) || READ_MAX));
      const end = Math.min(st.size, offset + limit);
      const data = new Uint8Array(Math.max(0, end - offset));
      let got = 0;
      while (got < data.length) {
        const n = readSync(fd, data, got, data.length - got, offset + got);
        if (n <= 0) break;
        got += n;
      }
      return new Response(data.subarray(0, got), { headers: { "content-type": "application/octet-stream", "x-size": String(st.size) } });
    } finally {
      closeSync(fd);
    }
  }

  /** Entries under a home (or readable runtime) dir, recursively up to `depth`, at most LIST_MAX. Symlinks are listed, not followed. */
  private list(url: URL): FileStat[] {
    const ref = this.fileRef(url);
    if ("wake" in ref || "relay" in ref) throw new HttpError(400, "list: an agent's home or runtime");
    const depth = Math.min(12, Math.max(1, Number(url.searchParams.get("depth") ?? 1) || 1));
    const skip = new Set((url.searchParams.get("skip") ?? "").split(",").filter(Boolean));
    // Listed but not walked (e.g. .git): one entry each.
    const opaque = new Set((url.searchParams.get("opaque") ?? "").split(",").filter(Boolean));
    const root = this.resolve(ref);
    if (!root || !statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
    const out: FileStat[] = [];
    const walk = (abs: string, rel: string, left: number) => {
      let names: string[];
      try {
        names = readdirSync(abs).sort();
      } catch {
        return;
      }
      for (const n of names) {
        if (out.length >= LIST_MAX) return;
        if (skip.has(n)) continue;
        const p = rel ? `${rel}/${n}` : n;
        if (ref.area === "runtime" && !runtimeReadable(ref.path ? `${ref.path}/${p}` : p)) continue;
        const st = lstatSync(join(abs, n), { throwIfNoEntry: false });
        if (!st) continue;
        const kind = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
        out.push({ path: p, kind, size: st.size, mtimeMs: st.mtimeMs });
        if (kind === "dir" && left > 1 && !opaque.has(n)) walk(join(abs, n), p, left - 1);
      }
    };
    walk(root, "", depth);
    return out;
  }
}
