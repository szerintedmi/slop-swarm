// The controller lock: one controller per data dir. It is a `flock(2)` on `<dataDir>/controller.lock`, taken through
// Bun's FFI since neither Bun nor Node exposes file locks. The kernel holds it on the open file descriptor and
// releases it when the process dies, however it dies, so there is no stale state to detect and nothing to recover
// by guesswork (an age or a pid can't tell a dead acquirer from a slow one). A busy or still-starting controller
// holds it just the same. Each open file description is its own lock owner, so two acquirers in one process
// exclude each other too. The pid file next to it is for display only (`just status`).
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class LockError extends Error {}

export const lockFilePath = (dataDir: string) => join(dataDir, "controller.lock");
export const lockPidPath = (dataDir: string) => join(dataDir, "controller.pid");

// Same values on Linux and macOS.
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

let libc: { symbols: { flock: (fd: number, op: number) => number } } | null = null;
function flock(fd: number, op: number): number {
  if (!libc) {
    const candidates = process.platform === "darwin" ? ["libc.dylib", "libSystem.B.dylib"] : ["libc.so.6", "libc.so", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1"];
    let err: unknown;
    for (const name of candidates) {
      try {
        libc = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
        break;
      } catch (e) {
        err = e;
      }
    }
    if (!libc) throw new LockError(`cannot load flock from libc (${candidates.join(", ")}): ${(err as Error)?.message ?? err}`);
  }
  return libc.symbols.flock(fd, op);
}

/** Open the lock file and try the lock without waiting; the fd is returned only when it was taken. */
function tryLock(dataDir: string): number | null {
  mkdirSync(dataDir, { recursive: true });
  const fd = openSync(lockFilePath(dataDir), "a");
  if (flock(fd, LOCK_EX | LOCK_NB) === 0) return fd;
  closeSync(fd);
  return null;
}

/** Whether a process holds the controller lock of `dataDir`. */
export function lockHeld(dataDir: string): boolean {
  const fd = tryLock(dataDir);
  if (fd === null) return true;
  flock(fd, LOCK_UN);
  closeSync(fd);
  return false;
}

export interface ControllerLock {
  file: string;
  release(): void;
}

/** Take the lock for `dataDir`, or throw LockError when another process (or this one, elsewhere) holds it. */
export function takeControllerLock(dataDir: string): ControllerLock {
  const fd = tryLock(dataDir);
  if (fd === null) throw new LockError(`a controller is already running for ${dataDir} (${lockFilePath(dataDir)} is locked)`);
  const pidFile = lockPidPath(dataDir);
  writeFileSync(pidFile, String(process.pid));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    flock(fd, LOCK_UN);
    closeSync(fd);
    try {
      if (readFileSync(pidFile, "utf8") === String(process.pid)) rmSync(pidFile, { force: true });
    } catch {
      /* gone */
    }
  };
  return { file: lockFilePath(dataDir), release };
}
