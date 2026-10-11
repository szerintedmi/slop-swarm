// Web search relay (docs/plans/2026-10-11-openrouter.md §3): the agents' only way to search the web
// from a runtime without a native search tool. One container per run (`slopswarm-search-<run>`), on the
// internal network (agents reach it) and the egress network (it reaches Exa). It only ever calls
// EXA_URL; the API key comes from its env and never appears in a response or a log line.
//
//   POST /search  Authorization: Bearer <token>   {query, num_results?, include_domains?, start_published_date?, category?}
//   GET  /health
//
// Tokens: the controller writes `{ "<sha256 of token>": {agent, wake} }` to /tokens/tokens.json (read-only
// here) for every running wake that may search, and removes the entry when the wake ends.
// Every search that passes auth is appended to /log/search.jsonl before the response goes out; the
// controller ingests that file, prices each search from the run's pricing snapshot and bills the wake.
// Self-contained (no imports from src/): it is the whole build context of docker/search/Dockerfile.
import { appendFileSync, readFileSync } from "node:fs";

export const EXA_URL = "https://api.exa.ai/search";
export const DEFAULT_RESULTS = 8;
/** Caps what one search can cost (Exa bills per result above 10). */
export const MAX_RESULTS = 20;
export const HIGHLIGHT_CHARS = 2000;
const MAX_QUERY_CHARS = 500;
const MAX_DOMAINS = 10;
const CATEGORIES = ["news", "company", "research paper", "publication", "personal site", "financial report", "people"] as const;

/** One line of search.jsonl. Read by src/search.ts (keep the two in step). */
export interface SearchLogEntry {
  /** Unique per search; Exa's requestId when there is one. */
  id: string;
  ts: string;
  agent: string;
  wake: number;
  query: string;
  /** What was asked of Exa (num_results, include_domains, …). */
  params: Record<string, unknown>;
  /** Exa search type sent (prices differ by type). */
  type: string;
  /** Results returned. */
  results: number;
  /** Returned pages per content type, e.g. {highlights: 8}. */
  pages: Record<string, number>;
  /** Exa's own costDollars.total (cross-check), null if Exa didn't answer. */
  exa_cost_usd: number | null;
  latency_ms: number;
  /** HTTP status we answered with. */
  status: number;
  /** Short reason when the search failed (Exa never billed us, as far as we know). */
  error: string | null;
}

export interface RelayDeps {
  apiKey: string | undefined;
  tokensFile: string;
  logFile: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  timeoutMs: number;
}

interface ExaResult {
  title?: string | null;
  url?: string;
  publishedDate?: string | null;
  author?: string | null;
  highlights?: string[];
  text?: string;
  summary?: string;
}
interface ExaResponse {
  requestId?: string;
  results?: ExaResult[];
  costDollars?: { total?: number };
}

const text = (body: string, status = 200) => new Response(body.endsWith("\n") ? body : body + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8" } });

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

/** The agent + wake a bearer token belongs to, or null. The tokens file is re-read every time (tiny, rewritten per wake). */
export function lookupToken(tokensFile: string, header: string | null): { agent: string; wake: number } | null {
  const m = /^Bearer\s+([A-Za-z0-9_-]{16,200})\s*$/.exec(header ?? "");
  if (!m) return null;
  let map: Record<string, { agent?: unknown; wake?: unknown }>;
  try {
    map = JSON.parse(readFileSync(tokensFile, "utf8"));
  } catch {
    return null;
  }
  const hit = map[sha256(m[1]!)];
  if (!hit || typeof hit.agent !== "string" || typeof hit.wake !== "number") return null;
  return { agent: hit.agent, wake: hit.wake };
}

export interface SearchParams {
  query: string;
  numResults: number;
  includeDomains?: string[];
  startPublishedDate?: string;
  category?: string;
}

/** Validate the agent's request body. Returns the params or a short error for the agent. */
export function parseParams(body: unknown): SearchParams | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "expected a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.query !== "string" || !b.query.trim()) return "query: expected a non-empty string";
  const query = b.query.trim();
  if (query.length > MAX_QUERY_CHARS) return `query: at most ${MAX_QUERY_CHARS} characters`;
  const n = b.num_results ?? DEFAULT_RESULTS;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_RESULTS) return `num_results: expected an integer 1–${MAX_RESULTS}`;
  const p: SearchParams = { query, numResults: n };
  if (b.include_domains !== undefined) {
    const d = b.include_domains;
    if (!Array.isArray(d) || !d.length || d.length > MAX_DOMAINS || !d.every((x) => typeof x === "string" && /^[A-Za-z0-9.*\/_-]{1,200}$/.test(x)))
      return `include_domains: expected 1–${MAX_DOMAINS} domains`;
    p.includeDomains = d as string[];
  }
  if (b.start_published_date !== undefined) {
    const s = b.start_published_date;
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) return "start_published_date: expected YYYY-MM-DD";
    p.startPublishedDate = s;
  }
  if (b.category !== undefined) {
    if (!CATEGORIES.includes(b.category as (typeof CATEGORIES)[number])) return `category: expected one of ${CATEGORIES.join(", ")}`;
    p.category = b.category as string;
  }
  return p;
}

