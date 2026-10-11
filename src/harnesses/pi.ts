// pi adapter (`@earendil-works/pi-coding-agent`): `pi --mode json` for the live stream, the session file
// for per-request usage. Used for OpenRouter models (plan docs/plans/2026-10-11-openrouter.md §1).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { priceKey } from "../pricing/index.ts";
import type { AgentEvent, CommandOptions, FinalizeContext, RequestUsage, HarnessAdapter, StreamParser } from "../types.ts";
import { findFiles, n, parseJsonLine, readJsonLines, short } from "./util.ts";

/** pi's tools for the lean harness (its defaults; grep/find/ls are left out, bash covers them). */
export const PI_TOOLS = "read,bash,edit,write";
/** Under the runtime mount: pi's agent dir (models.json, auth.json, …) and its session files. */
export const PI_AGENT_SUBDIR = "pi";
export const PI_SESSION_SUBDIR = "sessions";

/**
 * pi's `usage`: `input` EXCLUDES cache reads and writes; `cacheWrite1h` is the 1h-TTL subset of `cacheWrite`;
 * `reasoning` is already included in `output`.
 */
export function normalisePiUsage(u: Record<string, any>, requestId: string, model: string, ts?: string): RequestUsage {
  const written = n(u.cacheWrite);
  const written1h = Math.min(written, n(u.cacheWrite1h));
  return {
    requestId,
    model,
    freshInput: n(u.input),
    cacheRead: n(u.cacheRead),
    cacheWrite5m: written - written1h,
    cacheWrite1h: written1h,
    output: n(u.output),
    reasoning: n(u.reasoning),
    webSearches: 0,
    ts,
  };
}

function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return typeof result === "string" ? result : "";
  return content.map((c) => (c && typeof c.text === "string" ? c.text : `[${c?.type ?? "?"}]`)).join("\n");
}

const isoOf = (ms: unknown) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);

class PiParser implements StreamParser {
  private turns = 0;
  private compactions = 0;
  private anonymous = 0;
  private seenTools = new Set<string>();
  private lastStop: string | undefined;
  private lastError: string | undefined;
  constructor(private model: string) {}

  push(line: string): AgentEvent[] {
    const d = parseJsonLine(line);
    if (!d) return [];
    const out: AgentEvent[] = [];
    switch (d.type) {
      case "session":
        if (typeof d.id === "string") out.push({ kind: "session", sessionId: d.id, info: { version: d.version, cwd: d.cwd } });
        break;
      case "turn_start":
        out.push({ kind: "turn_start", n: ++this.turns });
        break;
      case "message_end": {
        // message_update carries running usage without a request id; message_end is the final message.
        const m = d.message ?? {};
        if (m.role !== "assistant") break;
        this.lastStop = typeof m.stopReason === "string" ? m.stopReason : undefined;
        if (m.stopReason === "error" || m.stopReason === "aborted") {
          this.lastError = String(m.errorMessage ?? m.stopReason);
          out.push({ kind: "message", role: "user", text: `[pi ${m.stopReason}] ${short(this.lastError, 500)}` });
        }
        if (m.usage) {
          const id = typeof m.responseId === "string" && m.responseId ? m.responseId : `pi-${++this.anonymous}`;
          out.push({ kind: "usage", usage: normalisePiUsage(m.usage, id, priceKey(String(m.model ?? this.model)), isoOf(m.timestamp)) });
        }
        for (const c of Array.isArray(m.content) ? m.content : []) {
          if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) out.push({ kind: "message", role: "assistant", text: c.text });
          else if (c?.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim()) out.push({ kind: "reasoning", text: c.thinking });
          else if (c?.type === "toolCall") {
            const id = String(c.id ?? "");
            if (this.seenTools.has(id)) continue;
            this.seenTools.add(id);
            out.push({ kind: "tool_call", id, name: String(c.name ?? "?"), args: JSON.stringify(c.arguments ?? {}) });
          }
        }
        break;
      }
      case "tool_execution_end":
        out.push({ kind: "tool_result", id: String(d.toolCallId ?? ""), ok: d.isError !== true, summary: resultText(d.result) });
        break;
      case "compaction_end":
        // The summary request is a model call of its own; the session file has it too (finalizeUsage).
        if (d.result?.usage) out.push({ kind: "usage", usage: normalisePiUsage(d.result.usage, `compaction-${++this.compactions}`, priceKey(this.model)) });
        break;
      case "auto_retry_end":
        if (d.success === false) this.lastError = String(d.finalError ?? "retries exhausted");
        break;
      case "agent_settled": {
        // pi exits 0 even when every attempt failed: the last assistant message's stop reason decides.
        const failed = d.aborted === true || this.lastStop === "error" || this.lastStop === "aborted" || this.lastStop === undefined;
        out.push({
          kind: "turn_end",
          reason: failed ? "error" : "completed",
          numTurns: this.turns,
          detail: failed ? short(this.lastError ?? (d.aborted ? "aborted" : "no assistant reply"), 300) : undefined,
        });
        break;
      }
    }
    return out;
  }
}

