// Web search relay, controller side (docs/plans/2026-10-11-openrouter.md §3). The relay itself is
// docker/search/relay.ts: one container per run on the internal network (agents reach it) and the egress
// network (it reaches api.exa.ai, the only host it calls). Agents never reach Exa directly: api.exa.ai is not
// on the proxy allowlist, and the key lives only in the relay's env.
//
// Per wake of an agent with `search: relay` (and of every agent when the world has `webfetch:`, src/webfetch.ts),
// the controller issues a token (runtime dir, read by `websearch` / `webfetch`) and registers its hash in the
// relay's tokens file, with whether it may search; the entry is removed when the wake ends. The relay logs
// every search to search/log/search.jsonl; the controller (the only DB writer) prices each line from the run's
// pricing snapshot (`search:` in pricing.yaml) and bills it to the wake as a request row (model `exa-search`,
// one web search, no tokens), so it counts in the per-wake, per-agent and swarm budgets like any request.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, SwarmConfig, WebfetchConfig } from "./config.ts";
import { runDir } from "./db/index.ts";
import { MOUNTS } from "./docker.ts";
import { searchCost, type PricingTable } from "./pricing/index.ts";
import type { CostBreakdown, RequestUsage } from "./types.ts";

/** Pseudo-model of a relay search in `requests` and in pricing.yaml `search:`. */
export const SEARCH_MODEL = "exa-search";
export const SEARCH_PORT = 8080;
const REPO = join(import.meta.dir, "..");
const SEARCH_CONTEXT = join(REPO, "docker", "search");
/** Same as forge.ts EGRESS_NETWORK (docker/compose.yaml). */
const EGRESS_NETWORK = "slopswarm-egress";

/** Tagged by the hash of its build context, like the agent image (proxy.ts). */
export const SEARCH_IMAGE = `slopswarm-search:${new Bun.CryptoHasher("sha256")
  .update(readFileSync(join(SEARCH_CONTEXT, "Dockerfile")))
  .update(readFileSync(join(SEARCH_CONTEXT, "relay.ts")))
  .update(readFileSync(join(SEARCH_CONTEXT, "webfetch.ts")))
  .digest("hex")
  .slice(0, 12)}`;

/** The one line of the system prompt that tells an agent how to search (only for `search: relay`). */
export const SEARCH_PROMPT_LINE =
  'Web search, a shell command (run it with bash): `websearch "query"` (options: --n N results, --domain D, --since YYYY-MM-DD, --news); each search is billed to your budget (see /self/pricing.yaml).\n';

export function usesRelay(a: Pick<AgentConfig, "search">): boolean {
  return a.search === "relay";
}

/** The run needs its relay: some agent searches through it, or the world has webfetch (every agent may fetch). */
export function relayNeeded(cfg: Pick<SwarmConfig, "agents" | "webfetch">): boolean {
  return cfg.agents.some(usesRelay) || !!cfg.webfetch;
}

/** Container name = hostname agents use. Kept within a DNS label (63 chars). */
export function searchHost(runId: string): string {
  const name = `slopswarm-search-${runId}`.replace(/[^a-zA-Z0-9-]/g, "-");
  if (name.length <= 63) return name;
  const h = new Bun.CryptoHasher("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, 54)}-${h}`;
}
export const searchUrl = (runId: string) => `http://${searchHost(runId)}:${SEARCH_PORT}`;

/** Host dirs: `tokens/` (mounted read-only into the relay) and `log/` (its only writable mount: search.jsonl, fetch.jsonl). */
export function searchDirs(base: string) {
  return {
    base,
    tokens: join(base, "tokens"),
    log: join(base, "log"),
    tokensFile: join(base, "tokens", "tokens.json"),
    logFile: join(base, "log", "search.jsonl"),
    fetchLogFile: join(base, "log", "fetch.jsonl"),
    /** The relay's own structured process log (docker/search/relay.ts relayLogger). */
    processLogFile: join(base, "log", "relay.jsonl"),
  };
}
export const runSearchDirs = (runId: string) => searchDirs(join(runDir(runId), "search"));

/** Where an agent's token lives in its runtime dir (host) and in the container. */
export const tokenPath = (runtimeDir: string) => join(runtimeDir, "search", "token");
export const TOKEN_FILE_IN = `${MOUNTS.runtime}/search/token`;

/** Container env of a wake that may use the relay (`websearch` and `webfetch` both read it). */
export function searchEnv(runId: string): Record<string, string> {
  return { SLOPSWARM_SEARCH_URL: searchUrl(runId), SLOPSWARM_SEARCH_TOKEN_FILE: TOKEN_FILE_IN };
}

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

type TokenMap = Record<string, { agent: string; wake: number; search: boolean }>;

function readTokens(file: string): TokenMap {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as TokenMap;
  } catch {
    return {};
  }
}
/** Replace atomically: the relay reads the file on every request. */
function writeTokens(file: string, map: TokenMap): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(map));
  chmodSync(tmp, 0o644);
  renameSync(tmp, file);
}

