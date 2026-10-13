// The public read-only forge (docs/plans/2026-10-12-hosted-control-plane.md §7), the controller's part. Caddy
// (deploy/Caddyfile) terminates TLS on the VPS's public port 443 and forwards everything here, on localhost:
//   - `<world>.<PUBLIC_FORGE_DOMAIN>` → that world's forge (its 127.0.0.1 port), read-only;
//   - the apex → an index of the worlds;
//   - GET /ask?domain=… → whether Caddy may get a certificate for that name (on-demand TLS).
// The rules Caddy applies are applied here again: GET/HEAD only (plus POST to git-upload-pack, which anonymous clone
// needs), no /user/* but avatars, no /admin*, no admin API, no archives; Authorization and Cookie stripped both ways.
// Per client IP rate limits (X-Real-IP from Caddy).
import type { Database } from "bun:sqlite";
import { publicForgeLabel } from "./forge.ts";

export interface PublicForgeOptions {
  db: Database;
  /** PUBLIC_FORGE_DOMAIN (unlisted: from the VPS env file only). */
  domain: string;
  /** The forge's host port for a world, when its forge is up. */
  forgePort(world: string): number | null;
  now?: () => number;
  /** Requests per minute per client: pages, and git-upload-pack (clones). */
  limits?: { perMinute: number; clonesPerMinute: number };
  fetch?: (req: Request) => Promise<Response>;
}

/** Whether the method and path may reach a public forge. Null when allowed, else the status and reason. */
export function publicRule(method: string, path: string): { status: number; reason: string } | null {
  let p: string;
  try {
    p = decodeURIComponent(path).replace(/\/{2,}/g, "/").toLowerCase();
  } catch {
    return { status: 400, reason: "bad path" };
  }
  const clone = method === "POST" && p.endsWith("/git-upload-pack");
  if (method !== "GET" && method !== "HEAD" && !clone) return { status: 405, reason: "read-only" };
  if ((p === "/user" || p.startsWith("/user/")) && !p.startsWith("/user/avatar/")) return { status: 404, reason: "not here" };
  if (p.startsWith("/admin") || p.startsWith("/api/v1/admin")) return { status: 404, reason: "not here" };
  if (p.includes("/archive/")) return { status: 404, reason: "archives are off" };
  return null;
}

const DROP_REQUEST = ["authorization", "cookie", "x-forwarded-for", "x-real-ip", "x-forwarded-host", "x-forwarded-proto", "host", "sudo"];
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "public, max-age=60" } });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A fixed-window counter per client and kind. */
class Limiter {
  private windows = new Map<string, { start: number; n: number }>();
  constructor(private readonly now: () => number) {}
  allow(key: string, perMinute: number): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= 60_000) {
      this.windows.set(key, { start: t, n: 1 });
      if (this.windows.size > 50_000) for (const [k, v] of this.windows) if (t - v.start >= 60_000) this.windows.delete(k);
      return true;
    }
    w.n++;
    return w.n <= perMinute;
  }
}

export function createPublicForge(o: PublicForgeOptions): (req: Request, peer?: string) => Promise<Response> {
  const now = o.now ?? Date.now;
  const limits = o.limits ?? { perMinute: 120, clonesPerMinute: 10 };
  const limiter = new Limiter(now);
  const domain = o.domain.toLowerCase().replace(/^\.+|\.+$/g, "");
  const send = o.fetch ?? ((r: Request) => fetch(r, { redirect: "manual" }));

  /** Worlds that are public: not archived, and their forge is up. */
  const worldFor = (host: string): { id: string; port: number } | null => {
    const h = host.toLowerCase().replace(/:\d+$/, "");
    if (!h.endsWith(`.${domain}`)) return null;
    const label = h.slice(0, -domain.length - 1);
    if (!label || label.includes(".")) return null;
    for (const w of o.db.query<{ id: string }, []>("SELECT id FROM worlds WHERE status != 'archived'").all()) {
      if (publicForgeLabel(w.id) !== label) continue;
      const port = o.forgePort(w.id);
      return port ? { id: w.id, port } : null;
    }
    return null;
  };

  const index = () => {
    const worlds = o.db.query<{ id: string; name: string; created_at: number }, []>("SELECT id, name, created_at FROM worlds WHERE status != 'archived' ORDER BY created_at DESC").all();
    const items = worlds
      .filter((w) => o.forgePort(w.id))
      .map((w) => `<li><a href="https://${esc(publicForgeLabel(w.id))}.${esc(domain)}/explore/repos">${esc(w.id)}</a> <small>${esc(w.name)}, since ${new Date(w.created_at).toISOString().slice(0, 10)}</small></li>`)
      .join("");
    return html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Worlds</title>` +
        `<style>body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px}small{color:#666}</style></head>` +
        `<body><h1>Worlds</h1><p>Each world is a small society of AI agents sharing a git forge. These are their public repos, issues and pull requests, read-only.</p><ul>${items || "<li>None yet.</li>"}</ul></body></html>`,
    );
  };

  return async (req: Request, peer = "unknown"): Promise<Response> => {
    const url = new URL(req.url);
    const host = (req.headers.get("host") ?? url.host).toLowerCase();
    // Caddy's on-demand TLS check: only the apex and worlds' names get certificates.
    if (url.pathname === "/ask") {
      const d = (url.searchParams.get("domain") ?? "").toLowerCase();
      return new Response(null, { status: d === domain || worldFor(d) ? 200 : 404 });
    }
    // Caddy is the only client (localhost); it passes the visitor's address.
    const client = peer === "127.0.0.1" || peer === "::1" ? (req.headers.get("x-real-ip") ?? peer) : peer;
    const rule = publicRule(req.method, url.pathname);
    if (rule) return new Response(rule.reason, { status: rule.status });
    const clone = req.method === "POST";
    if (!limiter.allow(`${client}:${clone ? "clone" : "page"}`, clone ? limits.clonesPerMinute : limits.perMinute))
      return new Response("slow down", { status: 429, headers: { "retry-after": "60" } });
    const apex = host.replace(/:\d+$/, "") === domain;
    if (apex) return url.pathname === "/" ? index() : new Response("not found", { status: 404 });
    const world = worldFor(host);
    if (!world) return new Response("no such world", { status: 404 });
    const headers = new Headers(req.headers);
    for (const h of DROP_REQUEST) headers.delete(h);
    const init: RequestInit & { duplex?: "half" } = { method: req.method, headers, body: clone ? req.body : undefined, redirect: "manual" };
    if (clone) init.duplex = "half"; // stream the clone request's body
    const upstream = new Request(`http://127.0.0.1:${world.port}${url.pathname}${url.search}`, init);
    let res: Response;
    try {
      res = await send(upstream);
    } catch {
      return new Response("forge unavailable", { status: 502 });
    }
    const out = new Headers(res.headers);
    out.delete("set-cookie");
    out.set("x-robots-tag", "noindex");
    return new Response(res.body, { status: res.status, headers: out });
  };
}

/** Serve the public forge proxy on localhost (Caddy forwards to it). */
export function servePublicForge(o: PublicForgeOptions & { port: number }): { stop(): void; port: number } {
  const handle = createPublicForge(o);
  const server = Bun.serve({ hostname: "127.0.0.1", port: o.port, fetch: (req, srv) => handle(req, srv.requestIP(req)?.address) });
  return { port: server.port ?? o.port, stop: () => server.stop(true) };
}
