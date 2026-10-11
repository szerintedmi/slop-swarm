// Claude Code adapter: `claude -p --output-format stream-json --verbose` (plan §3, §8).
import { join } from "node:path";
import type { AgentEvent, CommandOptions, FinalizeContext, RequestUsage, RuntimeAdapter, StreamParser } from "../types.ts";
import { findFiles, n, parseJsonLine, readJsonLines, short } from "./util.ts";

/** Claude `input_tokens` EXCLUDES cache tokens; cache writes are split by TTL. */
export function normaliseClaudeUsage(u: Record<string, any>, requestId: string, model: string, ts?: string): RequestUsage {
  const split = u.cache_creation;
  const hasSplit = split && typeof split === "object";
  return {
    requestId,
    model,
    freshInput: n(u.input_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite5m: hasSplit ? n(split.ephemeral_5m_input_tokens) : 0,
    // Without the TTL split, assume 1h: subscription traffic uses the 1h TTL (plan §3).
    cacheWrite1h: hasSplit ? n(split.ephemeral_1h_input_tokens) : n(u.cache_creation_input_tokens),
    output: n(u.output_tokens),
    reasoning: n(u.output_tokens_details?.thinking_tokens),
    webSearches: n(u.server_tool_use?.web_search_requests),
    ts,
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((c) => (c && typeof c === "object" && typeof c.text === "string" ? c.text : `[${c?.type ?? "?"}]`)).join("\n");
  return "";
}

class ClaudeParser implements StreamParser {
  private seenTools = new Set<string>();

  push(line: string): AgentEvent[] {
    const d = parseJsonLine(line);
    if (!d) return [];
    const out: AgentEvent[] = [];
    switch (d.type) {
      case "system":
        if (d.subtype === "init" && typeof d.session_id === "string")
          out.push({
            kind: "session",
            sessionId: d.session_id,
            info: { apiKeySource: d.apiKeySource, claude_code_version: d.claude_code_version, model: d.model, tools: d.tools },
          });
        break;
      case "assistant": {
        const m = d.message ?? {};
        if (typeof m.id === "string" && m.usage)
          out.push({ kind: "usage", usage: normaliseClaudeUsage(m.usage, m.id, String(m.model ?? "unknown"), d.timestamp) });
        for (const c of Array.isArray(m.content) ? m.content : []) {
          if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) out.push({ kind: "message", role: "assistant", text: c.text });
          // Thinking text is present only with --thinking-display summarized; otherwise it is "" plus a signature.
          else if (c?.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim()) out.push({ kind: "reasoning", text: c.thinking });
          else if (c?.type === "tool_use" || c?.type === "server_tool_use") {
            const id = String(c.id ?? "");
            if (this.seenTools.has(id)) continue;
            this.seenTools.add(id);
            out.push({ kind: "tool_call", id, name: String(c.name ?? "?"), args: JSON.stringify(c.input ?? {}) });
          }
        }
        break;
      }
      case "user": {
        const content = d.message?.content;
        for (const c of Array.isArray(content) ? content : []) {
          if (c?.type === "tool_result")
            out.push({ kind: "tool_result", id: String(c.tool_use_id ?? ""), ok: c.is_error !== true, summary: toolResultText(c.content) });
        }
        break;
      }
      case "result": {
        const reason = d.subtype === "error_max_turns" ? "max_turns" : d.subtype === "success" && d.is_error !== true ? "completed" : "error";
        out.push({
          kind: "turn_end",
          reason,
          numTurns: typeof d.num_turns === "number" ? d.num_turns : undefined,
          reportedCostUsd: typeof d.total_cost_usd === "number" ? d.total_cost_usd : undefined,
          detail: reason === "completed" ? undefined : short(String(d.result ?? d.api_error_status ?? d.subtype ?? ""), 300),
        });
        break;
      }
    }
    return out;
  }
}

/** Tools for the lean harness. WebFetch is left out: it fetches client-side and the proxy blocks it. */
export const LEAN_TOOLS = "Bash,Read,Write,Edit,WebSearch";

export const claudeAdapter: RuntimeAdapter = {
  runtime: "claude",
  reportedCostIsCumulative: true,

  buildCommand(o: CommandOptions): string[] {
    return [
      "claude",
      "-p",
      o.prompt,
      "--model",
      o.model,
      "--effort",
      o.effort,
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      String(o.maxTurns),
      "--dangerously-skip-permissions",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      // Haiku's thinking is omitted from stream-json by default; ask for API-side summaries (billing unchanged).
      "--thinking-display",
      "summarized",
      // Lean harness: our seed replaces Claude Code's system prompt, and only these tools are exposed.
      ...(o.systemPrompt ? ["--system-prompt", o.systemPrompt.text, "--tools", LEAN_TOOLS] : []),
      ...(o.resumeSessionId ? ["--resume", o.resumeSessionId] : []),
    ];
  },

  containerEnv: (runtimeMount) => ({ CLAUDE_CONFIG_DIR: runtimeMount }),

  newParser: () => new ClaudeParser(),

  /**
   * Streamed assistant usage is partial (output_tokens is a running value). Final per-request
   * usage comes from, in order of preference: the result's `usage.iterations` (one entry per API
   * request; empty in some CLI builds), the session transcript (final usage per message id, also
   * available for killed wakes), and only then the streamed values.
   */
  async finalizeUsage(ctx: FinalizeContext): Promise<RequestUsage[]> {
    const streamed = ctx.streamed.map((u) => ({ ...u }));
    const fromTranscript = ctx.sessionId ? transcriptUsage(ctx.runtimeDir, ctx.sessionId) : new Map<string, Record<string, any>>();
    const base = streamed.map((s) => {
      const u = fromTranscript.get(s.requestId);
      if (!u) return s;
      const t = normaliseClaudeUsage(u, s.requestId, s.model, s.ts);
      return { ...t, reasoning: t.reasoning || s.reasoning, webSearches: t.webSearches || s.webSearches };
    });
    const result = lastResult(ctx.stdoutLines);
    if (!result) return base;
    const iterations: Record<string, any>[] = Array.isArray(result.usage?.iterations) ? result.usage.iterations : [];
    let out = base;
    if (iterations.length > 0 && iterations.length === streamed.length) {
      out = streamed.map((s, i) => {
        const it = normaliseClaudeUsage(iterations[i]!, s.requestId, s.model, s.ts);
        return { ...it, reasoning: it.reasoning || s.reasoning, webSearches: it.webSearches || s.webSearches };
      });
    }
    const last = out[out.length - 1];
    if (last) {
      // Result-level totals the per-request data lacks are attributed to the last request.
      const searches = n(result.usage?.server_tool_use?.web_search_requests);
      if (searches > 0 && out.every((u) => u.webSearches === 0)) last.webSearches = searches;
      const thinking = n(result.usage?.output_tokens_details?.thinking_tokens);
      if (thinking > 0 && out.every((u) => u.reasoning === 0)) last.reasoning = thinking;
    }
    // modelUsage accumulates over a resumed session: the previous wake's totals are the baseline.
    const baseline = ctx.previousWakeStdoutLines ? lastResult(ctx.previousWakeStdoutLines)?.modelUsage : undefined;
    return [...out, ...unattributedUsage(result.modelUsage, out, baseline)];
  },

};

/** The last `result` line of a wake's stdout, if any. */
function lastResult(lines: string[]): Record<string, any> | undefined {
  let result: Record<string, any> | undefined;
  for (const l of lines) {
    const d = parseJsonLine(l);
    if (d?.type === "result") result = d;
  }
  return result;
}

/** Final usage per message id from the session transcript(s): <runtime>/projects/<cwd>/<sessionId>.jsonl. */
function transcriptUsage(runtimeDir: string, sessionId: string): Map<string, Record<string, any>> {
  const out = new Map<string, Record<string, any>>();
  for (const f of findFiles(join(runtimeDir, "projects"), (name) => name === `${sessionId}.jsonl`))
    for (const d of readJsonLines(f)) {
      const id = d.type === "assistant" ? d.message?.id : undefined;
      if (typeof id === "string" && d.message?.usage) out.set(id, d.message.usage);
    }
  return out;
}

/**
 * Usage that the vendor's per-model totals (`result.modelUsage`) contain but no streamed request
 * does, e.g. the model calls Claude Code's WebSearch tool makes internally (fresh input + search
 * fees, never streamed). Returned as one synthetic request per model so run totals match the bill.
 * The cache-write TTL of hidden calls is unknown; it is priced as 1h, like the rest of the session.
 *
 * `modelUsage` (and `total_cost_usd`) accumulate over a resumed session, so for a resumed wake the
 * previous wake's `modelUsage` must be passed as `baseline`; without it the whole earlier session
 * would be billed again here.
 */
export function unattributedUsage(modelUsage: unknown, known: RequestUsage[], baseline?: unknown): RequestUsage[] {
  if (!modelUsage || typeof modelUsage !== "object") return [];
  const out: RequestUsage[] = [];
  const base = baseline && typeof baseline === "object" ? (baseline as Record<string, Record<string, unknown> | undefined>) : {};
  for (const [model, raw] of Object.entries(modelUsage as Record<string, Record<string, unknown>>)) {
    const mine = known.filter((u) => u.model === model);
    const prev = base[model] ?? {};
    const sum = (f: (u: RequestUsage) => number) => mine.reduce((s, u) => s + f(u), 0);
    const rest = (key: string, have: number) => Math.max(0, n(raw[key]) - n(prev[key]) - have);
    const u: RequestUsage = {
      requestId: `unattributed:${model}`,
      model,
      freshInput: rest("inputTokens", sum((u) => u.freshInput)),
      cacheRead: rest("cacheReadInputTokens", sum((u) => u.cacheRead)),
      cacheWrite5m: 0,
      cacheWrite1h: rest("cacheCreationInputTokens", sum((u) => u.cacheWrite5m + u.cacheWrite1h)),
      output: rest("outputTokens", sum((u) => u.output)),
      reasoning: rest("thinkingTokens", sum((u) => u.reasoning)),
      webSearches: rest("webSearchRequests", sum((u) => u.webSearches)),
    };
    if (u.freshInput + u.cacheRead + u.cacheWrite1h + u.output + u.webSearches > 0) out.push(u);
  }
  return out;
}
