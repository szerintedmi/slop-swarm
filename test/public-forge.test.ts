// The public read-only forge (docs/plans/2026-10-12-hosted-control-plane.md §7): host → world routing, the read-only
// rules, stripped credentials, rate limits, Caddy's on-demand TLS check, the index; and the forge side (public
// ROOT_URL, anonymous viewing, registration off) plus agents' git mapping the public URL back.
import { describe, expect, test } from "bun:test";
import { agentLoginFiles, forgeRunArgs, publicForgeLabel, publicForgeUrl } from "../src/forge.ts";
import { openDb } from "../src/db/index.ts";
import { createPublicForge, publicRule } from "../src/public-forge.ts";

const DOMAIN = "forge.example.com";

function setup(limits = { perMinute: 3, clonesPerMinute: 1 }) {
  const db = openDb(":memory:");
  for (const [id, status] of [["20261013-0000-Smoke_A-ab12", "idle"], ["w-active", "active"], ["w-archived", "archived"], ["w-down", "idle"]] as const)
    db.query("INSERT INTO worlds (id, name, created_at, forge_image, status) VALUES (?, 'smoke', 0, 'f', ?)").run(id, status);
  const seen: Request[] = [];
  let t = 0;
  const handle = createPublicForge({
    db,
    domain: DOMAIN,
    forgePort: (w) => (w === "w-down" ? null : w === "w-active" ? 3302 : 3301),
    now: () => t,
    limits,
    fetch: async (r) => (seen.push(r), new Response("forge page", { headers: { "set-cookie": "i_like_gitea=1", "content-type": "text/html", "content-encoding": "zstd" } })),
  });
  const get = (host: string, path = "/", init: RequestInit = {}, peer = "127.0.0.1") => handle(new Request(`http://${host}${path}`, { ...init, headers: { host, ...(init.headers as Record<string, string>) } }), peer);
  return { handle, get, seen, tick: (ms: number) => (t += ms) };
}

