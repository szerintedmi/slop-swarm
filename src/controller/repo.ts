// Controller-side DB writes and the reads they depend on.
import type { Database } from "bun:sqlite";
import type { AgentRow, ControlAction, EventRow, ExtensionRow, WakeRow } from "../db/index.ts";
import { priceKey } from "../pricing/index.ts";
import type { CostBreakdown, RequestUsage } from "../types.ts";

export class Repo {
  constructor(readonly db: Database, readonly runId: string) {}

  agents(): AgentRow[] {
    return this.db.query<AgentRow, [string]>("SELECT * FROM agents WHERE run_id = ? ORDER BY rowid").all(this.runId);
  }
  agent(name: string): AgentRow {
    const a = this.db.query<AgentRow, [string, string]>("SELECT * FROM agents WHERE run_id = ? AND name = ?").get(this.runId, name);
    if (!a) throw new Error(`unknown agent ${name}`);
    return a;
  }
  updateAgent(name: string, fields: Partial<Omit<AgentRow, "run_id" | "name">>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const sql = `UPDATE agents SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE run_id = ? AND name = ?`;
    this.db.query(sql).run(...(Object.values(fields) as (string | number | null)[]), this.runId, name);
  }
  swarmSpent(): number {
    return this.db.query<{ s: number }, [string]>("SELECT COALESCE(SUM(spent_usd), 0) AS s FROM agents WHERE run_id = ?").get(this.runId)!.s;
  }

