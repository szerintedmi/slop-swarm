// Web search + web fetch relay (docs/plans/2026-10-11-openrouter.md §3, §4): the agents' only way to search
// the web from a harness without a native search tool, and every agent's only way to download a public URL.
// One container per run (`slopswarm-search-<run>`), on the internal network (agents reach it) and the egress
// network (it reaches Exa and, for /fetch, public web servers). /search only ever calls EXA_URL; the API key
// comes from its env and never appears in a response or a log line. /fetch is GET-only to public addresses
// (docker/search/webfetch.ts) and is off unless the controller passes WEBFETCH_* limits.
//
//   POST /search  Authorization: Bearer <token>   {query, num_results?, include_domains?, start_published_date?, category?}
//   POST /fetch   Authorization: Bearer <token>   {url, raw?}
//   GET  /health
//
// Tokens: the controller writes `{ "<sha256 of token>": {agent, wake, search} }` to /tokens/tokens.json
// (read-only here) for every running wake that may use the relay, and removes the entry when the wake ends.
// `search: false` tokens (agents on their harness's own search, in a world with webfetch) may only fetch.
// Every search that passes auth is appended to /log/search.jsonl before the response goes out; the
// controller ingests that file, prices each search from the run's pricing snapshot and bills the wake.
// Every fetch that passes auth is appended to /log/fetch.jsonl (free; counted in the report).
// Self-contained (no imports from src/): with webfetch.ts it is the whole build context of docker/search/Dockerfile.
import { appendFileSync, readFileSync } from "node:fs";
import { contentKind, defaultFetchDeps, FetchError, fetchPublic, textAnswer, type FetchDeps, type FetchFailure, type WebfetchLimits } from "./webfetch.ts";

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

/** One line of fetch.jsonl. Read by src/webfetch.ts (keep the two in step). */
export interface FetchLogEntry {
  id: string;
  ts: string;
  agent: string;
  wake: number;
  /** As the agent asked for it. */
  url: string;
  /** The last URL fetched (after redirects), null if none was. */
  final_url: string | null;
  /** The site's HTTP status, null if no answer came. */
  status: number | null;
  /** HTTP status we answered the agent with. */
  relay_status: number;
  content_type: string | null;
  bytes: number;
  redirects: number;
  raw: boolean;
  latency_ms: number;
  /** Why the guard refused (scheme, port, private address…), else null. */
  blocked: string | null;
  /** Other failure (timeout, too large, unreachable, too many redirects), else null. */
  error: string | null;
}

