// The controller's view of an agent host (docs/plans/2026-10-12-hosted-control-plane.md §2.2): everything the wake
// loop does to an agent's files and containers goes through this, keyed by world and agent. The only
// implementation is RunnerHost, which talks HTTP to a runner (src/runner/), locally or over the tailnet.
import { RUNNER_API, type EnsureUpRequest, type EnsureUpResponse, type FileRef, type FileStat, type HomeInfo, type PrepareRequest, type PrepareResponse, type ReadResult, type RunnerLogLine, type WakeStartRequest, type WakeStatus, type WorldUpRequest } from "../runner/protocol.ts";

export interface AgentHost {
  /** Apply the host config (proxy, allowlist, limits) and make the agent image available. */
  ensureUp(r: EnsureUpRequest): Promise<EnsureUpResponse>;
  worldUp(world: string, r: WorldUpRequest): Promise<void>;
  worldDown(world: string): Promise<void>;
  prepare(world: string, agent: string, r: PrepareRequest): Promise<PrepareResponse>;
  revokeRelayToken(world: string, wake: number): Promise<void>;
  startWake(r: WakeStartRequest): Promise<WakeStatus>;
  /** null: the runner doesn't know the wake. */
  wakeStatus(id: string): Promise<WakeStatus | null>;
  wakes(): Promise<WakeStatus[]>;
  kill(id: string): Promise<void>;
  killAll(world?: string): Promise<string[]>;
  /** Drop a finished wake's output on the runner. */
  release(id: string): Promise<void>;
  /** Bytes from `offset` (null: no such file, or not readable). */
  read(ref: FileRef, offset?: number, limit?: number): Promise<ReadResult | null>;
  stat(ref: FileRef): Promise<FileStat | null>;
  list(ref: Extract<FileRef, { area: string }>, o?: { depth?: number; skip?: string[]; opaque?: string[] }): Promise<FileStat[]>;
  homeInfo(world: string, agent: string): Promise<HomeInfo>;
  /** The home and session dirs as a snapshot stream (src/runner/snapshot.ts). */
  pullHome(world: string, agent: string): Promise<{ stream: ReadableStream<Uint8Array>; bytes: number }>;
  pushHome(world: string, agent: string, generation: number, snapshot: ReadableStream<Uint8Array>): Promise<void>;
  setGeneration(world: string, agent: string, generation: number): Promise<void>;
  logs(since: number, limit?: number): Promise<RunnerLogLine[]>;
  /** Keeps the runner's watchdog quiet. */
  ping(): Promise<void>;
}

export class RunnerError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}

export interface RunnerHostOptions {
  url: string;
  token: string;
  /** Injectable transport (tests call Runner.handle directly). */
  fetch?: (req: Request) => Promise<Response>;
  /** Per-call timeout for small calls (snapshots have none). */
  timeoutMs?: number;
}

function refQuery(ref: FileRef): URLSearchParams {
  if ("wake" in ref) return new URLSearchParams({ wake: ref.wake, file: ref.file });
  if ("relay" in ref) return new URLSearchParams({ world: ref.world, relay: ref.relay });
  return new URLSearchParams({ world: ref.world, agent: ref.agent, area: ref.area, path: ref.path });
}

const enc = encodeURIComponent;

export class RunnerHost implements AgentHost {
  private readonly base: string;
  private readonly send: (req: Request) => Promise<Response>;
  constructor(private readonly o: RunnerHostOptions) {
    this.base = o.url.replace(/\/+$/, "") + RUNNER_API;
    this.send = o.fetch ?? ((req) => fetch(req));
  }

