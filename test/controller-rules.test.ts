import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadSwarm, parseSwarm, swarmFromSnapshot } from "../src/config.ts";
import { checkHostFor, hostConfigHash, loadHostConfig, parseHostConfig } from "../src/hostconfig.ts";
import { isDepleted, overLimit, wakeLimit } from "../src/controller/budget.ts";
import { fillSeed, humanDuration, makeRunId, wakeNote } from "../src/controller/run.ts";
import { messagePull, parseNextWake, pickDue, planNextWake } from "../src/controller/scheduler.ts";
import { pricingForModels } from "../src/controller/self-writer.ts";
import { wakeStopAt } from "../src/controller/wake.ts";
import { parsePricing } from "../src/pricing/index.ts";

const MIN = 60_000;
const sched = { maxSleepMs: 15 * MIN, maxConcurrentWakes: 3 };

describe("config", () => {
  test("all shipped swarm configs load", () => {
    for (const f of ["swarm", "smoke"]) {
      const c = loadSwarm(`config/${f}.yaml`);
      expect(c.agents.length).toBeGreaterThan(0);
      expect(checkHostFor(c, loadHostConfig())).toBeNull();
    }
    expect(loadHostConfig().network.allowlist).toContain("api.anthropic.com");
    const smoke = loadSwarm("config/smoke.yaml");
    expect(smoke.agents.map((a) => a.harness)).toEqual(["claude", "codex", "codex", "pi"]);
    expect(smoke.scheduler.maxConcurrentWakes).toBe(4); // defaults to the number of agents
    expect(smoke.budgets.swarmUsd).toBeGreaterThanOrEqual(smoke.agents.length * smoke.budgets.perAgentUsd);
  });

  test("snapshot round-trips", () => {
    const c = loadSwarm("config/swarm.yaml");
    const r = swarmFromSnapshot(c.snapshot);
    expect(r.agents).toEqual(c.agents);
    expect(r.budgets).toEqual(c.budgets);
    expect(r.scheduler).toEqual(c.scheduler);
  });

  const base = () => ({
    run: { name: "t", max_duration_min: 60 },
    agents: ["a1"],
    budgets: { swarm_usd: 1, per_agent_usd: 0.5, per_wake: { max_usd: 0.1, max_turns: 5, timeout_min: 1 } },
    scheduler: { max_sleep_min: 15 },
  });
  const agent = (o: object = {}) => ({ name: "a1", harness: "claude", model: "claude-haiku-5-5", ...o });

  test("validation errors", () => {
    expect(() => parseSwarm(base(), () => agent({ harness: "gemini" }))).toThrow(/harness/);
    // `runtime:` (the old name) still loads, for config snapshots of earlier runs; both at once is an error.
    expect(parseSwarm(base(), () => ({ name: "a1", runtime: "codex", model: "m" })).agents[0]!.harness).toBe("codex");
    expect(() => parseSwarm(base(), () => agent({ runtime: "claude" }))).toThrow(/harness only/);
    expect(() => parseSwarm(base(), () => agent({ name: "Bad Name" }))).toThrow(/name/);
    expect(() => parseSwarm({ ...base(), agents: ["a--b"] }, () => agent({ name: "a--b" }))).toThrow(/--/);
    expect(() => parseSwarm({ ...base(), agents: ["ab-"] }, () => agent({ name: "ab-" }))).toThrow(/name/);
    expect(() => parseSwarm({ ...base(), forge: { poll_s: "soon" } }, () => agent())).toThrow(/forge.poll_s/);
    expect(() => parseSwarm({ ...base(), run: { name: "t" } }, () => agent())).toThrow(/run.max_duration_min/);
    expect(() => parseSwarm({ ...base(), agents: ["a1", "a1"] }, () => agent())).toThrow(/duplicate/);
    expect(() => parseSwarm({ ...base(), scheduler: { max_sleep_min: 120 } }, () => agent())).toThrow(/max_duration/);
    expect(() => parseSwarm({ ...base(), github: { org: "bad org", user: "u" } }, () => agent())).toThrow(/github.org/);
    expect(parseSwarm({ ...base(), github: { org: "o", user: "u" } }, () => agent()).github).toEqual({ org: "o", user: "u" });
    // Old snapshots carry network: and controller.container: (now in host.yaml); they still load.
    expect(parseSwarm({ ...base(), network: { name: "n" }, controller: { container: { cpus: 1 } } }, () => agent()).agents).toHaveLength(1);
    const ok = parseSwarm(base(), () => agent({ budget_usd: 0.25 }));
    expect(ok.agents[0]!.budgetUsd).toBe(0.25);
    expect(ok.agents[0]!.effort).toBe("medium");
    // Optional sections and settings get their defaults.
    expect(ok.forge).toEqual({ image: "codeberg.org/forgejo/forgejo:16.0.4-rootless", port: 3300, pollMs: 15_000 });
    expect(ok.run.worldEndGraceMs).toBe(60_000);
    expect(ok.controller).toEqual({ tickMs: 5000 });
    expect(ok.github).toBeUndefined();
  });
});

