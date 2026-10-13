// A world's Forgejo (plan §4.5; docs/plans/2026-10-12-hosted-control-plane.md §3): the agents' shared space. One
// forge per world (never one shared instance), on the internal network only, plus a forwarder that publishes it on
// 127.0.0.1 for the owner (and the controller's API calls). The hostname comes from the world id, so saved git
// remotes in homes stay valid across runs.
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { worldAgentDirs, worldDirs } from "./db/index.ts";
import { MOUNTS } from "./docker.ts";
import { GITHUB_GITCONFIG_IN } from "./github.ts";

export const FORWARDER_IMAGE = "alpine/socat:1.8.0.3";
/** The compose network with a route out (docker/compose.yaml); only the forwarder joins it, to publish its port. */
export const EGRESS_NETWORK = "slopswarm-egress";
const FORGE_PORT_IN = 3000;
const TOKEN_NAME = "slopswarm";
const EMAIL_DOMAIN = "slopswarm.local";

/** Container name = the hostname agents use. Kept within a DNS label (63 chars). */
export function forgeHost(world: string): string {
  const name = `slopswarm-forge-${world}`.replace(/[^a-zA-Z0-9-]/g, "-");
  if (name.length <= 63) return name;
  const h = new Bun.CryptoHasher("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, 54)}-${h}`;
}
export const forgeUrl = (world: string) => `http://${forgeHost(world)}:${FORGE_PORT_IN}`;
export const forgeDataDir = (world: string) => worldDirs(world).forge;

/**
 * The world's public read-only forge URL (§7): `https://<world>.<PUBLIC_FORGE_DOMAIN>/`, or undefined without a domain.
 * The domain lives in the VPS env file only (unlisted, never committed).
 */
export function publicForgeUrl(world: string, domain = process.env.PUBLIC_FORGE_DOMAIN?.trim()): string | undefined {
  if (!domain) return undefined;
  return `https://${publicForgeLabel(world)}.${domain.replace(/^\.+|\/+$/g, "")}/`;
}

/** The world's subdomain label: lowercase letters, digits and hyphens, at most 63. */
export function publicForgeLabel(world: string): string {
  return world.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}

/** Login files in an agent's runtime dir, relative to it (mounted at /runtime). */
export const LOGIN_FILES = {
  token: "forge/token",
  gitconfig: "forge/gitconfig",
  credentials: "forge/git-credentials",
  tea: "xdg/tea/config.yml",
} as const;

/** Files in an agent's runtime dir that log git and tea in as the agent (mounted at /runtime). */
export function loginPaths(runtimeDir: string) {
  return {
    token: join(runtimeDir, LOGIN_FILES.token),
    gitconfig: join(runtimeDir, LOGIN_FILES.gitconfig),
    credentials: join(runtimeDir, LOGIN_FILES.credentials),
    tea: join(runtimeDir, LOGIN_FILES.tea),
  };
}

/** Container env for an agent's wake: where the forge is and where its logins live. */
export function forgeEnv(world: string): Record<string, string> {
  return {
    FORGE_URL: forgeUrl(world),
    GIT_CONFIG_GLOBAL: `${MOUNTS.runtime}/forge/gitconfig`,
    XDG_CONFIG_HOME: `${MOUNTS.runtime}/xdg`,
  };
}

export interface RuntimeFile {
  /** Relative to the runtime dir. */
  path: string;
  content: string;
  mode: number;
}

/**
 * The agent's git + tea login files (paths inside them are container paths), rewritten into its runtime dir by
 * every prepare. `publicUrl`: the forge's public ROOT_URL (§7), mapped back to the internal forge for git.
 */
export function agentLoginFiles(world: string, user: string, token: string, o: { publicUrl?: string } = {}): RuntimeFile[] {
  const url = forgeUrl(world);
  return [
    { path: LOGIN_FILES.token, content: token + "\n", mode: 0o600 },
    { path: LOGIN_FILES.credentials, content: `http://${user}:${token}@${forgeHost(world)}:${FORGE_PORT_IN}\n`, mode: 0o600 },
    {
      path: LOGIN_FILES.gitconfig,
      mode: 0o644,
      content: [
      "[user]",
      `\tname = ${user}`,
      `\temail = ${user}@${EMAIL_DOMAIN}`,
      "[credential]",
      `\thelper = store --file=${MOUNTS.runtime}/forge/git-credentials`,
      "[init]",
      "\tdefaultBranch = main",
      // Clone links on the public forge pages use its public URL; git stays on the internal forge.
      ...(o.publicUrl ? [`[url "${url}/"]`, `\tinsteadOf = ${o.publicUrl.replace(/\/*$/, "/")}`] : []),
      // The GitHub login (github.ts), when the run has one. Last, so its github.com helper reset wins.
      "[include]",
      `\tpath = ${GITHUB_GITCONFIG_IN}`,
      "",
    ].join("\n"),
    },
    {
      path: LOGIN_FILES.tea,
      mode: 0o600,
      content: [
      "logins:",
      "  - name: forge",
      `    url: ${url}`,
      `    token: ${token}`,
      "    default: true",
      `    user: ${user}`,
      "preferences:",
      "  editor: false",
      "",
    ].join("\n"),
    },
  ];
}

/** Write the agent's login files into a local runtime dir (preflight). */
export function writeAgentLogin(runtimeDir: string, world: string, user: string, token: string): void {
  for (const f of agentLoginFiles(world, user, token)) {
    const p = join(runtimeDir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
    chmodSync(p, f.mode);
  }
}

export interface ForgeAdmin {
  user: string;
  password: string;
}

/** The owner's admin login, from .env. */
export function forgeAdminFromEnv(env = process.env): ForgeAdmin | null {
  const password = env.FORGE_ADMIN_PASSWORD?.trim();
  if (!password) return null;
  return { user: env.FORGE_ADMIN_USER?.trim() || "operator", password };
}

/** Host port of the owner's view: FORGE_PORT overrides the config. */
export function forgePort(configured: number, env = process.env): number {
  const p = Number(env.FORGE_PORT ?? configured);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`invalid FORGE_PORT ${env.FORGE_PORT}`);
  return p;
}

/** What the controller needs from the forge; faked in tests. */
export interface ForgeApi {
  /** Unread notifications of `user`; with `since` (unix ms), only those updated after it. */
  unread(user: string, since?: number): Promise<number>;
}

type Auth = { basic: [string, string] } | { token: string };

export class ForgeClient implements ForgeApi {
  constructor(
    readonly baseUrl: string,
    private readonly admin: ForgeAdmin,
  ) {}

  private async call(method: string, path: string, o: { auth?: Auth; body?: unknown; sudo?: string } = {}): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { accept: "application/json" };
    const auth = o.auth ?? { basic: [this.admin.user, this.admin.password] };
    headers.authorization = "token" in auth ? `token ${auth.token}` : `Basic ${btoa(`${auth.basic[0]}:${auth.basic[1]}`)}`;
    if (o.sudo) headers.sudo = o.sudo;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(`${this.baseUrl}/api/v1${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await r.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: r.status, json };
  }

  private async must(method: string, path: string, o: Parameters<ForgeClient["call"]>[2] = {}): Promise<any> {
    const r = await this.call(method, path, o);
    if (r.status >= 300) throw new Error(`forge ${method} ${path}: ${r.status} ${typeof r.json === "string" ? r.json : JSON.stringify(r.json)}`.slice(0, 300));
    return r.json;
  }

  async waitReady(timeoutMs = 60_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      try {
        const r = await fetch(`${this.baseUrl}/api/v1/version`);
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      if (Date.now() > until) throw new Error(`forge did not come up at ${this.baseUrl} within ${timeoutMs / 1000}s`);
      await Bun.sleep(500);
    }
  }

  async adminWorks(): Promise<boolean> {
    return (await this.call("GET", "/user")).status === 200;
  }

  /** Hide the owner's account from agents' user lists. */
  async hideAdmin(): Promise<void> {
    await this.must("PATCH", `/admin/users/${encodeURIComponent(this.admin.user)}`, {
      body: { login_name: this.admin.user, source_id: 0, visibility: "private" },
    });
  }

  /** Make sure `name` exists and has a working token; returns the token. Reuses `existingToken` if it still works. */
  async ensureAgent(name: string, existingToken?: string): Promise<string> {
    if (existingToken) {
      const me = await this.call("GET", "/user", { auth: { token: existingToken } });
      if (me.status === 200 && me.json?.login === name) return existingToken;
    }
    const password = `${crypto.randomUUID()}-Aa1`;
    const exists = (await this.call("GET", `/users/${encodeURIComponent(name)}`)).status === 200;
    if (exists) await this.must("PATCH", `/admin/users/${encodeURIComponent(name)}`, { body: { login_name: name, source_id: 0, password, must_change_password: false } });
    else
      await this.must("POST", "/admin/users", {
        body: { username: name, email: `${name}@${EMAIL_DOMAIN}`, password, must_change_password: false, visibility: "public" },
      });
    const asUser: Auth = { basic: [name, password] };
    await this.call("DELETE", `/users/${encodeURIComponent(name)}/tokens/${TOKEN_NAME}`, { auth: asUser });
    const t = await this.must("POST", `/users/${encodeURIComponent(name)}/tokens`, { auth: asUser, body: { name: TOKEN_NAME, scopes: ["all"] } });
    if (typeof t?.sha1 !== "string") throw new Error(`forge: no token returned for ${name}`);
    return t.sha1;
  }

  async unread(user: string, since?: number): Promise<number> {
    const q = new URLSearchParams({ "status-types": "unread", limit: "50" });
    if (since !== undefined) q.set("since", new Date(since).toISOString().replace(/\.\d+Z$/, "Z"));
    const list = await this.must("GET", `/notifications?${q}`, { sudo: user });
    return Array.isArray(list) ? list.length : 0;
  }
}

/** An agent's stored forge token in its world (controller side, 0600), if any. */
export function forgeToken(world: string, agent: string): string | undefined {
  const p = worldAgentDirs(world, agent).forgeToken;
  return existsSync(p) ? readFileSync(p, "utf8").trim() || undefined : undefined;
}

/**
 * Create (or re-key) every agent's account in the world's forge and store its token on the controller's side; the
 * login files are written into the agent's runtime dir by each wake's prepare.
 */
export async function provisionAgents(client: ForgeClient, world: string, agents: string[]): Promise<void> {
  for (const name of agents) {
    const token = await client.ensureAgent(name, forgeToken(world, name));
    const p = worldAgentDirs(world, name).forgeToken;
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, token + "\n", { mode: 0o600 });
    chmodSync(p, 0o600);
  }
}

/** `docker run` argv for the forge itself. No published port and no route out (plan §4.5). */
export function forgeRunArgs(o: { world: string; image: string; network: string; publicUrl?: string }): string[] {
  const host = forgeHost(o.world);
  // With a public URL (§7) it is ROOT_URL, so pages and clone links are right; agents' git maps it back (agentLoginFiles).
  const rootUrl = o.publicUrl ? o.publicUrl.replace(/\/*$/, "/") : `${forgeUrl(o.world)}/`;
  const ini: Record<string, string> = {
    security__INSTALL_LOCK: "true",
    database__DB_TYPE: "sqlite3",
    server__ROOT_URL: rootUrl,
    server__DOMAIN: o.publicUrl ? new URL(rootUrl).hostname : host,
    server__HTTP_PORT: String(FORGE_PORT_IN),
    server__DISABLE_SSH: "true",
    server__START_SSH_SERVER: "false",
    server__OFFLINE_MODE: "true",
    service__DISABLE_REGISTRATION: "true",
    service__DEFAULT_KEEP_EMAIL_PRIVATE: "true",
    // Anonymous visitors may read public repos (the public forge, §7); private repos stay private.
    service__REQUIRE_SIGNIN_VIEW: "false",
    // Server-side fetches would bypass the egress proxy; the forge has no route out anyway.
    repository__DISABLE_MIGRATIONS: "true",
    mirror__ENABLED: "false",
    actions__ENABLED: "false",
    log__LEVEL: "Warn",
  };
  return [
    "docker", "run", "-d", "--rm",
    "--name", host,
    "--label", `slopswarm.forge=${o.world}`,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp:rw,size=256m",
    "--cpus", "1",
    "--memory", "1g",
    "--pids-limit", "512",
    "--network", o.network,
    "-v", `${forgeDataDir(o.world)}:/var/lib/gitea:rw`,
    ...Object.entries(ini).flatMap(([k, v]) => ["-e", `FORGEJO__${k}=${v}`]),
    o.image,
  ];
}

/**
 * `docker run` argv for the forwarder: 127.0.0.1:<port> -> forge:3000. `publish`: more host addresses on the same
 * port, e.g. the VPS's tailnet address, so a remote agent host's forwarder reaches this world's forge and no other
 * (one port per world: the forge router of docs/plans/2026-10-12-hosted-control-plane.md §2.5).
 */
export function forwarderRunArgs(o: { world: string; network: string; hostPort: number; publish?: string[] }): string[] {
  const host = forgeHost(o.world);
  return [
    "docker", "run", "-d", "--rm",
    "--name", `${host}-port`.slice(0, 63),
    "--label", `slopswarm.forge=${o.world}`,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--network", EGRESS_NETWORK,
    "--network", o.network,
    "-p", `127.0.0.1:${o.hostPort}:${FORGE_PORT_IN}`,
    ...(o.publish ?? []).flatMap((ip) => ["-p", `${ip}:${o.hostPort}:${FORGE_PORT_IN}`]),
    FORWARDER_IMAGE,
    `TCP-LISTEN:${FORGE_PORT_IN},fork,reuseaddr`,
    `TCP:${host}:${FORGE_PORT_IN}`,
  ];
}

/** The rootless Forgejo image's user. */
const FORGE_UID = 1000;

/**
 * Create the internal and egress networks if missing (the VPS, where no proxy compose runs; locally the proxy's
 * compose file owns them and this is not called). The internal one has no route out.
 */
export async function ensureNetworks(internal: string): Promise<void> {
  for (const [name, flags] of [[internal, ["--internal"]], [EGRESS_NETWORK, []]] as const) {
    if ((await docker(["docker", "network", "inspect", name])).code === 0) continue;
    const r = await docker(["docker", "network", "create", ...flags, name]);
    if (r.code !== 0 && !/already exists/.test(r.err)) throw new Error(`docker network create ${name}: ${r.err.trim()}`);
  }
}

async function docker(argv: string[], env?: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: env ? { ...process.env, ...env } : process.env });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

/** Remove this run's forge containers (the data stays on disk). */
export async function stopForge(world: string): Promise<void> {
  const ps = await docker(["docker", "ps", "-aq", "--filter", `label=slopswarm.forge=${world}`]);
  const ids = ps.out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (ids.length) await docker(["docker", "rm", "-f", ...ids]);
}

/**
 * Start the run's forge and forwarder (replacing leftovers from a crashed controller), create the
 * owner's admin account on first start, and return a client. Throws with a hint if the port is taken.
 */
export async function startForge(o: { world: string; image: string; network: string; hostPort: number; admin: ForgeAdmin; publish?: string[]; publicUrl?: string }): Promise<ForgeClient> {
  await stopForge(o.world);
  mkdirSync(forgeDataDir(o.world), { recursive: true });
  // The rootless forge runs as uid 1000: a controller running as root (the VPS) hands it its data dir.
  if (process.getuid?.() === 0) chownSync(forgeDataDir(o.world), FORGE_UID, FORGE_UID);
  const f = await docker(forgeRunArgs(o));
  if (f.code !== 0) throw new Error(`forge did not start: ${f.err.trim()}`);
  const w = await docker(forwarderRunArgs(o));
  if (w.code !== 0) {
    await stopForge(o.world);
    const taken = /already allocated|address already in use/i.test(w.err);
    throw new Error(
      taken
        ? `port ${o.hostPort} is in use (another run's forge?); pick another: FORGE_PORT=${o.hostPort + 1} just …`
        : `forge forwarder did not start: ${w.err.trim()}`,
    );
  }
  const client = new ForgeClient(`http://127.0.0.1:${o.hostPort}`, o.admin);
  await client.waitReady();
  if (!(await client.adminWorks())) {
    // The password goes in by env, never argv (plan §7.3).
    const r = await docker(
      [
        "docker", "exec", "-e", "FORGE_ADMIN_PASSWORD", forgeHost(o.world), "sh", "-c",
        'forgejo admin user create --admin --username "$0" --email "$0@' + EMAIL_DOMAIN + '" --password "$FORGE_ADMIN_PASSWORD" --must-change-password=false',
        o.admin.user,
      ],
      { FORGE_ADMIN_PASSWORD: o.admin.password },
    );
    const hint = "FORGE_ADMIN_PASSWORD changed since this run's forge was created?";
    if (r.code !== 0) throw new Error(`forge admin create failed (${hint}): ${(r.err || r.out).trim()}`);
    if (!(await client.adminWorks())) throw new Error(`forge admin login does not work (${hint})`);
    await client.hideAdmin();
  }
  return client;
}
