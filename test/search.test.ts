// Web search relay: the relay handler (mocked Exa), the cost formula, token auth, the `websearch` CLI and
// billing of searches into the wake (src/search.ts, docker/search/relay.ts).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler, exaBody, formatResults, lookupToken, parseParams, type RelayDeps } from "../docker/search/relay.ts";
import { loadSwarm, parseAgent, parseSwarm, type SwarmConfig } from "../src/config.ts";
import { Controller } from "../src/controller/index.ts";
import { createRun } from "../src/controller/run.ts";
import type { ProcessHandle } from "../src/controller/wake.ts";
import { agentDirs, openDb, type AgentRow, type RequestRow, type WakeRow } from "../src/db/index.ts";
import { loadPricing, parsePricing, PricingError, searchCost } from "../src/pricing/index.ts";
import { renderReport } from "../src/report.ts";
import {
  checkSearchSetup,
  issueSearchToken,
  readSearchLog,
  revokeSearchToken,
  runSearchDirs,
  SEARCH_MODEL,
  searchDirs,
  searchHost,
  searchRows,
  searchRunArgs,
  tokenPath,
  type SearchLogEntry,
} from "../src/search.ts";

const dataDir = mkdtempSync(join(tmpdir(), "slopswarm-search-test-"));
process.env.SLOPSWARM_DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const EXA = readFileSync("test/fixtures/exa-search.synthetic.json", "utf8");
const KEY = "exa-test-key-do-not-log-0123456789";
const pricing = loadPricing("config/pricing.yaml");

function scratch(): ReturnType<typeof searchDirs> {
  const d = searchDirs(mkdtempSync(join(dataDir, "relay-")));
  mkdirSync(d.tokens, { recursive: true });
  mkdirSync(d.log, { recursive: true });
  return d;
}

function relay(d: ReturnType<typeof searchDirs>, over: Partial<RelayDeps> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const deps: RelayDeps = {
    apiKey: KEY,
    tokensFile: d.tokensFile,
    logFile: d.logFile,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(EXA, { status: 200, headers: { "content-type": "application/json" } });
    },
    now: Date.now,
    timeoutMs: 1000,
    ...over,
  };
  return { handler: createHandler(deps), calls };
}

