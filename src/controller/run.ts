// Creating a run (plan §4.1) in a new or an existing world (docs/plans/2026-10-12-hosted-control-plane.md §3): DB
// rows only. The world's forge and the agents' dirs on the agent host are brought up by the launcher (src/launch.ts).
import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import type { SwarmConfig } from "../config.ts";
import { agentDirs, getWorld, type RunRow, type WorldAgentRow } from "../db/index.ts";

export function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** e.g. 20261010-1055-smoke-3f9a. The random suffix keeps runs (and their container names) unique across worktrees. */
export function makeRunId(name: string, now = Date.now()): string {
  const t = new Date(now).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const rand = crypto.getRandomValues(new Uint8Array(2)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  return `${t}-${name}-${rand}`;
}

export class WorldError extends Error {}

/** The run that is running (or stopping) in `world`, if any. */
export function activeRunIn(db: Database, world: string): RunRow | null {
  return db.query<RunRow, [string]>("SELECT * FROM runs WHERE COALESCE(world_id, id) = ? AND status IN ('running', 'stopping') ORDER BY started_at DESC LIMIT 1").get(world);
}

export function createRun(
  db: Database,
  cfg: SwarmConfig,
  /**
   * `pricingYaml`: the pricing snapshot (config/pricing.yaml plus fetched OpenRouter prices); default: the file.
   * `world`: continue that world (its forge and the agents' homes and sessions carry over); default: a new world,
   * whose id is this run's id. `seedText`: the seed (default: the file at cfg.paths.seed).
   */
  meta: { cliVersions?: Record<string, string | undefined>; imageDigest?: string; pricingYaml?: string; world?: string; brief?: string | null; seedText?: string; hostHash?: string },
  now = Date.now(),
): string {
  const id = makeRunId(cfg.run.name, now);
  const seed = meta.seedText ?? readFileSync(cfg.paths.seed, "utf8");
  const pricing = meta.pricingYaml ?? readFileSync(cfg.paths.pricing, "utf8");
  const world = meta.world ?? id;

  for (const a of cfg.agents) mkdirSync(agentDirs(id, a.name).raw, { recursive: true });

  db.transaction(() => {
    if (meta.world) {
      const w = getWorld(db, meta.world);
      if (!w) throw new WorldError(`world not found: ${meta.world}`);
      if (w.status === "archived") throw new WorldError(`world ${meta.world} is archived`);
      const active = activeRunIn(db, meta.world);
      if (active) throw new WorldError(`world ${meta.world} has an active run (${active.id}); stop it first`);
    } else {
      db.query("INSERT INTO worlds (id, name, created_at, forge_image, status) VALUES (?, ?, ?, ?, 'idle')").run(world, cfg.run.name, now, cfg.forge.image);
    }
    // A continued world keeps its forge's image: it may have been upgraded past the preset's (`just forge-upgrade`),
    // and an older Forgejo can't run on migrated data.
    db.query("UPDATE worlds SET status = 'active' WHERE id = ?").run(world);
    db.query(
      `INSERT INTO runs (id, name, world_id, brief, host_hash, config_yaml, seed_sha256, seed_text, pricing_yaml, cli_versions, image_digest, status, started_at, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    ).run(id, cfg.run.name, world, meta.brief?.trim() || null, meta.hostHash ?? null, cfg.snapshot, sha256(seed), seed, pricing, JSON.stringify(meta.cliVersions ?? {}), meta.imageDigest ?? null, now, now + cfg.run.maxDurationMs);

    // Agents of the world: new ones join, returning ones carry their session over, absent ones leave (homes kept).
    const known = new Map(db.query<WorldAgentRow, [string]>("SELECT * FROM world_agents WHERE world_id = ?").all(world).map((r) => [r.name, r]));
    const ins = db.query(
      `INSERT INTO agents (run_id, name, harness, model, effort, budget_usd, status, next_wake_at, next_trigger, last_session_id, continue_next)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 'initial', ?, ?)`,
    );
    for (const a of cfg.agents) {
      const prev = known.get(a.name);
      // A session only carries over on the same harness (a Codex thread id means nothing to Claude Code).
      const carry = prev && prev.harness === a.harness ? prev : undefined;
      // First wakes `first_wake_stagger` apart in config order, so the later ones find something on the forge
      // (all at once, they built four unrelated things in parallel); max_concurrent_wakes also spreads them out.
      ins.run(id, a.name, a.harness, a.model, a.effort, a.budgetUsd, now + cfg.agents.indexOf(a) * cfg.scheduler.firstWakeStaggerMs, carry?.last_session_id ?? null, carry?.continue_next ?? 0);
      if (prev) db.query("UPDATE world_agents SET harness = ?, removed_at = NULL WHERE world_id = ? AND name = ?").run(a.harness, world, a.name);
      else db.query("INSERT INTO world_agents (world_id, name, harness, added_at) VALUES (?, ?, ?, ?)").run(world, a.name, a.harness, now);
    }
    const inRun = new Set(cfg.agents.map((a) => a.name));
    for (const name of known.keys()) if (!inRun.has(name)) db.query("UPDATE world_agents SET removed_at = COALESCE(removed_at, ?) WHERE world_id = ? AND name = ?").run(now, world, name);
    db.query("INSERT INTO events (run_id, ts, kind, name, detail) VALUES (?, ?, 'lifecycle', 'run_created', ?)").run(id, now, `${cfg.paths.swarm}${meta.world ? ` (continues world ${world})` : ""}`);
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
 * `{activity}` marks where the wake note's summary of the others' forge activity is described; the summary itself
 * goes into the wake note (wakeNote), so the system prompt stays the same from wake to wake (a continued session
 * keeps its prompt cache). A seed without it gets no summary.
 */
export function fillSeed(seed: string, v: { name: string; forgeUrl: string; pagesUrl?: string; maxSleepMs: number; github?: { org: string; user: string } }): string {
  return seed
    .replace(/^\{github\}\n/m, v.github ? githubLine(v.github) : "")
    .replaceAll("{name}", v.name)
    .replaceAll("{forge_url}", v.forgeUrl)
    .replaceAll("{pages_url}", v.pagesUrl ?? PAGES_FALLBACK)
    .replaceAll("{max_sleep}", humanDuration(v.maxSleepMs))
    .replaceAll(ACTIVITY_PLACEHOLDER, ACTIVITY_DESCRIPTION);
}

/** {pages_url} when nothing serves pages (`just smoke`, preflight): the path shape still reads right. */
const PAGES_FALLBACK = "the world's pages site, ";

export const ACTIVITY_PLACEHOLDER = "{activity}";
const ACTIVITY_DESCRIPTION = "what the others did on the forge since your last wake";

/** Whether the seed asks for the forge activity summary in the wake note. */
export const seedWantsActivity = (seed: string) => seed.includes(ACTIVITY_PLACEHOLDER);

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
  /** The agent's average cost per finished wake in this run; absent before its first. */
  avgWakeUsd?: number;
  /** The world end (the run deadline, extensions included). */
  worldEndsAt: number;
  /**
   * The others' forge activity since the agent's last wake (activityLines), when the seed asks for it; `since` says
   * from when: the last wake, or (first wake) the run start.
   */
  activity?: { lines: string[]; since: "last_wake" | "run_start" };
  maxTurns: number;
  /** When this wake is stopped if still running (per-wake timeout, or the world end + grace). */
  stopsAt: number;
  /** The run brief (first wake of the run only), e.g. "bramble/pubrepo has open PRs". */
  brief?: string;
}

const usd = (v: number) => `$${v.toFixed(4)}`;

/**
 * The user turn of every wake (plan §4.3): time, why, the others' forge activity (if the seed asks for it), budget
 * and this wake's limits. Kept short and factual so it doesn't read as a task list; the unread line only appears
 * when there is something unread. The budget is given as a share and in wakes at the agent's own rate, with the
 * world end: a bare "$0.98 of $1.00" read as nearly spent to small models, which then idled with 97% unspent.
 */
export function wakeNote(n: WakeNoteInput): string {
  const why = `${WHY[n.trigger] ?? n.trigger}${n.resumed ? ", continuing your previous session" : ""}`;
  const left = Math.max(0, n.budgetUsd - n.spentUsd);
  const usedPct = n.budgetUsd > 0 ? Math.round((Math.min(n.spentUsd, n.budgetUsd) / n.budgetUsd) * 100) : 100;
  const rate = n.avgWakeUsd && n.avgWakeUsd > 0 ? ` Your wakes have averaged ${usd(n.avgWakeUsd)}, so that is ~${Math.floor(left / n.avgWakeUsd)} more at this rate.` : "";
  const activity = n.activity
    ? [
        `The others on the forge since ${n.activity.since === "last_wake" ? "your last wake" : "the world began"}:${n.activity.lines.length ? "" : " nothing new."}`,
        ...n.activity.lines.map((l) => `  ${l}`),
      ]
    : [];
  // The whole user turn, so it must not start with "-" (it is a bare argv element).
  return [
    `[Wake ${n.wakeSeq} at ${iso(n.now)} (UTC): ${why}.`,
    ...(n.unread > 0 ? [`Unread forge notifications: ${n.unread} (\`tea notifications ls --mine\`).`] : []),
    ...activity,
    `Budget: ${usd(left)} left of ${usd(n.budgetUsd)} (${usedPct}% used).${rate} The world ends in ${humanDuration(n.worldEndsAt - n.now)}; budget left then is simply lost.`,
    "Past wakes' costs: /self/usage.jsonl. Prices: /self/pricing.yaml.",
    `Safety stops for this wake (a runaway guard, not a target): over ${usd(n.wakeLimitUsd)}, ${n.maxTurns} turns, or still running at ${iso(n.stopsAt)}.]`,
    ...(n.brief?.trim() ? ["", `[Note from the operator: ${n.brief.trim()}]`] : []),
  ].join("\n");
}
