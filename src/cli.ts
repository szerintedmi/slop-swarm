#!/usr/bin/env bun
// Entry point for every `just` recipe (plan §9). Commands that change something go through the controller's HTTP API
// (docs/plans/2026-10-12-hosted-control-plane.md §5.3): SLOPSWARM_API picks the controller, else the local service.
// Read-only commands read the local DB when there is one (they work offline), else the API. `--json` everywhere.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { runStatus } from "./api.ts";
import { api, apiBase, ApiClientError } from "./api-client.ts";
import { loadSwarm, swarmFromSnapshot } from "./config.ts";
import { activeSeed, bundleFromDir, ensureConfigDefaults, exportConfig, importBundle, listAgentProfiles, listPresets, listSeeds, writeBundle, type ConfigBundle } from "./config-db.ts";
import { listWorlds, migrateWorldDirs, type WorldSummary } from "./controller/worlds.ts";
import { CODEX_AUTH_PATH, SECRETS_DIR } from "./controller/index.ts";
import { startDashboard } from "./dashboard/server.ts";
import { buildDashboard } from "./dashboard/build.ts";
import { DATA_DIR, DB_PATH, enqueueControl, getRun, latestRun, openDb, worldOf, type AgentRow, type ControlAction, type ControlRow, type RunRow, type WakeRow } from "./db/index.ts";
import { dockerKillLabelled } from "./docker.ts";
import { forgeAdminFromEnv, forgeDataDir, forgePort, FORWARDER_IMAGE, startForge, stopForge } from "./forge.ts";
import { type AgentHost } from "./host/agent-host.ts";
import { loadHostConfig } from "./hostconfig.ts";
import { connectAgentHost } from "./launch.ts";
import { createLogger, formatLogLine, readLogFile, readLogs, type LogLine } from "./log.ts";
import { buildImages, ensureProxy } from "./proxy.ts";
import { runPreflight } from "./preflight.ts";
import { runnerDataDir } from "./runner/main.ts";
import { ensureSearchImage } from "./search.ts";
import { renderReport } from "./report.ts";
import { lockHeld, takeControllerLock, type ControllerLock } from "./lock.ts";
import { ControllerService, type LaunchRequest } from "./service.ts";
import { getAdapter } from "./harnesses/index.ts";
import { describeExtension, parseDuration, parseExtendArgs, type ExtendDetail } from "./world.ts";

const ROOT = join(import.meta.dir, "..");
const LOG_TOOL_LINES = 20;
const LOG_FILES = () => [join(DATA_DIR, "logs", "controller.jsonl"), join(DATA_DIR, "logs", "runner.jsonl"), join(runnerDataDir(), "logs", "runner.jsonl")];

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/** `--json` anywhere in the args. */
const wantsJson = (args: string[]) => args.includes("--json");
const withoutFlags = (args: string[]) => args.filter((a) => !a.startsWith("--"));
const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

function requireRun(id?: string): RunRow {
  const db = openDb();
  const run = getRun(db, id || undefined);
  if (!run) die(id ? `run not found: ${id}` : "no runs yet; start one with `just up`");
  return run;
}

function rel(t: number | null, now = Date.now()): string {
  if (t === null) return "-";
  const d = Math.round((t - now) / 1000);
  const abs = Math.abs(d);
  const s = abs < 90 ? `${abs}s` : abs < 5400 ? `${Math.round(abs / 60)}m` : `${(abs / 3600).toFixed(1)}h`;
  return d >= 0 ? `in ${s}` : `${s} ago`;
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}

/** The controller lock of this data dir (src/lock.ts): held by the kernel while a controller process lives. */
let lock: ControllerLock | null = null;
async function takeLock(): Promise<void> {
  try {
    lock = takeControllerLock(DATA_DIR);
  } catch (e) {
    die((e as Error).message);
  }
  process.on("exit", releaseLock);
}
function releaseLock(): void {
  lock?.release();
  lock = null;
}
/** Whether a controller holds this data dir's lock (busy or starting ones included). */
const controllerRunning = () => lockHeld(DATA_DIR);

function hostConfig() {
  try {
    return loadHostConfig();
  } catch (e) {
    die((e as Error).message);
  }
}

/** Dashboard port: PORT env overrides the default 7777. */
function dashPort(fallback: number): number {
  const p = Number(process.env.PORT ?? fallback);
  if (!Number.isInteger(p) || p < 0 || p > 65535) die(`invalid PORT ${process.env.PORT}`);
  return p;
}

/**
 * The first free port from `preferred` on (another run's dashboard or forge may hold it). Both probes are needed:
 * Docker publishes the forge on 127.0.0.1, which a bind on all interfaces doesn't notice.
 */
