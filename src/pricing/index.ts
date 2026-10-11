// Per-request API-equivalent cost (plan §2 "Cost", §3 quirks). Prices come from config/pricing.yaml.
import { readFileSync } from "node:fs";
import type { CostBreakdown, RequestUsage } from "../types.ts";

export interface PricingTier {
  /** Applies when the request's prompt tokens are strictly above this. */
  abovePromptTokens: number;
  /** Applied to fresh input, cache reads and cache writes. */
  inputMultiplier: number;
  outputMultiplier: number;
}

export interface PricingModel {
  provider: string;
  /** USD per million tokens. */
  perMtok: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number };
  /** Sorted ascending by abovePromptTokens. */
  tiers: PricingTier[];
  /** USD per tool use, e.g. { web_search: 0.01 }. */
  toolFeesUsd: Record<string, number>;
  /** If false, reasoning tokens are billed on top of `output`. */
  outputIncludesReasoning: boolean;
}

export interface PricingTable {
  models: Record<string, PricingModel>;
}

export class PricingError extends Error {}

function rec(v: unknown, field: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new PricingError(`${field}: expected a mapping`);
  return v as Record<string, unknown>;
}
function price(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new PricingError(`${field}: expected a number >= 0`);
  return v;
}

export function parsePricing(yamlText: string): PricingTable {
  const root = rec(Bun.YAML.parse(yamlText), "pricing");
  const models: Record<string, PricingModel> = {};
  for (const [name, raw] of Object.entries(rec(root.models, "models"))) {
    const f = `models.${name}`;
    const m = rec(raw, f);
    const p = rec(m.per_mtok, `${f}.per_mtok`);
    const tiersRaw = m.tiers ?? [];
    if (!Array.isArray(tiersRaw)) throw new PricingError(`${f}.tiers: expected a list`);
    const tiers = tiersRaw
      .map((t, i) => {
        const tt = rec(t, `${f}.tiers[${i}]`);
        // `multiplier` sets both; `input_multiplier` / `output_multiplier` override it (e.g. OpenAI: 2x input, 1.5x output).
        const mult = (key: string) => {
          const v = price(tt[key] ?? tt.multiplier, `${f}.tiers[${i}].${key} (or multiplier)`);
          if (v <= 0) throw new PricingError(`${f}.tiers[${i}].${key}: must be > 0`);
          return v;
        };
        return {
          abovePromptTokens: price(tt.above_prompt_tokens, `${f}.tiers[${i}].above_prompt_tokens`),
          inputMultiplier: mult("input_multiplier"),
          outputMultiplier: mult("output_multiplier"),
        };
      })
      .sort((a, b) => a.abovePromptTokens - b.abovePromptTokens);
    const toolFeesUsd: Record<string, number> = {};
    for (const [tool, fee] of Object.entries(rec(m.tool_fees_usd ?? {}, `${f}.tool_fees_usd`)))
      toolFeesUsd[tool] = price(fee, `${f}.tool_fees_usd.${tool}`);
    const oir = m.output_includes_reasoning ?? true;
    if (typeof oir !== "boolean") throw new PricingError(`${f}.output_includes_reasoning: expected a boolean`);
    models[name] = {
      provider: typeof m.provider === "string" ? m.provider : "unknown",
      perMtok: {
        input: price(p.input, `${f}.per_mtok.input`),
        output: price(p.output, `${f}.per_mtok.output`),
        cacheRead: price(p.cache_read, `${f}.per_mtok.cache_read`),
        cacheWrite5m: price(p.cache_write_5m ?? 0, `${f}.per_mtok.cache_write_5m`),
        cacheWrite1h: price(p.cache_write_1h ?? 0, `${f}.per_mtok.cache_write_1h`),
      },
      tiers,
      toolFeesUsd,
      outputIncludesReasoning: oir,
    };
  }
  if (Object.keys(models).length === 0) throw new PricingError("models: expected at least one model");
  return { models };
}

export function loadPricing(path: string): PricingTable {
  return parsePricing(readFileSync(path, "utf8"));
}

export function promptTokens(u: RequestUsage): number {
  return u.freshInput + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
}

export function computeCost(u: RequestUsage, p: PricingTable): CostBreakdown {
  const m = p.models[u.model];
  if (!m) throw new PricingError(`no pricing for model ${JSON.stringify(u.model)}`);
  const prompt = promptTokens(u);
  let tier = 0;
  let inMult = 1;
  let outMult = 1;
  for (const t of m.tiers) {
    if (prompt > t.abovePromptTokens) {
      tier = t.abovePromptTokens;
      inMult = t.inputMultiplier;
      outMult = t.outputMultiplier;
    }
  }
  const billedOutput = u.output + (m.outputIncludesReasoning ? 0 : u.reasoning);
  const r = m.perMtok;
  const inputUsd = u.freshInput * r.input + u.cacheRead * r.cacheRead + u.cacheWrite5m * r.cacheWrite5m + u.cacheWrite1h * r.cacheWrite1h;
  const tokenUsd = (inputUsd * inMult + billedOutput * r.output * outMult) / 1_000_000;
  const toolUsd = u.webSearches * (m.toolFeesUsd.web_search ?? 0);
  return { costUsd: tokenUsd + toolUsd, promptTokens: prompt, tier };
}

export interface UsageTotals {
  requests: number;
  freshInput: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  reasoning: number;
  webSearches: number;
}

export function sumUsage(us: RequestUsage[]): UsageTotals {
  const t: UsageTotals = { requests: 0, freshInput: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoning: 0, webSearches: 0 };
  for (const u of us) {
    t.requests++;
    t.freshInput += u.freshInput;
    t.cacheRead += u.cacheRead;
    t.cacheWrite5m += u.cacheWrite5m;
    t.cacheWrite1h += u.cacheWrite1h;
    t.output += u.output;
    t.reasoning += u.reasoning;
    t.webSearches += u.webSearches;
  }
  return t;
}
