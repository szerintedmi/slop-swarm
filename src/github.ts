// The agents' public outlet (plan §4.6): one GitHub org, reached through one account they all share.
// The token is SWARM_GITHUB_TOKEN in .env (not GITHUB_TOKEN/GH_TOKEN, which gh and git on the host would pick up
// and act as the agents' account). The controller writes gh's login from it each wake, and git gets its GitHub
// credentials from gh. The token never goes into the container env, so it never shows in `docker run` args.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MOUNTS } from "./docker.ts";

export const GITHUB_TOKEN_ENV = "SWARM_GITHUB_TOKEN";

/** The agents' shared GitHub token from .env, or undefined if unset. Read per wake. */
export function githubTokenFromEnv(): string | undefined {
  return process.env[GITHUB_TOKEN_ENV]?.trim() || undefined;
}

/** Files in an agent's runtime dir (mounted at /runtime) that log gh and git in to GitHub. */
export function githubLoginPaths(runtimeDir: string) {
  return {
    hosts: join(runtimeDir, "github", "gh", "hosts.yml"),
    // Included from the forge gitconfig (forge.ts); git ignores the include when the file is missing.
    gitconfig: join(runtimeDir, "github", "gitconfig"),
  };
}
export const GITHUB_GITCONFIG_IN = `${MOUNTS.runtime}/github/gitconfig`;

/** Container env for the GitHub login. */
export function githubEnv(): Record<string, string> {
  return { GH_CONFIG_DIR: `${MOUNTS.runtime}/github/gh` };
}

/** The GitHub login files, relative to the runtime dir (rewritten into it by every prepare). */
export function githubLoginFiles(user: string, token: string): { path: string; content: string; mode: number }[] {
  return [
    { path: "github/gh/hosts.yml", content: ["github.com:", `    user: ${user}`, `    oauth_token: ${token}`, "    git_protocol: https", ""].join("\n"), mode: 0o600 },
    // Only for github.com; the forge keeps its own credential store.
    { path: "github/gitconfig", content: ['[credential "https://github.com"]', "\thelper =", "\thelper = !gh auth git-credential", ""].join("\n"), mode: 0o644 },
  ];
}

export function writeGithubLogin(runtimeDir: string, user: string, token: string): void {
  mkdirSync(join(runtimeDir, "github", "gh"), { recursive: true });
  for (const f of githubLoginFiles(user, token)) {
    writeFileSync(join(runtimeDir, f.path), f.content);
    chmodSync(join(runtimeDir, f.path), f.mode);
  }
}
