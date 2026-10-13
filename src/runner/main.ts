// The runner daemon (docs/plans/2026-10-12-hosted-control-plane.md §2.3): `just runner` on an agent host, or started
// in-process by `just up` on the laptop. Env:
//   RUNNER_TOKEN     shared bearer token (required; the controller has the same value)
//   RUNNER_DATA_DIR  agent dirs, wake output, logs (default: <data>/runner)
//   RUNNER_HOST      bind address (default 127.0.0.1; the agent host's tailnet address when the controller is remote)
//   RUNNER_PORT      default 7701
import { join } from "node:path";
import { dataDir } from "../db/index.ts";
import { dockerInfra, dockerRuntime } from "./containers.ts";
import { Runner } from "./runner.ts";

export const DEFAULT_RUNNER_PORT = 7701;

export function runnerDataDir(): string {
  return process.env.RUNNER_DATA_DIR?.trim() || join(dataDir(), "runner");
}

/** Start a runner and serve it. `port: 0` picks a free port. */
export async function serveRunner(o: { token: string; host?: string; port?: number; dataDir?: string }): Promise<{ url: string; runner: Runner; stop(): void }> {
  const runner = new Runner({ dataDir: o.dataDir ?? runnerDataDir(), token: o.token, runtime: dockerRuntime, infra: dockerInfra });
  await runner.init();
  const server = Bun.serve({
    hostname: o.host ?? "127.0.0.1",
    port: o.port ?? DEFAULT_RUNNER_PORT,
    // Home snapshots can be large and slow.
    idleTimeout: 0,
    maxRequestBodySize: 4 * 1024 * 1024 * 1024,
    fetch: (req) => runner.handle(req),
  });
  return {
    url: `http://${server.hostname}:${server.port}`,
    runner,
    stop: () => {
      runner.close();
      server.stop(true);
    },
  };
}

/**
 * Agents run as uid 1000 and write their bind-mounted dirs, which the runner creates: on Linux the runner must be that
 * user (in the docker group). macOS (OrbStack, Docker Desktop) maps file ownership itself.
 */
export function runnerUserProblem(platform = process.platform, uid = process.getuid?.()): string | null {
  if (platform !== "linux" || uid === undefined || uid === AGENT_UID_NUM) return null;
  return `on Linux the runner must run as the agents' uid ${AGENT_UID_NUM} (it is ${uid}): agents write the dirs it creates`;
}
const AGENT_UID_NUM = 1000;

if (import.meta.main) {
  const problem = runnerUserProblem();
  if (problem && process.env.RUNNER_ALLOW_ANY_UID !== "1") {
    console.error(`error: ${problem} (RUNNER_ALLOW_ANY_UID=1 to start anyway)`);
    process.exit(1);
  }
  const token = process.env.RUNNER_TOKEN?.trim();
  if (!token) {
    console.error("error: RUNNER_TOKEN is not set");
    process.exit(1);
  }
  const port = Number(process.env.RUNNER_PORT ?? DEFAULT_RUNNER_PORT);
  const r = await serveRunner({ token, host: process.env.RUNNER_HOST?.trim() || "127.0.0.1", port });
  r.runner.log.info(`runner listening on ${r.url} (data: ${runnerDataDir()})`);
  const quit = () => {
    // Wakes keep running: a restarted runner reattaches to them.
    r.stop();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}
