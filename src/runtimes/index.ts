import type { Runtime, RuntimeAdapter } from "../types.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { piAdapter } from "./pi.ts";

const ADAPTERS: Record<Runtime, RuntimeAdapter> = { claude: claudeAdapter, codex: codexAdapter, pi: piAdapter };

export function getAdapter(runtime: Runtime): RuntimeAdapter {
  const a = ADAPTERS[runtime];
  if (!a) throw new Error(`unknown runtime ${JSON.stringify(runtime)}`);
  return a;
}