const search = (token: string | null, body: unknown) =>
  new Request("http://relay:8080/search", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const tokenOf = (runtimeDir: string) => readFileSync(tokenPath(runtimeDir), "utf8").trim();

describe("relay request parsing", () => {
  test("defaults and validation", () => {
    expect(parseParams({ query: "  hello  " })).toEqual({ query: "hello", numResults: 8 });
    expect(parseParams({ query: "x", num_results: 3, include_domains: ["example.org"], start_published_date: "2026-01-02", category: "news" })).toEqual({
      query: "x",
      numResults: 3,
      includeDomains: ["example.org"],
      startPublishedDate: "2026-01-02",
      category: "news",
    });
    expect(parseParams({})).toContain("query");
    expect(parseParams({ query: "x", num_results: 0 })).toContain("num_results");
    expect(parseParams({ query: "x", num_results: 21 })).toContain("num_results");
    expect(parseParams({ query: "x", start_published_date: "yesterday" })).toContain("YYYY-MM-DD");
    expect(parseParams({ query: "x", include_domains: ["a b"] })).toContain("include_domains");
    expect(parseParams({ query: "x", category: "cats" })).toContain("category");
    expect(parseParams({ query: "x".repeat(501) })).toContain("500");
  });

  test("Exa body: auto, highlights capped, filters mapped", () => {
    expect(exaBody({ query: "q", numResults: 8 })).toEqual({ query: "q", type: "auto", numResults: 8, contents: { highlights: { maxCharacters: 2000 } } });
    expect(exaBody({ query: "q", numResults: 2, includeDomains: ["a.org"], startPublishedDate: "2026-10-01", category: "news" })).toMatchObject({
      includeDomains: ["a.org"],
      startPublishedDate: "2026-10-01T00:00:00.000Z",
      category: "news",
    });
  });

  test("formatted results are compact text", () => {
    const text = formatResults("agent costs", JSON.parse(EXA).results);
    expect(text).toStartWith("3 result(s) for: agent costs\n");
    expect(text).toContain("1. What it costs to keep an agent running\n   https://example.org/blog/agent-costs (2026-09-28)\n   Most of the cost of an idle agent is the first request of every wake: the system prompt");
    expect(text).toContain("3. (untitled)\n   https://example.net/no-highlights\n");
    expect(formatResults("nothing", [])).toBe("No results for: nothing");
  });
});

describe("relay handler", () => {
  test("auth: token for a running wake only", async () => {
    const d = scratch();
    const runtime = mkdtempSync(join(dataDir, "rt-"));
    const { handler, calls } = relay(d);
    expect((await handler(search(null, { query: "x" }))).status).toBe(401);
    expect((await handler(search("A".repeat(43), { query: "x" }))).status).toBe(401);

    issueSearchToken(d, runtime, "wren", 7);
    const token = tokenOf(runtime);
    expect(statSync(tokenPath(runtime)).mode & 0o777).toBe(0o600);
    // The relay's file holds only the token's hash.
    expect(readFileSync(d.tokensFile, "utf8")).not.toContain(token);
    expect(lookupToken(d.tokensFile, `Bearer ${token}`)).toEqual({ agent: "wren", wake: 7, search: true });

    // A new wake's token replaces the agent's old one.
    issueSearchToken(d, runtime, "wren", 8);
    expect(lookupToken(d.tokensFile, `Bearer ${token}`)).toBeNull();
    const token2 = tokenOf(runtime);
    expect((await handler(search(token2, { query: "x" }))).status).toBe(200);

    revokeSearchToken(d, 8);
    expect((await handler(search(token2, { query: "x" }))).status).toBe(401);
    expect(calls).toHaveLength(1);
    expect(readSearchLog(d.logFile)).toHaveLength(1); // unauthorised attempts are not logged
  });

  test("search: Exa request, compact answer, log line (no key anywhere)", async () => {
    const d = scratch();
    const runtime = mkdtempSync(join(dataDir, "rt-"));
    issueSearchToken(d, runtime, "wren", 3);
    const { handler, calls } = relay(d);
    const res = await handler(search(tokenOf(runtime), { query: "agent costs", num_results: 3, include_domains: ["example.org"] }));
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("1. What it costs to keep an agent running");

    expect(calls[0]!.url).toBe("https://api.exa.ai/search");
    expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      query: "agent costs",
      type: "auto",
      numResults: 3,
      contents: { highlights: { maxCharacters: 2000 } },
      includeDomains: ["example.org"],
    });

    const [e] = readSearchLog(d.logFile, 3);
    expect(e).toMatchObject({
      id: "b5947044c4b78efa9552a7c89b306d95",
      agent: "wren",
      wake: 3,
      query: "agent costs",
      params: { num_results: 3, include_domains: ["example.org"] },
      type: "auto",
      results: 3,
      pages: { highlights: 2 },
      exa_cost_usd: 0.007,
      status: 200,
      error: null,
    });
    expect(readFileSync(d.logFile, "utf8")).not.toContain(KEY);
    expect(body).not.toContain(KEY);
  });

  test("failures: no key, cap reached, timeout, provider down are short messages, logged, not billed", async () => {
    const d = scratch();
    const runtime = mkdtempSync(join(dataDir, "rt-"));
    issueSearchToken(d, runtime, "wren", 4);
    const t = tokenOf(runtime);
    const cases: [Partial<RelayDeps>, number, RegExp][] = [
      [{ apiKey: undefined }, 503, /search unavailable: no search provider key/],
      [{ fetch: async () => new Response('{"error":"credits exhausted"}', { status: 402 }) }, 402, /spend cap or credit/],
      [{ fetch: async () => new Response("{}", { status: 401 }) }, 503, /rejected the relay's key/],
      [{ fetch: async () => new Response("{}", { status: 500 }) }, 502, /provider error \(HTTP 500\)/],
      [{ fetch: async () => { throw new DOMException("timed out", "TimeoutError"); } }, 504, /timed out/],
      [{ fetch: async () => { throw new TypeError("connect ECONNREFUSED"); } }, 504, /unreachable/],
      [{ fetch: async () => new Response("not json", { status: 200 }) }, 502, /unreadable/],
    ];
    for (const [over, status, msg] of cases) {
      const res = await relay(d, over).handler(search(t, { query: "q" }));
      expect(res.status).toBe(status);
      expect(await res.text()).toMatch(msg);
    }
    expect((await relay(d).handler(search(t, "{nope"))).status).toBe(400);
    expect((await relay(d).handler(search(t, { query: "" }))).status).toBe(400);
    const log = readSearchLog(d.logFile, 4);
    expect(log).toHaveLength(cases.length); // invalid requests never reach Exa and are not logged
    expect(log.every((e) => e.error !== null)).toBe(true);
    expect(searchRows(pricing, log).rows).toHaveLength(0);
    expect(readFileSync(d.logFile, "utf8")).not.toContain(KEY);
  });

  test("health and routing", async () => {
    const d = scratch();
    expect(await (await relay(d).handler(new Request("http://relay/health"))).json()).toEqual({ ok: true, exa: true, webfetch: false });
    expect(await (await relay(d, { apiKey: undefined }).handler(new Request("http://relay/health"))).json()).toEqual({ ok: true, exa: false, webfetch: false });
    expect((await relay(d).handler(new Request("http://relay/search"))).status).toBe(405);
    expect((await relay(d).handler(new Request("http://relay/other"))).status).toBe(404);
  });
});

