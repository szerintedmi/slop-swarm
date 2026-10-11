// Web fetch (docs/plans/2026-10-11-openrouter.md §4): GET-only downloads of PUBLIC URLs for the agents, done
// by the relay so agents never connect out themselves (the egress proxy allowlist stays model APIs + GitHub).
//
// The guard is the whole point:
// - http/https only, ports 80/443 only, no credentials in the URL, a fixed User-Agent, no agent-supplied
//   headers, cookies or body (GET only).
// - SSRF: the relay resolves the hostname itself and refuses if ANY address is not public unicast
//   (loopback, RFC 1918, CGNAT, link-local / cloud metadata, multicast, reserved, ULA, IPv4-mapped…). Docker
//   networks are RFC 1918, so the forge, the proxy and the relay itself are refused by the same rule;
//   single-label names (Docker container names) and .local/.internal/.localhost names are refused up front.
// - Pinning: the connection goes to the vetted address (no second DNS lookup, so no DNS rebinding), with the
//   original Host header and TLS SNI / certificate check against the hostname.
// - Redirects are followed by hand, each hop checked like the first, up to `maxRedirects`.
// - One deadline for the whole fetch (all hops), and a byte cap on the decoded body (checked while streaming,
//   and up front from Content-Length).
// Self-contained (no imports from src/): it is part of the build context of docker/search/Dockerfile.
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import zlib from "node:zlib";

export const USER_AGENT = "slopswarm-agent/1.0 (+research probe; GET only)";
/** What one text answer may hold (a long page costs the agent its tokens); `-o` saves the whole file. */
export const TEXT_MAX_CHARS = 40_000;
export const ALLOWED_PORTS: readonly number[] = [80, 443];
const MAX_URL_CHARS = 2000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface WebfetchLimits {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}

// ---------- address classification ----------

/** Strict dotted quad (the WHATWG URL parser already turned `0x7f.1` or `2130706433` into one). */
export function parseIPv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** 16 bytes, or null. Accepts `::` compression and a trailing dotted quad; a zone id (`%eth0`) is rejected. */
export function parseIPv6(input: string): number[] | null {
  let s = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  if (!s.includes(":") || s.includes("%")) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const v4 = parseIPv4(s.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    s = s.slice(0, lastColon + 1) + "0:0"; // placeholder groups, overwritten below
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  const total = head.length + rest.length;
  if (halves.length === 1 ? total !== 8 : total > 7) return null;
  const all = [...head, ...Array(8 - total).fill("0"), ...rest];
  const bytes: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** IPv4 ranges that are not public unicast (RFC 6890 special-purpose registry and friends). */
const V4_BLOCKED: [number[], number][] = [
  [[0, 0, 0, 0], 8], // "this network"
  [[10, 0, 0, 0], 8], // RFC 1918
  [[100, 64, 0, 0], 10], // CGNAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local, cloud metadata (169.254.169.254)
  [[172, 16, 0, 0], 12], // RFC 1918 (Docker's default pools)
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // TEST-NET-1
  [[192, 88, 99, 0], 24], // 6to4 relay anycast
  [[192, 168, 0, 0], 16], // RFC 1918
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // TEST-NET-2
  [[203, 0, 113, 0], 24], // TEST-NET-3
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved, broadcast
];

function inPrefix(ip: number[], net: number[], bits: number): boolean {
  for (let i = 0; i < 4 && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((ip[i]! & mask) !== (net[i]! & mask)) return false;
  }
  return true;
}

export function isPublicIPv4(b: number[]): boolean {
  return !V4_BLOCKED.some(([net, bits]) => inPrefix(b, net, bits));
}

/** Only global unicast (2000::/3) minus its special blocks; embedded IPv4 (mapped, NAT64, 6to4) is judged as IPv4. */
export function isPublicIPv6(b: number[]): boolean {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPublicIPv4(b.slice(12)); // ::ffff:a.b.c.d
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return isPublicIPv4(b.slice(12)); // 64:ff9b::/96 NAT64
  if ((b[0]! & 0xe0) !== 0x20) return false; // ::, ::1, IPv4-compatible, 64:ff9b:1::/48, 100::/64, fc00::/7, fe80::/10, fec0::/10, ff00::/8, …
  if (b[0] === 0x20 && b[1] === 0x01 && (b[2]! & 0xfe) === 0) return false; // 2001::/23 (Teredo, ORCHID, …)
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false; // 2001:db8::/32 documentation
  if (b[0] === 0x20 && b[1] === 0x02) return isPublicIPv4(b.slice(2, 6)); // 2002::/16 6to4
  if (b[0] === 0x3f && b[1] === 0xff && (b[2]! & 0xf0) === 0) return false; // 3fff::/20 documentation
  return true;
}

/** True only for a public unicast address. Anything unparsable is not public. */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isPublicIPv4(v4);
  const v6 = parseIPv6(ip);
  return v6 ? isPublicIPv6(v6) : false;
}

// ---------- URL checks ----------

export type FetchFailure = "invalid" | "blocked" | "too_large" | "timeout" | "redirects" | "upstream";

export class FetchError extends Error {
  constructor(
    readonly kind: FetchFailure,
    message: string,
  ) {
    super(message);
  }
}

const NON_PUBLIC_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".arpa", ".test", ".invalid", ".example", ".onion"];

