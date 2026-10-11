// Writes the agent-visible, read-only /self view (plan §4.1): usage.jsonl and pricing.yaml.
// The per-wake status (time, budget, limits) is in the wake note instead (run.ts wakeNote).
// pricing.yaml holds only the agent's own models (configured + billed), not the other agents'.
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

const ENTRY = /^  (["']?)([^\s#"'][^:#"']*?)\1:\s*(#.*)?$/;

/**
 * The run's pricing YAML cut down to the given models (unknown ones are just absent). Filters the
 * top-level `models:` entries as text so the header and per-model comments stay readable; if the
 * result doesn't parse back to exactly the wanted entries, re-emits the YAML under the header instead.
 */
export function pricingForModels(pricingYaml: string, models: Iterable<string>): string {
  const want = new Set(models);
  const root = Bun.YAML.parse(pricingYaml) as { models?: Record<string, unknown> } & Record<string, unknown>;
  const picked = Object.fromEntries(Object.entries(root.models ?? {}).filter(([k]) => want.has(k)));

  const out: string[] = [];
  let state: "before" | "in" | "after" = "before";
  let key: string | null = null;
  let modelsLine = -1;
  for (const line of pricingYaml.split("\n")) {
    if (state === "before") {
      if (/^models:\s*(#.*)?$/.test(line)) {
        state = "in";
        modelsLine = out.length;
      }
      out.push(line);
      continue;
    }
    if (state === "in") {
      if (/^[^\s#]/.test(line)) state = "after";
      else {
        const m = ENTRY.exec(line);
        if (m) key = m[2]!;
        if (key === null || want.has(key)) out.push(line);
        continue;
      }
    }
    out.push(line);
  }
  if (modelsLine >= 0 && Object.keys(picked).length === 0) out[modelsLine] = "models: {}";
  const text = out.join("\n").replace(/\s*$/, "\n");

  try {
    const back = Bun.YAML.parse(text) as Record<string, unknown>;
    if (JSON.stringify(back) === JSON.stringify({ ...root, models: picked })) return text;
  } catch {
    // fall through to the re-emitted form
  }
  const header = pricingYaml.split("\n").filter((l, i, all) => all.slice(0, i + 1).every((x) => x.startsWith("#") || !x.trim()));
  return `${header.join("\n")}\n${Bun.YAML.stringify({ ...root, models: picked }, null, 2)}\n`;
}

export function writeSelf(selfDir: string, budgetUsd: number, finishedWakes: WakeRow[], pricingYaml: string, models: Iterable<string>): void {
  mkdirSync(selfDir, { recursive: true });
  let spent = 0;
  const ledger = finishedWakes.map((w) => {
    spent += w.cost_usd;
    return usageLine(w, budgetUsd, spent);
  });
  writeFileSync(join(selfDir, "usage.jsonl"), ledger.length ? ledger.join("\n") + "\n" : "");
  writeFileSync(join(selfDir, "pricing.yaml"), pricingForModels(pricingYaml, models));
}
