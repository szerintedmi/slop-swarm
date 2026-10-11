// Real-time scheduling (plan §5). One rule: an agent wakes when new forge notifications arrive, or `max_sleep`
// after its last wake; it can ask (next_wake.yaml) to wake earlier.
import type { SwarmConfig } from "../config.ts";
import type { WakeTrigger } from "../types.ts";

export type SchedulerConfig = SwarmConfig["scheduler"];

export interface NextWakeRequest {
  inMinutes?: number;
  continueSession: boolean;
  /** Set when next_wake.yaml existed but could not be used as written. */
  error?: string;
}

/** Parse the agent-written ./next_wake.yaml. `undefined` text = file absent. */
export function parseNextWake(text: string | undefined): NextWakeRequest | undefined {
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (e) {
    return { continueSession: false, error: `invalid YAML: ${(e as Error).message}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { continueSession: false, error: "expected a mapping" };
  const r = raw as Record<string, unknown>;
  const out: NextWakeRequest = { continueSession: r.continue_session === true || r.continue_session === "true" };
  const n = typeof r.in_minutes === "string" ? Number(r.in_minutes) : r.in_minutes;
  if (typeof n === "number" && Number.isFinite(n) && n >= 0) out.inMinutes = n;
  else if (r.in_minutes !== undefined) out.error = `in_minutes is not a non-negative number: ${JSON.stringify(r.in_minutes)}`;
  return out;
}

/** Next wake after a wake that ended at `endedAt`: the agent's choice, at most `max_sleep`. */
export function planNextWake(
  endedAt: number,
  req: NextWakeRequest | undefined,
  s: SchedulerConfig,
): { at: number; trigger: WakeTrigger } {
  if (req?.inMinutes === undefined) return { at: endedAt + s.maxSleepMs, trigger: "timer" };
  const ms = Math.min(req.inMinutes * 60_000, s.maxSleepMs);
  return { at: endedAt + ms, trigger: "self" };
}

/** New notifications wake the recipient now. Returns the new time, or null if it is already due by then. */
export function messagePull(now: number, agent: { next_wake_at: number | null }): number | null {
  return agent.next_wake_at !== null && agent.next_wake_at <= now ? null : now;
}

export interface SchedulableAgent {
  name: string;
  status: string;
  next_wake_at: number | null;
}

/** Agents due now, earliest first, limited to the free concurrency slots. */
export function pickDue<T extends SchedulableAgent>(agents: T[], now: number, running: number, maxConcurrent: number): T[] {
  const free = Math.max(0, maxConcurrent - running);
  return agents
    .filter((a) => (a.status === "active" || a.status === "sleeping") && a.next_wake_at !== null && a.next_wake_at <= now)
    .sort((a, b) => a.next_wake_at! - b.next_wake_at! || a.name.localeCompare(b.name))
    .slice(0, free);
}
