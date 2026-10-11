// One wake (plan §4.2): write /self, run the CLI in an ephemeral container, stream + cost every
// request live, kill on budget/timeout, then finalise usage and schedule the next wake.
import { copyFileSync, createWriteStream, existsSync, lstatSync, readdirSync, readFileSync, statSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SwarmConfig } from "../config.ts";
import { agentDirs, type WakeRow } from "../db/index.ts";
import type { AgentConfig } from "../config.ts";
import { dockerProcessEnv, dockerRunArgs, MOUNTS, type ContainerSpec } from "../docker.ts";
import { forgeEnv, forgeHost, forgeUrl, type ForgeApi } from "../forge.ts";
import { githubEnv, writeGithubLogin } from "../github.ts";
import { generationCosts, type VendorCost } from "../openrouter.ts";
import { computeCost, type PricingTable } from "../pricing/index.ts";
import { getAdapter } from "../harnesses/index.ts";
import { issueSearchToken, readSearchLog, revokeSearchToken, runSearchDirs, SEARCH_MODEL, SEARCH_PROMPT_LINE, searchEnv, searchHost, searchRows, usesRelay } from "../search.ts";
import type { AgentEvent, CostBreakdown, RequestUsage, Harness, HarnessAdapter, WakeExitReason, WakeTrigger } from "../types.ts";
import { isDepleted, overLimit, wakeLimit, agentRemaining } from "./budget.ts";
import type { Repo } from "./repo.ts";
import { fillSeed, wakeNote, SYSTEM_PROMPT_FILE } from "./run.ts";
import { messagePull, parseNextWake, planNextWake } from "./scheduler.ts";
import { writeSelf } from "./self-writer.ts";

export const MAX_CONSECUTIVE_FAILURES = 3;
/** A failed wake is retried after this long. */
export const RETRY_AFTER_MS = 60_000;
const LIVE_POLL_MS = 5_000;
const KILL_RETRY_MS = 1_000;
const ARGS_MAX = 200;

export interface ProcessHandle {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}

export interface WakeDeps {
  repo: Repo;
  cfg: SwarmConfig;
  pricing: PricingTable;
  pricingYaml: string;
  seed: string;
  runDeadline: number;
  /** The effective swarm budget (config plus extensions). */
  swarmBudgetUsd: number;
  /** Agent image tag (proxy.ts AGENT_IMAGE). */
  image: string;
  /** Path of the Codex auth file copied into a codex agent's runtime dir if missing. */
  codexAuthPath: string;
  /** Path of the shared GitHub token (github.ts); read each wake when the run has a GitHub outlet. */
  githubTokenPath: string;
  /** The run's forge: unread notification counts (plan §4.5). */
  forge: ForgeApi;
  /** Start `docker run …` with `env` as its environment; injectable for tests. stderr goes to `stderrPath`. */
  startProcess?: (argv: string[], stderrPath: string, env: Record<string, string | undefined>) => ProcessHandle;
  /** Kill the wake's container; injectable for tests. */
  killContainer?: (name: string) => Promise<void>;
  adapterFor?: (harness: Harness) => HarnessAdapter;
  /** OpenRouter's charged cost per generation id (cross-check); injectable for tests. */
  vendorCosts?: (ids: string[], key: string) => Promise<Map<string, VendorCost>>;
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
}

export interface WakeOutcome {
  wakeId: number;
  exitReason: WakeExitReason;
  costUsd: number;
}

function defaultStart(argv: string[], stderrPath: string, env: Record<string, string | undefined>): ProcessHandle {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: Bun.file(stderrPath), stdin: "ignore", env });
  return { stdout: p.stdout, exited: p.exited };
}

async function defaultKill(name: string): Promise<void> {
  await Bun.spawn(["docker", "kill", name], { stdout: "ignore", stderr: "ignore" }).exited;
}

/** Total bytes of regular files under `dir` (symlinks are not followed). */
export function dirBytes(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e);
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) total += st.size;
    }
  };
  walk(dir);
  return total;
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

/**
 * When a wake starting at `startedAt` is stopped if it is still running: after the per-wake timeout, or at
 * the world end plus `graceMs`, whichever comes first (plan §6).
 */
export function wakeStopAt(startedAt: number, timeoutMs: number, worldEnd: number, graceMs: number): { at: number; atWorldEnd: boolean } {
  const byTimeout = startedAt + timeoutMs;
  const byWorldEnd = worldEnd + graceMs;
  return byWorldEnd < byTimeout ? { at: byWorldEnd, atWorldEnd: true } : { at: byTimeout, atWorldEnd: false };
}

