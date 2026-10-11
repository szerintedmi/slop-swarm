// `just preflight`: plan §11 checks 1–7, and 9 (web search relay). Each prints PASS / FAIL / SKIP with a one-line reason.
// Containers run with the same dockerRunArgs as real wakes; scratch dirs live under data/preflight/.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OPENROUTER_DOMAIN, loadSwarm, parseAgent, type AgentConfig, type SwarmConfig } from "./config.ts";
import { fillSeed, SYSTEM_PROMPT_FILE } from "./controller/run.ts";
import { DATA_DIR } from "./db/index.ts";
import { dockerProcessEnv, dockerRunArgs, imageInfo, MOUNTS, type ContainerSpec } from "./docker.ts";
import { forgeUrl } from "./forge.ts";
import { computeCost, loadPricing, parsePricing, searchCost } from "./pricing/index.ts";
import { generationCosts, prepareOpenRouter } from "./openrouter.ts";
import { secretEnv } from "./controller/wake.ts";
import { writePiModels } from "./runtimes/pi.ts";
import { billed, issueSearchToken, readSearchLog, SEARCH_MODEL, searchDirs, searchEnv, searchHost, startSearch, stopSearch } from "./search.ts";
import { AGENT_IMAGE, ensureAgentImage, ensureProxy } from "./proxy.ts";
import { getAdapter } from "./runtimes/index.ts";
import type { AgentEvent, RequestUsage, Runtime } from "./types.ts";

type Status = "PASS" | "FAIL" | "SKIP";
interface Result {
  status: Status;
  reason: string;
}

const REPO = join(import.meta.dir, "..");
const FIXTURES = join(REPO, "test", "fixtures");
const CODEX_AUTH = join(REPO, "secrets", "codex", "auth.json");
const CONTAINER_TIMEOUT_MS = 5 * 60_000;

interface RunOutput {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface CliRun extends RunOutput {
  runtimeDir: string;
  events: AgentEvent[];
  usage: RequestUsage[];
}

class Preflight {
  readonly root = join(DATA_DIR, "preflight", new Date().toISOString().replace(/[:.]/g, "-"));
  private seq = 0;
  /** Outputs shared between checks (1–3 feed 5–7). */
  claudeHi?: CliRun;
  codexHi?: CliRun;

  constructor(readonly cfg: SwarmConfig) {
    mkdirSync(this.root, { recursive: true });
  }

  model(runtime: Runtime): string {
    if (runtime === "pi") return piAgent(this.cfg).model;
    return this.cfg.agents.find((a) => a.runtime === runtime)?.model ?? (runtime === "claude" ? "claude-haiku-5-5" : "gpt-6-luna");
  }

  agentDirs(agent: string) {
    const base = join(this.root, "agents", agent);
    const d = { home: join(base, "home"), self: join(base, "self"), runtime: join(base, "runtime") };
    for (const p of [d.home, d.self, d.runtime]) mkdirSync(p, { recursive: true });
    return d;
  }

