import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeCost, loadPricing, parsePricing, sumUsage } from "../src/pricing/index.ts";
import type { RequestUsage } from "../src/types.ts";

const pricing = loadPricing(join(import.meta.dir, "..", "config", "pricing.yaml"));

function usage(p: Partial<RequestUsage>): RequestUsage {
  return { requestId: "r", model: "claude-haiku-5-5", freshInput: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoning: 0, webSearches: 0, ...p };
}

describe("computeCost", () => {
  test("reproduces Claude's total_cost_usd for the real claude-hi fixture (within 1%)", () => {
    const lines = readFileSync(join(import.meta.dir, "fixtures", "claude-hi.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const result = lines.find((l) => l.type === "result");
    const it = result.usage.iterations[0];
    const c = computeCost(
      usage({ freshInput: it.input_tokens, cacheRead: it.cache_read_input_tokens, cacheWrite1h: it.cache_creation.ephemeral_1h_input_tokens, cacheWrite5m: it.cache_creation.ephemeral_5m_input_tokens, output: it.output_tokens }),
      pricing,
    );
    expect(Math.abs(c.costUsd - result.total_cost_usd) / result.total_cost_usd).toBeLessThan(0.01);
  });

  test("plan §3 Claude baseline costs $0.00122", () => {
    const c = computeCost(usage({ freshInput: 2, cacheWrite1h: 5499, cacheRead: 11447, output: 14 }), pricing);
    expect(c.costUsd).toBeCloseTo(0.00122, 5);
    expect(c.promptTokens).toBe(2 + 5499 + 11447);
    expect(c.tier).toBe(0);
  });

  test("cache TTL tiers are priced differently", () => {
    // 100K tokens: at (not above) the 5x tier threshold.
    const fiveMin = computeCost(usage({ cacheWrite5m: 100_000 }), pricing).costUsd;
    const oneHour = computeCost(usage({ cacheWrite1h: 100_000 }), pricing).costUsd;
    const read = computeCost(usage({ cacheRead: 100_000 }), pricing).costUsd;
    expect(fiveMin).toBeCloseTo(0.0125, 9);
    expect(oneHour).toBeCloseTo(0.02, 9);
    expect(read).toBeCloseTo(0.001, 9);
  });

  test("prompt-size tier applies only strictly above the threshold, to the whole request", () => {
    const at = computeCost(usage({ cacheRead: 99_999, freshInput: 1, output: 100 }), pricing);
    expect(at.promptTokens).toBe(100_000);
    expect(at.tier).toBe(0);
    expect(at.costUsd).toBeCloseTo((99_999 * 0.01 + 0.1 + 100 * 0.5) / 1e6, 12);

    const above = computeCost(usage({ cacheRead: 99_999, freshInput: 2, output: 100 }), pricing);
    expect(above.tier).toBe(100_000);
    expect(above.costUsd).toBeCloseTo((5 * (99_999 * 0.01 + 2 * 0.1 + 100 * 0.5)) / 1e6, 12);
  });

  test("tool fees are added per search and not multiplied by the tier", () => {
    const base = computeCost(usage({ freshInput: 200_000 }), pricing).costUsd;
    const withSearch = computeCost(usage({ freshInput: 200_000, webSearches: 2 }), pricing).costUsd;
    expect(withSearch - base).toBeCloseTo(0.02, 12);
  });

  test("codex fixture turn priced with cached input at the cached rate", () => {
    // codex-hi: input 19407 incl. 12032 cached, output 6
    const c = computeCost(usage({ model: "gpt-6-luna", freshInput: 19407 - 12032, cacheRead: 12032, output: 6 }), pricing);
    expect(c.costUsd).toBeCloseTo((7375 * 0.1 + 12032 * 0.01 + 6 * 0.5) / 1e6, 12);
  });

  test("gpt-6-luna long-context tier: 2x input/cache, 1.5x output above 272K", () => {
    const at = computeCost(usage({ model: "gpt-6-luna", freshInput: 272_000, output: 1000 }), pricing);
    expect(at.tier).toBe(0);
    expect(at.costUsd).toBeCloseTo((272_000 * 0.1 + 1000 * 0.5) / 1e6, 12);
    const above = computeCost(usage({ model: "gpt-6-luna", freshInput: 200_000, cacheRead: 72_001, output: 1000 }), pricing);
    expect(above.tier).toBe(272_000);
    expect(above.costUsd).toBeCloseTo(((200_000 * 0.1 + 72_001 * 0.01) * 2 + 1000 * 0.5 * 1.5) / 1e6, 12);
  });

  test("reasoning is added to output only when the model bills it separately", () => {
    const table = parsePricing(`
models:
  m:
    per_mtok: { input: 1, output: 10, cache_read: 0.1 }
    output_includes_reasoning: false
`);
    const c = computeCost(usage({ model: "m", output: 100, reasoning: 50 }), table);
    expect(c.costUsd).toBeCloseTo((150 * 10) / 1e6, 12);
    const included = computeCost(usage({ output: 100, reasoning: 50 }), pricing);
    expect(included.costUsd).toBeCloseTo((100 * 0.5) / 1e6, 12);
  });

  test("unknown model throws", () => {
    expect(() => computeCost(usage({ model: "nope" }), pricing)).toThrow(/no pricing/);
  });
});

describe("parsePricing", () => {
  test("rejects bad input", () => {
    expect(() => parsePricing("models: {}")).toThrow();
    expect(() => parsePricing("models:\n  m:\n    per_mtok: { input: -1, output: 1, cache_read: 0 }")).toThrow(/input/);
    expect(() => parsePricing("models:\n  m:\n    per_mtok: { input: 1, output: 1 }")).toThrow(/cache_read/);
    expect(() => parsePricing("models:\n  m:\n    per_mtok: { input: 1, output: 1, cache_read: 0 }\n    tiers: [{ above_prompt_tokens: 10, multiplier: 0 }]")).toThrow(
      /multiplier/,
    );
  });

  test("sorts tiers so the highest exceeded threshold wins", () => {
    const t = parsePricing(`
models:
  m:
    per_mtok: { input: 1, output: 1, cache_read: 1 }
    tiers:
      - { above_prompt_tokens: 200, multiplier: 3 }
      - { above_prompt_tokens: 100, multiplier: 2 }
`);
    expect(computeCost(usage({ model: "m", freshInput: 150 }), t).tier).toBe(100);
    expect(computeCost(usage({ model: "m", freshInput: 250 }), t).tier).toBe(200);
    expect(computeCost(usage({ model: "m", freshInput: 250 }), t).costUsd).toBeCloseTo((250 * 3) / 1e6, 12);
  });
});

test("sumUsage totals", () => {
  const t = sumUsage([usage({ freshInput: 1, output: 2, webSearches: 1 }), usage({ cacheRead: 3, cacheWrite1h: 4, reasoning: 5 })]);
  expect(t).toEqual({ requests: 2, freshInput: 1, cacheRead: 3, cacheWrite5m: 0, cacheWrite1h: 4, output: 2, reasoning: 5, webSearches: 1 });
});
