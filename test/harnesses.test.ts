import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCost, loadPricing, sumUsage } from "../src/pricing/index.ts";
import { getAdapter } from "../src/harnesses/index.ts";
import type { AgentEvent, RequestUsage, HarnessAdapter } from "../src/types.ts";

const FX = join(import.meta.dir, "fixtures");
const pricing = loadPricing(join(import.meta.dir, "..", "config", "pricing.yaml"));
const lines = (f: string) => readFileSync(join(FX, f), "utf8").split("\n").filter(Boolean);

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "slopswarm-rt-"));
  tmpDirs.push(d);
  return d;
}

/** Mimics the controller: feed every line, keep the last usage per requestId in first-seen order. */
function run(adapter: HarnessAdapter, stdout: string[], model?: string) {
  const parser = adapter.newParser({ model });
  const events: AgentEvent[] = [];
  const streamed = new Map<string, RequestUsage>();
  for (const l of stdout) {
    for (const e of parser.push(l)) {
      events.push(e);
      if (e.kind === "usage") streamed.set(e.usage.requestId, e.usage);
    }
  }
  return { events, streamed: [...streamed.values()] };
}

describe("claude adapter", () => {
  const claude = getAdapter("claude");

  test("WebSearch's hidden model calls are billed via modelUsage (real container run)", async () => {
    // Claude Code's WebSearch tool makes its own model calls; they are in modelUsage but never streamed.
    const stdout = lines("preflight-claude-search.jsonl");
    const result = stdout.map((l) => JSON.parse(l)).find((d) => d.type === "result");
    const { streamed } = run(claude, stdout);
    const final = await claude.finalizeUsage({ runtimeDir: tmp(), sessionId: result.session_id, streamed, stdoutLines: stdout });
    const extra = final.find((u) => u.requestId === "unattributed:claude-haiku-5-5")!;
    expect(extra.webSearches).toBe(1);
    expect(extra.freshInput).toBeGreaterThan(10_000);
    const cost = final.reduce((s, u) => s + computeCost(u, pricing).costUsd, 0);
    expect(Math.abs(cost / result.total_cost_usd - 1)).toBeLessThan(0.01);
    // Nothing is added when the stream already accounts for everything.
    const hi = lines("claude-hi.jsonl");
    const hiFinal = await claude.finalizeUsage({ runtimeDir: tmp(), streamed: run(claude, hi).streamed, stdoutLines: hi });
    expect(hiFinal.some((u) => u.requestId.startsWith("unattributed:"))).toBe(false);
  });

  test("resumed session: modelUsage is cumulative, so the previous wake is the baseline (real run)", async () => {
    // Real smoke run, bramble wake 1 (fresh) and wake 2 (--resume of the same session).
    const wake1 = lines("claude-resume-wake1.jsonl");
    const wake2 = lines("claude-resume-wake2.jsonl");
    const result2 = wake2.map((l) => JSON.parse(l)).find((d) => d.type === "result");
    const result1 = wake1.map((l) => JSON.parse(l)).find((d) => d.type === "result");
    expect(result2.session_id).toBe(result1.session_id);
    const costOf = (us: RequestUsage[]) => us.reduce((s, u) => s + computeCost(u, pricing).costUsd, 0);
    // No session transcript here, so streamed output stays partial and the gap lands in "unattributed";
    // the totals are what matter.
    const unattributed = (us: RequestUsage[]) => us.find((u) => u.requestId.startsWith("unattributed:"));

    const first = await claude.finalizeUsage({ runtimeDir: tmp(), sessionId: result1.session_id, streamed: run(claude, wake1).streamed, stdoutLines: wake1 });
    expect(unattributed(first)).toMatchObject({ cacheRead: 0, cacheWrite1h: 0 });
    expect(Math.abs(costOf(first) / result1.total_cost_usd - 1)).toBeLessThan(0.01);

    // Without the baseline the whole of wake 1 is billed again as "unattributed".
    const naive = await claude.finalizeUsage({ runtimeDir: tmp(), sessionId: result2.session_id, streamed: run(claude, wake2).streamed, stdoutLines: wake2 });
    expect(unattributed(naive)!.cacheRead).toBe(result1.modelUsage["claude-haiku-5-5"].cacheReadInputTokens);
    expect(costOf(naive)).toBeGreaterThan(result1.total_cost_usd);

    const second = await claude.finalizeUsage({
      runtimeDir: tmp(), sessionId: result2.session_id, streamed: run(claude, wake2).streamed, stdoutLines: wake2, previousWakeStdoutLines: wake1,
    });
    expect(unattributed(second)).toMatchObject({ cacheRead: 0, cacheWrite1h: 0, reasoning: 0 });
    // This wake's own usage equals the result's per-invocation `usage` (no hidden calls happened here).
    expect(second.reduce((s, u) => s + u.cacheRead, 0)).toBe(result2.usage.cache_read_input_tokens);
    expect(second.reduce((s, u) => s + u.cacheWrite1h, 0)).toBe(result2.usage.cache_creation_input_tokens);
    expect(second.reduce((s, u) => s + u.output, 0)).toBe(result2.usage.output_tokens);
    // total_cost_usd is cumulative too: this wake's share is the difference.
    expect(Math.abs(costOf(second) / (result2.total_cost_usd - result1.total_cost_usd) - 1)).toBeLessThan(0.01);
  });

  test("buildCommand: lean harness swaps the system prompt and limits tools", () => {
    const argv = claude.buildCommand({ prompt: "[Wake at …]", model: "m", effort: "medium", maxTurns: 5, systemPrompt: { text: "You are bramble.", file: "/x" } });
    expect(argv[argv.indexOf("--system-prompt") + 1]).toBe("You are bramble.");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Bash,Read,Write,Edit,WebSearch");
    expect(argv[argv.indexOf("-p") + 1]).toBe("[Wake at …]");
    expect(claude.buildCommand({ prompt: "hi", model: "m", effort: "medium", maxTurns: 5 })).not.toContain("--system-prompt");
  });

  test("buildCommand: on the relay (nativeSearch false) WebSearch is off, lean or stock", () => {
    const lean = claude.buildCommand({ prompt: "hi", model: "m", effort: "medium", maxTurns: 5, systemPrompt: { text: "s", file: "/x" }, nativeSearch: false });
    expect(lean[lean.indexOf("--tools") + 1]).toBe("Bash,Read,Write,Edit");
    expect(lean).not.toContain("--disallowedTools");
    const stock = claude.buildCommand({ prompt: "hi", model: "m", effort: "medium", maxTurns: 5, nativeSearch: false });
    expect(stock[stock.indexOf("--disallowedTools") + 1]).toBe("WebSearch");
    expect(claude.searchModes).toEqual(["native", "relay"]);
  });

  test("buildCommand", () => {
    const argv = claude.buildCommand({ prompt: "hi", model: "claude-haiku-5-5", effort: "medium", maxTurns: 60 });
    expect(argv).toEqual([
      "claude", "-p", "hi", "--model", "claude-haiku-5-5", "--effort", "medium", "--output-format", "stream-json", "--verbose",
      "--max-turns", "60", "--dangerously-skip-permissions", "--strict-mcp-config", "--setting-sources", "", "--thinking-display", "summarized",
    ]);
    const resumed = claude.buildCommand({ prompt: "hi", model: "m", effort: "low", maxTurns: 5, resumeSessionId: "abc" });
    expect(resumed.slice(-2)).toEqual(["--resume", "abc"]);
    expect(claude.containerEnv("/runtime")).toEqual({ CLAUDE_CONFIG_DIR: "/runtime" });
  });

  test("parses the real say-hi fixture", async () => {
    const stdout = lines("claude-hi.jsonl");
    const { events, streamed } = run(claude, stdout);
    const session = events.find((e) => e.kind === "session");
    expect(session).toMatchObject({ kind: "session", sessionId: "103171c0-2e8b-48a0-b379-0d9a0197c878", info: { apiKeySource: "none", claude_code_version: "2.1.296" } });
    expect(events.filter((e) => e.kind === "message")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: "turn_end", reason: "completed", numTurns: 1, reportedCostUsd: 0.0013900700000000002 });

    // Streamed usage is partial (5 output tokens); finalize takes the result's iterations (38).
    expect(streamed).toHaveLength(1);
    expect(streamed[0]!.output).toBe(5);
    const final = await claude.finalizeUsage({ runtimeDir: tmp(), streamed, stdoutLines: stdout });
    expect(final).toEqual([
      {
        requestId: "msg_011CftH3P9jmhzAUxgBGNJVb", model: "claude-haiku-5-5", freshInput: 2, cacheRead: 11447, cacheWrite5m: 0, cacheWrite1h: 6282,
        output: 38, reasoning: 0, webSearches: 0, ts: "2026-10-10T08:56:05.829Z",
      },
    ]);
    const cost = computeCost(final[0]!, pricing).costUsd;
    expect(Math.abs(cost - 0.0013900700000000002) / 0.00139007).toBeLessThan(0.01);
  });

  test("parses tool calls, dedupes partial usage, finalizes from iterations", async () => {
    const stdout = lines("claude-tools.synthetic.jsonl");
    const { events, streamed } = run(claude, stdout);
    expect(events.filter((e) => e.kind === "tool_call")).toEqual([
      { kind: "tool_call", id: "toolu_1", name: "Bash", args: '{"command":"ls -la /commons","description":"List commons"}' },
      { kind: "tool_call", id: "toolu_2", name: "Write", args: '{"file_path":"/self/notes.md","content":"hello"}' },
    ]);
    const results = events.filter((e) => e.kind === "tool_result");
    expect(results.map((r) => r.kind === "tool_result" && [r.id, r.ok])).toEqual([["toolu_1", true], ["toolu_2", false]]);
    expect(streamed.map((u) => u.requestId)).toEqual(["msg_A", "msg_B", "msg_C"]);

    const final = await claude.finalizeUsage({ runtimeDir: tmp(), streamed, stdoutLines: stdout });
    expect(final.map((u) => u.output)).toEqual([80, 60, 40]);
    expect(final.map((u) => u.requestId)).toEqual(["msg_A", "msg_B", "msg_C"]);
    // Result-level web search + thinking land on the last request.
    expect(final[2]).toMatchObject({ webSearches: 1, reasoning: 12 });
    const total = final.reduce((s, u) => s + computeCost(u, pricing).costUsd, 0);
    expect(total).toBeCloseTo(0.01185701, 8);
  });

  test("killed wake (no result line) falls back to streamed usage", async () => {
    const stdout = lines("claude-tools.synthetic.jsonl").slice(0, -1);
    const { streamed } = run(claude, stdout);
    const final = await claude.finalizeUsage({ runtimeDir: tmp(), streamed, stdoutLines: stdout });
    expect(final.map((u) => u.output)).toEqual([3, 7, 2]);
  });

  test("iteration count mismatch falls back to streamed", async () => {
    const stdout = lines("claude-tools.synthetic.jsonl");
    const { streamed } = run(claude, stdout);
    const final = await claude.finalizeUsage({ runtimeDir: tmp(), streamed: streamed.slice(0, 2), stdoutLines: stdout });
    expect(final.slice(0, 2).map((u) => u.output)).toEqual([3, 7]);
    // What the streamed requests miss is still billed, as one unattributed request.
    expect(final[2]!.requestId).toBe("unattributed:claude-haiku-5-5");
    expect(final.reduce((s, u) => s + u.output, 0)).toBe(180);
  });

  test("max turns and garbage lines", () => {
    const { events } = run(claude, ["not json", "", "{bad", ...lines("claude-maxturns.synthetic.jsonl")]);
    expect(events).toEqual([{ kind: "turn_end", reason: "max_turns", numTurns: 60, reportedCostUsd: 0.05, detail: "error_max_turns" }]);
  });

  test("cache_creation without TTL split counts as 1h", () => {
    const line = JSON.stringify({ type: "assistant", message: { id: "m1", model: "x", content: [], usage: { input_tokens: 1, cache_creation_input_tokens: 9, output_tokens: 1 } } });
    const { streamed } = run(claude, [line]);
    expect(streamed[0]).toMatchObject({ cacheWrite1h: 9, cacheWrite5m: 0 });
  });

  test("empty iterations (container build): final usage comes from the session transcript", async () => {
    // Real pre-flight output (frozen copy): the stream says output 5, the result says 58, iterations is [].
    const stdout = lines("claude-empty-iterations.jsonl");
    const result = stdout.map((l) => JSON.parse(l)).find((d) => d.type === "result");
    const msg = stdout.map((l) => JSON.parse(l)).find((d) => d.type === "assistant");
    expect(result.usage.iterations).toEqual([]);
    const { streamed } = run(getAdapter("claude"), stdout);
    expect(streamed[0]!.output).toBe(5);
    const runtimeDir = tmp();
    mkdirSync(join(runtimeDir, "projects", "-home-agent"), { recursive: true });
    const transcript = { type: "assistant", message: { ...msg.message, usage: { ...result.usage, iterations: [] } } };
    writeFileSync(join(runtimeDir, "projects", "-home-agent", `${result.session_id}.jsonl`), JSON.stringify(transcript) + "\n");
    const final = await getAdapter("claude").finalizeUsage({ runtimeDir, sessionId: result.session_id, streamed, stdoutLines: stdout });
    expect(final).toHaveLength(1);
    expect(final[0]!.output).toBe(58);
    const cost = final.reduce((s, u) => s + computeCost(u, pricing).costUsd, 0);
    expect(Math.abs(cost / result.total_cost_usd - 1)).toBeLessThan(0.01);
  });
});

