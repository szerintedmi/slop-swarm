// The controller service (docs/plans/2026-10-12-hosted-control-plane.md §5): runs permanently, serves the dashboard
// and the HTTP API, runs one active run at a time, and with no run active idles and polls for launches (`controls`
// rows with run_id NULL and action `launch`). A restart (crash or deploy) resumes the active run and follows its
// running wakes again through the runner. The controller stays the only DB writer; the API runs in this process.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { swarmFromSnapshot, type SwarmConfig } from "./config.ts";
import { Controller } from "./controller/index.ts";
import { activeRunIn } from "./controller/run.ts";
import { backupDb, backupForge, DEFAULT_KEEP, lastForgeBackup, newestMtime } from "./backup.ts";
import { dataDir, getRun, getWorld, serviceFile, worldDirs, type ControlRow, type RunRow, worldOf } from "./db/index.ts";
import { startDashboard } from "./dashboard/server.ts";
import { ensureNetworks, forgeAdminFromEnv, forgeDataDir, publicForgeUrl, startForge, stopForge, type ForgeClient } from "./forge.ts";
import type { HostConfig } from "./hostconfig.ts";
import { agentImageRef, bringDownWorld, bringUpWorld, LaunchError, missingSecrets, prepareRun, resolveSwarm, type AgentHostHandle } from "./launch.ts";
import type { Logger } from "./log.ts";
import { listPublished, pagesOrigin, servePages, type PublishedRepo } from "./pages.ts";
import { servePublicForge } from "./public-forge.ts";

const LAUNCH_POLL_MS = 2_000;

export interface LaunchRequest {
  /** A preset name, or a swarm file path (local development). */
  preset: string;
  /** Continue this world; default: a new one. */
  world?: string;
  brief?: string;
}

export interface ServiceOptions {
  db: Database;
  agentHost: AgentHostHandle;
  hostCfg: HostConfig;
  log: Logger;
  /** Dashboard + API port, and the addresses it binds (localhost, and the tailnet address on the VPS). */
  port: number;
  bind: string[];
  /** First forge host port; each world gets the next free one (stable per world, `worlds.forge_port`). */
  forgeBasePort: number;
  /** Extra addresses the forge forwarders publish on (the VPS tailnet address, for remote agent hosts). */
  forgePublish: string[];
  /** Keep every world's forge up (the VPS: browsable and public); default: only the active run's. */
  allForges: boolean;
  /** Bearer token the API accepts (SLOPSWARM_API_TOKEN). */
  apiToken?: string;
  /** Pick a free port (local); the VPS has fixed ports. */
  freePort?: (preferred: number, what: string) => number;
  /** Starts a world's forge (tests inject a fake). */
  startForge?: typeof startForge;
  /** Backups (the VPS): the DB nightly, a world's forge after its run and nightly when changed (src/backup.ts). */
  backups?: { keep: number; hourUtc: number };
  /** Create the forge networks if missing (the VPS: no proxy compose there). */
  ensureNetworks?: boolean;
  /** The public read-only forge proxy Caddy forwards to (§7): PUBLIC_FORGE_DOMAIN and a localhost port. */
  publicForge?: { domain: string; port: number };
  /** Pages (src/pages.ts) on localhost: `<world>.localhost:<port>`; the public ones go through the public forge proxy. */
  pagesPort?: number;
}

interface Active {
  run: RunRow;
  cfg: SwarmConfig;
  controller: Controller;
  done: Promise<void>;
}