  async container(
    agent: string,
    argv: string[],
    { env = {}, passEnv = [], noProxy = [] }: { env?: Record<string, string>; passEnv?: NonNullable<ContainerSpec["passEnv"]>; noProxy?: string[] } = {},
  ): Promise<RunOutput> {
    const dirs = this.agentDirs(agent);
    const name = `slopswarm-preflight-${agent}-${process.pid}-${++this.seq}`;
    const args = dockerRunArgs({
      name,
      image: AGENT_IMAGE,
      runId: "preflight",
      agent,
      mounts: { home: dirs.home, self: dirs.self, runtime: dirs.runtime },
      env,
      passEnv,
      argv,
      network: this.cfg.network.name,
      proxy: this.cfg.network.proxy,
      noProxy,
      limits: this.cfg.controller.container,
    });
    const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: dockerProcessEnv({ passEnv }) });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      Bun.spawn(["docker", "kill", name], { stdout: "ignore", stderr: "ignore" });
    }, CONTAINER_TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    return { code, stdout, stderr, timedOut };
  }

  /**
   * Run a CLI inside a container with the adapter's real command line (+ optional extra flags).
   * "lean" (what agents run) uses the filled seed as the system prompt; "stock" keeps the CLI's own.
   */
  async cli(runtime: Runtime, agent: string, prompt: string, extraArgs: string[] = [], maxTurns = 5, harness: "lean" | "stock" = "lean"): Promise<CliRun> {
    const adapter = getAdapter(runtime);
    const dirs = this.agentDirs(agent);
    let systemPrompt: { text: string; file: string } | undefined;
    if (harness === "lean") {
      const s = this.cfg.scheduler;
      const text = fillSeed(readFileSync(this.cfg.paths.seed, "utf8"), { name: agent, forgeUrl: forgeUrl("preflight"), maxSleepMs: s.maxSleepMs });
      writeFileSync(join(dirs.runtime, SYSTEM_PROMPT_FILE), text);
      systemPrompt = { text, file: `${MOUNTS.runtime}/${SYSTEM_PROMPT_FILE}` };
    }
    let argv = adapter.buildCommand({ prompt, model: this.model(runtime), effort: "medium", maxTurns, systemPrompt });
    if (extraArgs.length) argv = runtime === "codex" ? [...argv.slice(0, -1), ...extraArgs, argv[argv.length - 1]!] : [...argv, ...extraArgs];
    const passEnv = runtime === "pi" ? secretEnv(piAgent(this.cfg)) : runtime === "claude" ? ["CLAUDE_CODE_OAUTH_TOKEN"] : [];
    const out = await this.container(agent, argv, { env: adapter.containerEnv(MOUNTS.runtime), passEnv });
    const parser = adapter.newParser();
    const lines = out.stdout.split("\n").filter((l) => l.trim());
    const events = lines.flatMap((l) => parser.push(l));
    const streamed = new Map<string, RequestUsage>();
    for (const e of events) if (e.kind === "usage") streamed.set(e.usage.requestId, e.usage);
    const sessionId = events.find((e): e is Extract<AgentEvent, { kind: "session" }> => e.kind === "session")?.sessionId;
    let usage: RequestUsage[] = [...streamed.values()];
    try {
      usage = await adapter.finalizeUsage({ runtimeDir: dirs.runtime, sessionId, streamed: usage, stdoutLines: lines });
    } catch (e) {
      out.stderr += `\nfinalizeUsage failed: ${e}`;
    }
    return { ...out, runtimeDir: dirs.runtime, events, usage };
  }
}

// ---------- helpers ----------

const pass = (reason: string): Result => ({ status: "PASS", reason });
const fail = (reason: string): Result => ({ status: "FAIL", reason });
const skip = (reason: string): Result => ({ status: "SKIP", reason });

function jsonLines(text: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const l of text.split("\n")) {
    try {
      const v = JSON.parse(l);
      if (v && typeof v === "object") out.push(v);
    } catch {}
  }
  return out;
}

function lastLine(s: string): string {
  return s.trim().split("\n").filter(Boolean).pop()?.slice(0, 200) ?? "";
}

// Credential/identity keys only. Token *counts* (input_tokens, …) are the point of the fixtures.
const REDACT_KEYS = /(account_id|user_id|email|secret|api_key|access_token|refresh_token|id_token|^token$|bearer)/i;

/** Fixtures are committed: drop identifying fields (account/user ids, emails) before saving. */
function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, REDACT_KEYS.test(k) && typeof x === "string" ? "REDACTED" : scrub(x)]),
    );
  return v;
}

function saveFixture(name: string, text: string) {
  mkdirSync(FIXTURES, { recursive: true });
  const lines = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.stringify(scrub(JSON.parse(l)));
      } catch {
        return null;
      }
    })
    .filter((l): l is string => l !== null);
  writeFileSync(join(FIXTURES, name), lines.join("\n") + "\n");
}

function codexRollout(runtimeDir: string): string | undefined {
  const sessions = join(runtimeDir, "sessions");
  if (!existsSync(sessions)) return undefined;
  const files = [...new Bun.Glob("**/rollout-*.jsonl").scanSync({ cwd: sessions, absolute: true })].sort();
  return files.length ? readFileSync(files[files.length - 1]!, "utf8") : undefined;
}

function sha(path: string): string {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "";
}

function promptTokens(u: RequestUsage): number {
  return u.freshInput + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
}

function toolCalls(r: CliRun): string[] {
  return r.events.filter((e): e is Extract<AgentEvent, { kind: "tool_call" }> => e.kind === "tool_call").map((e) => e.name);
}

function turnEnd(r: CliRun) {
  return r.events.find((e): e is Extract<AgentEvent, { kind: "turn_end" }> => e.kind === "turn_end");
}

