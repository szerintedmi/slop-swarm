// The HTTP API (docs/plans/2026-10-12-hosted-control-plane.md §5.2), in the controller process. Every feature is an
// endpoint first, then a CLI command (`--json`), a `just` recipe and a dashboard control.
//
// Access: the bind address is the boundary (localhost, and the tailnet address on the VPS: the dashboard relies on
// tailnet membership). A request that carries a bearer token must carry SLOPSWARM_API_TOKEN (scripts, CI). Every
// mutating request needs the `X-Slopswarm` header and is refused when the browser says it is cross-site.
//
//   GET    /api/v1/status[?run=]                    active (or given, else latest) run: state, extensions, queued controls
//   GET    /api/v1/runs                             runs, newest first
//   GET    /api/v1/runs/:id                         one run's state
//   GET    /api/v1/runs/:id/wakes[?agent=]          its wakes
//   GET    /api/v1/runs/:id/report                  the Markdown report
//   POST   /api/v1/runs/:id/stop | kill | resume    graceful stop / emergency kill / continue a stopped run
//   POST   /api/v1/runs/:id/extend                  {timeMs?, swarmUsd?, agentUsd?}
//   POST   /api/v1/runs/:id/agents/:name/pause | unpause | wake
//   GET    /api/v1/wakes/:id                        a wake with its requests
//   GET    /api/v1/wakes/:id/transcript             its raw CLI log (text)
//   POST   /api/v1/launches                         {preset, world?, brief?} -> {id}
//   GET    /api/v1/launches/:id                     {status: pending | done | failed, run?, error?}
//   GET    /api/v1/logs[?since=ms&limit=]           controller + runner structured logs
//   GET    /api/v1/worlds                           worlds with runs and agents
//   GET    /api/v1/worlds/:id                       one world
//   GET    /api/v1/worlds/:id/pages[?owner=]        {url, repos}: its published repos (src/pages.ts); the forge must be up
//   GET    /api/v1/worlds/:id/agents/:name/home     home tree (live, or the VPS copy)
//   GET    /api/v1/worlds/:id/agents/:name/file?path=  one home file
//   GET    /api/v1/presets | agents                 config rows
//   GET|PUT|DELETE /api/v1/presets/:name | agents/:name   {yaml} validated on save
//   GET    /api/v1/seeds[?name=]                    every seed's versions (without text); /seeds/:id with text
//   POST   /api/v1/seeds                            {name?, text, note?}: a new active version of that seed (default: `default`)
//   POST   /api/v1/seeds/:id/activate               the active version of its seed
//   DELETE /api/v1/seeds/:name                      a seed with all its versions (not `default`, not one a preset names)
//   GET    /api/v1/config                           the whole config as a bundle; POST imports one
//   POST   /api/v1/worlds/:id/forge-image           {image}: a new Forgejo image for an idle world (runs its migrations)
//   GET    /api/v1/backups                          backups and disk use; POST {db?, worlds?} backs up now
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { diskUse, listBackups } from "./backup.ts";
import { ConfigError, DEFAULT_SEED } from "./config.ts";
import {
  activateSeed,
  configBundle,
  deleteAgentProfile,
  deletePreset,
  deleteSeed,
  getAgentProfile,
  getPreset,
  importBundle,
  listAgentProfiles,
  listPresets,
  listSeeds,
  saveAgentProfile,
  savePreset,
  saveSeed,
  type ConfigBundle,
  type SeedRow,
} from "./config-db.ts";
import { activeRunIn } from "./controller/run.ts";
import { listWorlds } from "./controller/worlds.ts";
import { agentsOf, overviewState, runLive, wakesOf } from "./dashboard/data.ts";
import { homeFile, homeTree } from "./dashboard/homes.ts";
import { dataDir, enqueueControl, getRun, getWorld, latestRun, worldOf, type ControlAction, type ControlRow, type RequestRow, type RunRow, type WakeRow } from "./db/index.ts";
import type { AgentHost } from "./host/agent-host.ts";
import { readLogs } from "./log.ts";
import { renderReport } from "./report.ts";
import { runnerDataDir } from "./runner/main.ts";
import type { LaunchRequest } from "./service.ts";
import { describeExtension, extensionsOf, parseExtendDetail, swarmBudgetUsd, worldTime } from "./world.ts";