export class ControllerService {
  private active: Active | null = null;
  private readonly forges = new Map<string, { client: ForgeClient; url: string; port: number }>();
  private dash: { stop(): void; url: string }[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private launching = false;
  private stopped = false;
  readonly urls: string[] = [];

  constructor(readonly o: ServiceOptions) {}

  /** Serve the dashboard and API, resume an active run, then poll for launches. */
  async start(): Promise<void> {
    for (const hostname of this.o.bind) {
      const d = await startDashboard({
        db: this.o.db,
        port: this.o.port,
        hostname,
        host: this.o.agentHost.host,
        forgeFor: (world) => this.forges.get(world)?.url ?? null,
        pagesFor: (world) => (this.forges.has(world) ? (this.pagesUrl(world) ?? null) : null),
        pagesOf: (world) => this.pages(world),
        allowedHosts: [...this.o.bind, ...(process.env.SLOPSWARM_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean)],
        api: { token: this.o.apiToken, service: this },
      });
      this.dash.push(d);
      this.urls.push(d.url);
    }
    if (this.o.ensureNetworks) await ensureNetworks(process.env.FORGE_NETWORK?.trim() || this.o.hostCfg.network.name);
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(serviceFile(), JSON.stringify({ pid: process.pid, url: this.urls[0], started_at: Date.now() }) + "\n");
    if (this.o.allForges) await this.allForgesUp();
    const running = this.o.db.query<RunRow, []>("SELECT * FROM runs WHERE status IN ('running', 'stopping') ORDER BY started_at DESC").all();
    for (const r of running.slice(1)) {
      this.o.log.warn(`run ${r.id} was also marked running; only one run at a time: marking it stopped`);
      this.o.db.query("UPDATE runs SET status = 'stopped', stop_reason = 'another run was active', ended_at = ? WHERE id = ?").run(Date.now(), r.id);
    }
    if (running[0]) await this.resume(running[0]).catch((e) => this.o.log.error(`resuming ${running[0]!.id}: ${(e as Error).message}`));
    this.timer = setInterval(() => void this.pollLaunches(), LAUNCH_POLL_MS);
    void this.pollLaunches();
    if (this.o.backups) this.nightly = setInterval(() => void this.nightlyBackup(), 10 * 60_000);
    if (this.o.pagesPort) {
      this.pagesServer = servePages({ db: this.o.db, port: this.o.pagesPort, forgePort: (w) => this.forges.get(w)?.port ?? null, origin: (w) => this.pagesUrl(w)! });
      this.o.log.info(`pages on http://<world>.localhost:${this.pagesServer.port}/`);
    }
    if (this.o.publicForge) {
      this.publicProxy = servePublicForge({ db: this.o.db, domain: this.o.publicForge.domain, port: this.o.publicForge.port, forgePort: (w) => this.forges.get(w)?.port ?? null });
      this.o.log.info(`public forge proxy on 127.0.0.1:${this.publicProxy.port} (for Caddy)`);
    }
  }

  private publicProxy?: { stop(): void; port: number };
  private pagesServer?: { stop(): void; port: number };

  /** The world's pages origin: the public one with a public forge, else the local one (undefined: none served). */
  pagesUrl(world: string): string | undefined {
    return pagesOrigin(world, { publicDomain: this.o.publicForge?.domain, localPort: this.pagesServer?.port });
  }

  /** The world's published repos (its forge must be up). */
  async pages(world: string, owner?: string): Promise<{ url: string | null; repos: PublishedRepo[] }> {
    const url = this.pagesUrl(world) ?? null;
    const f = this.forges.get(world);
    if (!url || !f) return { url, repos: [] };
    // The dashboard polls its pages: one listing per world and owner every 15 s at most (a request per repo).
    const key = `${world}\n${owner ?? ""}`;
    const hit = this.pagesCache.get(key);
    if (hit && Date.now() - hit.at < 15_000) return { url, repos: await hit.repos };
    const repos = listPublished(`http://127.0.0.1:${f.port}`, url, { owner });
    this.pagesCache.set(key, { at: Date.now(), repos });
    repos.catch(() => this.pagesCache.delete(key));
    return { url, repos: await repos };
  }
  private readonly pagesCache = new Map<string, { at: number; repos: Promise<PublishedRepo[]> }>();

  private nightly?: ReturnType<typeof setInterval>;
  private lastNightly = 0;
  private backingUp: Promise<unknown> | null = null;

  /** Once a day at the configured UTC hour: the DB, and the forges of stopped worlds that changed since their last copy. */
  private async nightlyBackup(now = Date.now()): Promise<void> {
    const b = this.o.backups;
    if (!b || new Date(now).getUTCHours() !== b.hourUtc || now - this.lastNightly < 20 * 3600_000) return;
    this.lastNightly = now;
    const worlds = this.o.db.query<{ id: string }, []>("SELECT id FROM worlds WHERE status = 'idle'").all().map((w) => w.id);
    const changed = worlds.filter((w) => newestMtime(worldDirs(w).forge) > lastForgeBackup(w));
    await this.backupNow({ db: true, worlds: changed }).catch((e) => this.o.log.error(`nightly backup: ${(e as Error).message}`));
  }

  /**
   * Back up now: the DB, and the given worlds' forges (not a world with an active run: its forge is in use). A forge
   * this service runs is stopped for the copy and started again.
   */
  backupNow(o: { db?: boolean; worlds?: string[] } = {}): Promise<{ db: string | null; forges: Record<string, string | null> }> {
    const keep = this.o.backups?.keep ?? DEFAULT_KEEP;
    const run = async () => {
      const db = o.db === false ? null : backupDb(this.o.db, { keep });
      const forges: Record<string, string | null> = {};
      for (const w of o.worlds ?? []) {
        if (this.active && worldOf(this.active.run) === w) throw new LaunchError(`world ${w} has an active run: its forge is backed up when the run ends`);
        const running = this.forges.has(w);
        if (running) await this.forgeDown(w);
        try {
          forges[w] = backupForge(w, { keep });
        } finally {
          if (running) await this.forgeUp(w).catch((e) => this.o.log.error(`forge of ${w} did not come back after its backup: ${(e as Error).message}`, { world: w }));
        }
      }
      this.o.log.info(`backup: ${db ? "db" : ""}${Object.keys(forges).length ? ` forges ${Object.keys(forges).join(", ")}` : ""}`);
      return { db, forges };
    };
    // One at a time.
    const p = (this.backingUp ?? Promise.resolve()).catch(() => {}).then(run);
    this.backingUp = p.finally(() => {
      if (this.backingUp === p) this.backingUp = null;
    });
    return p;
  }

  /** A new Forgejo image for a world (security releases): recorded, and its forge restarted on it, which migrates it. */
  async upgradeForge(world: string, image: string): Promise<void> {
    if (!getWorld(this.o.db, world)) throw new LaunchError(`world not found: ${world}`);
    if (this.active && worldOf(this.active.run) === world) throw new LaunchError(`world ${world} has an active run; upgrade it between runs`);
    if (!/^[\w./:@-]+$/.test(image)) throw new LaunchError(`not an image reference: ${image}`);
    const running = this.forges.has(world);
    if (running) await this.forgeDown(world);
    this.o.db.query("UPDATE worlds SET forge_image = ? WHERE id = ?").run(image, world);
    if (running || this.o.allForges) await this.forgeUp(world);
    this.o.log.info(`forge of ${world} now on ${image}`, { world });
  }

  /** Status for the API: the active run, if any. */
  activeRun(): RunRow | null {
    return this.active ? getRun(this.o.db, this.active.run.id) : null;
  }

  forgeUrl(world: string): string | null {
    return this.forges.get(world)?.url ?? null;
  }

  /** Every world's forge up (the VPS): browsable on the tailnet, public through Caddy (§7). */
  private async allForgesUp(): Promise<void> {
    const worlds = this.o.db.query<{ id: string }, []>("SELECT id FROM worlds WHERE status != 'archived' ORDER BY created_at").all();
    for (const w of worlds) {
      if (!existsSync(forgeDataDir(w.id))) continue;
      await this.forgeUp(w.id).catch((e) => this.o.log.warn(`forge of ${w.id} did not start: ${(e as Error).message}`, { world: w.id }));
    }
  }

  /** The world's forge port: stored, else the first free one from the base (and stored). */
  private forgePortFor(world: string): number {
    const row = getWorld(this.o.db, world);
    if (row?.forge_port) return row.forge_port;
    const taken = new Set(this.o.db.query<{ p: number }, []>("SELECT forge_port AS p FROM worlds WHERE forge_port IS NOT NULL").all().map((r) => r.p));
    let port = this.o.forgeBasePort;
    while (taken.has(port)) port++;
    if (this.o.freePort) port = this.o.freePort(port, "forge");
    this.o.db.query("UPDATE worlds SET forge_port = ? WHERE id = ?").run(port, world);
    return port;
  }

  /** Start (or reuse) a world's forge. */
  async forgeUp(world: string): Promise<{ client: ForgeClient; url: string; port: number }> {
    const have = this.forges.get(world);
    if (have) return have;
    const admin = forgeAdminFromEnv();
    if (!admin) throw new LaunchError("FORGE_ADMIN_PASSWORD is not set");
    const w = getWorld(this.o.db, world);
    if (!w) throw new LaunchError(`world not found: ${world}`);
    let port = this.forgePortFor(world);
    let client: ForgeClient;
    try {
      client = await (this.o.startForge ?? startForge)({ world, image: w.forge_image, network: process.env.FORGE_NETWORK?.trim() || this.o.hostCfg.network.name, hostPort: port, admin, publish: this.o.forgePublish, publicUrl: publicForgeUrl(world) });
    } catch (e) {
      // Locally, another worktree may have taken the stored port: pick a new one once.
      if (!this.o.freePort || !/in use/.test((e as Error).message)) throw e;
      this.o.db.query("UPDATE worlds SET forge_port = NULL WHERE id = ?").run(world);
      port = this.forgePortFor(world);
      client = await (this.o.startForge ?? startForge)({ world, image: w.forge_image, network: process.env.FORGE_NETWORK?.trim() || this.o.hostCfg.network.name, hostPort: port, admin, publish: this.o.forgePublish, publicUrl: publicForgeUrl(world) });
    }
    const f = { client, url: client.baseUrl, port };
    this.forges.set(world, f);
    this.o.log.info(`forge of ${world}: ${client.baseUrl}`, { world });
    return f;
  }

  async forgeDown(world: string): Promise<void> {
    this.forges.delete(world);
    if (!this.o.startForge) await stopForge(world);
  }

  /** Queue a launch (the API's and CLI's way in). */
  enqueueLaunch(r: LaunchRequest, source: string): number {
    const q = this.o.db.query("INSERT INTO controls (run_id, agent, action, created_at, source, detail) VALUES (NULL, NULL, 'launch', ?, ?, ?)").run(Date.now(), source, JSON.stringify(r));
    void this.pollLaunches();
    return Number(q.lastInsertRowid);
  }

  private async pollLaunches(): Promise<void> {
    if (this.launching || this.stopped) return;
    const c = this.o.db.query<ControlRow, []>("SELECT * FROM controls WHERE run_id IS NULL AND action = 'launch' AND consumed_at IS NULL ORDER BY id LIMIT 1").get();
    if (!c) return;
    this.launching = true;
    const done = (result: { run: string } | { error: string }) =>
      this.o.db.query("UPDATE controls SET consumed_at = ?, result = ? WHERE id = ?").run(Date.now(), JSON.stringify(result), c.id);
    try {
      if (this.active) return void done({ error: `a run is active (${this.active.run.id}); one run at a time` });
      let req: LaunchRequest;
      try {
        req = JSON.parse(c.detail ?? "{}") as LaunchRequest;
        if (!req.preset || typeof req.preset !== "string") throw new Error("preset missing");
      } catch (e) {
        return void done({ error: `bad launch: ${(e as Error).message}` });
      }
      try {
        const runId = await this.launch(req);
        done({ run: runId });
      } catch (e) {
        this.o.log.error(`launch failed: ${(e as Error).message}`);
        done({ error: (e as Error).message });
      }
    } finally {
      this.launching = false;
    }
  }

  /**
   * Launches and resumes run one at a time: `active` is set only once the world is up, so two concurrent requests
   * would both pass the one-run check and start two controllers.
   */
  private starting: Promise<unknown> = Promise.resolve();
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.starting.catch(() => {}).then(fn);
    this.starting = p;
    return p;
  }

