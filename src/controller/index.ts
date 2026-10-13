// The controller loop: consumes controls, enforces run limits, pulls wakes on forge notifications,
// starts due wakes (plan §4.5, §5, §6) on the agent host through its runner, and pulls each agent's home to the
// VPS copy after its wake (docs/plans/2026-10-12-hosted-control-plane.md §2.6).
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SwarmConfig } from "../config.ts";
import { getRun, runDir, worldAgentDirs, worldDirs, worldOf, type RunRow, type WakeRow } from "../db/index.ts";
import type { ForgeApi } from "../forge.ts";
import type { AgentHost } from "../host/agent-host.ts";
import { createLogger, type Logger } from "../log.ts";
import { parsePricing, type PricingTable } from "../pricing/index.ts";
import { getAdapter } from "../harnesses/index.ts";
import { readSearchLog, searchRows } from "../search.ts";
import type { RequestUsage } from "../types.ts";
import { describeExtension, extraSwarmUsd, parseExtendDetail } from "../world.ts";
import { DEPLETED_EPSILON_USD, isDepleted } from "./budget.ts";
import { mirrorFile, pullHome } from "./host-files.ts";
import { Repo } from "./repo.ts";
import { messagePull, parseNextWake, pickDue, planNextWake } from "./scheduler.ts";
import { costAll, previousSessionLines, RETRY_AFTER_MS, runPiModelsPath, startWake, type WakeDeps, type WakeHandle } from "./wake.ts";

/** File secrets (the master Codex login, each agent's copy): SLOPSWARM_SECRETS_DIR, default secrets/ in the checkout. */
export const SECRETS_DIR = process.env.SLOPSWARM_SECRETS_DIR?.trim() || join(import.meta.dir, "..", "..", "secrets");
export const CODEX_AUTH_PATH = join(SECRETS_DIR, "codex", "auth.json");
/** How often the controller tells the runner it is alive (its watchdog kills wakes after host.yaml runner.watchdog_s). */
const PING_MS = 30_000;

export interface ControllerOptions {
  /** The world's forge (started by the launcher; a fake in tests). */
  forge: ForgeApi;
  /** The agent host's runner. */
  host: AgentHost;
  /** Agent image reference, as the runner knows it. */
  image: string;
  log?: (msg: string) => void;
  /** Structured log (src/log.ts); default: the human `log` only. */
  logger?: Logger;
  /** Overrides for tests. */
  wakeDeps?: Partial<WakeDeps>;
  /** Home sync warning threshold (host.yaml runner.home_warn_mb). */
  homeWarnBytes?: number;
  now?: () => number;
}

export class Controller {
  readonly repo: Repo;
  /** Re-read after an extension moves the deadline. */
  private run: RunRow;
  /** The effective swarm budget: config plus extensions. */
  private swarmUsd: number;
  private readonly pricing: PricingTable;
  private readonly running = new Map<string, WakeHandle>();
  /** OpenRouter cost cross-checks still running after their wakes ended (they hold no scheduler slot). */
  private readonly vendorChecks = new Set<Promise<void>>();
  /** Home pulls after a wake, by agent: they hold no slot, but the agent's next wake waits for its pull. */
  private readonly pulls = new Map<string, Promise<void>>();
  private lastPing = -Infinity;
  private readonly pauseAfterWake = new Set<string>();
  private stopping = false;
  private killed = false;
  /** Shutting down for a deploy: the loop ends, the run stays running, wakes are left to the next controller. */
  private detached = false;
  private wakeup: (() => void) | null = null;
  private polling: Promise<void> | null = null;
  private lastPoll = -Infinity;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;

  readonly world: string;
  private readonly logger: Logger;

