import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { agentDirs, openDb } from "../src/db/index.ts";
import { fileTree, startDashboard } from "../src/dashboard/server.ts";
import { esc } from "../src/dashboard/format.ts";
import type { AgentEvent, StreamParser } from "../src/types.ts";

const RUN = "20261010-1200-test";
const dataDir = mkdtempSync(join(tmpdir(), "slopswarm-dash-data-"));
process.env.SLOPSWARM_DATA_DIR = dataDir;
const now = Date.now();

// Stub parser: each raw line is a JSON-encoded AgentEvent.
// Svelte's SSR markers have no visible content; assertions target rendered markup.
const markup = (html: string) => html.replace(/<!--.*?-->/gs, "");

const stubParser = (): StreamParser => ({
  push(line) {
    try {
      return [JSON.parse(line) as AgentEvent];
    } catch {
      return [];
    }
  },
});

function seed(db: Database, rawLog: string) {
  db.query(
    `INSERT INTO runs (id, name, config_yaml, seed_sha256, seed_text, pricing_yaml, status, started_at, deadline_at)
     VALUES (?, 'tiny-society-T', ?, 'abc', 'seed', 'models: {}', 'running', ?, ?)`,
  ).run(RUN, "# --- config/swarm.yaml\nrun: {name: t}\nbudgets: {swarm_usd: 20}\n# --- agents/bramble.yaml\nname: bramble\n", now - 3_600_000, now + 3_600_000);
  for (const [name, status] of [
    ["bramble", "sleeping"],
    ["thistle", "waking"],
  ] as const)
    db.query(
      `INSERT INTO agents (run_id, name, runtime, model, effort, budget_usd, spent_usd, status, next_wake_at, next_trigger, wake_count)
       VALUES (?, ?, 'claude', 'claude-haiku-5-5', 'medium', 3, 0.42, ?, ?, 'self', 2)`,
    ).run(RUN, name, status, now + 600_000);
  for (const seq of [1, 2])
    db.query(
      `INSERT INTO wakes (run_id, agent, seq, trigger, started_at, ended_at, exit_reason, cost_usd, requests, tool_calls, raw_log_path, next_in_minutes)
       VALUES (?, 'bramble', ?, ?, ?, ?, 'completed', 0.21, 2, 3, ?, 30)`,
    ).run(RUN, seq, seq === 1 ? "initial" : "self", now - 3_000_000 + seq * 1_000_000, now - 2_900_000 + seq * 1_000_000, rawLog);
  db.query(
    `INSERT INTO requests (wake_id, run_id, agent, seq, request_id, model, fresh_input, cache_read, cache_write_5m, cache_write_1h, output, reasoning, web_searches, prompt_tokens, tier, cost_usd)
     VALUES (1, ?, 'bramble', 1, 'msg_1', 'claude-haiku-5-5', 2, 11447, 0, 6282, 38, 0, 0, 17731, 0, 0.00139),
            (1, ?, 'bramble', 2, 'resp_rollout_only', 'claude-haiku-5-5', 5, 100, 0, 0, 10, 0, 0, 105, 0, 0.00002)`,
  ).run(RUN, RUN);
  db.query(`INSERT INTO events (run_id, agent, wake_id, ts, kind, name, detail, ok) VALUES (?, 'bramble', 1, ?, 'tool_call', 'Bash', ?, 1)`).run(
    RUN,
    now - 100_000,
    "<script>alert(1)</script>",
  );
  db.query(`INSERT INTO events (run_id, agent, wake_id, ts, kind, name, detail, ok) VALUES (?, 'thistle', NULL, ?, 'lifecycle', 'forge_pull', '1 unread', NULL)`).run(
    RUN,
    now - 90_000,
  );
  // Agent home files.
  const home = agentDirs(RUN, "bramble").home;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "notes.md"), "# bramble notes\n- goal: map the <forge>\n");
  writeFileSync(join(home, "blob.bin"), Buffer.from([0, 1, 2, 3]));
  Bun.spawnSync(["ln", "-s", "/etc/passwd", join(home, "passwd-link")]);
  // A cloned repo: nested dirs, a .git dir, and a hostile file name.
  mkdirSync(join(home, "repo/src"), { recursive: true });
  mkdirSync(join(home, "repo/.git/objects"), { recursive: true });
  writeFileSync(join(home, "repo/src/main.ts"), "const x = 1 < 2 && '<b>';\n");
  writeFileSync(join(home, "repo/README.md"), "readme\n");
  writeFileSync(join(home, "repo/.git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(home, "repo/<img src=x>.txt"), "x");
  Bun.spawnSync(["ln", "-s", "/etc", join(home, "repo/etc-link")]);
}

let dir: string;
let db: Database;
let dash: { stop(): void; url: string };
let ro: { stop(): void; url: string };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "slopswarm-dash-"));
  const rawLog = join(dir, "wake1.jsonl");
  const events: AgentEvent[] = [
    { kind: "session", sessionId: "sess-1" },
    { kind: "reasoning", text: "Maybe I should **check** the inbox first." },
    { kind: "message", role: "assistant", text: "I will look around <b>now</b>" },
    { kind: "tool_call", id: "t1", name: "Bash", args: "ls -la" },
    { kind: "tool_result", id: "t1", ok: false, summary: "permission denied" },
    {
      kind: "usage",
      usage: { requestId: "msg_1", model: "claude-haiku-5-5", freshInput: 2, cacheRead: 11447, cacheWrite5m: 0, cacheWrite1h: 6282, output: 5, reasoning: 0, webSearches: 0 },
    },
    {
      kind: "usage",
      usage: { requestId: "msg_1", model: "claude-haiku-5-5", freshInput: 2, cacheRead: 11447, cacheWrite5m: 0, cacheWrite1h: 6282, output: 38, reasoning: 0, webSearches: 0 },
    },
    { kind: "turn_end", reason: "completed", numTurns: 1, reportedCostUsd: 0.00139 },
  ];
  writeFileSync(rawLog, events.map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n");
  db = openDb(":memory:");
  seed(db, rawLog);
  dash = await startDashboard({ db, port: 0, parserFor: stubParser, forge: { runId: RUN, url: "http://127.0.0.1:3300" } });
  ro = await startDashboard({ db, port: 0, readonly: true, parserFor: stubParser });
}, 60_000);

