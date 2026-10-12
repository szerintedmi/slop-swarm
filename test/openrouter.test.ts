// OpenRouter: catalogue -> pricing snapshot and pi's models.json, the generation cost lookup, agent config.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseAgent, parseSwarm } from "../src/config.ts";
import { secretEnv } from "../src/controller/wake.ts";
import { dockerProcessEnv, dockerRunArgs } from "../src/docker.ts";
import { catalogueEntry, generationCosts, mergePricing, piModelEntry, prepareOpenRouter, pricingEntry, type CatalogueModel } from "../src/openrouter.ts";
import { computeCost, parsePricing, priceKey } from "../src/pricing/index.ts";
import type { RequestUsage } from "../src/types.ts";

// Trimmed entries of GET https://openrouter.ai/api/v1/models (2026-10-11).
const GLM: CatalogueModel = {
  id: "z-ai/glm-5.3-flash",
  name: "Z.ai: GLM 5.3 Flash",
  context_length: 1048576,
  architecture: { input_modalities: ["text", "image", "video"] },
  top_provider: { max_completion_tokens: 943717 },
  supported_parameters: ["reasoning", "tools"],
  reasoning: { mandatory: true, supported_efforts: ["max", "high", "low"] },
  pricing: { prompt: "0.00000015", completion: "0.0000005", input_cache_read: "0.00000003" },
};
const GLM_BATCH: CatalogueModel = { ...GLM, id: "z-ai/glm-5.3-flash:batch", pricing: { prompt: "0.00000006", completion: "0.0000002" } };
const HAIKU: CatalogueModel = {
  id: "anthropic/claude-haiku-5.5",
  pricing: {
    prompt: "0.0000001",
    completion: "0.0000005",
    web_search: "0.01",
    input_cache_read: "0.00000001",
    input_cache_write: "0.000000125",
    input_cache_write_1h: "0.0000002",
    overrides: [
      { min_prompt_tokens: 100000, prompt: "0.0000005", completion: "0.0000025", input_cache_read: "0.00000005" },
      { utc_start: "00:00", utc_end: "08:00", prompt: "0.00000001", completion: "0.00000001" },
    ],
  },
};
const CATALOGUE = [GLM, GLM_BATCH, HAIKU];
const PRESET = "z-ai/glm-5.3-flash@preset/sw-glm-5-3-flash";
const BASE = readFileSync("config/pricing.yaml", "utf8");

const usage = (model: string, o: Partial<RequestUsage> = {}): RequestUsage => ({
  requestId: "r", model, freshInput: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoning: 0, webSearches: 0, ...o,
});

describe("catalogue -> pricing", () => {
  test("price key: the slug before @; a :suffix that isn't its own entry falls back to the base slug", () => {
    expect(priceKey(PRESET)).toBe("z-ai/glm-5.3-flash");
    expect(priceKey("gpt-6-luna")).toBe("gpt-6-luna");
    expect(catalogueEntry(CATALOGUE, "z-ai/glm-5.3-flash:batch@preset/x")).toBe(GLM_BATCH);
    expect(catalogueEntry(CATALOGUE, "z-ai/glm-5.3-flash:nitro")).toBe(GLM);
    expect(catalogueEntry(CATALOGUE, "nope/model")).toBeUndefined();
  });

  test("per-token strings become per-Mtok; no cache-write price = 0; overrides become absolute tiers", () => {
    expect(pricingEntry(GLM)).toEqual({
      provider: "openrouter",
      per_mtok: { input: 0.15, output: 0.5, cache_read: 0.03, cache_write_5m: 0, cache_write_1h: 0 },
      output_includes_reasoning: true,
    });
    const h = pricingEntry(HAIKU);
    expect(h.per_mtok).toEqual({ input: 0.1, output: 0.5, cache_read: 0.01, cache_write_5m: 0.125, cache_write_1h: 0.2 });
    // The time-window override is not modelled.
    expect(h.tiers).toEqual([{ above_prompt_tokens: 99999, per_mtok: { input: 0.5, output: 2.5, cache_read: 0.05 } }]);
    expect(h.tool_fees_usd).toEqual({ web_search: 0.01 });
    expect(() => pricingEntry({ id: "x/router", pricing: { prompt: "-1", completion: "-1" } })).toThrow();
  });

  test("absolute tiers price the whole request; fields they lack keep the base price", () => {
    const yaml = mergePricing(BASE, ["anthropic/claude-haiku-5.5"], CATALOGUE, new Date("2026-10-11T00:00:00Z"));
    const p = parsePricing(yaml);
    const small = computeCost(usage("anthropic/claude-haiku-5.5", { freshInput: 1000, output: 100 }), p);
    expect(small.costUsd).toBeCloseTo((1000 * 0.1 + 100 * 0.5) / 1e6, 12);
    const big = computeCost(usage("anthropic/claude-haiku-5.5", { freshInput: 100_000, cacheWrite5m: 1000, output: 100 }), p);
    expect(big.tier).toBe(99999);
    expect(big.costUsd).toBeCloseTo((100_000 * 0.5 + 1000 * 0.125 + 100 * 2.5) / 1e6, 12);
  });

  test("mergePricing: text inserted into models:, other top-level sections verbatim, hand-written price wins", () => {
    // config/pricing.yaml has a `search:` section after `models:`; it must stay verbatim and in place.
    const searchAt = BASE.indexOf("\nsearch:");
    expect(searchAt).toBeGreaterThan(0);
    const text = mergePricing(BASE, [PRESET, "gpt-6-luna"], CATALOGUE, new Date("2026-10-11T00:00:00Z"));
    expect(text.trimEnd().endsWith(BASE.slice(searchAt).trimEnd())).toBe(true);
    expect(text).toContain("# list price from https://openrouter.ai/api/v1/models, fetched 2026-10-11T00:00:00Z");
    const parsed = Bun.YAML.parse(text) as any;
    expect(parsed.search).toEqual((Bun.YAML.parse(BASE) as any).search);
    expect(Object.keys(parsed.models)).toEqual(["claude-haiku-5-5", "gpt-6-luna", "z-ai/glm-5.3-flash"]);
    expect(parsePricing(text).models["gpt-6-luna"]!.provider).toBe("openai");
    expect(mergePricing(BASE, ["gpt-6-luna"], CATALOGUE, new Date())).toBe(BASE);
    expect(() => mergePricing(BASE, ["nope/model@preset/x"], CATALOGUE, new Date())).toThrow(/not in the OpenRouter catalogue/);
  });
});

