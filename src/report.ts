// Markdown cost summary for a run (plan §12).
import type { Database } from "bun:sqlite";
import type { AgentRow, RequestRow, RunRow, WakeRow } from "./db/index.ts";
import { billed, readSearchLog, runSearchDirs, SEARCH_MODEL } from "./search.ts";
import { fetched, readFetchLog, type FetchLogEntry } from "./webfetch.ts";
import { describeExtension, extensionsOf, swarmBudgetUsd, worldGaps, worldTime } from "./world.ts";

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}
const median = (xs: number[]) => quantile(xs, 0.5);

const $ = (v: number, d = 4) => (Number.isFinite(v) ? `$${v.toFixed(d)}` : "–");
const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "–");
const n = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "–");

function mdTable(head: string[], rows: (string | number)[][]): string {
  if (!rows.length) return "_no data_\n";
  const line = (r: (string | number)[]) => `| ${r.map(String).join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n") + "\n";
}

const IDLE_TOOL_CALLS = 2;
const CACHE_TTL_BUCKETS: { label: string; max: number }[] = [
  { label: "first wake", max: -1 },
  { label: "< 5 min", max: 5 * 60_000 },
  { label: "5 min – 1 h", max: 60 * 60_000 },
  { label: "> 1 h", max: Infinity },
];

function stats(ws: WakeRow[]): (string | number)[] {
  const c = ws.map((w) => w.cost_usd);
  return [ws.length, $(median(c)), $(quantile(c, 0.9)), $(c.reduce((s, v) => s + v, 0))];
}

export function renderReport(db: Database, runId: string, now = Date.now()): string {
  const run = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  const agents = db.query<AgentRow, [string]>("SELECT * FROM agents WHERE run_id = ? ORDER BY rowid").all(runId);
  const allWakes = db.query<WakeRow, [string]>("SELECT * FROM wakes WHERE run_id = ? AND ended_at IS NOT NULL ORDER BY started_at").all(runId);
  // Wakes that never reached the model (auth/infra failures) would skew every cost statistic.
  const wakes = allWakes.filter((w) => w.requests > 0);
  const allRequests = db.query<RequestRow, [string]>("SELECT * FROM requests WHERE run_id = ? ORDER BY wake_id, seq").all(runId);
  // Relay web searches are billed as request rows without tokens (src/search.ts); kept apart from model requests.
  const requests = allRequests.filter((r) => r.model !== SEARCH_MODEL);
  const searchRequests = allRequests.filter((r) => r.model === SEARCH_MODEL);
  const pulls = db.query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM events WHERE run_id = ? AND kind = 'lifecycle' AND name = 'forge_pull'").get(runId)!.c;
  // World time: the stretches while the run was stopped (before a resume or extension) don't count.
  const world = worldTime(db, run, now);
  const hours = world.elapsedMs / 3_600_000;
  const gaps = worldGaps(world.segments);
  const extensions = extensionsOf(db, runId);
  const swarmBudget = swarmBudgetUsd(db, run);
  const total = wakes.reduce((s, w) => s + w.cost_usd, 0);
  const out: string[] = [];

  out.push(`# Token probe report: ${run.name}`, "");
  out.push(`- Run: \`${run.id}\` (${run.status}${run.stop_reason ? `, ${run.stop_reason}` : ""})`);
  const wall = (world.segments.at(-1)!.end - run.started_at) / 3_600_000;
  out.push(`- Started ${new Date(run.started_at).toISOString()}, world time ${hours.toFixed(2)} h${gaps.length ? ` (${wall.toFixed(2)} h wall clock; stopped ${gaps.length} time(s) in between)` : ""}`);
  out.push(`- Seed sha256: \`${run.seed_sha256.slice(0, 16)}…\`, CLI versions: \`${run.cli_versions ?? "?"}\`, image: \`${run.image_digest ?? "?"}\``);
  out.push(`- Wakes: ${allWakes.length} (${allWakes.length - wakes.length} without any API request, excluded below), API requests: ${requests.length}${searchRequests.length ? `, relay web searches: ${searchRequests.length}` : ""}`, "");

  out.push("## Totals", "");
  out.push(
    mdTable(
      ["agent", "harness / model", "wakes", "spent", "budget", "$/hour", "status"],
      [
        ...agents.map((a) => [a.name, `${a.harness} / ${a.model}`, a.wake_count, $(a.spent_usd), $(a.budget_usd, 2), $(hours > 0 ? a.spent_usd / hours : NaN), a.status]),
        ["**run**", "", allWakes.length, $(total), swarmBudget !== null ? $(swarmBudget, 2) : "", $(hours > 0 ? total / hours : NaN), run.status],
      ],
    ),
  );

  if (extensions.length) {
    out.push("## Extensions", "");
    out.push(
      mdTable(
        ["at", "added", "world end before", "world end after"],
        extensions.map((e) => [
          new Date(e.ts).toISOString(),
          describeExtension({ timeMs: e.time_ms, swarmUsd: e.swarm_usd, agentUsd: JSON.parse(e.agent_usd_json) }),
          new Date(e.old_deadline).toISOString(),
          new Date(e.new_deadline).toISOString(),
        ]),
      ),
    );
  }

  // Drain: wakes still running when the world ended (stopped at world_end_grace_s at the latest). An extension
  // applied after the end means the world ended before, too.
  const ends = [...extensions.filter((e) => e.ts >= e.old_deadline).map((e) => e.old_deadline), run.deadline_at];
  const endCrossed = (w: WakeRow) => ends.find((t) => w.started_at < t && w.ended_at! > t);
  const pastEnd = allWakes.filter((w) => endCrossed(w) !== undefined);
  if (pastEnd.length) {
    const cut = pastEnd.filter((w) => w.exit_reason === "world_end").length;
    const over = Math.max(...pastEnd.map((w) => w.ended_at! - endCrossed(w)!)) / 1000;
    out.push(
      `World end: ${pastEnd.length} wake(s) were still running when the world ended, costing ${$(pastEnd.reduce((s, w) => s + w.cost_usd, 0))} in total (whole wakes); ${cut} stopped by the grace limit; the last ended ${over.toFixed(0)} s after the end.`,
      "",
    );
  }

  // Vendor cross-check (Claude reports its own total_cost_usd).
  const checked = wakes.filter((w) => w.reported_cost_usd !== null && w.reported_cost_usd > 0);
  if (checked.length) {
    const ours = checked.reduce((s, w) => s + w.cost_usd, 0);
    const theirs = checked.reduce((s, w) => s + w.reported_cost_usd!, 0);
    out.push(`Cross-check on ${checked.length} wake(s) with a vendor-reported cost: computed ${$(ours)} vs reported ${$(theirs)} (${pct(ours / theirs - 1)} difference).`, "");
  }

  // OpenRouter: what each generation was charged and which provider served it (list price vs routed price).
  const vendor = requests.filter((r) => r.vendor_cost_usd !== null);
  if (vendor.length) {
    const byProvider = new Map<string, RequestRow[]>();
    for (const r of vendor) byProvider.set(r.vendor_provider ?? "?", [...(byProvider.get(r.vendor_provider ?? "?") ?? []), r]);
    const row = (k: string, rs: RequestRow[]) => {
      const ours = rs.reduce((s, r) => s + r.cost_usd, 0);
      const theirs = rs.reduce((s, r) => s + r.vendor_cost_usd!, 0);
      return [k, rs.length, $(ours), $(theirs), theirs > 0 ? pct(ours / theirs - 1) : "-"];
    };
    out.push(
      `OpenRouter charges on ${vendor.length} request(s) (we compute list prices; the provider a preset routes to may charge less):`,
      "",
      mdTable(["served by", "requests", "computed", "charged", "difference"], [...[...byProvider].map(([k, rs]) => row(k, rs)), row("all", vendor)]),
    );
  }

  const log = readSearchLog(runSearchDirs(runId).logFile);
  if (searchRequests.length || log.length) {
    out.push("## Web search (relay)", "");
    const ours = searchRequests.reduce((s, r) => s + r.cost_usd, 0);
    const billedIds = new Set(searchRequests.map((r) => r.request_id));
    const matched = log.filter((e) => billedIds.has(`search:${e.id}`) && e.exa_cost_usd !== null);
    const oursMatched = searchRequests.filter((r) => matched.some((e) => `search:${e.id}` === r.request_id)).reduce((s, r) => s + r.cost_usd, 0);
    const theirs = matched.reduce((s, e) => s + e.exa_cost_usd!, 0);
    const failed = log.filter((e) => !billed(e));
    out.push(
      `${searchRequests.length} search(es) billed, ${$(ours)} computed (in the wake costs above)` +
        (matched.length ? `; Exa reported ${$(theirs)} for ${matched.length} of them (computed ${$(oursMatched)}, ${pct(oursMatched / theirs - 1)} difference)` : "") +
        (failed.length ? `; ${failed.length} failed, not billed (${[...new Set(failed.map((e) => e.error?.split(":")[0] ?? "error"))].join(", ")})` : "") +
        ".",
      "",
    );
    const lat = log.filter(billed).map((e) => e.latency_ms);
    if (lat.length) out.push(`Latency: median ${n(median(lat))} ms, p90 ${n(quantile(lat, 0.9))} ms.`, "");
  }

  const fetches = readFetchLog(runSearchDirs(runId).fetchLogFile);
  if (fetches.length) out.push("## Web fetch (relay)", "", ...fetchSummary(fetches), "");

  out.push("## Per wake", "");
  const idle = wakes.filter((w) => w.tool_calls <= IDLE_TOOL_CALLS);
  out.push(mdTable(["set", "wakes", "median", "p90", "total"], [["all wakes", ...stats(wakes)], [`idle floor (≤${IDLE_TOOL_CALLS} tool calls)`, ...stats(idle)]]));
  const byHarness = new Map<string, WakeRow[]>();
  for (const w of wakes) {
    const rt = agents.find((a) => a.name === w.agent)?.model ?? "?";
    byHarness.set(rt, [...(byHarness.get(rt) ?? []), w]);
  }
  if (byHarness.size > 1) out.push(mdTable(["model", "wakes", "median", "p90", "total"], [...byHarness].map(([k, ws]) => [k, ...stats(ws)])));

  out.push("## Overhead share", "");
  const reqByWake = new Map<number, RequestRow[]>();
  for (const r of requests) reqByWake.set(r.wake_id, [...(reqByWake.get(r.wake_id) ?? []), r]);
  const shares: number[] = [];
  const firstInputs: number[] = [];
  for (const rs of reqByWake.values()) {
    const totalIn = rs.reduce((s, r) => s + r.prompt_tokens, 0);
    if (!totalIn) continue;
    shares.push(rs[0]!.prompt_tokens / totalIn);
    firstInputs.push(rs[0]!.prompt_tokens);
  }
  out.push(`First request's prompt as a share of the wake's total input: median ${pct(median(shares))}, p90 ${pct(quantile(shares, 0.9))}. Median first-request prompt: ${n(median(firstInputs))} tokens.`, "");

  out.push("## Cache: cold vs warm", "");
  // A wake whose sleep spans a stretch while the run was stopped is cold by construction: kept out of the table.
  const sleptAcrossGap = (w: WakeRow) => w.slept_ms !== null && gaps.some((g) => g.start < w.started_at && g.end > w.started_at - w.slept_ms!);
  const acrossGap = wakes.filter(sleptAcrossGap);
  const cacheWakes = wakes.filter((w) => !sleptAcrossGap(w));
  if (acrossGap.length) out.push(`${acrossGap.length} wake(s) slept across a stop of the run (cold cache by construction); not in this table.`, "");
  out.push(
    mdTable(
      ["slept before wake", "wakes", "median cost", "cache-write share of input", "cache-read share of input"],
      CACHE_TTL_BUCKETS.map((b, i) => {
        const lo = i === 0 ? -Infinity : CACHE_TTL_BUCKETS[i - 1]!.max;
        const ws = cacheWakes.filter((w) => (i === 0 ? w.slept_ms === null : w.slept_ms !== null && w.slept_ms > lo && w.slept_ms <= b.max));
        const input = ws.reduce((s, w) => s + w.fresh_input + w.cache_read + w.cache_write_5m + w.cache_write_1h, 0);
        const writes = ws.reduce((s, w) => s + w.cache_write_5m + w.cache_write_1h, 0);
        const reads = ws.reduce((s, w) => s + w.cache_read, 0);
        return [b.label, ws.length, $(median(ws.map((w) => w.cost_usd))), pct(writes / input), pct(reads / input)];
      }),
    ),
  );

  out.push("## Context strategy", "");
  const fresh = wakes.filter((w) => !w.resumed);
  const resumed = wakes.filter((w) => w.resumed);
  const asked = wakes.filter((w) => w.continue_requested === 1).length;
  out.push(mdTable(["session", "wakes", "median", "p90", "total"], [["fresh", ...stats(fresh)], ["continued", ...stats(resumed)]]));
  out.push(`Agents asked to continue their session after ${asked} of ${wakes.length} wakes.`, "");

  out.push("## Drift", "");
  const maxSeq = Math.max(0, ...wakes.map((w) => w.seq));
  const bucket = Math.max(1, Math.ceil(maxSeq / 6));
  const driftRows: (string | number)[][] = [];
  for (let lo = 1; lo <= maxSeq; lo += bucket) {
    const ws = wakes.filter((w) => w.seq >= lo && w.seq < lo + bucket);
    const sizes = ws.map((w) => w.home_bytes ?? 0);
    driftRows.push([`${lo}–${lo + bucket - 1}`, ws.length, $(median(ws.map((w) => w.cost_usd))), n(median(ws.map((w) => w.fresh_input + w.cache_read + w.cache_write_5m + w.cache_write_1h))), `${n(median(sizes) / 1024)} KiB`]);
  }
  out.push(mdTable(["wake #", "wakes", "median cost", "median input tokens", "median home"], driftRows));

  out.push("## Messaging", "");
  const triggers = [...new Set(wakes.map((w) => w.trigger))];
  out.push(mdTable(["trigger", "wakes", "median", "p90", "total"], triggers.map((t) => [t, ...stats(wakes.filter((w) => w.trigger === t))])));
  out.push(
    `\`message\` = pulled by forge notifications. Sleeping agents pulled by the poller: ${pulls}. Wakes that started with unread notifications: ${wakes.filter((w) => w.msgs_in > 0).length} of ${wakes.length}.`,
    "",
  );

  out.push("## Budget behaviour", "");
  const behaviour = agents.map((a) => {
    const ws = wakes.filter((w) => w.agent === a.name);
    const half = Math.ceil(ws.length / 2);
    const early = ws.slice(0, half);
    const late = ws.slice(half);
    const interval = (xs: WakeRow[]) => median(xs.map((w) => w.next_in_minutes).filter((v): v is number => v !== null));
    return [a.name, ws.length, $(median(early.map((w) => w.cost_usd))), $(median(late.map((w) => w.cost_usd))), `${n(interval(early))} / ${n(interval(late))}`, `${ws.filter((w) => w.next_in_minutes !== null).length}/${ws.length}`];
  });
  out.push(mdTable(["agent", "wakes", "median cost, 1st half", "median cost, 2nd half", "requested interval min (1st / 2nd half)", "wrote next_wake.yaml"], behaviour));

  out.push("## Extrapolation", "");
  if (hours > 0 && agents.length) {
    const perAgentDay = (total / agents.length / hours) * 24;
    out.push(`At the observed rate, one agent costs ${$(perAgentDay, 2)}/day: ${$(perAgentDay * 5, 2)}/day for 5 agents, ${$(perAgentDay * 100, 2)}/day for 100.`, "");
  } else out.push("_not enough data_", "");

  return out.join("\n");
}