/** The session file pi writes for `sessionId`: <runtime>/sessions/<timestamp>_<sessionId>.jsonl. */
function sessionFiles(runtimeDir: string, sessionId: string): string[] {
  return findFiles(join(runtimeDir, PI_SESSION_SUBDIR), (name) => name.endsWith(`_${sessionId}.jsonl`)).sort();
}

/** Records written before the wake started belong to earlier wakes of a resumed session. */
const CLOCK_SLACK_MS = 5000;

/**
 * Per-request usage from a pi session file: assistant messages (keyed by the provider's response id),
 * compaction and branch summaries, and standalone usage entries (e.g. cache warming).
 */
export function usageFromSession(entries: Record<string, any>[], model: string, wakeStartedAt?: number): RequestUsage[] {
  const out: RequestUsage[] = [];
  for (const e of entries) {
    const t = Date.parse(String(e.timestamp ?? ""));
    if (wakeStartedAt !== undefined && !Number.isNaN(t) && t < wakeStartedAt - CLOCK_SLACK_MS) continue;
    const ts = typeof e.timestamp === "string" ? e.timestamp : undefined;
    if (e.type === "message" && e.message?.role === "assistant" && e.message.usage) {
      const m = e.message;
      const id = typeof m.responseId === "string" && m.responseId ? m.responseId : `entry:${e.id}`;
      out.push(normalisePiUsage(m.usage, id, priceKey(String(m.model ?? model)), ts));
    } else if ((e.type === "compaction" || e.type === "branch_summary") && e.usage) {
      out.push(normalisePiUsage(e.usage, `${e.type}:${e.id}`, priceKey(model), ts));
    } else if (e.type === "usage" && e.usage) {
      out.push(normalisePiUsage(e.usage, `usage:${e.id}`, priceKey(String(e.model ?? model)), ts));
    }
  }
  return out;
}

/** Write pi's models.json (the controller's model entries) into an agent's runtime dir. */
export function writePiModels(runtimeDir: string, modelsJson: unknown): void {
  const dir = join(runtimeDir, PI_AGENT_SUBDIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "models.json"), JSON.stringify(modelsJson, null, 2) + "\n");
}

export const piAdapter: HarnessAdapter = {
  harness: "pi",
  // No max-turns flag: the controller counts `turn_start` events and stops the container.
  maxTurnsBy: "turns",
  // pi has no search tool of its own.
  searchModes: ["relay"],

  buildCommand(o: CommandOptions): string[] {
    const mount = "/runtime";
    return [
      "pi",
      "--mode",
      "json",
      "--provider",
      "openrouter",
      "--model",
      o.model,
      // pi clamps the level to what the model supports (e.g. GLM has low/high/max: medium runs as high).
      "--thinking",
      o.effort,
      ...(o.systemPrompt ? ["--system-prompt", o.systemPrompt.file] : []),
      "--session-dir",
      `${mount}/${PI_SESSION_SUBDIR}`,
      // A new session gets pi's own id (the `session` header reports it); a resumed one is opened by id.
      ...(o.resumeSessionId ? ["--session-id", o.resumeSessionId] : []),
      "--tools",
      PI_TOOLS,
      // Nothing discovered: no AGENTS.md/CLAUDE.md, extensions, MCP, skills, prompt templates or themes.
      "--no-context-files",
      "--no-extensions",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--offline",
      "--",
      o.prompt,
    ];
  },

  containerEnv: (runtimeMount) => ({
    PI_CODING_AGENT_DIR: `${runtimeMount}/${PI_AGENT_SUBDIR}`,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  }),

  newParser: (o) => new PiParser(o?.model ?? "unknown"),

  /**
   * message_end usage is already final, so the stream is complete for every request that finished. The session
   * file is preferred where it has the request (it also survives a killed controller); streamed records it lacks
   * are kept.
   */
  async finalizeUsage(ctx: FinalizeContext): Promise<RequestUsage[]> {
    const streamed = ctx.streamed.map((u) => ({ ...u }));
    if (!ctx.sessionId) return streamed;
    const model = ctx.streamed[0]?.model ?? "unknown";
    const fromSession = sessionFiles(ctx.runtimeDir, ctx.sessionId).flatMap((f) => usageFromSession(readJsonLines(f), model, ctx.wakeStartedAt));
    if (fromSession.length === 0) return streamed;
    const known = new Set(fromSession.map((u) => u.requestId));
    // Streamed compaction ids (`compaction-N`) have no session-file twin by id; the session's own record wins.
    const sessionHasCompaction = fromSession.some((u) => u.requestId.startsWith("compaction:"));
    const extra = streamed.filter((u) => !known.has(u.requestId) && !(sessionHasCompaction && u.requestId.startsWith("compaction-")));
    return [...fromSession, ...extra];
  },
};
