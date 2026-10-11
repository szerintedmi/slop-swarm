// YAML config loading + validation (plan §2, §5, §6).
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Effort, Runtime } from "./types.ts";

export interface AgentConfig {
  name: string;
  runtime: Runtime;
  model: string;
  effort: Effort;
  budgetUsd: number;
  /** Web search: the runtime's own tool (`native`) or the run's relay via `websearch` (src/search.ts). */
  search: "native" | "relay";
}

export interface SwarmConfig {
  /** `worldEndGraceMs`: how long a wake still running at the world end may go on before it is stopped. */
  run: { name: string; maxDurationMs: number; worldEndGraceMs: number };
  agents: AgentConfig[];
  budgets: {
    swarmUsd: number;
    perAgentUsd: number;
    perWake: { maxUsd: number; maxTurns: number; timeoutMs: number };
  };
  scheduler: {
    maxSleepMs: number;
    maxConcurrentWakes: number;
  };
  controller: {
    tickMs: number;
    container: { cpus: number; memoryGb: number; pidsLimit: number };
  };
  network: { name: string; proxy: string; allowlist: string[] };
  /** The run's Forgejo (plan §4.5). `port` is the host port of the owner's view (FORGE_PORT overrides it at start). */
  forge: { image: string; port: number; pollMs: number };
  /** The agents' public outlet: a GitHub org they all reach through one shared account. Absent = no GitHub. */
  github?: { org: string; user: string };
  /** Absolute path of the config file and the seed/pricing files next to it. */
  paths: { swarm: string; seed: string; pricing: string; configDir: string };
  /** Raw YAML text of swarm + agents, snapshotted into the runs table. */
  snapshot: string;
}

export class ConfigError extends Error {}

function obj(v: unknown, field: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`${field}: expected a mapping`);
  return v as Record<string, unknown>;
}
function num(v: unknown, field: string, { min = 0 }: { min?: number } = {}): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) throw new ConfigError(`${field}: expected a number >= ${min}`);
  return v;
}
function str(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new ConfigError(`${field}: expected a non-empty string`);
  return v;
}
function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (!allowed.includes(v as T)) throw new ConfigError(`${field}: expected one of ${allowed.join(", ")}`);
  return v as T;
}

// Settings carry their unit in the name (`_s`, `_min`, `_usd`, …); durations are converted to ms here.
const S = 1000;
const MIN = 60_000;

// Also a Forgejo username, which can't end with "-".
export const AGENT_NAME_RE = /^[a-z]([a-z0-9-]{0,29}[a-z0-9])?$/;

// GitHub logins and org names: alphanumerics and single hyphens, not at either end.
const GITHUB_NAME_RE = /^[a-zA-Z0-9](-?[a-zA-Z0-9])*$/;
/** Domains the GitHub outlet needs on the allowlist (suffix match: github.com covers api.github.com). */
export const GITHUB_DOMAINS = ["github.com", "githubusercontent.com"] as const;

export const DEFAULT_FORGE_IMAGE = "codeberg.org/forgejo/forgejo:16.0.4-rootless";

export function parseAgent(raw: unknown, defaultBudget: number, source: string): AgentConfig {
  const a = obj(raw, source);
  const name = str(a.name, `${source}.name`);
  if (!AGENT_NAME_RE.test(name)) throw new ConfigError(`${source}.name: must match ${AGENT_NAME_RE}`);
  // Forgejo rejects consecutive non-alphanumerics in usernames.
  if (name.includes("--")) throw new ConfigError(`${source}.name: must not contain "--"`);
  const runtime = oneOf(a.runtime, `${source}.runtime`, ["claude", "codex"] as const);
  return {
    name,
    runtime,
    model: str(a.model, `${source}.model`),
    effort: oneOf(a.effort ?? "medium", `${source}.effort`, ["low", "medium", "high"] as const),
    budgetUsd: a.budget_usd === undefined ? defaultBudget : num(a.budget_usd, `${source}.budget_usd`),
    // Claude and Codex keep their vendors' native search; runtimes without one (pi) default to the relay.
    search: oneOf(a.search ?? ((runtime as string) === "pi" ? "relay" : "native"), `${source}.search`, ["native", "relay"] as const),
  };
}