/** The pi agent the checks use: the config's first, else the sample `config/agents/fern.yaml`. */
function piAgent(cfg: SwarmConfig): AgentConfig {
  const a = cfg.agents.find((x) => x.runtime === "pi");
  if (a) return a;
  return parseAgent(Bun.YAML.parse(readFileSync(join(cfg.paths.configDir, "agents", "fern.yaml"), "utf8")), 1, "agents/fern.yaml");
}

const hasClaudeToken = () => !!process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
const hasCodexAuth = () => existsSync(CODEX_AUTH);

// ---------- checks ----------

async function check1(pf: Preflight): Promise<Result> {
  if (!hasClaudeToken()) return skip("CLAUDE_CODE_OAUTH_TOKEN not set in .env (run `claude setup-token`)");
  const r = await pf.cli("claude", "claude-hi", "say hi", [], 3);
  pf.claudeHi = r;
  saveFixture("preflight-claude-hi.jsonl", r.stdout);
  const init = jsonLines(r.stdout).find((d) => d.type === "system" && d.subtype === "init");
  if (!init) return fail(`no init event (exit ${r.code}): ${lastLine(r.stderr)}`);
  const src = String(init.apiKeySource ?? "");
  if (/api_?key|apiKeyHelper/i.test(src)) return fail(`apiKeySource=${src}: an API key is being used, not the OAuth token`);
  const end = turnEnd(r);
  if (r.code !== 0 || end?.reason !== "completed") return fail(`exit ${r.code}, ${end?.reason ?? "no result"}: ${lastLine(r.stderr) || end?.detail}`);
  return pass(`apiKeySource=${src || "none"} (OAuth), --effort medium accepted, ${r.usage.length} request(s)`);
}

async function check2(pf: Preflight): Promise<Result> {
  if (!hasCodexAuth()) return skip("secrets/codex/auth.json missing (copy your ChatGPT-login auth.json there)");
  const original = sha(CODEX_AUTH);
  const runs: { agent: string; ok: boolean; detail: string }[] = [];
  const runOnce = async (agent: string, fresh: boolean) => {
    const rt = pf.agentDirs(agent).runtime;
    if (fresh) copyFileSync(CODEX_AUTH, join(rt, "auth.json"));
    const r = await pf.cli("codex", agent, "say hi", [], 3);
    if (agent === "codex-a" && !pf.codexHi) pf.codexHi = r;
    const ok = r.code === 0 && turnEnd(r)?.reason === "completed";
    runs.push({ agent, ok, detail: ok ? "ok" : `exit ${r.code}: ${lastLine(r.stderr)}` });
    return r;
  };
  const a = await runOnce("codex-a", true);
  saveFixture("preflight-codex-hi.jsonl", a.stdout);
  const rollout = codexRollout(a.runtimeDir);
  if (rollout) saveFixture("preflight-codex-hi-rollout.jsonl", rollout);
  await runOnce("codex-b", true);
  const host = Bun.spawnSync(["codex", "login", "status"], { stdout: "pipe", stderr: "pipe" });
  const hostText = `${host.stdout.toString()}${host.stderr.toString()}`;
  const hostOk = host.exitCode === 0 && /logged in/i.test(hostText) && !/not logged in/i.test(hostText);
  // Second round with the (possibly rotated) per-container copies: did anyone get logged out?
  await runOnce("codex-a", false);
  await runOnce("codex-b", false);
  const rotated = ["codex-a", "codex-b"].some((a) => sha(join(pf.agentDirs(a).runtime, "auth.json")) !== original);
  const failed = runs.filter((r) => !r.ok);
  const summary = `containers ${runs.length - failed.length}/${runs.length} ok, host ${hostOk ? "logged in" : "LOGGED OUT"}, auth.json ${rotated ? "rotated in a container" : "unchanged"}`;
  if (failed.length || !hostOk)
    return fail(`${summary}; ${failed.map((f) => `${f.agent}: ${f.detail}`).join("; ")} -> fall back to one shared CODEX_HOME/auth.json and serialise Codex wakes`);
  return pass(summary);
}