/** Parse and check a URL before any network access. Throws FetchError("invalid" | "blocked"). */
export function checkUrl(raw: string, base?: URL): URL {
  if (raw.length > MAX_URL_CHARS) throw new FetchError("invalid", `URL longer than ${MAX_URL_CHARS} characters`);
  let u: URL;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new FetchError("invalid", "not a valid absolute URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new FetchError("blocked", `scheme ${u.protocol.replace(/:$/, "")}: only http and https`);
  if (u.username || u.password) throw new FetchError("blocked", "URLs with credentials (user:pass@) are not allowed");
  const port = u.port === "" ? (u.protocol === "https:" ? 443 : 80) : Number(u.port);
  if (!ALLOWED_PORTS.includes(port)) throw new FetchError("blocked", `port ${port}: only 80 and 443`);
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new FetchError("blocked", `${host} is a private or reserved address`);
  } else {
    const name = host.replace(/\.$/, "");
    if (!name.includes(".")) throw new FetchError("blocked", `${name} is not a public hostname`);
    if (name === "localhost" || NON_PUBLIC_SUFFIXES.some((s) => name.endsWith(s))) throw new FetchError("blocked", `${name} is not a public hostname`);
  }
  u.hash = "";
  return u;
}

// ---------- fetching ----------

export interface FetchDeps {
  /** All addresses of a hostname. */
  resolve: (host: string) => Promise<string[]>;
  /** Where to open the TCP connection for a vetted address (identity in production; tests point it at a local server). */
  connectTo: (ip: string, port: number) => { host: string; port: number };
  now: () => number;
}

export const defaultFetchDeps: FetchDeps = {
  resolve: async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address),
  connectTo: (ip, port) => ({ host: ip, port }),
  now: Date.now,
};

export interface FetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  body: Buffer;
  redirects: number;
}

/** The address to connect to: every resolved address must be public; IPv4 first (the relay's networks have no IPv6 route out). */
export async function vetHost(u: URL, deps: Pick<FetchDeps, "resolve">): Promise<string> {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return host; // checked in checkUrl
  let addrs: string[];
  try {
    addrs = await deps.resolve(host);
  } catch (err) {
    throw new FetchError("upstream", `could not resolve ${host}`);
  }
  if (!addrs.length) throw new FetchError("upstream", `could not resolve ${host}`);
  const bad = addrs.find((a) => !isPublicAddress(a));
  if (bad) throw new FetchError("blocked", `${host} resolves to a private or reserved address (${bad})`);
  return addrs.find((a) => isIP(a) === 4) ?? addrs[0]!;
}