describe("public forge", () => {
  test("names: one subdomain per world, a DNS label; no domain, no public URL", () => {
    expect(publicForgeLabel("20261013-0000-Smoke_A-ab12")).toBe("20261013-0000-smoke-a-ab12");
    expect(publicForgeUrl("w1", DOMAIN)).toBe(`https://w1.${DOMAIN}/`);
    expect(publicForgeUrl("w1", "")).toBeUndefined();
  });

  test("the read-only rules", () => {
    expect(publicRule("GET", "/bramble/pubrepo")).toBeNull();
    expect(publicRule("HEAD", "/")).toBeNull();
    expect(publicRule("POST", "/bramble/pubrepo.git/git-upload-pack")).toBeNull();
    expect(publicRule("GET", "/bramble/pubrepo.git/info/refs")).toBeNull();
    expect(publicRule("POST", "/bramble/pubrepo.git/git-receive-pack")!.status).toBe(405);
    expect(publicRule("POST", "/user/login")!.status).toBe(405);
    expect(publicRule("PUT", "/api/v1/repos/x")!.status).toBe(405);
    expect(publicRule("GET", "/user/login")!.status).toBe(404);
    expect(publicRule("GET", "/user/sign_up")!.status).toBe(404);
    expect(publicRule("GET", "/%75ser/login")!.status).toBe(404);
    expect(publicRule("GET", "/user/avatar/bramble/-1")).toBeNull();
    expect(publicRule("GET", "/admin")!.status).toBe(404);
    expect(publicRule("GET", "//api/v1/admin/users")!.status).toBe(404);
    expect(publicRule("GET", "/bramble/pubrepo/archive/main.zip")!.status).toBe(404);
    expect(publicRule("GET", "/%zz")!.status).toBe(400);
  });

  test("routing: a world's subdomain reaches its forge only, credentials stripped both ways", async () => {
    const { get, seen } = setup({ perMinute: 100, clonesPerMinute: 10 });
    const res = await get(`20261013-0000-smoke-a-ab12.${DOMAIN}`, "/explore/repos?q=x", { headers: { authorization: "token abc", cookie: "a=b", "x-real-ip": "203.0.113.9", sudo: "operator", "accept-encoding": "gzip, br, zstd" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const r = seen[0]!;
    expect(r.url).toBe("http://127.0.0.1:3301/explore/repos?q=x");
    for (const h of ["authorization", "cookie", "sudo", "x-real-ip", "accept-encoding"]) expect(r.headers.get(h)).toBeNull();
    expect((await get(`w-active.${DOMAIN}`, "/")).status).toBe(200);
    expect(seen[1]!.url).toBe("http://127.0.0.1:3302/");
    for (const host of [`w-archived.${DOMAIN}`, `w-down.${DOMAIN}`, `nope.${DOMAIN}`, `a.b.${DOMAIN}`, "evil.example.org"]) expect((await get(host)).status).toBe(404);
    expect(seen).toHaveLength(2);
  });

  test("the apex lists the public worlds; Caddy's ask only approves real names", async () => {
    const { get } = setup({ perMinute: 100, clonesPerMinute: 10 });
    const page = await (await get(DOMAIN)).text();
    expect(page).toContain(`https://20261013-0000-smoke-a-ab12.${DOMAIN}/explore/repos`);
    expect(page).not.toContain("w-archived");
    expect(page).not.toContain("w-down");
    const ask = async (d: string) => (await get("127.0.0.1:7780", `/ask?domain=${d}`)).status;
    expect(await ask(DOMAIN)).toBe(200);
    expect(await ask(`w-active.${DOMAIN}`)).toBe(200);
    expect(await ask(`w-down.${DOMAIN}`)).toBe(404);
    expect(await ask(`nope.${DOMAIN}`)).toBe(404);
    expect(await ask("example.org")).toBe(404);
  });

  test("rate limits per client (Caddy's X-Real-IP), clones tighter", async () => {
    const { get, tick } = setup();
    const host = `w-active.${DOMAIN}`;
    const as = (ip: string) => ({ headers: { "x-real-ip": ip } });
    for (let i = 0; i < 3; i++) expect((await get(host, "/", as("198.51.100.1"))).status).toBe(200);
    expect((await get(host, "/", as("198.51.100.1"))).status).toBe(429);
    expect((await get(host, "/", as("198.51.100.2"))).status).toBe(200);
    // A client that isn't Caddy can't pick its address.
    expect((await get(host, "/", as("198.51.100.3"), "192.0.2.50")).status).toBe(200);
    const clone = { method: "POST", body: "0000", headers: { "x-real-ip": "198.51.100.4" } };
    expect((await get(host, "/r.git/git-upload-pack", clone)).status).toBe(200);
    expect((await get(host, "/r.git/git-upload-pack", { ...clone, body: "0000" })).status).toBe(429);
    tick(60_000);
    expect((await get(host, "/", as("198.51.100.1"))).status).toBe(200);
  });

  test("the forge serves its public URL; agents' git maps it back to the internal forge", () => {
    const args = forgeRunArgs({ world: "w1", image: "forgejo:x", network: "slopswarm-internal", publicUrl: `https://w1.${DOMAIN}` });
    const env = args.flatMap((a, i) => (args[i - 1] === "-e" ? [a] : []));
    expect(env).toContain(`FORGEJO__server__ROOT_URL=https://w1.${DOMAIN}/`);
    expect(env).toContain(`FORGEJO__server__DOMAIN=w1.${DOMAIN}`);
    expect(env).toContain("FORGEJO__service__DISABLE_REGISTRATION=true");
    expect(env).toContain("FORGEJO__service__REQUIRE_SIGNIN_VIEW=false");
    const gitconfig = agentLoginFiles("w1", "bramble", "tok", { publicUrl: `https://w1.${DOMAIN}/` }).find((f) => f.path === "forge/gitconfig")!.content;
    expect(gitconfig).toContain(`[url "http://slopswarm-forge-w1:3000/"]\n\tinsteadOf = https://w1.${DOMAIN}/`);
    // Without a public URL nothing changes for agents.
    expect(agentLoginFiles("w1", "bramble", "tok").find((f) => f.path === "forge/gitconfig")!.content).not.toContain("insteadOf");
  });
});