/** Web fetches are free; the report shows what was fetched and what the guard refused (relay log, not the DB). */
export function fetchSummary(log: FetchLogEntry[]): string[] {
  const ok = log.filter(fetched);
  const httpErrors = ok.filter((e) => e.status === null || e.status < 200 || e.status > 299).length;
  const blocked = log.filter((e) => !fetched(e) && e.blocked);
  const failed = log.filter((e) => !fetched(e) && !e.blocked);
  const count = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  const list = (xs: string[], max = 5) => count(xs).slice(0, max).map(([k, v]) => `${k} ${v}`).join(", ");
  const host = (e: FetchLogEntry) => {
    try {
      return new URL(e.final_url ?? e.url).hostname;
    } catch {
      return "?";
    }
  };
  const lines = [
    `${log.length} fetch(es): ${ok.length} answered (${n(ok.reduce((s, e) => s + e.bytes, 0))} bytes${httpErrors ? `, ${httpErrors} with an HTTP error status` : ""}, ${ok.filter((e) => e.raw).length} saved raw)` +
      `, ${blocked.length} blocked, ${failed.length} failed. By agent: ${list(log.map((e) => e.agent), 20)}.`,
  ];
  if (ok.length) lines.push(`Top hosts: ${list(ok.map(host))}.`);
  if (blocked.length) lines.push(`Blocked: ${list(blocked.map((e) => e.blocked!.replace(/^[^ ]+ (is|resolves)/, "<host> $1").replace(/ \(.*\)$/, "")))}.`);
  if (failed.length) lines.push(`Failed: ${list(failed.map((e) => (e.error ?? "error").split(":")[0]!))}.`);
  return lines;
}
