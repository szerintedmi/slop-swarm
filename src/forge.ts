// The run's Forgejo (plan §4.5): the agents' shared world. One forge per run, on the internal network
// only, plus a forwarder that publishes it on 127.0.0.1 for the owner (and the controller's API calls).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "./db/index.ts";
import { MOUNTS } from "./docker.ts";
import { GITHUB_GITCONFIG_IN } from "./github.ts";

export const FORWARDER_IMAGE = "alpine/socat:1.8.0.3";
/** The compose network with a route out (docker/compose.yaml); only the forwarder joins it, to publish its port. */
export const EGRESS_NETWORK = "slopswarm-egress";
const FORGE_PORT_IN = 3000;
const TOKEN_NAME = "slopswarm";
const EMAIL_DOMAIN = "slopswarm.local";

/** Container name = the hostname agents use. Kept within a DNS label (63 chars). */
export function forgeHost(runId: string): string {
  const name = `slopswarm-forge-${runId}`.replace(/[^a-zA-Z0-9-]/g, "-");
  if (name.length <= 63) return name;
  const h = new Bun.CryptoHasher("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, 54)}-${h}`;
}
export const forgeUrl = (runId: string) => `http://${forgeHost(runId)}:${FORGE_PORT_IN}`;
export const forgeDataDir = (runId: string) => join(runDir(runId), "forge");

/** Files in an agent's runtime dir that log git and tea in as the agent (mounted at /runtime). */
export function loginPaths(runtimeDir: string) {
  return {
    token: join(runtimeDir, "forge", "token"),
    gitconfig: join(runtimeDir, "forge", "gitconfig"),
    credentials: join(runtimeDir, "forge", "git-credentials"),
    tea: join(runtimeDir, "xdg", "tea", "config.yml"),
  };
}

/** Container env for an agent's wake: where the forge is and where its logins live. */
export function forgeEnv(runId: string): Record<string, string> {
  return {
    FORGE_URL: forgeUrl(runId),
    GIT_CONFIG_GLOBAL: `${MOUNTS.runtime}/forge/gitconfig`,
    XDG_CONFIG_HOME: `${MOUNTS.runtime}/xdg`,
  };
}

/** Write the agent's git + tea login files. Paths inside them are container paths. */
export function writeAgentLogin(runtimeDir: string, runId: string, user: string, token: string): void {
  const p = loginPaths(runtimeDir);
  const url = forgeUrl(runId);
  mkdirSync(join(runtimeDir, "forge"), { recursive: true });
  mkdirSync(join(runtimeDir, "xdg", "tea"), { recursive: true });
  const secret = (path: string, text: string) => {
    writeFileSync(path, text);
    chmodSync(path, 0o600);
  };
  secret(p.token, token + "\n");
  secret(p.credentials, `http://${user}:${token}@${forgeHost(runId)}:${FORGE_PORT_IN}\n`);
  writeFileSync(
    p.gitconfig,
    [
      "[user]",
      `\tname = ${user}`,
      `\temail = ${user}@${EMAIL_DOMAIN}`,
      "[credential]",
      `\thelper = store --file=${MOUNTS.runtime}/forge/git-credentials`,
      "[init]",
      "\tdefaultBranch = main",
      // The GitHub login (github.ts), when the run has one. Last, so its github.com helper reset wins.
      "[include]",
      `\tpath = ${GITHUB_GITCONFIG_IN}`,
      "",
    ].join("\n"),
  );
  secret(
    p.tea,
    [
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
  );
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

/** Create (or re-key) every agent's account and write its login files into its runtime dir. */
export async function provisionAgents(client: ForgeClient, runId: string, agents: { name: string; runtimeDir: string }[]): Promise<void> {
  for (const a of agents) {
    const p = loginPaths(a.runtimeDir);
    const existing = existsSync(p.token) ? readFileSync(p.token, "utf8").trim() : undefined;
    const token = await client.ensureAgent(a.name, existing);
    writeAgentLogin(a.runtimeDir, runId, a.name, token);
  }
}

/** `docker run` argv for the forge itself. No published port and no route out (plan §4.5). */
export function forgeRunArgs(o: { runId: string; image: string; network: string }): string[] {
  const host = forgeHost(o.runId);
  const ini: Record<string, string> = {
    security__INSTALL_LOCK: "true",
    database__DB_TYPE: "sqlite3",
    server__ROOT_URL: `${forgeUrl(o.runId)}/`,
    server__DOMAIN: host,
    server__HTTP_PORT: String(FORGE_PORT_IN),
    server__DISABLE_SSH: "true",
    server__START_SSH_SERVER: "false",
    server__OFFLINE_MODE: "true",
    service__DISABLE_REGISTRATION: "true",
    service__DEFAULT_KEEP_EMAIL_PRIVATE: "true",
    // Server-side fetches would bypass the egress proxy; the forge has no route out anyway.
    repository__DISABLE_MIGRATIONS: "true",
    mirror__ENABLED: "false",
    actions__ENABLED: "false",
    log__LEVEL: "Warn",
  };
  return [
    "docker", "run", "-d", "--rm",
    "--name", host,
    "--label", `slopswarm.forge=${o.runId}`,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp:rw,size=256m",
    "--cpus", "1",
    "--memory", "1g",
    "--pids-limit", "512",
    "--network", o.network,
    "-v", `${forgeDataDir(o.runId)}:/var/lib/gitea:rw`,
    ...Object.entries(ini).flatMap(([k, v]) => ["-e", `FORGEJO__${k}=${v}`]),
    o.image,
  ];
}

/** `docker run` argv for the forwarder: 127.0.0.1:<port> -> forge:3000. */
export function forwarderRunArgs(o: { runId: string; network: string; hostPort: number }): string[] {
  const host = forgeHost(o.runId);
  return [
    "docker", "run", "-d", "--rm",
    "--name", `${host}-port`.slice(0, 63),
    "--label", `slopswarm.forge=${o.runId}`,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--network", EGRESS_NETWORK,
    "--network", o.network,
    "-p", `127.0.0.1:${o.hostPort}:${FORGE_PORT_IN}`,
    FORWARDER_IMAGE,
    `TCP-LISTEN:${FORGE_PORT_IN},fork,reuseaddr`,
    `TCP:${host}:${FORGE_PORT_IN}`,
  ];
}

async function docker(argv: string[], env?: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: env ? { ...process.env, ...env } : process.env });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

/** Remove this run's forge containers (the data stays on disk). */
export async function stopForge(runId: string): Promise<void> {
  const ps = await docker(["docker", "ps", "-aq", "--filter", `label=slopswarm.forge=${runId}`]);
  const ids = ps.out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (ids.length) await docker(["docker", "rm", "-f", ...ids]);
}

/**
 * Start the run's forge and forwarder (replacing leftovers from a crashed controller), create the
 * owner's admin account on first start, and return a client. Throws with a hint if the port is taken.
 */
export async function startForge(o: { runId: string; image: string; network: string; hostPort: number; admin: ForgeAdmin }): Promise<ForgeClient> {
  await stopForge(o.runId);
  mkdirSync(forgeDataDir(o.runId), { recursive: true });
  const f = await docker(forgeRunArgs(o));
  if (f.code !== 0) throw new Error(`forge did not start: ${f.err.trim()}`);
  const w = await docker(forwarderRunArgs(o));
  if (w.code !== 0) {
    await stopForge(o.runId);
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
        "docker", "exec", "-e", "FORGE_ADMIN_PASSWORD", forgeHost(o.runId), "sh", "-c",
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