describe("pi models.json", () => {
  test("an entry for the literal preset id, metadata from the catalogue, output capped", () => {
    expect(piModelEntry(PRESET, GLM)).toEqual({
      id: PRESET,
      name: "Z.ai: GLM 5.3 Flash (@preset/sw-glm-5-3-flash)",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
      input: ["text", "image"],
      contextWindow: 1048576,
      maxTokens: 32768,
      compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter", sendSessionAffinityHeaders: true },
    });
  });

  test("prepareOpenRouter: one catalogue fetch, pricing + models.json per pi agent; nothing without OpenRouter agents", async () => {
    let fetches = 0;
    const fetchFn = async (url: string) => {
      fetches++;
      expect(url).toBe("https://openrouter.ai/api/v1/models");
      return new Response(JSON.stringify({ data: CATALOGUE }));
    };
    const fern = parseAgent({ name: "fern", harness: "pi", provider: "openrouter", model: PRESET }, 1, "fern");
    const bramble = parseAgent({ name: "bramble", harness: "claude", model: "claude-haiku-5-5" }, 1, "bramble");
    const s = await prepareOpenRouter([fern, bramble], BASE, fetchFn as typeof fetch);
    expect(fetches).toBe(1);
    expect(parsePricing(s.pricingYaml).models["z-ai/glm-5.3-flash"]).toBeDefined();
    expect((s.piModels.fern as any).providers.openrouter.models[0].id).toBe(PRESET);
    expect(await prepareOpenRouter([bramble], BASE, fetchFn as typeof fetch)).toEqual({ pricingYaml: BASE, piModels: {} });
    expect(fetches).toBe(1);
  });
});

describe("generation cost lookup", () => {
  test("retries a not-yet-available generation, skips ones that never resolve, sends the key as a bearer token", async () => {
    const calls: Record<string, number> = {};
    const fetchFn = async (url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer k");
      const id = new URL(url).searchParams.get("id")!;
      calls[id] = (calls[id] ?? 0) + 1;
      if (id === "gen-late" && calls[id] < 2) return new Response("{}", { status: 404 });
      if (id === "gen-gone") return new Response("{}", { status: 404 });
      if (id === "gen-bad") return new Response("{}", { status: 401 });
      return new Response(JSON.stringify({ data: { total_cost: 0.000055331, provider_name: "StreamLake" } }));
    };
    const out = await generationCosts(["gen-ok", "gen-late", "gen-gone", "gen-bad"], "k", { fetchFn: fetchFn as typeof fetch, sleep: async () => {}, attempts: 3 });
    expect([...out.keys()].sort()).toEqual(["gen-late", "gen-ok"]);
    expect(out.get("gen-ok")).toEqual({ costUsd: 0.000055331, provider: "StreamLake" });
    expect(calls["gen-gone"]).toBe(3);
    expect(calls["gen-bad"]).toBe(1);
  });

  test("generation lookups stop at the deadline: what resolved by then is kept", async () => {
    let t = 0;
    const fetchFn = async (url: string) => {
      t += 10_000; // each lookup takes 10 s
      const id = new URL(url).searchParams.get("id")!;
      return id === "gen-a" ? Response.json({ data: { total_cost: 0.001, provider_name: "P" } }) : new Response("", { status: 404 });
    };
    const out = await generationCosts(["gen-a", "gen-b", "gen-c", "gen-d"], "k", { fetchFn: fetchFn as unknown as typeof fetch, sleep: async () => {}, now: () => t, deadlineMs: 25_000 });
    expect([...out.keys()]).toEqual(["gen-a"]);
    expect(t).toBe(30_000);
  });
});