describe("host config", () => {
  const host = (allowlist: string[], extra: object = {}) => parseHostConfig({ network: { name: "n", proxy: "http://p:8888", allowlist }, ...extra });
  test("defaults, validation and the applied hash", () => {
    const h = host(["api.anthropic.com"]);
    expect(h.container).toEqual({ cpus: 1, memoryGb: 2, pidsLimit: 256 });
    expect(h.runner).toMatchObject({ watchdogMs: 300_000, hardTimeoutSlackMs: 60_000, homeExcludes: [] });
    expect(() => host(["not a domain"])).toThrow(/invalid domain/);
    expect(() => host(["a.com"], { runner: { home_excludes: ["../x"] } })).toThrow(/home_excludes/);
    expect(() => host(["a.com"], { runner: { watchdog_s: 5 } })).toThrow(/watchdog_s/);
    // The hash covers what the runner applies (allowlist order and case don't matter), not runner limits.
    expect(hostConfigHash(host(["b.com", "A.com"]))).toBe(hostConfigHash(host(["a.com", "b.com"], { runner: { watchdog_s: 60 } })));
    expect(hostConfigHash(host(["a.com"]))).not.toBe(hostConfigHash(host(["a.com", "b.com"])));
  });
  test("the swarm's needs against the allowlist", () => {
    const gh = { agents: [], github: { org: "o", user: "u" } };
    expect(checkHostFor(gh, host(["api.anthropic.com"]))).toMatch(/github.com, githubusercontent.com/);
    expect(checkHostFor(gh, host(["github.com", "githubusercontent.com"]))).toBeNull();
  });
});

describe("scheduler", () => {
  test("parseNextWake", () => {
    expect(parseNextWake(undefined)).toBeUndefined();
    expect(parseNextWake("in_minutes: 30\ncontinue_session: true")).toEqual({ inMinutes: 30, continueSession: true });
    expect(parseNextWake("in_minutes: '45'")).toEqual({ inMinutes: 45, continueSession: false });
    expect(parseNextWake("in_minutes: soon")!.error).toMatch(/in_minutes/);
    expect(parseNextWake(": : :")!.error).toBeDefined();
    expect(parseNextWake("- a\n- b")!.error).toMatch(/mapping/);
  });

  test("planNextWake: max_sleep, or earlier if the agent asked", () => {
    expect(planNextWake(0, undefined, sched)).toEqual({ at: 15 * MIN, trigger: "timer" });
    expect(planNextWake(0, { inMinutes: 0, continueSession: false }, sched)).toEqual({ at: 0, trigger: "self" });
    expect(planNextWake(0, { inMinutes: 7, continueSession: false }, sched)).toEqual({ at: 7 * MIN, trigger: "self" });
    expect(planNextWake(0, { inMinutes: 240, continueSession: false }, sched)).toEqual({ at: 15 * MIN, trigger: "self" });
    expect(planNextWake(0, { continueSession: true, error: "x" }, sched).trigger).toBe("timer");
  });

  test("messagePull: wake now, unless already due", () => {
    expect(messagePull(10 * MIN, { next_wake_at: 15 * MIN })).toBe(10 * MIN);
    expect(messagePull(10 * MIN, { next_wake_at: 10 * MIN })).toBeNull();
    expect(messagePull(10 * MIN, { next_wake_at: null })).toBe(10 * MIN);
  });

  test("pickDue honours status, time and free slots", () => {
    const agents = [
      { name: "a", status: "sleeping", next_wake_at: 5 },
      { name: "b", status: "active", next_wake_at: 1 },
      { name: "c", status: "paused", next_wake_at: 0 },
      { name: "d", status: "depleted", next_wake_at: 0 },
      { name: "e", status: "sleeping", next_wake_at: 100 },
      { name: "f", status: "sleeping", next_wake_at: 2 },
    ];
    expect(pickDue(agents, 10, 0, 3).map((a) => a.name)).toEqual(["b", "f", "a"]);
    expect(pickDue(agents, 10, 2, 3).map((a) => a.name)).toEqual(["b"]);
    expect(pickDue(agents, 10, 3, 3)).toEqual([]);
  });

});

