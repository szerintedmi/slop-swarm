// Creating a run: DB rows and per-agent dirs (plan §4.1). The run's forge is started by the CLI (src/forge.ts).
import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import type { SwarmConfig } from "../config.ts";
import { agentDirs } from "../db/index.ts";

export function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** e.g. 20261010-1055-smoke-3f9a. The random suffix keeps runs (and their container names) unique across worktrees. */
export function makeRunId(name: string, now = Date.now()): string {
  const t = new Date(now).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const rand = crypto.getRandomValues(new Uint8Array(2)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  return `${t}-${name}-${rand}`;
}

export function createRun(
  db: Database,
  cfg: SwarmConfig,
  /** `pricingYaml`: the pricing snapshot (config/pricing.yaml plus fetched OpenRouter prices); default: the file. */
  meta: { cliVersions?: Record<string, string | undefined>; imageDigest?: string; pricingYaml?: string },
  now = Date.now(),
): string {
  const id = makeRunId(cfg.run.name, now);
  const seed = readFileSync(cfg.paths.seed, "utf8");
  const pricing = meta.pricingYaml ?? readFileSync(cfg.paths.pricing, "utf8");

  for (const a of cfg.agents) {
    const d = agentDirs(id, a.name);
    for (const p of [d.home, d.self, d.runtime, d.raw]) mkdirSync(p, { recursive: true });
  }

  db.transaction(() => {
    db.query(
      `INSERT INTO runs (id, name, config_yaml, seed_sha256, seed_text, pricing_yaml, cli_versions, image_digest, status, started_at, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    ).run(id, cfg.run.name, cfg.snapshot, sha256(seed), seed, pricing, JSON.stringify(meta.cliVersions ?? {}), meta.imageDigest ?? null, now, now + cfg.run.maxDurationMs);
    const ins = db.query(
      `INSERT INTO agents (run_id, name, runtime, model, effort, budget_usd, status, next_wake_at, next_trigger)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 'initial')`,
    );
    // Everyone is due at once; max_concurrent_wakes spreads them out.
    for (const a of cfg.agents) ins.run(id, a.name, a.runtime, a.model, a.effort, a.budgetUsd, now);
    db.query("INSERT INTO events (run_id, ts, kind, name, detail) VALUES (?, ?, 'lifecycle', 'run_created', ?)").run(id, now, cfg.paths.swarm);
  })();
  return id;
}

export const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");

/** "1h 5m", "12m", "45s" */
export function humanDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

/**
 * Fill the seed's {placeholders}. The template (not the filled text) is what runs.seed_sha256 freezes.
 * Agents are not told when the world ends (plan §4.3): that is the harness's business.
 */
export function fillSeed(seed: string, v: { name: string; forgeUrl: string; maxSleepMs: number; github?: { org: string; user: string } }): string {
  return seed
    .replace(/^\{github\}\n/m, v.github ? githubLine(v.github) : "")
    .replaceAll("{name}", v.name)
    .replaceAll("{forge_url}", v.forgeUrl)
    .replaceAll("{max_sleep}", humanDuration(v.maxSleepMs));
}

/** The seed's `{github}` line (plan §4.6); the line is dropped when the run has no GitHub outlet. */
function githubLine(gh: { org: string; user: string }): string {
  return (
    `Your work helps only once it reaches people outside this world. GitHub is public: publish what's useful there\n` +
    `early and update it as you go, in the organisation github.com/${gh.org}.\n` +
    `One account, ${gh.user}, is shared by everyone; git and \`gh\` are logged in as it. Sign what you publish as {name}.\n`
  );
}

/** Written to the agent's runtime dir each wake; Codex reads its instructions from this file. */
export const SYSTEM_PROMPT_FILE = "system-prompt.md";

const WHY: Record<string, string> = {
  initial: "your first wake",
  self: "the time you chose",
  timer: "your sleep ended",
  message: "new forge notifications",
  manual: "the operator woke you",
};

export interface WakeNoteInput {
  now: number;
  wakeSeq: number;
  trigger: string;
  resumed: boolean;
  /** Unread forge notifications at wake start. */
  unread: number;
  budgetUsd: number;
  spentUsd: number;
  /** This wake's spend cap (the tightest of per-wake max, agent and swarm remaining). */
  wakeLimitUsd: number;
  maxTurns: number;
  /** When this wake is stopped if still running (per-wake timeout, or the world end + grace). */
  stopsAt: number;
}

const usd = (v: number) => `$${v.toFixed(4)}`;

/**
 * The user turn of every wake (plan §4.3): time, why, budget and this wake's limits. Kept short and factual so it
 * doesn't read as a task list; the unread line only appears when there is something unread.
 */
export function wakeNote(n: WakeNoteInput): string {
  const why = `${WHY[n.trigger] ?? n.trigger}${n.resumed ? ", continuing your previous session" : ""}`;
  // The whole user turn, so it must not start with "-" (it is a bare argv element).
  return [
    `[Wake ${n.wakeSeq} at ${iso(n.now)} (UTC): ${why}.`,
    ...(n.unread > 0 ? [`Unread forge notifications: ${n.unread} (\`tea notifications ls --mine\`).`] : []),
    `Budget: ${usd(Math.max(0, n.budgetUsd - n.spentUsd))} left of ${usd(n.budgetUsd)}.`,
    `This wake is stopped if it spends over ${usd(n.wakeLimitUsd)}, makes ${n.maxTurns} turns, or is still running at ${iso(n.stopsAt)}.`,
    "Past wakes' costs: /self/usage.jsonl. Prices: /self/pricing.yaml.]",
  ].join("\n");
}
