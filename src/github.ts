// The agents' public outlet (plan §4.6): one GitHub org, reached through one account they all share.
// The token lives in a file under secrets/; the controller writes gh's login from it each wake, and git
// gets its GitHub credentials from gh. Nothing goes through the container env, so it never shows in `docker run` args.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MOUNTS } from "./docker.ts";

export const GITHUB_TOKEN_PATH = join(import.meta.dir, "..", "secrets", "github", "token");

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

export function writeGithubLogin(runtimeDir: string, user: string, token: string): void {
  const p = githubLoginPaths(runtimeDir);
  mkdirSync(join(runtimeDir, "github", "gh"), { recursive: true });
  writeFileSync(p.hosts, ["github.com:", `    user: ${user}`, `    oauth_token: ${token}`, "    git_protocol: https", ""].join("\n"));
  chmodSync(p.hosts, 0o600);
  // Only for github.com; the forge keeps its own credential store.
  writeFileSync(p.gitconfig, ['[credential "https://github.com"]', "\thelper =", "\thelper = !gh auth git-credential", ""].join("\n"));
}
