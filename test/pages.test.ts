// Pages (src/pages.ts): host → world routing, files from the forge's media API with types by extension, directory
// index and redirects, the indexes, read-only, and the public route through the public forge proxy.
import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db/index.ts";
import { contentType, createPages, pagesOrigin } from "../src/pages.ts";
import { createPublicForge } from "../src/public-forge.ts";

const WORLD = "20261013-0000-Shock-ab12";
const LABEL = "20261013-0000-shock-ab12";
const FILES: Record<string, string> = {
  "bramble/demo/index.html": "<h1>hi</h1>",
  "bramble/demo/js/app.mjs": "export {}",
  "bramble/demo/levels/index.html": "<p>levels</p>",
};

function fakeForge() {
  const seen: string[] = [];
  const fetch = async (r: Request) => {
    const u = new URL(r.url);
    seen.push(`${r.method} ${u.pathname}${u.search}`);
    const media = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/media\/(.+)$/.exec(u.pathname);
    if (media) {
      const body = FILES[`${media[1]}/${media[2]}/${decodeURIComponent(media[3]!)}`];
      return body === undefined ? new Response("nope", { status: 404 }) : new Response(body, { headers: { "content-type": "text/plain", "set-cookie": "x=1" } });
    }
    if (u.pathname === "/api/v1/repos/search")
      return Response.json({ data: [
        { name: "demo", owner: { login: "bramble" }, description: "a demo", updated_at: "2026-10-13T10:00:00Z" },
        { name: "notes", owner: { login: "wren" }, updated_at: "2026-10-13T09:00:00Z" },
        { name: "secret", owner: { login: "wren" }, private: true, updated_at: "2026-10-13T09:00:00Z" },
      ] });
    if (u.pathname === "/api/v1/repos/bramble/demo/contents/index.html") return Response.json({});
    return new Response("nope", { status: 404 });
  };
  return { fetch, seen };
}

function setup() {
  const db = openDb(":memory:");
  db.query("INSERT INTO worlds (id, name, created_at, forge_image, status) VALUES (?, 'shock', 0, 'f', 'idle')").run(WORLD);
  db.query("INSERT INTO worlds (id, name, created_at, forge_image, status) VALUES ('w-down', 'x', 0, 'f', 'idle')").run();
  const forge = fakeForge();
  const handle = createPages({ db, suffix: "localhost", forgePort: (w) => (w === WORLD ? 3301 : null), origin: (w) => pagesOrigin(w, { localPort: 7778 })!, fetch: forge.fetch, perMinute: 5 });
  const get = (path: string, host = `${LABEL}.localhost:7778`, method = "GET") => handle(new Request(`http://${host}${path}`, { method, headers: { host } }), "10.0.0.1");
  return { db, get, forge };
}

describe("pages", () => {
  test("origins: one per world, public with a domain", () => {
    expect(pagesOrigin(WORLD, { localPort: 7778 })).toBe(`http://${LABEL}.localhost:7778/`);
    expect(pagesOrigin(WORLD, { publicDomain: "forge.example.com", localPort: 7778 })).toBe(`https://${LABEL}.pages.forge.example.com/`);
    expect(pagesOrigin(WORLD, {})).toBeUndefined();
    expect(contentType("a/b.mjs")).toStartWith("text/javascript");
    expect(contentType("x.wasm")).toBe("application/wasm");
    expect(contentType("noext")).toBe("application/octet-stream");
  });

  test("files from the default branch, typed by extension, no forge headers", async () => {
    const { get, forge } = setup();
    const r = await get("/bramble/demo/js/app.mjs");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toStartWith("text/javascript");
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await r.text()).toBe("export {}");
    expect(forge.seen).toContain("GET /api/v1/repos/bramble/demo/media/js/app.mjs");
  });

  test("dir/ is its index.html; dir and repo without a slash redirect", async () => {
    const { get } = setup();
    const root = await get("/bramble/demo/");
    expect(root.headers.get("content-type")).toStartWith("text/html");
    expect(await root.text()).toBe("<h1>hi</h1>");
    expect(await (await get("/bramble/demo/levels/")).text()).toBe("<p>levels</p>");
    const dir = await get("/bramble/demo/levels");
    expect(dir.status).toBe(301);
    expect(dir.headers.get("location")).toBe(`http://${LABEL}.localhost:7778/bramble/demo/levels/`);
    expect((await get("/bramble/demo")).headers.get("location")).toBe(`http://${LABEL}.localhost:7778/bramble/demo/`);
    expect((await get("/bramble/demo/missing.js")).status).toBe(404);
  });

  test("indexes: the world's and one agent's published repos, never private ones", async () => {
    const { get } = setup();
    const all = await (await get("/")).text();
    expect(all).toContain(`href="http://${LABEL}.localhost:7778/bramble/demo/"`);
    expect(all).toContain("wren/notes</a> <small>(no index.html)</small>");
    expect(all).not.toContain("secret");
    const mine = await (await get("/bramble/")).text();
    expect(mine).toContain("bramble&#39;s pages");
    expect(mine).not.toContain("notes");
  });

  test("read-only, unknown or stopped worlds, bad paths, rate limit", async () => {
    const { get } = setup();
    expect((await get("/bramble/demo/", undefined, "POST")).status).toBe(405);
    expect((await get("/", "nope.localhost:7778")).status).toBe(404);
    expect((await get("/", "w-down.localhost:7778")).status).toBe(503);
    expect((await get("/bramble/demo/a%2F..%2Fx")).status).toBe(400);
    for (let i = 0; i < 4; i++) await get("/bramble/demo/"); // the bad path counted too
    expect((await get("/bramble/demo/")).status).toBe(429);
  });

  test("public: <world>.pages.<domain> through the public forge proxy, and certificates for it", async () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO worlds (id, name, created_at, forge_image, status) VALUES (?, 'shock', 0, 'f', 'idle')").run(WORLD);
    const forge = fakeForge();
    const handle = createPublicForge({ db, domain: "forge.example.com", forgePort: () => 3301, fetch: forge.fetch });
    const host = `${LABEL}.pages.forge.example.com`;
    const r = await handle(new Request(`http://${host}/bramble/demo/`, { headers: { host } }), "127.0.0.1");
    expect(await r.text()).toBe("<h1>hi</h1>");
    expect((await handle(new Request(`http://${host}/`, { headers: { host } }))).status).toBe(200);
    const ask = (d: string) => handle(new Request(`http://127.0.0.1/ask?domain=${d}`)).then((x) => x.status);
    expect(await ask(host)).toBe(200);
    expect(await ask(`nope.pages.forge.example.com`)).toBe(404);
    expect(await ask(`${LABEL}.forge.example.com`)).toBe(200);
  });
});