export function startWake(deps: WakeDeps, agentName: string, trigger: WakeTrigger): WakeHandle {
  const now = deps.now ?? Date.now;
  const { repo, cfg } = deps;
  const startProcess = deps.startProcess ?? defaultStart;
  const killContainer = deps.killContainer ?? defaultKill;
  const a = repo.agent(agentName);
  const adapter = (deps.adapterFor ?? getAdapter)(a.harness);
  const agentCfg = cfg.agents.find((x) => x.name === a.name);
  const dirs = agentDirs(repo.runId, a.name);
  const seq = a.wake_count + 1;
  const startedAt = now();
  const previous = repo.finishedWakes(a.name);
  const containerName = `slopswarm-${repo.runId}-${a.name}-${seq}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const rawLog = join(dirs.raw, `${String(seq).padStart(4, "0")}.jsonl`);

  repo.updateAgent(a.name, { status: "waking", next_wake_at: null, next_trigger: null });
  const wakeId = repo.startWake({
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

  let abortReason: WakeExitReason | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let killing: Promise<void> | null = null;
  let proc: ProcessHandle | undefined;
  const kill = (reason: WakeExitReason) => {
    if (abortReason) return;
    abortReason = reason;
    repo.lifecycle("wake_kill", reason, a.name, wakeId);
    // `docker kill` is a no-op while `docker run` is still creating the container: retry until the process is gone.
    // Before the process starts there is nothing to kill; abortReason keeps it from starting.
    killing = (async () => {
      for (;;) {
        await killContainer(containerName);
        if (!proc) return;
        const gone = await Promise.race([proc.exited.then(() => true), Bun.sleep(KILL_RETRY_MS).then(() => false)]);
        if (gone) return;
      }
    })();
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

  // Web search through the run's relay (src/search.ts): a token for this wake only, revoked when it ends.
  const relay = cfg.agents.some((c) => c.name === a.name && usesRelay(c)) ? runSearchDirs(repo.runId) : null;
  /** This wake's relay searches as request rows (no tokens, one web search each, priced from the run's snapshot). */
  const searches = () => (relay ? searchRows(deps.pricing, readSearchLog(relay.logFile, wakeId)) : { rows: [], total: 0 });

  const done = (async (): Promise<WakeOutcome> => {
    const unread = await unreadOf();
    repo.updateWake(wakeId, { msgs_in: unread });
    // The agent asked to continue its session (plan §4.4).
    const resumeId = a.continue_next && a.last_session_id ? a.last_session_id : undefined;
    const resumed = resumeId !== undefined;
    repo.updateWake(wakeId, { resumed: resumed ? 1 : 0 });
    const previousLines = resumed ? previousSessionLines(previous, resumeId) : undefined;

    const swarmRemaining = Math.max(0, deps.swarmBudgetUsd - repo.swarmSpent());
    const limit = wakeLimit(cfg.budgets.perWake.maxUsd, agentRemaining(a), swarmRemaining);

    // The agent sees only its own models' prices; costing above keeps the full table.
    writeSelf(dirs.self, a.budget_usd, previous, deps.pricingYaml, [...repo.agentModels(a.name), ...(relay ? [SEARCH_MODEL] : [])]);

    if (a.harness === "codex" && !existsSync(join(dirs.runtime, "auth.json"))) {
      if (!existsSync(deps.codexAuthPath)) throw new Error(`codex auth missing: ${deps.codexAuthPath}`);
      copyFileSync(deps.codexAuthPath, join(dirs.runtime, "auth.json"));
      chmodSync(join(dirs.runtime, "auth.json"), 0o600);
    }

    if (cfg.github) {
      if (!existsSync(deps.githubTokenPath)) throw new Error(`github token missing: ${deps.githubTokenPath}`);
      writeGithubLogin(dirs.runtime, cfg.github.user, readFileSync(deps.githubTokenPath, "utf8").trim());
    }

    if (relay) issueSearchToken(relay, dirs.runtime, a.name, wakeId);

    // Only a next_wake.yaml written (or rewritten) during this wake counts.
    const nwPath = join(dirs.home, "next_wake.yaml");
    const nwBefore = statSync(nwPath, { throwIfNoEntry: false })?.mtimeMs;

    // Lean harness: the filled seed is the whole system prompt; the user turn is the wake note.
    const seed =
      fillSeed(deps.seed, { name: a.name, forgeUrl: forgeUrl(repo.runId), maxSleepMs: cfg.scheduler.maxSleepMs, github: cfg.github }) + (relay ? SEARCH_PROMPT_LINE : "");
    writeFileSync(join(dirs.runtime, SYSTEM_PROMPT_FILE), seed);
    const argv = adapter.buildCommand({
      prompt: wakeNote({
        now: startedAt,
        wakeSeq: seq,
        trigger,
        resumed,
        unread,
        budgetUsd: a.budget_usd,
        spentUsd: a.spent_usd,
        wakeLimitUsd: limit.usd,
        maxTurns: cfg.budgets.perWake.maxTurns,
        stopsAt: stop.at,
      }),
      systemPrompt: { text: seed, file: `${MOUNTS.runtime}/${SYSTEM_PROMPT_FILE}` },
      model: a.model,
      effort: a.effort as "low" | "medium" | "high",
      maxTurns: cfg.budgets.perWake.maxTurns,
      resumeSessionId: resumeId,
      // On the relay the harness's own search tool is off, so the agent doesn't have both.
      nativeSearch: relay === null,
    });
    const spec: ContainerSpec = {
      name: containerName,
      image: deps.image,
      runId: repo.runId,
      agent: a.name,
      mounts: { home: dirs.home, self: dirs.self, runtime: dirs.runtime },
      env: { ...adapter.containerEnv(MOUNTS.runtime), ...forgeEnv(repo.runId), ...(cfg.github ? githubEnv() : {}), ...(relay ? searchEnv(repo.runId) : {}) },
      passEnv: secretEnv(agentCfg ?? { harness: a.harness, provider: "native" }),
      argv,
      network: cfg.network.name,
      proxy: cfg.network.proxy,
      noProxy: [forgeHost(repo.runId), ...(relay ? [searchHost(repo.runId)] : [])],
      limits: cfg.controller.container,
    };
    repo.lifecycle("wake_start", `${trigger}${resumed ? " (resumed)" : ""}`, a.name, wakeId);

    /**
     * OpenRouter's charged cost and serving provider per request, beside ours (which stays authoritative). The
     * wake's vendor-reported cost is set only when every request resolved. Never fails the wake.
     */
    const crossCheck = async (keyEnv: string, requestIds: string[]) => {
      const ids = requestIds.filter((id) => id.startsWith("gen-"));
      const key = process.env[keyEnv];
      if (!ids.length || !key) return;
      try {
        const found = await (deps.vendorCosts ?? ((i: string[], k: string) => generationCosts(i, k)))(ids, key);
        repo.setVendorCosts(wakeId, found);
        if (found.size === requestIds.length) repo.updateWake(wakeId, { reported_cost_usd: [...found.values()].reduce((s, v) => s + v.costUsd, 0) });
        if (found.size < ids.length) repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "openrouter_cost", detail: `${ids.length - found.size} of ${ids.length} generation(s) not found`, ok: 0 });
      } catch (err) {
        repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "openrouter_cost", detail: short(String(err)), ok: 0 });
      }
    };

    // Live streaming + costing.
    const parser = adapter.newParser({ model: a.model });
    const streamed = new Map<string, RequestUsage>();
    const stdoutLines: string[] = [];
    let sessionId: string | undefined = resumeId;
    let turnEnd: Extract<AgentEvent, { kind: "turn_end" }> | undefined;
    let toolCalls = 0;
    let live: RequestUsage[] = [];
    let lastPersist = 0;

    const finalize = () =>
      adapter.finalizeUsage({ runtimeDir: dirs.runtime, sessionId, streamed: [...streamed.values()], stdoutLines, wakeStartedAt: startedAt, previousWakeStdoutLines: previousLines });

    const evaluate = (force = false) => {
      const usages = live.length >= streamed.size ? live : [...streamed.values()];
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
     * Re-read the authoritative usage (session transcript / rollout) and re-evaluate. Streamed values are
     * partial (Claude) or thread-cumulative (Codex), so the session file is preferred as soon as it exists.
     */
    const refresh = async (force: boolean) => {
      if (sessionId) {
        try {
          live = await finalize();
        } catch {
          /* best effort; evaluate falls back to streamed */
        }
      }
      evaluate(force);
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

    // An emergency kill during the setup above must not start a container now.
    if (abortReason) proc = { stdout: new ReadableStream<Uint8Array>({ start: (c) => c.close() }), exited: Promise.resolve(-1) };
    else proc = startProcess(dockerRunArgs(spec), rawLog.replace(/\.jsonl$/, ".stderr.log"), dockerProcessEnv(spec));
    arm();
    // Codex streams usage only at turn end; its rollout file has per-request usage as it happens.
    poll = setInterval(() => void refresh(true), LIVE_POLL_MS);

    const out = createWriteStream(rawLog, { flags: "a" });
    const decoder = new TextDecoder();
    let buf = "";
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      out.write(line + "\n");
      stdoutLines.push(line);
      for (const e of parser.push(line)) onEvent(e);
    };
    try {
      for await (const chunk of proc.stdout) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          handleLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      handleLine(buf);
    } catch (err) {
      repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "stdout", detail: short(String(err)), ok: 0 });
    }
    const exitCode = await proc.exited;
    disarm();
    clearInterval(poll);
    if (killing) await killing;
    await new Promise<void>((r) => out.end(r));

    // Authoritative usage.
    let finalUsage: RequestUsage[];
    try {
      finalUsage = await finalize();
    } catch (err) {
      repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "finalize_usage", detail: short(String(err)), ok: 0 });
      finalUsage = [...streamed.values()];
    }
    // The token stops working first, so no search lands after the wake's searches are billed.
    if (relay) revokeSearchToken(relay, wakeId);
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

    const nwStat = statSync(nwPath, { throwIfNoEntry: false });
    const nwText = nwStat?.isFile() && nwStat.mtimeMs !== nwBefore ? readFileSync(nwPath, "utf8") : undefined;
    const req = parseNextWake(nwText);
    if (req?.error) repo.event({ agent: a.name, wake_id: wakeId, kind: "error", name: "next_wake.yaml", detail: short(req.error), ok: 0 });

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
      home_bytes: dirBytes(dirs.home),
      next_in_minutes: req?.inMinutes ?? null,
      continue_requested: req ? (req.continueSession ? 1 : 0) : null,
    });

    // Agent state + schedule.
    const fresh = repo.agent(a.name);
    const spent = fresh.spent_usd + total;
    const failed = exitReason === "error";
    const failures = failed ? fresh.consecutive_failures + 1 : 0;
    let plan = planNextWake(endedAt, req, cfg.scheduler);
    if (failed) plan = { at: endedAt + RETRY_AFTER_MS, trigger: "timer" };
    let status: "sleeping" | "depleted" | "failed" | "paused" = fresh.status === "paused" ? "paused" : "sleeping";
    if (isDepleted({ budget_usd: fresh.budget_usd, spent_usd: spent })) status = "depleted";
    else if (failures >= MAX_CONSECUTIVE_FAILURES) status = "failed";
    let nextAt: number | null = status === "sleeping" || status === "paused" ? plan.at : null;
    let nextTrigger: string | null = nextAt !== null ? plan.trigger : null;
    // Notifications that arrived during this wake and are still unread pull the next wake earlier.
    if (nextAt !== null && (await unreadOf(startedAt)) > 0) {
      const pulled = messagePull(endedAt, { next_wake_at: nextAt });
      if (pulled !== null) {
        nextAt = pulled;
        nextTrigger = "message";
      }
    }
    repo.updateAgent(a.name, {
      status,
      spent_usd: spent,
      wake_count: seq,
      last_session_id: sessionId ?? fresh.last_session_id,
      last_wake_end: endedAt,
      continue_next: req?.continueSession && !failed ? 1 : 0,
      consecutive_failures: failures,
      next_wake_at: nextAt,
      next_trigger: nextTrigger,
    });
    repo.lifecycle("wake_end", `${exitReason}, $${total.toFixed(4)}${status !== "sleeping" ? `, now ${status}` : ""}`, a.name, wakeId);
    if (agentCfg?.provider === "openrouter" && agentCfg.keyEnv) await crossCheck(agentCfg.keyEnv, rows.map((r) => r.u.requestId));
    return { wakeId, exitReason, costUsd: total };
  })().catch((err) => {
    disarm();
    clearInterval(poll);
    if (relay) revokeSearchToken(relay, wakeId);
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
    return { wakeId, exitReason: "error" as WakeExitReason, costUsd: 0 };
  });

  return { agent: a.name, wakeId, done, abort: kill, setWorldEnd };
}
