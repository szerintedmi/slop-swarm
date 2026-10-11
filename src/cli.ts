#!/usr/bin/env bun
// Entry point for every `just` recipe (plan §9).
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadSwarm, swarmFromSnapshot } from "./config.ts";
import { CODEX_AUTH_PATH, Controller } from "./controller/index.ts";
import { GITHUB_TOKEN_PATH } from "./github.ts";
import { createRun } from "./controller/run.ts";
import { startDashboard } from "./dashboard/server.ts";
import { buildDashboard } from "./dashboard/build.ts";
import { agentDirs, DATA_DIR, DB_PATH, enqueueControl, getRun, latestRun, openDb, type AgentRow, type ControlAction, type RunRow, type WakeRow } from "./db/index.ts";
import { dockerKillLabelled, imageInfo } from "./docker.ts";
import { forgeAdminFromEnv, forgeDataDir, forgePort, FORWARDER_IMAGE, provisionAgents, startForge, stopForge, type ForgeClient } from "./forge.ts";
import { AGENT_IMAGE, buildImages, ensureAgentImage, ensureProxy } from "./proxy.ts";
import { runPreflight } from "./preflight.ts";
import { renderReport } from "./report.ts";
import { getAdapter } from "./runtimes/index.ts";
import { describeExtension, parseExtendArgs, parseExtendDetail, swarmBudgetUsd, worldTime } from "./world.ts";

const ROOT = join(import.meta.dir, "..");
const LOCK = join(DATA_DIR, "controller.pid");
const LOG_TOOL_LINES = 20;

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid of the live controller of this data dir, if any. */
function controllerPid(): number | null {
  const pid = existsSync(LOCK) ? Number(readFileSync(LOCK, "utf8")) : 0;
  return pid && pidAlive(pid) ? pid : null;
}

function releaseLock(): void {
  try {
    if (readFileSync(LOCK, "utf8") === String(process.pid)) unlinkSync(LOCK);
  } catch {
    /* gone */
  }
}

function takeLock(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const pid = controllerPid();
  if (pid) die(`a controller is already running (pid ${pid})`);
  writeFileSync(LOCK, String(process.pid));
  process.on("exit", releaseLock);
}

/** Fail before a run starts (or resumes) if a configured runtime has no credentials. */
function assertSecrets(cfg: ReturnType<typeof loadSwarm>): void {
  if (cfg.agents.some((a) => a.runtime === "claude") && !process.env.CLAUDE_CODE_OAUTH_TOKEN) die("CLAUDE_CODE_OAUTH_TOKEN is not set in .env");
  if (cfg.agents.some((a) => a.runtime === "codex") && !existsSync(CODEX_AUTH_PATH)) die(`codex agents need ${CODEX_AUTH_PATH} (copy ~/.codex/auth.json)`);
  if (!forgeAdminFromEnv()) die("FORGE_ADMIN_PASSWORD is not set in .env (`just setup` generates one)");
  if (cfg.github && !existsSync(GITHUB_TOKEN_PATH)) die(`the github outlet needs ${GITHUB_TOKEN_PATH} (a token for ${cfg.github.user}; or remove github: from the config)`);
}

function forgePortOf(cfg: ReturnType<typeof loadSwarm>): number {
  try {
    return forgePort(cfg.forge.port);
  } catch (e) {
    die((e as Error).message);
  }
}

/** Start the run's forge and log every agent in (plan §4.5). */
async function bringUpForge(runId: string, cfg: ReturnType<typeof loadSwarm>, port: number): Promise<{ client: ForgeClient; url: string }> {
  const admin = forgeAdminFromEnv()!;
  let client: ForgeClient;
  try {
    client = await startForge({ runId, image: cfg.forge.image, network: cfg.network.name, hostPort: port, admin });
    await provisionAgents(client, runId, cfg.agents.map((a) => ({ name: a.name, runtimeDir: agentDirs(runId, a.name).runtime })));
  } catch (e) {
    await stopForge(runId);
    openDb()
      .query("UPDATE runs SET status = 'stopped', stop_reason = 'forge did not start', ended_at = ? WHERE id = ? AND status = 'running'")
      .run(Date.now(), runId);
    die((e as Error).message);
  }
  console.log(`forge: ${client.baseUrl}  (admin: ${admin.user}, password in .env)`);
  return { client, url: client.baseUrl };
}

/** Dashboard port: PORT env overrides the default 7777. */
function dashPort(fallback: number): number {
  const p = Number(process.env.PORT ?? fallback);
  if (!Number.isInteger(p) || p < 0 || p > 65535) die(`invalid PORT ${process.env.PORT}`);
  return p;
}

