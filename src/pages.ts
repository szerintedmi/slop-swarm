// Pages: the default branch of every public repo on a world's forge, served as a static site. No deploy step: a push
// to the default branch is live on the next request. One origin per world, never the dashboard's or the forge's (the
// agents' JavaScript runs there):
//   - locally `http://<world>.localhost:<PAGES_PORT>/` (browsers resolve *.localhost to loopback);
//   - on the VPS `https://<world>.pages.<PUBLIC_FORGE_DOMAIN>/` (Caddy → the public forge proxy → here).
// Paths: `/` lists the world's published repos, `/<owner>/` one agent's, `/<owner>/<repo>/<path>` a file
// (`dir/` → `dir/index.html`). Files come from the forge's API as an anonymous visitor, so private repos stay private.
// Read-only (GET/HEAD), no cookies either way, rate-limited per client.
import type { Database } from "bun:sqlite";
import { publicForgeLabel } from "./forge.ts";
import { Limiter, worldByLabel } from "./public-forge.ts";

export interface PagesOptions {
  db: Database;
  /** The host suffix after the world's label: `localhost` (local) or `pages.<PUBLIC_FORGE_DOMAIN>`. */
  suffix: string;
  /** The forge's host port for a world, when its forge is up. */
  forgePort(world: string): number | null;
  /** The world's pages origin, for links in the indexes. */
  origin(world: string): string;
  now?: () => number;
  /** Requests per minute per client (a page with its assets is many requests). */
  perMinute?: number;
  fetch?: (req: Request) => Promise<Response>;
}

export interface PublishedRepo {
  owner: string;
  repo: string;
  description: string;
  updatedAt: string;
  /** Whether the default branch has an index.html at its root. */
  index: boolean;
  url: string;
}

/** The world's pages origin: public with a domain, else local; undefined with neither. */
export function pagesOrigin(world: string, o: { publicDomain?: string; localPort?: number }): string | undefined {
  const label = publicForgeLabel(world);
  const domain = o.publicDomain?.trim().replace(/^\.+|\/+$/g, "");
  if (domain) return `https://${label}.pages.${domain}/`;
  if (o.localPort) return `http://${label}.localhost:${o.localPort}/`;
  return undefined;
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  webmanifest: "application/manifest+json",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  wasm: "application/wasm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
};
const ext = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
export const contentType = (path: string) => TYPES[ext(path)] ?? "application/octet-stream";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const COMMON = { "x-robots-tag": "noindex", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const plain = (body: string, status: number, extra: Record<string, string> = {}) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...COMMON, ...extra } });

/** The world's public repos (newest push first), and whether each has an index.html. Anonymous, like a visitor. */
export async function listPublished(forgeBase: string, origin: string, o: { owner?: string; fetch?: (r: Request) => Promise<Response> } = {}): Promise<PublishedRepo[]> {
  const send = o.fetch ?? ((r: Request) => fetch(r));
  const get = async (path: string) => {
    const r = await send(new Request(`${forgeBase}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) }));
    return r.ok ? r.json() : null;
  };
  type Repo = { name: string; owner: { login: string }; description?: string; updated_at: string; empty?: boolean; private?: boolean };
  const repos: Repo[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = (await get(`/api/v1/repos/search?limit=50&page=${page}&sort=updated&order=desc`)) as { data?: Repo[] } | null;
    const data = r?.data ?? [];
    repos.push(...data);
    if (data.length < 50) break;
  }
  const mine = repos.filter((r) => !r.private && !r.empty && (!o.owner || r.owner.login.toLowerCase() === o.owner.toLowerCase()));
  return Promise.all(
    mine.map(async (r) => {
      const path = `${encodeURIComponent(r.owner.login)}/${encodeURIComponent(r.name)}`;
      const index = !!(await get(`/api/v1/repos/${path}/contents/index.html`).catch(() => null));
      return { owner: r.owner.login, repo: r.name, description: r.description ?? "", updatedAt: r.updated_at, index, url: `${origin}${path}/` };
    }),
  );
}

function indexPage(world: string, owner: string | null, repos: PublishedRepo[]): Response {
  const title = owner ? `${owner}'s pages` : `Pages of ${world}`;
  const items = repos
    .map((r) => `<li><a href="${esc(r.url)}">${esc(owner ? r.repo : `${r.owner}/${r.repo}`)}</a>${r.index ? "" : " <small>(no index.html)</small>"}${r.description ? ` — ${esc(r.description)}` : ""} <small>${esc(r.updatedAt.slice(0, 16).replace("T", " "))}</small></li>`)
    .join("");
  const body =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>` +
    `<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px}small{color:#666}</style></head>` +
    `<body><h1>${esc(title)}</h1><p>The default branch of every public repo${owner ? ` of ${esc(owner)}` : ""} in world ${esc(world)}, served as it is.</p>` +
    `${owner ? `<p><a href="/">all pages of this world</a></p>` : ""}<ul>${items || "<li>Nothing published yet.</li>"}</ul></body></html>`;
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...COMMON } });
}

