// Web fetch through the relay: the SSRF guard (address classifier, URL checks, DNS pinning, redirects), limits,
// HTML → text, raw passthrough, token auth, logging, the `webfetch` CLI, config and the system prompt block
// for every harness (docker/search/webfetch.ts, docker/search/relay.ts /fetch, src/webfetch.ts).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler, webfetchFromEnv, type RelayDeps } from "../docker/search/relay.ts";
import {
  checkUrl,
  contentKind,
  decodeEntities,
  FetchError,
  fetchPublic,
  htmlToText,
  isPublicAddress,
  parseIPv6,
  TEXT_MAX_CHARS,
  USER_AGENT,
  type FetchDeps,
  type WebfetchLimits,
} from "../docker/search/webfetch.ts";
import { loadSwarm, parseSwarm, type SwarmConfig } from "../src/config.ts";
import { Controller } from "../src/controller/index.ts";
import { createRun } from "../src/controller/run.ts";
import type { ProcessHandle } from "../src/controller/wake.ts";
import { agentDirs, openDb } from "../src/db/index.ts";
import { renderReport } from "../src/report.ts";
import { issueSearchToken, relayNeeded, revokeSearchToken, runSearchDirs, searchDirs, searchHost, searchRunArgs, tokenPath } from "../src/search.ts";
import { readFetchLog, webfetchPromptBlock } from "../src/webfetch.ts";

const dataDir = mkdtempSync(join(tmpdir(), "slopswarm-webfetch-test-"));
process.env.SLOPSWARM_DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

// ---------- address classifier ----------