/** Fail early (before a run is created) if the dashboard (or forge) port is taken. */
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

async function runController(runId: string, cfg: ReturnType<typeof loadSwarm>, port: number, fport: number): Promise<void> {
  const forge = await bringUpForge(runId, cfg, fport);
  const db = openDb();
  const controller = new Controller(db, runId, cfg, { forge: forge.client });
  const dash = await startDashboard({ db, port, runId, forge: { runId, url: forge.url } });
  console.log(`dashboard: ${dash.url}`);
  let interrupts = 0;
  // After the run: Ctrl-C (or SIGTERM) closes the dashboard and the forge.
  let quit: (() => void) | null = null;
  process.on("SIGINT", () => {
    if (quit) return quit();
    interrupts++;
    if (interrupts === 1) {
      console.log("\nCtrl-C: graceful stop (no new wakes; running wakes finish). Ctrl-C again to kill containers.");
      controller.requestStop("interrupted");
    } else void controller.emergencyKill("interrupted twice");
  });
  process.on("SIGTERM", () => (quit ? quit() : controller.requestStop("SIGTERM")));
  await controller.loop();
  // The run is over: no controller any more, but keep the dashboard and the forge up for browsing.
  releaseLock();
  console.log(`report: just report ${runId}`);
  console.log(`dashboard (${dash.url}) and forge (${forge.url}) stay up for browsing; Ctrl-C to quit`);
  await new Promise<void>((resolve) => (quit = resolve));
  dash.stop();
  await stopForge(runId);
  console.log("\ndashboard and forge stopped");
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
    mkdirSync(join(ROOT, "secrets", "codex"), { recursive: true });
    if (!existsSync(join(ROOT, "secrets", "codex", "auth.json")))
      console.log("Codex runs need secrets/codex/auth.json (copy ~/.codex/auth.json after `codex login`)");
    openDb().close();
    console.log(`database: ${DB_PATH}`);
    await buildImages();
    const swarm = loadSwarm(join(ROOT, "config", "swarm.yaml"));
    for (const image of [swarm.forge.image, FORWARDER_IMAGE]) await Bun.spawn(["docker", "pull", "-q", image], { stdout: "inherit", stderr: "inherit" }).exited;
    await ensureProxy(swarm.network.allowlist);
    console.log("setup done");
  },

  async 'ui-build'() {
    await buildDashboard(true);
  },

  async 'ui-dev'() {
    const child = Bun.spawn([process.execPath, '--no-env-file', '--bun', 'vite', 'dev', '--host', '127.0.0.1'], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    process.exitCode = await child.exited;
  },

  async preflight(args) {
    const only = args.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const ok = await runPreflight({ swarmPath: join(ROOT, "config", "swarm.yaml"), only: only.length ? only : undefined });
    process.exit(ok ? 0 : 1);
  },

  async up([swarmPath = "config/swarm.yaml"]) {
    const cfg = loadSwarm(swarmPath);
    assertSecrets(cfg);
    await buildDashboard(); // fail before creating a run or starting/stopping Docker containers
    takeLock();
    const port = freePort(dashPort(7777), "dashboard");
    const fport = freePort(forgePortOf(cfg), "forge");
    await ensureProxy(cfg.network.allowlist);
    await ensureAgentImage();
    const info = await imageInfo(AGENT_IMAGE);
    if (!info) die(`image ${AGENT_IMAGE} could not be built`);
    const db = openDb();
    const runId = createRun(db, cfg, { cliVersions: { claude: info.claude, codex: info.codex }, imageDigest: info.digest });
    db.close();
    console.log(`run ${runId} started (${cfg.agents.map((a) => a.name).join(", ")})`);
    await runController(runId, cfg, port, fport);
  },

  async resume([id]) {
    const run = requireRun(id);
    const cfg = swarmFromSnapshot(run.config_yaml);
    assertSecrets(cfg);
    await buildDashboard(); // fail before creating a run or starting/stopping Docker containers
    takeLock();
    const port = freePort(dashPort(7777), "dashboard");
    await stopForge(run.id); // leftovers of a crashed controller hold the port
    const fport = freePort(forgePortOf(cfg), "forge");
    await ensureProxy(cfg.network.allowlist);
    await ensureAgentImage();
    console.log(`resuming run ${run.id}`);
    await runController(run.id, cfg, port, fport);
  },

  stop() {
    const run = requireRun();
    enqueueControl(openDb(), run.id, "stop", null, "cli");
    console.log(`stop requested for ${run.id}; running wakes will finish`);
  },

  async kill() {
    const run = requireRun();
    const db = openDb();
    enqueueControl(db, run.id, "kill", null, "cli");
    // Only this run's containers: other worktrees may be running their own.
    const killed = await dockerKillLabelled({ runId: run.id });
    if (!controllerPid()) {
      // No controller to consume the control: mark the run stopped ourselves.
      db.query("UPDATE runs SET status = 'stopped', stop_reason = 'kill (no controller)', ended_at = ? WHERE id = ? AND status != 'finished'").run(Date.now(), run.id);
    }
    console.log(`killed ${killed.length} container(s): ${killed.join(", ") || "none"}`);
  },

  extend(args) {
    let parsed;
    try {
      parsed = parseExtendArgs(args);
    } catch (e) {
      die(`${(e as Error).message}\nusage: just extend [run] [--time 1h] [--swarm-usd 2] [--agent-usd 0.5] [--agent-usd bramble=1]\n  --agent-usd AMOUNT adds to every agent, --agent-usd NAME=AMOUNT to that agent; flags can repeat and add up`);
    }
    const { runId, detail } = parsed;
    const run = requireRun(runId);
    const db = openDb();
    const agents = db.query<AgentRow, [string]>("SELECT * FROM agents WHERE run_id = ? ORDER BY rowid").all(run.id);
    for (const who of Object.keys(detail.agentUsd)) if (who !== "*" && !agents.some((a) => a.name === who)) die(`unknown agent ${who}`);
    enqueueControl(db, run.id, "extend", null, "cli", JSON.stringify(detail));
    console.log(`extend ${run.id}: ${describeExtension(detail)}`);
    // What would still stop the run right away.
    const now = Date.now();
    const gets = (a: AgentRow) => (detail.agentUsd["*"] ?? 0) + (detail.agentUsd[a.name] ?? 0);
    if (!detail.timeMs && run.deadline_at <= now) console.log("warning: the world has ended and no --time was given; the run will stop again");
    if (agents.every((a) => a.status === "failed" || a.budget_usd + gets(a) - a.spent_usd < 0.001))
      console.log("warning: no agent would have budget left; add --agent-usd");
    const swarm = swarmBudgetUsd(db, run);
    if (swarm !== null && swarm + detail.swarmUsd - agents.reduce((s, a) => s + a.spent_usd, 0) < 0.001) console.log("warning: the swarm budget is spent; add --swarm-usd");
    const live = run.status === "running" || run.status === "stopping";
    if (live && controllerPid()) console.log("queued: the running controller applies it on its next tick");
    else console.log(`queued: no controller is running this run; \`just resume ${run.id}\` applies it and continues the run`);
  },

  pause: (a) => agentControl("pause", a),
  unpause: (a) => agentControl("unpause", a),
  wake: (a) => agentControl("wake", a),

  status([id]) {
    const run = requireRun(id);
    const db = openDb();
    const agents = db.query<AgentRow, [string]>("SELECT * FROM agents WHERE run_id = ? ORDER BY rowid").all(run.id);
    const last = db.query<WakeRow, [string, string]>("SELECT * FROM wakes WHERE run_id = ? AND agent = ? ORDER BY seq DESC LIMIT 1");
    const now = Date.now();
    const spent = agents.reduce((s, a) => s + a.spent_usd, 0);
    const live = run.status === "running" || run.status === "stopping";
    const ends = live ? `ends ${rel(run.deadline_at, now)}` : `ended ${rel(run.ended_at, now)}`;
    const world = worldTime(db, run, now);
    const budget = swarmBudgetUsd(db, run);
    console.log(`${run.id}  [${run.status}${run.stop_reason ? `: ${run.stop_reason}` : ""}]  world time ${(world.elapsedMs / 3_600_000).toFixed(2)}h, ${ends}, spend $${spent.toFixed(4)}${budget !== null ? ` of $${budget.toFixed(2)}` : ""}`);
    if (!live) console.log("no controller: nothing will wake (`just resume` continues this run, `just extend` adds time or budget)");
    else if (!controllerPid()) console.log("marked running, but no controller is running (crashed?): `just resume` continues this run");
    const queued = db
      .query<{ detail: string | null }, [string]>("SELECT detail FROM controls WHERE run_id = ? AND action = 'extend' AND consumed_at IS NULL ORDER BY id")
      .all(run.id);
    for (const c of queued) {
      try {
        console.log(`queued extension (applied when a controller runs): ${describeExtension(parseExtendDetail(c.detail))}`);
      } catch {
        /* the controller logs a malformed one */
      }
    }
    const rows = [["agent", "runtime", "model", "status", "next wake", "wakes", "spent", "budget", "last exit"]];
    for (const a of agents) {
      const w = last.get(run.id, a.name);
      rows.push([a.name, a.runtime, a.model, a.status, live && a.next_wake_at ? `${rel(a.next_wake_at, now)} (${a.next_trigger})` : "-", String(a.wake_count), `$${a.spent_usd.toFixed(4)}`, `$${a.budget_usd.toFixed(2)}`, w ? `${w.exit_reason ?? "running"} ${rel(w.ended_at ?? w.started_at, now)}` : "-"]);
    }
    console.log(table(rows));
  },

  async logs(args) {
    const full = args.includes("--full");
    const [name, wakeSeq] = args.filter((a) => a !== "--full");
    if (!name) die("usage: just logs NAME [wake] [--full]");
    const run = requireRun();
    const db = openDb();
    const agent = db.query<AgentRow, [string, string]>("SELECT * FROM agents WHERE run_id = ? AND name = ?").get(run.id, name);
    if (!agent) die(`unknown agent ${name}`);
    const wake = wakeSeq
      ? db.query<WakeRow, [string, string, number]>("SELECT * FROM wakes WHERE run_id = ? AND agent = ? AND seq = ?").get(run.id, name, Number(wakeSeq))
      : db.query<WakeRow, [string, string]>("SELECT * FROM wakes WHERE run_id = ? AND agent = ? ORDER BY seq DESC LIMIT 1").get(run.id, name);
    if (!wake?.raw_log_path || !existsSync(wake.raw_log_path)) die("no transcript for that wake");
    const costs = new Map(
      db.query<{ request_id: string; cost_usd: number }, [number]>("SELECT request_id, cost_usd FROM requests WHERE wake_id = ?").all(wake.id).map((r) => [r.request_id, r.cost_usd]),
    );
    console.log(`# ${name} wake ${wake.seq} (${wake.trigger}${wake.resumed ? ", resumed" : ""}) ${new Date(wake.started_at).toISOString()} -> ${wake.exit_reason ?? "running"}, $${wake.cost_usd.toFixed(4)}\n`);
    const parser = getAdapter(agent.runtime).newParser({ model: agent.model });
    const seen = new Set<string>();
    const indent = (s: string, pad: string) => s.replace(/\n/g, `\n${pad}`);
    // Tool output can be huge; keep the first lines unless --full.
    const clip = (s: string) => {
      const lines = s.replace(/\s+$/, "").split("\n");
      return full || lines.length <= LOG_TOOL_LINES ? lines.join("\n") : `${lines.slice(0, LOG_TOOL_LINES).join("\n")}\n… ${lines.length - LOG_TOOL_LINES} more lines (--full)`;
    };
    for (const line of readFileSync(wake.raw_log_path, "utf8").split("\n")) {
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
  },

  async dash([id]) {
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
    if (forge) await stopForge(forge.runId);
    console.log(`\ndashboard${forge ? " and forge" : ""} stopped`);
  },

  report([id]) {
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

/** `just dash`: serve a finished run's forge for browsing. Best effort: the dashboard works without it. */
async function browseForge(run: RunRow | null): Promise<{ runId: string; url: string } | null> {
  if (!run || !existsSync(forgeDataDir(run.id))) return null;
  if ((run.status === "running" || run.status === "stopping") && controllerPid()) {
    console.log("forge: served by the run's controller");
    return null;
  }
  const admin = forgeAdminFromEnv();
  if (!admin) {
    console.log("forge: not started (FORGE_ADMIN_PASSWORD is not set in .env)");
    return null;
  }
  try {
    const cfg = swarmFromSnapshot(run.config_yaml);
    const hostPort = freePort(forgePort(cfg.forge.port), "forge");
    await ensureProxy(cfg.network.allowlist); // creates the networks the forge needs
    const client = await startForge({ runId: run.id, image: cfg.forge.image, network: cfg.network.name, hostPort, admin });
    console.log(`forge (${run.id}): ${client.baseUrl}  (admin: ${admin.user}, password in .env)`);
    return { runId: run.id, url: client.baseUrl };
  } catch (e) {
    await stopForge(run.id);
    console.log(`forge: not started: ${(e as Error).message}`);
    return null;
  }
}

function agentControl(action: ControlAction, [name]: string[]): void {
  if (!name) die(`usage: just ${action} NAME`);
  const run = requireRun();
  const db = openDb();
  if (!db.query("SELECT 1 FROM agents WHERE run_id = ? AND name = ?").get(run.id, name)) die(`unknown agent ${name}`);
  enqueueControl(db, run.id, action, name, "cli");
  console.log(`${action} ${name}: queued for the controller`);
}

const [cmd, ...rest] = process.argv.slice(2);
const fn = cmd ? commands[cmd] : undefined;
if (!fn) die(`usage: bun src/cli.ts <${Object.keys(commands).join("|")}> [args]`);
await fn(rest);