/** Exa /search request body (https://exa.ai/docs/reference/search). */
export function exaBody(p: SearchParams): Record<string, unknown> {
  return {
    query: p.query,
    type: "auto",
    numResults: p.numResults,
    contents: { highlights: { maxCharacters: HIGHLIGHT_CHARS } },
    ...(p.includeDomains ? { includeDomains: p.includeDomains } : {}),
    ...(p.startPublishedDate ? { startPublishedDate: `${p.startPublishedDate}T00:00:00.000Z` } : {}),
    ...(p.category ? { category: p.category } : {}),
  };
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Compact, readable results for the agent: title, url, date, highlights. */
export function formatResults(query: string, results: ExaResult[]): string {
  if (!results.length) return `No results for: ${query}`;
  const out = [`${results.length} result(s) for: ${query}`, ""];
  results.forEach((r, i) => {
    const date = r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : "";
    out.push(`${i + 1}. ${squash(r.title || "(untitled)")}`);
    out.push(`   ${r.url ?? ""}${date}`);
    for (const h of r.highlights ?? []) if (squash(h)) out.push(`   ${squash(h)}`);
    out.push("");
  });
  return out.join("\n");
}

/** Pages returned per content type (what Exa bills contents by). */
export function pagesByContent(results: ExaResult[]): Record<string, number> {
  const pages: Record<string, number> = {};
  for (const r of results)
    for (const k of ["highlights", "text", "summary"] as const) {
      const v = r[k];
      if (Array.isArray(v) ? v.length : v) pages[k] = (pages[k] ?? 0) + 1;
    }
  return pages;
}

function exaError(status: number): { status: number; msg: string } {
  if (status === 402) return { status: 402, msg: "search unavailable: the search provider's spend cap or credit is used up" };
  if (status === 429) return { status: 429, msg: "search rate-limited by the provider; try again in a minute" };
  if (status === 401 || status === 403) return { status: 503, msg: "search unavailable: the provider rejected the relay's key" };
  if (status === 400) return { status: 400, msg: "the provider rejected the request (check the options)" };
  return { status: 502, msg: `search provider error (HTTP ${status}); try again later` };
}

export function createHandler(deps: RelayDeps): (req: Request) => Promise<Response> {
  const log = (e: SearchLogEntry) => appendFileSync(deps.logFile, JSON.stringify(e) + "\n");
  return async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/health" && req.method === "GET") return Response.json({ ok: true, exa: !!deps.apiKey });
    if (url.pathname !== "/search") return text("not found", 404);
    if (req.method !== "POST") return text("use POST /search", 405);
    const who = lookupToken(deps.tokensFile, req.headers.get("authorization"));
    if (!who) return text("search: not authorised (no valid token for a running wake)", 401);

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return text("search: body must be JSON", 400);
    }
    const p = parseParams(raw);
    if (typeof p === "string") return text(`search: ${p}`, 400);

    const started = deps.now();
    const entry: SearchLogEntry = {
      id: crypto.randomUUID(),
      ts: new Date(started).toISOString(),
      agent: who.agent,
      wake: who.wake,
      query: p.query,
      params: {
        num_results: p.numResults,
        ...(p.includeDomains ? { include_domains: p.includeDomains } : {}),
        ...(p.startPublishedDate ? { start_published_date: p.startPublishedDate } : {}),
        ...(p.category ? { category: p.category } : {}),
      },
      type: "auto",
      results: 0,
      pages: {},
      exa_cost_usd: null,
      latency_ms: 0,
      status: 200,
      error: null,
    };
    const finish = (status: number, body: string, error: string | null): Response => {
      entry.status = status;
      entry.error = error;
      entry.latency_ms = deps.now() - started;
      log(entry);
      return text(body, status);
    };

    if (!deps.apiKey) return finish(503, "search unavailable: no search provider key is configured for this world", "no EXA_API_KEY");

    let res: Response;
    try {
      res = await deps.fetch(EXA_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": deps.apiKey },
        body: JSON.stringify(exaBody(p)),
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return finish(504, timedOut ? "search timed out; try again later" : "search provider unreachable; try again later", timedOut ? "timeout" : `fetch: ${String(err).slice(0, 200)}`);
    }
    if (!res.ok) {
      const e = exaError(res.status);
      // Exa's error body may echo request details, never the key; keep a short excerpt for the operator.
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      return finish(e.status, e.msg, `exa ${res.status}: ${detail}`);
    }
    let data: ExaResponse;
    try {
      data = (await res.json()) as ExaResponse;
    } catch {
      return finish(502, "search provider sent an unreadable answer", "exa: bad JSON");
    }
    const results = Array.isArray(data.results) ? data.results : [];
    if (data.requestId) entry.id = `${data.requestId}`;
    entry.results = results.length;
    entry.pages = pagesByContent(results);
    entry.exa_cost_usd = typeof data.costDollars?.total === "number" ? data.costDollars.total : null;
    return finish(200, formatResults(p.query, results), null);
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8080);
  const handler = createHandler({
    apiKey: process.env.EXA_API_KEY?.trim() || undefined,
    tokensFile: process.env.TOKENS_FILE ?? "/tokens/tokens.json",
    logFile: process.env.LOG_FILE ?? "/log/search.jsonl",
    fetch: (u, i) => fetch(u, i),
    now: Date.now,
    timeoutMs: Number(process.env.EXA_TIMEOUT_MS ?? 25_000),
  });
  Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch: (req) =>
      handler(req).catch((err) => {
        console.error(`relay error: ${String(err).slice(0, 300)}`);
        return text("search relay error", 500);
      }),
  });
  console.log(`search relay on :${port} (exa ${process.env.EXA_API_KEY?.trim() ? "configured" : "NOT configured"})`);
}
