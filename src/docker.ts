// `docker run` argv for one ephemeral agent wake (plan §7.1) + small docker helpers.

export interface ContainerSpec {
  name: string;
  image: string;
  runId: string;
  agent: string;
  /** The world the wake belongs to, and the wake's id (container name) on the runner: labels for reattach and kill. */
  world?: string;
  wake?: string;
  /**
   * `docker run -d` without `--rm` (the runner, src/runner/): the container outlives the docker CLI, so a restarted
   * runner reattaches to it by label, and its exit code and logs survive until the runner removes it.
   */
  detach?: boolean;
  /** Host paths. Agents share nothing on disk; their shared world is the forge (plan §4.5). */
  mounts: { home: string; self: string; runtime: string };
  env: Record<string, string>;
  /**
   * Names passed as `-e NAME`: the value comes from the docker CLI's own env, so secrets never appear in argv.
   * `{ name, from }` passes the host variable `from` as `name` (see dockerProcessEnv).
   */
  passEnv?: (string | { name: string; from: string })[];
  argv: string[];
  network: string;
  proxy: string;
  /** Hosts reached directly on the internal network (the run's forge), not through the proxy. */
  noProxy?: string[];
  limits: { cpus: number; memoryGb: number; pidsLimit: number };
}

/** Container-side mount points. */
export const MOUNTS = { home: "/home/agent", self: "/self", runtime: "/runtime" } as const;

export const AGENT_UID = "1000:1000";

export function dockerRunArgs(spec: ContainerSpec): string[] {
  const noProxy = ["localhost", "127.0.0.1", ...(spec.noProxy ?? [])].join(",");
  const env: Record<string, string> = {
    HOME: MOUNTS.home,
    TMPDIR: "/tmp",
    HTTPS_PROXY: spec.proxy,
    HTTP_PROXY: spec.proxy,
    https_proxy: spec.proxy,
    http_proxy: spec.proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    ...spec.env,
  };
  const args = [
    "docker", "run", spec.detach ? "-d" : "--rm", "--init",
    "--name", spec.name,
    "--label", "slopswarm=1",
    "--label", `slopswarm.run=${spec.runId}`,
    "--label", `slopswarm.agent=${spec.agent}`,
    ...(spec.world ? ["--label", `slopswarm.world=${spec.world}`] : []),
    ...(spec.wake ? ["--label", `slopswarm.wake=${spec.wake}`] : []),
    "--user", AGENT_UID,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp:rw,exec,size=512m",
    "--cpus", String(spec.limits.cpus),
    "--memory", `${Math.round(spec.limits.memoryGb * 1024)}m`,
    "--pids-limit", String(spec.limits.pidsLimit),
    "--network", spec.network,
    "-w", MOUNTS.home,
    "-v", `${spec.mounts.home}:${MOUNTS.home}:rw`,
    "-v", `${spec.mounts.self}:${MOUNTS.self}:ro`,
    "-v", `${spec.mounts.runtime}:${MOUNTS.runtime}:rw`,
  ];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  for (const k of spec.passEnv ?? []) args.push("-e", typeof k === "string" ? k : k.name);
  args.push(spec.image, ...spec.argv);
  return args;
}

/**
 * The env for the `docker run` process: `base` plus each renamed passEnv variable under its container name, so
 * `-e NAME` picks it up. The value only ever lives in that child's env.
 */
export function dockerProcessEnv(spec: Pick<ContainerSpec, "passEnv">, base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const env = { ...base };
  for (const k of spec.passEnv ?? []) if (typeof k !== "string") env[k.name] = base[k.from];
  return env;
}

async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

/** `docker kill` every container labelled slopswarm (optionally only one run or world). Returns the killed names. */
export async function dockerKillLabelled(filter: { runId?: string; world?: string } = {}): Promise<string[]> {
  const label = filter.world ? `slopswarm.world=${filter.world}` : filter.runId ? `slopswarm.run=${filter.runId}` : "slopswarm=1";
  const ps = await run(["docker", "ps", "-q", "--filter", `label=${label}`, "--format", "{{.Names}}"]);
  const names = ps.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (names.length) await run(["docker", "kill", ...names]);
  return names;
}

export async function imageInfo(image: string): Promise<{ digest: string; claude?: string; codex?: string; pi?: string } | null> {
  const r = await run(["docker", "image", "inspect", image, "--format", "{{json .}}"]);
  if (r.code !== 0) return null;
  const info = JSON.parse(r.stdout) as { Id: string; RepoDigests?: string[]; Config?: { Labels?: Record<string, string> } };
  const labels = info.Config?.Labels ?? {};
  return {
    digest: info.RepoDigests?.[0] ?? info.Id,
    claude: labels["org.slopswarm.claude-code"],
    codex: labels["org.slopswarm.codex"],
    pi: labels["org.slopswarm.pi"],
  };
}