describe("agent config", () => {
  test("provider defaults to native; pi needs openrouter and vice versa; key_env defaults and is validated", () => {
    expect(parseAgent({ name: "bramble", harness: "claude", model: "m" }, 1, "a")).toMatchObject({ provider: "native" });
    expect(parseAgent({ name: "bramble", harness: "claude", model: "m" }, 1, "a").keyEnv).toBeUndefined();
    expect(parseAgent({ name: "fern", harness: "pi", provider: "openrouter", model: PRESET }, 1, "a")).toMatchObject({ keyEnv: "OPEN_ROUTER_API_KEY" });
    expect(parseAgent({ name: "fern", harness: "pi", provider: "openrouter", model: PRESET, key_env: "OR_KEY_GLM" }, 1, "a").keyEnv).toBe("OR_KEY_GLM");
    expect(() => parseAgent({ name: "fern", harness: "pi", model: PRESET }, 1, "a")).toThrow(/provider: openrouter/);
    expect(() => parseAgent({ name: "fern", harness: "codex", provider: "openrouter", model: "m" }, 1, "a")).toThrow(/provider: openrouter/);
    expect(() => parseAgent({ name: "fern", harness: "pi", provider: "openrouter", model: PRESET, key_env: "sk-or-v1-abc" }, 1, "a")).toThrow(/key_env/);
    expect(() => parseAgent({ name: "bramble", harness: "claude", model: "m", key_env: "X" }, 1, "a")).toThrow(/key_env/);
  });

  test("a run with OpenRouter agents needs openrouter.ai on the allowlist", () => {
    const swarm = (allowlist: string[]) => ({
      run: { name: "t", max_duration_min: 60 },
      agents: ["fern"],
      budgets: { swarm_usd: 1, per_agent_usd: 1, per_wake: { max_usd: 0.1, max_turns: 10, timeout_min: 5 } },
      scheduler: { max_sleep_min: 15 },
      network: { name: "n", proxy: "http://p:8888", allowlist },
    });
    const fern = (name: string) => ({ name, harness: "pi", provider: "openrouter", model: PRESET });
    expect(() => parseSwarm(swarm(["api.anthropic.com"]), fern)).toThrow(/openrouter\.ai/);
    expect(parseSwarm(swarm(["openrouter.ai"]), fern).agents[0]!.provider).toBe("openrouter");
  });

  test("the sample agent parses", () => {
    const fern = parseAgent(Bun.YAML.parse(readFileSync("config/agents/fern.yaml", "utf8")), 1, "fern");
    expect(fern).toMatchObject({ harness: "pi", provider: "openrouter", model: PRESET, keyEnv: "OPEN_ROUTER_API_KEY" });
  });

  test("the key reaches the container by name only, renamed to OPENROUTER_API_KEY", () => {
    const fern = parseAgent({ name: "fern", harness: "pi", provider: "openrouter", model: PRESET, key_env: "OR_KEY_GLM" }, 1, "a");
    const passEnv = secretEnv(fern);
    expect(passEnv).toEqual([{ name: "OPENROUTER_API_KEY", from: "OR_KEY_GLM" }]);
    const args = dockerRunArgs({
      name: "c", image: "i", runId: "r", agent: "fern", mounts: { home: "/h", self: "/s", runtime: "/r" }, env: {}, passEnv,
      argv: ["pi"], network: "n", proxy: "http://p:8888", limits: { cpus: 1, memoryGb: 1, pidsLimit: 64 },
    });
    expect(args[args.indexOf("OPENROUTER_API_KEY") - 1]).toBe("-e");
    expect(args.some((a) => a.includes("secret-value"))).toBe(false);
    const env = dockerProcessEnv({ passEnv }, { OR_KEY_GLM: "secret-value", PATH: "/bin" });
    expect(env).toEqual({ OR_KEY_GLM: "secret-value", PATH: "/bin", OPENROUTER_API_KEY: "secret-value" });
    expect(secretEnv(parseAgent({ name: "bramble", harness: "claude", model: "m" }, 1, "a"))).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
  });
});
