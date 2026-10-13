// YAML config loading + validation (plan §2, §5, §6).
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAdapter } from "./harnesses/index.ts";
import { HARNESSES, type Effort, type Harness, type SearchMode } from "./types.ts";

export type ModelProvider = "native" | "openrouter";

export interface AgentConfig {
  name: string;
  harness: Harness;
  /** For OpenRouter, the model string as sent, e.g. `z-ai/glm-5.3-flash@preset/sw-glm-5-3-flash`. */
  model: string;
  effort: Effort;
  budgetUsd: number;
  /** `native`: the harness's own vendor (Claude Code, Codex). `openrouter`: OpenRouter, via pi. */
  provider: ModelProvider;
  /** OpenRouter agents: the env var (in .env) holding the API key. Never the key itself. */
  keyEnv?: string;
  /** Web search: the harness's own tool (`native`) or the run's relay via `websearch` (src/search.ts). */
  search: SearchMode;
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
  };
  /** The run's Forgejo (plan §4.5). `port` is the host port of the owner's view (FORGE_PORT overrides it at start). */
  forge: { image: string; port: number; pollMs: number };
  /** The agents' public outlet: a GitHub org they all reach through one shared account. Absent = no GitHub. */
  github?: { org: string; user: string };
  /** Agents' `webfetch <url>`: GET-only downloads of public URLs through the run's relay (src/webfetch.ts). Absent = off. */
  webfetch?: WebfetchConfig;
  /** Absolute path of the config file and the seed/pricing files next to it. */
  paths: { swarm: string; seed: string; pricing: string; configDir: string };
  /** Raw YAML text of swarm + agents, snapshotted into the runs table. */
  snapshot: string;
}

