// Config in the DB (docs/plans/2026-10-12-hosted-control-plane.md §4): seed versions, agent profiles and swarm
// presets as YAML text, validated on save by the config parsers (no normalised columns). config/ in git holds the
// defaults loaded into an empty DB; `just config export | import` syncs files and DB. The allowlist and container
// limits are not here: they are config/host.yaml, deployed with the controller.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { AGENT_NAME_RE, buildSnapshot, ConfigError, parseAgent, parseSwarm, type SwarmConfig } from "./config.ts";
import { sha256 } from "./controller/run.ts";

export const CONFIG_DIR = join(import.meta.dir, "..", "config");
/** Files in config/ that aren't swarm presets. */
const NOT_PRESETS = new Set(["host.yaml", "pricing.yaml"]);
const PRESET_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export interface SeedRow {
  id: number;
  text: string;
  sha256: string;
  note: string | null;
  created_at: number;
  active: number;
}
export interface ConfigRow {
  name: string;
  yaml: string;
  updated_at: number;
}

function parseYaml(text: string, what: string): unknown {
  try {
    return Bun.YAML.parse(text);
  } catch (e) {
    throw new ConfigError(`${what}: not valid YAML: ${(e as Error).message}`);
  }
}

// ---- seeds ----

export function listSeeds(db: Database): SeedRow[] {
  return db.query<SeedRow, []>("SELECT * FROM seeds ORDER BY id DESC").all();
}
export function activeSeed(db: Database): SeedRow | null {
  return db.query<SeedRow, []>("SELECT * FROM seeds WHERE active = 1 ORDER BY id DESC LIMIT 1").get();
}
/** A new seed version, made active (the same text as the active one is not a new version). */
export function saveSeed(db: Database, text: string, note: string | null = null, now = Date.now()): SeedRow {
  if (!text.trim()) throw new ConfigError("seed: empty");
  for (const p of ["{name}", "{forge_url}"]) if (!text.includes(p)) throw new ConfigError(`seed: missing the ${p} placeholder`);
  const cur = activeSeed(db);
  if (cur && cur.text === text) return cur;
  return db.transaction(() => {
    db.query("UPDATE seeds SET active = 0 WHERE active = 1").run();
    const r = db.query("INSERT INTO seeds (text, sha256, note, created_at, active) VALUES (?, ?, ?, ?, 1)").run(text, sha256(text), note, now);
    return db.query<SeedRow, [number]>("SELECT * FROM seeds WHERE id = ?").get(Number(r.lastInsertRowid))!;
  })();
}
export function activateSeed(db: Database, id: number): SeedRow {
  const row = db.query<SeedRow, [number]>("SELECT * FROM seeds WHERE id = ?").get(id);
  if (!row) throw new ConfigError(`seed version ${id} not found`);
  db.transaction(() => {
    db.query("UPDATE seeds SET active = 0 WHERE active = 1").run();
    db.query("UPDATE seeds SET active = 1 WHERE id = ?").run(id);
  })();
  return { ...row, active: 1 };
}

// ---- agent profiles ----

export function listAgentProfiles(db: Database): ConfigRow[] {
  return db.query<ConfigRow, []>("SELECT * FROM agent_profiles ORDER BY name").all();
}
export function getAgentProfile(db: Database, name: string): ConfigRow | null {
  return db.query<ConfigRow, [string]>("SELECT * FROM agent_profiles WHERE name = ?").get(name);
}
/** Validate (parseAgent; the name must match) and store an agent profile. */
export function saveAgentProfile(db: Database, name: string, yaml: string, now = Date.now()): ConfigRow {
  if (!AGENT_NAME_RE.test(name)) throw new ConfigError(`agent profile name: must match ${AGENT_NAME_RE}`);
  const a = parseAgent(parseYaml(yaml, `agents/${name}.yaml`), 1, `agents/${name}.yaml`);
  if (a.name !== name) throw new ConfigError(`agents/${name}.yaml: name is ${a.name}, expected ${name}`);
  db.query("INSERT INTO agent_profiles (name, yaml, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET yaml = excluded.yaml, updated_at = excluded.updated_at").run(name, yaml, now);
  return { name, yaml, updated_at: now };
}
export function deleteAgentProfile(db: Database, name: string): void {
  const users = listPresets(db).filter((p) => presetAgentNames(p.yaml).includes(name)).map((p) => p.name);
  if (users.length) throw new ConfigError(`agent ${name} is in preset(s) ${users.join(", ")}`);
  db.query("DELETE FROM agent_profiles WHERE name = ?").run(name);
}

