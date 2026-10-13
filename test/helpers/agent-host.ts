// A real Runner (src/runner/) behind a RunnerHost, with a fake container runtime: `behave(agent, argv)` gives a
// wake's stdout, or null to hang until killed. The controller tests drive wakes through it end to end.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunnerHost } from "../../src/host/agent-host.ts";
import { parseHostConfig } from "../../src/hostconfig.ts";
import type { Logger } from "../../src/log.ts";
import type { ContainerRuntime, OutputFiles, RunnerInfra, WakeContainer } from "../../src/runner/containers.ts";
import { Runner, runnerAgentDirs } from "../../src/runner/runner.ts";

export const TEST_HOST = parseHostConfig({
  network: { name: "slopswarm-internal", proxy: "http://slopswarm-proxy:8888", allowlist: ["api.anthropic.com", "openrouter.ai"] },
  container: { cpus: 1, memory_gb: 2, pids_limit: 256 },
});

export const silentLogger: Logger = { log() {}, info() {}, warn() {}, error() {}, with() { return silentLogger; } };

export interface FakeAgentHost {
  host: RunnerHost;
  runner: Runner;
  /** `docker run` argv of every wake, in order. */
  argvs: string[][];
  /** The env each `docker run` got (secrets by name). */
  envs: Record<string, string | undefined>[];
  /** Container names `docker kill` was called with. */
  kills: string[];
  /** The agent's dirs on the (fake) agent host. */
  dirs(world: string, agent: string): ReturnType<typeof runnerAgentDirs>;
  runnerDir: string;
}

export function fakeAgentHost(o: {
  dataDir: string;
  behave: (agent: string, argv: string[]) => string | null | Promise<string>;
  /** What a hanging container prints before it hangs. */
  hangOutput?: string;
  /** The first N `docker kill`s do nothing (a container still being created). */
  killMisses?: number;
}): FakeAgentHost {
  const runnerDir = join(o.dataDir, "runner");
  mkdirSync(runnerDir, { recursive: true });
  const argvs: string[][] = [];
  const envs: Record<string, string | undefined>[] = [];
  const kills: string[] = [];
  const live = new Map<string, { world: string; finish: (code: number) => void }>();
  let misses = o.killMisses ?? 0;
  const runtime: ContainerRuntime = {
    async launch(argv: string[], env: Record<string, string | undefined>, out: OutputFiles): Promise<WakeContainer> {
      argvs.push(argv);
      envs.push(env);
      const name = argv[argv.indexOf("--name") + 1]!;
      const label = (k: string) => argv.find((a) => a.startsWith(`slopswarm.${k}=`))!.split("=")[1]!;
      const text = o.behave(label("agent"), argv);
      let finish!: (code: number) => void;
      const exited = new Promise<number>((r) => (finish = r));
      live.set(name, { world: label("world"), finish });
      if (text === null) writeFileSync(out.stdout, o.hangOutput ?? "");
      else
        void Promise.resolve(text).then((t) => {
          writeFileSync(out.stdout, t);
          finish(0);
        });
      return { exited: exited.then((c) => (live.delete(name), c)) };
    },
    async reattach() {
      return null;
    },
    async present() {
      return [...live.keys()];
    },
    async kill(name: string) {
      kills.push(name);
      if (misses > 0) misses--;
      else live.get(name)?.finish(137);
    },
  };
  const infra: RunnerInfra = {
    async ensureProxy() {},
    async ensureImage() {
      return { digest: "sha256:test", claude: "2.1.296" };
    },
    async relayUp() {},
    async relayDown() {},
    async forgeForwarderUp() {},
    async forgeForwarderDown() {},
    async killAll(world?: string) {
      const names = [...live.entries()].filter(([, c]) => !world || c.world === world).map(([n]) => n);
      for (const n of names) await runtime.kill(n);
      return names;
    },
  };
  const token = "test-runner-token";
  const runner = new Runner({ dataDir: runnerDir, token, runtime, infra, watchdog: false, initialHost: TEST_HOST, log: silentLogger, killRetryMs: 50 });
  const host = new RunnerHost({ url: "http://runner.test", token, fetch: (req) => runner.handle(req) });
  return { host, runner, argvs, envs, kills, runnerDir, dirs: (world, agent) => runnerAgentDirs(runnerDir, world, agent) };
}
