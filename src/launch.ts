// Starting and resuming runs (docs/plans/2026-10-12-hosted-control-plane.md §2, §3): the steps shared by the CLI and
// the controller service. The agent host is always reached through its runner, locally too.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HOST_SNAPSHOT_KEY, loadSwarm, type SwarmConfig } from "./config.ts";
import { ensureConfigDefaults, swarmFromPreset } from "./config-db.ts";
import { CODEX_AUTH_PATH } from "./controller/index.ts";
import { createRun } from "./controller/run.ts";
import { pushHomeIfBehind } from "./controller/host-files.ts";
import { runPiModelsPath } from "./controller/wake.ts";
import { getRun, runDir, worldOf, type RunRow } from "./db/index.ts";
import { forgeAdminFromEnv, provisionAgents, stopForge, type ForgeClient } from "./forge.ts";
import { GITHUB_TOKEN_ENV, githubTokenFromEnv } from "./github.ts";
import { RunnerHost, type AgentHost } from "./host/agent-host.ts";
import { checkHostFor, hostConfigText, type HostConfig } from "./hostconfig.ts";
import type { Logger } from "./log.ts";
import { prepareOpenRouter } from "./openrouter.ts";
import { parsePricing } from "./pricing/index.ts";
import { AGENT_IMAGE } from "./proxy.ts";
import { serveRunner } from "./runner/main.ts";
import { checkSearchSetup, relayNeeded } from "./search.ts";

export class LaunchError extends Error {}

/**
 * What a run starts from: a preset in the DB (by name; config/ is loaded into an empty DB first), or a swarm file
 * (a path: development, the files as they are). The snapshot gets the host config appended.
 */
export function resolveSwarm(db: Database, arg: string): { cfg: SwarmConfig; seedText: string; source: string } {
  let hostText: string;
  try {
    hostText = hostConfigText();
  } catch (e) {
    throw new LaunchError((e as Error).message);
  }
  if (arg.includes("/") || arg.endsWith(".yaml")) {
    const cfg = loadSwarm(arg);
    return { cfg: { ...cfg, snapshot: cfg.snapshot.replace(/\n?$/, "\n") + `# --- ${HOST_SNAPSHOT_KEY}\n${hostText}` }, seedText: readFileSync(cfg.paths.seed, "utf8"), source: arg };
  }
  ensureConfigDefaults(db);
  const { cfg, seed } = swarmFromPreset(db, arg, { hostYaml: hostText });
  return { cfg, seedText: seed.text, source: `preset ${arg}, seed ${seed.name} v${seed.id}` };
}

/** The agent image the runner runs: a registry reference (CI pushes it by digest) or this checkout's local tag. */
export function agentImageRef(env = process.env): string {
  return env.SLOPSWARM_AGENT_IMAGE?.trim() || AGENT_IMAGE;
}

/** Missing credentials for the configured harnesses, as messages (empty: all there). */
export function missingSecrets(cfg: Pick<SwarmConfig, "agents" | "github">, env = process.env): string[] {
  const out: string[] = [];
  if (cfg.agents.some((a) => a.harness === "claude") && !env.CLAUDE_CODE_OAUTH_TOKEN) out.push("CLAUDE_CODE_OAUTH_TOKEN is not set in .env");
  if (cfg.agents.some((a) => a.harness === "codex") && !existsSync(CODEX_AUTH_PATH)) out.push(`codex agents need ${CODEX_AUTH_PATH} (copy ~/.codex/auth.json)`);
  for (const a of cfg.agents) if (a.keyEnv && !env[a.keyEnv]?.trim()) out.push(`${a.name}: ${a.keyEnv} is not set in .env (its OpenRouter key)`);
  if (!forgeAdminFromEnv(env)) out.push("FORGE_ADMIN_PASSWORD is not set in .env (`just setup` generates one)");
  if (cfg.github && !githubTokenFromEnv()) out.push(`the github outlet needs ${GITHUB_TOKEN_ENV} in .env (a token for ${cfg.github.user}; or remove github: from the config)`);
  return out;
}

export interface AgentHostHandle {
  host: AgentHost;
  /** Where it is (for logs). */
  url: string;
  /** Local runner started in this process (stopped with it). */
  local: boolean;
  stop(): void;
}

/**
 * The runner to use: SLOPSWARM_RUNNER_URL + SLOPSWARM_RUNNER_TOKEN for a runner elsewhere (the agent host), else one started in
 * this process on localhost (the laptop: one code path, the same an ephemeral VM will use).
 */
export async function connectAgentHost(env = process.env): Promise<AgentHostHandle> {
  const url = env.SLOPSWARM_RUNNER_URL?.trim();
  if (url) {
    const token = env.SLOPSWARM_RUNNER_TOKEN?.trim();
    if (!token) throw new LaunchError("SLOPSWARM_RUNNER_URL is set but SLOPSWARM_RUNNER_TOKEN is not");
    return { host: new RunnerHost({ url, token }), url, local: false, stop: () => {} };
  }
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  const r = await serveRunner({ token, host: "127.0.0.1", port: 0 });
  return { host: new RunnerHost({ url: r.url, token }), url: r.url, local: true, stop: r.stop };
}