function freePort(preferred: number, what: string): number {
  const free = (port: number) =>
    ["127.0.0.1", "0.0.0.0"].every((hostname) => {
      try {
        Bun.serve({ port, hostname, fetch: () => new Response() }).stop(true);
        return true;
      } catch {
        return false;
      }
    });
  for (let p = preferred; p < preferred + 20 && p <= 65535; p++) {
    if (!free(p)) continue;
    if (p !== preferred) console.log(`${what}: port ${preferred} is in use, using ${p}`);
    return p;
  }
  die(`${what}: no free port in ${preferred}–${preferred + 19}`);
}

// ---------- the API, or the local DB ----------

/** The controller's API if one is reachable (SLOPSWARM_API, or a local service), else null. */
function controllerApi(): string | null {
  return apiBase()?.url ?? null;
}

/** Read-only commands: the API only when SLOPSWARM_API is set; else the local DB. */
function remoteApi(): string | null {
  const b = apiBase();
  return b?.explicit ? b.url : null;
}

async function call<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await api<T>(base, method, path, body);
  } catch (e) {
    if (e instanceof ApiClientError) die(e.message);
    throw e;
  }
}

/** No controller to talk to: change the local DB directly (the controller applies it when it runs this run). */
function noController(what: string): void {
  if (process.env.SLOPSWARM_API?.trim()) die(`controller unreachable at ${process.env.SLOPSWARM_API}`);
  console.log(`(no controller service running: ${what} is queued in the local DB; \`just resume\` applies it)`);
}

// ---------- the service ----------

/** Runs from before worlds: move their forge and agent dirs (once). */
async function migrateDirsOrDie(): Promise<void> {
  const db = openDb();
  try {
    for (const line of await migrateWorldDirs(db)) console.log(line);
  } catch (e) {
    die(`moving runs into worlds: ${(e as Error).message}`);
  } finally {
    db.close();
  }
}

/** Copy a remote runner's structured log into data/logs/runner.jsonl every few seconds (`just logs` reads it offline). */
function pumpRunnerLogs(host: AgentHost): { stop(): void } {
  const file = join(DATA_DIR, "logs", "runner.jsonl");
  const last = readLogFile(file).at(-1);
  let since = last ? Date.parse(last.timestamp) + 1 : 0;
  const t = setInterval(async () => {
    try {
      const lines = await host.logs(since);
      if (!lines.length) return;
      mkdirSync(join(DATA_DIR, "logs"), { recursive: true });
      appendFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      since = Date.parse(lines.at(-1)!.timestamp) + 1;
    } catch {
      /* the agent host may be off */
    }
  }, 5_000);
  return { stop: () => clearInterval(t) };
}

async function waitLaunch(db: ReturnType<typeof openDb>, id: number): Promise<{ run?: string; error?: string }> {
  for (;;) {
    const c = db.query<ControlRow, [number]>("SELECT * FROM controls WHERE id = ?").get(id);
    if (c?.result) return JSON.parse(c.result) as { run?: string; error?: string };
    await Bun.sleep(300);
  }
}

/**
 * The controller service in the foreground (`just serve`, and `just up`/`resume` without a running one). Ctrl-C:
 * a graceful stop of the active run, again: an emergency kill; with no run active it quits. SIGTERM (a deploy) quits
 * without stopping the run: the next service resumes it and follows its wakes.
 */