// ---- presets ----

export function listPresets(db: Database): ConfigRow[] {
  return db.query<ConfigRow, []>("SELECT * FROM swarm_presets ORDER BY name").all();
}
export function getPreset(db: Database, name: string): ConfigRow | null {
  return db.query<ConfigRow, [string]>("SELECT * FROM swarm_presets WHERE name = ?").get(name);
}
function presetAgentNames(yaml: string): string[] {
  try {
    const raw = Bun.YAML.parse(yaml) as { agents?: unknown[] };
    return (raw?.agents ?? []).map((a) => (typeof a === "string" ? a : String((a as { name?: unknown })?.name ?? "")));
  } catch {
    return [];
  }
}
/** Validate (parseSwarm against the stored agent profiles) and store a preset. */
export function savePreset(db: Database, name: string, yaml: string, now = Date.now()): ConfigRow {
  if (!PRESET_NAME_RE.test(name)) throw new ConfigError(`preset name: must match ${PRESET_NAME_RE}`);
  parseSwarm(parseYaml(yaml, `preset ${name}`), (agent) => {
    const p = getAgentProfile(db, agent);
    if (!p) throw new ConfigError(`preset ${name}: no agent profile ${agent}`);
    return parseYaml(p.yaml, `agents/${agent}.yaml`);
  });
  db.query("INSERT INTO swarm_presets (name, yaml, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET yaml = excluded.yaml, updated_at = excluded.updated_at").run(name, yaml, now);
  return { name, yaml, updated_at: now };
}
export function deletePreset(db: Database, name: string): void {
  db.query("DELETE FROM swarm_presets WHERE name = ?").run(name);
}

// ---- files <-> DB ----

/** Load config/ (or `dir`) into an empty DB: the default seed, profiles and presets. Returns what was loaded. */
export function ensureConfigDefaults(db: Database, dir = CONFIG_DIR): string[] {
  const empty = !activeSeed(db) && !listAgentProfiles(db).length && !listPresets(db).length;
  return empty ? importConfig(db, dir, "defaults from config/") : [];
}

/**
 * Files -> DB: every agent profile in `dir/agents/`, every preset (`dir/*.yaml` but host.yaml and pricing.yaml), the
 * seed (`dir/seed.md`, a new version if it differs). Profiles go first (presets are checked against them). All or
 * nothing.
 */
export function importConfig(db: Database, dir = CONFIG_DIR, note = "import"): string[] {
  const out: string[] = [];
  db.transaction(() => {
    const agentsDir = join(dir, "agents");
    if (existsSync(agentsDir))
      for (const f of readdirSync(agentsDir).filter((f) => f.endsWith(".yaml")).sort()) {
        saveAgentProfile(db, basename(f, ".yaml"), readFileSync(join(agentsDir, f), "utf8"));
        out.push(`agent ${basename(f, ".yaml")}`);
      }
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".yaml") && !NOT_PRESETS.has(f)).sort()) {
      savePreset(db, basename(f, ".yaml"), readFileSync(join(dir, f), "utf8"));
      out.push(`preset ${basename(f, ".yaml")}`);
    }
    const seedFile = join(dir, "seed.md");
    if (existsSync(seedFile)) {
      const before = activeSeed(db)?.id;
      const s = saveSeed(db, readFileSync(seedFile, "utf8"), note);
      if (s.id !== before) out.push(`seed v${s.id}`);
    }
  })();
  return out;
}

/** DB -> files: the active seed, every profile and preset. Files of profiles or presets not in the DB are left alone. */
export function exportConfig(db: Database, dir = CONFIG_DIR): string[] {
  const out: string[] = [];
  mkdirSync(join(dir, "agents"), { recursive: true });
  for (const a of listAgentProfiles(db)) {
    writeFileSync(join(dir, "agents", `${a.name}.yaml`), a.yaml);
    out.push(`agents/${a.name}.yaml`);
  }
  for (const p of listPresets(db)) {
    writeFileSync(join(dir, `${p.name}.yaml`), p.yaml);
    out.push(`${p.name}.yaml`);
  }
  const s = activeSeed(db);
  if (s) {
    writeFileSync(join(dir, "seed.md"), s.text);
    out.push(`seed.md (v${s.id})`);
  }
  return out;
}