/** Validate an already-parsed swarm YAML. `loadAgent(name)` returns the parsed agent YAML. */
export function parseSwarm(
  raw: unknown,
  loadAgent: (name: string) => unknown,
): Omit<SwarmConfig, "paths" | "snapshot"> {
  const s = obj(raw, "swarm");
  const run = obj(s.run, "run");
  const budgets = obj(s.budgets, "budgets");
  const perWake = obj(budgets.per_wake, "budgets.per_wake");
  const sch = obj(s.scheduler, "scheduler");
  const ctl = obj(s.controller ?? {}, "controller");
  const cont = obj(ctl.container ?? {}, "controller.container");
  const net = obj(s.network, "network");
  const forge = obj(s.forge ?? {}, "forge");

  const perAgentUsd = num(budgets.per_agent_usd, "budgets.per_agent_usd");
  if (!Array.isArray(s.agents) || s.agents.length === 0) throw new ConfigError("agents: expected a non-empty list of agent names");
  const agents = s.agents.map((n, i) => {
    const name = str(n, `agents[${i}]`);
    const a = parseAgent(loadAgent(name), perAgentUsd, `agents/${name}.yaml`);
    if (a.name !== name) throw new ConfigError(`agents/${name}.yaml: name is ${a.name}, expected ${name}`);
    return a;
  });
  const dup = agents.find((a, i) => agents.findIndex((b) => b.name === a.name) !== i);
  if (dup) throw new ConfigError(`agents: duplicate agent ${dup.name}`);

  const cfg = {
    run: {
      name: str(run.name, "run.name"),
      maxDurationMs: num(run.max_duration_min, "run.max_duration_min") * MIN,
      worldEndGraceMs: num(run.world_end_grace_s ?? 60, "run.world_end_grace_s") * S,
    },
    agents,
    budgets: {
      swarmUsd: num(budgets.swarm_usd, "budgets.swarm_usd"),
      perAgentUsd,
      perWake: {
        maxUsd: num(perWake.max_usd, "budgets.per_wake.max_usd"),
        maxTurns: num(perWake.max_turns, "budgets.per_wake.max_turns", { min: 1 }),
        timeoutMs: num(perWake.timeout_min, "budgets.per_wake.timeout_min") * MIN,
      },
    },
    scheduler: {
      maxSleepMs: num(sch.max_sleep_min, "scheduler.max_sleep_min") * MIN,
      maxConcurrentWakes: num(sch.max_concurrent_wakes ?? agents.length, "scheduler.max_concurrent_wakes", { min: 1 }),
    },
    controller: {
      tickMs: num(ctl.tick_s ?? 5, "controller.tick_s") * S,
      container: {
        cpus: num(cont.cpus ?? 1, "controller.container.cpus"),
        memoryGb: num(cont.memory_gb ?? 2, "controller.container.memory_gb"),
        pidsLimit: num(cont.pids_limit ?? 256, "controller.container.pids_limit", { min: 16 }),
      },
    },
    network: {
      name: str(net.name, "network.name"),
      proxy: str(net.proxy, "network.proxy"),
      allowlist: (Array.isArray(net.allowlist) ? net.allowlist : []).map((d, i) => str(d, `network.allowlist[${i}]`)),
    },
    forge: {
      image: str(forge.image ?? DEFAULT_FORGE_IMAGE, "forge.image"),
      port: num(forge.port ?? 3300, "forge.port", { min: 1 }),
      pollMs: num(forge.poll_s ?? 15, "forge.poll_s") * S,
    },
  };
  if (cfg.scheduler.maxSleepMs > cfg.run.maxDurationMs) throw new ConfigError("scheduler: max_sleep_min longer than run.max_duration_min");
  if (s.github === undefined) return cfg;
  return { ...cfg, github: parseGithub(s.github, cfg.network.allowlist) };
}

function parseGithub(raw: unknown, allowlist: string[]): { org: string; user: string } {
  const gh = obj(raw, "github");
  const name = (v: unknown, field: string) => {
    const n = str(v, field);
    if (!GITHUB_NAME_RE.test(n)) throw new ConfigError(`${field}: not a valid GitHub name`);
    return n;
  };
  const missing = GITHUB_DOMAINS.filter((d) => !allowlist.some((a) => a.trim().toLowerCase().replace(/^\*?\./, "") === d));
  if (missing.length) throw new ConfigError(`github: network.allowlist needs ${missing.join(", ")}`);
  return { org: name(gh.org, "github.org"), user: name(gh.user, "github.user") };
}

/** Rebuild a run's config from the YAML snapshot stored in `runs.config_yaml` (for `just resume`). */
export function swarmFromSnapshot(snapshot: string): SwarmConfig {
  const chunks = new Map<string, string>();
  let key = "";
  for (const line of snapshot.split("\n")) {
    const m = /^# --- (.+)$/.exec(line);
    if (m) {
      key = m[1]!;
      chunks.set(key, "");
    } else chunks.set(key, (chunks.get(key) ?? "") + line + "\n");
  }
  const [swarmKey] = [...chunks.keys()].filter((k) => !k.startsWith("agents/"));
  if (swarmKey === undefined) throw new ConfigError("snapshot has no swarm section");
  const parsed = parseSwarm(Bun.YAML.parse(chunks.get(swarmKey)!), (name) => {
    const text = chunks.get(`agents/${name}.yaml`);
    if (text === undefined) throw new ConfigError(`snapshot has no agents/${name}.yaml`);
    return Bun.YAML.parse(text);
  });
  return { ...parsed, paths: { swarm: swarmKey, seed: "", pricing: "", configDir: "" }, snapshot };
}

export function loadSwarm(swarmPath: string): SwarmConfig {
  const abs = resolve(swarmPath);
  if (!existsSync(abs)) throw new ConfigError(`config not found: ${abs}`);
  const configDir = dirname(abs);
  const swarmText = readFileSync(abs, "utf8");
  const agentTexts: string[] = [];
  const parsed = parseSwarm(Bun.YAML.parse(swarmText), (name) => {
    const p = join(configDir, "agents", `${name}.yaml`);
    if (!existsSync(p)) throw new ConfigError(`agent config not found: ${p}`);
    const text = readFileSync(p, "utf8");
    agentTexts.push(`# --- agents/${name}.yaml\n${text}`);
    return Bun.YAML.parse(text);
  });
  const paths = { swarm: abs, seed: join(configDir, "seed.md"), pricing: join(configDir, "pricing.yaml"), configDir };
  for (const p of [paths.seed, paths.pricing]) if (!existsSync(p)) throw new ConfigError(`missing ${p}`);
  return { ...parsed, paths, snapshot: [`# --- ${swarmPath}`, swarmText, ...agentTexts].join("\n") };
}
