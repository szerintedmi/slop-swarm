// Dashboard queries and safe file access. Read-only.
import type { Database } from "bun:sqlite";
import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { AgentRow, EventRow, RunRow, WakeRow } from "../db/index.ts";
import { swarmBudgetUsd, worldTime } from "../world.ts";

/** Whether a controller is (supposed to be) driving the run. */
export function runLive(run: RunRow): boolean {
  return run.status === "running" || run.status === "stopping";
}

export function agentsOf(db: Database, runId: string): AgentRow[] {
  return db.query<AgentRow, [string]>("SELECT * FROM agents WHERE run_id = ? ORDER BY name").all(runId);
}

export function wakesOf(db: Database, runId: string, agent?: string): WakeRow[] {
  return agent
    ? db.query<WakeRow, [string, string]>("SELECT * FROM wakes WHERE run_id = ? AND agent = ? ORDER BY seq DESC").all(runId, agent)
    : db.query<WakeRow, [string]>("SELECT * FROM wakes WHERE run_id = ? ORDER BY started_at DESC").all(runId);
}

/**
 * The agent's last words: the final assistant text of its latest finished wake, read from the tail
 * of the raw CLI log (Claude `result.result`, Codex last `agent_message`, pi last assistant `message_end`). No parser.
 */
export function lastSaid(wake: WakeRow | undefined): string | null {
  if (!wake?.raw_log_path) return null;
  try {
    const fd = openSync(wake.raw_log_path, "r");
    try {
      const size = lstatSync(wake.raw_log_path).size;
      const n = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, size - n);
      const lines = buf.toString("utf8").split("\n").reverse();
      for (const l of lines) {
        if (!l.startsWith("{")) continue;
        try {
          const d = JSON.parse(l);
          if (d.type === "result" && typeof d.result === "string" && d.result.trim()) return d.result;
          if (d.type === "item.completed" && d.item?.type === "agent_message" && typeof d.item.text === "string") return d.item.text;
          if (d.type === "message_end" && d.message?.role === "assistant" && Array.isArray(d.message.content)) {
            const text = d.message.content
              .filter((c: any) => c?.type === "text" && typeof c.text === "string")
              .map((c: any) => c.text)
              .join("\n")
              .trim();
            if (text) return text;
          }
        } catch {
          /* partial first line */
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    /* no log */
  }
  return null;
}

export function overviewState(db: Database, run: RunRow, now = Date.now()) {
  const agents = agentsOf(db, run.id);
  const lastActivity = new Map(
    db
      .query<{ agent: string; ts: number }, [string]>("SELECT agent, MAX(ts) AS ts FROM events WHERE run_id = ? AND agent IS NOT NULL GROUP BY agent")
      .all(run.id)
      .map((r) => [r.agent, r.ts]),
  );
  const events = db.query<EventRow, [string]>("SELECT * FROM events WHERE run_id = ? ORDER BY ts DESC, id DESC LIMIT 50").all(run.id);
  const running = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM wakes WHERE run_id = ? AND ended_at IS NULL").get(run.id)!.n;
  const lastWake = db.query<WakeRow, [string, string]>(
    "SELECT * FROM wakes WHERE run_id = ? AND agent = ? AND ended_at IS NOT NULL ORDER BY seq DESC LIMIT 1",
  );
  const notified = new Map(
    db
      .query<{ agent: string; n: number }, [string]>("SELECT agent, COUNT(*) AS n FROM wakes WHERE run_id = ? AND trigger = 'message' GROUP BY agent")
      .all(run.id)
      .map((r) => [r.agent, r.n]),
  );
  const spent = agents.reduce((s, a) => s + a.spent_usd, 0);
  const world = worldTime(db, run, now);
  const live = runLive(run);
  return {
    run: {
      id: run.id,
      name: run.name,
      status: run.status,
      stopReason: run.stop_reason,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      deadlineAt: run.deadline_at,
      /** World time: stretches while the run was stopped don't count. */
      elapsedMs: world.elapsedMs,
      /** Elapsed plus what is left until the (possibly extended) deadline. */
      maxDurationMs: world.totalMs,
      spentUsd: spent,
      swarmBudgetUsd: swarmBudgetUsd(db, run),
      runningWakes: running,
      notificationWakes: [...notified.values()].reduce((s, n) => s + n, 0),
    },
    agents: agents.map((a) => ({
      name: a.name,
      harness: a.harness,
      model: a.model,
      effort: a.effort,
      status: a.status,
      budgetUsd: a.budget_usd,
      spentUsd: a.spent_usd,
      wakeCount: a.wake_count,
      // A stopped/finished run has no controller, so its stored schedule is not live.
      nextWakeAt: live ? a.next_wake_at : null,
      nextTrigger: live ? a.next_trigger : null,
      continueNext: !!a.continue_next,
      lastActivityAt: lastActivity.get(a.name) ?? a.last_wake_end,
      lastSaid: lastSaid(lastWake.get(run.id, a.name) ?? undefined),
      /** Wakes pulled by forge notifications. */
      notificationWakes: notified.get(a.name) ?? 0,
    })),
    events,
  };
}

// ---------- activity feed ----------

export type Activity =
  | { kind: "run"; ts: number; text: string }
  /** One item per wake, at its start time (still running if wake.ended_at is null). */
  | { kind: "wake"; ts: number; agent: string; wake: WakeRow }
  /** Unread forge notifications pulled a sleeping agent's next wake. */
  | { kind: "pull"; ts: number; agent: string; text: string }
  | { kind: "error"; ts: number; agent: string | null; text: string; wakeId: number | null };

/** A human-readable story of the run, newest first: wakes, notification pulls, errors. What agents did in the forge is in the forge. */
export function activity(db: Database, run: RunRow, limit = 200): Activity[] {
  const out: Activity[] = [];
  const wakes = wakesOf(db, run.id);
  for (const w of wakes) out.push({ kind: "wake", ts: w.started_at, agent: w.agent, wake: w });
  for (const e of db
    .query<EventRow, [string]>(
      "SELECT * FROM events WHERE run_id = ? AND (kind = 'error' OR (kind = 'lifecycle' AND (name LIKE 'run_%' OR name = 'forge_pull'))) ORDER BY ts",
    )
    .all(run.id)) {
    if (e.name === "forge_pull" && e.agent) out.push({ kind: "pull", ts: e.ts, agent: e.agent, text: e.detail ?? "" });
    else if (e.kind === "error") out.push({ kind: "error", ts: e.ts, agent: e.agent, text: `${e.name ?? ""}: ${e.detail ?? ""}`, wakeId: e.wake_id });
    else out.push({ kind: "run", ts: e.ts, text: `${(e.name ?? "").replace(/^run_/, "run ")}${e.detail ? ` (${e.detail})` : ""}` });
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

// ---------- files ----------

export interface TreeNode {
  name: string;
  size?: number;
  /** Modified time (ms) for files and directories. */
  mtime?: number;
  kind: "file" | "dir" | "symlink" | "other";
  children?: TreeNode[];
  truncated?: boolean;
  /** A directory named in `opaque`: listed, never walked (children stay empty). */
  opaque?: boolean;
}

/**
 * Walk a directory. Never follows symlinks; depth- and count-limited. Directories named in `opaque`
 * (e.g. `.git`) are listed but not walked, so they cost one entry.
 */
export function fileTree(root: string, maxDepth = 4, maxEntries = 500, opaque: readonly string[] = []): TreeNode[] | null {
  let count = 0;
  const walk = (dir: string, depth: number): TreeNode[] => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return [];
    }
    const out: TreeNode[] = [];
    for (const name of names) {
      if (++count > maxEntries) {
        out.push({ name: "…", kind: "other", truncated: true });
        break;
      }
      const p = join(dir, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      const mtime = st.mtimeMs;
      if (st.isSymbolicLink()) out.push({ name, kind: "symlink" });
      else if (st.isDirectory() && opaque.includes(name)) out.push({ name, kind: "dir", mtime, children: [], opaque: true });
      else if (st.isDirectory()) out.push({ name, kind: "dir", mtime, children: depth < maxDepth ? walk(p, depth + 1) : [], truncated: depth >= maxDepth });
      else if (st.isFile()) out.push({ name, kind: "file", size: st.size, mtime });
      else out.push({ name, kind: "other" });
    }
    return out;
  };
  try {
    if (!lstatSync(root).isDirectory()) return null;
  } catch {
    return null;
  }
  return walk(root, 1);
}

export const FILE_VIEW_CAP = 512 * 1024;

export type SafeRead =
  | { ok: true; text: string; size: number; mtime: number; truncated: boolean }
  | { ok: false; status: 400 | 404 | 415; reason: string };

/**
 * Read a text file under `root`. The path must stay inside root after resolution, no path component
 * may be a symlink, and binary files are refused. Content is capped at FILE_VIEW_CAP.
 */
export function readSafeFile(root: string, relPath: string): SafeRead {
  if (!relPath || relPath.includes("\0")) return { ok: false, status: 400, reason: "bad path" };
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { ok: false, status: 404, reason: "no such directory" };
  }
  const target = resolve(rootReal, relPath);
  if (target !== rootReal && !target.startsWith(rootReal + sep)) return { ok: false, status: 400, reason: "path escapes the directory" };
  // Reject symlinks anywhere below the root.
  let cur = rootReal;
  for (const part of relative(rootReal, target).split(sep)) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return { ok: false, status: 404, reason: "not found" };
    }
    if (st.isSymbolicLink()) return { ok: false, status: 400, reason: "symlinks are not followed" };
  }
  const st = lstatSync(target);
  if (!st.isFile()) return { ok: false, status: 400, reason: "not a regular file" };
  const fd = openSync(target, "r");
  try {
    const n = Math.min(st.size, FILE_VIEW_CAP);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, 0);
    if (buf.subarray(0, 8192).includes(0)) return { ok: false, status: 415, reason: "binary file" };
    return { ok: true, text: buf.toString("utf8"), size: st.size, mtime: st.mtimeMs, truncated: st.size > n };
  } finally {
    closeSync(fd);
  }
}
