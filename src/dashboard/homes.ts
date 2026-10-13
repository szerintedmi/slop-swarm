// The dashboard's home browser (docs/plans/2026-10-12-hosted-control-plane.md §2.6): live through the runner while
// the agent host is up (mid-wake too), else the VPS backup copy, "as of generation N".
import { worldAgentDirs } from "../db/index.ts";
import { backupGeneration } from "../controller/host-files.ts";
import type { AgentHost } from "../host/agent-host.ts";
import type { FileStat } from "../runner/protocol.ts";
import { FILE_VIEW_CAP, fileTree, readSafeFile, type SafeRead, type TreeNode } from "./data.ts";

export interface HomeSource {
  /** true: read from the agent host now; false: the VPS copy. */
  live: boolean;
  /** The VPS copy's generation (0: none yet). */
  generation: number;
}

const LIVE_TIMEOUT_MS = 3_000;

/** A flat runner listing as a tree; `maxEntries` like fileTree. */
export function treeFromList(entries: FileStat[], maxEntries = 1000): TreeNode[] {
  const root: TreeNode[] = [];
  const dirs = new Map<string, TreeNode[]>([["", root]]);
  let count = 0;
  for (const e of entries) {
    const at = e.path.lastIndexOf("/");
    const parent = at < 0 ? "" : e.path.slice(0, at);
    const name = e.path.slice(at + 1);
    const into = dirs.get(parent);
    if (!into) continue;
    if (++count > maxEntries) {
      root.push({ name: "…", kind: "other", truncated: true });
      break;
    }
    if (e.kind === "dir") {
      const children: TreeNode[] = [];
      dirs.set(e.path, children);
      into.push({ name, kind: "dir", mtime: e.mtimeMs, children });
    } else if (e.kind === "file") into.push({ name, kind: "file", size: e.size, mtime: e.mtimeMs });
    else into.push({ name, kind: e.kind });
  }
  return root;
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("agent host did not answer")), LIVE_TIMEOUT_MS))]);
}

/** The agent's home tree, live if the agent host answers. `.git` is listed, never walked. */
export async function homeTree(host: AgentHost | undefined, world: string, agent: string): Promise<{ tree: TreeNode[]; source: HomeSource }> {
  const generation = backupGeneration(world, agent);
  if (host) {
    try {
      const entries = await withTimeout(host.list({ world, agent, area: "home", path: "" }, { depth: 6, opaque: [".git"] }));
      return { tree: treeFromList(entries), source: { live: true, generation } };
    } catch {
      /* agent host off: the backup copy */
    }
  }
  return { tree: fileTree(worldAgentDirs(world, agent).home, 6, 1000, [".git"]) ?? [], source: { live: false, generation } };
}

/** One file of the home, live if the agent host answers, else from the VPS copy. */
export async function homeFile(host: AgentHost | undefined, world: string, agent: string, path: string): Promise<{ file: SafeRead; source: HomeSource }> {
  const generation = backupGeneration(world, agent);
  if (host) {
    try {
      if (!path || path.includes("\0")) return { file: { ok: false, status: 400, reason: "bad path" }, source: { live: true, generation } };
      const ref = { world, agent, area: "home" as const, path };
      const st = await withTimeout(host.stat(ref));
      if (!st) return { file: { ok: false, status: 404, reason: "not found" }, source: { live: true, generation } };
      if (st.kind !== "file") return { file: { ok: false, status: 400, reason: "not a regular file" }, source: { live: true, generation } };
      const r = await withTimeout(host.read(ref, 0, FILE_VIEW_CAP));
      if (!r) return { file: { ok: false, status: 404, reason: "not found" }, source: { live: true, generation } };
      if (r.data.subarray(0, 8192).includes(0)) return { file: { ok: false, status: 415, reason: "binary file" }, source: { live: true, generation } };
      return { file: { ok: true, text: new TextDecoder().decode(r.data), size: r.size, mtime: st.mtimeMs, truncated: r.size > r.data.length }, source: { live: true, generation } };
    } catch {
      /* agent host off: the backup copy */
    }
  }
  return { file: readSafeFile(worldAgentDirs(world, agent).home, path), source: { live: false, generation } };
}
