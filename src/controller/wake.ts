// One wake (plan §4.2; docs/plans/2026-10-12-hosted-control-plane.md §2): prepare the agent's dirs on the agent
// host, start the CLI there through the runner, follow its output by offset and cost every request live, kill on
// budget/timeout, then finalise usage and schedule the next wake. The same code re-follows a wake that is still
// running after a controller restart.
import { copyFileSync, createWriteStream, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentConfig, SwarmConfig } from "../config.ts";
import { agentDirs, worldAgentDirs, worldDirs, type WakeRow } from "../db/index.ts";
import { MOUNTS, type ContainerSpec } from "../docker.ts";
import { agentLoginFiles, forgeEnv, forgeHost, forgeToken, forgeUrl, type ForgeApi } from "../forge.ts";
import { GITHUB_TOKEN_ENV, githubEnv, githubLoginFiles, githubTokenFromEnv } from "../github.ts";
import { RunnerError, type AgentHost } from "../host/agent-host.ts";
import { generationCosts, type VendorCost } from "../openrouter.ts";
import { computeCost, type PricingTable } from "../pricing/index.ts";
import { getAdapter } from "../harnesses/index.ts";
import { PI_AGENT_SUBDIR } from "../harnesses/pi.ts";
import type { HostFile, WakeStatus } from "../runner/protocol.ts";
import { newRelayToken, readSearchLog, RELAY_TOKEN_FILE, SEARCH_MODEL, SEARCH_PROMPT_LINE, searchEnv, searchHost, searchRows, usesRelay } from "../search.ts";
import { webfetchPromptBlock } from "../webfetch.ts";
import { browsercheckEnv } from "../browsercheck.ts";
import type { AgentEvent, CostBreakdown, RequestUsage, Harness, HarnessAdapter, WakeExitReason, WakeTrigger } from "../types.ts";
import { isDepleted, overLimit, wakeLimit, agentRemaining } from "./budget.ts";
import { mirrorFile, mirrorSessionFiles } from "./host-files.ts";
import type { Repo } from "./repo.ts";
import { fillSeed, wakeNote, SYSTEM_PROMPT_FILE } from "./run.ts";
import { messagePull, parseNextWake, planNextWake } from "./scheduler.ts";
import { selfFiles } from "./self-writer.ts";

export const MAX_CONSECUTIVE_FAILURES = 3;
/** A failed wake is retried after this long. */
export const RETRY_AFTER_MS = 60_000;
const LIVE_POLL_MS = 5_000;
const OUTPUT_POLL_MS = 500;
const KILL_RETRY_MS = 5_000;
const ARGS_MAX = 200;
/** Total time the OpenRouter cost cross-check may take after a wake. */
const VENDOR_CHECK_MS = 90_000;
/** How long the runner may stay unreachable past a wake's hard timeout before the controller gives the wake up. */
const UNREACHABLE_GRACE_MS = 5 * 60_000;
const NEXT_WAKE_MAX = 64 * 1024;
const STDERR_MAX = 1024 * 1024;
const DEFAULT_HARD_TIMEOUT_SLACK_MS = 60_000;

export interface WakeDeps {
  repo: Repo;
  cfg: SwarmConfig;
  pricing: PricingTable;
  pricingYaml: string;
  seed: string;
  runDeadline: number;
  /** The effective swarm budget (config plus extensions). */
  swarmBudgetUsd: number;
  /** Agent image reference, as the runner knows it. */
  image: string;
  /** The agent host (a runner). */
  host: AgentHost;
  /** The world the run is in. */
  world: string;
  /** Optional run brief, added to each agent's first wake note of the run. */
  brief?: string | null;
  /** The master Codex login; each agent gets its own copy (codexAgentAuthPath), seeded from it. */
  codexAuthPath: string;
  /** The agents' shared GitHub token (github.ts, from .env); read each wake when the run has a GitHub outlet. Injectable for tests. */
  githubToken?: () => string | undefined;
  /** Where container secrets come from (default: the controller's env). */
  env?: Record<string, string | undefined>;
  /** The run's forge: unread notification counts (plan §4.5). */
  forge: ForgeApi;
  /** An agent's forge token (default: the one stored in the world, forge.ts). */
  forgeToken?: (agent: string) => string | undefined;
  /** The forge's public URL when it has one (§7): git maps it back to the internal forge. */
  forgePublicUrl?: string;
  /** pi's models.json for an agent (frozen at run start). */
  piModels?: (agent: string) => unknown;
  /** Extra time the runner gives a wake past its per-wake timeout before killing it itself (host.yaml). */
  hardTimeoutSlackMs?: number;
  adapterFor?: (harness: Harness) => HarnessAdapter;
  /** OpenRouter's charged cost per generation id (cross-check); injectable for tests. */
  vendorCosts?: (ids: string[], key: string) => Promise<Map<string, VendorCost>>;
  /** How often the runner's output is polled while nothing new came. */
  outputPollMs?: number;
  /** How often the session files are re-read for usage while the wake runs (default LIVE_POLL_MS). */
  livePollMs?: number;
  now?: () => number;
}