export interface RelayDeps {
  apiKey: string | undefined;
  tokensFile: string;
  logFile: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  timeoutMs: number;
  /** Web fetch limits; absent = /fetch is disabled. */
  webfetch?: WebfetchLimits | null;
  fetchLogFile?: string;
  /** DNS and connection hooks of /fetch (tests). */
  fetchDeps?: FetchDeps;
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

/**
 * The agent + wake a bearer token belongs to, and whether it may search, or null. The tokens file is re-read
 * every time (tiny, rewritten per wake). Entries without `search` (written before webfetch) may search.
 */
export function lookupToken(tokensFile: string, header: string | null): { agent: string; wake: number; search: boolean } | null {
  const m = /^Bearer\s+([A-Za-z0-9_-]{16,200})\s*$/.exec(header ?? "");
  if (!m) return null;
  let map: Record<string, { agent?: unknown; wake?: unknown; search?: unknown }>;
  try {
    map = JSON.parse(readFileSync(tokensFile, "utf8"));
  } catch {
    return null;
  }
  const hit = map[sha256(m[1]!)];
  if (!hit || typeof hit.agent !== "string" || typeof hit.wake !== "number") return null;
  return { agent: hit.agent, wake: hit.wake, search: hit.search !== false };
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
  const webfetch = createFetchHandler(deps);
  return async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/health" && req.method === "GET") return Response.json({ ok: true, exa: !!deps.apiKey, webfetch: !!deps.webfetch });
    if (url.pathname === "/fetch") return webfetch(req);
    if (url.pathname !== "/search") return text("not found", 404);
    if (req.method !== "POST") return text("use POST /search", 405);
    const who = lookupToken(deps.tokensFile, req.headers.get("authorization"));
    if (!who) return text("search: not authorised (no valid token for a running wake)", 401);
    if (!who.search) return text("search: not available to this agent (it uses its harness's own web search)", 403);

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

const FETCH_STATUS: Record<FetchFailure, number> = { invalid: 400, blocked: 403, too_large: 413, timeout: 504, redirects: 502, upstream: 502 };

/** Header-safe value (printable ASCII, capped). */
const hv = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 2000);

/**
 * POST /fetch {url, raw?}: GET a public URL for the agent (webfetch.ts does the guarding). Text answers carry a
 * short header; `raw: true` returns the bytes with the metadata in X-Webfetch-* headers. Logged to fetch.jsonl.
 */
function createFetchHandler(deps: RelayDeps): (req: Request) => Promise<Response> {
  const fetchDeps = deps.fetchDeps ?? defaultFetchDeps;
  return async (req) => {
    if (req.method !== "POST") return text("use POST /fetch", 405);
    const who = lookupToken(deps.tokensFile, req.headers.get("authorization"));
    if (!who) return text("webfetch: not authorised (no valid token for a running wake)", 401);
    if (!deps.webfetch || !deps.fetchLogFile) return text("webfetch: not available in this world", 503);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return text("webfetch: body must be JSON", 400);
    }
    const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    if (typeof b.url !== "string" || !b.url.trim()) return text("webfetch: url: expected a non-empty string", 400);
    if (b.raw !== undefined && typeof b.raw !== "boolean") return text("webfetch: raw: expected true or false", 400);
    const raw = b.raw === true;
    const started = deps.now();
    const entry: FetchLogEntry = {
      id: crypto.randomUUID(),
      ts: new Date(started).toISOString(),
      agent: who.agent,
      wake: who.wake,
      url: b.url.trim().slice(0, 2000),
      final_url: null,
      status: null,
      relay_status: 200,
      content_type: null,
      bytes: 0,
      redirects: 0,
      raw,
      latency_ms: 0,
      blocked: null,
      error: null,
    };
    const finish = (res: Response): Response => {
      entry.relay_status = res.status;
      entry.latency_ms = deps.now() - started;
      appendFileSync(deps.fetchLogFile!, JSON.stringify(entry) + "\n");
      return res;
    };
    let r;
    try {
      r = await fetchPublic(entry.url, deps.webfetch, fetchDeps, (u, n) => {
        entry.final_url = u;
        entry.redirects = n;
      });
    } catch (err) {
      const e = err instanceof FetchError ? err : new FetchError("upstream", `fetch failed (${String(err).slice(0, 150)})`);
      if (e.kind === "blocked" || e.kind === "invalid") entry.blocked = e.message;
      else entry.error = `${e.kind}: ${e.message}`;
      const prefix = e.kind === "blocked" ? "blocked: " : e.kind === "too_large" ? "too large: " : "";
      return finish(text(`webfetch: ${prefix}${e.message}`, FETCH_STATUS[e.kind]));
    }
    Object.assign(entry, { final_url: r.finalUrl, status: r.status, content_type: r.contentType || null, bytes: r.body.length, redirects: r.redirects });
    const meta = {
      "x-webfetch-url": hv(r.finalUrl),
      "x-webfetch-status": String(r.status),
      "x-webfetch-type": hv(r.contentType),
      "x-webfetch-bytes": String(r.body.length),
    };
    if (raw) return finish(new Response(new Uint8Array(r.body.buffer as ArrayBuffer, r.body.byteOffset, r.body.length), { status: 200, headers: { "content-type": "application/octet-stream", ...meta } }));
    const kind = contentKind(r.contentType, r.body);
    if (kind === "binary")
      return finish(text(`webfetch: ${r.contentType.split(";")[0]} is not text (${r.body.length} bytes, HTTP ${r.status}); save it with \`webfetch URL -o FILE\``, 415));
    return finish(new Response(textAnswer(r, kind), { status: 200, headers: { "content-type": "text/plain; charset=utf-8", ...meta } }));
  };
}

/** Web fetch limits from the env (set by the controller from the swarm config's `webfetch:`), or null = disabled. */
export function webfetchFromEnv(env: Record<string, string | undefined>): WebfetchLimits | null {
  const n = (k: string) => (env[k] !== undefined && env[k] !== "" ? Number(env[k]) : NaN);
  const l = { maxBytes: n("WEBFETCH_MAX_BYTES"), timeoutMs: n("WEBFETCH_TIMEOUT_MS"), maxRedirects: n("WEBFETCH_MAX_REDIRECTS") };
  return Object.values(l).every((v) => Number.isFinite(v) && v >= 0) && l.maxBytes > 0 && l.timeoutMs > 0 ? l : null;
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8080);
  const webfetch = webfetchFromEnv(process.env);
  const handler = createHandler({
    apiKey: process.env.EXA_API_KEY?.trim() || undefined,
    tokensFile: process.env.TOKENS_FILE ?? "/tokens/tokens.json",
    logFile: process.env.LOG_FILE ?? "/log/search.jsonl",
    fetch: (u, i) => fetch(u, i),
    now: Date.now,
    timeoutMs: Number(process.env.EXA_TIMEOUT_MS ?? 25_000),
    webfetch,
    fetchLogFile: process.env.FETCH_LOG_FILE ?? "/log/fetch.jsonl",
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
  console.log(
    `search relay on :${port} (exa ${process.env.EXA_API_KEY?.trim() ? "configured" : "NOT configured"}; webfetch ${webfetch ? `on, ${webfetch.maxBytes} bytes, ${webfetch.timeoutMs} ms, ${webfetch.maxRedirects} redirects` : "off"})`,
  );
}