  /** Create the run and start driving it. Returns once it is running. */
  launch(req: LaunchRequest): Promise<string> {
    return this.serialized(async () => {
      const { db } = this.o;
      if (this.active) throw new LaunchError(`a run is active (${this.active.run.id}); one run at a time`);
      const { cfg, seedText, source } = resolveSwarm(db, req.preset);
      const missing = missingSecrets(cfg);
      if (missing.length) throw new LaunchError(missing.join("; "));
      if (req.world) {
        if (!getWorld(db, req.world)) throw new LaunchError(`world not found: ${req.world}`);
        const a = activeRunIn(db, req.world);
        if (a) throw new LaunchError(`world ${req.world} has an active run (${a.id})`);
      }
      const runId = await prepareRun({ db, cfg, hostCfg: this.o.hostCfg, host: this.o.agentHost.host, world: req.world, brief: req.brief, seedText, log: this.o.log });
      this.o.log.info(`run ${runId} launched from ${source}${req.world ? ` in world ${req.world}` : " in a new world"}`, { run: runId });
      await this.drive(getRun(db, runId)!, cfg);
      return runId;
    });
  }

  /** Continue a stopped or finished run (after `extend`), or pick up one marked running. One run at a time. */
  resumeRun(id: string): Promise<void> {
    return this.serialized(async () => {
      const run = getRun(this.o.db, id);
      if (!run) throw new LaunchError(`run not found: ${id}`);
      if (this.active) {
        if (this.active.run.id === id) return;
        throw new LaunchError(`a run is active (${this.active.run.id}); one run at a time`);
      }
      const other = activeRunIn(this.o.db, worldOf(run));
      if (other && other.id !== id) throw new LaunchError(`world ${worldOf(run)} has an active run (${other.id})`);
      await this.resume(run);
    });
  }

