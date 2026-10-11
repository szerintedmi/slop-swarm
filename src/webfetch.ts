// Web fetch, controller side (docs/plans/2026-10-11-openrouter.md §4). Agents of every harness run
// `webfetch <url>` (docker/webfetch, in the agent image); the run's relay (docker/search/relay.ts POST /fetch,
// guarded by docker/search/webfetch.ts) does the GET, so agents never connect out themselves and the egress
// proxy allowlist stays as it is. Swarm-wide: `webfetch:` in the swarm config turns it on for all agents;
// every agent's wake then gets a relay token (fetch-only unless the agent also has `search: relay`).
// Fetches are free: the relay logs each to search/log/fetch.jsonl and the report counts them; nothing goes
// into the DB.
import { existsSync, readFileSync } from "node:fs";
import type { WebfetchConfig } from "./config.ts";
import { TEXT_MAX_CHARS } from "../docker/search/webfetch.ts";
export type { FetchLogEntry } from "../docker/search/relay.ts";
import type { FetchLogEntry } from "../docker/search/relay.ts";

const fmt = (n: number) => String(Math.round(n * 10) / 10);

/** The lines of the system prompt that tell an agent about `webfetch` (only when the world has it). Kept short: every wake pays for it. */
export function webfetchPromptBlock(w: WebfetchConfig): string {
  return (
    `Web fetch: \`webfetch URL\` prints a page as text (HTML converted, cut at ${TEXT_MAX_CHARS / 1000}K characters); \`webfetch URL -o FILE\` saves the raw bytes (any file type).\n` +
    `GET only, public http(s) on ports 80/443; no logins, cookies, forms or JavaScript; max ${fmt(w.maxBytes / 1048576)} MB, ${fmt(w.timeoutMs / 1000)} s, ${w.maxRedirects} redirects. Every fetch is logged.\n`
  );
}

/** The fetches of one wake (all of them without `wake`), in log order. Malformed lines are skipped. */
export function readFetchLog(logFile: string, wake?: number): FetchLogEntry[] {
  if (!existsSync(logFile)) return [];
  const out: FetchLogEntry[] = [];
  for (const line of readFileSync(logFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as FetchLogEntry;
      if (e && typeof e.id === "string" && (wake === undefined || e.wake === wake)) out.push(e);
    } catch {
      /* a torn last line is completed by the next read */
    }
  }
  return out;
}

/** A fetch that got the site's answer to the agent (whatever the site's status). */
export const fetched = (e: FetchLogEntry) => e.relay_status === 200;