describe("budget", () => {
  test("wakeLimit picks the tightest limit", () => {
    expect(wakeLimit(0.5, 3, 20)).toEqual({ usd: 0.5, reason: "budget_wake" });
    expect(wakeLimit(0.5, 0.2, 20)).toEqual({ usd: 0.2, reason: "budget_agent" });
    expect(wakeLimit(0.5, 3, 0.1)).toEqual({ usd: 0.1, reason: "budget_swarm" });
  });
  test("overLimit and depletion", () => {
    expect(overLimit(0.49, { usd: 0.5, reason: "budget_wake" })).toBeNull();
    expect(overLimit(0.51, { usd: 0.5, reason: "budget_wake" })).toBe("budget_wake");
    expect(isDepleted({ budget_usd: 3, spent_usd: 2.9995 })).toBe(true);
    expect(isDepleted({ budget_usd: 3, spent_usd: 2.9 })).toBe(false);
  });
});

test("run ids are unique even within the same minute", () => {
  const t = Date.UTC(2026, 9, 10, 10, 55);
  const ids = new Set(Array.from({ length: 50 }, () => makeRunId("smoke", t)));
  expect(ids.size).toBeGreaterThan(45);
  expect([...ids][0]).toMatch(/^20261010-1055-smoke-[0-9a-f]{4}$/);
});

describe("prompt + status", () => {
  test("seed placeholders", () => {
    const seed = fillSeed("You are {name}. Forge {forge_url}. Sleep {max_sleep}.\n", { name: "wren", forgeUrl: "http://f:3000", maxSleepMs: 90 * MIN });
    expect(seed).toBe("You are wren. Forge http://f:3000. Sleep 1h 30m.\n");
    expect(humanDuration(45_000)).toBe("45s");
    expect(humanDuration(60 * MIN)).toBe("1h");
    // The shipped seed has no placeholder left once filled, and never mentions the world end.
    const shipped = fillSeed(readFileSync("config/seed.md", "utf8"), { name: "x", forgeUrl: "http://f:3000", maxSleepMs: MIN });
    expect(shipped).not.toMatch(/\{[a-z_]+\}/);
    expect(shipped).not.toMatch(/commons|outbox|inbox|STATUS\.md|world ends|until \d/);
    // Agents are told notifications wake them, so they don't wake just to check.
    expect(shipped).toContain("wakes you sooner");
    // The GitHub line is there only when the run has the outlet.
    expect(shipped).not.toContain("GitHub");
    const withGh = fillSeed(readFileSync("config/seed.md", "utf8"), { name: "x", forgeUrl: "http://f:3000", maxSleepMs: MIN, github: { org: "o", user: "u" } });
    expect(withGh).not.toMatch(/\{[a-z_]+\}/);
    expect(withGh).toContain("github.com/o");
    expect(withGh).toContain("publish what's useful there\nearly");
    expect(withGh).toContain("Sign what you publish as x");
  });

  test("wake note: when, why, budget and limits; unread only when there is some; no world end", () => {
    const base = {
      now: Date.UTC(2026, 9, 10, 12), wakeSeq: 3, trigger: "message", resumed: false, unread: 2,
      budgetUsd: 3, spentUsd: 0.25, wakeLimitUsd: 0.5, maxTurns: 60, stopsAt: Date.UTC(2026, 9, 10, 12, 15),
    };
    expect(wakeNote(base)).toBe(
      [
        "[Wake 3 at 2026-10-10T12:00:00Z (UTC): new forge notifications.",
        "Unread forge notifications: 2 (`tea notifications ls --mine`).",
        "Budget: $2.7500 left of $3.0000.",
        "This wake is stopped if it spends over $0.5000, makes 60 turns, or is still running at 2026-10-10T12:15:00Z.",
        "Past wakes' costs: /self/usage.jsonl. Prices: /self/pricing.yaml.]",
      ].join("\n"),
    );
    const first = wakeNote({ ...base, wakeSeq: 1, trigger: "initial", unread: 0 });
    expect(first).toStartWith("[Wake 1 at 2026-10-10T12:00:00Z (UTC): your first wake.");
    expect(first).not.toContain("Unread");
    expect(first).not.toContain("world");
    expect(wakeNote({ ...base, trigger: "self", resumed: true })).toContain(": the time you chose, continuing your previous session.");
  });

  test("wakeStopAt: per-wake timeout, or the world end + grace, whichever is first", () => {
    const end = 60 * MIN;
    expect(wakeStopAt(0, 10 * MIN, end, MIN)).toEqual({ at: 10 * MIN, atWorldEnd: false });
    expect(wakeStopAt(55 * MIN, 10 * MIN, end, MIN)).toEqual({ at: 61 * MIN, atWorldEnd: true });
    expect(wakeStopAt(51 * MIN, 10 * MIN, end, MIN)).toEqual({ at: 61 * MIN, atWorldEnd: false }); // tie: the timeout
    expect(wakeStopAt(59 * MIN, 10 * MIN, end, 0)).toEqual({ at: 60 * MIN, atWorldEnd: true });
  });
});

