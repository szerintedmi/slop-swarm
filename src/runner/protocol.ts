// Wire types between the controller (src/host/) and the runner (src/runner/), docs/plans/2026-10-12-hosted-control-plane.md §2.
// The controller starts every connection; the runner holds no controller credentials. Everything is keyed by
// world and agent (never a host path): the runner owns its dir layout.
import type { HostConfig } from "../hostconfig.ts";
import type { WebfetchConfig } from "../config.ts";

export const RUNNER_API = "/v1";

/** World ids double as container-name parts and forge hostnames. */
export const WORLD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
/** Wake ids are container names. */
export const WAKE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** A file the controller writes into an agent's dirs at `prepare` (logins, tokens, /self, the system prompt). */
export interface HostFile {
  area: "runtime" | "self";
  /** Relative to the area; no `..`, not absolute. */
  path: string;
  /** base64 */
  content: string;
  /** Default 0o644; secrets 0o600. */
  mode?: number;
  /** Written only when absent (Codex's auth.json: the agent's copy rotates). */
  ifMissing?: boolean;
}

export interface PrepareRequest {
  files: HostFile[];
  /** Runtime paths removed first (e.g. a GitHub login the run no longer has). */
  remove?: string[];
  /** Container env secrets by container name; kept in the runner's memory only, passed as `-e NAME`. */
  env: Record<string, string>;
  /** Register this hash in the world relay's tokens file (the token itself is one of `files`). */
  relayToken?: { hash: string; wake: number; search: boolean };
}
export interface PrepareResponse {
  /** `ifMissing` files that were already there. */
  kept: string[];
}

export interface EnsureUpRequest {
  host: HostConfig;
  /** Agent image: a registry reference by digest, or a local tag the runner can build from its checkout. */
  image: string;
  /** Secrets of the world relays (EXA_API_KEY), kept in memory and passed by name. */
  relaySecrets: Record<string, string>;
}
export interface EnsureUpResponse {
  /** hostconfig.ts hostConfigHash of what was applied. */
  appliedHash: string;
  image: { ref: string; digest: string; claude?: string; codex?: string; pi?: string };
  runnerVersion: string;
}

export interface WorldUpRequest {
  /** Start the world's relay (search and/or webfetch). */
  relay?: { webfetch?: WebfetchConfig };
  /** Remote forge: start a forwarder `slopswarm-forge-<world>` on the agent host to this host:port. Absent locally. */
  forgeTarget?: string;
}

export interface WakeStartRequest {
  /** Container name, unique per wake. */
  id: string;
  world: string;
  run: string;
  agent: string;
  /** Controller DB wake id (logs, relay). */
  wakeId: number;
  image: string;
  /** Plain container env (no secrets). */
  env: Record<string, string>;
  /** Names of `prepare` env secrets passed as `-e NAME`. */
  secretEnv: string[];
  argv: string[];
  noProxy: string[];
  /** The runner kills the wake this long after it starts, whatever the controller does. */
  hardTimeoutMs: number;
}

export type WakeState = "starting" | "running" | "exited";

export interface WakeTimings {
  imageCheckMs?: number;
  containerStartMs?: number;
  /** Container start to exit. */
  runMs?: number;
}

export interface WakeStatus {
  id: string;
  world: string;
  run: string;
  agent: string;
  wakeId: number;
  state: WakeState;
  exitCode: number | null;
  /** Why the runner killed it (kill request, hard timeout, watchdog), if it did. */
  killed: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Bytes of the agent's home after the wake. */
  homeBytes: number | null;
  /** Launch failure (docker run refused), if any. */
  error: string | null;
  timings: WakeTimings;
}

/** What `read` / `stat` address: a wake's output, an agent's file, or a world relay's log. */
export type FileRef =
  | { wake: string; file: "stdout" | "stderr" }
  | { world: string; agent: string; area: "home" | "runtime"; path: string }
  | { world: string; relay: "search" | "fetch" };

export interface FileStat {
  path: string;
  kind: "file" | "dir" | "symlink" | "other";
  size: number;
  mtimeMs: number;
}

export interface ReadResult {
  data: Uint8Array;
  /** Total size of the file now. */
  size: number;
}

export interface HomeInfo {
  generation: number | null;
  bytes: number;
  /** Top-level runtime entries that are neither synced nor known to be excluded (a warning). */
  unknownRuntime: string[];
  /** Entries left out of the snapshot because their names can't be synced (e.g. a backslash): a warning. */
  skipped?: string[];
}

export interface RunnerLogLine {
  timestamp: string;
  severity_text: string;
  body: string;
  [attr: string]: unknown;
}

/** Runtime subdirs synced with the home (CLI session files): Claude's `projects/`, Codex's and pi's `sessions/`. */
export const RUNTIME_SYNC_DIRS = ["projects", "sessions"] as const;

/** Runtime paths the controller may read: session files and Codex's rotated login. */
export function runtimeReadable(path: string): boolean {
  return path === "auth.json" || RUNTIME_SYNC_DIRS.some((d) => path === d || path.startsWith(`${d}/`));
}

/**
 * Runtime entries that stay on the agent host and are expected there: our logins and tokens, the CLIs' state and
 * caches. Anything else at the top level of a runtime dir is reported (HomeInfo.unknownRuntime).
 */
export const RUNTIME_KNOWN_EXCLUDED: readonly RegExp[] = [
  // ours: forge/tea/git logins, GitHub login, relay token, system prompt, pi's agent dir (models.json, keys)
  /^(forge|xdg|github|search|pi|system-prompt\.md)$/,
  // Claude Code
  /^\.claude\.json(\.backup.*)?$/, /^\.credentials\.json$/, /^\.last-cleanup$/, /^(backups|plugins|session-env|shell-snapshots|statsig|todos|ide|debug|cache|sessions|file-history|todos)$/,
  /^policy-limits\.json(\.stamp\.json)?$/, /^settings(\.local)?\.json$/,
  // Codex
  /^auth\.json$/, /^config\.toml$/, /^version\.json$/, /^installation_id$/, /^models_cache\.json$/, /^\.sandbox_migration$/,
  /^\.sqlite-maintenance\.lock$/, /^[a-z_]+_\d+\.sqlite(-shm|-wal)?$/, /^(shell_snapshots|skills|tmp|log|thread-writer-locks|memories)$/,
];

export function knownRuntimeEntry(name: string): boolean {
  return (RUNTIME_SYNC_DIRS as readonly string[]).includes(name) || RUNTIME_KNOWN_EXCLUDED.some((re) => re.test(name));
}

/** A relative path inside an area: no absolute paths, no `..` or empty segments. */
export function safeRelPath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\0") || p.includes("\\")) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}