/**
 * A run's config from a preset and the stored profiles, with its snapshot (the preset, each profile used, and the
 * host config). Prices still come from config/pricing.yaml (the controller's own table).
 */
export function swarmFromPreset(db: Database, name: string, o: { hostYaml?: string; configDir?: string } = {}): { cfg: SwarmConfig; seed: SeedRow } {
  const preset = getPreset(db, name);
  if (!preset) throw new ConfigError(`preset not found: ${name} (presets: ${listPresets(db).map((p) => p.name).join(", ") || "none"})`);
  const seed = activeSeed(db);
  if (!seed) throw new ConfigError("no active seed (`just config import` loads config/seed.md)");
  const used: [string, string][] = [];
  const parsed = parseSwarm(parseYaml(preset.yaml, `preset ${name}`), (agent) => {
    const p = getAgentProfile(db, agent);
    if (!p) throw new ConfigError(`preset ${name}: no agent profile ${agent}`);
    used.push([agent, p.yaml]);
    return parseYaml(p.yaml, `agents/${agent}.yaml`);
  });
  const configDir = o.configDir ?? CONFIG_DIR;
  return {
    cfg: {
      ...parsed,
      paths: { swarm: `preset:${name}`, seed: "", pricing: join(configDir, "pricing.yaml"), configDir },
      snapshot: buildSnapshot(`preset:${name}`, preset.yaml, used, o.hostYaml),
    },
    seed,
  };
}

/** The DB's config as one JSON bundle (the API's export; `just config export` writes it as files). */
export interface ConfigBundle {
  agents: Record<string, string>;
  presets: Record<string, string>;
  seed?: { text: string; note?: string | null };
}

export function configBundle(db: Database): ConfigBundle {
  const seed = activeSeed(db);
  return {
    agents: Object.fromEntries(listAgentProfiles(db).map((a) => [a.name, a.yaml])),
    presets: Object.fromEntries(listPresets(db).map((p) => [p.name, p.yaml])),
    ...(seed ? { seed: { text: seed.text, note: seed.note } } : {}),
  };
}

/** Import a bundle: profiles, then presets (checked against them), then the seed. All or nothing. */
export function importBundle(db: Database, b: ConfigBundle, note = "import"): string[] {
  const out: string[] = [];
  db.transaction(() => {
    for (const [name, yaml] of Object.entries(b.agents ?? {})) {
      saveAgentProfile(db, name, String(yaml));
      out.push(`agent ${name}`);
    }
    for (const [name, yaml] of Object.entries(b.presets ?? {})) {
      savePreset(db, name, String(yaml));
      out.push(`preset ${name}`);
    }
    if (b.seed?.text) {
      const before = activeSeed(db)?.id;
      const s = saveSeed(db, b.seed.text, b.seed.note ?? note);
      if (s.id !== before) out.push(`seed v${s.id}`);
    }
  })();
  return out;
}

/** config/ (or `dir`) as a bundle, for importing through the API. */
export function bundleFromDir(dir = CONFIG_DIR): ConfigBundle {
  const agentsDir = join(dir, "agents");
  const agents = existsSync(agentsDir) ? Object.fromEntries(readdirSync(agentsDir).filter((f) => f.endsWith(".yaml")).sort().map((f) => [basename(f, ".yaml"), readFileSync(join(agentsDir, f), "utf8")])) : {};
  const presets = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".yaml") && !NOT_PRESETS.has(f)).sort().map((f) => [basename(f, ".yaml"), readFileSync(join(dir, f), "utf8")]));
  const seedFile = join(dir, "seed.md");
  return { agents, presets, ...(existsSync(seedFile) ? { seed: { text: readFileSync(seedFile, "utf8") } } : {}) };
}

/** Write a bundle as files (`just config export` through the API). */
export function writeBundle(b: ConfigBundle, dir = CONFIG_DIR): string[] {
  const out: string[] = [];
  mkdirSync(join(dir, "agents"), { recursive: true });
  for (const [n, y] of Object.entries(b.agents)) {
    writeFileSync(join(dir, "agents", `${n}.yaml`), y);
    out.push(`agents/${n}.yaml`);
  }
  for (const [n, y] of Object.entries(b.presets)) {
    writeFileSync(join(dir, `${n}.yaml`), y);
    out.push(`${n}.yaml`);
  }
  if (b.seed) {
    writeFileSync(join(dir, "seed.md"), b.seed.text);
    out.push("seed.md");
  }
  return out;
}