async function check3(pf: Preflight): Promise<Result> {
  const probe = await pf.container("egress", [
    "bash",
    "-c",
    [
      `code() { curl -sS -m 15 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null; echo " rc=$?"; }`,
      `echo "example $(code https://example.com)"`,
      `echo "anthropic $(code https://api.anthropic.com/v1/messages)"`,
      `echo "chatgpt $(code https://chatgpt.com/backend-api/codex)"`,
      `echo "openrouter $(code https://openrouter.ai/api/v1/models)"`,
      `echo "direct $(curl -sS -m 5 --noproxy '*' -o /dev/null https://api.anthropic.com 2>/dev/null; echo rc=$?)"`,
    ].join("\n"),
  ]);
  const line = (k: string) => probe.stdout.split("\n").find((l) => l.startsWith(`${k} `)) ?? "";
  const http = (k: string) => Number(/ (\d{3}) rc=/.exec(line(k))?.[1] ?? 0);
  const problems: string[] = [];
  // Over HTTPS a proxy denial is a failed CONNECT (no HTTP status, curl rc 56); any status code
  // came from the upstream server, so the tunnel was allowed (chatgpt.com answers 403 to anonymous curl).
  if (http("example")) problems.push(`example.com reachable (${line("example")})`);
  if (!http("anthropic")) problems.push(`api.anthropic.com not reachable via proxy (${line("anthropic")})`);
  if (!http("chatgpt")) problems.push(`chatgpt.com not reachable via proxy (${line("chatgpt")})`);
  if (/rc=0/.test(line("direct"))) problems.push("direct egress without proxy works");
  const wantsOpenRouter = pf.cfg.network.allowlist.some((d) => d.trim().toLowerCase().replace(/^\*?\./, "") === OPENROUTER_DOMAIN);
  if (wantsOpenRouter && !http("openrouter")) problems.push(`openrouter.ai not reachable via proxy (${line("openrouter")})`);
  if (problems.length) return fail(problems.join("; "));
  const notes = ["example.com blocked, model APIs reachable only via proxy"];

  const searchPrompt = "Use your web search tool once to find the title of today's top story on bbc.com, then reply with that title only.";
  if (hasClaudeToken()) {
    const r = await pf.cli("claude", "claude-search", searchPrompt, [], 6);
    saveFixture("preflight-claude-search.jsonl", r.stdout);
    const searches = r.usage.reduce((s, u) => s + u.webSearches, 0);
    const tools = toolCalls(r);
    if (!searches && !tools.includes("WebSearch")) return fail(`Claude did not web-search (tools: ${tools.join(",") || "none"}; exit ${r.code})`);
    notes.push(`claude web search ok (${searches} server-side search${searches === 1 ? "" : "es"})`);
  } else notes.push("claude search SKIPPED (no token)");
  if (hasCodexAuth()) {
    const rt = pf.agentDirs("codex-search").runtime;
    copyFileSync(CODEX_AUTH, join(rt, "auth.json"));
    const r = await pf.cli("codex", "codex-search", searchPrompt, [], 6);
    saveFixture("preflight-codex-search.jsonl", r.stdout);
    const rollout = codexRollout(r.runtimeDir);
    if (rollout) saveFixture("preflight-codex-search-rollout.jsonl", rollout);
    const searched = /web_search/.test(rollout ?? "") || /web_search/.test(r.stdout);
    if (!searched) return fail(`Codex did not web-search (exit ${r.code}): ${lastLine(r.stderr)}`);
    notes.push("codex web search ok");
  } else notes.push("codex search SKIPPED (no auth.json)");
  return pass(notes.join("; "));
}