  private async call(method: string, path: string, o: { body?: unknown; raw?: ReadableStream<Uint8Array>; query?: URLSearchParams; timeout?: boolean } = {}): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.o.token}` };
    let body: RequestInit["body"];
    if (o.raw !== undefined) {
      body = o.raw as RequestInit["body"];
      headers["content-type"] = "application/octet-stream";
    } else if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers["content-type"] = "application/json";
    }
    const url = `${this.base}${path}${o.query ? `?${o.query}` : ""}`;
    const signal = o.timeout === false ? undefined : AbortSignal.timeout(this.o.timeoutMs ?? 60_000);
    const init: RequestInit & { duplex?: string } = { method, headers, body, signal };
    if (o.raw instanceof ReadableStream) init.duplex = "half";
    let res: Response;
    try {
      res = await this.send(new Request(url, init));
    } catch (e) {
      throw new RunnerError(0, `runner unreachable (${method} ${path}): ${(e as Error).message}`);
    }
    return res;
  }

  private async ok<T>(method: string, path: string, o: Parameters<RunnerHost["call"]>[2] = {}): Promise<T> {
    const res = await this.call(method, path, o);
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        /* plain text */
      }
      throw new RunnerError(res.status, `runner ${method} ${path}: ${res.status} ${msg}`.slice(0, 600));
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  ensureUp(r: EnsureUpRequest) {
    // Pulling or building the image can take minutes.
    return this.ok<EnsureUpResponse>("POST", "/ensure-up", { body: r, timeout: false });
  }
  async worldUp(world: string, r: WorldUpRequest) {
    await this.ok("POST", `/worlds/${enc(world)}/up`, { body: r, timeout: false });
  }
  async worldDown(world: string) {
    await this.ok("POST", `/worlds/${enc(world)}/down`, { body: {} });
  }
  prepare(world: string, agent: string, r: PrepareRequest) {
    return this.ok<PrepareResponse>("POST", `/worlds/${enc(world)}/agents/${enc(agent)}/prepare`, { body: r });
  }
  async revokeRelayToken(world: string, wake: number) {
    await this.ok("POST", `/worlds/${enc(world)}/relay/revoke`, { body: { wake } });
  }
  startWake(r: WakeStartRequest) {
    return this.ok<WakeStatus>("POST", "/wakes", { body: r });
  }
  async wakeStatus(id: string) {
    const res = await this.call("GET", `/wakes/${enc(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new RunnerError(res.status, `runner GET /wakes/${id}: ${res.status} ${await res.text()}`);
    return (await res.json()) as WakeStatus;
  }
  wakes() {
    return this.ok<WakeStatus[]>("GET", "/wakes");
  }
  async kill(id: string) {
    await this.ok("POST", `/wakes/${enc(id)}/kill`, { body: {} });
  }
  async killAll(world?: string) {
    return (await this.ok<{ killed: string[] }>("POST", "/kill-all", { body: { world } })).killed;
  }
  async release(id: string) {
    await this.ok("POST", `/wakes/${enc(id)}/release`, { body: {} });
  }
  async read(ref: FileRef, offset = 0, limit?: number): Promise<ReadResult | null> {
    const q = refQuery(ref);
    q.set("offset", String(offset));
    if (limit !== undefined) q.set("limit", String(limit));
    const res = await this.call("GET", "/read", { query: q });
    if (res.status === 404) return null;
    if (!res.ok) throw new RunnerError(res.status, `runner read: ${res.status} ${await res.text()}`);
    return { data: new Uint8Array(await res.arrayBuffer()), size: Number(res.headers.get("x-size") ?? 0) };
  }
  async stat(ref: FileRef) {
    const res = await this.call("GET", "/stat", { query: refQuery(ref) });
    if (res.status === 404) return null;
    if (!res.ok) throw new RunnerError(res.status, `runner stat: ${res.status} ${await res.text()}`);
    return (await res.json()) as FileStat;
  }
  list(ref: Extract<FileRef, { area: string }>, o: { depth?: number; skip?: string[]; opaque?: string[] } = {}) {
    const q = refQuery(ref);
    if (o.depth) q.set("depth", String(o.depth));
    if (o.skip?.length) q.set("skip", o.skip.join(","));
    if (o.opaque?.length) q.set("opaque", o.opaque.join(","));
    return this.ok<FileStat[]>("GET", "/list", { query: q });
  }
  homeInfo(world: string, agent: string) {
    return this.ok<HomeInfo>("GET", `/worlds/${enc(world)}/agents/${enc(agent)}/home/info`);
  }
  async pullHome(world: string, agent: string) {
    const res = await this.call("GET", `/worlds/${enc(world)}/agents/${enc(agent)}/home`, { timeout: false });
    if (!res.ok || !res.body) throw new RunnerError(res.status, `runner pull home ${world}/${agent}: ${res.status} ${await res.text()}`);
    return { stream: res.body, bytes: Number(res.headers.get("x-home-bytes") ?? 0) };
  }
  async pushHome(world: string, agent: string, generation: number, snapshot: ReadableStream<Uint8Array>) {
    await this.ok("PUT", `/worlds/${enc(world)}/agents/${enc(agent)}/home`, { raw: snapshot, query: new URLSearchParams({ generation: String(generation) }), timeout: false });
  }
  async setGeneration(world: string, agent: string, generation: number) {
    await this.ok("POST", `/worlds/${enc(world)}/agents/${enc(agent)}/generation`, { body: { generation } });
  }
  logs(since: number, limit = 1000) {
    return this.ok<RunnerLogLine[]>("GET", "/logs", { query: new URLSearchParams({ since: String(since), limit: String(limit) }) });
  }
  async ping() {
    await this.ok("POST", "/ping", { body: {} });
  }
}
