// Config in the DB (docs/plans/2026-10-12-hosted-control-plane.md §4): validate on save, export/import round trip,
// a run's config and snapshot built from DB rows.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_SNAPSHOT_KEY, loadSwarm, swarmFromSnapshot } from "../src/config.ts";
import {
  activateSeed,
  activeSeed,
  activeSeeds,
  deleteAgentProfile,
  deleteSeed,
  ensureConfigDefaults,
  exportConfig,
  importConfig,
  listAgentProfiles,
  listPresets,
  listSeeds,
  saveAgentProfile,
  savePreset,
  saveSeed,
  swarmFromPreset,
} from "../src/config-db.ts";
import { Database } from "bun:sqlite";
import { openDb } from "../src/db/index.ts";

const tmp = mkdtempSync(join(tmpdir(), "slopswarm-configdb-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("config in the DB", () => {
  test("an empty DB gets config/ as defaults, once", () => {
    const db = openDb(":memory:");
    const loaded = ensureConfigDefaults(db);
    expect(loaded).toContain("preset smoke");
    expect(loaded).toContain("agent bramble");
    expect(loaded).toContain("seed default v1");
    expect(loaded).toContain("seed shock v2");
    expect(listPresets(db).map((p) => p.name)).toEqual(["shock", "smoke", "swarm"]);
    expect(listAgentProfiles(db).map((a) => a.name)).toEqual(["bramble", "fern", "sorrel", "thistle", "wren"]);
    expect(activeSeed(db)!.text).toBe(readFileSync("config/seeds/default.md", "utf8"));
    expect(activeSeed(db, "shock")!.text).toBe(readFileSync("config/seeds/shock.md", "utf8"));
    expect(ensureConfigDefaults(db)).toEqual([]);
  });

  test("validate on save: profiles, presets against profiles, seeds", () => {
    const db = openDb(":memory:");
    ensureConfigDefaults(db);
    expect(() => saveAgentProfile(db, "bramble", "name: bramble\nharness: gemini\nmodel: m\n")).toThrow(/harness/);
    expect(() => saveAgentProfile(db, "bramble", "name: thistle\nharness: claude\nmodel: m\n")).toThrow(/expected bramble/);
    expect(() => saveAgentProfile(db, "bramble", "name: [unclosed")).toThrow(/YAML/);
    expect(() => saveAgentProfile(db, "Bad", "name: Bad\n")).toThrow(/name/);
    const smoke = listPresets(db).find((p) => p.name === "smoke")!.yaml;
    expect(() => savePreset(db, "x", smoke.replace("agents: [bramble, sorrel, wren, fern]", "agents: [bramble, ghost]"))).toThrow(/no agent profile ghost/);
    expect(() => savePreset(db, "x", smoke.replace("max_duration_min: 8", "max_duration_min: 1"))).toThrow(/max_sleep_min/);
    expect(() => savePreset(db, "Bad Name", smoke)).toThrow(/preset name/);
    expect(() => savePreset(db, "x", smoke.replace("seed: default", "seed: ghost"))).toThrow(/no seed ghost \(seeds: default, shock\)/);
    expect(() => savePreset(db, "x", smoke.replace("seed: default", "seed: Bad"))).toThrow(/seed: must match/);
    expect(() => saveSeed(db, "default", "no placeholders")).toThrow(/\{name\}/);
    expect(() => saveSeed(db, "Bad Name", "You are {name} at {forge_url}.\n")).toThrow(/seed name/);
    // The stored rows didn't change.
    expect(listPresets(db).map((p) => p.name)).toEqual(["shock", "smoke", "swarm"]);
    // A profile or seed in use can't be deleted; nor the default seed.
    expect(() => deleteAgentProfile(db, "fern")).toThrow(/smoke/);
    expect(() => deleteSeed(db, "shock")).toThrow(/preset\(s\) shock/);
    expect(() => deleteSeed(db, "default")).toThrow(/can't be deleted/);
    expect(() => deleteSeed(db, "ghost")).toThrow(/not found/);
  });

  test("seeds are versioned per name; a known text re-activates its version; one active version per name", () => {
    const db = openDb(":memory:");
    ensureConfigDefaults(db);
    const v1 = activeSeed(db)!;
    expect(saveSeed(db, "default", v1.text).id).toBe(v1.id);
    const v3 = saveSeed(db, "default", v1.text + "\nBe kind.\n", "tweak");
    expect(v3.id).toBeGreaterThan(v1.id);
    expect(activeSeed(db)!.id).toBe(v3.id);
    // The shock seed is untouched by the default's versions.
    expect(activeSeed(db, "shock")!.id).toBe(2);
    activateSeed(db, v1.id);
    expect(activeSeed(db)!.id).toBe(v1.id);
    // Saving the v3 text again activates v3 rather than adding a v4.
    expect(saveSeed(db, "default", v3.text).id).toBe(v3.id);
    expect(activeSeed(db)!.id).toBe(v3.id);
    expect(listSeeds(db).filter((s) => s.active).map((s) => s.name)).toEqual(["default", "shock"]);
    expect(listSeeds(db, "default")).toHaveLength(2);
    // A new seed, then deleted with its versions once no preset names it.
    const calm = saveSeed(db, "calm", "You are {name}. Forge {forge_url}.\n");
    expect(calm).toMatchObject({ name: "calm", active: 1 });
    expect(activeSeeds(db).map((s) => s.name)).toEqual(["calm", "default", "shock"]);
    deleteSeed(db, "calm");
    expect(listSeeds(db, "calm")).toEqual([]);
    expect(() => activateSeed(db, calm.id)).toThrow(/not found/);
  });

  test("an old DB's seed versions become the default seed, its active one stays active", () => {
    const path = join(tmp, "old.sqlite");
    const old = new Database(path, { create: true });
    old.exec("CREATE TABLE seeds (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, sha256 TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 0)");
    old.exec("INSERT INTO seeds (text, sha256, note, created_at, active) VALUES ('You are {name} at {forge_url}. v1', 'a', NULL, 1, 0), ('You are {name} at {forge_url}. v2', 'b', 'tweak', 2, 1)");
    old.close();
    const db = openDb(path);
    expect(listSeeds(db).map((s) => [s.id, s.name, s.active])).toEqual([[2, "default", 1], [1, "default", 0]]);
    expect(activeSeed(db)!.text).toBe("You are {name} at {forge_url}. v2");
    // Not empty: config/ is not loaded over it. An import adds config/'s seeds as versions: the shock seed, and the
    // default's file text (a new active version, as its text differs from v2; v2 stays, to be made active again).
    expect(ensureConfigDefaults(db)).toEqual([]);
    expect(importConfig(db)).toEqual(expect.arrayContaining(["seed default v3", "seed shock v4"]));
    expect(listSeeds(db, "default").map((s) => [s.id, s.active])).toEqual([[3, 1], [2, 0], [1, 0]]);
    db.close();
  });

  test("export / import round trip", () => {
    const db = openDb(":memory:");
    ensureConfigDefaults(db);
    saveAgentProfile(db, "bramble", readFileSync("config/agents/bramble.yaml", "utf8").replace(/effort: \w+/, "effort: high"));
    const out = join(tmp, "export");
    const files = exportConfig(db, out);
    expect(files).toContain("agents/bramble.yaml");
    expect(files).toContain("smoke.yaml");
    expect(readFileSync(join(out, "agents", "bramble.yaml"), "utf8")).toContain("effort: high");
    expect(readdirSync(out).sort()).toEqual(["agents", "seeds", "shock.yaml", "smoke.yaml", "swarm.yaml"]);
    expect(readdirSync(join(out, "seeds")).sort()).toEqual(["default.md", "shock.md"]);
    // Into a fresh DB: the same rows. Note host.yaml / pricing.yaml in a dir are not presets.
    writeFileSync(join(out, "host.yaml"), "network: {}\n");
    const db2 = openDb(":memory:");
    importConfig(db2, out);
    for (const [a, b] of [[listPresets(db), listPresets(db2)], [listAgentProfiles(db), listAgentProfiles(db2)]] as const)
      expect(b.map((r) => [r.name, r.yaml])).toEqual(a.map((r) => [r.name, r.yaml]));
    expect(activeSeeds(db2).map((s) => [s.name, s.text])).toEqual(activeSeeds(db).map((s) => [s.name, s.text]));
    // A broken file: nothing is imported.
    writeFileSync(join(out, "agents", "zed.yaml"), "name: zed\nharness: nope\n");
    const db3 = openDb(":memory:");
    expect(() => importConfig(db3, out)).toThrow(/harness/);
    expect(listAgentProfiles(db3)).toEqual([]);
  });

  test("a run's config from a preset: per-agent overrides, the snapshot round-trips and records the host config", () => {
    const db = openDb(":memory:");
    ensureConfigDefaults(db);
    const smoke = listPresets(db).find((p) => p.name === "smoke")!.yaml;
    savePreset(db, "rich", smoke.replace("agents: [bramble, sorrel, wren, fern]", "agents: [{ name: bramble, budget_usd: 3, effort: high }, sorrel]").replace("seed: default", "seed: shock"));
    const { cfg, seed } = swarmFromPreset(db, "rich", { hostYaml: "network: {name: n}\n" });
    expect(cfg.seed).toBe("shock");
    expect(seed).toMatchObject({ name: "shock", id: activeSeed(db, "shock")!.id });
    // A preset that names no seed runs with the default one.
    expect(swarmFromPreset(db, "smoke").cfg.seed).toBe("default");
    expect(swarmFromPreset(db, "smoke").seed.name).toBe("default");
    expect(cfg.agents.map((a) => [a.name, a.budgetUsd, a.effort])).toEqual([
      ["bramble", 3, "high"],
      ["sorrel", 2, loadSwarm("config/smoke.yaml").agents.find((a) => a.name === "sorrel")!.effort],
    ]);
    expect(cfg.snapshot).toContain("# --- preset:rich\n");
    expect(cfg.snapshot).toContain("# --- agents/bramble.yaml\n");
    expect(cfg.snapshot).toContain(`# --- ${HOST_SNAPSHOT_KEY}\nnetwork: {name: n}\n`);
    const back = swarmFromSnapshot(cfg.snapshot);
    expect(back.agents).toEqual(cfg.agents);
    expect(back.budgets).toEqual(cfg.budgets);
    expect(back.seed).toBe("shock");
    expect(back.paths.swarm).toBe("preset:rich");
    expect(() => swarmFromPreset(db, "nope")).toThrow(/preset not found: nope \(presets: rich, shock, smoke, swarm\)/);
    // A file config reads its seed next to it: config/seeds/<name>.md.
    expect(loadSwarm("config/shock.yaml").paths.seed).toMatch(/config\/seeds\/shock\.md$/);
    expect(loadSwarm("config/smoke.yaml").paths.seed).toMatch(/config\/seeds\/default\.md$/);
  });
});