/**
 * Give a wake a fresh relay token: the token goes to the agent's runtime dir, its hash to the relay's
 * tokens file (so neither file alone is a usable copy of the other). Earlier tokens of the agent are dropped.
 * `search: false`: the token may only fetch (an agent on its harness's own search, in a world with webfetch).
 */
export function issueSearchToken(dirs: ReturnType<typeof searchDirs>, runtimeDir: string, agent: string, wake: number, { search = true }: { search?: boolean } = {}): void {
  const { token, hash } = newRelayToken();
  registerRelayToken(dirs, hash, { agent, wake, search });
  mkdirSync(join(runtimeDir, "search"), { recursive: true });
  writeFileSync(tokenPath(runtimeDir), token + "\n");
  chmodSync(tokenPath(runtimeDir), 0o600);
}

/** A fresh relay token and the hash the relay knows it by (the controller makes it; the runner registers the hash). */
export function newRelayToken(): { token: string; hash: string } {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  return { token, hash: sha256(token) };
}

/** Register a token hash in the relay's tokens file; the agent's earlier tokens are dropped. */
export function registerRelayToken(dirs: ReturnType<typeof searchDirs>, hash: string, entry: { agent: string; wake: number; search: boolean }): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("relay token hash: expected sha256 hex");
  mkdirSync(dirs.tokens, { recursive: true });
  const map = Object.fromEntries(Object.entries(readTokens(dirs.tokensFile)).filter(([, v]) => v.agent !== entry.agent));
  map[hash] = entry;
  writeTokens(dirs.tokensFile, map);
}

/** The agent's runtime file holding its relay token (relative to the runtime dir; mounted at TOKEN_FILE_IN). */
export const RELAY_TOKEN_FILE = "search/token";

/** The wake is over: its token stops working. */
export function revokeSearchToken(dirs: ReturnType<typeof searchDirs>, wake: number): void {
  if (!existsSync(dirs.tokensFile)) return;
  const map = readTokens(dirs.tokensFile);
  const kept = Object.fromEntries(Object.entries(map).filter(([, v]) => v.wake !== wake));
  if (Object.keys(kept).length !== Object.keys(map).length) writeTokens(dirs.tokensFile, kept);
}

/** One line of search.jsonl (written by docker/search/relay.ts SearchLogEntry). */
export interface SearchLogEntry {
  id: string;
  ts: string;
  agent: string;
  wake: number;
  query: string;
  params: Record<string, unknown>;
  type: string;
  results: number;
  pages: Record<string, number>;
  exa_cost_usd: number | null;
  latency_ms: number;
  status: number;
  error: string | null;
}

/** The searches of one wake (all of them without `wake`), in log order. Malformed lines are skipped. */
export function readSearchLog(logFile: string, wake?: number): SearchLogEntry[] {
  if (!existsSync(logFile)) return [];
  const out: SearchLogEntry[] = [];
  // A search is billed once, even if its line appears twice.
  const seen = new Set<string>();
  for (const line of readFileSync(logFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as SearchLogEntry;
      if (e && typeof e.id === "string" && (wake === undefined || e.wake === wake) && !seen.has(e.id)) {
        seen.add(e.id);
        out.push(e);
      }
    } catch {
      /* a torn last line is completed by the next read */
    }
  }
  return out;
}

/** A successful search is billed; a failed one (no key, Exa error, timeout) was not charged by Exa. */
export const billed = (e: SearchLogEntry) => e.status === 200 && e.error === null;

/** Request rows for a wake's billed searches: no tokens, one web search, our computed cost. */
export function searchRows(pricing: PricingTable, entries: SearchLogEntry[]): { rows: { u: RequestUsage; c: CostBreakdown }[]; total: number } {
  const rows = entries.filter(billed).map((e) => ({
    u: { requestId: `search:${e.id}`, model: SEARCH_MODEL, freshInput: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoning: 0, webSearches: 1, ts: e.ts },
    c: { costUsd: searchCost({ model: SEARCH_MODEL, type: e.type, results: e.results, pages: e.pages }, pricing), promptTokens: 0, tier: 0 },
  }));
  return { rows, total: rows.reduce((s, r) => s + r.c.costUsd, 0) };
}

