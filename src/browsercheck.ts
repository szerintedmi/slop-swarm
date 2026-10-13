// browsercheck (docker/browsercheck.mjs): headless Chromium in the agent image, for agents testing browser software.
// Not a capability switch (it's in every image, adds no egress); the swarm config sets its time limit, which reaches
// the container as BROWSERCHECK_TIMEOUT_S: the default and the most an agent's `--timeout` may ask for.
import type { BrowsercheckConfig } from "./config.ts";
import type { Harness } from "./types.ts";

export const BROWSERCHECK_TIMEOUT_ENV = "BROWSERCHECK_TIMEOUT_S";
/** Claude Code kills a Bash command after this long unless the model asks for more. */
const CLAUDE_BASH_DEFAULT_MS = 120_000;
/** Room for Chromium's start and shutdown on top of the browsercheck limit. */
const SHELL_SLACK_MS = 30_000;

/**
 * The container env for browsercheck. Claude Code's Bash tool would cut a browsercheck run off at its own 2-minute
 * default, so for Claude agents that default is raised to the limit plus slack. Codex returns after 10 s and lets the
 * command run on (it polls), and pi's bash has no default timeout.
 */
export function browsercheckEnv(b: BrowsercheckConfig, harness: Harness): Record<string, string> {
  const env: Record<string, string> = { [BROWSERCHECK_TIMEOUT_ENV]: String(Math.round(b.timeoutMs / 1000)) };
  const shellMs = b.timeoutMs + SHELL_SLACK_MS;
  if (harness === "claude" && shellMs > CLAUDE_BASH_DEFAULT_MS) env.BASH_DEFAULT_TIMEOUT_MS = String(shellMs);
  return env;
}
