// The agent card's "last said": the final assistant text, read from the tail of each harness's raw log.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { lastSaid } from "../src/dashboard/data.ts";
import type { WakeRow } from "../src/db/index.ts";

const wake = (fixture: string) => ({ raw_log_path: join(import.meta.dir, "fixtures", fixture) }) as WakeRow;

describe("lastSaid", () => {
  test("claude, codex and pi each yield their final assistant text", () => {
    expect(lastSaid(wake("claude-hi.jsonl"))).toBeTruthy();
    expect(lastSaid(wake("codex-hi.jsonl"))).toBeTruthy();
    expect(lastSaid(wake("pi-hi.jsonl"))).toStartWith("Hi there!");
  });

  test("no log, no words", () => {
    expect(lastSaid(undefined)).toBeNull();
    expect(lastSaid({ raw_log_path: null } as unknown as WakeRow)).toBeNull();
  });
});
