// How the runner runs wake containers (docs/plans/2026-10-12-hosted-control-plane.md §2.3). A wake starts with
// `docker run -d` (no --rm), then `docker logs -f` writes its stdout and stderr to files and `docker wait` gives
// the exit code; the container is removed after both. A restarted runner follows a container it finds by label
// the same way: `docker logs` replays from the start, so the files get the same bytes again and the controller's
// offsets stay valid.
import { buildAgentImage, AGENT_IMAGE, ensureProxy } from "../proxy.ts";
import { imageInfo, dockerKillLabelled } from "../docker.ts";
import { EGRESS_NETWORK, forgeHost, FORWARDER_IMAGE } from "../forge.ts";
import { startSearch, stopSearch } from "../search.ts";
import type { WebfetchConfig } from "../config.ts";

export interface WakeContainer {
  /** The container's exit code, after its output is in the files and it has been removed. */
  exited: Promise<number>;
}

export interface OutputFiles {
  stdout: string;
  stderr: string;
}

export interface ContainerRuntime {
  /** Start the container (`argv` is a full `docker run -d …`) and follow it. Throws if docker refused. */
  launch(argv: string[], env: Record<string, string | undefined>, out: OutputFiles): Promise<WakeContainer>;
  /** Follow a container that is already there (running or exited); null if it is gone. */
  reattach(name: string, out: OutputFiles): Promise<WakeContainer | null>;
  /** Names of wake containers present (label slopswarm.wake), running or not. */
  present(): Promise<string[]>;
  kill(name: string): Promise<void>;
}

/** Long-lived pieces of the agent host: proxy, images, world relays and forge forwarders. */
export interface RunnerInfra {
  ensureProxy(allowlist: string[]): Promise<void>;
  /** Make the agent image available (pull by digest, or build the local tag); returns its labels. */
  ensureImage(ref: string): Promise<{ digest: string; claude?: string; codex?: string; pi?: string }>;
  relayUp(o: { world: string; dir: string; network: string; webfetch?: WebfetchConfig; exaKey?: string }): Promise<void>;
  relayDown(world: string): Promise<void>;
  forgeForwarderUp(o: { world: string; network: string; target: string }): Promise<void>;
  forgeForwarderDown(world: string): Promise<void>;
  /** `docker kill` every wake container (of one world). */
  killAll(world?: string): Promise<string[]>;
}

async function run(argv: string[], env?: Record<string, string | undefined>): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: env ?? process.env });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

export const dockerRuntime: ContainerRuntime = {
  async launch(argv, env, out) {
    const r = await run(argv, env);
    if (r.code !== 0) throw new Error(`docker run: ${r.err.trim().slice(0, 500) || `exit ${r.code}`}`);
    const name = argv[argv.indexOf("--name") + 1]!;
    const c = await this.reattach(name, out);
    if (!c) throw new Error(`docker run: container ${name} vanished`);
    return c;
  },

  async reattach(name, out) {
    if ((await run(["docker", "container", "inspect", "-f", "{{.State.Status}}", name])).code !== 0) return null;
    const logs = Bun.spawn(["docker", "logs", "-f", name], { stdout: Bun.file(out.stdout), stderr: Bun.file(out.stderr), stdin: "ignore" });
    const wait = run(["docker", "wait", name]);
    const exited = (async () => {
      const [w] = await Promise.all([wait, logs.exited]);
      const code = Number.parseInt(w.out.trim(), 10);
      await run(["docker", "rm", "-f", name]);
      return Number.isFinite(code) ? code : -1;
    })();
    return { exited };
  },

  async present() {
    const r = await run(["docker", "ps", "-a", "--filter", "label=slopswarm.wake", "--format", "{{.Names}}"]);
    return r.out.split("\n").map((s) => s.trim()).filter(Boolean);
  },

  async kill(name) {
    await run(["docker", "kill", name]);
  },
};

/** Forwarder on the agent host for a remote forge: `slopswarm-forge-<world>:3000` -> the VPS forge router port. */
export function forgeForwarderArgs(o: { world: string; network: string; target: string }): string[] {
  if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(o.target)) throw new Error(`forge target: expected host:port, got ${JSON.stringify(o.target)}`);
  return [
    "docker", "run", "-d", "--rm",
    "--name", forgeHost(o.world),
    // Not slopswarm.forge: locally that label is the forge itself, which the runner must never remove.
    "--label", `slopswarm.forge-forwarder=${o.world}`,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--cpus", "0.25",
    "--memory", "64m",
    "--pids-limit", "64",
    // Internal: agents reach it by the forge's name. Egress: its route to the VPS (tailnet), and nowhere else it is told.
    "--network", o.network,
    "--network", EGRESS_NETWORK,
    FORWARDER_IMAGE,
    "TCP-LISTEN:3000,fork,reuseaddr",
    `TCP:${o.target}`,
  ];
}

export const dockerInfra: RunnerInfra = {
  ensureProxy: (allowlist) => ensureProxy(allowlist),

  async ensureImage(ref) {
    let info = await imageInfo(ref);
    if (!info) {
      if (ref === AGENT_IMAGE) await buildAgentImage();
      else if (ref.includes("@sha256:") || ref.includes("/")) {
        const r = await run(["docker", "pull", "-q", ref]);
        if (r.code !== 0) throw new Error(`docker pull ${ref}: ${r.err.trim().slice(0, 300)}`);
      } else throw new Error(`agent image ${ref} is not here and is neither this checkout's tag (${AGENT_IMAGE}) nor a registry reference`);
      info = await imageInfo(ref);
      if (!info) throw new Error(`agent image ${ref} is still missing`);
    }
    return info;
  },

  relayUp: (o) => startSearch({ runId: o.world, network: o.network, dir: o.dir, webfetch: o.webfetch, exaKey: o.exaKey }),
  relayDown: (world) => stopSearch(world),

  async forgeForwarderUp(o) {
    await this.forgeForwarderDown(o.world);
    const r = await run(forgeForwarderArgs(o));
    if (r.code !== 0) throw new Error(`forge forwarder: ${r.err.trim().slice(0, 300)}`);
  },
  async forgeForwarderDown(world) {
    const ps = await run(["docker", "ps", "-aq", "--filter", `label=slopswarm.forge-forwarder=${world}`]);
    const ids = ps.out.split("\n").map((s) => s.trim()).filter(Boolean);
    if (ids.length) await run(["docker", "rm", "-f", ...ids]);
  },

  killAll: (world) => dockerKillLabelled(world ? { world } : {}),
};