export interface CreateRunOptions {
  db: Database;
  cfg: SwarmConfig;
  hostCfg: HostConfig;
  host: AgentHost;
  /** Continue this world; default: a new one. */
  world?: string;
  brief?: string | null;
  /** The seed text (default: the config's seed file). */
  seedText?: string;
  log: Logger;
  env?: Record<string, string | undefined>;
}

/**
 * Apply the host config on the runner, freeze prices, and create the run (in a new or an existing world). Returns the
 * run id. Nothing about the world's forge yet: bringUpWorld does that.
 */
export async function prepareRun(o: CreateRunOptions): Promise<string> {
  const env = o.env ?? process.env;
  const hostProblem = checkHostFor(o.cfg, o.hostCfg);
  if (hostProblem) throw new LaunchError(hostProblem);
  const image = agentImageRef(env);
  const up = await o.host.ensureUp({ host: o.hostCfg, image, relaySecrets: env.EXA_API_KEY?.trim() ? { EXA_API_KEY: env.EXA_API_KEY.trim() } : {} });
  o.log.info(`agent host ready: host config ${up.appliedHash}, image ${up.image.ref}`);
  // OpenRouter agents: prices and pi's model entries from the public catalogue, frozen into the run.
  let openrouter;
  try {
    openrouter = await prepareOpenRouter(o.cfg.agents, readFileSync(o.cfg.paths.pricing, "utf8"));
  } catch (e) {
    throw new LaunchError(`OpenRouter: ${(e as Error).message}`);
  }
  const check = checkSearchSetup(o.cfg, parsePricing(openrouter.pricingYaml), env);
  if (check.error) throw new LaunchError(check.error);
  for (const w of check.warnings) o.log.warn(w);
  const runId = createRun(o.db, o.cfg, {
    cliVersions: { claude: up.image.claude, codex: up.image.codex, pi: up.image.pi },
    imageDigest: up.image.digest,
    pricingYaml: openrouter.pricingYaml,
    world: o.world,
    brief: o.brief,
    seedText: o.seedText,
    hostHash: up.appliedHash,
  });
  for (const [name, models] of Object.entries(openrouter.piModels)) {
    const p = runPiModelsPath(runDir(runId), name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(models, null, 2) + "\n");
  }
  return runId;
}

/**
 * Bring the run's world up around its forge (started by the caller: the service keeps forges and their ports): the
 * host config again (the runner may have restarted), every agent's forge login, the relay (and, for a remote agent
 * host, the forge forwarder) on the agent host, and homes pushed where the agent host is behind the VPS copy. On
 * failure the run is marked stopped.
 */
export async function bringUpWorld(o: { db: Database; run: RunRow; cfg: SwarmConfig; hostCfg: HostConfig; host: AgentHost; forge: ForgeClient; forgeTarget?: string; log: Logger }): Promise<void> {
  const world = worldOf(o.run);
  const fail = (reason: string, e: unknown): never => {
    o.db.query("UPDATE runs SET status = 'stopped', stop_reason = ?, ended_at = ? WHERE id = ? AND status = 'running'").run(reason, Date.now(), o.run.id);
    o.db.query("UPDATE worlds SET status = 'idle' WHERE id = ? AND status = 'active'").run(world);
    throw new LaunchError(`${reason}: ${(e as Error)?.message ?? e}`);
  };
  try {
    await o.host.ensureUp({ host: o.hostCfg, image: agentImageRef(), relaySecrets: process.env.EXA_API_KEY?.trim() ? { EXA_API_KEY: process.env.EXA_API_KEY.trim() } : {} });
  } catch (e) {
    fail("agent host did not come up", e);
  }
  try {
    await provisionAgents(o.forge, world, o.cfg.agents.map((a) => a.name));
  } catch (e) {
    fail("forge accounts", e);
  }
  try {
    await o.host.worldUp(world, { relay: relayNeeded(o.cfg) ? { webfetch: o.cfg.webfetch } : undefined, forgeTarget: o.forgeTarget });
  } catch (e) {
    fail("relay did not start", e);
  }
  for (const a of o.cfg.agents) {
    try {
      const pushed = await pushHomeIfBehind(o.host, { world, agent: a.name });
      if (pushed) o.log.info(`home of ${a.name} pushed to the agent host (generation ${pushed.generation})`, { world, agent: a.name });
    } catch (e) {
      await o.host.worldDown(world).catch(() => {});
      fail(`home push failed for ${a.name}`, e);
    }
  }
}

/** The run's world goes down on the agent host (relay, forwarder) and here (forge). */
export async function bringDownWorld(o: { run: RunRow; host: AgentHost; forge?: boolean }): Promise<void> {
  const world = worldOf(o.run);
  await o.host.worldDown(world).catch(() => {});
  if (o.forge !== false) await stopForge(world);
}

export function requireRunRow(db: Database, id: string): RunRow {
  const run = getRun(db, id);
  if (!run) throw new LaunchError(`run not found: ${id}`);
  return run;
}
