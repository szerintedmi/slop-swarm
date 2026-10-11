import { afterEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir } from "../src/db/index.ts";

const saved = process.env.SLOPSWARM_DATA_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.SLOPSWARM_DATA_DIR;
  else process.env.SLOPSWARM_DATA_DIR = saved;
});

test("SLOPSWARM_DATA_DIR: ~ is the home dir, relative paths are relative to the repo root", () => {
  process.env.SLOPSWARM_DATA_DIR = "~/somewhere/data";
  expect(dataDir()).toBe(join(homedir(), "somewhere/data"));
  process.env.SLOPSWARM_DATA_DIR = "../other/data";
  expect(dataDir()).toBe(join(import.meta.dir, "..", "..", "other/data"));
  process.env.SLOPSWARM_DATA_DIR = "/abs/data";
  expect(dataDir()).toBe("/abs/data");
});
