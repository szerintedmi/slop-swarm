import type { Harness, HarnessAdapter } from "../types.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { piAdapter } from "./pi.ts";

const ADAPTERS: Record<Harness, HarnessAdapter> = { claude: claudeAdapter, codex: codexAdapter, pi: piAdapter };

export function getAdapter(harness: Harness): HarnessAdapter {
  const a = ADAPTERS[harness];
  if (!a) throw new Error(`unknown harness ${JSON.stringify(harness)}`);
  return a;
}