async function check4(pf: Preflight): Promise<Result> {
  // A second agent with a private file that agent "iso-a" must not see.
  const other = pf.agentDirs("iso-b");
  writeFileSync(join(other.home, "private-marker.txt"), "secret");
  const script = [
    "set +e",
    `t() { if eval "$2" >/dev/null 2>&1; then echo "$1 yes"; else echo "$1 no"; fi; }`,
    `t users "ls /Users"`,
    `t other "find / -name private-marker.txt 2>/dev/null | grep -q ."`,
    `t self_write "touch /self/x"`,
    `t root_write "touch /etc/x"`,
    `t home_write "echo hi > /home/agent/iso-home.txt"`,
    `t commons "test -e /commons"`,
    `t tea "tea --version"`,
    `t host_direct "curl -sS -m 5 --noproxy '*' http://host.docker.internal/"`,
    `t host_proxy "curl -sS -m 5 -f http://host.docker.internal/"`,
    `t docker_sock "test -e /var/run/docker.sock"`,
    `echo "uid $(id -u)"`,
  ].join("\n");
  const r = await pf.container("iso-a", ["bash", "-c", script]);
  const got = (k: string) => r.stdout.split("\n").find((l) => l.startsWith(`${k} `))?.split(" ")[1];
  const expect: Record<string, string> = {
    users: "no",
    other: "no",
    self_write: "no",
    root_write: "no",
    home_write: "yes",
    commons: "no",
    tea: "yes",
    host_direct: "no",
    host_proxy: "no",
    docker_sock: "no",
    uid: "1000",
  };
  const bad = Object.entries(expect).filter(([k, v]) => got(k) !== v).map(([k, v]) => `${k}=${got(k) ?? "?"} (want ${v})`);
  const homeFile = join(pf.agentDirs("iso-a").home, "iso-home.txt");
  if (!existsSync(homeFile)) bad.push("container write not visible on host");
  if (bad.length) return fail(`${bad.join(", ")} (exit ${r.code} ${lastLine(r.stderr)})`);
  return pass("no /Users, no other agents' files, /self + rootfs read-only, home writable as uid 1000, no /commons, tea installed, host unreachable");
}

function fixtureText(name: string, fallback?: string): { text: string; source: string } | undefined {
  for (const n of [name, fallback]) {
    if (n && existsSync(join(FIXTURES, n))) return { text: readFileSync(join(FIXTURES, n), "utf8"), source: n };
  }
  return undefined;
}

async function check5(pf: Preflight): Promise<Result> {
  const notes: string[] = [];
  // Claude: cache_creation TTL split present?
  const claude = pf.claudeHi ? { text: pf.claudeHi.stdout, source: "check 1" } : fixtureText("preflight-claude-hi.jsonl", "claude-hi.jsonl");
  if (claude) {
    const split = jsonLines(claude.text).some(
      (d) => d.message?.usage?.cache_creation && "ephemeral_1h_input_tokens" in d.message.usage.cache_creation,
    );
    if (!split) return fail(`Claude usage has no cache_creation TTL split (${claude.source})`);
    notes.push(`claude TTL split present (${claude.source})`);
  } else notes.push("claude: no fixture");
  // Codex: does output_tokens include reasoning_output_tokens? total_tokens tells us.
  const rollouts = [
    pf.codexHi ? codexRollout(pf.codexHi.runtimeDir) : undefined,
    fixtureText("preflight-codex-search-rollout.jsonl")?.text,
    fixtureText("preflight-codex-hi-rollout.jsonl")?.text,
    fixtureText("codex-tools-rollout.jsonl")?.text,
  ].filter((x): x is string => !!x);
  let verdict: string | undefined;
  for (const text of rollouts) {
    for (const d of jsonLines(text)) {
      const u = d.type === "token_usage_record" ? d.payload?.usage : undefined;
      if (!u || !(u.reasoning_output_tokens > 0)) continue;
      if (u.total_tokens === u.input_tokens + u.output_tokens) verdict = "INCLUDES reasoning_output_tokens";
      else if (u.total_tokens === u.input_tokens + u.output_tokens + u.reasoning_output_tokens) verdict = "EXCLUDES reasoning_output_tokens";
      if (verdict) break;
    }
    if (verdict) break;
  }
  notes.push(verdict ? `codex output_tokens ${verdict}` : "codex reasoning: inconclusive (no request with reasoning > 0)");
  const missing = !claude && !rollouts.length;
  return missing ? skip("no fixtures yet (run checks 1–3 with secrets)") : pass(notes.join("; "));
}