export function createPages(o: PagesOptions): (req: Request, peer?: string) => Promise<Response> {
  const now = o.now ?? Date.now;
  const limiter = new Limiter(now);
  const perMinute = o.perMinute ?? 600;
  const suffix = o.suffix.toLowerCase();
  const send = o.fetch ?? ((r: Request) => fetch(r, { redirect: "manual" }));

  return async (req: Request, peer = "unknown"): Promise<Response> => {
    if (req.method !== "GET" && req.method !== "HEAD") return plain("read-only", 405);
    const url = new URL(req.url);
    const host = (req.headers.get("host") ?? url.host).toLowerCase().replace(/:\d+$/, "");
    if (!host.endsWith(`.${suffix}`)) return plain("no such world", 404);
    const world = worldByLabel(o.db, host.slice(0, -suffix.length - 1));
    if (!world) return plain("no such world", 404);
    const port = o.forgePort(world);
    if (!port) return plain("this world's forge is not running", 503);
    const client = peer === "127.0.0.1" || peer === "::1" ? (req.headers.get("x-real-ip") ?? peer) : peer;
    if (!limiter.allow(client, perMinute)) return plain("slow down", 429, { "retry-after": "60" });

    let segs: string[];
    try {
      segs = url.pathname.split("/").slice(1).map(decodeURIComponent);
    } catch {
      return plain("bad path", 400);
    }
    if (segs.some((s) => s === ".." || s === "." || s.includes("/") || s.includes("\\") || s.includes("\0"))) return plain("bad path", 400);
    const forge = `http://127.0.0.1:${port}`;
    const origin = o.origin(world);
    const [owner = "", repo = "", ...rest] = segs;
    if (!owner) return indexPage(world, null, await listPublished(forge, origin, { fetch: send }).catch(() => []));
    if (segs.length === 1) return Response.redirect(`${url.origin}/${encodeURIComponent(owner)}/`, 301);
    if (!repo) return indexPage(world, owner, await listPublished(forge, origin, { owner, fetch: send }).catch(() => []));
    if (segs.length === 2) return Response.redirect(`${url.origin}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/`, 301);

    const file = rest.join("/") === "" || rest[rest.length - 1] === "" ? [...rest.filter(Boolean), "index.html"] : rest;
    const media = (parts: string[]) => send(new Request(`${forge}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/media/${parts.map(encodeURIComponent).join("/")}`, { method: req.method }));
    let res: Response;
    try {
      res = await media(file);
      // `/dir` with a dir/index.html: on to `/dir/`, so relative links inside it resolve.
      if (!res.ok && !ext(file[file.length - 1]!)) {
        const dir = await media([...file, "index.html"]);
        if (dir.ok) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
      }
    } catch {
      return plain("forge unavailable", 502);
    }
    if (res.status === 404) return plain(`not found: ${url.pathname}\n(pages serve the default branch of public repos)`, 404);
    if (!res.ok) return plain("forge error", 502);
    const path = file.join("/");
    return new Response(req.method === "HEAD" ? null : res.body, { status: 200, headers: { "content-type": contentType(path), "cache-control": "no-cache", ...COMMON } });
  };
}

/** Serve pages on localhost: `<world>.localhost:<port>`. */
export function servePages(o: Omit<PagesOptions, "suffix"> & { port: number }): { stop(): void; port: number } {
  const handle = createPages({ ...o, suffix: "localhost" });
  const server = Bun.serve({ hostname: "127.0.0.1", port: o.port, fetch: (req, srv) => handle(req, srv.requestIP(req)?.address) });
  return { port: server.port ?? o.port, stop: () => server.stop(true) };
}