  event(e: Omit<EventRow, "id" | "run_id" | "ts"> & { ts?: number }): void {
    this.db
      .query("INSERT INTO events (run_id, agent, wake_id, ts, kind, name, detail, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.runId, e.agent, e.wake_id, e.ts ?? Date.now(), e.kind, e.name, e.detail, e.ok);
  }
  lifecycle(name: string, detail: string | null = null, agent: string | null = null, wakeId: number | null = null): void {
    this.event({ agent, wake_id: wakeId, kind: "lifecycle", name, detail, ok: null });
  }

  startWake(w: Pick<WakeRow, "agent" | "seq" | "trigger" | "started_at" | "slept_ms" | "resumed" | "msgs_in" | "raw_log_path" | "container_name">): number {
    const r = this.db
      .query(
        `INSERT INTO wakes (run_id, agent, seq, trigger, started_at, slept_ms, resumed, msgs_in, raw_log_path, container_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(this.runId, w.agent, w.seq, w.trigger, w.started_at, w.slept_ms, w.resumed, w.msgs_in, w.raw_log_path, w.container_name);
    return Number(r.lastInsertRowid);
  }
  updateWake(id: number, fields: Partial<Omit<WakeRow, "id" | "run_id">>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db.query(`UPDATE wakes SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...(Object.values(fields) as (string | number | null)[]), id);
  }
  wake(id: number): WakeRow {
    return this.db.query<WakeRow, [number]>("SELECT * FROM wakes WHERE id = ?").get(id)!;
  }
  finishedWakes(agent: string): WakeRow[] {
    return this.db
      .query<WakeRow, [string, string]>("SELECT * FROM wakes WHERE run_id = ? AND agent = ? AND ended_at IS NOT NULL ORDER BY seq")
      .all(this.runId, agent);
  }
  /** The agent's own models (as priced): its configured model plus every model its past requests were billed for. */
  agentModels(agent: string): string[] {
    const billed = this.db
      .query<{ model: string }, [string, string]>("SELECT DISTINCT model FROM requests WHERE run_id = ? AND agent = ? ORDER BY model")
      .all(this.runId, agent)
      .map((r) => r.model);
    // An OpenRouter preset reference is priced as the model before the `@`.
    return [...new Set([priceKey(this.agent(agent).model), ...billed])];
  }
  openWakes(): WakeRow[] {
    return this.db.query<WakeRow, [string]>("SELECT * FROM wakes WHERE run_id = ? AND ended_at IS NULL").all(this.runId);
  }

  /** Replace a wake's request rows with `rows` (provisional during the wake, authoritative after). */
  replaceRequests(wakeId: number, agent: string, rows: { u: RequestUsage; c: CostBreakdown }[]): void {
    const del = this.db.query("DELETE FROM requests WHERE wake_id = ?");
    const ins = this.db.query(
      `INSERT INTO requests (wake_id, run_id, agent, seq, request_id, model, ts, fresh_input, cache_read, cache_write_5m,
         cache_write_1h, output, reasoning, web_searches, prompt_tokens, tier, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      del.run(wakeId);
      rows.forEach(({ u, c }, i) =>
        ins.run(wakeId, this.runId, agent, i + 1, u.requestId, u.model, u.ts ?? null, u.freshInput, u.cacheRead, u.cacheWrite5m,
          u.cacheWrite1h, u.output, u.reasoning, u.webSearches, c.promptTokens, c.tier, c.costUsd),
      );
    })();
  }

  /** Request ids billed to the agent's other wakes (a resumed session file repeats them). */
  billedRequestIds(agent: string, exceptWakeId: number): Set<string> {
    return new Set(
      this.db
        .query<{ request_id: string }, [string, string, number]>("SELECT request_id FROM requests WHERE run_id = ? AND agent = ? AND wake_id != ?")
        .all(this.runId, agent, exceptWakeId)
        .map((r) => r.request_id),
    );
  }

  /** The vendor's charged cost and serving provider for a wake's requests (by request id). */
  setVendorCosts(wakeId: number, costs: Map<string, { costUsd: number; provider: string | null }>): void {
    const q = this.db.query("UPDATE requests SET vendor_cost_usd = ?, vendor_provider = ? WHERE wake_id = ? AND request_id = ?");
    this.db.transaction(() => {
      for (const [id, c] of costs) q.run(c.costUsd, c.provider, wakeId, id);
    })();
  }

  /** Start of the agent's latest wake (null before the first). */
  lastWakeStart(agent: string): number | null {
    return this.db.query<{ t: number | null }, [string, string]>("SELECT MAX(started_at) AS t FROM wakes WHERE run_id = ? AND agent = ?").get(this.runId, agent)!.t;
  }

  pendingControls(): { id: number; agent: string | null; action: ControlAction; source: string | null; detail: string | null }[] {
    return this.db
      .query<{ id: number; agent: string | null; action: ControlAction; source: string | null; detail: string | null }, [string]>(
        "SELECT id, agent, action, source, detail FROM controls WHERE run_id = ? AND consumed_at IS NULL ORDER BY id",
      )
      .all(this.runId);
  }
  consumeControl(id: number): void {
    this.db.query("UPDATE controls SET consumed_at = ? WHERE id = ?").run(Date.now(), id);
  }

  setRunStatus(status: string, stopReason: string | null = null): void {
    const ended = status === "stopped" || status === "finished" ? Date.now() : null;
    this.db
      .query("UPDATE runs SET status = ?, stop_reason = COALESCE(?, stop_reason), ended_at = COALESCE(?, ended_at) WHERE id = ?")
      .run(status, stopReason, ended, this.runId);
  }
  /** Back to running after a stop or the end (resume, extension): the old end no longer applies. */
  reopenRun(): void {
    this.db.query("UPDATE runs SET status = 'running', stop_reason = NULL, ended_at = NULL WHERE id = ?").run(this.runId);
  }
  /** Whether anything has happened since the run was created (a controller ran it before). */
  hasHistory(): boolean {
    return !!this.db.query("SELECT 1 FROM events WHERE run_id = ? AND name IS NOT 'run_created' LIMIT 1").get(this.runId);
  }

  addExtension(e: Omit<ExtensionRow, "id" | "run_id">): void {
    this.db
      .query("INSERT INTO extensions (run_id, ts, source, time_ms, old_deadline, new_deadline, swarm_usd, agent_usd_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.runId, e.ts, e.source, e.time_ms, e.old_deadline, e.new_deadline, e.swarm_usd, e.agent_usd_json);
    this.db.query("UPDATE runs SET deadline_at = ? WHERE id = ?").run(e.new_deadline, this.runId);
  }
}
