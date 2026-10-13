// The run's forge (plan §4.5): container args, agent login files, and the API client against a fake Forgejo.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forgeAdminFromEnv,
  forgeEnv,
  ForgeClient,
  forgeHost,
  forgePort,
  forgeRunArgs,
  forgeToken,
  forgeUrl,
  forwarderRunArgs,
  loginPaths,
  provisionAgents,
  writeAgentLogin,
} from "../src/forge.ts";
import { githubEnv, githubLoginPaths, writeGithubLogin } from "../src/github.ts";
import { worldAgentDirs } from "../src/db/index.ts";

const dataDir = mkdtempSync(join(tmpdir(), "slopswarm-forge-"));
process.env.SLOPSWARM_DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const RUN = "20261010-1200-smoke-ab12";
const all = (args: string[], f: string) => args.flatMap((a, i) => (a === f ? [args[i + 1]!] : []));

describe("names and env", () => {
  test("hostname is the container name and fits a DNS label", () => {
    expect(forgeHost(RUN)).toBe(`slopswarm-forge-${RUN}`);
    expect(forgeUrl(RUN)).toBe(`http://slopswarm-forge-${RUN}:3000`);
    const long = forgeHost(`20261010-1200-${"x".repeat(80)}-ab12`);
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^slopswarm-forge-.*-[0-9a-f]{8}$/);
  });

  test("agent env points git and tea at the runtime mount", () => {
    expect(forgeEnv(RUN)).toEqual({
      FORGE_URL: forgeUrl(RUN),
      GIT_CONFIG_GLOBAL: "/runtime/forge/gitconfig",
      XDG_CONFIG_HOME: "/runtime/xdg",
    });
  });

  test("admin and port from env", () => {
    expect(forgeAdminFromEnv({})).toBeNull();
    expect(forgeAdminFromEnv({ FORGE_ADMIN_PASSWORD: "pw" })).toEqual({ user: "operator", password: "pw" });
    expect(forgeAdminFromEnv({ FORGE_ADMIN_PASSWORD: "pw", FORGE_ADMIN_USER: "petro" })).toEqual({ user: "petro", password: "pw" });
    expect(forgePort(3300, {})).toBe(3300);
    expect(forgePort(3300, { FORGE_PORT: "3310" })).toBe(3310);
    expect(() => forgePort(3300, { FORGE_PORT: "nope" })).toThrow(/FORGE_PORT/);
  });
});

describe("containers", () => {
  test("the forge has no published port and only the internal network", () => {
    const args = forgeRunArgs({ world: RUN, image: "forgejo:x", network: "slopswarm-internal" });
    expect(args.slice(0, 2)).toEqual(["docker", "run"]);
    expect(args).not.toContain("-p");
    expect(all(args, "--network")).toEqual(["slopswarm-internal"]);
    // Not labelled slopswarm=1 / slopswarm.run: `just kill` must not take the forge down.
    expect(all(args, "--label")).toEqual([`slopswarm.forge=${RUN}`]);
    expect(args).toContain("--read-only");
    expect(all(args, "--cap-drop")).toEqual(["ALL"]);
    const env = all(args, "-e");
    for (const e of ["FORGEJO__repository__DISABLE_MIGRATIONS=true", "FORGEJO__mirror__ENABLED=false", "FORGEJO__service__DISABLE_REGISTRATION=true"])
      expect(env).toContain(e);
    expect(env).toContain(`FORGEJO__server__ROOT_URL=${forgeUrl(RUN)}/`);
    expect(all(args, "-v")).toEqual([`${join(dataDir, "worlds", RUN, "forge")}:/var/lib/gitea:rw`]);
    expect(args.at(-1)).toBe("forgejo:x");
  });

  test("the forwarder publishes on localhost only", () => {
    const args = forwarderRunArgs({ world: RUN, network: "slopswarm-internal", hostPort: 3300 });
    expect(all(args, "-p")).toEqual(["127.0.0.1:3300:3000"]);
    expect(all(args, "--network")).toEqual(["slopswarm-egress", "slopswarm-internal"]);
    expect(args.at(-1)).toBe(`TCP:${forgeHost(RUN)}:3000`);
  });
});

test("agent login files: git identity, credential store, tea login; secrets 0600", () => {
  const rt = mkdtempSync(join(dataDir, "rt-"));
  writeAgentLogin(rt, RUN, "wren", "tok123");
  const p = loginPaths(rt);
  expect(readFileSync(p.token, "utf8")).toBe("tok123\n");
  expect(readFileSync(p.credentials, "utf8")).toBe(`http://wren:tok123@${forgeHost(RUN)}:3000\n`);
  const git = readFileSync(p.gitconfig, "utf8");
  expect(git).toContain("name = wren");
  expect(git).toContain("helper = store --file=/runtime/forge/git-credentials");
  const tea = Bun.YAML.parse(readFileSync(p.tea, "utf8")) as { logins: { url: string; token: string; user: string; default: boolean }[] };
  expect(tea.logins).toEqual([expect.objectContaining({ url: forgeUrl(RUN), token: "tok123", user: "wren", default: true })]);
  for (const f of [p.token, p.credentials, p.tea]) expect(statSync(f).mode & 0o777).toBe(0o600);
});

