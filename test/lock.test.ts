// The controller lock (src/lock.ts): a kernel-held flock, so a busy, slow or starting controller still holds it, a
// dead one doesn't, and no acquirer can ever take it away from a live one.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockHeld, lockPidPath, takeControllerLock } from "../src/lock.ts";

const dataDir = mkdtempSync(join(tmpdir(), "slopswarm-lock-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const LOCK_TS = join(import.meta.dir, "..", "src", "lock.ts");
/** A child process that takes the lock, holds it for `holdMs`, and prints `won` or `lost:<reason>`. */
const holder = (holdMs: number) =>
  Bun.spawn(
    ["bun", "-e", `const { takeControllerLock } = await import(${JSON.stringify(LOCK_TS)});
      try { const l = takeControllerLock(${JSON.stringify(dataDir)}); process.stdout.write("won"); await Bun.sleep(${holdMs}); l.release(); }
      catch (e) { process.stdout.write("lost:" + e.message); }`],
    { stdout: "pipe", stderr: "pipe" },
  );

describe("controller lock", () => {
  test("one holder at a time, in this process or another; released on release", async () => {
    expect(lockHeld(dataDir)).toBe(false);
    const lock = takeControllerLock(dataDir);
    expect(lockHeld(dataDir)).toBe(true);
    expect(readFileSync(lockPidPath(dataDir), "utf8")).toBe(String(process.pid));
    expect(() => takeControllerLock(dataDir)).toThrow(/already running/);
    const other = holder(0);
    expect(await new Response(other.stdout).text()).toMatch(/^lost:.*already running/);
    lock.release();
    expect(lockHeld(dataDir)).toBe(false);
    expect(existsSync(lockPidPath(dataDir))).toBe(false);
  });

  test("the lock dies with its holder, and not before: a killed holder frees it, a slow one keeps it", async () => {
    const slow = holder(60_000);
    // The first chunk only: stdout stays open while the child holds the lock.
    const first = await slow.stdout.getReader().read();
    expect(new TextDecoder().decode(first.value)).toBe("won");
    // Blocked for a while (far longer than any expiry heuristic would allow): still held.
    expect(lockHeld(dataDir)).toBe(true);
    await Bun.sleep(300);
    expect(lockHeld(dataDir)).toBe(true);
    expect(() => takeControllerLock(dataDir)).toThrow(/already running/);
    slow.kill(9);
    await slow.exited;
    expect(lockHeld(dataDir)).toBe(false);
    const lock = takeControllerLock(dataDir);
    lock.release();
  });

  test("concurrent acquirers in two processes: exactly one wins", async () => {
    const procs = [holder(300), holder(300)];
    const outs = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
    await Promise.all(procs.map((p) => p.exited));
    expect(outs.filter((o) => o === "won")).toHaveLength(1);
    expect(outs.filter((o) => o.startsWith("lost:"))).toHaveLength(1);
    expect(lockHeld(dataDir)).toBe(false);
  });

  test("a busy holder still holds it (no event-loop turn needed)", async () => {
    const lock = takeControllerLock(dataDir);
    const probe = Bun.spawn(["bun", "-e", `const { lockHeld } = await import(${JSON.stringify(LOCK_TS)}); process.stdout.write(String(lockHeld(${JSON.stringify(dataDir)})))`], { stdout: "pipe", stderr: "pipe" });
    const out = new Response(probe.stdout).text();
    Bun.sleepSync(300); // this process is blocked while the probe runs
    expect((await out).trim()).toBe("true");
    lock.release();
  });
});