interface Hop {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer | null;
}

const header = (h: http.IncomingHttpHeaders, k: string) => {
  const v = h[k];
  return Array.isArray(v) ? v[0] : v;
};

/** One GET to the pinned address. Redirect answers come back without a body. */
function getOnce(u: URL, ip: string, deadline: number, maxBytes: number, deps: FetchDeps): Promise<Hop> {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const port = u.port === "" ? (u.protocol === "https:" ? 443 : 80) : Number(u.port);
  const target = deps.connectTo(ip, port);
  const mod = u.protocol === "https:" ? https : http;
  return new Promise<Hop>((resolve, reject) => {
    let settled = false;
    const finish = (err: FetchError | null, hop?: Hop) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        req.destroy();
        reject(err);
      } else resolve(hop!);
    };
    const req = mod.request(
      {
        host: target.host,
        port: target.port,
        method: "GET",
        path: `${u.pathname}${u.search}`,
        // SNI and the certificate check go by the hostname, not the pinned address.
        ...(u.protocol === "https:" && !isIP(host) ? { servername: host } : {}),
        headers: {
          host: u.host,
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
          "accept-encoding": "gzip, deflate",
          connection: "close",
        },
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (REDIRECT_STATUSES.has(status) && header(res.headers, "location")) {
          res.resume();
          return finish(null, { status, headers: res.headers, body: null });
        }
        const declared = Number(header(res.headers, "content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) return finish(new FetchError("too_large", `larger than the ${mb(maxBytes)} limit (${declared} bytes declared)`));
        const enc = (header(res.headers, "content-encoding") ?? "").trim().toLowerCase();
        const decoder = enc === "gzip" || enc === "x-gzip" ? zlib.createGunzip() : enc === "deflate" ? zlib.createInflate() : null;
        const stream: NodeJS.ReadableStream = decoder ? res.pipe(decoder) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) return finish(new FetchError("too_large", `larger than the ${mb(maxBytes)} limit; stopped after ${mb(maxBytes)}`));
          chunks.push(c);
        });
        stream.on("end", () => finish(null, { status, headers: res.headers, body: Buffer.concat(chunks) }));
        stream.on("error", (e: Error) => finish(new FetchError("upstream", `bad response body (${e.message.slice(0, 100)})`)));
        res.on("error", (e: Error) => finish(new FetchError("upstream", `connection error (${e.message.slice(0, 100)})`)));
      },
    );
    const timer = setTimeout(() => finish(new FetchError("timeout", "timed out")), Math.max(0, deadline - deps.now()));
    req.on("error", (e: Error) => finish(new FetchError("upstream", `could not fetch ${u.host} (${e.message.slice(0, 150)})`)));
    req.end();
  });
}

const mb = (bytes: number) => `${Math.round((bytes / 1048576) * 10) / 10} MB`;

/**
 * GET a public URL within the limits, following redirects by hand (every hop re-checked). Throws FetchError.
 * `onHop` sees each URL as it is about to be fetched (for the log's final_url on failure).
 */
export async function fetchPublic(rawUrl: string, limits: WebfetchLimits, deps: FetchDeps = defaultFetchDeps, onHop?: (url: string, redirects: number) => void): Promise<FetchResult> {
  const deadline = deps.now() + limits.timeoutMs;
  let u = checkUrl(rawUrl);
  for (let redirects = 0; ; redirects++) {
    onHop?.(u.href, redirects);
    const ip = await withDeadline(vetHost(u, deps), deadline, deps);
    const hop = await getOnce(u, ip, deadline, limits.maxBytes, deps);
    if (hop.body === null) {
      if (redirects >= limits.maxRedirects) throw new FetchError("redirects", `more than ${limits.maxRedirects} redirects`);
      u = checkUrl(header(hop.headers, "location")!, u);
      continue;
    }
    return { finalUrl: u.href, status: hop.status, contentType: (header(hop.headers, "content-type") ?? "").slice(0, 200), body: hop.body, redirects };
  }
}

