// Config in the DB (docs/plans/2026-10-12-hosted-control-plane.md §4): named seeds (versioned, one active version
// each; a preset picks one with `seed:`), agent profiles and swarm presets as YAML text, validated on save by the
// config parsers (no normalised columns). config/ in git holds the defaults loaded into an empty DB (`seeds/<name>.md`,
// `agents/<name>.yaml`, `<preset>.yaml`); `just config export | import` syncs files and DB. The allowlist and
// container limits are not here: they are config/host.yaml, deployed with the controller.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { AGENT_NAME_RE, buildSnapshot, ConfigError, DEFAULT_SEED, parseAgent, parseSwarm, SEED_NAME_RE, type SwarmConfig } from "./config.ts";
import { sha256 } from "./controller/run.ts";

export const CONFIG_DIR = join(import.meta.dir, "..", "config");
/** Files in config/ that aren't swarm presets. */
const NOT_PRESETS = new Set(["host.yaml", "pricing.yaml"]);
const PRESET_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export interface SeedRow {
  id: number;
  name: string;
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
// Seeds have names (presets pick one with `seed:`; `default` when they name none) and versions per name; exactly one
// version of each name is active.

/** Every version (newest first), of one seed or of all. */
export function listSeeds(db: Database, name?: string): SeedRow[] {
  return name === undefined
    ? db.query<SeedRow, []>("SELECT * FROM seeds ORDER BY name, id DESC").all()
    : db.query<SeedRow, [string]>("SELECT * FROM seeds WHERE name = ? ORDER BY id DESC").all(name);
}
export function activeSeed(db: Database, name = DEFAULT_SEED): SeedRow | null {
  return db.query<SeedRow, [string]>("SELECT * FROM seeds WHERE name = ? AND active = 1 ORDER BY id DESC LIMIT 1").get(name);
}
/** The active version of every seed, by name. */
export function activeSeeds(db: Database): SeedRow[] {
  return db.query<SeedRow, []>("SELECT * FROM seeds WHERE active = 1 ORDER BY name").all();
}
/**
 * A version of the named seed, made active: a new one, or the earlier version with the same text (so importing an
 * old text again re-activates it instead of duplicating it).
 */
export function saveSeed(db: Database, name: string, text: string, note: string | null = null, now = Date.now()): SeedRow {
  if (!SEED_NAME_RE.test(name)) throw new ConfigError(`seed name: must match ${SEED_NAME_RE}`);
  if (!text.trim()) throw new ConfigError(`seed ${name}: empty`);
  for (const p of ["{name}", "{forge_url}"]) if (!text.includes(p)) throw new ConfigError(`seed ${name}: missing the ${p} placeholder`);
  const same = db.query<SeedRow, [string, string]>("SELECT * FROM seeds WHERE name = ? AND sha256 = ? ORDER BY id DESC LIMIT 1").get(name, sha256(text));
  if (same) return same.active ? same : activateSeed(db, same.id);
  return db.transaction(() => {
    db.query("UPDATE seeds SET active = 0 WHERE name = ? AND active = 1").run(name);
    const r = db.query("INSERT INTO seeds (name, text, sha256, note, created_at, active) VALUES (?, ?, ?, ?, ?, 1)").run(name, text, sha256(text), note, now);
    return db.query<SeedRow, [number]>("SELECT * FROM seeds WHERE id = ?").get(Number(r.lastInsertRowid))!;
  })();
}
/** Make a version the active one of its seed. */
export function activateSeed(db: Database, id: number): SeedRow {
  const row = db.query<SeedRow, [number]>("SELECT * FROM seeds WHERE id = ?").get(id);
  if (!row) throw new ConfigError(`seed version ${id} not found`);
  db.transaction(() => {
    db.query("UPDATE seeds SET active = 0 WHERE name = ? AND active = 1").run(row.name);
    db.query("UPDATE seeds SET active = 1 WHERE id = ?").run(id);
  })();
  return { ...row, active: 1 };
}
/** Delete a seed with all its versions; not `default`, and not one a preset names. */
export function deleteSeed(db: Database, name: string): void {
  if (name === DEFAULT_SEED) throw new ConfigError(`the ${DEFAULT_SEED} seed can't be deleted (presets without seed: use it)`);
  const users = listPresets(db).filter((p) => presetSeedName(p.yaml) === name).map((p) => p.name);
  if (users.length) throw new ConfigError(`seed ${name} is in preset(s) ${users.join(", ")}`);
  if (!listSeeds(db, name).length) throw new ConfigError(`seed ${name} not found`);
  db.query("DELETE FROM seeds WHERE name = ?").run(name);
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
function presetSeedName(yaml: string): string {
  try {
    const raw = Bun.YAML.parse(yaml) as { seed?: unknown };
    return typeof raw?.seed === "string" ? raw.seed : DEFAULT_SEED;
  } catch {
    return DEFAULT_SEED;
  }
}
/** Validate (parseSwarm against the stored agent profiles; its seed must exist) and store a preset. */
export function savePreset(db: Database, name: string, yaml: string, now = Date.now()): ConfigRow {
  if (!PRESET_NAME_RE.test(name)) throw new ConfigError(`preset name: must match ${PRESET_NAME_RE}`);
  const cfg = parseSwarm(parseYaml(yaml, `preset ${name}`), (agent) => {
    const p = getAgentProfile(db, agent);
    if (!p) throw new ConfigError(`preset ${name}: no agent profile ${agent}`);
    return parseYaml(p.yaml, `agents/${agent}.yaml`);
  });
  if (!activeSeed(db, cfg.seed)) throw new ConfigError(`preset ${name}: no seed ${cfg.seed} (seeds: ${activeSeeds(db).map((s) => s.name).join(", ") || "none"})`);
  db.query("INSERT INTO swarm_presets (name, yaml, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET yaml = excluded.yaml, updated_at = excluded.updated_at").run(name, yaml, now);
  return { name, yaml, updated_at: now };
}
export function deletePreset(db: Database, name: string): void {
  db.query("DELETE FROM swarm_presets WHERE name = ?").run(name);
}

// ---- files <-> DB ----

/** Load config/ (or `dir`) into an empty DB: the seeds, profiles and presets. Returns what was loaded. */
export function ensureConfigDefaults(db: Database, dir = CONFIG_DIR): string[] {
  const empty = !listSeeds(db).length && !listAgentProfiles(db).length && !listPresets(db).length;
  return empty ? importConfig(db, dir, "defaults from config/") : [];
}

/**
 * Files -> DB: every agent profile in `dir/agents/`, every seed in `dir/seeds/` (`<name>.md`, a new active version
 * when the text is new), every preset (`dir/*.yaml` but host.yaml and pricing.yaml). Profiles and seeds go first
 * (presets are checked against them). All or nothing.
 */
export function importConfig(db: Database, dir = CONFIG_DIR, note = "import"): string[] {
  return importBundle(db, bundleFromDir(dir), note);
}

/** DB -> files: every profile, every seed's active version, every preset. Files of rows not in the DB are left alone. */
export function exportConfig(db: Database, dir = CONFIG_DIR): string[] {
  return writeBundle(configBundle(db), dir);
}

/**
 * A run's config from a preset and the stored profiles, with its snapshot (the preset, each profile used, and the
 * host config). Prices still come from config/pricing.yaml (the controller's own table).
 */
export function swarmFromPreset(db: Database, name: string, o: { hostYaml?: string; configDir?: string } = {}): { cfg: SwarmConfig; seed: SeedRow } {
  const preset = getPreset(db, name);
  if (!preset) throw new ConfigError(`preset not found: ${name} (presets: ${listPresets(db).map((p) => p.name).join(", ") || "none"})`);
  const used: [string, string][] = [];
  const parsed = parseSwarm(parseYaml(preset.yaml, `preset ${name}`), (agent) => {
    const p = getAgentProfile(db, agent);
    if (!p) throw new ConfigError(`preset ${name}: no agent profile ${agent}`);
    used.push([agent, p.yaml]);
    return parseYaml(p.yaml, `agents/${agent}.yaml`);
  });
  const seed = activeSeed(db, parsed.seed);
  if (!seed) throw new ConfigError(`preset ${name}: no seed ${parsed.seed} (\`just config import\` loads config/seeds/)`);
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
  /** Each seed's active text, by name. */
  seeds?: Record<string, { text: string; note?: string | null }>;
}

export function configBundle(db: Database): ConfigBundle {
  return {
    agents: Object.fromEntries(listAgentProfiles(db).map((a) => [a.name, a.yaml])),
    presets: Object.fromEntries(listPresets(db).map((p) => [p.name, p.yaml])),
    seeds: Object.fromEntries(activeSeeds(db).map((s) => [s.name, { text: s.text, note: s.note }])),
  };
}

/** Import a bundle: profiles and seeds, then presets (checked against them). All or nothing. */
export function importBundle(db: Database, b: ConfigBundle, note = "import"): string[] {
  const out: string[] = [];
  db.transaction(() => {
    for (const [name, yaml] of Object.entries(b.agents ?? {})) {
      saveAgentProfile(db, name, String(yaml));
      out.push(`agent ${name}`);
    }
    for (const [name, seed] of Object.entries(b.seeds ?? {})) {
      const before = activeSeed(db, name)?.id;
      const s = saveSeed(db, name, String(seed?.text ?? ""), seed?.note ?? note);
      if (s.id !== before) out.push(`seed ${name} v${s.id}`);
    }
    for (const [name, yaml] of Object.entries(b.presets ?? {})) {
      savePreset(db, name, String(yaml));
      out.push(`preset ${name}`);
    }
  })();
  return out;
}

/** config/ (or `dir`) as a bundle, for importing through the API. */
export function bundleFromDir(dir = CONFIG_DIR): ConfigBundle {
  const agentsDir = join(dir, "agents");
  const agents = existsSync(agentsDir) ? Object.fromEntries(readdirSync(agentsDir).filter((f) => f.endsWith(".yaml")).sort().map((f) => [basename(f, ".yaml"), readFileSync(join(agentsDir, f), "utf8")])) : {};
  const presets = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".yaml") && !NOT_PRESETS.has(f)).sort().map((f) => [basename(f, ".yaml"), readFileSync(join(dir, f), "utf8")]));
  const seedsDir = join(dir, "seeds");
  const seeds = existsSync(seedsDir) ? Object.fromEntries(readdirSync(seedsDir).filter((f) => f.endsWith(".md")).sort().map((f) => [basename(f, ".md"), { text: readFileSync(join(seedsDir, f), "utf8") }])) : {};
  return { agents, presets, seeds };
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
  if (Object.keys(b.seeds ?? {}).length) mkdirSync(join(dir, "seeds"), { recursive: true });
  for (const [n, s] of Object.entries(b.seeds ?? {})) {
    writeFileSync(join(dir, "seeds", `${n}.md`), s.text);
    out.push(`seeds/${n}.md`);
  }
  return out;
}
