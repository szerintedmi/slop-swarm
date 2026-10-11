// Codex CLI adapter: `codex exec --json` for the live stream, the rollout file for per-request usage (plan §4.2, §8).
import { basename, join } from "node:path";
import type { AgentEvent, CommandOptions, FinalizeContext, RequestUsage, RuntimeAdapter, StreamParser } from "../types.ts";
import { findFiles, n, parseJsonLine, readJsonLines, short } from "./util.ts";

/**
 * OpenAI `input_tokens` INCLUDES `cached_input_tokens` (and, we assume, cache writes).
 * `output_tokens` already includes `reasoning_output_tokens`: in the fixtures
 * total_tokens == input_tokens + output_tokens while reasoning > 0.
 */
export function normaliseCodexUsage(u: Record<string, any>, requestId: string, model: string, ts?: string): RequestUsage {
  const cached = n(u.cached_input_tokens);
  const written = n(u.cache_write_input_tokens);
  return {
    requestId,
    model,
    freshInput: Math.max(0, n(u.input_tokens) - cached - written),
    cacheRead: cached,
    cacheWrite5m: written,
    cacheWrite1h: 0,
    output: n(u.output_tokens),
    reasoning: n(u.reasoning_output_tokens),
    webSearches: 0,
    ts,
  };
}

function itemArgs(item: Record<string, any>): string {
  switch (item.type) {
    case "command_execution":
      return String(item.command ?? "");
    case "web_search":
      return String(item.query ?? "");
    case "file_change":
      return (Array.isArray(item.changes) ? item.changes : []).map((c: any) => `${c?.kind ?? "?"} ${c?.path ?? "?"}`).join(", ");
    case "mcp_tool_call":
      return JSON.stringify(item.arguments ?? {});
    default: {
      const { id: _id, type: _type, status: _status, ...rest } = item;
      return JSON.stringify(rest);
    }
  }
}

function itemName(item: Record<string, any>): string {
  if (item.type === "mcp_tool_call") return `mcp:${item.server ?? "?"}/${item.tool ?? "?"}`;
  return String(item.type ?? "?");
}

function itemResult(item: Record<string, any>): { ok: boolean; summary: string } {
  const failed = item.status === "failed" || item.status === "declined" || (typeof item.exit_code === "number" && item.exit_code !== 0) || !!item.error;
  const summary =
    item.aggregated_output ?? item.error?.message ?? (item.result !== undefined ? JSON.stringify(item.result) : item.status ?? "");
  return { ok: !failed, summary: String(summary) };
}

class CodexParser implements StreamParser {
  private turns = 0;
  private started = new Set<string>();
  constructor(private model: string) {}

  push(line: string): AgentEvent[] {
    const d = parseJsonLine(line);
    if (!d) return [];
    const out: AgentEvent[] = [];
    const item = d.item && typeof d.item === "object" ? (d.item as Record<string, any>) : undefined;
    switch (d.type) {
      case "thread.started":
        if (typeof d.thread_id === "string") out.push({ kind: "session", sessionId: d.thread_id });
        break;
      case "item.started":
        if (item && item.type !== "agent_message" && item.type !== "reasoning" && item.type !== "error") {
          this.started.add(String(item.id));
          out.push({ kind: "tool_call", id: String(item.id), name: itemName(item), args: itemArgs(item) });
        }
        break;
      case "item.completed":
        if (!item) break;
        if (item.type === "reasoning") {
          if (typeof item.text === "string" && item.text.trim()) out.push({ kind: "reasoning", text: item.text });
          break;
        }
        if (item.type === "error") {
          // Non-fatal CLI notices (e.g. ignored config keys), not tool calls.
          out.push({ kind: "message", role: "user", text: `[codex notice] ${String(item.message ?? "")}` });
          break;
        }
        if (item.type === "agent_message") {
          if (typeof item.text === "string" && item.text.trim()) out.push({ kind: "message", role: "assistant", text: item.text });
          break;
        }
        if (!this.started.has(String(item.id))) out.push({ kind: "tool_call", id: String(item.id), name: itemName(item), args: itemArgs(item) });
        out.push({ kind: "tool_result", id: String(item.id), ...itemResult(item) });
        break;
      case "turn.completed":
        this.turns++;
        // Provisional per-turn aggregate; finalizeUsage replaces it with per-request rollout records.
        if (d.usage) out.push({ kind: "usage", usage: normaliseCodexUsage(d.usage, `turn-${this.turns}`, this.model) });
        out.push({ kind: "turn_end", reason: "completed", numTurns: this.turns });
        break;
      case "turn.failed":
        out.push({ kind: "turn_end", reason: "error", numTurns: this.turns, detail: short(String(d.error?.message ?? "turn failed"), 300) });
        break;
      case "error":
        out.push({ kind: "turn_end", reason: "error", numTurns: this.turns, detail: short(String(d.message ?? "error"), 300) });
        break;
    }
    return out;
  }
}

function rolloutFor(runtimeDir: string, sessionId: string): string | undefined {
  const files = findFiles(join(runtimeDir, "sessions"), (name) => name.startsWith("rollout-") && name.endsWith(`-${sessionId}.jsonl`));
  return files.sort((a, b) => basename(a).localeCompare(basename(b))).at(-1);
}

/** Records written before the wake started belong to earlier wakes of a resumed thread. */
const CLOCK_SLACK_MS = 5000;