async function withDeadline<T>(p: Promise<T>, deadline: number, deps: Pick<FetchDeps, "now">): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new FetchError("timeout", "timed out")), Math.max(0, deadline - deps.now()))));
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- what the agent gets ----------

export type ContentKind = "html" | "text" | "binary";

/** By Content-Type; without one, a body with no NUL bytes in its first KB is text (HTML if it looks like it). */
export function contentKind(contentType: string, body: Buffer): ContentKind {
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (/^text\//.test(mime) || /^application\/(json|xml|javascript|ecmascript|x-javascript|yaml|x-yaml|toml|x-sh|csv|sql|graphql|x-ndjson|ndjson)$/.test(mime) || /\+(json|xml)$/.test(mime))
    return "text";
  if (mime) return "binary";
  const head = body.subarray(0, 1024);
  if (head.includes(0)) return "binary";
  return /^\s*(<!doctype html|<html)/i.test(head.toString("utf8")) ? "html" : "text";
}

/** Decode with the declared charset (Content-Type, or an HTML meta tag), UTF-8 otherwise. */
export function decodeBody(body: Buffer, contentType: string, kind: ContentKind): string {
  let charset = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType)?.[1];
  if (!charset && kind === "html") charset = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(body.subarray(0, 4096).toString("latin1"))?.[1];
  try {
    return new TextDecoder((charset ?? "utf-8") as ConstructorParameters<typeof TextDecoder>[0]).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", middot: "·", bull: "•", euro: "€", pound: "£", yen: "¥",
  cent: "¢", deg: "°", times: "×", divide: "÷", para: "¶", sect: "§", shy: "", zwj: "", zwnj: "", larr: "←", rarr: "→", uarr: "↑", darr: "↓",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "";
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? accented(e) ?? m;
  });
}

const ACCENTS: Record<string, string> = { acute: "\u0301", grave: "\u0300", circ: "\u0302", uml: "\u0308", tilde: "\u0303", ring: "\u030a", cedil: "\u0327" };
/** `&eacute;`, `&Uuml;`, `&ccedil;`… as letter + combining mark, composed. */
function accented(e: string): string | undefined {
  const mark = ACCENTS[e.slice(1)];
  return mark && /^[a-zA-Z]$/.test(e[0]!) ? (e[0]! + mark).normalize("NFC") : e === "szlig" ? "ß" : undefined;
}

/** Elements dropped with their content: code, styling, embedded media and page chrome (nav, footer, sidebars). */
const DROP = ["script", "style", "noscript", "template", "svg", "math", "iframe", "object", "embed", "canvas", "head", "select", "button", "nav", "footer", "aside", "dialog"];
const BLOCK = new Set(["p", "div", "section", "article", "header", "main", "blockquote", "figure", "figcaption", "table", "thead", "tbody", "ul", "ol", "dl", "address", "details", "summary", "form", "fieldset", "center", "hgroup"]);

/**
 * A small HTML → markdown-ish text converter (no dependencies, keeps the relay image small): drops scripts,
 * styles and page chrome, prefers <main>/<article>, keeps headings, lists, code blocks, table rows and links
 * as `[text](absolute url)`. Not a full HTML parser; it aims at readable text, not fidelity.
 */
