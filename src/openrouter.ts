// OpenRouter: the public model catalogue (prices, model metadata for pi) and the per-generation cost lookup
// (plan docs/plans/2026-10-11-openrouter.md §2). Keys are passed in by the caller and never logged.
import type { AgentConfig } from "./config.ts";
import { parsePricing, priceKey, PricingError } from "./pricing/index.ts";

export const OPENROUTER_API = "https://openrouter.ai/api/v1";
/** Output cap written into pi's models.json; the catalogue's (up to ~1M) is rejected by some providers. */
export const PI_MAX_OUTPUT_TOKENS = 32_768;

/** The parts of a `GET /api/v1/models` entry we use. Prices are strings, USD per token (web_search: per call). */
export interface CatalogueModel {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
  top_provider?: { max_completion_tokens?: number | null };
  supported_parameters?: string[];
  reasoning?: { mandatory?: boolean; supported_efforts?: string[] } | null;
  pricing?: Record<string, unknown> & { overrides?: Record<string, unknown>[] };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The public catalogue (no key). */
export async function fetchCatalogue(fetchFn: Fetch = fetch): Promise<CatalogueModel[]> {
  const r = await fetchFn(`${OPENROUTER_API}/models`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`OpenRouter catalogue: HTTP ${r.status}`);
  const body = (await r.json()) as { data?: CatalogueModel[] };
  if (!Array.isArray(body.data)) throw new Error("OpenRouter catalogue: no data");
  return body.data;
}

/**
 * The catalogue entry a model string is priced as: the slug before `@`; a `:suffix` that is not a catalogue
 * entry of its own (`:batch` is, `:nitro` routing is not) falls back to the base slug.
 */
export function catalogueEntry(catalogue: CatalogueModel[], model: string): CatalogueModel | undefined {
  const key = priceKey(model);
  const byId = (id: string) => catalogue.find((m) => m.id === id);
  const colon = key.lastIndexOf(":");
  return byId(key) ?? (colon > 0 ? byId(key.slice(0, colon)) : undefined);
}

/** USD per token (string) -> USD per million tokens, without float noise. Undefined if absent. */
function perMtok(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const x = Number(v);
  if (!Number.isFinite(x) || x < 0) throw new PricingError(`${field}: not a price (${JSON.stringify(v)})`);
  return Number((x * 1e6).toPrecision(12));
}

const FIELDS = [
  ["prompt", "input"],
  ["completion", "output"],
  ["input_cache_read", "cache_read"],
  ["input_cache_write", "cache_write_5m"],
  ["input_cache_write_1h", "cache_write_1h"],
] as const;

/**
 * One model's entry for the pricing YAML, from its catalogue prices (list prices; the provider a preset routes
 * to may charge less, which the generation cross-check shows). Models without a cache-write price pay 0 for it.
 * `overrides` with `min_prompt_tokens` become absolute-price tiers; time-window discounts are not modelled.
 */
export function pricingEntry(m: CatalogueModel): Record<string, unknown> {
  const p = m.pricing ?? {};
  const base: Record<string, number> = {};
  for (const [from, to] of FIELDS) base[to] = perMtok(p[from], `${m.id}.pricing.${from}`) ?? 0;
  if (perMtok(p.prompt, `${m.id}.pricing.prompt`) === undefined || perMtok(p.completion, `${m.id}.pricing.completion`) === undefined)
    throw new PricingError(`${m.id}: the catalogue has no prompt/completion price`);
  const tiers = (Array.isArray(p.overrides) ? p.overrides : [])
    .filter((o) => typeof o?.min_prompt_tokens === "number" && o.min_prompt_tokens > 0)
    .map((o) => {
      const per: Record<string, number> = {};
      for (const [from, to] of FIELDS) {
        const v = perMtok(o[from], `${m.id}.pricing.overrides.${from}`);
        if (v !== undefined) per[to] = v;
      }
      // OpenRouter: the override applies from min_prompt_tokens on; our tiers apply strictly above a threshold.
      return { above_prompt_tokens: (o.min_prompt_tokens as number) - 1, per_mtok: per };
    });
  const search = p.web_search === undefined ? undefined : Number(p.web_search);
  return {
    provider: "openrouter",
    per_mtok: base,
    ...(tiers.length ? { tiers } : {}),
    ...(search !== undefined && Number.isFinite(search) && search > 0 ? { tool_fees_usd: { web_search: search } } : {}),
    // pi reports reasoning inside output (and OpenRouter bills internal_reasoning at the completion price).
    output_includes_reasoning: true,
  };
}

/**
 * The run's pricing snapshot: the hand-written YAML plus fetched entries for the OpenRouter models the run uses
 * that it doesn't price already (a hand-written price wins). Throws if a model is in neither.
 * The entries are inserted as text into the `models:` block so the rest of the file stays as it is.
 */
export function mergePricing(baseYaml: string, models: string[], catalogue: CatalogueModel[], fetchedAt: Date): string {
  const base = parsePricing(baseYaml);
  const added: [string, Record<string, unknown>][] = [];
  for (const model of new Set(models.map(priceKey))) {
    if (base.models[model] || added.some(([k]) => k === model)) continue;
    const m = catalogueEntry(catalogue, model);
    if (!m) throw new PricingError(`${model}: not in the OpenRouter catalogue and not in config/pricing.yaml`);
    added.push([model, pricingEntry(m)]);
  }
  if (!added.length) return baseYaml;
  const stamp = fetchedAt.toISOString().replace(/\.\d+Z$/, "Z");
  const block = added
    .map(([key, e]) => {
      const lines = [``, `  ${JSON.stringify(key)}:`, `    # list price from ${OPENROUTER_API}/models, fetched ${stamp}`];
      for (const [k, v] of Object.entries(e)) lines.push(`    ${k}: ${JSON.stringify(v)}`);
      return lines.join("\n");
    })
    .join("\n");
  // Insert at the end of the `models:` block, before the next top-level key (other sections stay verbatim).
  const lines = baseYaml.replace(/\s*$/, "").split("\n");
  const start = lines.findIndex((l) => /^models:\s*(#.*)?$/.test(l));
  let end = lines.length;
  if (start >= 0) {
    const next = lines.findIndex((l, i) => i > start && /^[^\s#]/.test(l));
    if (next >= 0) {
      end = next;
      while (end > start + 1 && (!lines[end - 1]!.trim() || lines[end - 1]!.startsWith("#"))) end--;
    }
  }
  const text = [...lines.slice(0, end), block, ...(end < lines.length ? ["", ...lines.slice(end)] : [])].join("\n") + "\n";
  const want = { ...(Bun.YAML.parse(baseYaml) as Record<string, any>) };
  want.models = { ...want.models, ...Object.fromEntries(added) };
  try {
    if (JSON.stringify(Bun.YAML.parse(text)) === JSON.stringify(want)) return text;
  } catch {
    // Unexpected layout (e.g. a flow-style `models:`): re-emit below.
  }
  return `${Bun.YAML.stringify(want, null, 2)}\n`;
}

/** pi's names for its thinking levels, and OpenRouter's for reasoning efforts. */
const PI_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * pi's models.json entry for an agent's model string (presets included): pi otherwise treats an unknown id as a
 * copy of the provider's default model. Metadata comes from the catalogue, like pi's own OpenRouter catalogue.
 */
export function piModelEntry(model: string, m: CatalogueModel): Record<string, unknown> {
  const efforts = m.reasoning?.supported_efforts;
  const reasoning = !!m.reasoning || (m.supported_parameters ?? []).includes("reasoning");
  const input = (m.architecture?.input_modalities ?? ["text"]).filter((x) => x === "text" || x === "image");
  const maxOut = m.top_provider?.max_completion_tokens;
  return {
    id: model,
    name: model === m.id ? (m.name ?? m.id) : `${m.name ?? m.id} (${model.slice(priceKey(model).length) || model})`,
    reasoning,
    ...(reasoning && Array.isArray(efforts)
      ? {
          thinkingLevelMap: {
            off: efforts.includes("none") ? "none" : null,
            ...Object.fromEntries(PI_LEVELS.map((l) => [l, efforts.includes(l) ? l : null])),
          },
        }
      : {}),
    input: input.length ? input : ["text"],
    ...(m.context_length ? { contextWindow: m.context_length } : {}),
    maxTokens: Math.min(PI_MAX_OUTPUT_TOKENS, typeof maxOut === "number" && maxOut > 0 ? maxOut : PI_MAX_OUTPUT_TOKENS),
    compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter", sendSessionAffinityHeaders: true },
  };
}

/** models.json for pi: one OpenRouter entry per model string. */
export function piModelsJson(entries: Record<string, unknown>[]): unknown {
  return { providers: { openrouter: { models: entries } } };
}

/** Fetched pricing and pi model entries for a run's OpenRouter agents. */
export interface OpenRouterSetup {
  pricingYaml: string;
  /** Agent name -> models.json content. */
  piModels: Record<string, unknown>;
}

/** Everything a run with OpenRouter agents needs from the catalogue, fetched once at run start. */
export async function prepareOpenRouter(agents: AgentConfig[], baseYaml: string, fetchFn: Fetch = fetch, now = new Date()): Promise<OpenRouterSetup> {
  const or = agents.filter((a) => a.provider === "openrouter");
  if (!or.length) return { pricingYaml: baseYaml, piModels: {} };
  const catalogue = await fetchCatalogue(fetchFn);
  const pricingYaml = mergePricing(baseYaml, or.map((a) => a.model), catalogue, now);
  const piModels: Record<string, unknown> = {};
  for (const a of or.filter((x) => x.harness === "pi")) {
    const m = catalogueEntry(catalogue, a.model);
    if (!m) throw new PricingError(`${a.name}: ${priceKey(a.model)} is not in the OpenRouter catalogue`);
    piModels[a.name] = piModelsJson([piModelEntry(a.model, m)]);
  }
  return { pricingYaml, piModels };
}

/** What OpenRouter charged for one generation, and which provider served it. */
export interface VendorCost {
  costUsd: number;
  provider: string | null;
}

/**
 * `GET /api/v1/generation?id=…` for each id (with the key). A generation can take a few seconds to appear, so a
 * 404 is retried. Ids that never resolve are left out; failures never throw.
 */
export async function generationCosts(
  ids: string[],
  key: string,
  opts: { fetchFn?: Fetch; sleep?: (ms: number) => Promise<unknown>; attempts?: number; delayMs?: number } = {},
): Promise<Map<string, VendorCost>> {
  const { fetchFn = fetch, sleep = Bun.sleep, attempts = 4, delayMs = 2000 } = opts;
  const out = new Map<string, VendorCost>();
  let pending = [...new Set(ids)];
  for (let i = 0; i < attempts && pending.length; i++) {
    if (i > 0) await sleep(delayMs * i);
    const retry: string[] = [];
    for (const id of pending) {
      try {
        const r = await fetchFn(`${OPENROUTER_API}/generation?id=${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (r.status === 404 || r.status === 429 || r.status >= 500) {
          retry.push(id);
          continue;
        }
        if (!r.ok) continue;
        const d = ((await r.json()) as { data?: { total_cost?: unknown; provider_name?: unknown } }).data;
        if (typeof d?.total_cost === "number") out.set(id, { costUsd: d.total_cost, provider: typeof d.provider_name === "string" ? d.provider_name : null });
      } catch {
        retry.push(id);
      }
    }
    pending = retry;
  }
  return out;
}