  private async resume(run: RunRow): Promise<void> {
    this.o.log.info(`resuming run ${run.id} (world ${worldOf(run)})`, { run: run.id });
    await this.drive(run, swarmFromSnapshot(run.config_yaml));
  }

  /** Bring the run's world up and run its controller loop in the background. */
  private async drive(run: RunRow, cfg: SwarmConfig): Promise<void> {
    const world = worldOf(run);
    // A backup of this world's forge may be copying it right now.
    await this.backingUp?.catch(() => {});
    let forge: Awaited<ReturnType<ControllerService["forgeUp"]>>;
    let controller: Controller;
    try {
      forge = await this.forgeUp(world);
      const target = this.o.forgePublish[0] ? `${this.o.forgePublish[0]}:${forge.port}` : process.env.SLOPSWARM_FORGE_TARGET?.trim() || undefined;
      await bringUpWorld({ db: this.o.db, run, cfg, hostCfg: this.o.hostCfg, host: this.o.agentHost.host, forge: forge.client, forgeTarget: target, log: this.o.log });
      controller = this.makeController(run, cfg, forge.client, world);
    } catch (e) {
      // Nothing drives the run: it must not stay "running" (and its world "active").
      this.o.db.query("UPDATE runs SET status = 'stopped', stop_reason = COALESCE(stop_reason, ?), ended_at = COALESCE(ended_at, ?) WHERE id = ? AND status IN ('running', 'stopping')").run(`did not start: ${String((e as Error)?.message ?? e).slice(0, 200)}`, Date.now(), run.id);
      this.o.db.query("UPDATE worlds SET status = 'idle' WHERE id = ? AND status = 'active'").run(world);
      throw e;
    }
    this.follow(run, cfg, controller);
  }