export function htmlToText(html: string, baseUrl: string): { title: string; text: string } {
  const title = squash(decodeEntities(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? ""));
  let h = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  for (const t of DROP) h = h.replace(new RegExp(`<${t}\\b[^>]*>[\\s\\S]*?<\\/${t}\\s*>`, "gi"), " ");
  const inner = (tag: string) => {
    const start = new RegExp(`<${tag}\\b[^>]*>`, "i").exec(h);
    const end = h.toLowerCase().lastIndexOf(`</${tag}`);
    return start && end > start.index ? h.slice(start.index + start[0].length, end) : null;
  };
  h = inner("main") ?? inner("article") ?? inner("body") ?? h;

  const out: string[] = [];
  const tail = () => {
    let s = "";
    for (let i = out.length - 1; i >= 0 && s.length < 2; i--) s = out[i] + s;
    return s.slice(-2);
  };
  const block = () => {
    const t = tail();
    if (out.length && t !== "\n\n") out.push(t.endsWith("\n") ? "\n" : "\n\n");
  };
  const line = () => {
    if (out.length && !tail().endsWith("\n")) out.push("\n");
  };
  const lists: { ordered: boolean; n: number }[] = [];
  const links: { at: number; href: string }[] = [];
  let pre = 0;
  let cell = 0;
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0;
  const text = (s: string) => {
    if (!s) return;
    let t = decodeEntities(s);
    if (!pre) {
      t = t.replace(/\s+/g, " ");
      const prev = out.length ? out[out.length - 1]! : "\n";
      if (prev.endsWith("\n") || prev.endsWith(" ")) t = t.trimStart();
    }
    if (t) out.push(t);
  };
  for (let m: RegExpExecArray | null; (m = tagRe.exec(h)); ) {
    text(h.slice(last, m.index));
    last = tagRe.lastIndex;
    const close = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    const attrs = m[3] ?? "";
    if (/^h[1-6]$/.test(tag)) {
      block();
      if (!close) out.push("#".repeat(Number(tag[1])) + " ");
    } else if (tag === "br") line();
    else if (tag === "hr") {
      block();
      out.push("---");
      block();
    } else if (tag === "pre") {
      if (close) {
        pre = Math.max(0, pre - 1);
        line();
        out.push("```");
        block();
      } else {
        block();
        pre++;
        out.push("```\n");
      }
    } else if (tag === "code" && !pre) out.push("`");
    else if (tag === "ul" || tag === "ol") {
      if (close) lists.pop();
      else lists.push({ ordered: tag === "ol", n: 0 });
      if (lists.length === 0 || !close) block();
    } else if (tag === "li" && !close) {
      line();
      const l = lists.at(-1);
      out.push("  ".repeat(Math.max(0, lists.length - 1)) + (l?.ordered ? `${++l.n}. ` : "- "));
    } else if (tag === "tr") {
      line();
      cell = 0;
    } else if ((tag === "td" || tag === "th") && !close) {
      if (cell++ > 0) out.push(" | ");
    } else if (tag === "dt" || tag === "dd") line();
    else if (tag === "a") {
      if (!close) {
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
        links.push({ at: out.length, href: decodeEntities(href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim() });
      } else {
        const l = links.pop();
        if (l) {
          const label = out.splice(l.at).join("").replace(/\s+/g, " ").trim();
          const abs = absolute(l.href, baseUrl);
          out.push(label && abs ? `[${label}](${abs})` : label);
        }
      }
    } else if (BLOCK.has(tag)) block();
  }
  text(h.slice(last));
  const body = out
    .join("")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: body };
}

function absolute(href: string, base: string): string | null {
  if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return null;
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u.href : null;
  } catch {
    return null;
  }
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** The text answer: a one-line header, the title, then the (capped) readable body. */
export function textAnswer(r: FetchResult, kind: Exclude<ContentKind, "binary">, maxChars = TEXT_MAX_CHARS): string {
  const decoded = decodeBody(r.body, r.contentType, kind);
  const { title, text } = kind === "html" ? htmlToText(decoded, r.finalUrl) : { title: "", text: decoded };
  const head = [`URL: ${r.finalUrl} (HTTP ${r.status}, ${r.contentType.split(";")[0] || "no content-type"}, ${r.body.length} bytes)`];
  if (title) head.push(`Title: ${title}`);
  const cut = text.length > maxChars;
  return `${head.join("\n")}\n\n${cut ? text.slice(0, maxChars) : text}${cut ? `\n\n[truncated: showing ${maxChars} of ${text.length} characters; \`webfetch URL -o FILE\` saves the whole file]` : ""}\n`;
}