  constructor(readonly db: Database, runId: string, readonly cfg: SwarmConfig, private readonly opts: ControllerOptions) {
    const run = getRun(db, runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    this.run = run;
    this.world = worldOf(run);
    this.repo = new Repo(db, runId);
    this.swarmUsd = cfg.budgets.swarmUsd + extraSwarmUsd(db, runId);
    // The run uses the pricing + seed frozen at creation, not whatever is on disk now.
    this.pricing = parsePricing(run.pricing_yaml);
    this.now = opts.now ?? Date.now;
    this.logger = (opts.logger ?? createLogger("controller", { console: opts.log ? (l) => opts.log!(l.replace(/^\[[\d:]+\] /, "")) : undefined })).with({ world: this.world, run: runId });
    this.log = (m) => this.logger.info(m);
  }

  private deps(): WakeDeps {
    return {
      repo: this.repo,
      cfg: this.cfg,
      pricing: this.pricing,
      pricingYaml: this.run.pricing_yaml,
      seed: this.run.seed_text,
      runDeadline: this.run.deadline_at,
      runStartedAt: this.run.started_at,
      swarmBudgetUsd: this.swarmUsd,
      image: this.opts.image,
      host: this.opts.host,
      world: this.world,
      brief: this.run.brief,
      codexAuthPath: CODEX_AUTH_PATH,
      forge: this.opts.forge,
      piModels: (agent) => {
        const p = runPiModelsPath(runDir(this.run.id), agent);
        return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
      },
      now: this.now,
      ...this.opts.wakeDeps,
    };
  }

  /** Pull the agent's home to the VPS copy (a `home_sync` event); never during its wake. */
  private pullAfterWake(agent: string): void {
    const t0 = this.now();
    const p = pullHome(this.opts.host, this.db, { world: this.world, agent, warnBytes: this.opts.homeWarnBytes })
      .then((r) => {
        for (const w of r.warnings) this.repo.event({ agent, wake_id: null, kind: "error", name: "home_sync", detail: w.slice(0, 300), ok: 0 });
        this.repo.event({ agent, wake_id: null, kind: "lifecycle", name: "home_sync", detail: JSON.stringify({ generation: r.generation, bytes: r.bytes, ms: this.now() - t0 }), ok: 1 });
      })
      .catch((err) => {
        try {
          this.repo.event({ agent, wake_id: null, kind: "error", name: "home_sync", detail: String((err as Error)?.message ?? err).slice(0, 300), ok: 0 });
        } catch {
          /* closed */
        }
      })
      .finally(() => {
        if (this.pulls.get(agent) === p) this.pulls.delete(agent);
        this.wakeup?.();
      });
    this.pulls.set(agent, p);
  }

  /** Graceful stop: no new wakes; running ones finish. */
  requestStop(reason = "stop"): void {
    if (this.stopping) return;
    this.stopping = true;
    this.repo.setRunStatus("stopping", reason);
    this.repo.lifecycle("run_stopping", reason);
    this.log(`stopping (${reason}); waiting for ${this.running.size} running wake(s)`);
    this.wakeup?.();
  }

  /** Emergency: kill every wake container of this world now. */
  async emergencyKill(source = "kill"): Promise<void> {
    this.killed = true;
    this.requestStop(source);
    for (const h of this.running.values()) h.abort("stopped");
    let killed: string[] = [];
    try {
      killed = await this.opts.host.killAll(this.world);
    } catch (err) {
      this.repo.event({ agent: null, wake_id: null, kind: "error", name: "kill", detail: String(err).slice(0, 300), ok: 0 });
    }
    this.repo.lifecycle("run_killed", `${killed.length} container(s)`);
    this.log(`emergency kill: ${killed.length} container(s)`);
  }

  /**
   * Leave the run to the next controller (a deploy, SIGTERM): stop the loop and following wakes, with no more DB
   * writes. The run stays running and its containers keep running on the agent host; the next controller resumes
   * the run and follows them again.
   */
  detach(): void {
    this.detached = true;
    for (const h of this.running.values()) h.detach();
    this.wakeup?.();
  }

  /** Resolves when every running wake (and its home pull) has finished (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.running.size || this.vendorChecks.size || this.pulls.size) {
      await Promise.all([...this.running.values()].map((h) => h.done));
      await Promise.all(this.vendorChecks);
      await Promise.all(this.pulls.values());
    }
  }

  /**
   * After a controller restart (a crash or a deploy): wakes the runner still knows are followed again (running ones
   * keep running); wakes it lost are closed and billed from what the controller has (its transcript copy and session
   * mirror).
   */
  async recover(): Promise<void> {
    for (const w of this.repo.openWakes()) {
      // Only a definitive "unknown" (404) closes the wake; a runner that doesn't answer yet is followed again (the
      // follow loop retries, and gives the wake up only past its hard timeout).
      let known = false;
      try {
        known = !!w.container_name && (await this.opts.host.wakeStatus(w.container_name)) !== null;
      } catch (err) {
        known = !!w.container_name;
        this.repo.event({ agent: w.agent, wake_id: w.id, kind: "error", name: "runner", detail: String(err).slice(0, 300), ok: 0 });
      }
      if (known) {
        this.follow(startWake(this.deps(), w.agent, w.trigger as Parameters<typeof startWake>[2], w), w.seq);
        this.log(`following wake ${w.agent}#${w.seq} again`);
      } else await this.closeLostWake(w);
    }
  }

  /** A wake the runner no longer knows: bill what the controller saw of it and schedule the agent again. */
  private async closeLostWake(w: WakeRow): Promise<void> {
    const a = this.repo.agent(w.agent);
    const adapter = getAdapter(a.harness);
    let usage: RequestUsage[] = [];
    let sessionId = w.session_id ?? undefined;
    try {
      const lines = w.raw_log_path && existsSync(w.raw_log_path) ? readFileSync(w.raw_log_path, "utf8").split("\n").filter(Boolean) : [];
      const parser = adapter.newParser({ model: a.model });
      const streamed = new Map<string, RequestUsage>();
      for (const l of lines)
        for (const e of parser.push(l)) {
          if (e.kind === "usage") streamed.set(e.usage.requestId, e.usage);
          if (e.kind === "session") sessionId = e.sessionId;
        }
      usage = await adapter.finalizeUsage({
        runtimeDir: worldAgentDirs(this.world, a.name).live,
        sessionId,
        streamed: [...streamed.values()],
        stdoutLines: lines,
        wakeStartedAt: w.started_at,
        billedRequestIds: this.repo.billedRequestIds(a.name, w.id),
        previousWakeStdoutLines: w.resumed ? previousSessionLines(this.repo.worldWakes(a.name), sessionId) : undefined,
      });
    } catch {
      /* bill nothing we cannot see */
    }
    const llm = costAll(this.pricing, usage);
    // Relay searches of the wake are billed too; its token stops working.
    await this.opts.host.revokeRelayToken(this.world, w.id).catch(() => {});
    await mirrorFile(this.opts.host, { world: this.world, relay: "search" }, worldDirs(this.world).relayLog).catch(() => {});
    const searched = searchRows(this.pricing, readSearchLog(worldDirs(this.world).relayLog, w.id));
    const rows = [...llm.rows, ...searched.rows];
    const cost = llm.total + searched.total;
    this.repo.replaceRequests(w.id, a.name, rows);
    const endedAt = this.now();
    // Honour a next_wake.yaml written during the wake (the agent finished its turn before the crash).
    let req: ReturnType<typeof parseNextWake>;
    try {
      const ref = { world: this.world, agent: a.name, area: "home" as const, path: "next_wake.yaml" };
      const nw = await this.opts.host.stat(ref);
      if (nw?.kind === "file" && nw.mtimeMs >= w.started_at) req = parseNextWake(new TextDecoder().decode((await this.opts.host.read(ref))?.data ?? new Uint8Array()));
    } catch {
      /* the runner may be gone too */
    }
    const plan = req && !req.error ? planNextWake(endedAt, req, this.cfg.scheduler) : { at: endedAt + RETRY_AFTER_MS, trigger: "timer" };
    this.repo.updateWake(w.id, {
      ended_at: endedAt,
      exit_reason: "error",
      cost_usd: cost,
      requests: llm.rows.length,
      session_id: sessionId ?? null,
      next_in_minutes: req?.inMinutes ?? null,
      continue_requested: req ? (req.continueSession ? 1 : 0) : null,
    });
    this.repo.updateAgent(a.name, {
      status: a.status === "waking" ? "sleeping" : a.status,
      spent_usd: a.spent_usd + cost,
      wake_count: Math.max(a.wake_count, w.seq),
      last_wake_end: endedAt,
      last_session_id: sessionId ?? a.last_session_id,
      continue_next: req?.continueSession && !req.error ? 1 : 0,
      next_wake_at: a.next_wake_at ?? plan.at,
      next_trigger: a.next_trigger ?? plan.trigger,
    });
    this.repo.lifecycle("wake_recovered", `controller restart; billed $${cost.toFixed(4)}`, a.name, w.id);
    this.log(`recovered open wake ${a.name}#${w.seq} ($${cost.toFixed(4)})`);
  }

  private consumeControls(): void {
    for (const c of this.repo.pendingControls()) {
      this.repo.consumeControl(c.id);
      this.repo.event({ agent: c.agent, wake_id: null, kind: "control", name: c.action, detail: c.source, ok: 1 });
      this.log(`control: ${c.action}${c.agent ? ` ${c.agent}` : ""} (${c.source ?? "?"})`);
      if (c.action === "stop") this.requestStop("stop requested");
      else if (c.action === "kill") void this.emergencyKill("kill requested");
      else if (c.action === "extend") this.extend(c.detail, c.source);
      else if (c.agent && (c.action === "pause" || c.action === "unpause" || c.action === "wake")) this.agentControl(c.agent, c.action);
    }
  }

  /**
   * More world time and/or budget (`just extend`). Time counts from the old deadline, or from now if that has
   * passed (the stopped gap isn't world time). Agents aren't told: the world end is hidden from them, and
   * every wake note gives their current budget.
   */
  private extend(json: string | null, source: string | null): void {
    let d;
    try {
      d = parseExtendDetail(json);
    } catch (err) {
      this.repo.event({ agent: null, wake_id: null, kind: "error", name: "extend", detail: String(err).slice(0, 200), ok: 0 });
      return;
    }
    const now = this.now();
    const oldDeadline = this.run.deadline_at;
    const newDeadline = d.timeMs ? Math.max(oldDeadline, now) + d.timeMs : oldDeadline;
    const summary = describeExtension(d);
    this.db.transaction(() => {
      for (const a of this.repo.agents()) {
        const add = (d.agentUsd["*"] ?? 0) + (d.agentUsd[a.name] ?? 0);
        if (!add) continue;
        const budget = a.budget_usd + add;
        // A depleted agent with budget again wakes now. A failed one stays failed (`just wake` revives it).
        const revive = a.status === "depleted" && !isDepleted({ budget_usd: budget, spent_usd: a.spent_usd });
        this.repo.updateAgent(a.name, { budget_usd: budget, ...(revive ? { status: "sleeping", next_wake_at: now, next_trigger: "timer" } : {}) });
      }
      this.repo.addExtension({ ts: now, source, time_ms: d.timeMs, old_deadline: oldDeadline, new_deadline: newDeadline, swarm_usd: d.swarmUsd, agent_usd_json: JSON.stringify(d.agentUsd) });
      this.repo.event({ agent: null, wake_id: null, ts: now, kind: "lifecycle", name: "run_extended", detail: summary, ok: null });
    })();
    this.run = getRun(this.db, this.run.id)!;
    this.swarmUsd = this.cfg.budgets.swarmUsd + extraSwarmUsd(this.db, this.run.id);
    for (const h of this.running.values()) h.setWorldEnd(newDeadline);
    // Draining after the end or a stop: carry on (tick() stops again if the run still can't go on).
    if (this.stopping && !this.killed) {
      this.stopping = false;
      this.repo.reopenRun();
    }
    this.log(`extended: ${summary}; world ends ${new Date(newDeadline).toISOString()}`);
  }

  private agentControl(name: string, action: "pause" | "unpause" | "wake"): void {
    let a;
    try {
      a = this.repo.agent(name);
    } catch {
      return;
    }
    const isRunning = this.running.has(name);
    if (action === "pause") {
      if (isRunning) this.pauseAfterWake.add(name);
      else if (a.status === "active" || a.status === "sleeping") this.repo.updateAgent(name, { status: "paused" });
    } else if (action === "unpause") {
      this.pauseAfterWake.delete(name);
      if (a.status === "paused") this.repo.updateAgent(name, { status: "sleeping", next_wake_at: a.next_wake_at ?? this.now() });
    } else if (action === "wake") {
      if (isRunning || a.status === "depleted") return;
      // Waking a failed agent revives it with a clean failure count.
      this.repo.updateAgent(name, {
        status: "sleeping",
        next_wake_at: this.now(),
        next_trigger: "manual",
        consecutive_failures: a.status === "failed" ? 0 : a.consecutive_failures,
      });
    }
  }

  private onWakeDone(h: WakeHandle, ran: boolean): void {
    this.running.delete(h.agent);
    if (this.detached) return;
    if (ran) this.pullAfterWake(h.agent);
    if (this.pauseAfterWake.delete(h.agent)) {
      const a = this.repo.agent(h.agent);
      if (a.status === "sleeping") this.repo.updateAgent(h.agent, { status: "paused" });
    }
    this.wakeup?.();
  }

  /**
   * Pull the next wake of every sleeping agent that has unread notifications updated since its last
   * wake started (plan §5). Running agents are handled when their wake ends. At most one poll at a time.
   */
  pollForge(): Promise<void> {
    if (this.polling) return this.polling;
    this.lastPoll = this.now();
    const sleeping = (a: { name: string; status: string }) => !this.running.has(a.name) && (a.status === "sleeping" || a.status === "active");
    this.polling = (async () => {
      for (const a of this.repo.agents().filter(sleeping)) {
        let n: number;
        try {
          n = await this.opts.forge.unread(a.name, this.repo.lastWakeStart(a.name) ?? this.run.started_at);
        } catch (err) {
          this.repo.event({ agent: a.name, wake_id: null, kind: "error", name: "forge", detail: String(err).slice(0, 200), ok: 0 });
          continue;
        }
        if (!n) continue;
        const fresh = this.repo.agent(a.name); // may have changed during the await
        if (!sleeping(fresh)) continue;
        const at = messagePull(this.now(), fresh);
        if (at === null) continue;
        this.repo.updateAgent(a.name, { next_wake_at: at, next_trigger: "message" });
        this.repo.lifecycle("forge_pull", `${n} unread`, a.name);
        this.wakeup?.();
      }
    })().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  /** One scheduler step. Returns false when the run is over. */
  tick(): boolean {
    this.consumeControls();
    const now = this.now();
    const swarmSpent = this.repo.swarmSpent();
    const agents = this.repo.agents();
    if (!this.stopping) {
      if (now >= this.run.deadline_at) this.requestStop("max_duration reached");
      else if (this.swarmUsd - swarmSpent < DEPLETED_EPSILON_USD) this.requestStop("swarm budget exhausted");
      else if (agents.every((a) => a.status === "depleted" || a.status === "failed")) this.requestStop("no agent can wake");
    }
    if (this.stopping) {
      if (this.running.size === 0) {
        const final = !this.killed && this.run.deadline_at <= now ? "finished" : "stopped";
        this.repo.setRunStatus(final);
        this.repo.lifecycle(`run_${final}`);
        this.log(`run ${final}; swarm spend $${swarmSpent.toFixed(4)}`);
        return false;
      }
      return true;
    }
    if (now - this.lastPoll >= this.cfg.forge.pollMs) void this.pollForge();
    if (now - this.lastPing >= PING_MS) {
      this.lastPing = now;
      this.opts.host.ping().catch((err) => this.logger.warn(`runner ping failed: ${String(err).slice(0, 200)}`));
    }
    const due = pickDue(
      // An agent whose home is still being pulled waits for it.
      agents.filter((a) => !this.running.has(a.name) && !this.pulls.has(a.name)),
      now,
      this.running.size,
      this.cfg.scheduler.maxConcurrentWakes,
    );
    for (const a of due) {
      const trigger = (a.next_trigger ?? "timer") as Parameters<typeof startWake>[2];
      this.follow(startWake(this.deps(), a.name, trigger), a.wake_count + 1);
      this.log(`wake ${a.name}#${a.wake_count + 1} (${trigger})`);
    }
    return true;
  }

  private follow(h: WakeHandle, seq: number): void {
    this.running.set(h.agent, h);
    void h.done.then((o) => {
      if (o.detached) return void this.running.delete(h.agent);
      this.logger.info(`done ${h.agent}#${seq}: ${o.exitReason}, $${o.costUsd.toFixed(4)}`, { agent: h.agent, wake_id: h.wakeId });
      if (o.vendorCheck) {
        const check = o.vendorCheck.finally(() => this.vendorChecks.delete(check));
        this.vendorChecks.add(check);
      }
      this.onWakeDone(h, o.ran);
    });
  }

  /** Before the first tick: recover from a crash and mark a resumed run running again. Pending controls apply in that tick. */
  async begin(): Promise<void> {
    await this.recover();
    if (this.repo.hasHistory()) {
      this.repo.reopenRun();
      this.run = getRun(this.db, this.run.id)!;
      this.repo.lifecycle("run_resumed");
    }
  }

  /** Run until the run finishes or is stopped. */
  async loop(): Promise<void> {
    await this.begin();
    this.log(`run ${this.run.id}: ${this.cfg.agents.length} agent(s), deadline ${new Date(this.run.deadline_at).toISOString()}`);
    while (!this.detached && this.tick()) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, this.cfg.controller.tickMs);
        this.wakeup = () => {
          clearTimeout(t);
          r();
        };
      });
      this.wakeup = null;
    }
    await this.polling;
    // Shutting down for a deploy: cross-checks and pulls are best effort; the next controller pulls again.
    if (this.detached) return;
    // Bounded (VENDOR_CHECK_MS); their numbers land in the report.
    await Promise.all(this.vendorChecks);
    await Promise.all(this.pulls.values());
  }
}