export const API_PREFIX = "/api/v1";
export const CSRF_HEADER = "x-slopswarm";

/** What the API needs from the controller service (absent: a read-only dashboard). */
export interface ApiService {
  enqueueLaunch(r: LaunchRequest, source: string): number;
  activeRun(): RunRow | null;
  resumeRun?(id: string): Promise<void>;
  backupNow?(o: { db?: boolean; worlds?: string[] }): Promise<unknown>;
  upgradeForge?(world: string, image: string): Promise<void>;
  pages?(world: string, owner?: string): Promise<{ url: string | null; repos: unknown[] }>;
}

export interface ApiOptions {
  db: Database;
  readonly?: boolean;
  /** SLOPSWARM_API_TOKEN: a request with a bearer token must carry this one. */
  token?: string;
  host?: AgentHost;
  service?: ApiService;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const text = (t: string, type = "text/plain; charset=utf-8") => new Response(t, { headers: { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "no-store" } });

function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Display fields of a run (never the config, seed or pricing snapshots). */
export function publicRun(run: RunRow) {
  const { id, name, status, started_at, deadline_at, ended_at, stop_reason, brief, host_hash } = run;
  return { id, name, world: worldOf(run), status, started_at, deadline_at, ended_at, stop_reason, brief, host_hash };
}
export function publicWake(w: WakeRow) {
  const { raw_log_path: _r, container_name: _c, ...rest } = w;
  return rest;
}
const seedMeta = ({ text: _t, ...s }: SeedRow) => s;

const AGENT_ACTIONS: readonly ControlAction[] = ["pause", "unpause", "wake"];

/** Queue a run or agent control after checking it, as the CLI and the dashboard do (one code path). */
export function queueControl(db: Database, o: { run: RunRow; action: ControlAction; agent?: string | null; source: string; detail?: unknown }): number {
  const { run, action } = o;
  if (!["pause", "unpause", "wake", "stop", "kill", "extend"].includes(action)) throw new ApiError(400, `unknown action ${action}`);
  if (o.agent) {
    if (!AGENT_ACTIONS.includes(action)) throw new ApiError(400, `${action} does not take an agent`);
    if (!agentsOf(db, run.id).some((a) => a.name === o.agent)) throw new ApiError(404, `unknown agent ${o.agent}`);
  } else if (AGENT_ACTIONS.includes(action)) throw new ApiError(400, `${action} needs an agent`);
  let detail: string | null = null;
  if (action === "extend") {
    try {
      const d = parseExtendDetail(JSON.stringify(o.detail ?? null));
      if (!d.timeMs && !d.swarmUsd && !Object.keys(d.agentUsd).length) throw new Error("nothing to extend");
      for (const who of Object.keys(d.agentUsd)) if (who !== "*" && !agentsOf(db, run.id).some((a) => a.name === who)) throw new Error(`unknown agent ${who}`);
      detail = JSON.stringify(d);
    } catch (e) {
      throw new ApiError(400, `extend: ${(e as Error).message}`);
    }
  }
  return enqueueControl(db, run.id, action, o.agent ?? null, o.source, detail);
}

/** A run's status, as `just status` and the API show it. */
export function runStatus(db: Database, run: RunRow, now = Date.now()) {
  const queued = db
    .query<ControlRow, [string]>("SELECT * FROM controls WHERE run_id = ? AND consumed_at IS NULL ORDER BY id")
    .all(run.id)
    .map((c) => ({ id: c.id, action: c.action, agent: c.agent, detail: c.action === "extend" ? describeExtension(parseExtendDetail(c.detail)) : null }));
  const world = worldTime(db, run, now);
  return {
    run: publicRun(run),
    live: runLive(run),
    worldTimeMs: world.elapsedMs,
    swarmBudgetUsd: swarmBudgetUsd(db, run),
    /** The data dir's filesystem (the dashboard warns when it runs low). */
    disk: diskUse(),
    state: overviewState(db, run, now),
    extensions: extensionsOf(db, run.id),
    queued,
  };
}

export function createApi(o: ApiOptions): (req: Request) => Promise<Response | null> {
  const { db } = o;

  const runOr404 = (id: string): RunRow => {
    const r = getRun(db, id);
    if (!r) throw new ApiError(404, `run not found: ${id}`);
    return r;
  };
  const body = async <T>(req: Request): Promise<T> => {
    try {
      return (await req.json()) as T;
    } catch {
      throw new ApiError(400, "expected a JSON body");
    }
  };
  const writable = () => {
    if (o.readonly || !o.service) throw new ApiError(403, "read-only dashboard: no controller here");
  };

  async function route(req: Request, url: URL, p: string[]): Promise<Response> {
    const m = req.method;
    const is = (method: string, ...segs: (string | null)[]) => m === method && p.length === segs.length && segs.every((s, i) => s === null || s === p[i]);

    // ---- runs ----
    if (is("GET", "status")) {
      const id = url.searchParams.get("run");
      const run = id ? runOr404(id) : (o.service?.activeRun() ?? latestRun(db));
      return json(run ? runStatus(db, run) : { run: null });
    }
    if (is("GET", "runs")) return json(db.query<RunRow, []>("SELECT * FROM runs ORDER BY started_at DESC LIMIT 500").all().map(publicRun));
    if (is("GET", "runs", null)) return json(runStatus(db, runOr404(p[1]!)));
    if (is("GET", "runs", null, "wakes")) {
      const run = runOr404(p[1]!);
      const agent = url.searchParams.get("agent") ?? undefined;
      return json(wakesOf(db, run.id, agent).map(publicWake));
    }
    if (is("GET", "runs", null, "report")) return text(renderReport(db, runOr404(p[1]!).id), "text/markdown; charset=utf-8");
    if (m === "POST" && p[0] === "runs" && p.length === 3 && ["stop", "kill", "extend", "resume"].includes(p[2]!)) {
      writable();
      const run = runOr404(p[1]!);
      if (p[2] === "resume") {
        if (!o.service?.resumeRun) throw new ApiError(501, "this controller can't resume runs");
        await o.service.resumeRun(run.id);
        return json({ ok: true, run: run.id });
      }
      const detail = p[2] === "extend" ? await body<unknown>(req) : undefined;
      const active = o.service?.activeRun()?.id === run.id;
      if (p[2] === "kill" && !active) {
        // No controller drives it: kill its containers here and mark it stopped. Only a run that is still marked
        // running has anything to kill, and only when no other run is active in its world (killing a world's
        // containers would kill that run's wakes).
        if (run.status !== "running" && run.status !== "stopping") throw new ApiError(409, `run ${run.id} is not running (${run.status}): nothing to kill`);
        const other = activeRunIn(db, worldOf(run));
        if (other && other.id !== run.id) throw new ApiError(409, `world ${worldOf(run)} has a newer active run (${other.id}); kill that one`);
        const id = queueControl(db, { run, action: "kill", source: "api" });
        const killed = o.host ? await o.host.killAll(worldOf(run)).catch(() => []) : [];
        db.query("UPDATE runs SET status = 'stopped', stop_reason = 'kill (no controller)', ended_at = ? WHERE id = ? AND status IN ('running', 'stopping')").run(Date.now(), run.id);
        db.query("UPDATE worlds SET status = 'idle' WHERE id = ? AND status = 'active'").run(worldOf(run));
        return json({ control: id, killed });
      }
      const id = queueControl(db, { run, action: p[2] as ControlAction, source: "api", detail });
      return json({ control: id, applied: active ? "by the running controller" : "when the run is resumed" });
    }
    if (m === "POST" && p[0] === "runs" && p.length === 5 && p[2] === "agents" && AGENT_ACTIONS.includes(p[4] as ControlAction)) {
      writable();
      const run = runOr404(p[1]!);
      return json({ control: queueControl(db, { run, action: p[4] as ControlAction, agent: p[3]!, source: "api" }) });
    }

    // ---- wakes ----
    if (is("GET", "wakes", null)) {
      const w = db.query<WakeRow, [number]>("SELECT * FROM wakes WHERE id = ?").get(Number(p[1]));
      if (!w) throw new ApiError(404, "wake not found");
      return json({ wake: publicWake(w), requests: db.query<RequestRow, [number]>("SELECT * FROM requests WHERE wake_id = ? ORDER BY seq").all(w.id) });
    }
    if (is("GET", "wakes", null, "transcript")) {
      const w = db.query<WakeRow, [number]>("SELECT * FROM wakes WHERE id = ?").get(Number(p[1]));
      if (!w?.raw_log_path) throw new ApiError(404, "no transcript");
      const f = Bun.file(w.raw_log_path);
      if (!(await f.exists())) throw new ApiError(404, "no transcript");
      return text(await f.text());
    }

    // ---- launches ----
    if (is("POST", "launches")) {
      writable();
      const r = await body<LaunchRequest>(req);
      if (!r || typeof r.preset !== "string" || !r.preset.trim()) throw new ApiError(400, "launch needs a preset");
      if (r.world !== undefined && typeof r.world !== "string") throw new ApiError(400, "world: a world id");
      if (r.brief !== undefined && typeof r.brief !== "string") throw new ApiError(400, "brief: text");
      return json({ id: o.service!.enqueueLaunch({ preset: r.preset.trim(), world: r.world?.trim() || undefined, brief: r.brief?.trim() || undefined }, req.headers.get("x-slopswarm-source") ?? "api") }, 202);
    }
    if (is("GET", "launches", null)) {
      const c = db.query<ControlRow, [number]>("SELECT * FROM controls WHERE id = ? AND action = 'launch'").get(Number(p[1]));
      if (!c) throw new ApiError(404, "launch not found");
      const result = c.result ? (JSON.parse(c.result) as { run?: string; error?: string }) : null;
      return json({ id: c.id, request: JSON.parse(c.detail ?? "{}"), status: !result ? "pending" : result.error ? "failed" : "done", ...result });
    }

    // ---- logs ----
    if (is("GET", "logs")) {
      const since = Number(url.searchParams.get("since") ?? 0) || 0;
      const limit = Math.min(20_000, Number(url.searchParams.get("limit") ?? 2000) || 2000);
      return json(readLogs([join(dataDir(), "logs", "controller.jsonl"), join(dataDir(), "logs", "runner.jsonl"), join(runnerDataDir(), "logs", "runner.jsonl")], since, limit));
    }

    // ---- worlds and homes ----
    if (is("GET", "worlds")) return json(listWorlds(db));
    if (is("GET", "worlds", null)) {
      const w = listWorlds(db).find((x) => x.id === p[1]);
      if (!w) throw new ApiError(404, "world not found");
      return json({ ...w, runs: db.query<RunRow, [string]>("SELECT * FROM runs WHERE COALESCE(world_id, id) = ? ORDER BY started_at DESC").all(w.id).map(publicRun) });
    }
    if (is("GET", "worlds", null, "pages")) {
      if (!getWorld(db, p[1]!)) throw new ApiError(404, "world not found");
      if (!o.service?.pages) throw new ApiError(501, "this controller doesn't serve pages");
      return json(await o.service.pages(p[1]!, url.searchParams.get("owner") ?? undefined));
    }
    if (is("GET", "worlds", null, "agents", null, "home") || is("GET", "worlds", null, "agents", null, "file")) {
      const world = p[1]!;
      if (!getWorld(db, world)) throw new ApiError(404, "world not found");
      if (!db.query("SELECT 1 FROM world_agents WHERE world_id = ? AND name = ?").get(world, p[3]!)) throw new ApiError(404, "agent not in this world");
      if (p[4] === "home") return json(await homeTree(o.host, world, p[3]!));
      const r = await homeFile(o.host, world, p[3]!, url.searchParams.get("path") ?? "");
      if (!r.file.ok) throw new ApiError(r.file.status, r.file.reason);
      return json(r);
    }

    if (is("POST", "worlds", null, "forge-image")) {
      writable();
      if (!o.service?.upgradeForge) throw new ApiError(501, "this controller can't upgrade forges");
      const b = await body<{ image?: unknown }>(req);
      if (typeof b?.image !== "string") throw new ApiError(400, "expected {image}");
      await o.service.upgradeForge(p[1]!, b.image.trim());
      return json({ ok: true, world: p[1], image: b.image.trim() });
    }

    // ---- backups ----
    if (is("GET", "backups")) return json({ ...listBackups(), disk: diskUse() });
    if (is("POST", "backups")) {
      writable();
      if (!o.service?.backupNow) throw new ApiError(501, "this controller can't back up");
      const b = await body<{ db?: unknown; worlds?: unknown }>(req);
      const worlds = Array.isArray(b?.worlds) ? b.worlds.map(String) : [];
      for (const w of worlds) if (!getWorld(db, w)) throw new ApiError(404, `world not found: ${w}`);
      return json(await o.service.backupNow({ db: b?.db !== false, worlds }));
    }

    // ---- config ----
    if (is("GET", "presets")) return json(listPresets(db));
    if (is("GET", "agents")) return json(listAgentProfiles(db));
    for (const [kind, get, save, del] of [
      ["presets", getPreset, savePreset, deletePreset],
      ["agents", getAgentProfile, saveAgentProfile, deleteAgentProfile],
    ] as const) {
      if (is("GET", kind, null)) {
        const row = get(db, p[1]!);
        return row ? json(row) : json({ error: "not found" }, 404);
      }
      if (is("PUT", kind, null)) {
        writable();
        const b = await body<{ yaml?: unknown }>(req);
        if (typeof b?.yaml !== "string") throw new ApiError(400, "expected {yaml}");
        return json(save(db, p[1]!, b.yaml));
      }
      if (is("DELETE", kind, null)) {
        writable();
        del(db, p[1]!);
        return json({ ok: true });
      }
    }
    if (is("GET", "seeds")) return json(listSeeds(db, url.searchParams.get("name") ?? undefined).map(seedMeta));
    if (is("GET", "seeds", null)) {
      const s = listSeeds(db).find((x) => x.id === Number(p[1]));
      return s ? json(s) : json({ error: "not found" }, 404);
    }
    if (is("POST", "seeds")) {
      writable();
      const b = await body<{ name?: unknown; text?: unknown; note?: unknown }>(req);
      if (typeof b?.text !== "string" || (b.name !== undefined && typeof b.name !== "string")) throw new ApiError(400, "expected {name?, text, note?}");
      return json(seedMeta(saveSeed(db, b.name ?? DEFAULT_SEED, b.text, typeof b.note === "string" ? b.note : null)));
    }
    if (is("POST", "seeds", null, "activate")) {
      writable();
      return json(seedMeta(activateSeed(db, Number(p[1]))));
    }
    if (is("DELETE", "seeds", null)) {
      writable();
      deleteSeed(db, p[1]!);
      return json({ ok: true });
    }
    if (is("GET", "config")) return json(configBundle(db));
    if (is("POST", "config")) {
      writable();
      return json({ imported: importBundle(db, await body<ConfigBundle>(req), "import (api)") });
    }
    throw new ApiError(404, `no route ${m} ${url.pathname}`);
  }

  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) return null;
    try {
      const auth = req.headers.get("authorization");
      if (auth !== null && (!o.token || !sameSecret(auth, `Bearer ${o.token}`))) return json({ error: "unauthorized" }, 401);
      if (req.method !== "GET" && req.method !== "HEAD") {
        if (!req.headers.get(CSRF_HEADER)) return json({ error: `mutating requests need the ${CSRF_HEADER} header` }, 403);
        if (req.headers.get("sec-fetch-site") === "cross-site") return json({ error: "cross-site request refused" }, 403);
      }
      const p = url.pathname.slice(API_PREFIX.length).split("/").filter(Boolean).map(decodeURIComponent);
      return await route(req, url, p);
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.message }, e.status);
      if (e instanceof ConfigError) return json({ error: e.message }, 400);
      return json({ error: String((e as Error)?.message ?? e).slice(0, 500) }, 500);
    }
  };
}