/** Start-time checks: pricing for searches, and a warning if the relay has no key. Returns the warnings. */
export function checkSearchSetup(cfg: Pick<SwarmConfig, "agents">, pricing: PricingTable, env = process.env): { error?: string; warnings: string[] } {
  const agents = cfg.agents.filter(usesRelay).map((a) => a.name);
  if (!agents.length) return { warnings: [] };
  if (!pricing.search[SEARCH_MODEL]) return { error: `agents with search: relay (${agents.join(", ")}) need search.${SEARCH_MODEL} in pricing.yaml`, warnings: [] };
  return {
    warnings: env.EXA_API_KEY?.trim() ? [] : [`EXA_API_KEY is not set in .env: web search will answer "unavailable" for ${agents.join(", ")}`],
  };
}

/** Relay env that turns /fetch on (docker/search/relay.ts webfetchFromEnv). Limits only, nothing secret. */
export function webfetchRelayEnv(w: WebfetchConfig | undefined): string[] {
  if (!w) return [];
  return ["-e", `WEBFETCH_MAX_BYTES=${w.maxBytes}`, "-e", `WEBFETCH_TIMEOUT_MS=${w.timeoutMs}`, "-e", `WEBFETCH_MAX_REDIRECTS=${w.maxRedirects}`];
}

/** `docker run` argv for the relay. The key is passed by name (`-e EXA_API_KEY`), so it never shows in argv. */
export function searchRunArgs(o: { runId: string; image: string; network: string; dir: string; withKey: boolean; webfetch?: WebfetchConfig }): string[] {
  const d = searchDirs(o.dir);
  return [
    "docker", "run", "-d", "--rm",
    "--name", searchHost(o.runId),
    "--label", `slopswarm.search=${o.runId}`,
    "--user", "1000:1000",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp:rw,size=16m",
    "--cpus", "0.5",
    "--memory", "256m",
    "--pids-limit", "64",
    // Internal: agents reach it. Egress: its route to api.exa.ai (the only host /search calls) and, with webfetch,
    // to public web servers (/fetch refuses every non-public address, so not the internal network either).
    "--network", o.network,
    "--network", EGRESS_NETWORK,
    "-v", `${d.tokens}:/tokens:ro`,
    "-v", `${d.log}:/log:rw`,
    // The world id for the relay's structured log (not secret).
    "-e", `SLOPSWARM_WORLD=${o.runId}`,
    ...(o.withKey ? ["-e", "EXA_API_KEY"] : []),
    ...webfetchRelayEnv(o.webfetch),
    o.image,
  ];
}

async function docker(argv: string[], env: Record<string, string | undefined> = process.env): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

/** Build the relay image for the current sources if it doesn't exist yet. */
export async function ensureSearchImage(): Promise<void> {
  if ((await docker(["docker", "image", "inspect", SEARCH_IMAGE])).code === 0) return;
  console.log(`building ${SEARCH_IMAGE}…`);
  const r = await docker(["docker", "build", "-t", SEARCH_IMAGE, SEARCH_CONTEXT]);
  if (r.code !== 0) throw new Error(`search relay image build failed: ${r.err.trim().slice(-500)}`);
}

/** Remove this run's relay container (its log stays on disk). */
export async function stopSearch(runId: string): Promise<void> {
  const ps = await docker(["docker", "ps", "-aq", "--filter", `label=slopswarm.search=${runId}`]);
  const ids = ps.out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (ids.length) await docker(["docker", "rm", "-f", ...ids]);
}

/**
 * Start the run's (on the runner: the world's) relay, replacing a leftover, and wait until it answers on the internal
 * network. `exaKey`: the key passed by name (default: EXA_API_KEY from the env).
 */
export async function startSearch(o: { runId: string; network: string; dir?: string; webfetch?: WebfetchConfig; exaKey?: string }): Promise<void> {
  const dir = o.dir ?? runSearchDirs(o.runId).base;
  const d = searchDirs(dir);
  mkdirSync(d.tokens, { recursive: true });
  mkdirSync(d.log, { recursive: true });
  if (!existsSync(d.tokensFile)) writeTokens(d.tokensFile, {});
  await ensureSearchImage();
  await stopSearch(o.runId);
  const key = (o.exaKey ?? process.env.EXA_API_KEY)?.trim();
  const r = await docker(searchRunArgs({ runId: o.runId, image: SEARCH_IMAGE, network: o.network, dir, withKey: !!key, webfetch: o.webfetch }), { ...process.env, EXA_API_KEY: key });
  if (r.code !== 0) throw new Error(`search relay did not start: ${r.err.trim()}`);
  // No host port: probe from inside the container.
  const until = Date.now() + 20_000;
  for (;;) {
    const h = await docker(["docker", "exec", searchHost(o.runId), "bun", "-e", `const r = await fetch("http://127.0.0.1:${SEARCH_PORT}/health"); process.exit(r.ok ? 0 : 1)`]);
    if (h.code === 0) return;
    if (Date.now() > until) throw new Error(`search relay did not come up: ${(h.err || h.out).trim().slice(0, 300)}`);
    await Bun.sleep(300);
  }
}