export interface WebfetchConfig {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
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

/** OpenRouter agents read their key from this env var unless they name another (`key_env`). */
export const DEFAULT_OPENROUTER_KEY_ENV = "OPEN_ROUTER_API_KEY";
/** The domain OpenRouter agents need on the allowlist (API and the generation cost lookup). */
export const OPENROUTER_DOMAIN = "openrouter.ai";
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const DEFAULT_FORGE_IMAGE = "codeberg.org/forgejo/forgejo:16.0.4-rootless";

export function parseAgent(raw: unknown, defaultBudget: number, source: string): AgentConfig {
  const a = obj(raw, source);
  const name = str(a.name, `${source}.name`);
  if (!AGENT_NAME_RE.test(name)) throw new ConfigError(`${source}.name: must match ${AGENT_NAME_RE}`);
  // Forgejo rejects consecutive non-alphanumerics in usernames.
  if (name.includes("--")) throw new ConfigError(`${source}.name: must not contain "--"`);
  // `runtime:` is the old name of `harness:`, accepted only so config snapshots of earlier runs still load.
  if (a.harness !== undefined && a.runtime !== undefined) throw new ConfigError(`${source}: give harness only (runtime is its old name)`);
  const harness = oneOf(a.harness ?? a.runtime, `${source}.harness`, HARNESSES);
  const provider = oneOf(a.provider ?? "native", `${source}.provider`, ["native", "openrouter"] as const);
  // Claude Code and Codex stay on their own vendors; pi runs OpenRouter models only (for now).
  if ((harness === "pi") !== (provider === "openrouter"))
    throw new ConfigError(`${source}: harness pi goes with provider: openrouter (and only pi does, for now)`);
  if (a.key_env !== undefined && provider !== "openrouter") throw new ConfigError(`${source}.key_env: only for provider: openrouter`);
  const keyEnv = provider === "openrouter" ? str(a.key_env ?? DEFAULT_OPENROUTER_KEY_ENV, `${source}.key_env`) : undefined;
  if (keyEnv !== undefined && !ENV_NAME_RE.test(keyEnv)) throw new ConfigError(`${source}.key_env: not an environment variable name`);
  return {
    name,
    harness,
    model: str(a.model, `${source}.model`),
    effort: oneOf(a.effort ?? "medium", `${source}.effort`, ["low", "medium", "high"] as const),
    budgetUsd: a.budget_usd === undefined ? defaultBudget : num(a.budget_usd, `${source}.budget_usd`),
    provider,
    ...(keyEnv !== undefined ? { keyEnv } : {}),
    search: parseSearch(a.search, harness, `${source}.search`),
  };
}

/**
 * `search:` against what the harness supports (its adapter's `searchModes`; the first is the default).
 * Claude and Codex default to their own search; with `relay` their own tool is turned off. pi has none.
 */
function parseSearch(v: unknown, harness: Harness, field: string): SearchMode {
  const modes = getAdapter(harness).searchModes;
  const mode = oneOf(v ?? modes[0], field, ["native", "relay"] as const);
  if (!modes.includes(mode))
    throw new ConfigError(`${field}: ${harness} has no ${mode === "native" ? "native search tool" : "relay support"}; use ${modes.map((m) => `search: ${m}`).join(" or ")}`);
  return mode;
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
  // `network:` and `controller.container:` moved to config/host.yaml; earlier runs' snapshots still carry them (ignored).
  const forge = obj(s.forge ?? {}, "forge");

  const perAgentUsd = num(budgets.per_agent_usd, "budgets.per_agent_usd");
  if (!Array.isArray(s.agents) || s.agents.length === 0) throw new ConfigError("agents: expected a non-empty list of agent names");
  // Each entry is a profile name, or `{ name, …overrides }` (a preset's per-agent overrides, e.g. budget_usd or model).
  const agents = s.agents.map((n, i) => {
    const entry = typeof n === "object" && n !== null && !Array.isArray(n) ? (n as Record<string, unknown>) : null;
    const name = str(entry ? entry.name : n, `agents[${i}]${entry ? ".name" : ""}`);
    const profile = loadAgent(name);
    const merged = entry ? { ...obj(profile, `agents/${name}.yaml`), ...entry, name: (profile as Record<string, unknown>)?.name } : profile;
    const a = parseAgent(merged, perAgentUsd, `agents/${name}.yaml`);
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
    },
    forge: {
      image: str(forge.image ?? DEFAULT_FORGE_IMAGE, "forge.image"),
      port: num(forge.port ?? 3300, "forge.port", { min: 1 }),
      pollMs: num(forge.poll_s ?? 15, "forge.poll_s") * S,
    },
  };
  if (cfg.scheduler.maxSleepMs > cfg.run.maxDurationMs) throw new ConfigError("scheduler: max_sleep_min longer than run.max_duration_min");
  // The allowlist the agents need (openrouter.ai, GitHub's domains) is checked against config/host.yaml at launch (hostconfig.ts checkHostFor).
  return {
    ...cfg,
    ...(s.github !== undefined ? { github: parseGithub(s.github) } : {}),
    ...(s.webfetch !== undefined && s.webfetch !== false ? { webfetch: parseWebfetch(s.webfetch) } : {}),
  };
}

/** Upper bounds keep one fetch from tying up the relay (256 MB memory, one deadline per fetch). */
export const WEBFETCH_MAX = { mb: 100, timeoutS: 120, redirects: 10 } as const;

/** `webfetch:` (an empty section takes the defaults; remove it or set `false` to turn webfetch off). */
function parseWebfetch(raw: unknown): WebfetchConfig {
  const w = obj(raw ?? {}, "webfetch");
  const bounded = (v: unknown, field: string, min: number, max: number, int = false) => {
    const n = num(v, field, { min });
    if (n > max || (int && !Number.isInteger(n))) throw new ConfigError(`${field}: expected ${int ? "an integer" : "a number"} ${min}–${max}`);
    return n;
  };
  const mb = bounded(w.max_mb ?? 20, "webfetch.max_mb", 0.001, WEBFETCH_MAX.mb);
  return {
    maxBytes: Math.round(mb * 1024 * 1024),
    timeoutMs: bounded(w.timeout_s ?? 30, "webfetch.timeout_s", 1, WEBFETCH_MAX.timeoutS) * S,
    maxRedirects: bounded(w.max_redirects ?? 5, "webfetch.max_redirects", 0, WEBFETCH_MAX.redirects, true),
  };
}

function parseGithub(raw: unknown): { org: string; user: string } {
  const gh = obj(raw, "github");
  const name = (v: unknown, field: string) => {
    const n = str(v, field);
    if (!GITHUB_NAME_RE.test(n)) throw new ConfigError(`${field}: not a valid GitHub name`);
    return n;
  };
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
  // The host config (§4.3) is recorded in the snapshot too, after the swarm and agents.
  const [swarmKey] = [...chunks.keys()].filter((k) => !k.startsWith("agents/") && k !== HOST_SNAPSHOT_KEY && k !== "");
  if (swarmKey === undefined) throw new ConfigError("snapshot has no swarm section");
  const parsed = parseSwarm(Bun.YAML.parse(chunks.get(swarmKey)!), (name) => {
    const text = chunks.get(`agents/${name}.yaml`);
    if (text === undefined) throw new ConfigError(`snapshot has no agents/${name}.yaml`);
    return Bun.YAML.parse(text);
  });
  return { ...parsed, paths: { swarm: swarmKey, seed: "", pricing: "", configDir: "" }, snapshot };
}

/** The snapshot chunk holding the host config a run started with (config/host.yaml). */
export const HOST_SNAPSHOT_KEY = "host.yaml";

/** A run's config snapshot: `# --- <key>` chunks, swarm first, then each agent profile, then the host config. */
export function buildSnapshot(swarmKey: string, swarmText: string, agentTexts: [string, string][], hostYaml?: string): string {
  const chunk = (k: string, t: string) => `# --- ${k}\n${t.endsWith("\n") ? t : t + "\n"}`;
  return [chunk(swarmKey, swarmText), ...agentTexts.map(([n, t]) => chunk(`agents/${n}.yaml`, t)), ...(hostYaml !== undefined ? [chunk(HOST_SNAPSHOT_KEY, hostYaml)] : [])].join("");
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