async function check6(pf: Preflight): Promise<Result> {
  const pricing = loadPricing(pf.cfg.paths.pricing);
  let usage: RequestUsage[];
  let lines: string[];
  let source: string;
  // Prefer a live call: the adapter needs the run's session transcript for final usage.
  if (!pf.claudeHi && hasClaudeToken()) pf.claudeHi = await pf.cli("claude", "claude-hi", "say hi", [], 3);
  if (pf.claudeHi) {
    usage = pf.claudeHi.usage;
    lines = pf.claudeHi.stdout.split("\n");
    source = "live call";
  } else {
    const f = fixtureText("preflight-claude-hi.jsonl", "claude-hi.jsonl");
    if (!f) return skip("no Claude output (needs check 1 or a fixture)");
    source = f.source;
    lines = f.text.split("\n");
    const adapter = getAdapter("claude");
    const parser = adapter.newParser();
    const streamed = new Map<string, RequestUsage>();
    for (const l of lines) for (const e of parser.push(l)) if (e.kind === "usage") streamed.set(e.usage.requestId, e.usage);
    usage = await adapter.finalizeUsage({ runtimeDir: "/nonexistent", streamed: [...streamed.values()], stdoutLines: lines });
  }
  const reported = jsonLines(lines.join("\n")).find((d) => d.type === "result")?.total_cost_usd;
  if (typeof reported !== "number" || reported <= 0) return skip(`no total_cost_usd in ${source}`);
  const computed = usage.reduce((s, u) => s + computeCost(u, pricing).costUsd, 0);
  const diff = Math.abs(computed - reported) / reported;
  const msg = `computed $${computed.toFixed(6)} vs reported $${reported.toFixed(6)} (${(diff * 100).toFixed(2)}%, ${source})`;
  return diff <= 0.01 ? pass(msg) : fail(msg);
}

async function check7(pf: Preflight): Promise<Result> {
  const notes: string[] = [];
  const have = { claude: hasClaudeToken(), codex: existsSync(CODEX_AUTH) };
  for (const rt of ["claude", "codex"] as const) {
    if (!have[rt]) {
      notes.push(`${rt} SKIPPED (no credentials)`);
      continue;
    }
    if (rt === "codex")
      for (const v of ["stock", "lean"]) copyFileSync(CODEX_AUTH, join(pf.agentDirs(`codex-${v}`).runtime, "auth.json"));
    const stock = await pf.cli(rt, `${rt}-stock`, "say hi", [], 3, "stock");
    const lean = await pf.cli(rt, `${rt}-lean`, "say hi", [], 3, "lean");
    saveFixture(`preflight-${rt}-lean.jsonl`, lean.stdout);
    const a = stock.usage[0];
    const b = lean.usage[0];
    if (!a || !b) return fail(`${rt}: missing usage (stock ${stock.usage.length} req, lean ${lean.usage.length} req; exit ${lean.code} ${lastLine(lean.stderr)})`);
    const pa = promptTokens(a);
    const pb = promptTokens(b);
    notes.push(`${rt} stock ${pa} → lean ${pb} tokens (−${((1 - pb / pa) * 100).toFixed(0)}%)`);
  }
  if (!have.claude && !have.codex) return skip("no credentials");
  return pass(`first-request prompt: ${notes.join("; ")}`);
}

async function check8(pf: Preflight): Promise<Result> {
  const agent = piAgent(pf.cfg);
  const key = agent.keyEnv ? process.env[agent.keyEnv]?.trim() : undefined;
  if (!key) return skip(`${agent.keyEnv ?? "the OpenRouter key"} not set in .env`);
  // What a run does at start: fetched prices and pi's models.json entry.
  const setup = await prepareOpenRouter([agent], readFileSync(pf.cfg.paths.pricing, "utf8"));
  writePiModels(pf.agentDirs("pi-hi").runtime, setup.piModels[agent.name]);
  const r = await pf.cli("pi", "pi-hi", "say hi", [], 3);
  saveFixture("preflight-pi-hi.jsonl", r.stdout);
  const end = turnEnd(r);
  if (r.code !== 0 || end?.reason !== "completed" || !r.usage.length)
    return fail(`exit ${r.code}, ${end?.reason ?? "no end"}, ${r.usage.length} request(s): ${end?.detail ?? lastLine(r.stderr)}`);
  const pricing = parsePricing(setup.pricingYaml);
  const computed = r.usage.reduce((s, u) => s + computeCost(u, pricing).costUsd, 0);
  const charged = await generationCosts(r.usage.map((u) => u.requestId), key);
  const theirs = [...charged.values()].reduce((s, v) => s + v.costUsd, 0);
  const via = [...new Set([...charged.values()].map((v) => v.provider ?? "?"))].join(", ");
  return pass(
    `${agent.model}: ${r.usage.length} request(s), computed $${computed.toFixed(6)} (list price) vs charged $${theirs.toFixed(6)} via ${via || "?"} (${charged.size}/${r.usage.length} looked up)`,
  );
}

/**
 * Web search relay (src/search.ts): a relay for a scratch run answers an agent container's `websearch` with a
 * per-wake token, logs the search, and api.exa.ai stays unreachable from the agent. The Exa leg only with EXA_API_KEY.
 */