describe("search cost", () => {
  const e = (results: number, pages: Record<string, number>, type = "auto") => ({ model: SEARCH_MODEL, type, results, pages });
  test("Exa formula: base up to 10 results, extra results, pages per content type", () => {
    // Highlights are free on /search (live costDollars, 2026-10-11); text and summary pages cost $0.001 each.
    expect(searchCost(e(8, { highlights: 8 }), pricing)).toBeCloseTo(0.007, 10);
    expect(searchCost(e(0, {}), pricing)).toBeCloseTo(0.007, 10);
    expect(searchCost(e(15, { highlights: 15 }), pricing)).toBeCloseTo(0.007 + 5 * 0.001, 10);
    expect(searchCost(e(2, { highlights: 2, text: 1, summary: 2, unknown: 9 }), pricing)).toBeCloseTo(0.007 + 0.003, 10);
    // The fixture: our formula matches Exa's own costDollars.total.
    expect(searchCost(e(3, { highlights: 2 }), pricing)).toBeCloseTo(JSON.parse(EXA).costDollars.total, 10);
    expect(() => searchCost(e(1, {}, "deep"), pricing)).toThrow(PricingError);
    expect(() => searchCost({ ...e(1, {}), model: "nope" }, pricing)).toThrow(PricingError);
  });

  test("pricing.yaml search section: parsed, optional, validated", () => {
    expect(pricing.search[SEARCH_MODEL]).toMatchObject({ provider: "exa", includedResults: 10, perExtraResultUsd: 0.001 });
    const base = "models:\n  m:\n    per_mtok: { input: 1, output: 1, cache_read: 0.1 }\n";
    expect(parsePricing(base).search).toEqual({});
    expect(() => parsePricing(base + "search:\n  s:\n    per_request_usd: {}\n")).toThrow(PricingError);
    expect(() => parsePricing(base + "search:\n  s:\n    per_request_usd: { auto: -1 }\n")).toThrow(PricingError);
  });

  test("search rows: billed searches only, no tokens, one web search each", () => {
    const entry = (over: Partial<SearchLogEntry>): SearchLogEntry => ({
      id: "x", ts: "2026-10-11T10:00:00.000Z", agent: "wren", wake: 1, query: "q", params: {}, type: "auto",
      results: 8, pages: { highlights: 8 }, exa_cost_usd: 0.007, latency_ms: 500, status: 200, error: null, ...over,
    });
    const { rows, total } = searchRows(pricing, [entry({ id: "a" }), entry({ id: "b", status: 503, error: "no EXA_API_KEY", results: 0, pages: {} })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.u).toMatchObject({ requestId: "search:a", model: SEARCH_MODEL, freshInput: 0, output: 0, webSearches: 1 });
    expect(total).toBeCloseTo(0.007, 10);
  });
});

describe("config and setup", () => {
  test("search: native by default for claude/codex, relay on request; pi relay only", () => {
    const parse = (o: object) => parseAgent({ name: "a", model: "m", ...o }, 1, "x");
    const pi = { harness: "pi", provider: "openrouter" };
    expect(parse({ harness: "claude" }).search).toBe("native");
    expect(parse({ harness: "claude", search: "native" }).search).toBe("native");
    expect(parse({ harness: "claude", search: "relay" }).search).toBe("relay");
    expect(parse({ harness: "codex" }).search).toBe("native");
    expect(parse({ harness: "codex", search: "native" }).search).toBe("native");
    expect(parse({ harness: "codex", search: "relay" }).search).toBe("relay");
    expect(parse(pi).search).toBe("relay");
    expect(parse({ ...pi, search: "relay" }).search).toBe("relay");
    expect(() => parse({ ...pi, search: "native" })).toThrow("x.search: pi has no native search tool; use search: relay");
    expect(() => parse({ harness: "codex", search: "exa" })).toThrow("search");
  });

  test("start checks: pricing needed, missing key only warns", () => {
    const agents = [{ name: "wren", search: "relay" as const }] as SwarmConfig["agents"];
    expect(checkSearchSetup({ agents: [] }, pricing, {})).toEqual({ warnings: [] });
    expect(checkSearchSetup({ agents }, pricing, { EXA_API_KEY: "k" })).toEqual({ warnings: [] });
    expect(checkSearchSetup({ agents }, pricing, {}).warnings[0]).toContain("EXA_API_KEY is not set");
    expect(checkSearchSetup({ agents }, { ...pricing, search: {} }, {}).error).toContain("search.exa-search");
  });

  test("relay container: hardened, internal + egress, key by name, tokens read-only", () => {
    const argv = searchRunArgs({ runId: "r1", image: "img", network: "slopswarm-internal", dir: "/d", withKey: true });
    const s = argv.join(" ");
    for (const f of ["--cap-drop ALL", "--security-opt no-new-privileges", "--read-only", "--user 1000:1000", "--network slopswarm-internal", "--network slopswarm-egress", "-v /d/tokens:/tokens:ro", "-v /d/log:/log:rw", "-e EXA_API_KEY img"])
      expect(s).toContain(f);
    expect(s).not.toContain("-p ");
    expect(s).not.toMatch(/EXA_API_KEY=/);
    expect(searchRunArgs({ runId: "r1", image: "img", network: "n", dir: "/d", withKey: false }).join(" ")).not.toContain("EXA_API_KEY");
  });
});

const hasTools = ["bash", "curl", "jq"].every((t) => Bun.which(t));

describe.skipIf(!hasTools)("websearch CLI", () => {
  const d = scratch();
  const runtime = mkdtempSync(join(dataDir, "rt-"));
  let mode: "ok" | "cap" = "ok";
  const { handler, calls } = relay(d, {
    fetch: async (url, init) => {
      if (mode === "cap") return new Response("{}", { status: 402 });
      calls.push({ url, init });
      return new Response(EXA, { status: 200 });
    },
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  afterAll(() => server.stop(true));
  issueSearchToken(d, runtime, "wren", 11);

  const run = async (args: string[], env: Record<string, string> = {}) => {
    const p = Bun.spawn(["bash", "docker/websearch", ...args], {
      env: { PATH: process.env.PATH!, SLOPSWARM_SEARCH_URL: server.url.href, SLOPSWARM_SEARCH_TOKEN_FILE: tokenPath(runtime), ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  };

  test("searches with options; the token never in argv", async () => {
    const r = await run(["agent", "costs", "--n", "3", "--domain", "example.org", "--domain=news.example.com", "--since", "2026-10-01", "--news"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("3 result(s) for: agent costs");
    expect(JSON.parse(calls.at(-1)!.init.body as string)).toMatchObject({
      query: "agent costs",
      numResults: 3,
      includeDomains: ["example.org", "news.example.com"],
      startPublishedDate: "2026-10-01T00:00:00.000Z",
      category: "news",
    });
  });

  test("errors: short message on stderr, non-zero exit", async () => {
    mode = "cap";
    const cap = await run(["q"]);
    mode = "ok";
    expect(cap.code).toBe(1);
    expect(cap.err).toContain("websearch: search unavailable: the search provider's spend cap");
    expect((await run([])).code).toBe(2);
    expect((await run(["q", "--n", "lots"])).code).toBe(2);
    expect((await run(["q"], { SLOPSWARM_SEARCH_URL: "" })).code).toBe(3);
    const down = await run(["q"], { SLOPSWARM_SEARCH_URL: "http://127.0.0.1:9" });
    expect(down.code).toBe(1);
    expect(down.err).toContain("websearch: search relay unreachable");
    const badToken = join(runtime, "bad-token");
    writeFileSync(badToken, "x".repeat(43));
    const unauth = await run(["q"], { SLOPSWARM_SEARCH_TOKEN_FILE: badToken });
    expect(unauth.code).toBe(1);
    expect(unauth.err).toContain("not authorised");
  });
});

// A real Exa call, only when a key is in the environment (it costs ~$0.007).
describe.skipIf(!process.env.EXA_API_KEY?.trim())("live Exa", () => {
  test("one search through the relay handler", async () => {
    const d = scratch();
    const runtime = mkdtempSync(join(dataDir, "rt-"));
    issueSearchToken(d, runtime, "wren", 1);
    const handler = createHandler({ apiKey: process.env.EXA_API_KEY!.trim(), tokensFile: d.tokensFile, logFile: d.logFile, fetch: (u, i) => fetch(u, i), now: Date.now, timeoutMs: 25_000 });
    const res = await handler(search(tokenOf(runtime), { query: "Exa search API", num_results: 2 }));
    expect(res.status).toBe(200);
    const [e] = readSearchLog(d.logFile, 1);
    expect(e!.results).toBeGreaterThan(0);
    const ours = searchCost({ model: SEARCH_MODEL, type: e!.type, results: e!.results, pages: e!.pages }, pricing);
    console.log(`live Exa: ${e!.results} results, computed $${ours.toFixed(4)}, Exa $${e!.exa_cost_usd}`);
    expect(e!.exa_cost_usd).not.toBeNull();
    // Our formula (config/pricing.yaml) matches what Exa charged.
    expect(Math.abs(ours - e!.exa_cost_usd!)).toBeLessThan(0.0005);
  }, 30_000);
});

// ---------- billing into the wake ----------

const FIXTURE = readFileSync("test/fixtures/claude-tools.synthetic.jsonl", "utf8");
const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);

function config(): SwarmConfig {
  const base = loadSwarm("config/smoke.yaml");
  const parsed = parseSwarm(
    {
      run: { name: "search-test", max_duration_min: 120 },
      agents: ["wren", "bramble"],
      budgets: { swarm_usd: 1, per_agent_usd: 0.5, per_wake: { max_usd: 0.1, max_turns: 10, timeout_min: 5 } },
      scheduler: { max_sleep_min: 15, max_concurrent_wakes: 1 },
      controller: { tick_s: 1 },
      network: { name: "slopswarm-internal", proxy: "http://slopswarm-proxy:8888", allowlist: ["api.anthropic.com"] },
    },
    (name) => ({ name, harness: "claude", model: "claude-haiku-5-5", effort: "medium", ...(name === "wren" ? { search: "relay" } : {}) }),
  );
  return { ...parsed, paths: base.paths, snapshot: "# --- test\n" };
}

describe("searches billed to the wake", () => {
  beforeEach(() => {
    for (const d of ["runs"]) rmSync(join(dataDir, d), { recursive: true, force: true });
  });

  test("a relay search counts in the wake's cost, the agent's spend and the report", async () => {
    const db = openDb(":memory:");
    const cfg = config();
    const runId = createRun(db, cfg, {}, T0);
    const dirs = runSearchDirs(runId);
    mkdirSync(dirs.log, { recursive: true });
    const argvs: string[][] = [];
    const tokensSeen: Record<string, boolean> = {};
    const startProcess = (argv: string[]): ProcessHandle => {
      argvs.push(argv);
      const agent = argv.find((a) => a.startsWith("slopswarm.agent="))!.split("=")[1]!;
      const tp = tokenPath(agentDirs(runId, agent).runtime);
      tokensSeen[agent] = existsSync(tp);
      const done = (async () => {
        // The agent runs `websearch` once mid-wake: the relay authenticates its token and logs the search.
        if (agent === "wren") {
          const res = await relay(dirs).handler(search(readFileSync(tp, "utf8").trim(), { query: "agent costs" }));
          expect(res.status).toBe(200);
        }
      })();
      const stdout = new ReadableStream<Uint8Array>({
        async start(c) {
          await done;
          c.enqueue(new TextEncoder().encode(FIXTURE));
          c.close();
        },
      });
      return { stdout, exited: done.then(() => 0) };
    };
    const ctl = new Controller(db, runId, cfg, { forge: { unread: async () => 0 }, log: () => {}, now: () => T0, wakeDeps: { startProcess, killContainer: async () => {} } });

    ctl.tick();
    await ctl.whenIdle();
    ctl.tick();
    await ctl.whenIdle();

    const wake = (agent: string) => db.query<WakeRow, [string]>("SELECT * FROM wakes WHERE agent = ?").get(agent)!;
    const reqs = (id: number) => db.query<RequestRow, [number]>("SELECT * FROM requests WHERE wake_id = ? ORDER BY seq").all(id);
    const w = wake("wren");
    const b = wake("bramble");
    expect(w.exit_reason).toBe("completed");
    expect(w.requests).toBe(3); // model requests only
    expect(w.web_searches).toBe(b.web_searches + 1); // the fixture has a native search too
    const rows = reqs(w.id);
    const s = rows.find((r) => r.model === SEARCH_MODEL)!;
    expect(s).toMatchObject({ request_id: "search:b5947044c4b78efa9552a7c89b306d95", web_searches: 1, prompt_tokens: 0, output: 0 });
    expect(s.cost_usd).toBeCloseTo(0.007, 10);
    // Same model usage as bramble's wake, plus the search.
    expect(w.cost_usd).toBeCloseTo(b.cost_usd + 0.007, 10);
    const spent = db.query<AgentRow, [string]>("SELECT * FROM agents WHERE name = ?").get("wren")!.spent_usd;
    expect(spent).toBeCloseTo(w.cost_usd, 10);

    // Only the relay agent got a token, the relay's address and the prompt line; its token is revoked after the wake.
    expect(tokensSeen).toEqual({ wren: true, bramble: false });
    const env = (argv: string[], k: string) => argv.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);
    const argvOf = (agent: string) => argvs.find((v) => v.includes(`slopswarm.agent=${agent}`));
    const wa = argvOf("wren");
    const ba = argvOf("bramble");
    expect(env(wa!, "SLOPSWARM_SEARCH_URL")).toBe(`http://${searchHost(runId)}:8080`);
    expect(env(wa!, "SLOPSWARM_SEARCH_TOKEN_FILE")).toBe("/runtime/search/token");
    expect(env(wa!, "NO_PROXY")!.split(",")).toContain(searchHost(runId));
    expect(wa![wa!.indexOf("--system-prompt") + 1]).toContain('Web search, a shell command (run it with bash): `websearch "query"`');
    expect(env(ba!, "SLOPSWARM_SEARCH_URL")).toBeUndefined();
    expect(ba![ba!.indexOf("--system-prompt") + 1]).not.toContain("websearch");
    // The relay agent has Claude Code's own WebSearch tool turned off; the native one keeps it.
    expect(wa![wa!.indexOf("--tools") + 1]).toBe("Bash,Read,Write,Edit");
    expect(ba![ba!.indexOf("--tools") + 1]).toBe("Bash,Read,Write,Edit,WebSearch");
    expect(JSON.parse(readFileSync(dirs.tokensFile, "utf8"))).toEqual({});

    // The agent sees the search price in /self/pricing.yaml; the report shows searches and Exa's cross-check.
    expect(readFileSync(join(agentDirs(runId, "wren").self, "pricing.yaml"), "utf8")).toContain(SEARCH_MODEL);
    expect(readFileSync(join(agentDirs(runId, "bramble").self, "pricing.yaml"), "utf8")).not.toContain(SEARCH_MODEL);
    const report = renderReport(db, runId, T0 + 60_000);
    expect(report).toContain("API requests: 6, relay web searches: 1");
    expect(report).toContain("## Web search (relay)");
    expect(report).toContain("1 search(es) billed, $0.0070 computed");
    expect(report).toContain("Exa reported $0.0070 for 1 of them");
  });
});