async function runService(o: { launch?: LaunchRequest; resume?: string } = {}): Promise<void> {
  await migrateDirsOrDie();
  await buildDashboard(); // fail before starting or stopping Docker containers
  await takeLock();
  const hostCfg = hostConfig();
  const env = process.env;
  const bind = (env.SLOPSWARM_BIND?.trim() || "127.0.0.1").split(",").map((s) => s.trim()).filter(Boolean);
  const allForges = env.SLOPSWARM_ALL_FORGES === "1";
  const port = bind.length === 1 && bind[0] === "127.0.0.1" ? freePort(dashPort(7777), "dashboard") : dashPort(7777);
  let forgeBase: number;
  try {
    forgeBase = forgePort(3300);
  } catch (e) {
    die((e as Error).message);
  }
  const agentHost = await connectAgentHost().catch((e) => die((e as Error).message));
  const log = createLogger("controller", { file: join(DATA_DIR, "logs", "controller.jsonl") });
  log.info(`agent host: ${agentHost.local ? "runner in this process" : "runner"} at ${agentHost.url}`);
  const db = openDb();
  const service = new ControllerService({
    db,
    agentHost,
    hostCfg,
    log,
    port,
    bind,
    forgeBasePort: forgeBase,
    forgePublish: (env.SLOPSWARM_FORGE_PUBLISH ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    allForges,
    apiToken: env.SLOPSWARM_API_TOKEN?.trim() || undefined,
    freePort: allForges ? undefined : (p, what) => freePort(p, what),
    ensureNetworks: env.SLOPSWARM_ENSURE_NETWORKS === "1",
    publicForge: env.PUBLIC_FORGE_DOMAIN?.trim() ? { domain: env.PUBLIC_FORGE_DOMAIN.trim(), port: Number(env.SLOPSWARM_PUBLIC_PORT ?? 7780) || 7780 } : undefined,
    backups: env.SLOPSWARM_BACKUPS === "1" ? { keep: Number(env.SLOPSWARM_BACKUP_KEEP ?? 7) || 7, hourUtc: Number(env.SLOPSWARM_BACKUP_HOUR_UTC ?? 3) || 0 } : undefined,
  });
  await service.start();
  console.log(`dashboard and API: ${service.urls.join(", ")}`);
  const pump = agentHost.local ? null : pumpRunnerLogs(agentHost.host);

  let quit!: () => void;
  const quitting = new Promise<void>((r) => (quit = r));
  let interrupts = 0;
  process.on("SIGINT", () => {
    if (!service.controller()) return quit();
    interrupts++;
    if (interrupts === 1) console.log("\nCtrl-C: graceful stop (no new wakes; running wakes finish). Ctrl-C again to kill containers.");
    service.interrupt(interrupts);
  });
  process.on("SIGTERM", () => quit());

  if (o.launch) {
    const r = await waitLaunch(db, service.enqueueLaunch(o.launch, "cli"));
    if (r.error) {
      await service.close({ stopForges: !allForges });
      die(r.error);
    }
    console.log(`run ${r.run} launched${o.launch.world ? ` in world ${o.launch.world}` : " in a new world"}`);
  }
  if (o.resume) {
    try {
      await service.resumeRun(o.resume);
    } catch (e) {
      await service.close({ stopForges: !allForges });
      die((e as Error).message);
    }
  }
  if (o.launch || o.resume) {
    // Locally the service stays up after the run for browsing (dashboard, forge).
    void Promise.race([service.whenRunEnds(), quitting]).then(() => {
      if (!service.controller()) console.log(`run over; dashboard (${service.urls[0]}) and forge stay up for browsing; Ctrl-C to quit`);
    });
  } else console.log("idle: waiting for launches (`just up PRESET`, the dashboard, or POST /api/v1/launches)");
  await quitting;
  pump?.stop();
  await service.close({ stopForges: !allForges });
  releaseLock();
  console.log("\ncontroller stopped");
  process.exit(0);
}

/** `[preset|file.yaml] [--world W] [--brief "…"]` of `just up`. */
function parseUpArgs(args: string[]): LaunchRequest & { follow: boolean } {
  let preset = "swarm";
  let world: string | undefined;
  let brief: string | undefined;
  let follow = true;
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    const [flag, inline] = a.startsWith("--") && eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined];
    if (flag === "--world") world = inline ?? args[++i];
    else if (flag === "--brief") brief = inline ?? args[++i];
    else if (flag === "--detach" || flag === "--json") follow = false;
    else if (a.startsWith("--")) die(`unknown option ${a}`);
    else pos.push(a);
  }
  if (pos[0]) preset = pos[0];
  if (pos.length > 1) die(`unexpected argument ${pos[1]}`);
  return { preset, world, brief, follow };
}

/** Follow a run through the API: one line whenever its summary changes, until it is over (Ctrl-C stops following only). */
async function follow(base: string, runId: string): Promise<void> {
  let last = "";
  for (;;) {
    const s = await call<ReturnType<typeof runStatus>>(base, "GET", `/status?run=${encodeURIComponent(runId)}`);
    const line = `${s.run.status}${s.run.stop_reason ? ` (${s.run.stop_reason})` : ""}: spend $${s.state.run.spentUsd.toFixed(4)}, ${s.state.agents.map((a) => `${a.name} ${a.status}`).join(", ")}`;
    if (line !== last) console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
    last = line;
    if (!s.live) return;
    await Bun.sleep(5_000);
  }
}

// ---------- printing ----------

function printStatus(s: ReturnType<typeof runStatus>, controllerUp: boolean, now = Date.now()): void {
  const { run, state } = s;
  const ends = s.live ? `ends ${rel(run.deadline_at, now)}` : `ended ${rel(run.ended_at, now)}`;
  console.log(
    `${run.id}  [${run.status}${run.stop_reason ? `: ${run.stop_reason}` : ""}]  world ${run.world}, world time ${(s.worldTimeMs / 3_600_000).toFixed(2)}h, ${ends}, spend $${state.run.spentUsd.toFixed(4)}${s.swarmBudgetUsd !== null ? ` of $${s.swarmBudgetUsd.toFixed(2)}` : ""}`,
  );
  if (!s.live) console.log("no controller: nothing will wake (`just resume` continues this run, `just extend` adds time or budget)");
  else if (!controllerUp) console.log("marked running, but no controller is running (crashed?): `just resume` continues this run");
  for (const q of s.queued) if (q.action === "extend") console.log(`queued extension (applied when a controller runs): ${q.detail}`);
  const rows = [["agent", "harness", "model", "status", "next wake", "wakes", "spent", "budget"]];
  for (const a of state.agents)
    rows.push([a.name, a.harness, a.model, a.status, s.live && a.nextWakeAt ? `${rel(a.nextWakeAt, now)} (${a.nextTrigger})` : "-", String(a.wakeCount), `$${a.spentUsd.toFixed(4)}`, `$${a.budgetUsd.toFixed(2)}`]);
  console.log(table(rows));
}

