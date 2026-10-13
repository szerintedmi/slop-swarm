// Egress allowlist proxy (tinyproxy) and image builds (plan §7.2).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dir, "..");
export const COMPOSE_FILE = join(REPO, "docker", "compose.yaml");
// Generated, gitignored. Lives in the repo (not the data folder): compose mounts it by a fixed relative path.
export const PROXY_FILTER = join(REPO, "docker", "proxy", "filter");
export const PROXY_CONTAINER = "slopswarm-proxy";
const AGENT_DOCKERFILE = join(REPO, "docker", "agent.Dockerfile");
/**
 * Agent image tagged by the hash of its Dockerfile and the files it copies (docker/websearch, docker/webfetch): worktrees with the same
 * Dockerfile share one image, and a branch that changes it gets its own without touching the others.
 */
export const AGENT_IMAGE = `slopswarm-agent:${new Bun.CryptoHasher("sha256")
  .update(readFileSync(AGENT_DOCKERFILE))
  .update(readFileSync(join(REPO, "docker", "websearch")))
  .update(readFileSync(join(REPO, "docker", "webfetch")))
  .digest("hex")
  .slice(0, 12)}`;

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Suffix match: `api.anthropic.com` allows that host and its subdomains, nothing else. */
export function filterLines(allowlist: string[]): string[] {
  return allowlist.map((d) => {
    const domain = d.trim().toLowerCase().replace(/^\*?\./, "");
    if (!DOMAIN_RE.test(domain)) throw new Error(`network.allowlist: invalid domain ${JSON.stringify(d)}`);
    return `(^|\\.)${domain.replaceAll(".", "\\.")}$`;
  });
}

/** Write docker/proxy/filter. Returns true if the content changed. */
export function writeProxyFilter(allowlist: string[]): boolean {
  const text = filterLines(allowlist).join("\n") + "\n";
  if (existsSync(PROXY_FILTER) && readFileSync(PROXY_FILTER, "utf8") === text) return false;
  mkdirSync(dirname(PROXY_FILTER), { recursive: true });
  writeFileSync(PROXY_FILTER, text);
  return true;
}

async function sh(argv: string[], { quiet = false } = {}): Promise<string> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: quiet ? "pipe" : "inherit", cwd: REPO });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) throw new Error(`${argv.join(" ")} exited ${code}`);
  return out;
}

async function proxyRunning(): Promise<boolean> {
  const p = Bun.spawn(["docker", "inspect", "-f", "{{.State.Running}}", PROXY_CONTAINER], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  return (await p.exited) === 0 && out.trim() === "true";
}

/** Write the filter, bring up the internal network + proxy, restart the proxy if the allowlist changed. */
export async function ensureProxy(allowlist: string[]): Promise<void> {
  const changed = writeProxyFilter(allowlist);
  const wasRunning = await proxyRunning();
  await sh(["docker", "compose", "-f", COMPOSE_FILE, "up", "-d", "--quiet-pull"], { quiet: true });
  // tinyproxy reads the filter at startup only.
  if (changed && wasRunning) await sh(["docker", "restart", PROXY_CONTAINER], { quiet: true });
}

export async function buildImages(): Promise<void> {
  await buildAgentImage();
  await sh(["docker", "compose", "-f", COMPOSE_FILE, "build"]);
}

export async function buildAgentImage(): Promise<void> {
  await sh(["docker", "build", "-f", AGENT_DOCKERFILE, "-t", AGENT_IMAGE, join(REPO, "docker")]);
}

/** Build the agent image for the current Dockerfile if it doesn't exist yet. */
export async function ensureAgentImage(): Promise<void> {
  const p = Bun.spawn(["docker", "image", "inspect", AGENT_IMAGE], { stdout: "ignore", stderr: "ignore" });
  if ((await p.exited) === 0) return;
  console.log(`building ${AGENT_IMAGE} (agent.Dockerfile changed or first use)…`);
  await buildAgentImage();
}
