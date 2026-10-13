// The CLI's side of the HTTP API (docs/plans/2026-10-12-hosted-control-plane.md §5.3). SLOPSWARM_API picks the
// controller (e.g. the VPS over the tailnet); else the local service, found by data/service.json.
import { existsSync, readFileSync } from "node:fs";
import { serviceFile } from "./db/index.ts";

const API_PREFIX = "/api/v1";

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The controller to talk to: SLOPSWARM_API, else a live local service; null when there is none. */
export function apiBase(env = process.env): { url: string; explicit: boolean } | null {
  const explicit = env.SLOPSWARM_API?.trim();
  if (explicit) return { url: explicit.replace(/\/+$/, ""), explicit: true };
  if (!existsSync(serviceFile())) return null;
  try {
    const s = JSON.parse(readFileSync(serviceFile(), "utf8")) as { pid: number; url: string };
    // Never this process: a restarted controller container is PID 1 again and would take the stale record for a
    // live service.
    return s.pid && s.pid !== process.pid && alive(s.pid) && s.url ? { url: s.url.replace(/\/+$/, ""), explicit: false } : null;
  } catch {
    return null;
  }
}

export async function api<T>(base: string, method: string, path: string, body?: unknown, env = process.env): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", "x-slopswarm": "cli", "x-slopswarm-source": "cli" };
  const token = env.SLOPSWARM_API_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${base}${API_PREFIX}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    throw new ApiClientError(0, `controller unreachable at ${base}: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* plain */
    }
    throw new ApiClientError(res.status, msg);
  }
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("json") ? JSON.parse(text) : text) as T;
}