export interface WakeHandle {
  agent: string;
  wakeId: number;
  done: Promise<WakeOutcome>;
  /** Stop the wake early (run stop/kill). */
  abort(reason: WakeExitReason): void;
  /** The world end moved (run extension): a wake still running is stopped against the new one. */
  setWorldEnd(deadline: number): void;
  /** Stop following without finishing the wake (a controller shutting down for a deploy): no DB writes after this. */
  detach(): void;
}

export interface WakeOutcome {
  wakeId: number;
  exitReason: WakeExitReason;
  costUsd: number;
  /** The OpenRouter cost cross-check, still running after the wake (and its scheduler slot) ended. */
  vendorCheck?: Promise<void>;
  /** The container ran (so the home may have changed and is pulled to the VPS). */
  ran: boolean;
  /** Left to the next controller (detach): nothing was recorded. */
  detached?: boolean;
}

function short(s: string, n = ARGS_MAX): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

const isEmpty = (u: RequestUsage) =>
  u.freshInput + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h + u.output + u.reasoning + u.webSearches === 0;

export function costAll(pricing: PricingTable, usages: RequestUsage[]): { rows: { u: RequestUsage; c: CostBreakdown }[]; total: number } {
  // Zero-usage records (e.g. Claude's "<synthetic>" reply when auth fails) are not API requests.
  const rows = usages.filter((u) => !isEmpty(u)).map((u) => ({ u, c: computeCost(u, pricing) }));
  return { rows, total: rows.reduce((s, r) => s + r.c.costUsd, 0) };
}

/**
 * Raw stdout of the last earlier wake that ran `sessionId`, when this wake resumes it. Adapters
 * need it because both CLIs report some totals cumulatively over a resumed session (see FinalizeContext).
 * Earlier runs of the world count too (`previous` may span runs).
 */
export function previousSessionLines(previous: WakeRow[], sessionId: string | undefined): string[] | undefined {
  if (!sessionId) return undefined;
  const prev = previous.filter((w) => w.session_id === sessionId).at(-1);
  if (!prev?.raw_log_path || !existsSync(prev.raw_log_path)) return undefined;
  return readFileSync(prev.raw_log_path, "utf8").split("\n").filter(Boolean);
}

/** The vendor-reported cost of the previous wake, as its stream said it (cumulative for Claude). */
function reportedCostOf(adapter: HarnessAdapter, model: string, lines: string[]): number | undefined {
  const parser = adapter.newParser({ model });
  let reported: number | undefined;
  for (const l of lines) for (const e of parser.push(l)) if (e.kind === "turn_end" && e.reportedCostUsd !== undefined) reported = e.reportedCostUsd;
  return reported;
}

/** Secrets a harness's container gets by name (never in argv): the Claude token, or the agent's OpenRouter key. */
export function secretEnv(agent: Pick<AgentConfig, "harness" | "provider" | "keyEnv">): NonNullable<ContainerSpec["passEnv"]> {
  if (agent.provider === "openrouter" && agent.keyEnv) return [{ name: "OPENROUTER_API_KEY", from: agent.keyEnv }];
  return agent.harness === "claude" ? ["CLAUDE_CODE_OAUTH_TOKEN"] : [];
}

/** Those secrets' values, by their container name, for the runner's prepare. Missing ones are left out. */
export function secretValues(agent: Pick<AgentConfig, "harness" | "provider" | "keyEnv">, env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of secretEnv(agent)) {
    const [name, from] = typeof k === "string" ? [k, k] : [k.name, k.from];
    const v = env[from];
    if (v) out[name] = v;
  }
  return out;
}

/** An agent's own Codex login on the controller's side (Codex rotates it; two agents never share one). */
export function codexAgentAuthPath(masterPath: string, world: string, agent: string): string {
  return join(dirname(masterPath), world, agent, "auth.json");
}

/** Where pi's models.json for an agent of a run is kept (frozen at run start; sent at each prepare). */
export const runPiModelsPath = (runDir: string, agent: string) => join(runDir, "pi-models", `${agent}.json`);

/**
 * When a wake starting at `startedAt` is stopped if it is still running: after the per-wake timeout, or at
 * the world end plus `graceMs`, whichever comes first (plan §6).
 */
export function wakeStopAt(startedAt: number, timeoutMs: number, worldEnd: number, graceMs: number): { at: number; atWorldEnd: boolean } {
  const byTimeout = startedAt + timeoutMs;
  const byWorldEnd = worldEnd + graceMs;
  return byWorldEnd < byTimeout ? { at: byWorldEnd, atWorldEnd: true } : { at: byTimeout, atWorldEnd: false };
}

const b64 = (s: string) => Buffer.from(s).toString("base64");
const textFile = (area: HostFile["area"], path: string, content: string, mode = 0o644, ifMissing = false): HostFile => ({ area, path, content: b64(content), mode, ...(ifMissing ? { ifMissing } : {}) });