describe("codex adapter", () => {
  const codex = getAdapter("codex");
  const TOOLS_ID = "01a12507-ce95-78c3-b3f2-69fa7cb10ea0";

  function runtimeWithRollout(fixture: string, sid: string) {
    const dir = tmp();
    const d = join(dir, "sessions", "2026", "10", "10");
    mkdirSync(d, { recursive: true });
    copyFileSync(join(FX, fixture), join(d, `rollout-2026-10-10T09-57-14-${sid}.jsonl`));
    return dir;
  }

  test("buildCommand: new and resume (flags after the resume subcommand)", () => {
    const fresh = codex.buildCommand({ prompt: "hi", model: "gpt-6-luna", effort: "medium", maxTurns: 60 });
    expect(fresh).toEqual([
      "codex", "exec", "--json", "--skip-git-repo-check", "-m", "gpt-6-luna", "-c", "model_reasoning_effort=medium",
      "--dangerously-bypass-approvals-and-sandbox", "-c", 'web_search="live"', "-c", 'model_reasoning_summary="auto"', "hi",
    ]);
    const resumed = codex.buildCommand({ prompt: "hi", model: "gpt-6-luna", effort: "medium", maxTurns: 60, resumeSessionId: "T1" });
    expect(resumed.slice(0, 4)).toEqual(["codex", "exec", "resume", "--json"]);
    expect(resumed.slice(-2)).toEqual(["T1", "hi"]);
    expect(codex.containerEnv("/runtime")).toEqual({ CODEX_HOME: "/runtime" });
  });

  test("buildCommand: lean harness replaces the base instructions (also on resume)", () => {
    const sp = { text: "You are wren.", file: "/runtime/system-prompt.md" };
    for (const resumeSessionId of [undefined, "T1"]) {
      const argv = codex.buildCommand({ prompt: "[Wake at …]", model: "gpt-6-luna", effort: "medium", maxTurns: 60, resumeSessionId, systemPrompt: sp });
      expect(argv).toContain("--strict-config");
      expect(argv).toContain('model_instructions_file="/runtime/system-prompt.md"');
      expect(argv).toContain("include_environment_context=false");
      expect(argv[argv.indexOf("multi_agent") - 1]).toBe("--disable");
      expect(argv.at(-1)).toBe("[Wake at …]");
      if (resumeSessionId) expect(argv.at(-2)).toBe("T1");
    }
  });

  test("buildCommand: on the relay (nativeSearch false) Codex's web search is disabled, also on resume", () => {
    for (const resumeSessionId of [undefined, "T1"]) {
      const argv = codex.buildCommand({ prompt: "hi", model: "gpt-6-luna", effort: "medium", maxTurns: 60, resumeSessionId, nativeSearch: false });
      expect(argv).toContain('web_search="disabled"');
      expect(argv).not.toContain('web_search="live"');
    }
    expect(codex.searchModes).toEqual(["native", "relay"]);
  });

  test("parses the say-hi stream and normalises input (input includes cached)", () => {
    const { events, streamed } = run(codex, lines("codex-hi.jsonl"), "gpt-6-luna");
    expect(events[0]).toEqual({ kind: "session", sessionId: "01a12507-767d-7fb1-bfb5-ede93d67f174" });
    expect(events.find((e) => e.kind === "message")).toEqual({ kind: "message", role: "assistant", text: "Hi!" });
    expect(streamed).toEqual([
      { requestId: "turn-1", model: "gpt-6-luna", freshInput: 19407 - 12032, cacheRead: 12032, cacheWrite5m: 0, cacheWrite1h: 0, output: 6, reasoning: 0, webSearches: 0, ts: undefined },
    ]);
    expect(events.at(-1)).toEqual({ kind: "turn_end", reason: "completed", numTurns: 1 });
  });

  test("finalizeUsage: per-request rollout records sum to the turn totals", async () => {
    const stdout = lines("codex-tools.jsonl");
    const { streamed } = run(codex, stdout, "gpt-6-luna");
    const dir = runtimeWithRollout("codex-tools-rollout.jsonl", TOOLS_ID);
    const final = await codex.finalizeUsage({ runtimeDir: dir, sessionId: TOOLS_ID, streamed, stdoutLines: stdout });
    expect(final).toHaveLength(4);
    expect(final[0]!.requestId).toBe("resp_0c58145b1ffcdb8a016ac9fde8f4f48191a01ed7bca23d7f25");
    expect(final.every((u) => u.model === "gpt-6-luna")).toBe(true);
    const sum = sumUsage(final);
    const turn = sumUsage(streamed);
    expect(sum.freshInput).toBe(turn.freshInput);
    expect(sum.cacheRead).toBe(54272);
    expect(sum.freshInput + sum.cacheRead).toBe(64357);
    expect(sum.output).toBe(201);
    expect(sum.reasoning).toBe(25);
  });

  test("finalizeUsage only counts records from this wake (resumed thread)", async () => {
    const dir = runtimeWithRollout("codex-tools-rollout.jsonl", TOOLS_ID);
    const final = await codex.finalizeUsage({
      runtimeDir: dir, sessionId: TOOLS_ID, streamed: [], stdoutLines: [], wakeStartedAt: Date.parse("2026-10-10T08:58:00Z"),
    });
    expect(final.map((u) => u.output)).toEqual([68, 26]);
  });

  test("finalizeUsage falls back to token_count, then to streamed", async () => {
    const dir = tmp();
    const d = join(dir, "sessions", "2026", "10", "10");
    mkdirSync(d, { recursive: true });
    const noRecords = lines("codex-tools-rollout.jsonl").filter((l) => !l.includes('"type":"token_usage_record"'));
    writeFileSync(join(d, `rollout-x-${TOOLS_ID}.jsonl`), noRecords.join("\n"));
    const viaCounts = await codex.finalizeUsage({ runtimeDir: dir, sessionId: TOOLS_ID, streamed: [], stdoutLines: [] });
    expect(viaCounts.map((u) => u.output)).toEqual([65, 42, 68, 26]);

    const { streamed } = run(codex, lines("codex-hi.jsonl"), "gpt-6-luna");
    const fallback = await codex.finalizeUsage({ runtimeDir: tmp(), sessionId: "nope", streamed, stdoutLines: [] });
    expect(fallback).toEqual(streamed);
  });

  test("streamed fallback subtracts the previous wake's thread-cumulative turn usage", async () => {
    const stdout = lines("codex-hi.jsonl");
    const { streamed } = run(codex, stdout, "gpt-6-luna");
    // Resumed thread, no rollout found: the same turn totals as the previous wake means nothing new was used.
    const final = await codex.finalizeUsage({ runtimeDir: tmp(), sessionId: "nope", streamed, stdoutLines: stdout, previousWakeStdoutLines: stdout });
    expect(final).toHaveLength(1);
    expect(sumUsage(final)).toMatchObject({ freshInput: 0, cacheRead: 0, output: 0 });
    const fresh = await codex.finalizeUsage({ runtimeDir: tmp(), sessionId: "nope", streamed, stdoutLines: stdout });
    expect(fresh).toEqual(streamed);
  });

  test("tool items become tool_call/tool_result; failures and errors map correctly", () => {
    const stdout = [
      JSON.stringify({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "bash -lc ls", status: "in_progress" } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "bash -lc ls", aggregated_output: "a\nb", exit_code: 0, status: "completed" } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "web_search", query: "weather budapest" } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_3", type: "command_execution", command: "false", aggregated_output: "", exit_code: 1, status: "failed" } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_4", type: "reasoning", text: "hmm" } }),
      JSON.stringify({ type: "turn.failed", error: { message: "boom" } }),
    ];
    const { events } = run(codex, stdout, "gpt-6-luna");
    expect(events).toEqual([
      { kind: "tool_call", id: "item_1", name: "command_execution", args: "bash -lc ls" },
      { kind: "tool_result", id: "item_1", ok: true, summary: "a\nb" },
      { kind: "tool_call", id: "item_2", name: "web_search", args: "weather budapest" },
      { kind: "tool_result", id: "item_2", ok: true, summary: "" },
      { kind: "tool_call", id: "item_3", name: "command_execution", args: "false" },
      { kind: "tool_result", id: "item_3", ok: false, summary: "" },
      { kind: "reasoning", text: "hmm" },
      { kind: "turn_end", reason: "error", numTurns: 0, detail: "boom" },
    ]);
  });

});

