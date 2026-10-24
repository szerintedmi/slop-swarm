// The CLI compiles the UI before serving it; unchanged sources reuse the local build.
// Each build lands in its own build/dashboard/<hash>/ (written to a temp dir, then renamed), so
// a rebuild never touches the files a running dashboard is still serving lazily.
import { createHash } from 'node:crypto';
import { existsSync, openSync, closeSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const buildRoot = join(projectRoot, 'build/dashboard');
const KEEP_BUILDS = 3;
let current: Promise<string> | undefined;

// The UI bundle only takes values from src/dashboard (UI, format.ts); other src/ imports are type-only.
function sourceHash() {
  const hash = createHash('sha256');
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) { hash.update(path); hash.update(readFileSync(path)); }
    }
  }
  walk(join(projectRoot, 'src/dashboard'));
  if (existsSync(join(projectRoot, 'static'))) walk(join(projectRoot, 'static'));
  for (const name of ['vite.config.ts', 'package.json', 'bun.lock', 'tsconfig.ui.json', 'tsconfig.json']) hash.update(readFileSync(join(projectRoot, name)));
  return hash.digest('hex').slice(0, 16);
}

const complete = (dir: string) => existsSync(join(dir, 'server/instance.js'));

// vite writes .svelte-kit/ in place, so concurrent builds (two worktree commands) take turns.
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = join(buildRoot, '.lock');
  mkdirSync(buildRoot, { recursive: true });
  for (;;) {
    try { closeSync(openSync(lock, 'wx')); writeFileSync(lock, String(process.pid)); break; } catch { /* held */ }
    const pid = Number(readFileSync(lock, 'utf8').trim()) || 0;
    let alive = false;
    try { if (pid) { process.kill(pid, 0); alive = true; } } catch { /* gone */ }
    if (!alive && pid) { rmSync(lock, { force: true }); continue; }
    await Bun.sleep(200);
  }
  try { return await fn(); } finally { rmSync(lock, { force: true }); }
}

/** Old builds may still be served by a long-running dashboard; keep the most recent few. */
function prune(keep: string) {
  const dirs = readdirSync(buildRoot, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && join(buildRoot, e.name) !== keep)
    .map(e => join(buildRoot, e.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const dir of dirs.slice(KEEP_BUILDS - 1)) rmSync(dir, { recursive: true, force: true });
}

/** Resolves to the build directory for the current sources. Checked once per process unless forced. */
export function buildDashboard(force = false): Promise<string> {
  if (current && !force) return current;
  current = (async () => {
    const hash = sourceHash(), dir = join(buildRoot, hash);
    if (!force && complete(dir)) return dir;
    return withLock(async () => {
      if (!force && complete(dir)) return dir; // another process built it while we waited
      const tmp = join(buildRoot, `.tmp-${hash}-${process.pid}`);
      rmSync(tmp, { recursive: true, force: true });
      const proc = Bun.spawn([process.execPath, '--no-env-file', '--bun', 'vite', 'build'], { cwd: projectRoot, env: { ...process.env, NODE_ENV: 'production', SLOPSWARM_DASHBOARD_OUT: tmp }, stdout: 'inherit', stderr: 'inherit' });
      if (await proc.exited !== 0) { rmSync(tmp, { recursive: true, force: true }); throw new Error('Dashboard build failed'); }
      // A forced rebuild of the same hash moves the old copy aside rather than deleting it under a server.
      if (existsSync(dir)) renameSync(dir, join(buildRoot, `${hash}-${Date.now()}`));
      renameSync(tmp, dir);
      prune(dir);
      return dir;
    });
  })();
  current.catch(() => { current = undefined; });
  return current;
}
