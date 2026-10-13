// The agent host's limits (config/host.yaml): egress allowlist, container limits, runner limits. One deployed
// file, pushed to the runner at every run start (docs/plans/2026-10-12-hosted-control-plane.md, Decisions).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, GITHUB_DOMAINS, OPENROUTER_DOMAIN, type SwarmConfig } from "./config.ts";
import { filterLines } from "./proxy.ts";

export const HOST_CONFIG_PATH = join(import.meta.dir, "..", "config", "host.yaml");

export interface HostConfig {
  network: { name: string; proxy: string; allowlist: string[] };
  container: { cpus: number; memoryGb: number; pidsLimit: number };
  runner: {
    watchdogMs: number;
    hardTimeoutSlackMs: number;
    homeWarnBytes: number;
    homeCapBytes: number;
    homeExcludes: string[];
  };
}

function obj(v: unknown, field: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`host.yaml ${field}: expected a mapping`);
  return v as Record<string, unknown>;
}
function num(v: unknown, field: string, min = 0): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) throw new ConfigError(`host.yaml ${field}: expected a number >= ${min}`);
  return v;
}
function str(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new ConfigError(`host.yaml ${field}: expected a non-empty string`);
  return v;
}
const NAME_RE = /^[A-Za-z0-9._-]+$/;

export function parseHostConfig(raw: unknown): HostConfig {
  const h = obj(raw, "(root)");
  const net = obj(h.network, "network");
  const cont = obj(h.container ?? {}, "container");
  const run = obj(h.runner ?? {}, "runner");
  const allowlist = (Array.isArray(net.allowlist) ? net.allowlist : []).map((d, i) => str(d, `network.allowlist[${i}]`));
  try {
    filterLines(allowlist);
  } catch (e) {
    throw new ConfigError(`host.yaml ${(e as Error).message}`);
  }
  const excludes = (Array.isArray(run.home_excludes) ? run.home_excludes : []).map((d, i) => {
    const s = str(d, `runner.home_excludes[${i}]`);
    if (!NAME_RE.test(s) || s === "." || s === "..") throw new ConfigError(`host.yaml runner.home_excludes[${i}]: expected a file or dir name`);
    return s;
  });
  const MB = 1024 * 1024;
  return {
    network: { name: str(net.name, "network.name"), proxy: str(net.proxy, "network.proxy"), allowlist },
    container: {
      cpus: num(cont.cpus ?? 1, "container.cpus"),
      memoryGb: num(cont.memory_gb ?? 2, "container.memory_gb"),
      pidsLimit: num(cont.pids_limit ?? 256, "container.pids_limit", 16),
    },
    runner: {
      watchdogMs: num(run.watchdog_s ?? 300, "runner.watchdog_s", 30) * 1000,
      hardTimeoutSlackMs: num(run.hard_timeout_slack_s ?? 60, "runner.hard_timeout_slack_s") * 1000,
      homeWarnBytes: Math.round(num(run.home_warn_mb ?? 200, "runner.home_warn_mb") * MB),
      homeCapBytes: Math.round(num(run.home_cap_mb ?? 2000, "runner.home_cap_mb", 1) * MB),
      homeExcludes: excludes,
    },
  };
}

export function loadHostConfig(path = process.env.SLOPSWARM_HOST_CONFIG || HOST_CONFIG_PATH): HostConfig {
  return parseHostConfig(Bun.YAML.parse(hostConfigText(path)));
}

/** The host config file's text (recorded in each run's snapshot). */
export function hostConfigText(path = process.env.SLOPSWARM_HOST_CONFIG || HOST_CONFIG_PATH): string {
  if (!existsSync(path)) throw new ConfigError(`host config not found: ${path}`);
  return readFileSync(path, "utf8");
}

/** What the runner applies of the host config, hashed: allowlist and container limits (recorded per run). */
export function hostConfigHash(h: HostConfig): string {
  const applied = { allowlist: [...h.network.allowlist].map((d) => d.trim().toLowerCase()).sort(), container: h.container, network: h.network.name, proxy: h.network.proxy };
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(applied)).digest("hex").slice(0, 16);
}

export function onAllowlist(allowlist: string[], domain: string): boolean {
  return allowlist.some((a) => a.trim().toLowerCase().replace(/^\*?\./, "") === domain);
}

/** The swarm's needs against the host's allowlist: OpenRouter agents need openrouter.ai, the GitHub outlet its domains. */
export function checkHostFor(cfg: Pick<SwarmConfig, "agents" | "github">, host: HostConfig): string | null {
  if (cfg.agents.some((a) => a.provider === "openrouter") && !onAllowlist(host.network.allowlist, OPENROUTER_DOMAIN))
    return `host.yaml network.allowlist needs ${OPENROUTER_DOMAIN} for the OpenRouter agents`;
  if (cfg.github) {
    const missing = GITHUB_DOMAINS.filter((d) => !onAllowlist(host.network.allowlist, d));
    if (missing.length) return `github: host.yaml network.allowlist needs ${missing.join(", ")}`;
  }
  return null;
}