describe("pricingForModels (/self/pricing.yaml)", () => {
  const full = readFileSync("config/pricing.yaml", "utf8");
  const header = full.slice(0, full.indexOf("models:"));
  const names = (y: string) => Object.keys(parsePricing(y).models).sort();

  test("an agent on one model sees only that model, with the header and its comments", () => {
    const y = pricingForModels(full, ["gpt-6-luna"]);
    expect(names(y)).toEqual(["gpt-6-luna"]);
    expect(y).toStartWith(header);
    expect(y).toContain("# Source: developers.openai.com");
    expect(y).not.toContain("claude-haiku-5-5");
    expect(parsePricing(y).models["gpt-6-luna"]).toEqual(parsePricing(full).models["gpt-6-luna"]!);
  });

  test("extra billed models are included; unknown models are omitted", () => {
    expect(names(pricingForModels(full, ["claude-haiku-5-5", "gpt-6-luna", "mystery"]))).toEqual(["claude-haiku-5-5", "gpt-6-luna"]);
    // No known model at all (can't happen for a real agent: its configured model is costed) -> empty map.
    const none = pricingForModels(full, ["mystery"]);
    expect(Bun.YAML.parse(none)).toEqual({ models: {} });
    expect(none).toStartWith(header);
  });

  test("relay search prices only for agents that may search; the section and its comments go otherwise", () => {
    const without = pricingForModels(full, ["gpt-6-luna"]);
    expect((Bun.YAML.parse(without) as Record<string, unknown>).search).toBeUndefined();
    expect(without).not.toContain("Web search through the run's relay");
    const withSearch = pricingForModels(full, ["gpt-6-luna", "exa-search"]);
    expect(parsePricing(withSearch).search["exa-search"]).toEqual(parsePricing(full).search["exa-search"]!);
    expect(withSearch).toContain("# Web search through the run's relay");
    expect(names(withSearch)).toEqual(["gpt-6-luna"]);
  });

  test("falls back to re-emitted YAML (header kept) when the layout can't be filtered as text", () => {
    const flow = "# units: USD/Mtok\nmodels: {a: {per_mtok: {input: 1, output: 2, cache_read: 0.1}}, b: {per_mtok: {input: 3, output: 4, cache_read: 0.3}}}\n";
    const y = pricingForModels(flow, ["b"]);
    expect(y).toStartWith("# units: USD/Mtok\n");
    expect(names(y)).toEqual(["b"]);
    expect(parsePricing(y).models.b!.perMtok.output).toBe(4);
  });
});