/** Start a new wake of `agentName`, or (with `existing`) follow one the runner is still running after a controller restart. */
export function startWake(deps: WakeDeps, agentName: string, trigger: WakeTrigger, existing?: WakeRow): WakeHandle {
  const now = deps.now ?? Date.now;
  const { repo, cfg, host, world } = deps;
  const env = deps.env ?? process.env;
  const a = repo.agent(agentName);
  const adapter = (deps.adapterFor ?? getAdapter)(a.harness);
  const agentCfg = cfg.agents.find((x) => x.name === a.name);
  const rawDir = agentDirs(repo.runId, a.name).raw;
  const seq = existing ? existing.seq : a.wake_count + 1;
  const startedAt = existing ? existing.started_at : now();
  const previous = repo.finishedWakes(a.name);
  /** Earlier wakes of the agent in the world, earlier runs included (a session can continue across runs). */
  const sessionHistory = repo.worldWakes(a.name);
  const containerName = existing?.container_name ?? `slopswarm-${repo.runId}-${a.name}-${seq}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const rawLog = existing?.raw_log_path ?? join(rawDir, `${String(seq).padStart(4, "0")}.jsonl`);
  const live = worldAgentDirs(world, a.name).live;

  let wakeId: number;
  if (existing) wakeId = existing.id;
  else {
    repo.updateAgent(a.name, { status: "waking", next_wake_at: null, next_trigger: null });
    wakeId = repo.startWake({
      agent: a.name,
      seq,
      trigger,
      started_at: startedAt,
      slept_ms: a.last_wake_end !== null ? startedAt - a.last_wake_end : null,
      resumed: 0,
      msgs_in: 0,
      raw_log_path: rawLog,
      container_name: containerName,
    });
  }

  let abortReason: WakeExitReason | null = null;
  /** The controller is going away: stop following, leave the wake to the next controller. */
  let detached = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  /** The runner has the kill (it kills a wake that isn't up yet as soon as it is). */
  let killSent = false;
  let lastKillTry = 0;
  let started = false;
  const sendKill = () => {
    lastKillTry = now();
    host.kill(containerName).then(
      () => (killSent = true),
      (err) => repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "kill", detail: short(String(err)), ok: 0 }),
    );
  };
  const kill = (reason: WakeExitReason) => {
    if (abortReason) return;
    abortReason = reason;
    repo.lifecycle("wake_kill", reason, a.name, wakeId);
    // Before the wake is started there is nothing to kill; abortReason keeps it from starting.
    if (started) sendKill();
  };
  let stop = wakeStopAt(startedAt, cfg.budgets.perWake.timeoutMs, deps.runDeadline, cfg.run.worldEndGraceMs);
  let armed = false;
  const arm = () => {
    clearTimeout(timeout);
    armed = true;
    timeout = setTimeout(() => kill(stop.atWorldEnd ? "world_end" : "timeout"), Math.max(0, stop.at - now()));
  };
  const disarm = () => {
    armed = false;
    clearTimeout(timeout);
  };
  const setWorldEnd = (deadline: number) => {
    stop = wakeStopAt(startedAt, cfg.budgets.perWake.timeoutMs, deadline, cfg.run.worldEndGraceMs);
    if (armed && !abortReason) arm();
  };

  /** Unread forge notifications (only those updated after `since`, if given). A forge error counts as none. */
  const unreadOf = async (since?: number): Promise<number> => {
    try {
      return await deps.forge.unread(a.name, since);
    } catch (err) {
      repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "forge", detail: short(String(err)), ok: 0 });
      return 0;
    }
  };

  // The world's relay (src/search.ts): web search for `search: relay` agents, web fetch for every agent when the
  // world has `webfetch:` (src/webfetch.ts). A token for this wake only, revoked when it ends.
  const searchRelay = cfg.agents.some((c) => c.name === a.name && usesRelay(c));
  const relay = searchRelay || !!cfg.webfetch;
  const relayLog = worldDirs(world).relayLog;
  /** Bring the controller's copy of the relay's search log up to date (best effort). */
  const syncRelayLog = async () => {
    if (!searchRelay) return;
    try {
      await mirrorFile(host, { world, relay: "search" }, relayLog);
    } catch {
      /* the next refresh retries */
    }
  };
  /** This wake's relay searches as request rows (no tokens, one web search each, priced from the run's snapshot). */
  const searches = () => (searchRelay ? searchRows(deps.pricing, readSearchLog(relayLog, wakeId)) : { rows: [], total: 0 });
  const nwRef = { world, agent: a.name, area: "home" as const, path: "next_wake.yaml" };
  const codexAuth = codexAgentAuthPath(deps.codexAuthPath, world, a.name);

  /** Everything the agent's dirs need before the wake: /self, logins, tokens, the system prompt, secrets. */
  const prepare = async (o: { resumed: boolean; unread: number; limitUsd: number }) => {
    const files: HostFile[] = [];
    // The agent sees only its own models' prices; costing above keeps the full table.
    for (const f of selfFiles(a.budget_usd, previous, deps.pricingYaml, [...repo.agentModels(a.name), ...(searchRelay ? [SEARCH_MODEL] : [])])) files.push(textFile("self", f.path, f.content));

    if (a.harness === "codex") {
      if (!existsSync(codexAuth)) {
        if (!existsSync(deps.codexAuthPath)) throw new Error(`codex auth missing: ${deps.codexAuthPath}`);
        mkdirSync(dirname(codexAuth), { recursive: true, mode: 0o700 });
        copyFileSync(deps.codexAuthPath, codexAuth);
        chmodSync(codexAuth, 0o600);
      }
      // The agent host keeps the copy Codex rotates; this one only seeds a host that has none (a new VM).
      files.push({ area: "runtime", path: "auth.json", content: readFileSync(codexAuth).toString("base64"), mode: 0o600, ifMissing: true });
    }

    const token = (deps.forgeToken ?? ((n: string) => forgeToken(world, n)))(a.name);
    if (!token) throw new Error(`no forge login for ${a.name} in world ${world} (provision the forge first)`);
    for (const f of agentLoginFiles(world, a.name, token, { publicUrl: deps.forgePublicUrl })) files.push(textFile("runtime", f.path, f.content, f.mode));

    const remove: string[] = [];
    if (cfg.github) {
      const gh = (deps.githubToken ?? githubTokenFromEnv)();
      if (!gh) throw new Error(`github token missing: ${GITHUB_TOKEN_ENV} is not set in .env`);
      for (const f of githubLoginFiles(cfg.github.user, gh)) files.push(textFile("runtime", f.path, f.content, f.mode));
    } else remove.push("github");

    let relayToken: { hash: string; wake: number; search: boolean } | undefined;
    if (relay) {
      const t = newRelayToken();
      files.push(textFile("runtime", RELAY_TOKEN_FILE, t.token + "\n", 0o600));
      relayToken = { hash: t.hash, wake: wakeId, search: searchRelay };
    } else remove.push("search");

    const models = a.harness === "pi" ? deps.piModels?.(a.name) : undefined;
    if (models !== undefined) files.push(textFile("runtime", `${PI_AGENT_SUBDIR}/models.json`, JSON.stringify(models, null, 2) + "\n"));

    // Lean harness: the filled seed is the whole system prompt; the user turn is the wake note. Every harness
    // gets it (claude --system-prompt, codex model_instructions_file, pi --system-prompt), web tool lines included.
    const seed =
      fillSeed(deps.seed, { name: a.name, forgeUrl: forgeUrl(world), maxSleepMs: cfg.scheduler.maxSleepMs, github: cfg.github }) +
      (searchRelay ? SEARCH_PROMPT_LINE : "") +
      (cfg.webfetch ? webfetchPromptBlock(cfg.webfetch) : "");
    files.push(textFile("runtime", SYSTEM_PROMPT_FILE, seed));

    const secrets = secretValues(agentCfg ?? { harness: a.harness, provider: "native" }, env);
    await host.prepare(world, a.name, { files, remove, env: secrets, relayToken });

    const argv = adapter.buildCommand({
      prompt: wakeNote({
        now: startedAt,
        wakeSeq: seq,
        trigger,
        resumed: o.resumed,
        unread: o.unread,
        budgetUsd: a.budget_usd,
        spentUsd: a.spent_usd,
        wakeLimitUsd: o.limitUsd,
        maxTurns: cfg.budgets.perWake.maxTurns,
        stopsAt: stop.at,
        brief: seq === 1 ? (deps.brief ?? undefined) : undefined,
      }),
      systemPrompt: { text: seed, file: `${MOUNTS.runtime}/${SYSTEM_PROMPT_FILE}` },
      model: a.model,
      effort: a.effort as "low" | "medium" | "high",
      maxTurns: cfg.budgets.perWake.maxTurns,
      resumeSessionId: o.resumed ? (a.last_session_id ?? undefined) : undefined,
      // On the relay the harness's own search tool is off, so the agent doesn't have both.
      nativeSearch: !searchRelay,
    });
    return {
      argv,
      env: { ...adapter.containerEnv(MOUNTS.runtime), ...forgeEnv(world), ...(cfg.github ? githubEnv() : {}), ...(relay ? searchEnv(world) : {}), ...browsercheckEnv(cfg.browsercheck, a.harness) },
      secretEnv: Object.keys(secrets),
      noProxy: [forgeHost(world), ...(relay ? [searchHost(world)] : [])],
    };
  };

  const done = (async (): Promise<WakeOutcome> => {
    let unread: number;
    let resumeId: string | undefined;
    if (existing) {
      unread = existing.msgs_in;
      resumeId = existing.resumed ? (existing.session_id ?? a.last_session_id ?? undefined) : undefined;
    } else {
      unread = await unreadOf();
      repo.updateWake(wakeId, { msgs_in: unread });
      // The agent asked to continue its session (plan §4.4).
      resumeId = a.continue_next && a.last_session_id ? a.last_session_id : undefined;
      repo.updateWake(wakeId, { resumed: resumeId !== undefined ? 1 : 0 });
    }
    const resumed = resumeId !== undefined;
    const previousLines = resumed ? previousSessionLines(sessionHistory, resumeId) : undefined;

    const swarmRemaining = Math.max(0, deps.swarmBudgetUsd - repo.swarmSpent());
    const limit = wakeLimit(cfg.budgets.perWake.maxUsd, agentRemaining(a), swarmRemaining);

    // Only a next_wake.yaml written (or rewritten) during this wake counts. A re-followed wake can't know the
    // mtime before it, so there the file counts if it changed after the wake started.
    const nwBefore = existing ? undefined : (await host.stat(nwRef))?.mtimeMs;

    let status: WakeStatus | null = null;
    if (!existing) {
      const spec = await prepare({ resumed, unread, limitUsd: limit.usd });
      if (!abortReason) {
        try {
          status = await host.startWake({
            id: containerName,
            world,
            run: repo.runId,
            agent: a.name,
            wakeId,
            image: deps.image,
            env: spec.env,
            secretEnv: spec.secretEnv,
            argv: spec.argv,
            noProxy: spec.noProxy,
            hardTimeoutMs: cfg.budgets.perWake.timeoutMs + (deps.hardTimeoutSlackMs ?? DEFAULT_HARD_TIMEOUT_SLACK_MS),
          });
        } catch (err) {
          // The runner refused it: nothing runs. Anything else (unreachable, a lost response) may have started the
          // container: follow it like any wake (the loop below gives up past the hard timeout; a runner that never got
          // the start reports no such wake, and the wake ends as an error).
          if (err instanceof RunnerError && err.status >= 400 && err.status < 500) throw err;
          repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "runner", detail: `start not confirmed, following the wake anyway: ${short(String(err))}`, ok: 0 });
        }
        started = true;
        repo.lifecycle("wake_start", `${trigger}${resumed ? " (resumed)" : ""}`, a.name, wakeId);
      }
    } else {
      started = true;
      repo.lifecycle("wake_refollow", "controller restart: following the running wake", a.name, wakeId);
    }

    /**
     * OpenRouter's charged cost and serving provider per request, beside ours (which stays authoritative). The
     * wake's vendor-reported cost is set only when every model request resolved. Runs after the wake has released
     * its slot, bounded by VENDOR_CHECK_MS; never fails the wake.
     */
    const crossCheck = async (keyEnv: string, requestIds: string[]) => {
      const ids = requestIds.filter((id) => id.startsWith("gen-"));
      const key = env[keyEnv];
      if (!ids.length || !key) return;
      try {
        const found = await (deps.vendorCosts ?? ((i: string[], k: string) => generationCosts(i, k, { deadlineMs: VENDOR_CHECK_MS })))(ids, key);
        repo.setVendorCosts(wakeId, found);
        if (ids.length === requestIds.length && found.size === ids.length)
          repo.updateWake(wakeId, { reported_cost_usd: [...found.values()].reduce((s, v) => s + v.costUsd, 0) });
        if (found.size < ids.length) repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "openrouter_cost", detail: `${ids.length - found.size} of ${ids.length} generation(s) not found`, ok: 0 });
      } catch (err) {
        try {
          repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "openrouter_cost", detail: short(String(err)), ok: 0 });
        } catch {
          /* the run may have closed its database meanwhile */
        }
      }
    };

    // Live streaming + costing.
    const parser = adapter.newParser({ model: a.model });
    const streamed = new Map<string, RequestUsage>();
    const stdoutLines: string[] = [];
    let sessionId: string | undefined = resumeId;
    let turnEnd: Extract<AgentEvent, { kind: "turn_end" }> | undefined;
    let toolCalls = 0;
    let liveUsage: RequestUsage[] = [];
    let lastPersist = 0;

    const billed = repo.billedRequestIds(a.name, wakeId);
    /** Usage from the controller's mirror of the session files (the agent host's runtime dir, session subdir only). */
    const finalize = () =>
      adapter.finalizeUsage({ runtimeDir: live, sessionId, streamed: [...streamed.values()], stdoutLines, wakeStartedAt: startedAt, billedRequestIds: billed, previousWakeStdoutLines: previousLines });
    const mirror = async () => {
      if (sessionId) await mirrorSessionFiles(host, { world, agent: a.name, sessionDir: adapter.sessionDir, sessionId, liveDir: live });
    };

    const evaluate = (force = false) => {
      const usages = liveUsage.length >= streamed.size ? liveUsage : [...streamed.values()];
      const llm = costAll(deps.pricing, usages);
      const s = searches();
      const rows = [...llm.rows, ...s.rows];
      const total = llm.total + s.total;
      const reason = overLimit(total, limit);
      if (reason) kill(reason);
      if (force || now() - lastPersist > 2_000) {
        repo.replaceRequests(wakeId, a.name, rows);
        repo.updateWake(wakeId, { cost_usd: total, requests: llm.rows.length, tool_calls: toolCalls, session_id: sessionId ?? null });
        lastPersist = now();
      }
    };
    /**
     * Re-read the authoritative usage (session transcript / rollout, mirrored from the agent host) and re-evaluate.
     * Streamed values are partial (Claude) or thread-cumulative (Codex), so the session file is preferred as soon as it exists.
     */
    let refreshing: Promise<void> | null = null;
    const refresh = (force: boolean): Promise<void> => {
      if (refreshing) return refreshing;
      refreshing = (async () => {
        try {
          await mirror();
          await syncRelayLog();
          if (sessionId) liveUsage = await finalize();
        } catch {
          /* best effort; evaluate falls back to streamed */
        }
        try {
          evaluate(force);
        } catch (err) {
          repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "costing", detail: short(String(err)), ok: 0 });
        }
      })().finally(() => (refreshing = null));
      return refreshing;
    };

    const onEvent = (e: AgentEvent) => {
      switch (e.kind) {
        case "session":
          sessionId = e.sessionId;
          repo.event({ agent: a.name, wake_id: wakeId, kind: "lifecycle", name: "session", detail: short(JSON.stringify({ id: e.sessionId, ...e.info })), ok: null });
          break;
        case "usage":
          streamed.set(e.usage.requestId, e.usage);
          void refresh(false);
          break;
        case "tool_call":
          toolCalls++;
          repo.event({ agent: a.name, wake_id: wakeId, kind: "tool_call", name: e.name, detail: short(e.args), ok: null });
          // Codex has no --max-turns flag; enforce the limit on tool calls (plan §6).
          if (adapter.maxTurnsBy === "tool_calls" && toolCalls > cfg.budgets.perWake.maxTurns) kill("max_turns");
          break;
        case "turn_start":
          // pi has none either; it reports each assistant turn.
          if (adapter.maxTurnsBy === "turns" && e.n > cfg.budgets.perWake.maxTurns) kill("max_turns");
          break;
        case "tool_result":
          if (!e.ok) repo.event({ agent: a.name, wake_id: wakeId, kind: "tool_result", name: e.id, detail: short(e.summary), ok: 0 });
          break;
        case "turn_end":
          turnEnd = e;
          break;
      }
    };

    // A re-followed wake reads its output from the start again, into a new transcript that replaces the saved one
    // only once the whole output came through: the saved one stays the evidence while the runner can't be reached.
    mkdirSync(dirname(rawLog), { recursive: true });
    const outPath = existing ? `${rawLog}.refollow` : rawLog;
    const out = createWriteStream(outPath, { flags: "w" });
    let gaveUp = false;
    const decoder = new TextDecoder();
    let buf = "";
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      out.write(line + "\n");
      stdoutLines.push(line);
      for (const e of parser.push(line)) onEvent(e);
    };
    const feed = (chunk: Uint8Array) => {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    };

    if (started) {
      arm();
      // Codex streams usage only at turn end; its rollout file has per-request usage as it happens.
      poll = setInterval(() => void refresh(true), deps.livePollMs ?? LIVE_POLL_MS);
      // An abort that came while the wake was being prepared: the runner kills it once it is up.
      if (abortReason) sendKill();
      let offset = 0;
      let unreachableSince: number | null = null;
      const giveUpAt = startedAt + cfg.budgets.perWake.timeoutMs + (deps.hardTimeoutSlackMs ?? DEFAULT_HARD_TIMEOUT_SLACK_MS) + UNREACHABLE_GRACE_MS;
      for (;;) {
        if (detached) break;
        try {
          if (abortReason && !killSent && now() - lastKillTry > KILL_RETRY_MS) sendKill();
          const r = await host.read({ wake: containerName, file: "stdout" }, offset);
          unreachableSince = null;
          if (r && r.data.length) {
            offset += r.data.length;
            feed(r.data);
            continue;
          }
          status = await host.wakeStatus(containerName);
          if (!status || status.state === "exited") {
            // Whatever came between the read and the status.
            const last = await host.read({ wake: containerName, file: "stdout" }, offset);
            if (last?.data.length) {
              offset += last.data.length;
              feed(last.data);
              continue;
            }
            break;
          }
        } catch (err) {
          if (unreachableSince === null) {
            unreachableSince = now();
            repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "runner", detail: short(String(err)), ok: 0 });
          }
          if (now() > giveUpAt) {
            repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "runner", detail: "runner unreachable past the wake's hard timeout: giving the wake up", ok: 0 });
            status = null;
            gaveUp = true;
            break;
          }
        }
        await Bun.sleep(deps.outputPollMs ?? OUTPUT_POLL_MS);
      }
      buf += decoder.decode();
      handleLine(buf);
    }
    if (detached) {
      disarm();
      clearInterval(poll);
      if (refreshing) await refreshing;
      await new Promise<void>((r) => out.end(r));
      if (existing) rmSync(outPath, { force: true });
      return { wakeId, exitReason: "stopped" as WakeExitReason, costUsd: 0, ran: false, detached: true };
    }
    const exitCode = status?.exitCode ?? -1;
    if (status?.error) repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "runner", detail: short(status.error, 500), ok: 0 });
    disarm();
    clearInterval(poll);
    if (refreshing) await refreshing;
    await new Promise<void>((r) => out.end(r));
    if (existing) {
      if (gaveUp && existsSync(rawLog)) {
        // The runner was lost before the output came through again: bill from the saved transcript.
        rmSync(outPath, { force: true });
        const saved = adapter.newParser({ model: a.model });
        stdoutLines.length = 0;
        streamed.clear();
        for (const line of readFileSync(rawLog, "utf8").split("\n")) {
          if (!line.trim()) continue;
          stdoutLines.push(line);
          for (const e of saved.push(line)) {
            if (e.kind === "session") sessionId = e.sessionId;
            else if (e.kind === "usage") streamed.set(e.usage.requestId, e.usage);
            else if (e.kind === "turn_end") turnEnd = e;
          }
        }
      } else renameSync(outPath, rawLog);
    }

    // Authoritative usage. A last mirror is best effort: when the runner can't be reached now, the session files
    // mirrored during the wake are still read (an interrupted Codex wake has no streamed totals at all).
    try {
      await mirror();
    } catch (err) {
      repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "mirror", detail: `final mirror failed, billing from the copy so far: ${short(String(err))}`, ok: 0 });
    }
    let finalUsage: RequestUsage[];
    try {
      finalUsage = await finalize();
    } catch (err) {
      repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "finalize_usage", detail: short(String(err)), ok: 0 });
      finalUsage = [...streamed.values()];
    }
    // The token stops working first, so no search lands after the wake's searches are billed.
    if (relay) await host.revokeRelayToken(world, wakeId).catch((err) => repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "relay", detail: short(String(err)), ok: 0 }));
    await syncRelayLog();
    if (cfg.webfetch) await mirrorFile(host, { world, relay: "fetch" }, worldDirs(world).fetchLog).catch(() => {});
    const llm = costAll(deps.pricing, finalUsage);
    const searched = searches();
    const rows = [...llm.rows, ...searched.rows];
    const total = llm.total + searched.total;
    repo.replaceRequests(wakeId, a.name, rows);

    // A "completed" wake with no billed request means the CLI never reached the model (e.g. bad auth).
    const exitReason: WakeExitReason =
      abortReason ??
      (turnEnd?.reason === "max_turns" ? "max_turns" : turnEnd?.reason === "completed" && exitCode === 0 && llm.rows.length > 0 ? "completed" : "error");
    const endedAt = now();

    // Vendor-reported cost, as this wake's share when the CLI reports it cumulatively over a resumed session.
    let reportedCost = turnEnd?.reportedCostUsd ?? null;
    if (reportedCost !== null && adapter.reportedCostIsCumulative && previousLines) {
      const before = reportedCostOf(adapter, a.model, previousLines);
      if (before !== undefined) reportedCost = Math.max(0, reportedCost - before);
    }

    // Files from the agent host: next_wake.yaml, stderr, the rotated Codex login.
    let nwText: string | undefined;
    try {
      const nw = await host.stat(nwRef);
      const changed = nw?.kind === "file" && (existing ? nw.mtimeMs >= startedAt : nw.mtimeMs !== nwBefore);
      if (changed) nwText = new TextDecoder().decode((await host.read(nwRef, 0, NEXT_WAKE_MAX))?.data ?? new Uint8Array());
    } catch (err) {
      repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "next_wake.yaml", detail: short(String(err)), ok: 0 });
    }
    const req = parseNextWake(nwText);
    if (req?.error) repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "next_wake.yaml", detail: short(req.error), ok: 0 });
    if (started) {
      try {
        const err = await host.read({ wake: containerName, file: "stderr" }, 0, STDERR_MAX);
        if (err?.data.length) writeFileSync(rawLog.replace(/\.jsonl$/, ".stderr.log"), err.data);
      } catch {
        /* stderr is a debugging aid */
      }
    }
    if (a.harness === "codex" && started) {
      try {
        const auth = await host.read({ world, agent: a.name, area: "runtime", path: "auth.json" });
        if (auth?.data.length) {
          writeFileSync(codexAuth, auth.data, { mode: 0o600 });
          chmodSync(codexAuth, 0o600);
        }
      } catch (err) {
        repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "codex_auth", detail: short(String(err)), ok: 0 });
      }
    }
    if (status?.timings) {
      const t = status.timings;
      repo.event({
        agent: a.name, wake_id: wakeId, kind: "lifecycle", name: "timings",
        detail: JSON.stringify({ image_check_ms: t.imageCheckMs ?? null, container_start_ms: t.containerStartMs ?? null, run_ms: t.runMs ?? null }),
        ok: null,
      });
    }

    const sum = (f: (u: RequestUsage) => number) => rows.reduce((s, r) => s + f(r.u), 0);
    repo.updateWake(wakeId, {
      ended_at: endedAt,
      exit_reason: exitReason,
      exit_code: exitCode,
      turns: turnEnd?.numTurns ?? null,
      session_id: sessionId ?? null,
      cost_usd: total,
      reported_cost_usd: reportedCost,
      requests: llm.rows.length,
      fresh_input: sum((u) => u.freshInput),
      cache_read: sum((u) => u.cacheRead),
      cache_write_5m: sum((u) => u.cacheWrite5m),
      cache_write_1h: sum((u) => u.cacheWrite1h),
      output: sum((u) => u.output),
      reasoning: sum((u) => u.reasoning),
      web_searches: sum((u) => u.webSearches),
      tool_calls: toolCalls,
      home_bytes: status?.homeBytes ?? null,
      next_in_minutes: req?.inMinutes ?? null,
      continue_requested: req ? (req.continueSession ? 1 : 0) : null,
    });
    if (started) await host.release(containerName).catch(() => {});

    // Agent state + schedule.
    const fresh = repo.agent(a.name);
    const spent = fresh.spent_usd + total;
    const failed = exitReason === "error";
    const failures = failed ? fresh.consecutive_failures + 1 : 0;
    let plan = planNextWake(endedAt, req, cfg.scheduler);
    if (failed) plan = { at: endedAt + RETRY_AFTER_MS, trigger: "timer" };
    let agentStatus: "sleeping" | "depleted" | "failed" | "paused" = fresh.status === "paused" ? "paused" : "sleeping";
    if (isDepleted({ budget_usd: fresh.budget_usd, spent_usd: spent })) agentStatus = "depleted";
    else if (failures >= MAX_CONSECUTIVE_FAILURES) agentStatus = "failed";
    let nextAt: number | null = agentStatus === "sleeping" || agentStatus === "paused" ? plan.at : null;
    let nextTrigger: string | null = nextAt !== null ? plan.trigger : null;
    // Notifications that arrived during this wake and are still unread pull the next wake earlier.
    if (nextAt !== null && (await unreadOf(startedAt)) > 0) {
      const pulled = messagePull(endedAt, { next_wake_at: nextAt });
      if (pulled !== null) {
        nextAt = pulled;
        nextTrigger = "message";
      }
    }
    const lastSession = sessionId ?? fresh.last_session_id;
    const continueNext = req?.continueSession && !failed ? 1 : 0;
    repo.updateAgent(a.name, {
      status: agentStatus,
      spent_usd: spent,
      wake_count: seq,
      last_session_id: lastSession,
      last_wake_end: endedAt,
      continue_next: continueNext,
      consecutive_failures: failures,
      next_wake_at: nextAt,
      next_trigger: nextTrigger,
    });
    repo.updateWorldAgent(world, a.name, { last_session_id: lastSession, continue_next: continueNext });
    repo.lifecycle("wake_end", `${exitReason}, $${total.toFixed(4)}${agentStatus !== "sleeping" ? `, now ${agentStatus}` : ""}`, a.name, wakeId);
    // Model requests only: relay searches have no generation to look up.
    const vendorCheck = agentCfg?.provider === "openrouter" && agentCfg.keyEnv ? crossCheck(agentCfg.keyEnv, llm.rows.map((r) => r.u.requestId)) : undefined;
    return { wakeId, exitReason, costUsd: total, vendorCheck, ran: started };
  })().catch(async (err) => {
    disarm();
    clearInterval(poll);
    if (relay) await host.revokeRelayToken(world, wakeId).catch(() => {});
    if (started) await host.kill(containerName).catch(() => {});
    repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "wake", detail: short(String(err?.stack ?? err), 500), ok: 0 });
    const endedAt = now();
    repo.updateWake(wakeId, { ended_at: endedAt, exit_reason: "error" });
    const fresh = repo.agent(a.name);
    const failures = fresh.consecutive_failures + 1;
    repo.updateAgent(a.name, {
      status: failures >= MAX_CONSECUTIVE_FAILURES ? "failed" : fresh.status === "paused" ? "paused" : "sleeping",
      wake_count: seq,
      last_wake_end: endedAt,
      consecutive_failures: failures,
      next_wake_at: endedAt + RETRY_AFTER_MS,
      next_trigger: "timer",
    });
    return { wakeId, exitReason: "error" as WakeExitReason, costUsd: 0, ran: started };
  });

  return {
    agent: a.name,
    wakeId,
    done,
    abort: kill,
    setWorldEnd,
    detach: () => {
      detached = true;
      disarm();
    },
  };
}