describe("pi adapter", () => {
  const pi = getAdapter("pi");
  const PRESET = "z-ai/glm-5.3-flash@preset/sw-glm-5-3-flash";
  const SID = "pi-fixture-1";

  function runtimeWithSession() {
    const dir = tmp();
    mkdirSync(join(dir, "sessions"), { recursive: true });
    copyFileSync(join(FX, "pi-session.jsonl"), join(dir, "sessions", `2026-10-11T21-29-34-942Z_${SID}.jsonl`));
    return dir;
  }

  test("buildCommand: lean harness, OpenRouter model string passed literally, resume by session id", () => {
    const sp = { text: "You are fern.", file: "/runtime/system-prompt.md" };
    const fresh = pi.buildCommand({ prompt: "[Wake 1 …]", model: PRESET, effort: "low", maxTurns: 60, systemPrompt: sp });
    expect(fresh.slice(0, 9)).toEqual(["pi", "--mode", "json", "--provider", "openrouter", "--model", PRESET, "--thinking", "low"]);
    expect(fresh[fresh.indexOf("--system-prompt") + 1]).toBe("/runtime/system-prompt.md");
    expect(fresh[fresh.indexOf("--session-dir") + 1]).toBe("/runtime/sessions");
    expect(fresh[fresh.indexOf("--tools") + 1]).toBe("read,bash,edit,write");
    for (const f of ["--no-context-files", "--no-extensions", "--no-mcp", "--no-skills", "--offline"]) expect(fresh).toContain(f);
    expect(fresh).not.toContain("--session-id");
    expect(fresh.slice(-2)).toEqual(["--", "[Wake 1 …]"]);
    const resumed = pi.buildCommand({ prompt: "hi", model: PRESET, effort: "low", maxTurns: 60, resumeSessionId: SID });
    expect(resumed[resumed.indexOf("--session-id") + 1]).toBe(SID);
    expect(pi.containerEnv("/runtime")).toMatchObject({ PI_CODING_AGENT_DIR: "/runtime/pi", PI_OFFLINE: "1", PI_TELEMETRY: "0" });
    expect(pi.maxTurnsBy).toBe("turns");
    expect(pi.searchModes).toEqual(["relay"]);
  });

  test("parses the real say-hi stream: one request priced as the slug before @ (input excludes cache)", async () => {
    const stdout = lines("pi-hi.jsonl");
    const { events, streamed } = run(pi, stdout, PRESET);
    expect(events[0]).toMatchObject({ kind: "session", sessionId: SID });
    expect(events.filter((e) => e.kind === "turn_start")).toEqual([{ kind: "turn_start", n: 1 }]);
    expect(events.some((e) => e.kind === "reasoning")).toBe(true);
    expect(events.find((e) => e.kind === "message")).toMatchObject({ role: "assistant" });
    expect(streamed).toEqual([
      { requestId: "gen-1791754175-7XX88bo8xF7c2YEBkz9E", model: "z-ai/glm-5.3-flash", freshInput: 1147, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 178, reasoning: 114, webSearches: 0, ts: "2026-10-11T21:29:34.996Z" },
    ]);
    expect(events.at(-1)).toEqual({ kind: "turn_end", reason: "completed", numTurns: 1, detail: undefined });
    // Without the session file, the stream is final.
    expect(await pi.finalizeUsage({ runtimeDir: tmp(), sessionId: SID, streamed, stdoutLines: stdout })).toEqual(streamed);
  });

  test("resumed wake with a tool call: tool events, implicit cache reads, session file limited to this wake", async () => {
    const stdout = lines("pi-resume-wake2.jsonl");
    const { events, streamed } = run(pi, stdout, PRESET);
    expect(events.filter((e) => e.kind === "turn_start")).toHaveLength(2);
    const call = events.find((e) => e.kind === "tool_call") as Extract<AgentEvent, { kind: "tool_call" }>;
    expect(call).toMatchObject({ name: "bash", args: JSON.stringify({ command: "echo hello > note.txt && cat note.txt" }) });
    expect(events.find((e) => e.kind === "tool_result")).toEqual({ kind: "tool_result", id: call.id, ok: true, summary: "hello\n" });
    expect(streamed.map((u) => [u.freshInput, u.cacheRead, u.output])).toEqual([[585, 768, 19], [34, 1344, 3]]);

    const dir = runtimeWithSession();
    // The session file holds both wakes; only records from this wake count.
    const all = await pi.finalizeUsage({ runtimeDir: dir, sessionId: SID, streamed: [], stdoutLines: [] });
    expect(all.map((u) => u.requestId)).toEqual(["gen-1791754175-7XX88bo8xF7c2YEBkz9E", ...streamed.map((u) => u.requestId)]);
    const wake2 = await pi.finalizeUsage({ runtimeDir: dir, sessionId: SID, streamed, stdoutLines: stdout, wakeStartedAt: Date.parse("2026-10-11T21:29:45Z") });
    expect(wake2.map(({ ts: _ts, ...u }) => u)).toEqual(streamed.map(({ ts: _ts, ...u }) => u));
    // Resumed within the clock slack of the previous wake's last request: its billed ids are skipped.
    const quick = { runtimeDir: dir, sessionId: SID, streamed, stdoutLines: stdout, wakeStartedAt: Date.parse("2026-10-11T21:29:38Z") };
    expect((await pi.finalizeUsage(quick)).map((u) => u.requestId)).toContain("gen-1791754175-7XX88bo8xF7c2YEBkz9E");
    const billed = new Set(["gen-1791754175-7XX88bo8xF7c2YEBkz9E"]);
    expect((await pi.finalizeUsage({ ...quick, billedRequestIds: billed })).map((u) => u.requestId)).toEqual(streamed.map((u) => u.requestId));
  });

  test("failed requests: pi exits 0, but the wake ends in error with no billable usage (real run)", () => {
    // The custom-id fallback sent max_tokens the provider rejected; pi retried three times and gave up.
    const { events, streamed } = run(pi, lines("pi-error.jsonl"), PRESET);
    expect(streamed.every((u) => u.freshInput + u.output === 0)).toBe(true);
    expect(events.some((e) => e.kind === "message" && e.role === "user" && e.text.startsWith("[pi error] 400"))).toBe(true);
    const end = events.at(-1) as Extract<AgentEvent, { kind: "turn_end" }>;
    expect(end.reason).toBe("error");
    expect(end.detail).toContain("400");
  });

  test("compaction usage counts as a request; cache writes split by TTL; garbage is ignored", async () => {
    const usage = { input: 100, output: 10, cacheRead: 50, cacheWrite: 30, cacheWrite1h: 20, reasoning: 4, totalTokens: 190 };
    const stdout = [
      "not json",
      JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/home/agent" }),
      JSON.stringify({ type: "compaction_end", reason: "threshold", result: { summary: "…", usage }, aborted: false, willRetry: false }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], model: PRESET, usage, stopReason: "stop" } }),
      JSON.stringify({ type: "agent_settled", aborted: false }),
    ];
    const { events, streamed } = run(pi, stdout, PRESET);
    expect(streamed.map((u) => u.requestId)).toEqual(["compaction-1", "pi-1"]);
    expect(streamed[0]).toMatchObject({ model: "z-ai/glm-5.3-flash", freshInput: 100, cacheRead: 50, cacheWrite5m: 10, cacheWrite1h: 20, output: 10, reasoning: 4 });
    expect(events.at(-1)).toMatchObject({ kind: "turn_end", reason: "completed", numTurns: 0 });

    // The session file's compaction entry replaces the streamed one; other streamed requests are kept.
    const dir = tmp();
    mkdirSync(join(dir, "sessions"));
    writeFileSync(
      join(dir, "sessions", "2026-10-11T00-00-00-000Z_s1.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-10-11T00:00:00.000Z" }),
        JSON.stringify({ type: "compaction", id: "c0ffee00", timestamp: "2026-10-11T00:00:01.000Z", summary: "…", firstKeptEntryId: "x", tokensBefore: 1, usage }),
      ].join("\n"),
    );
    const final = await pi.finalizeUsage({ runtimeDir: dir, sessionId: "s1", streamed, stdoutLines: stdout });
    expect(final.map((u) => u.requestId)).toEqual(["compaction:c0ffee00", "pi-1"]);
  });
});