afterAll(() => {
  dash?.stop();
  ro?.stop();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe("dashboard", () => {
  test("overview: run meters, agent cards, readable activity feed", async () => {
    const res = await fetch(`${dash.url}/`);
    expect(res.status).toBe(200);
    const body = markup(await res.text());
    expect(body).toContain("tiny-society-T");
    expect(body).toContain("thistle");
    expect(body).toContain("$20.00"); // swarm budget from the config snapshot
    expect(body).toContain("World time");
    expect(body).toContain('href="/wake/1"'); // wake items in the feed
    expect(body).toContain("has 1 unread forge notification(s); next wake pulled"); // notification pulls in the feed
    expect(body).toContain('action="/control"');
    expect(body).toContain('data-live="1"');
    expect(body).toContain(`href="/agents?run=${RUN}"`);
    expect(body).not.toContain("/messages");
    expect(body).not.toContain("/commons");
    expect(body).toContain('href="http://127.0.0.1:3300" target="_blank"'); // the run's forge
    expect(await (await fetch(`${ro.url}/`)).text()).not.toContain("Forge ↗"); // no forge served alongside
  });

  test("serves compiled client assets and SvelteKit data refreshes", async () => {
    const html = await (await fetch(`${dash.url}/`)).text();
    expect(html).not.toContain("config_yaml");
    expect(html).not.toContain("seed_text");
    expect(html).not.toContain("raw_log_path");
    const asset = html.match(/import\("([^"\n]+\/_app\/immutable\/entry\/start\.[^"]+)"\)/)?.[1];
    expect(asset).toBeDefined();
    const assetUrl = new URL(asset!, `${dash.url}/`);
    const js = await fetch(assetUrl);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("cache-control")).toContain("immutable");
    const head = await fetch(assetUrl, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const original = 0.42;
    try {
      db.query("UPDATE agents SET spent_usd = 0.75 WHERE run_id = ? AND name = 'bramble'").run(RUN);
      const refreshed = await fetch(`${dash.url}/__data.json?run=${RUN}&x-sveltekit-invalidated=11`);
      expect(refreshed.status).toBe(200);
      expect(refreshed.headers.get("content-type")).toContain("application/json");
      const data = await refreshed.text();
      expect(data).toContain('"overview"');
      expect(data).toContain('0.75');
    } finally {
      db.query("UPDATE agents SET spent_usd = ? WHERE run_id = ? AND name = 'bramble'").run(original, RUN);
    }
  });

  test("empty databases render without leaking another dashboard's context", async () => {
    const emptyDb = openDb(":memory:");
    const empty = await startDashboard({ db: emptyDb, port: 0, readonly: true });
    try {
      const [blank, populated] = await Promise.all([fetch(empty.url).then(r => r.text()), fetch(dash.url).then(r => r.text())]);
      expect(blank).toContain("No runs yet");
      expect(blank).not.toContain("bramble");
      expect(populated).toContain("bramble");
      expect((await fetch(`${empty.url}/agents`)).status).toBe(404);
      expect(await (await fetch(`${empty.url}/api/state`)).json()).toEqual({ run: null, agents: [], events: [] });
    } finally { empty.stop(); emptyDb.close(); }
  });

  test("run selection stays scoped and finished pages stop refreshing", async () => {
    const other = "20261011-finished";
    db.query(`INSERT INTO runs (id, name, config_yaml, seed_sha256, seed_text, pricing_yaml, status, started_at, deadline_at, ended_at)
      VALUES (?, 'finished view', 'budgets: {swarm_usd: 1}', 'test', 'test', 'models: {}', 'finished', ?, ?, ?)`)
      .run(other, now + 1, now + 2, now + 2);
    try {
      const finished = await (await fetch(`${dash.url}/?run=${other}`)).text();
      expect(finished).toContain("finished view");
      expect(finished).not.toContain('action="/control"');
      expect(finished).not.toContain('data-live="1"');
      const selected = await (await fetch(`${dash.url}/?run=${RUN}`)).text();
      expect(selected).toContain("tiny-society-T");
      expect(selected).toContain("bramble");
      const wake = await (await fetch(`${dash.url}/wake/1?run=${other}`)).text();
      expect(wake).toContain(`href="/agents?run=${RUN}"`);
      expect(wake).toContain('href="http://127.0.0.1:3300"');
      expect(wake).not.toContain('data-live="1"');
    } finally { db.query("DELETE FROM runs WHERE id = ?").run(other); }
  });

  test("raw events page escapes agent-written details", async () => {
    const body = markup(await (await fetch(`${dash.url}/events?run=${RUN}`)).text());
    expect(body).toContain("&lt;script>alert(1)&lt;/script>");
    expect(body).not.toContain("<script>alert(1)</script>");
  });

  test("file viewer confines paths", async () => {
    const ok = await fetch(`${dash.url}/file?run=${RUN}&agent=bramble&path=notes.md`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("map the &lt;forge&gt;");
    for (const bad of ["../../../../etc/passwd", "/etc/passwd", "..%2F..%2Fetc%2Fpasswd"]) {
      const r = await fetch(`${dash.url}/file?run=${RUN}&agent=bramble&path=${bad}`);
      expect(r.status).toBe(400);
    }
    expect((await fetch(`${dash.url}/file?run=${RUN}&agent=bramble&path=passwd-link`)).status).toBe(400); // symlink
    expect((await fetch(`${dash.url}/file?run=${RUN}&path=notes.md`)).status).toBe(404); // no agent, no shared folder
    expect((await fetch(`${dash.url}/file?run=${RUN}&agent=bramble&path=blob.bin`)).status).toBe(415);
    expect((await fetch(`${dash.url}/file?run=${RUN}&agent=bramble&path=missing.md`)).status).toBe(404);
    expect((await fetch(`${dash.url}/file?run=${RUN}&agent=ghost&path=notes.md`)).status).toBe(404);
  });

  test("agent page: summary, wakes and memory tabs", async () => {
    const summary = await (await fetch(`${dash.url}/agent/bramble?run=${RUN}`)).text();
    expect(summary).toContain("<svg");
    expect(summary).toContain('value="pause"');
    const wakes = await (await fetch(`${dash.url}/agent/bramble?run=${RUN}&tab=wakes`)).text();
    expect(wakes).toContain('href="/wake/1"');
    expect(wakes).toContain('href="/wake/2"');
    expect((await fetch(`${dash.url}/agent/nobody`)).status).toBe(404);
  });

  test("memory tab: file tree with a viewer", async () => {
    const mem = (path?: string) => fetch(`${dash.url}/agent/bramble?run=${RUN}&tab=memory${path == null ? "" : `&path=${encodeURIComponent(path)}`}`).then(async (r) => markup(await r.text()));
    const base = `/agent/bramble?run=${RUN}&amp;tab=memory&amp;path=`;
    const memory = await mem();
    expect(memory).toContain("memory · 5"); // notes.md, blob.bin, main.ts, README.md, <img…>.txt
    expect(memory).toContain(`href="${base}notes.md"`);
    expect(memory).toContain("map the &lt;forge&gt;"); // newest top-level file selected by default, escaped
    expect(memory).not.toContain("passwd-link"); // symlinks are skipped
    expect(memory).not.toContain("etc-link");
    // The repo is a collapsed directory, its file still reachable.
    expect(memory).toContain(`<details data-key="tree:${RUN}:bramble:repo"><summary><span class="nm">repo/</span><span class="meta">4 items</span>`); // .git counts as one
    expect(memory).toContain(`<details data-key="tree:${RUN}:bramble:repo/src"><summary>`);
    expect(memory).toContain(`href="${base}repo%2Fsrc%2Fmain.ts"`);
    expect(memory).toContain("&lt;img src=x>.txt"); // hostile names escaped
    expect(memory).not.toContain("<img src=x>");
    // .git is one line, never a <details>, never walked.
    expect(memory).toContain(`<span class="nm">.git/</span><span class="meta">not listed</span>`);
    expect(memory).not.toContain(":repo/.git");
    expect(memory).not.toContain("HEAD");

    const sel = await mem("repo/src/main.ts");
    expect(sel).toContain("const x = 1 &lt; 2 &amp;&amp; '&lt;b>';"); // escaped content
    expect(sel).toContain(`<details data-key="tree:${RUN}:bramble:repo" open="">`); // ancestors open
    expect(sel).toContain(`<details data-key="tree:${RUN}:bramble:repo/src" open="">`);
    expect(sel).toContain(`<li class="on"><a href="${base}repo%2Fsrc%2Fmain.ts"`);
    expect(sel).not.toContain("map the &lt;forge&gt;");

    expect(await mem("blob.bin")).toContain('<p class="err">binary file</p>');
    expect(await mem("passwd-link")).toContain('<p class="err">symlinks are not followed</p>');
    expect(await mem("repo/etc-link/passwd")).toContain('<p class="err">symlinks are not followed</p>');
    for (const bad of ["../../../../etc/passwd", "/etc/passwd"]) {
      const body = await mem(bad);
      expect(body).toContain('<p class="err">path escapes the directory</p>');
      expect(body).not.toContain("root:");
    }
  });

  test("api/state returns JSON overview", async () => {
    const s = (await (await fetch(`${dash.url}/api/state`)).json()) as {
      run: { id: string; spentUsd: number; swarmBudgetUsd: number };
      agents: { name: string }[];
      events: unknown[];
    };
    expect(s.run.id).toBe(RUN);
    expect(s.run.spentUsd).toBeCloseTo(0.84);
    expect(s.run.swarmBudgetUsd).toBe(20);
    expect(s.agents.map((a) => a.name)).toEqual(["bramble", "thistle"]);
    expect(s.events.length).toBe(2);
  });

  test("wake page renders the timeline with per-request cost", async () => {
    const res = await fetch(`${dash.url}/wake/1`);
    expect(res.status).toBe(200);
    const body = markup(await res.text());
    expect(body).toContain("I will look around &lt;b&gt;now&lt;/b&gt;");
    expect(body).toContain('class="reasoning"');
    expect(body).toContain("<strong>check</strong>");
    expect(body).toContain("tool · Bash");
    expect(body).toContain("permission denied"); // result paired with its call
    expect(body).toContain("$0.00139");
    expect(body.match(/request <code>msg_1<\/code>/g)?.length).toBe(1); // upserts collapsed
    expect(body).toContain("resp_rollout_only"); // request only known from the session file
    expect(body).toContain("<details data-hold");
    expect(body).not.toContain("not json"); // the raw log is fetched separately, only when opened
    const raw = await fetch(`${dash.url}/wake/1/raw`);
    expect(raw.headers.get("content-type")).toContain("text/plain");
    expect(await raw.text()).toContain("not json");
    expect((await fetch(`${dash.url}/wake/999/raw`)).status).toBe(404);
    expect((await fetch(`${dash.url}/wake/999`)).status).toBe(404);
  });

  test("POST control enqueues; bad input rejected", async () => {
    const post = (url: string, fields: Record<string, string>) =>
      fetch(`${url}/control`, { method: "POST", body: new URLSearchParams(fields), headers: { origin: new URL(url).origin }, redirect: "manual" });
    const res = await post(dash.url, { run: RUN, action: "pause", agent: "bramble" });
    expect(res.status).toBe(303);
    expect((await post(dash.url, { run: RUN, action: "stop" })).status).toBe(303);
    expect((await post(dash.url, { run: RUN, action: "rm -rf" })).status).toBe(400);
    expect((await post(dash.url, { run: RUN, action: "pause", agent: "ghost" })).status).toBe(400);
    expect((await post(dash.url, { run: RUN, action: "pause" })).status).toBe(400);
    // Cross-site form posts (CSRF from another page in the operator's browser) are refused.
    for (const headers of [{ "sec-fetch-site": "cross-site" }, { origin: "http://evil.example" }] as Record<string, string>[]) {
      const r = await fetch(`${dash.url}/control`, { method: "POST", body: new URLSearchParams({ run: RUN, action: "kill" }), headers });
      expect(r.status).toBe(403);
    }
    expect((await fetch(`${dash.url}/control`, { method: "POST", body: new URLSearchParams({ run: RUN, action: "wake", agent: "thistle" }), headers: { "sec-fetch-site": "same-origin", origin: new URL(dash.url).origin }, redirect: "manual" })).status).toBe(303);
    const rows = db.query("SELECT agent, action, source FROM controls ORDER BY id").all();
    expect(rows).toEqual([
      { agent: "bramble", action: "pause", source: "dashboard" },
      { agent: null, action: "stop", source: "dashboard" },
      { agent: "thistle", action: "wake", source: "dashboard" },
    ]);
  });

  test("readonly mode hides controls and rejects POSTs", async () => {
    const body = await (await fetch(`${ro.url}/`)).text();
    expect(body).not.toContain('action="/control"');
    expect(body).toContain("read-only");
    // Same-origin, so SvelteKit's own CSRF check passes and only the read-only guard can refuse it.
    const res = await fetch(`${ro.url}/control`, { method: "POST", body: new URLSearchParams({ run: RUN, action: "kill" }), headers: { origin: new URL(ro.url).origin, "sec-fetch-site": "same-origin" } });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("read-only");
  });
});

describe("fileTree", () => {
  test("lists files, does not follow symlinks, respects depth", () => {
    const root = mkdtempSync(join(tmpdir(), "slopswarm-tree-"));
    try {
      mkdirSync(join(root, "a/b/c/d/e"), { recursive: true });
      writeFileSync(join(root, "note.md"), "hello");
      Bun.spawnSync(["ln", "-s", "/etc", join(root, "etc-link")]);
      const t = fileTree(root, 3)!;
      expect(t.find((n) => n.name === "note.md")).toMatchObject({ kind: "file", size: 5 });
      expect(t.find((n) => n.name === "etc-link")).toMatchObject({ kind: "symlink" });
      const c = t.find((n) => n.name === "a")!.children![0]!.children![0]!;
      expect(c).toMatchObject({ name: "c", truncated: true, children: [] });
      expect(fileTree(join(root, "missing"))).toBeNull();
      // Opaque dirs are listed but not walked; walk limits still apply.
      mkdirSync(join(root, ".git/objects"), { recursive: true });
      expect(fileTree(root, 3, 500, [".git"])!.find((n) => n.name === ".git")).toMatchObject({ kind: "dir", opaque: true, children: [] });
      expect(fileTree(root, 3)!.find((n) => n.name === ".git")!.children![0]).toMatchObject({ name: "objects", kind: "dir" });
      expect(fileTree(root, 3, 2)!.at(-1)).toMatchObject({ name: "…", truncated: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("esc escapes quotes too", () => {
    expect(esc(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
  });
});
