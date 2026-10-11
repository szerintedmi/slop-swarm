// Writes the agent-visible, read-only /self view (plan §4.1): usage.jsonl and pricing.yaml.
// The per-wake status (time, budget, limits) is in the wake note instead (run.ts wakeNote).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WakeRow } from "../db/index.ts";

const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");

/** One ledger line per finished wake. */
export function usageLine(w: WakeRow, budgetUsd: number, spentAfterUsd: number): string {
  return JSON.stringify({
    wake: w.seq,
    started_at: w.started_at ? iso(w.started_at) : null,
    ended_at: w.ended_at ? iso(w.ended_at) : null,
    trigger: w.trigger,
    resumed_session: !!w.resumed,
    exit: w.exit_reason,
    api_requests: w.requests,
    tokens: {
      input_fresh: w.fresh_input,
      cache_read: w.cache_read,
      cache_write_5m: w.cache_write_5m,
      cache_write_1h: w.cache_write_1h,
      output: w.output,
      reasoning: w.reasoning,
    },
    web_searches: w.web_searches,
    tool_calls: w.tool_calls,
    cost_usd: Number(w.cost_usd.toFixed(6)),
    budget_remaining_usd: Number(Math.max(0, budgetUsd - spentAfterUsd).toFixed(6)),
  });
}

export function writeSelf(selfDir: string, budgetUsd: number, finishedWakes: WakeRow[], pricingYaml: string): void {
  mkdirSync(selfDir, { recursive: true });
  let spent = 0;
  const ledger = finishedWakes.map((w) => {
    spent += w.cost_usd;
    return usageLine(w, budgetUsd, spent);
  });
  writeFileSync(join(selfDir, "usage.jsonl"), ledger.length ? ledger.join("\n") + "\n" : "");
  writeFileSync(join(selfDir, "pricing.yaml"), pricingYaml);
}
