// Writes the agent-visible, read-only /self view (plan §4.1): usage.jsonl and pricing.yaml.
// The per-wake status (time, budget, limits) is in the wake note instead (run.ts wakeNote).
// pricing.yaml holds only the agent's own models (configured + billed, plus relay search if it may search), not the other agents'.
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

/** Top-level pricing sections keyed by model (pricing.yaml `models:`, and `search:` for the relay's pseudo-models). */
const SECTIONS = ["models", "search"] as const;

/**
 * The run's pricing YAML cut down to the given models (unknown ones are just absent). Filters the entries of
 * the top-level `models:` and `search:` sections as text so the header and per-model comments stay readable; an
 * empty `models:` becomes `models: {}`, an empty `search:` is dropped with the comment block above it. If the
 * result doesn't parse back to exactly the wanted entries, re-emits the YAML under the header instead.
 */
export function pricingForModels(pricingYaml: string, models: Iterable<string>): string {
  const want = new Set(models);
  const root = Bun.YAML.parse(pricingYaml) as Record<string, unknown>;
  const expected: Record<string, unknown> = { ...root };
  for (const sec of SECTIONS) {
    const v = root[sec];
    if (sec !== "models" && v === undefined) continue;
    const picked = Object.fromEntries(Object.entries((v ?? {}) as Record<string, unknown>).filter(([k]) => want.has(k)));
    if (sec === "models" || Object.keys(picked).length) expected[sec] = picked;
    else delete expected[sec];
  }

  const out: string[] = [];
  let section: (typeof SECTIONS)[number] | null = null;
  let key: string | null = null;
  let headerAt = -1;
  let commentsAt = -1;
  const close = () => {
    if (!section) return;
    if (!(section in expected)) out.splice(commentsAt); // empty optional section: drop it and its comments
    else if (Object.keys(expected[section] as object).length === 0) out[headerAt] = `${section}: {}`;
    section = null;
  };
  for (const line of pricingYaml.split("\n")) {
    if (section) {
      if (/^[^\s#]/.test(line)) close();
      else {
        const m = ENTRY.exec(line);
        if (m) key = m[2]!;
        if (key === null || want.has(key)) out.push(line);
        continue;
      }
    }
    const h = /^(\w+):\s*(#.*)?$/.exec(line);
    const sec = SECTIONS.find((x) => x === h?.[1]);
    if (sec) {
      section = sec;
      key = null;
      // The comment lines right above the header belong to it.
      commentsAt = out.length;
      while (commentsAt > 0 && /^#/.test(out[commentsAt - 1]!)) commentsAt--;
      headerAt = out.length;
    }
    out.push(line);
  }
  close();
  const text = out.join("\n").replace(/\s*$/, "\n");

  try {
    const back = Bun.YAML.parse(text) as Record<string, unknown>;
    if (JSON.stringify(back) === JSON.stringify(expected)) return text;
  } catch {
    // fall through to the re-emitted form
  }
  const header = pricingYaml.split("\n").filter((l, i, all) => all.slice(0, i + 1).every((x) => x.startsWith("#") || !x.trim()));
  return `${header.join("\n")}\n${Bun.YAML.stringify(expected, null, 2)}\n`;
}

/** The /self files (paths relative to /self), sent to the agent host by each wake's prepare. */
export function selfFiles(budgetUsd: number, finishedWakes: WakeRow[], pricingYaml: string, models: Iterable<string>): { path: string; content: string }[] {
  let spent = 0;
  const ledger = finishedWakes.map((w) => {
    spent += w.cost_usd;
    return usageLine(w, budgetUsd, spent);
  });
  return [
    { path: "usage.jsonl", content: ledger.length ? ledger.join("\n") + "\n" : "" },
    { path: "pricing.yaml", content: pricingForModels(pricingYaml, models) },
  ];
}

export function writeSelf(selfDir: string, budgetUsd: number, finishedWakes: WakeRow[], pricingYaml: string, models: Iterable<string>): void {
  mkdirSync(selfDir, { recursive: true });
  for (const f of selfFiles(budgetUsd, finishedWakes, pricingYaml, models)) writeFileSync(join(selfDir, f.path), f.content);
}
