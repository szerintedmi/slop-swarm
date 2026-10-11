// Shared types. The internal event stream is modelled on ACP's `session/update`
// (tool_call / message / usage / turn_end) so an ACP adapter can slot in later (plan §8).

/** The agent CLI (harness) a wake runs: Claude Code, Codex CLI or pi. */
export const HARNESSES = ["claude", "codex", "pi"] as const;
export type Harness = (typeof HARNESSES)[number];
export type Effort = "low" | "medium" | "high";

export type AgentStatus = "active" | "sleeping" | "waking" | "paused" | "depleted" | "failed";
/** initial | self (agent's chosen time) | timer (max_sleep reached / retry) | message | manual */
export type WakeTrigger = "initial" | "self" | "timer" | "message" | "manual";
export type WakeExitReason =
  | "completed" // CLI exited 0
  | "max_turns"
  | "timeout"
  | "world_end" // still running at the world end + world_end_grace -> killed
  | "budget_wake" // per-wake max_usd exceeded -> killed
  | "budget_agent" // agent budget exhausted mid-wake -> killed
  | "budget_swarm"
  | "stopped" // run stop / emergency kill
  | "error";

/** One API request, normalised across vendors. All counts are tokens. */
export interface RequestUsage {
  /** Vendor id of the request/response (Claude message id, OpenAI response id). Usage events with the same id are upserts. */
  requestId: string;
  model: string;
  /** Input tokens that were neither read from nor written to the cache. */
  freshInput: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** Billable output tokens as reported by the vendor. */
  output: number;
  /** Reasoning/thinking tokens (informational; see pricing `output_includes_reasoning`). */
  reasoning: number;
  webSearches: number;
  ts?: string;
}

export interface CostBreakdown {
  costUsd: number;
  promptTokens: number;
  /** 0 = base tier; otherwise the `above_prompt_tokens` threshold that applied. */
  tier: number;
}

export type AgentEvent =
  | { kind: "session"; sessionId: string; info?: Record<string, unknown> }
  | { kind: "message"; role: "assistant" | "user"; text: string }
  /** Reasoning summary: Claude summarized thinking, Codex reasoning summary. */
  | { kind: "reasoning"; text: string }
  /** `args` and `summary` carry the full text; consumers shorten it if they need to. */
  | { kind: "tool_call"; id: string; name: string; args: string }
  | { kind: "tool_result"; id: string; ok: boolean; summary: string }
  | { kind: "usage"; usage: RequestUsage }
  /** One assistant turn started (pi); the controller counts these for harnesses without a max-turns flag. */
  | { kind: "turn_start"; n: number }
  | {
      kind: "turn_end";
      /** Normalised: completed | max_turns | error */
      reason: "completed" | "max_turns" | "error";
      numTurns?: number;
      /** Vendor-reported cost (Claude total_cost_usd), cross-check only. */
      reportedCostUsd?: number;
      detail?: string;
    };

export interface CommandOptions {
  /** The user turn. */
  prompt: string;
  /**
   * Lean harness: replace the CLI's own system prompt with `text`. The caller must already have
   * written `text` to `file` (a container path; Codex reads instructions from a file).
   * Omitted = the CLI's stock system prompt and tools.
   */
  systemPrompt?: { text: string; file: string };
  model: string;
  effort: Effort;
  maxTurns: number;
  resumeSessionId?: string;
}

export interface StreamParser {
  /** Feed one stdout line; returns zero or more normalised events. Must never throw on bad input. */
  push(line: string): AgentEvent[];
}

export interface FinalizeContext {
  /** Host path of the agent's runtime dir (CLAUDE_CONFIG_DIR / CODEX_HOME). */
  runtimeDir: string;
  sessionId?: string;
  /** Usage collected from the live stream, last value per requestId. */
  streamed: RequestUsage[];
  /** Raw stdout lines of the wake. */
  stdoutLines: string[];
  /** Unix ms when the wake started; session-file records older than this belong to earlier (resumed) wakes. */
  wakeStartedAt?: number;
  /**
   * Raw stdout of the previous wake of the same session, when this wake resumed it. Both CLIs report
   * some totals cumulatively over a resumed session (Claude `result.modelUsage` / `total_cost_usd`,
   * Codex `turn.completed.usage`); adapters subtract the previous wake's totals to get this wake's own.
   */
  previousWakeStdoutLines?: string[];
}

export interface HarnessAdapter {
  readonly harness: Harness;
  /** True when `turn_end.reportedCostUsd` accumulates over a resumed session (Claude's total_cost_usd). */
  readonly reportedCostIsCumulative?: boolean;
  /**
   * How the controller enforces budgets.per_wake.max_turns for a CLI without a flag for it: by tool calls
   * (Codex) or by `turn_start` events (pi). Absent = the CLI enforces it (`maxTurns` in CommandOptions).
   */
  readonly maxTurnsBy?: "tool_calls" | "turns";
  /** argv to run inside the container (cwd = /home/agent). */
  buildCommand(o: CommandOptions): string[];
  /** Extra container env, e.g. CLAUDE_CONFIG_DIR / CODEX_HOME pointing at the runtime mount. */
  containerEnv(runtimeMount: string): Record<string, string>;
  /** `model` labels usage for harnesses whose stream doesn't name it (Codex). */
  newParser(o?: { model?: string }): StreamParser;
  /** Authoritative per-request usage after the container exits. */
  finalizeUsage(ctx: FinalizeContext): Promise<RequestUsage[]>;
}