function printWorlds(worlds: WorldSummary[]): void {
  if (!worlds.length) return console.log("no worlds yet; `just up` starts one");
  const rows = [["world", "name", "status", "runs", "last run", "agents", "forge image"]];
  for (const w of worlds)
    rows.push([
      w.id,
      w.name,
      w.activeRun ? `active (${w.activeRun})` : w.status,
      String(w.runs),
      w.lastRunAt ? rel(w.lastRunAt) : "-",
      w.agents.map((a) => `${a.name}${a.removed_at ? " (left)" : ""}${a.home_generation ? ` g${a.home_generation}` : ""}`).join(", "),
      w.forge_image.replace(/^.*\//, ""),
    ]);
  console.log(table(rows));
}

function printTranscript(raw: string, harness: AgentRow["harness"], model: string, costs: Map<string, number>, full: boolean): void {
  const parser = getAdapter(harness).newParser({ model });
  const seen = new Set<string>();
  const indent = (s: string, pad: string) => s.replace(/\n/g, `\n${pad}`);
  // Tool output can be huge; keep the first lines unless --full.
  const clip = (s: string) => {
    const lines = s.replace(/\s+$/, "").split("\n");
    return full || lines.length <= LOG_TOOL_LINES ? lines.join("\n") : `${lines.slice(0, LOG_TOOL_LINES).join("\n")}\n… ${lines.length - LOG_TOOL_LINES} more lines (--full)`;
  };
  for (const line of raw.split("\n")) {
    for (const e of parser.push(line)) {
      if (e.kind === "message") console.log(`${e.role === "assistant" ? "◆" : "▷"} ${indent(e.text, "  ")}\n`);
      else if (e.kind === "reasoning") console.log(`  💭 ${indent(e.text, "     ")}\n`);
      else if (e.kind === "tool_call") console.log(`  → ${e.name} ${indent(clip(e.args), "    ")}`);
      else if (e.kind === "tool_result") console.log(`  ${e.ok ? "←" : "✗"} ${indent(clip(e.summary), "    ")}`);
      else if (e.kind === "usage" && !seen.has(e.usage.requestId)) {
        seen.add(e.usage.requestId);
        const c = costs.get(e.usage.requestId);
        console.log(`  · request ${e.usage.requestId}${c !== undefined ? ` $${c.toFixed(5)}` : ""}`);
      } else if (e.kind === "turn_end") console.log(`■ ${e.reason}${e.numTurns ? ` after ${e.numTurns} turns` : ""}${e.detail ? `: ${e.detail}` : ""}`);
    }
  }
}

function sinceOf(args: string[]): number {
  const v = args.find((a) => a.startsWith("--since="))?.split("=")[1] ?? (args.includes("--since") ? args[args.indexOf("--since") + 1] : undefined);
  if (!v) return 0;
  try {
    return Date.now() - parseDuration(v);
  } catch (e) {
    die((e as Error).message);
  }
}

// ---------- commands ----------

async function runControl(action: "stop" | "kill", args: string[]): Promise<void> {
  const [id] = withoutFlags(args);
  const base = controllerApi();
  if (base) {
    const runId = id ?? (await call<{ run: { id: string } | null }>(base, "GET", "/status")).run?.id;
    if (!runId) die("no runs yet");
    const r = await call<{ control: number; killed?: string[]; applied?: string }>(base, "POST", `/runs/${encodeURIComponent(runId)}/${action}`, {});
    if (wantsJson(args)) return out(r);
    if (action === "stop") return console.log(`stop requested for ${runId}; running wakes will finish`);
    return console.log(r.killed ? `killed ${r.killed.length} container(s): ${r.killed.join(", ") || "none"}; run marked stopped` : `kill requested for ${runId}: the controller kills its containers now`);
  }
  const run = requireRun(id);
  const db = openDb();
  enqueueControl(db, run.id, action, null, "cli");
  if (action === "stop") return noController("the stop");
  // No controller: kill this world's containers on this machine and mark the run stopped.
  const killed = await dockerKillLabelled({ world: worldOf(run) });
  db.query("UPDATE runs SET status = 'stopped', stop_reason = 'kill (no controller)', ended_at = ? WHERE id = ? AND status != 'finished'").run(Date.now(), run.id);
  db.query("UPDATE worlds SET status = 'idle' WHERE id = ? AND status = 'active'").run(worldOf(run));
  console.log(`killed ${killed.length} container(s): ${killed.join(", ") || "none"}`);
}

async function agentControl(action: ControlAction, args: string[]): Promise<void> {
  const [name] = withoutFlags(args);
  if (!name) die(`usage: just ${action} NAME`);
  const base = controllerApi();
  if (base) {
    const runId = (await call<{ run: { id: string } | null }>(base, "GET", "/status")).run?.id;
    if (!runId) die("no runs yet");
    const r = await call(base, "POST", `/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(name)}/${action}`, {});
    return wantsJson(args) ? out(r) : console.log(`${action} ${name}: queued for the controller`);
  }
  const run = requireRun();
  const db = openDb();
  if (!db.query("SELECT 1 FROM agents WHERE run_id = ? AND name = ?").get(run.id, name)) die(`unknown agent ${name}`);
  enqueueControl(db, run.id, action, name, "cli");
  noController(`${action} ${name}`);
}

const commands: Record<string, (args: string[]) => Promise<void> | void> = {
  async setup() {
    if (!existsSync(join(ROOT, ".env"))) {
      copyFileSync(join(ROOT, ".env.example"), join(ROOT, ".env"));
      console.log("created .env from .env.example; set CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`)");
    }
    const env = readFileSync(join(ROOT, ".env"), "utf8");
    if (!/^FORGE_ADMIN_PASSWORD=\S/m.test(env)) {
      const line = `FORGE_ADMIN_PASSWORD=${crypto.randomUUID()}`;
      if (/^FORGE_ADMIN_PASSWORD=$/m.test(env)) writeFileSync(join(ROOT, ".env"), env.replace(/^FORGE_ADMIN_PASSWORD=$/m, line));
      else appendFileSync(join(ROOT, ".env"), `\n# Your admin login for the runs' forges (plan §4.5).\nFORGE_ADMIN_USER=operator\n${line}\n`);
      console.log("generated FORGE_ADMIN_PASSWORD in .env (your forge admin login)");
    }
    mkdirSync(join(SECRETS_DIR, "codex"), { recursive: true });
    if (!existsSync(CODEX_AUTH_PATH)) console.log(`Codex runs need ${CODEX_AUTH_PATH} (copy ~/.codex/auth.json after \`codex login\`)`);
    const db = openDb();
    for (const l of ensureConfigDefaults(db)) console.log(`config: loaded ${l}`);
    db.close();
    console.log(`database: ${DB_PATH}`);
    await buildImages();
    await ensureSearchImage();
    const swarm = loadSwarm(join(ROOT, "config", "swarm.yaml"));
    for (const image of [swarm.forge.image, FORWARDER_IMAGE]) await Bun.spawn(["docker", "pull", "-q", image], { stdout: "inherit", stderr: "inherit" }).exited;
    await ensureProxy(hostConfig().network.allowlist);
    console.log("setup done");
  },

  async "ui-build"() {
    await buildDashboard(true);
  },

  async "ui-dev"() {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--bun", "vite", "dev", "--host", "127.0.0.1"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    process.on("SIGINT", () => child.kill("SIGINT"));
    process.on("SIGTERM", () => child.kill("SIGTERM"));
    process.exitCode = await child.exited;
  },

  async preflight(args) {
    const only = args.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const ok = await runPreflight({ swarmPath: join(ROOT, "config", "swarm.yaml"), only: only.length ? only : undefined });
    process.exit(ok ? 0 : 1);
  },

  /** The controller service, idle until a launch (the VPS runs this). */
  async serve() {
    // The record alone isn't proof: after a crash it names a pid that may be alive as another process (PID 1 in a
    // restarted container), so the service has to answer too.
    if (controllerRunning()) die("a controller service is already running here");
    await runService();
  },

  async up(args) {
    const { follow: doFollow, ...launch } = parseUpArgs(args);
    const base = controllerApi();
    if (!base) return runService({ launch });
    const { id } = await call<{ id: number }>(base, "POST", "/launches", launch);
    let r: { status: string; run?: string; error?: string };
    for (;;) {
      r = await call(base, "GET", `/launches/${id}`);
      if (r.status !== "pending") break;
      await Bun.sleep(500);
    }
    if (wantsJson(args)) return out(r);
    if (r.error) die(r.error);
    console.log(`run ${r.run} launched${launch.world ? ` in world ${launch.world}` : " in a new world"} (controller ${base})`);
    if (doFollow) await follow(base, r.run!);
  },

  async continue([world, ...rest]) {
    if (!world || world.startsWith("--")) die('usage: just continue WORLD [preset] [--brief "…"]');
    await commands.up!([...rest, "--world", world]);
  },

  async resume(args) {
    const [id] = withoutFlags(args);
    const base = controllerApi();
    if (!base) return runService({ resume: requireRun(id).id });
    const runId = id ?? (await call<{ run: { id: string } | null }>(base, "GET", "/status")).run?.id;
    if (!runId) die("no runs yet");
    const r = await call(base, "POST", `/runs/${encodeURIComponent(runId)}/resume`, {});
    if (wantsJson(args)) return out(r);
    console.log(`run ${runId} resumed by the controller at ${base}`);
  },

  stop: (args) => runControl("stop", args),
  kill: (args) => runControl("kill", args),

  async extend(args) {
    let parsed;
    try {
      parsed = parseExtendArgs(args.filter((a) => a !== "--json"));
    } catch (e) {
      die(`${(e as Error).message}\nusage: just extend [run] [--time 1h] [--swarm-usd 2] [--agent-usd 0.5] [--agent-usd bramble=1]\n  --agent-usd AMOUNT adds to every agent, --agent-usd NAME=AMOUNT to that agent; flags can repeat and add up`);
    }
    const { runId, detail } = parsed;
    const base = controllerApi();
    if (base) {
      const id = runId ?? (await call<{ run: { id: string } | null }>(base, "GET", "/status")).run?.id;
      if (!id) die("no runs yet");
      const r = await call<{ applied: string }>(base, "POST", `/runs/${encodeURIComponent(id)}/extend`, detail);
      if (wantsJson(args)) return out(r);
      warnExtension(await call<ReturnType<typeof runStatus>>(base, "GET", `/runs/${encodeURIComponent(id)}`), detail);
      return console.log(`extend ${id}: ${describeExtension(detail)}; applied ${r.applied}${r.applied.startsWith("when") ? ` (\`just resume ${id}\`)` : ""}`);
    }
    const run = requireRun(runId);
    const db = openDb();
    const agents = db.query<AgentRow, [string]>("SELECT * FROM agents WHERE run_id = ? ORDER BY rowid").all(run.id);
    for (const who of Object.keys(detail.agentUsd)) if (who !== "*" && !agents.some((a) => a.name === who)) die(`unknown agent ${who}`);
    enqueueControl(db, run.id, "extend", null, "cli", JSON.stringify(detail));
    console.log(`extend ${run.id}: ${describeExtension(detail)}`);
    warnExtension(runStatus(db, run), detail);
    noController("the extension");
  },

  pause: (a) => agentControl("pause", a),
  unpause: (a) => agentControl("unpause", a),
  wake: (a) => agentControl("wake", a),

  async status(args) {
    const [id] = withoutFlags(args);
    const base = remoteApi();
    if (base) {
      const s = await call<ReturnType<typeof runStatus> | { run: null }>(base, "GET", `/status${id ? `?run=${encodeURIComponent(id)}` : ""}`);
      if (wantsJson(args)) return out(s);
      if (!s.run) return console.log("no runs yet");
      return printStatus(s as ReturnType<typeof runStatus>, true);
    }
    const run = requireRun(id);
    const s = runStatus(openDb(), run);
    if (wantsJson(args)) return out(s);
    printStatus(s, controllerRunning());
  },

  async logs(args) {
    const full = args.includes("--full");
    const pos = withoutFlags(args).filter((a, i, all) => !(i > 0 && all[i - 1] === "--since"));
    const sinceVal = args.includes("--since") ? args[args.indexOf("--since") + 1] : undefined;
    const [name, wakeSeq] = pos.filter((a) => a !== sinceVal);
    const base = remoteApi();
    if (!name) {
      const since = sinceOf(args);
      const lines = base ? await call<LogLine[]>(base, "GET", `/logs?since=${since}`) : readLogs(LOG_FILES(), since);
      if (wantsJson(args)) return out(lines);
      if (!lines.length) return console.log("no log lines yet (data/logs/)");
      for (const l of lines) console.log(formatLogLine(l));
      return;
    }
    if (base) {
      const s = await call<ReturnType<typeof runStatus>>(base, "GET", "/status");
      const wakes = await call<WakeRow[]>(base, "GET", `/runs/${encodeURIComponent(s.run.id)}/wakes?agent=${encodeURIComponent(name)}`);
      const wake = wakeSeq ? wakes.find((w) => w.seq === Number(wakeSeq)) : wakes[0];
      if (!wake) die("no such wake");
      const agent = s.state.agents.find((a) => a.name === name);
      if (!agent) die(`unknown agent ${name}`);
      const { requests } = await call<{ requests: { request_id: string; cost_usd: number }[] }>(base, "GET", `/wakes/${wake.id}`);
      const raw = await call<string>(base, "GET", `/wakes/${wake.id}/transcript`);
      console.log(`# ${name} wake ${wake.seq} (${wake.trigger}${wake.resumed ? ", resumed" : ""}) ${new Date(wake.started_at).toISOString()} -> ${wake.exit_reason ?? "running"}, $${wake.cost_usd.toFixed(4)}\n`);
      return printTranscript(raw, agent.harness as AgentRow["harness"], agent.model, new Map(requests.map((r) => [r.request_id, r.cost_usd])), full);
    }
    const run = requireRun();
    const db = openDb();
    const agent = db.query<AgentRow, [string, string]>("SELECT * FROM agents WHERE run_id = ? AND name = ?").get(run.id, name);
    if (!agent) die(`unknown agent ${name}`);
    const wake = wakeSeq
      ? db.query<WakeRow, [string, string, number]>("SELECT * FROM wakes WHERE run_id = ? AND agent = ? AND seq = ?").get(run.id, name, Number(wakeSeq))
      : db.query<WakeRow, [string, string]>("SELECT * FROM wakes WHERE run_id = ? AND agent = ? ORDER BY seq DESC LIMIT 1").get(run.id, name);
    if (!wake?.raw_log_path || !existsSync(wake.raw_log_path)) die("no transcript for that wake");
    const costs = new Map(db.query<{ request_id: string; cost_usd: number }, [number]>("SELECT request_id, cost_usd FROM requests WHERE wake_id = ?").all(wake.id).map((r) => [r.request_id, r.cost_usd]));
    console.log(`# ${name} wake ${wake.seq} (${wake.trigger}${wake.resumed ? ", resumed" : ""}) ${new Date(wake.started_at).toISOString()} -> ${wake.exit_reason ?? "running"}, $${wake.cost_usd.toFixed(4)}\n`);
    printTranscript(readFileSync(wake.raw_log_path, "utf8"), agent.harness, agent.model, costs, full);
  },

  async dash([id]) {
    await migrateDirsOrDie();
    await buildDashboard();
    openDb().close(); // apply schema migrations before the read-only connection
    const db = openDb(DB_PATH, { readonly: true });
    const port = freePort(dashPort(7777), "dashboard");
    const run = id ? getRun(db, id) : null;
    if (id && !run) die(`run not found: ${id}`);
    const forge = await browseForge(run ?? latestRun(db));
    const d = await startDashboard({ db, port, readonly: true, runId: run?.id, forge: forge ?? undefined });
    console.log(`read-only dashboard: ${d.url}  (Ctrl-C to quit)`);
    await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
    d.stop();
    if (forge) await stopForge(worldOf(getRun(db, forge.runId)!));
    console.log(`\ndashboard${forge ? " and forge" : ""} stopped`);
  },

  async worlds(args) {
    const base = remoteApi();
    const worlds = base ? await call<WorldSummary[]>(base, "GET", "/worlds") : listWorlds(openDb());
    if (wantsJson(args)) return out(worlds);
    printWorlds(worlds);
  },

  async config(args) {
    const [sub, dir] = withoutFlags(args);
    const json = wantsJson(args);
    const base = controllerApi();
    const db = base ? null : openDb();
    try {
      if (sub === "import") {
        const bundle = bundleFromDir(dir);
        const imported = base ? (await call<{ imported: string[] }>(base, "POST", "/config", bundle)).imported : importBundle(db!, bundle);
        return json ? out(imported) : console.log(imported.map((l) => `imported: ${l}`).join("\n") || "nothing new");
      }
      if (sub === "export") {
        const written = base ? writeBundle(await call<ConfigBundle>(base, "GET", "/config"), dir) : exportConfig(db!, dir);
        return json ? out(written) : console.log(written.map((f) => `wrote ${f}`).join("\n") || "nothing to export");
      }
      if (sub === "seeds") {
        const seeds = base ? await call<{ id: number; active: number; created_at: number; sha256: string; note: string | null }[]>(base, "GET", "/seeds") : listSeeds(db!).map(({ text: _t, ...s }) => s);
        if (json) return out(seeds);
        return console.log(table([["version", "active", "created", "sha256", "note"], ...seeds.map((s) => [`v${s.id}`, s.active ? "yes" : "", new Date(s.created_at).toISOString().slice(0, 16), s.sha256.slice(0, 12), s.note ?? ""])]));
      }
      if (sub === "list" || !sub) {
        let summary: { presets: string[]; agents: string[]; seed: { version: number; sha256: string } | null };
        if (base) {
          const b = await call<ConfigBundle>(base, "GET", "/config");
          const seeds = await call<{ id: number; active: number; sha256: string }[]>(base, "GET", "/seeds");
          const s = seeds.find((x) => x.active);
          summary = { presets: Object.keys(b.presets), agents: Object.keys(b.agents), seed: s ? { version: s.id, sha256: s.sha256 } : null };
        } else {
          ensureConfigDefaults(db!);
          const s = activeSeed(db!);
          summary = { presets: listPresets(db!).map((p) => p.name), agents: listAgentProfiles(db!).map((a) => a.name), seed: s ? { version: s.id, sha256: s.sha256 } : null };
        }
        if (json) return out(summary);
        console.log(`presets: ${summary.presets.join(", ") || "none"}`);
        console.log(`agent profiles: ${summary.agents.join(", ") || "none"}`);
        console.log(`seed: ${summary.seed ? `v${summary.seed.version} (${summary.seed.sha256.slice(0, 12)})` : "none"}`);
        return;
      }
    } catch (e) {
      die((e as Error).message);
    }
    die("usage: just config [list|seeds|import [dir]|export [dir]] [--json]");
  },

  /** Back up now through the controller: the DB, and the forges of the given (idle) worlds. */
  async backup(args) {
    const worlds = withoutFlags(args);
    const base = controllerApi();
    if (!base) die("no controller service running (`just serve`); backups go through it");
    const r = await call(base, "POST", "/backups", { db: true, worlds });
    if (wantsJson(args)) return out(r);
    const b = r as { db: string | null; forges: Record<string, string | null> };
    if (b.db) console.log(`db: ${b.db}`);
    for (const [w, p] of Object.entries(b.forges)) console.log(`forge ${w}: ${p ?? "no forge data"}`);
  },

  /** A new Forgejo image for an idle world: recorded and its forge restarted on it (runs Forgejo's migrations). */
  async "forge-upgrade"(args) {
    const [world, image] = withoutFlags(args);
    if (!world || !image) die("usage: just forge-upgrade WORLD IMAGE");
    const base = controllerApi();
    if (!base) die("no controller service running (`just serve`)");
    const r = await call(base, "POST", `/worlds/${encodeURIComponent(world)}/forge-image`, { image });
    if (wantsJson(args)) return out(r);
    console.log(`world ${world}: forge on ${image}`);
  },

  runner() {
    // The daemon is its own entry point; this keeps `just runner` on the same CLI.
    const p = Bun.spawn([process.execPath, join(ROOT, "src", "runner", "main.ts")], { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
    process.on("SIGINT", () => p.kill("SIGINT"));
    process.on("SIGTERM", () => p.kill("SIGTERM"));
    return p.exited.then((code) => process.exit(code));
  },

  async report(args) {
    const [id] = withoutFlags(args);
    const base = remoteApi();
    if (base) {
      const runId = id ?? (await call<{ run: { id: string } | null }>(base, "GET", "/status")).run?.id;
      if (!runId) die("no runs yet");
      return console.log(await call<string>(base, "GET", `/runs/${encodeURIComponent(runId)}/report`));
    }
    const run = requireRun(id);
    console.log(renderReport(openDb(), run.id));
  },

  async reset() {
    if (!existsSync(DATA_DIR)) return console.log("nothing to reset");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Delete ${DATA_DIR} (all runs, transcripts and the database)? Type "yes": `);
    rl.close();
    if (answer.trim() !== "yes") return console.log("aborted");
    rmSync(DATA_DIR, { recursive: true, force: true });
    console.log("data/ wiped");
  },
};

/** What would still stop the run right away after an extension. */
function warnExtension(s: ReturnType<typeof runStatus>, detail: ExtendDetail): void {
  const gets = (name: string) => (detail.agentUsd["*"] ?? 0) + (detail.agentUsd[name] ?? 0);
  if (!detail.timeMs && s.run.deadline_at <= Date.now()) console.log("warning: the world has ended and no --time was given; the run will stop again");
  if (s.state.agents.every((a) => a.status === "failed" || a.budgetUsd + gets(a.name) - a.spentUsd < 0.001)) console.log("warning: no agent would have budget left; add --agent-usd");
  if (s.swarmBudgetUsd !== null && s.swarmBudgetUsd + detail.swarmUsd - s.state.run.spentUsd < 0.001) console.log("warning: the swarm budget is spent; add --swarm-usd");
}

/** `just dash`: serve a finished run's forge for browsing. Best effort: the dashboard works without it. */
async function browseForge(run: RunRow | null): Promise<{ runId: string; url: string } | null> {
  if (!run || !existsSync(forgeDataDir(worldOf(run)))) return null;
  if (controllerApi()) {
    console.log("forge: served by the controller service");
    return null;
  }
  const admin = forgeAdminFromEnv();
  if (!admin) {
    console.log("forge: not started (FORGE_ADMIN_PASSWORD is not set in .env)");
    return null;
  }
  const world = worldOf(run);
  try {
    const cfg = swarmFromSnapshot(run.config_yaml);
    const hostPort = freePort(forgePort(cfg.forge.port), "forge");
    const hostCfg = hostConfig();
    await ensureProxy(hostCfg.network.allowlist); // creates the networks the forge needs
    const client = await startForge({ world, image: cfg.forge.image, network: hostCfg.network.name, hostPort, admin });
    console.log(`forge (world ${world}): ${client.baseUrl}  (admin: ${admin.user}, password in .env)`);
    return { runId: run.id, url: client.baseUrl };
  } catch (e) {
    await stopForge(world);
    console.log(`forge: not started: ${(e as Error).message}`);
    return null;
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const fn = cmd ? commands[cmd] : undefined;
if (!fn) die(`usage: bun src/cli.ts <${Object.keys(commands).join("|")}> [args]`);
await fn(rest);