  private makeController(run: RunRow, cfg: SwarmConfig, forge: ForgeClient, world: string): Controller {
    return new Controller(this.o.db, run.id, cfg, {
      forge,
      host: this.o.agentHost.host,
      image: agentImageRef(),
      logger: this.o.log,
      homeWarnBytes: this.o.hostCfg.runner.homeWarnBytes,
      wakeDeps: { hardTimeoutSlackMs: this.o.hostCfg.runner.hardTimeoutSlackMs, forgePublicUrl: publicForgeUrl(world), pagesUrl: this.pagesUrl(world) },
    });
  }

  /** Run the controller loop in the background; when the run ends its world goes down on the agent host. */
  private follow(run: RunRow, cfg: SwarmConfig, controller: Controller): void {
    const world = worldOf(run);
    const done = (async () => {
      try {
        await controller.loop();
      } catch (e) {
        this.o.log.error(`run ${run.id}: controller loop failed: ${(e as Error)?.stack ?? e}`);
      }
      this.active = null;
      // Detached (shutdown): the run goes on under the next controller; its world stays up.
      const status = getRun(this.o.db, run.id)?.status;
      if (status === "running" || status === "stopping") return;
      await bringDownWorld({ run, host: this.o.agentHost.host, forge: false });
      this.o.log.info(`run ${run.id} ended; report: just report ${run.id}`, { run: run.id });
      // The forge is idle now: back it up as plain files (§6.6).
      if (this.o.backups && !this.stopped) await this.backupNow({ db: false, worlds: [world] }).catch((e) => this.o.log.error(`backup of ${world}: ${(e as Error).message}`));
    })();
    this.active = { run, cfg, controller, done };
  }

  /** The active run's controller (controls are applied by it from the `controls` queue). */
  controller(): Controller | null {
    return this.active?.controller ?? null;
  }

  /** Wait for the active run to end (`just up` in the foreground). */
  async whenRunEnds(): Promise<void> {
    while (this.active) await this.active.done;
  }

  /** Ctrl-C in a terminal: a graceful stop of the active run, then an emergency kill on the second. */
  interrupt(count: number): void {
    const c = this.active?.controller;
    if (!c) return;
    if (count === 1) c.requestStop("interrupted");
    else void c.emergencyKill("interrupted twice");
  }

  /** Stop serving. The active run is left running (a deploy): the next service resumes it and follows its wakes. */
  async close(o: { stopForges?: boolean } = {}): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.nightly);
    this.publicProxy?.stop();
    this.pagesServer?.stop();
    const active = this.active;
    if (active) {
      active.controller.detach();
      await active.done;
    }
    for (const d of this.dash) d.stop();
    if (o.stopForges) for (const w of [...this.forges.keys()]) await this.forgeDown(w);
    rmSync(serviceFile(), { force: true });
    this.o.agentHost.stop();
  }
}
