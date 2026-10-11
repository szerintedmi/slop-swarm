// Budget rules (plan §6). Pure functions.
import type { WakeExitReason } from "../types.ts";

/** Below this an agent is treated as depleted: a single request costs more than this. */
export const DEPLETED_EPSILON_USD = 0.001;

export interface WakeLimit {
  usd: number;
  /** Which limit binds, used as the exit reason if it is exceeded. */
  reason: Extract<WakeExitReason, "budget_wake" | "budget_agent" | "budget_swarm">;
}

export function agentRemaining(a: { budget_usd: number; spent_usd: number }): number {
  return Math.max(0, a.budget_usd - a.spent_usd);
}

export function isDepleted(a: { budget_usd: number; spent_usd: number }): boolean {
  return agentRemaining(a) < DEPLETED_EPSILON_USD;
}

/** The spend cap for one wake: the tightest of per-wake max, agent remaining and swarm remaining. */
export function wakeLimit(perWakeMaxUsd: number, agentRemainingUsd: number, swarmRemainingUsd: number): WakeLimit {
  const opts: WakeLimit[] = [
    { usd: perWakeMaxUsd, reason: "budget_wake" },
    { usd: agentRemainingUsd, reason: "budget_agent" },
    { usd: swarmRemainingUsd, reason: "budget_swarm" },
  ];
  return opts.reduce((min, o) => (o.usd < min.usd ? o : min));
}

/** Whether the running cost of a wake has crossed its limit. */
export function overLimit(runningCostUsd: number, limit: WakeLimit): WakeLimit["reason"] | null {
  return runningCostUsd > limit.usd ? limit.reason : null;
}