export function usageFromRollout(lines: Record<string, any>[], defaultModel: string, wakeStartedAt?: number): RequestUsage[] {
  const inWake = (d: Record<string, any>) => {
    if (wakeStartedAt === undefined) return true;
    const t = Date.parse(String(d.timestamp ?? ""));
    return Number.isNaN(t) || t >= wakeStartedAt - CLOCK_SLACK_MS;
  };
  let model = defaultModel;
  const records: RequestUsage[] = [];
  const counts: RequestUsage[] = [];
  let lastTotal = "";
  let pendingSearches = 0;
  for (const d of lines) {
    const p = d.payload ?? {};
    if (d.type === "turn_context" && typeof p.model === "string") model = p.model;
    if (!inWake(d)) continue;
    if (d.type === "response_item" && p.type === "web_search_call") pendingSearches++;
    if (d.type === "token_usage_record" && p.usage) {
      const u = normaliseCodexUsage(p.usage, String(p.response_id ?? `rec-${d.ordinal ?? records.length}`), model, d.timestamp);
      u.webSearches = pendingSearches;
      pendingSearches = 0;
      records.push(u);
    } else if (d.type === "event_msg" && p.type === "token_count" && p.info?.last_token_usage) {
      const total = JSON.stringify(p.info.total_token_usage ?? null);
      if (total === lastTotal) continue; // repeated token_count (e.g. rate-limit refresh) for the same request
      lastTotal = total;
      counts.push(normaliseCodexUsage(p.info.last_token_usage, `tc-${d.ordinal ?? counts.length}`, model, d.timestamp));
    }
  }
  const out = records.length > 0 ? records : counts;
  const last = out.at(-1);
  if (last && pendingSearches > 0) last.webSearches += pendingSearches;
  return out;
}

/** The last streamed turn usage (thread-cumulative) of a previous wake, or undefined. */
function lastTurnUsage(lines: string[] | undefined): Record<string, any> | undefined {
  let last: Record<string, any> | undefined;
  for (const l of lines ?? []) {
    const d = parseJsonLine(l);
    if (d?.type === "turn.completed" && d.usage) last = d.usage;
  }
  return last;
}

/** Streamed usage minus the previous wake's cumulative turn totals (used only when no rollout record is available). */
export function subtractPreviousTurn(streamed: RequestUsage[], previousLines: string[] | undefined): RequestUsage[] {
  const prev = lastTurnUsage(previousLines);
  if (!prev) return streamed.map((u) => ({ ...u }));
  const p = normaliseCodexUsage(prev, "prev", "prev");
  const sub = (a: number, b: number) => Math.max(0, a - b);
  return streamed.map((u) => ({
    ...u,
    freshInput: sub(u.freshInput, p.freshInput),
    cacheRead: sub(u.cacheRead, p.cacheRead),
    cacheWrite5m: sub(u.cacheWrite5m, p.cacheWrite5m),
    output: sub(u.output, p.output),
    reasoning: sub(u.reasoning, p.reasoning),
  }));
}

/**
 * Lean harness: our seed replaces Codex's base instructions and every other injected block
 * (permissions, collaboration mode, apps, skills, environment context, multi-agent hints) is off.
 * The tool definitions (~6.7K tokens, incl. server-side collaboration.* sub-agent tools) cannot be removed.
 * --strict-config makes a renamed key fail loudly instead of silently restoring the stock prompt.
 */
export function leanFlags(instructionsFile: string): string[] {
  const c = (kv: string) => ["-c", kv];
  return [
    "--strict-config",
    ...c(`model_instructions_file=${JSON.stringify(instructionsFile)}`),
    ...c("include_permissions_instructions=false"),
    ...c("include_collaboration_mode_instructions=false"),
    ...c("include_apps_instructions=false"),
    ...c("include_environment_context=false"),
    ...c("skills.include_instructions=false"),
    ...c('features.multi_agent_v2.root_agent_usage_hint_text=""'),
    ...c('features.multi_agent_v2.multi_agent_mode_hint_text=""'),
    ...c("features.multi_agent_v2.usage_hint_enabled=false"),
    ...["multi_agent", "plugins", "apps", "skill_search", "tool_suggest", "image_generation", "browser_use", "computer_use", "goals", "view_image", "hooks"].flatMap((f) => ["--disable", f]),
  ];
}

export const codexAdapter: RuntimeAdapter = {
  runtime: "codex",

  // Codex has no max-turns flag: CommandOptions.maxTurns is ignored, the controller enforces timeout + budget.
  // `resume` is a subcommand, so all flags go after it.
  buildCommand(o: CommandOptions): string[] {
    const flags = [
      "--json",
      "--skip-git-repo-check",
      "-m",
      o.model,
      "-c",
      `model_reasoning_effort=${o.effort}`,
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      'web_search="live"',
      // Reasoning summaries for the transcript. Luna at medium effort often reasons 0 tokens, so many wakes have none.
      "-c",
      'model_reasoning_summary="auto"',
      ...(o.systemPrompt ? leanFlags(o.systemPrompt.file) : []),
    ];
    return o.resumeSessionId
      ? ["codex", "exec", "resume", ...flags, o.resumeSessionId, o.prompt]
      : ["codex", "exec", ...flags, o.prompt];
  },

  containerEnv: (runtimeMount) => ({ CODEX_HOME: runtimeMount }),

  newParser: (o) => new CodexParser(o?.model ?? "unknown"),

  async finalizeUsage(ctx: FinalizeContext): Promise<RequestUsage[]> {
    // `turn.completed.usage` accumulates over a resumed thread: the streamed fallback must not include the previous wake.
    const streamed = () => subtractPreviousTurn(ctx.streamed, ctx.previousWakeStdoutLines);
    if (!ctx.sessionId) return streamed();
    const file = rolloutFor(ctx.runtimeDir, ctx.sessionId);
    if (!file) return streamed();
    const defaultModel = ctx.streamed[0]?.model ?? "unknown";
    const fromRollout = usageFromRollout(readJsonLines(file), defaultModel, ctx.wakeStartedAt);
    return fromRollout.length > 0 ? fromRollout : streamed();
  },

};