describe("reasoning summaries (real container output)", () => {
  test("claude: --thinking-display summarized yields reasoning events", () => {
    const { events } = run(getAdapter("claude"), lines("claude-thinking-summary.jsonl"));
    const r = events.filter((e) => e.kind === "reasoning");
    expect(r.length).toBeGreaterThan(0);
    expect((r[0] as { text: string }).text.length).toBeGreaterThan(50);
    // Thinking blocks with an empty text (display omitted) produce nothing.
    const omitted = JSON.stringify({ type: "assistant", message: { id: "m", model: "claude-haiku-5-5", content: [{ type: "thinking", thinking: "", signature: "s" }] } });
    expect(getAdapter("claude").newParser().push(omitted).filter((e) => e.kind === "reasoning")).toEqual([]);
  });

  test("codex: model_reasoning_summary yields reasoning events", () => {
    const { events } = run(getAdapter("codex"), lines("codex-reasoning-summary.jsonl"), "gpt-6-luna");
    expect(events.filter((e) => e.kind === "reasoning")).toEqual([{ kind: "reasoning", text: "**Defining reliability criteria**\n**Setting reliability weights**" }]);
    expect(events.some((e) => e.kind === "message")).toBe(true);
  });

  test("codex: error items are notices, not tool calls", () => {
    const p = getAdapter("codex").newParser({ model: "gpt-6-luna" });
    const ev = p.push(JSON.stringify({ type: "item.completed", item: { id: "i0", type: "error", message: "ignoring 1 setting" } }));
    expect(ev).toEqual([{ kind: "message", role: "user", text: "[codex notice] ignoring 1 setting" }]);
  });
});
