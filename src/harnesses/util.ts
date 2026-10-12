import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function short(s: string, max = 200): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function parseJsonLine(line: string): Record<string, any> | undefined {
  const t = line.trim();
  if (!t.startsWith("{")) return undefined;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function readJsonLines(path: string): Record<string, any>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map(parseJsonLine)
    .filter((x): x is Record<string, any> => x !== undefined);
}

export function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Recursively list files under `dir` whose basename satisfies `match`. Missing dir -> []. */
export function findFiles(dir: string, match: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...findFiles(p, match));
    else if (match(e.name)) out.push(p);
  }
  return out;
}