describe("address classifier", () => {
  test("IPv4: only public unicast passes", () => {
    for (const ip of ["93.184.215.14", "8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "198.17.255.255", "198.20.0.1", "223.255.255.255", "169.253.0.1", "192.0.1.1", "11.0.0.1"])
      expect([ip, isPublicAddress(ip)]).toEqual([ip, true]);
    for (const ip of [
      "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254",
      "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.17.0.2", "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.88.99.1",
      "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    ])
      expect([ip, isPublicAddress(ip)]).toEqual([ip, false]);
  });

  test("IPv6: global unicast passes; loopback, ULA, link-local, multicast, documentation and embedded private IPv4 don't", () => {
    for (const ip of ["2606:4700:10::6814:179a", "2a00:1450:4001:82a::200e", "2001:4860:4860::8888", "::ffff:93.184.215.14", "::ffff:5db8:d70e", "64:ff9b::808:808", "2002:5db8:d70e::1"])
      expect([ip, isPublicAddress(ip)]).toEqual([ip, true]);
    for (const ip of [
      "::", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:0:0",
      "::127.0.0.1", "::ffff:0:7f00:1", "64:ff9b::a00:1", "64:ff9b:1::1", "100::1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0",
      "febf::1", "fec0::1", "ff02::1", "2001:db8::1", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2002:7f00:1::1", "2002:a00:1::",
      "3fff::1", "[::1]",
    ])
      expect([ip, isPublicAddress(ip)]).toEqual([ip, false]);
  });

  test("garbage is not public", () => {
    for (const s of ["", "localhost", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4x", "1::2::3", "12345::1", "::g", "1:2:3:4:5:6:7:8:9", "example.com"]) expect([s, isPublicAddress(s)]).toEqual([s, false]);
    expect(parseIPv6("1:2:3:4:5:6:1.2.3.4")).toEqual([0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 1, 2, 3, 4]);
  });
});

// ---------- URL checks ----------

const blockedBy = (raw: string) => {
  try {
    checkUrl(raw);
    return null;
  } catch (e) {
    return e instanceof FetchError ? `${e.kind}: ${e.message}` : String(e);
  }
};

describe("URL checks", () => {
  test("public http(s) on 80/443 passes; the fragment is dropped", () => {
    expect(checkUrl("https://example.com/a?b=1#frag").href).toBe("https://example.com/a?b=1");
    expect(checkUrl("http://example.com:80/").href).toBe("http://example.com/");
    expect(checkUrl("http://example.com:443/").port).toBe("443");
    expect(checkUrl("http://93.184.215.14/").hostname).toBe("93.184.215.14");
  });

  test("schemes, credentials, ports, private literals and internal names are blocked", () => {
    expect(blockedBy("ftp://example.com/")).toStartWith("blocked: scheme ftp");
    expect(blockedBy("file:///etc/passwd")).toStartWith("blocked: scheme file");
    expect(blockedBy("gopher://example.com/")).toStartWith("blocked: scheme gopher");
    expect(blockedBy("https://user:pw@example.com/")).toStartWith("blocked: URLs with credentials");
    expect(blockedBy("https://user@example.com/")).toStartWith("blocked: URLs with credentials");
    expect(blockedBy("http://example.com:8080/")).toBe("blocked: port 8080: only 80 and 443");
    expect(blockedBy("https://example.com:22/")).toBe("blocked: port 22: only 80 and 443");
    expect(blockedBy("http://127.0.0.1:7777/")).toBe("blocked: port 7777: only 80 and 443");
    for (const u of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://192.168.0.1/", "http://172.17.0.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[fd00::1]/", "http://0.0.0.0/"])
      expect([u, blockedBy(u)]).toEqual([u, expect.stringContaining("is a private or reserved address")]);
    // Obfuscated IPv4 forms are normalised by the URL parser first.
    for (const u of ["http://2130706433/", "http://0x7f.1/", "http://0177.0.0.1/", "http://127.1/", "http://0xa9fea9fe/"])
      expect([u, blockedBy(u)]).toEqual([u, expect.stringContaining("is a private or reserved address")]);
    // Docker container names (the forge, proxy, relay) are single-label; reserved suffixes too.
    for (const u of ["http://slopswarm-proxy/", "http://slopswarm-forge-r1/", `http://${searchHost("r1")}/`, "http://localhost/", "http://foo.localhost/", "http://printer.local/", "http://metadata.google.internal/", "http://host.docker.internal/", "http://x.test/"])
      expect([u, blockedBy(u)]).toEqual([u, expect.stringContaining("is not a public hostname")]);
    expect(blockedBy("not a url")).toStartWith("invalid:");
    expect(blockedBy("https://example.com/" + "a".repeat(2100))).toStartWith("invalid: URL longer");
  });
});

// ---------- fetching against a local server ----------

/** Fake public DNS: names resolve to public addresses; connections to them go to the local test server. */
const PUBLIC_IP = "93.184.215.14";
const OTHER_PUBLIC_IP = "93.184.215.15";

const big = Buffer.alloc(3 * 1024 * 1024, 0x61);
const PAGE = `<!doctype html><html><head><title>Test &amp; Page</title><style>body{color:red}</style><script>alert("x")</script></head>
<body><nav><a href="/home">Home</a> | <a href="/about">About</a></nav>
<main><h1>Hello  world</h1><p>First <b>para</b> with a <a href="/docs/x?y=1">relative link</a> and <a href="https://other.example.org/">an absolute one</a>.</p>
<ul><li>one</li><li>two <a href="#top">top</a></li></ul><pre>  code  block
  kept</pre><p>caf&eacute; &copy; 2026 &#8212; &#x2603;</p><script>var hidden = 1;</script>
<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table></main>
<footer>Copyright boilerplate</footer></body></html>`;

let hits: { path: string; host: string | null; ua: string | null; method: string; cookie: string | null; auth: string | null }[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url);
    hits.push({ path: u.pathname + u.search, host: req.headers.get("host"), ua: req.headers.get("user-agent"), method: req.method, cookie: req.headers.get("cookie"), auth: req.headers.get("authorization") });
    switch (u.pathname) {
      case "/page":
        return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      case "/plain":
        return new Response("just text\n", { headers: { "content-type": "text/plain" } });
      case "/json":
        return new Response('{"a":1}', { headers: { "content-type": "application/json" } });
      case "/pdf":
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 1, 2, 255]), { headers: { "content-type": "application/pdf" } });
      case "/gzip":
        return new Response(gzipSync(Buffer.from("compressed hello")), { headers: { "content-type": "text/plain", "content-encoding": "gzip" } });
      case "/bomb":
        return new Response(gzipSync(big), { headers: { "content-type": "text/plain", "content-encoding": "gzip" } });
      case "/big":
        return new Response(big, { headers: { "content-type": "application/octet-stream" } });
      case "/big-stream":
        // No Content-Length: the cap has to stop it while streaming.
        return new Response(
          new ReadableStream({
            async pull(c) {
              c.enqueue(new Uint8Array(256 * 1024));
              await Bun.sleep(1);
            },
          }),
          { headers: { "content-type": "application/octet-stream" } },
        );
      case "/longtext":
        return new Response("x".repeat(TEXT_MAX_CHARS + 500), { headers: { "content-type": "text/plain" } });
      case "/slow":
        await Bun.sleep(2000);
        return new Response("late");
      case "/404":
        return new Response("<html><body><p>Not here</p></body></html>", { status: 404, headers: { "content-type": "text/html" } });
      case "/redir":
        return new Response(null, { status: 302, headers: { location: u.searchParams.get("to") ?? "/page" } });
      case "/loop":
        return new Response(null, { status: 301, headers: { location: "/loop" } });
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));

let dns: Record<string, string[]> = {};
const connects: { ip: string; port: number }[] = [];
const fetchDeps: FetchDeps = {
  resolve: async (host) => {
    const a = dns[host];
    if (!a) throw new Error("ENOTFOUND");
    return a;
  },
  connectTo: (ip, port) => {
    connects.push({ ip, port });
    // Only vetted public addresses ever reach here; they all map to the local test server.
    if (!isPublicAddress(ip)) throw new Error(`connect to non-public ${ip}`);
    return { host: "127.0.0.1", port: server.port! };
  },
  now: Date.now,
};
const LIMITS: WebfetchLimits = { maxBytes: 1024 * 1024, timeoutMs: 1000, maxRedirects: 3 };

const failure = async (url: string, limits = LIMITS) => {
  try {
    await fetchPublic(url, limits, fetchDeps);
    return null;
  } catch (e) {
    return e instanceof FetchError ? `${e.kind}: ${e.message}` : `other: ${String(e)}`;
  }
};

beforeEach(() => {
  hits = [];
  connects.length = 0;
  dns = { "site.example.com": [PUBLIC_IP], "other.example.com": [OTHER_PUBLIC_IP], "internal.example.com": ["10.0.0.5"], "mixed.example.com": [PUBLIC_IP, "127.0.0.1"], "v6.example.com": ["fd00::1"], "meta.example.com": ["169.254.169.254"] };
});

describe("fetching", () => {
  test("GET to the pinned address with the original Host, a fixed User-Agent and nothing from the agent", async () => {
    const r = await fetchPublic("http://site.example.com/page", LIMITS, fetchDeps);
    expect(r.status).toBe(200);
    expect(r.finalUrl).toBe("http://site.example.com/page");
    expect(r.contentType).toBe("text/html; charset=utf-8");
    expect(connects).toEqual([{ ip: PUBLIC_IP, port: 80 }]);
    expect(hits).toEqual([{ path: "/page", host: "site.example.com", ua: USER_AGENT, method: "GET", cookie: null, auth: null }]);
  });

  test("DNS: any private address in the answer blocks the fetch; nothing is connected", async () => {
    expect(await failure("http://internal.example.com/")).toBe("blocked: internal.example.com resolves to a private or reserved address (10.0.0.5)");
    expect(await failure("http://mixed.example.com/")).toContain("resolves to a private or reserved address (127.0.0.1)");
    expect(await failure("http://v6.example.com/")).toContain("(fd00::1)");
    expect(await failure("http://meta.example.com/")).toContain("(169.254.169.254)");
    expect(await failure("http://nowhere.example.com/")).toBe("upstream: could not resolve nowhere.example.com");
    expect(connects).toEqual([]);
    expect(hits).toEqual([]);
  });

  test("DNS is looked up once per hop and the connection goes to that address (no rebinding window)", async () => {
    let calls = 0;
    const flipping: FetchDeps = {
      ...fetchDeps,
      resolve: async () => (calls++ === 0 ? [PUBLIC_IP] : ["127.0.0.1"]),
    };
    const r = await fetchPublic("http://site.example.com/plain", LIMITS, flipping);
    expect(r.status).toBe(200);
    expect(calls).toBe(1);
    expect(connects).toEqual([{ ip: PUBLIC_IP, port: 80 }]);
  });

  test("redirects: followed by hand, every hop re-checked", async () => {
    const r = await fetchPublic(`http://site.example.com/redir?to=${encodeURIComponent("http://other.example.com/plain")}`, LIMITS, fetchDeps);
    expect(r).toMatchObject({ finalUrl: "http://other.example.com/plain", status: 200, redirects: 1 });
    expect(connects.map((c) => c.ip)).toEqual([PUBLIC_IP, OTHER_PUBLIC_IP]);
    // Public → private: refused at the hop, never connected.
    for (const to of ["http://internal.example.com/", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://slopswarm-proxy/"]) {
      connects.length = 0;
      expect([to, await failure(`http://site.example.com/redir?to=${encodeURIComponent(to)}`)]).toEqual([to, expect.stringMatching(/^blocked: /)]);
      expect(connects).toHaveLength(1);
    }
    expect(await failure(`http://site.example.com/redir?to=${encodeURIComponent("http://other.example.com:8080/")}`)).toBe("blocked: port 8080: only 80 and 443");
    expect(await failure(`http://site.example.com/redir?to=${encodeURIComponent("file:///etc/passwd")}`)).toStartWith("blocked: scheme file");
    expect(await failure(`http://site.example.com/redir?to=${encodeURIComponent("https://u:p@other.example.com/")}`)).toStartWith("blocked: URLs with credentials");
    expect(await failure("http://site.example.com/loop")).toBe("redirects: more than 3 redirects");
    expect(await failure("http://site.example.com/redir", { ...LIMITS, maxRedirects: 0 })).toBe("redirects: more than 0 redirects");
  });

  test("limits: size (declared, streamed, decompressed) and one deadline", async () => {
    expect(await failure("http://site.example.com/big")).toStartWith("too_large: larger than the 1 MB limit");
    expect(await failure("http://site.example.com/big-stream")).toStartWith("too_large: larger than the 1 MB limit; stopped");
    expect(await failure("http://site.example.com/bomb")).toStartWith("too_large:");
    const t0 = Date.now();
    expect(await failure("http://site.example.com/slow", { ...LIMITS, timeoutMs: 300 })).toBe("timeout: timed out");
    expect(Date.now() - t0).toBeLessThan(1500);
    const gz = await fetchPublic("http://site.example.com/gzip", LIMITS, fetchDeps);
    expect(gz.body.toString()).toBe("compressed hello");
  });
});

// ---------- HTML → text ----------

describe("HTML to text", () => {
  test("drops scripts, styles and chrome; keeps headings, lists, code, tables and absolute links", () => {
    const { title, text } = htmlToText(PAGE, "http://site.example.com/page");
    expect(title).toBe("Test & Page");
    expect(text).toContain("# Hello world");
    expect(text).toContain("First para with a [relative link](http://site.example.com/docs/x?y=1) and [an absolute one](https://other.example.org/).");
    expect(text).toContain("- one\n- two top");
    expect(text).toContain("```\n  code  block\n  kept\n```");
    expect(text).toContain("café © 2026 — ☃");
    expect(text).toContain("a | b\n1 | 2");
    for (const gone of ["alert", "color:red", "hidden", "Home", "About", "Copyright boilerplate"]) expect(text).not.toContain(gone);
  });

  test("no <main>: the body; javascript: links lose their target; entities", () => {
    const { text } = htmlToText(`<body><p>A <a href="javascript:alert(1)">click</a></p><ol><li>x</li><li>y</li></ol></body>`, "https://e.example.org/");
    expect(text).toBe("A click\n\n1. x\n2. y");
    expect(decodeEntities("&lt;b&gt; &amp;amp; &#0; &unknown; &#x110000;")).toBe("<b> &amp;  &unknown; ");
  });

  test("content kinds", () => {
    expect(contentKind("text/html; charset=utf-8", Buffer.from(""))).toBe("html");
    expect(contentKind("application/xhtml+xml", Buffer.from(""))).toBe("html");
    for (const t of ["text/plain", "text/csv", "application/json", "application/ld+json", "application/rss+xml", "application/xml", "application/javascript"]) expect([t, contentKind(t, Buffer.from(""))]).toEqual([t, "text"]);
    for (const t of ["application/pdf", "image/png", "application/zip", "application/octet-stream"]) expect([t, contentKind(t, Buffer.from(""))]).toEqual([t, "binary"]);
    expect(contentKind("", Buffer.from("<!DOCTYPE html><p>x"))).toBe("html");
    expect(contentKind("", Buffer.from("plain"))).toBe("text");
    expect(contentKind("", Buffer.from([1, 0, 2]))).toBe("binary");
  });
});

// ---------- relay /fetch ----------

function scratch(): ReturnType<typeof searchDirs> {
  const d = searchDirs(mkdtempSync(join(dataDir, "relay-")));
  mkdirSync(d.tokens, { recursive: true });
  mkdirSync(d.log, { recursive: true });
  return d;
}

function relay(d: ReturnType<typeof searchDirs>, over: Partial<RelayDeps> = {}) {
  const exa: string[] = [];
  const deps: RelayDeps = {
    apiKey: "exa-key",
    tokensFile: d.tokensFile,
    logFile: d.logFile,
    fetch: async (url) => {
      exa.push(url);
      return new Response('{"results":[]}', { status: 200 });
    },
    now: Date.now,
    timeoutMs: 1000,
    webfetch: LIMITS,
    fetchLogFile: d.fetchLogFile,
    fetchDeps,
    ...over,
  };
  return { handler: createHandler(deps), exa };
}

const post = (path: string, token: string | null, body: unknown) =>
  new Request(`http://relay:8080${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const tokenOf = (runtimeDir: string) => readFileSync(tokenPath(runtimeDir), "utf8").trim();

describe("relay /fetch", () => {
  test("auth: a running wake's token; fetch-only tokens can't search; disabled answers 503", async () => {
    const d = scratch();
    const rt = mkdtempSync(join(dataDir, "rt-"));
    const { handler, exa } = relay(d);
    expect((await handler(post("/fetch", null, { url: "http://site.example.com/plain" }))).status).toBe(401);
    expect((await handler(post("/fetch", "A".repeat(43), { url: "http://site.example.com/plain" }))).status).toBe(401);
    issueSearchToken(d, rt, "bramble", 5, { search: false });
    const token = tokenOf(rt);
    expect((await handler(post("/fetch", token, { url: "http://site.example.com/plain" }))).status).toBe(200);
    const s = await handler(post("/search", token, { query: "x" }));
    expect(s.status).toBe(403);
    expect(await s.text()).toContain("not available to this agent");
    expect(exa).toEqual([]);
    expect((await relay(d, { webfetch: null }).handler(post("/fetch", token, { url: "http://site.example.com/plain" }))).status).toBe(503);
    expect((await handler(new Request("http://relay:8080/fetch"))).status).toBe(405);
    expect(await (await handler(new Request("http://relay:8080/health"))).json()).toEqual({ ok: true, exa: true, webfetch: true });
    revokeSearchToken(d, 5);
    expect((await handler(post("/fetch", token, { url: "http://site.example.com/plain" }))).status).toBe(401);
    // Only the authorised, enabled fetch was logged.
    expect(readFetchLog(d.fetchLogFile)).toHaveLength(1);
  });

  test("answers: text with a header, raw bytes, binary needs -o, errors with their status; every fetch logged", async () => {
    const d = scratch();
    const rt = mkdtempSync(join(dataDir, "rt-"));
    issueSearchToken(d, rt, "wren", 9);
    const token = tokenOf(rt);
    const { handler } = relay(d);
    const call = (body: unknown) => handler(post("/fetch", token, body));

    const page = await call({ url: "http://site.example.com/page" });
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toStartWith(`URL: http://site.example.com/page (HTTP 200, text/html, ${Buffer.byteLength(PAGE)} bytes)\nTitle: Test & Page\n\n# Hello world`);
    expect(page.headers.get("x-webfetch-status")).toBe("200");

    const pdf = await call({ url: "http://site.example.com/pdf", raw: true });
    expect(pdf.status).toBe(200);
    expect([...new Uint8Array(await pdf.arrayBuffer())]).toEqual([0x25, 0x50, 0x44, 0x46, 0, 1, 2, 255]);
    expect(pdf.headers.get("x-webfetch-type")).toBe("application/pdf");
    expect(pdf.headers.get("x-webfetch-bytes")).toBe("8");

    const bin = await call({ url: "http://site.example.com/pdf" });
    expect(bin.status).toBe(415);
    expect(await bin.text()).toContain("webfetch URL -o FILE");

    expect(await (await call({ url: "http://site.example.com/json" })).text()).toEndWith('\n\n{"a":1}\n');
    const long = await (await call({ url: "http://site.example.com/longtext" })).text();
    expect(long).toContain(`[truncated: showing ${TEXT_MAX_CHARS} of ${TEXT_MAX_CHARS + 500} characters`);

    const nf = await call({ url: "http://site.example.com/404" });
    expect(nf.status).toBe(200);
    expect(nf.headers.get("x-webfetch-status")).toBe("404");
    expect(await nf.text()).toContain("Not here");

    const priv = await call({ url: "http://169.254.169.254/latest/meta-data/" });
    expect(priv.status).toBe(403);
    expect(await priv.text()).toBe("webfetch: blocked: 169.254.169.254 is a private or reserved address\n");
    expect((await call({ url: "http://site.example.com/big" })).status).toBe(413);
    expect((await call({ url: "http://nowhere.example.com/" })).status).toBe(502);
    expect((await call({ url: "nope" })).status).toBe(400);
    expect((await call({ url: "http://site.example.com/", raw: "yes" })).status).toBe(400);
    expect((await call({})).status).toBe(400);
    expect((await handler(post("/fetch", token, "{bad"))).status).toBe(400);

    const log = readFetchLog(d.fetchLogFile, 9);
    expect(log.map((e) => [e.url.replace("http://site.example.com", ""), e.relay_status, e.status])).toEqual([
      ["/page", 200, 200],
      ["/pdf", 200, 200],
      ["/pdf", 415, 200],
      ["/json", 200, 200],
      ["/longtext", 200, 200],
      ["/404", 200, 404],
      ["http://169.254.169.254/latest/meta-data/", 403, null],
      ["/big", 413, null],
      ["http://nowhere.example.com/", 502, null],
      ["nope", 400, null],
    ]);
    expect(log[0]).toMatchObject({ agent: "wren", wake: 9, final_url: "http://site.example.com/page", content_type: "text/html; charset=utf-8", raw: false, blocked: null, error: null });
    expect(log[1]).toMatchObject({ raw: true, bytes: 8 });
    expect(log[6]!.blocked).toBe("169.254.169.254 is a private or reserved address");
    expect(log[7]!.error).toStartWith("too_large:");
    expect(log[9]!.blocked).toBe("not a valid absolute URL");
  });

  test("a redirect to a private address is logged with the hop it stopped at", async () => {
    const d = scratch();
    const rt = mkdtempSync(join(dataDir, "rt-"));
    issueSearchToken(d, rt, "wren", 3);
    const res = await relay(d).handler(post("/fetch", tokenOf(rt), { url: `http://site.example.com/redir?to=${encodeURIComponent("http://internal.example.com/x")}` }));
    expect(res.status).toBe(403);
    const [e] = readFetchLog(d.fetchLogFile);
    expect(e).toMatchObject({ final_url: "http://internal.example.com/x", redirects: 1, blocked: "internal.example.com resolves to a private or reserved address (10.0.0.5)" });
  });

  test("relay env: limits turn /fetch on; missing or bad values leave it off", () => {
    expect(webfetchFromEnv({ WEBFETCH_MAX_BYTES: "100", WEBFETCH_TIMEOUT_MS: "2000", WEBFETCH_MAX_REDIRECTS: "0" })).toEqual({ maxBytes: 100, timeoutMs: 2000, maxRedirects: 0 });
    expect(webfetchFromEnv({})).toBeNull();
    expect(webfetchFromEnv({ WEBFETCH_MAX_BYTES: "100", WEBFETCH_TIMEOUT_MS: "x", WEBFETCH_MAX_REDIRECTS: "1" })).toBeNull();
    const argv = searchRunArgs({ runId: "r1", image: "img", network: "n", dir: "/d", withKey: false, webfetch: { maxBytes: 5, timeoutMs: 6, maxRedirects: 7 } }).join(" ");
    expect(argv).toContain("-e WEBFETCH_MAX_BYTES=5 -e WEBFETCH_TIMEOUT_MS=6 -e WEBFETCH_MAX_REDIRECTS=7 img");
    expect(searchRunArgs({ runId: "r1", image: "img", network: "n", dir: "/d", withKey: false }).join(" ")).not.toContain("WEBFETCH");
  });
});

// ---------- the CLI ----------

const hasTools = ["bash", "curl", "jq"].every((t) => Bun.which(t));

describe.skipIf(!hasTools)("webfetch CLI", () => {
  const d = scratch();
  const runtime = mkdtempSync(join(dataDir, "rt-"));
  const { handler } = relay(d);
  const relayServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  afterAll(() => relayServer.stop(true));
  issueSearchToken(d, runtime, "wren", 21, { search: false });

  const run = async (args: string[], env: Record<string, string> = {}) => {
    const p = Bun.spawn(["bash", "docker/webfetch", ...args], {
      env: { PATH: process.env.PATH!, SLOPSWARM_SEARCH_URL: relayServer.url.href, SLOPSWARM_SEARCH_TOKEN_FILE: tokenPath(runtime), ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  };

  test("prints text; -o saves the raw bytes", async () => {
    const r = await run(["http://site.example.com/page"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("# Hello world");
    const file = join(runtime, "doc.pdf");
    const s = await run(["http://site.example.com/pdf", "-o", file]);
    expect(s.code).toBe(0);
    expect(s.out).toBe(`saved 8 bytes (application/pdf, HTTP 200) from http://site.example.com/pdf to ${file}\n`);
    expect([...readFileSync(file)]).toEqual([0x25, 0x50, 0x44, 0x46, 0, 1, 2, 255]);
  });

  test("exit codes: usage, disabled, blocked, too large, timeout, HTTP error, binary", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["a", "b"])).code).toBe(2);
    expect((await run(["nope"])).code).toBe(2);
    expect((await run(["http://site.example.com/"], { SLOPSWARM_SEARCH_URL: "" })).code).toBe(3);
    const blocked = await run(["http://169.254.169.254/"]);
    expect(blocked.code).toBe(4);
    expect(blocked.err).toBe("webfetch: blocked: 169.254.169.254 is a private or reserved address\n");
    expect((await run(["http://site.example.com:8080/"])).code).toBe(4);
    expect((await run(["http://site.example.com/big"])).code).toBe(5);
    expect((await run(["http://site.example.com/slow"])).code).toBe(6);
    const nf = await run(["http://site.example.com/404"]);
    expect(nf.code).toBe(7);
    expect(nf.out).toContain("Not here");
    expect(nf.err).toBe("webfetch: the site answered HTTP 404\n");
    const bin = await run(["http://site.example.com/pdf"]);
    expect(bin.code).toBe(8);
    expect(bin.err).toContain("-o FILE");
    const down = await run(["http://site.example.com/"], { SLOPSWARM_SEARCH_URL: "http://127.0.0.1:9" });
    expect(down.code).toBe(1);
    expect(down.err).toContain("webfetch: relay unreachable");
    // The token never appears in argv: it goes in through a header file.
    expect(readFileSync("docker/webfetch", "utf8")).toContain("-H @<(printf 'Authorization: Bearer %s\\n'");
  }, 15_000);
});

// ---------- config, relay start, prompt for every harness ----------

const base = loadSwarm("config/smoke.yaml");
function config(webfetch: unknown): SwarmConfig {
  const parsed = parseSwarm(
    {
      run: { name: "wf-test", max_duration_min: 120 },
      agents: ["bramble", "sorrel", "fern", "wren"],
      budgets: { swarm_usd: 1, per_agent_usd: 0.5, per_wake: { max_usd: 0.1, max_turns: 10, timeout_min: 5 } },
      scheduler: { max_sleep_min: 15, max_concurrent_wakes: 4 },
      controller: { tick_s: 1 },
      network: { name: "slopswarm-internal", proxy: "http://slopswarm-proxy:8888", allowlist: ["api.anthropic.com", "openrouter.ai"] },
      ...(webfetch !== undefined ? { webfetch } : {}),
    },
    (name) =>
      name === "fern"
        ? { name, harness: "pi", provider: "openrouter", model: "z-ai/glm-5.3-flash@preset/sw-glm-5-3-flash", key_env: "TEST_WF_KEY", effort: "low" }
        : name === "sorrel"
          ? { name, harness: "codex", model: "gpt-6-luna", effort: "low" }
          : { name, harness: "claude", model: "claude-haiku-5-5", effort: "medium", ...(name === "wren" ? { search: "relay" } : {}) },
  );
  return { ...parsed, paths: base.paths, snapshot: "# --- test\n" };
}

describe("config", () => {
  test("webfetch: absent or false = off; empty = defaults; units in the names; bounds", () => {
    expect(config(undefined).webfetch).toBeUndefined();
    expect(config(false).webfetch).toBeUndefined();
    expect(config(null).webfetch).toEqual({ maxBytes: 20 * 1048576, timeoutMs: 30_000, maxRedirects: 5 });
    expect(config({ max_mb: 2.5, timeout_s: 10, max_redirects: 0 }).webfetch).toEqual({ maxBytes: Math.round(2.5 * 1048576), timeoutMs: 10_000, maxRedirects: 0 });
    expect(() => config({ max_mb: 0 })).toThrow("webfetch.max_mb");
    expect(() => config({ max_mb: 500 })).toThrow("webfetch.max_mb: expected a number 0.001–100");
    expect(() => config({ timeout_s: 0 })).toThrow("webfetch.timeout_s");
    expect(() => config({ max_redirects: 1.5 })).toThrow("webfetch.max_redirects: expected an integer 0–10");
    expect(() => config("yes")).toThrow("webfetch: expected a mapping");
    // The shipped configs have it on.
    expect(base.webfetch).toEqual({ maxBytes: 20 * 1048576, timeoutMs: 30_000, maxRedirects: 5 });
    expect(loadSwarm("config/swarm.yaml").webfetch).toBeDefined();
  });

  test("the relay runs when an agent searches through it or the world has webfetch", () => {
    const noSearch = (c: SwarmConfig) => ({ ...c, agents: c.agents.filter((a) => a.search !== "relay") });
    expect(relayNeeded(noSearch(config(undefined)))).toBe(false);
    expect(relayNeeded(noSearch(config({})))).toBe(true);
    expect(relayNeeded(config(undefined))).toBe(true);
  });

  test("prompt block: short, from the limits", () => {
    const block = webfetchPromptBlock({ maxBytes: 20 * 1048576, timeoutMs: 30_000, maxRedirects: 5 });
    expect(block).toBe(
      "Web fetch: `webfetch URL` prints a page as text (HTML converted, cut at 40K characters); `webfetch URL -o FILE` saves the raw bytes (any file type).\n" +
        "GET only, public http(s) on ports 80/443; no logins, cookies, forms or JavaScript; max 20 MB, 30 s, 5 redirects. Every fetch is logged.\n",
    );
  });
});

const FIXTURES: Record<string, string> = {
  claude: readFileSync("test/fixtures/claude-tools.synthetic.jsonl", "utf8"),
  codex: "",
  pi: readFileSync("test/fixtures/pi-hi.jsonl", "utf8"),
};
const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);

async function runWakes(cfg: SwarmConfig, during?: (agent: string, runId: string) => Promise<void>) {
  const db = openDb(":memory:");
  const pricingYaml = readFileSync(base.paths.pricing, "utf8").replace(
    /^models:\n/m,
    `models:\n  "z-ai/glm-5.3-flash":\n    provider: openrouter\n    per_mtok: { input: 0.15, output: 0.5, cache_read: 0.03 }\n`,
  );
  const runId = createRun(db, cfg, { pricingYaml }, T0);
  mkdirSync(runSearchDirs(runId).log, { recursive: true });
  // Codex copies its auth on first wake; give it one so the wake starts.
  writeFileSync(join(agentDirs(runId, "sorrel").runtime, "auth.json"), "{}");
  process.env.TEST_WF_KEY = "sk-test-not-real";
  const argvs = new Map<string, string[]>();
  const tokens = new Map<string, boolean>();
  const startProcess = (argv: string[]): ProcessHandle => {
    const agent = argv.find((a) => a.startsWith("slopswarm.agent="))!.split("=")[1]!;
    argvs.set(agent, argv);
    tokens.set(agent, existsSync(tokenPath(agentDirs(runId, agent).runtime)));
    const done = (async () => during?.(agent, runId))();
    const harness = cfg.agents.find((a) => a.name === agent)!.harness;
    const stdout = new ReadableStream<Uint8Array>({
      async start(c) {
        await done;
        c.enqueue(new TextEncoder().encode(FIXTURES[harness]));
        c.close();
      },
    });
    return { stdout, exited: done.then(() => 0) };
  };
  const ctl = new Controller(db, runId, cfg, {
    forge: { unread: async () => 0 },
    log: () => {},
    now: () => T0,
    wakeDeps: { startProcess, killContainer: async () => {}, vendorCosts: async () => new Map() },
  });
  ctl.tick();
  await ctl.whenIdle();
  delete process.env.TEST_WF_KEY;
  const prompt = (agent: string) => readFileSync(join(agentDirs(runId, agent).runtime, "system-prompt.md"), "utf8");
  return { db, runId, argvs, tokens, prompt };
}

describe("wakes", () => {
  const env = (argv: string[], k: string) => argv.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);
  const arg = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1]!;

  test("webfetch on: every harness gets the block in its system prompt, a token, the relay's address; searching stays per agent", async () => {
    const cfg = config({});
    const block = webfetchPromptBlock(cfg.webfetch!);
    const mapDuring: Record<string, { agent: string; search: boolean }> = {};
    const r = await runWakes(cfg, async (agent, runId) => {
      const map = JSON.parse(readFileSync(runSearchDirs(runId).tokensFile, "utf8")) as Record<string, { agent: string; search: boolean }>;
      for (const v of Object.values(map)) mapDuring[v.agent] = v;
      // One agent fetches mid-wake: the relay logs it under the agent's wake.
      if (agent === "bramble") {
        const d = runSearchDirs(runId);
        const res = await relay(d).handler(post("/fetch", tokenOf(agentDirs(runId, agent).runtime), { url: "http://site.example.com/plain" }));
        expect(res.status).toBe(200);
      }
    });
    for (const agent of ["bramble", "sorrel", "fern", "wren"]) {
      expect([agent, r.prompt(agent).endsWith(block)]).toEqual([agent, true]);
      expect([agent, r.tokens.get(agent)]).toEqual([agent, true]);
      const argv = r.argvs.get(agent)!;
      expect(env(argv, "SLOPSWARM_SEARCH_URL")).toBe(`http://${searchHost(r.runId)}:8080`);
      expect(env(argv, "NO_PROXY")!.split(",")).toContain(searchHost(r.runId));
    }
    // How the prompt reaches each harness: claude and pi by flag, codex by its instructions file.
    expect(arg(r.argvs.get("bramble")!, "--system-prompt")).toEndWith(block);
    expect(arg(r.argvs.get("fern")!, "--system-prompt")).toBe("/runtime/system-prompt.md");
    expect(r.argvs.get("sorrel")!.join(" ")).toContain('model_instructions_file="/runtime/system-prompt.md"');
    // Only the relay-search agent may search and gets the search line; the others keep their native search.
    expect(Object.fromEntries(Object.entries(mapDuring).map(([k, v]) => [k, v.search]))).toEqual({ bramble: false, sorrel: false, fern: true, wren: true });
    expect(r.prompt("wren")).toContain('Web search: `websearch "query"`');
    expect(r.prompt("fern")).toContain("websearch");
    expect(r.prompt("bramble")).not.toContain("websearch");
    expect(arg(r.argvs.get("bramble")!, "--tools")).toBe("Bash,Read,Write,Edit,WebSearch");
    expect(arg(r.argvs.get("wren")!, "--tools")).toBe("Bash,Read,Write,Edit");
    expect(readFileSync(join(agentDirs(r.runId, "bramble").self, "pricing.yaml"), "utf8")).not.toContain("exa-search");
    // Tokens are revoked after the wakes; the fetch is in the log and the report, not billed.
    expect(JSON.parse(readFileSync(runSearchDirs(r.runId).tokensFile, "utf8"))).toEqual({});
    const log = readFetchLog(runSearchDirs(r.runId).fetchLogFile);
    expect(log).toHaveLength(1);
    expect(log[0]!.agent).toBe("bramble");
    const report = renderReport(r.db, r.runId, T0 + 60_000);
    expect(report).toContain("## Web fetch (relay)");
    expect(report).toContain("1 fetch(es): 1 answered (10 bytes, 0 saved raw), 0 blocked, 0 failed. By agent: bramble 1.");
    expect(report).toContain("Top hosts: site.example.com 1.");
  });

  test("webfetch off: no block, and only relay-search agents get a token", async () => {
    const r = await runWakes(config(undefined));
    for (const agent of ["bramble", "sorrel", "fern", "wren"]) expect([agent, r.prompt(agent).includes("webfetch")]).toEqual([agent, false]);
    expect(Object.fromEntries(r.tokens)).toEqual({ bramble: false, sorrel: false, fern: true, wren: true });
    expect(env(r.argvs.get("bramble")!, "SLOPSWARM_SEARCH_URL")).toBeUndefined();
    expect(renderReport(r.db, r.runId, T0 + 60_000)).not.toContain("Web fetch");
  });
});