test("github login: gh hosts file (0600) and a github.com-only git helper, included last by the forge gitconfig", () => {
  const rt = mkdtempSync(join(dataDir, "rt-"));
  writeAgentLogin(rt, RUN, "wren", "tok123");
  writeGithubLogin(rt, "slop-swarm-agents", "ghtok");
  const p = githubLoginPaths(rt);
  const hosts = Bun.YAML.parse(readFileSync(p.hosts, "utf8")) as Record<string, { user: string; oauth_token: string }>;
  expect(hosts["github.com"]).toMatchObject({ user: "slop-swarm-agents", oauth_token: "ghtok" });
  expect(statSync(p.hosts).mode & 0o777).toBe(0o600);
  expect(githubEnv()).toEqual({ GH_CONFIG_DIR: "/runtime/github/gh" });
  const gh = readFileSync(p.gitconfig, "utf8");
  // The empty helper drops the forge's store for github.com, so the token isn't copied into it.
  expect(gh).toMatch(/\[credential "https:\/\/github\.com"\]\n\thelper =\n\thelper = !gh auth git-credential/);
  const forge = readFileSync(loginPaths(rt).gitconfig, "utf8");
  expect(forge.trimEnd().endsWith("[include]\n\tpath = /runtime/github/gitconfig")).toBe(true);
});

/** Just enough of the Forgejo API for the client. */
function fakeForgejo() {
  const users = new Map<string, { password: string }>([["operator", { password: "adminpw" }]]);
  const tokens = new Map<string, string>(); // token -> user
  const seen: { method: string; path: string; sudo: string | null; since: string | null }[] = [];
  let n = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/api\/v1/, "");
      seen.push({ method: req.method, path, sudo: req.headers.get("sudo"), since: url.searchParams.get("since") });
      const auth = req.headers.get("authorization") ?? "";
      let who: string | null = null;
      if (auth.startsWith("token ")) who = tokens.get(auth.slice(6)) ?? null;
      else if (auth.startsWith("Basic ")) {
        const [u, pw] = atob(auth.slice(6)).split(":");
        if (users.get(u!)?.password === pw) who = u!;
      }
      const json = (v: unknown, status = 200) => Response.json(v, { status });
      if (path === "/version") return json({ version: "16.0.4" });
      if (!who) return json({ message: "unauthorized" }, 401);
      const body: any = req.method === "GET" || req.method === "DELETE" ? null : await req.json();
      if (path === "/user") return json({ login: who });
      let m: RegExpExecArray | null;
      if ((m = /^\/users\/([^/]+)$/.exec(path))) return users.has(m[1]!) ? json({ login: m[1] }) : json({}, 404);
      if (path === "/admin/users" && req.method === "POST") {
        if (users.has(body.username)) return json({}, 422);
        users.set(body.username, { password: body.password });
        return json({ login: body.username }, 201);
      }
      if ((m = /^\/admin\/users\/([^/]+)$/.exec(path)) && req.method === "PATCH") {
        if (body.password) users.set(m[1]!, { password: body.password });
        return json({ login: m[1] });
      }
      if ((m = /^\/users\/([^/]+)\/tokens(?:\/(.+))?$/.exec(path))) {
        if (who !== m[1]) return json({}, 403);
        if (req.method === "DELETE") return new Response(null, { status: 204 });
        const t = `tok-${m[1]}-${++n}`;
        tokens.set(t, m[1]!);
        return json({ name: body.name, sha1: t }, 201);
      }
      if (path === "/notifications") return json(req.headers.get("sudo") === "wren" ? [{ id: 1 }, { id: 2 }] : []);
      return json({}, 404);
    },
  });
  return { server, users, tokens, seen, url: `http://127.0.0.1:${server.port}` };
}

describe("ForgeClient", () => {
  test("creates agents once, reuses working tokens, re-keys lost ones", async () => {
    const f = fakeForgejo();
    try {
      const client = new ForgeClient(f.url, { user: "operator", password: "adminpw" });
      await client.waitReady(2000);
      expect(await client.adminWorks()).toBe(true);
      await provisionAgents(client, RUN, ["wren"]);
      const t1 = forgeToken(RUN, "wren")!;
      expect(f.tokens.get(t1)).toBe("wren");
      // The token is kept on the controller's side, owner-only.
      expect(statSync(worldAgentDirs(RUN, "wren").forgeToken).mode & 0o777).toBe(0o600);
      // Resume: the stored token still works, nothing is re-created.
      const before = f.seen.length;
      await provisionAgents(client, RUN, ["wren"]);
      expect(forgeToken(RUN, "wren")).toBe(t1);
      expect(f.seen.slice(before).map((s) => `${s.method} ${s.path}`)).toEqual(["GET /user"]);
      // A dead token: the existing user gets a new password and token.
      f.tokens.clear();
      await provisionAgents(client, RUN, ["wren"]);
      const t2 = forgeToken(RUN, "wren")!;
      expect(t2).not.toBe(t1);
      expect(f.tokens.get(t2)).toBe("wren");
      expect(f.seen.some((s) => s.method === "PATCH" && s.path === "/admin/users/wren")).toBe(true);
    } finally {
      f.server.stop(true);
    }
  });

  test("unread counts another user's notifications via Sudo, optionally since a time", async () => {
    const f = fakeForgejo();
    try {
      const client = new ForgeClient(f.url, { user: "operator", password: "adminpw" });
      expect(await client.unread("wren")).toBe(2);
      expect(await client.unread("sorrel", Date.UTC(2026, 9, 10, 12, 0, 0, 500))).toBe(0);
      const calls = f.seen.filter((s) => s.path === "/notifications");
      expect(calls.map((c) => [c.sudo, c.since])).toEqual([
        ["wren", null],
        ["sorrel", "2026-10-10T12:00:00Z"],
      ]);
    } finally {
      f.server.stop(true);
    }
  });

  test("a wrong admin password is reported, not retried", async () => {
    const f = fakeForgejo();
    try {
      const client = new ForgeClient(f.url, { user: "operator", password: "wrong" });
      expect(await client.adminWorks()).toBe(false);
      await expect(client.unread("wren")).rejects.toThrow(/401/);
    } finally {
      f.server.stop(true);
    }
  });
});