async function check9(pf: Preflight): Promise<Result> {
  const runId = `preflight-${process.pid}`;
  const dirs = searchDirs(join(pf.root, "search"));
  try {
    await startSearch({ runId, network: pf.cfg.network.name, dir: dirs.base });
    const runtime = pf.agentDirs("searcher").runtime;
    issueSearchToken(dirs, runtime, "searcher", 1);
    const script =
      'websearch "Exa search API pricing" --n 2 >/tmp/out 2>/tmp/err; echo "websearch=$?"; head -c 300 /tmp/out; head -c 300 /tmp/err; ' +
      'curl -s -m 10 -o /dev/null https://api.exa.ai/search; echo "direct=$?"';
    const out = await pf.container("searcher", ["bash", "-c", script], { env: searchEnv(runId), noProxy: [searchHost(runId)] });
    const ws = /websearch=(\d+)/.exec(out.stdout)?.[1];
    const direct = /direct=(\d+)/.exec(out.stdout)?.[1];
    if (direct === undefined || direct === "0") return fail(`an agent container reached api.exa.ai directly (${lastLine(out.stdout)})`);
    const logged = readSearchLog(dirs.logFile, 1);
    if (!logged.length) return fail(`relay logged no search (websearch exit ${ws}: ${lastLine(out.stdout + out.stderr)})`);
    const key = !!process.env.EXA_API_KEY?.trim();
    if (!key) {
      if (ws === "1" && /unavailable/.test(out.stdout)) return pass("relay reachable with a wake token, search logged, Exa unreachable from agents; Exa leg SKIPPED (no EXA_API_KEY)");
      return fail(`expected "search unavailable" without a key (websearch exit ${ws}: ${lastLine(out.stdout)})`);
    }
    const e = logged.at(-1)!;
    if (ws !== "0" || !billed(e)) return fail(`search failed: ${e.error ?? lastLine(out.stdout)}`);
    const ours = searchCost({ model: SEARCH_MODEL, type: e.type, results: e.results, pages: e.pages }, loadPricing(pf.cfg.paths.pricing));
    return pass(`${e.results} result(s) in ${e.latency_ms} ms; cost computed $${ours.toFixed(4)} vs Exa $${e.exa_cost_usd?.toFixed(4) ?? "?"}; Exa unreachable from agents`);
  } finally {
    await stopSearch(runId);
  }
}

const CHECKS: [number, string, (pf: Preflight) => Promise<Result>][] = [
  [1, "Claude in a container (OAuth, --effort)", check1],
  [2, "Codex in a container (auth refresh rotation)", check2],
  [3, "Egress allowlist + web search", check3],
  [4, "Mount isolation", check4],
  [5, "Token-field fixtures", check5],
  [6, "Pricing cross-check (Claude ±1%)", check6],
  [7, "Lean harness overhead (stock vs lean system prompt)", check7],
  [8, "pi + OpenRouter in a container (key, preset, cost cross-check)", check8],
  [9, "Web search relay (token, log, isolation; Exa with EXA_API_KEY)", check9],
];

export async function runPreflight(opts: { swarmPath: string; only?: number[] }): Promise<boolean> {
  const cfg = loadSwarm(opts.swarmPath);
  const selected = CHECKS.filter(([n]) => !opts.only?.length || opts.only.includes(n));
  await ensureAgentImage();
  const img = await imageInfo(AGENT_IMAGE);
  if (!img) {
    console.log(`FAIL  image ${AGENT_IMAGE} not found — run \`just setup\``);
    return false;
  }
  console.log(`image ${AGENT_IMAGE} (claude ${img.claude ?? "?"}, codex ${img.codex ?? "?"}, pi ${img.pi ?? "?"})`);
  await ensureProxy(cfg.network.allowlist);
  const pf = new Preflight(cfg);
  let ok = true;
  for (const [n, title, fn] of selected) {
    let r: Result;
    try {
      r = await fn(pf);
    } catch (e) {
      r = fail(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (r.status === "FAIL") ok = false;
    console.log(`${r.status.padEnd(4)}  ${n}. ${title} — ${r.reason}`);
  }
  return ok;
}

if (import.meta.main) {
  const only = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  const swarm = process.argv.slice(2).find((a) => a.endsWith(".yaml")) ?? "config/swarm.yaml";
  process.exit((await runPreflight({ swarmPath: swarm, only })) ? 0 : 1);
}
