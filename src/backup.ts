// Backups on the VPS (docs/plans/2026-10-12-hosted-control-plane.md §6.6):
// - the controller DB, nightly, with SQLite's own consistent copy (`VACUUM INTO`, through bun:sqlite);
// - a world's forge as plain files while its forge is stopped (after its run, and nightly for stopped worlds that
//   changed). No sqlite3 inside the rootless forge image. Accepted gap: an active world's forge has no backup until
//   its run ends.
// - homes need none here: the VPS copy is the backup (§2.6).
// Each kind keeps the newest `keep` copies under <data>/backups/.
import type { Database } from "bun:sqlite";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { dataDir, worldDirs } from "./db/index.ts";

export const DEFAULT_KEEP = 7;

export function backupDirs(root = dataDir()) {
  const base = join(root, "backups");
  return { base, db: join(base, "db"), forges: join(base, "forges") };
}

const stamp = (t: number) => new Date(t).toISOString().replace(/[:.]/g, "-");

/** Keep the newest `keep` entries of a dir (names sort by time). */
function prune(dir: string, keep: number): void {
  if (!existsSync(dir)) return;
  const all = readdirSync(dir).filter((n) => !n.startsWith(".")).sort();
  for (const n of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(dir, n), { recursive: true, force: true });
}

/** A consistent copy of the controller DB. Returns its path. */
export function backupDb(db: Database, o: { keep?: number; now?: number; root?: string } = {}): string {
  const dir = backupDirs(o.root).db;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `swarm-${stamp(o.now ?? Date.now())}.db`);
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  prune(dir, o.keep ?? DEFAULT_KEEP);
  return file;
}

/** Newest mtime under a dir (symlinks not followed); 0 when missing. */
export function newestMtime(dir: string): number {
  let newest = 0;
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const st = lstatSync(join(d, n), { throwIfNoEntry: false });
      if (!st) continue;
      newest = Math.max(newest, st.mtimeMs);
      if (st.isDirectory()) walk(join(d, n));
    }
  };
  walk(dir);
  return newest;
}

/** When the world's forge was last backed up (ms; 0 never), from the newest backup's name. */
export function lastForgeBackup(world: string, root?: string): number {
  const dir = join(backupDirs(root).forges, world);
  if (!existsSync(dir)) return 0;
  const last = readdirSync(dir).filter((n) => !n.startsWith(".")).sort().at(-1);
  if (!last) return 0;
  const iso = last.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1:$2:$3.$4Z");
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Copy a stopped world's forge data as plain files. The caller makes sure the forge is not running. */
export function backupForge(world: string, o: { keep?: number; now?: number; root?: string } = {}): string | null {
  const src = worldDirs(world).forge;
  if (!existsSync(src)) return null;
  const dir = join(backupDirs(o.root).forges, world);
  mkdirSync(dir, { recursive: true });
  const name = stamp(o.now ?? Date.now());
  const dest = join(dir, name);
  // Hidden (leading dot) until complete: never listed, pruned or taken for the last backup.
  const tmp = join(dir, `.partial-${name}`);
  rmSync(tmp, { recursive: true, force: true });
  cpSync(src, tmp, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  // Only a complete copy gets its final name (and counts for retention).
  renameSync(tmp, dest);
  prune(dir, o.keep ?? DEFAULT_KEEP);
  return dest;
}

export interface BackupList {
  db: string[];
  forges: Record<string, string[]>;
}

export function listBackups(root?: string): BackupList {
  const d = backupDirs(root);
  const ls = (p: string) => (existsSync(p) ? readdirSync(p).filter((n) => !n.startsWith(".")).sort() : []);
  return { db: ls(d.db), forges: Object.fromEntries(ls(d.forges).map((w) => [w, ls(join(d.forges, w))])) };
}

/** Disk use of the data dir's filesystem (the dashboard warns when it runs low). */
export function diskUse(path = dataDir()): { totalBytes: number; freeBytes: number; freeRatio: number } | null {
  try {
    const s = statfsSync(path);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { totalBytes: total, freeBytes: free, freeRatio: total ? free / total : 1 };
  } catch {
    return null;
  }
}
