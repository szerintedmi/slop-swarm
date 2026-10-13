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
  deleteAgentProfile,
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
import { openDb } from "../src/db/index.ts";

const tmp = mkdtempSync(join(tmpdir(), "slopswarm-configdb-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("config in the DB", () => {
  test("an empty DB gets config/ as defaults, once", () => {
    const db = openDb(":memory:");
    const loaded = ensureConfigDefaults(db);
    expect(loaded).toContain("preset smoke");
    expect(loaded).toContain("agent bramble");
    expect(loaded).toContain("seed v1");
    expect(listPresets(db).map((p) => p.name)).toEqual(["smoke", "swarm"]);
    expect(listAgentProfiles(db).map((a) => a.name)).toEqual(["bramble", "fern", "sorrel", "thistle", "wren"]);
    expect(activeSeed(db)!.text).toBe(readFileSync("config/seed.md", "utf8"));
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
    expect(() => saveSeed(db, "no placeholders")).toThrow(/\{name\}/);
    // The stored rows didn't change.
    expect(listPresets(db).map((p) => p.name)).toEqual(["smoke", "swarm"]);
    // A profile in use can't be deleted.
    expect(() => deleteAgentProfile(db, "fern")).toThrow(/smoke/);
  });

  test("seeds are versioned; the same text is not a new version; any version can be made active again", () => {
    const db = openDb(":memory:");
    ensureConfigDefaults(db);
    const v1 = activeSeed(db)!;
    expect(saveSeed(db, v1.text).id).toBe(v1.id);
    const v2 = saveSeed(db, v1.text + "\nBe kind.\n", "tweak");
    expect(v2.id).toBeGreaterThan(v1.id);
    expect(activeSeed(db)!.id).toBe(v2.id);
    activateSeed(db, v1.id);
    expect(activeSeed(db)!.id).toBe(v1.id);
    expect(listSeeds(db).filter((s) => s.active)).toHaveLength(1);
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
    expect(readdirSync(out).sort()).toEqual(["agents", "seed.md", "smoke.yaml", "swarm.yaml"]);
    // Into a fresh DB: the same rows. Note host.yaml / pricing.yaml in a dir are not presets.
    writeFileSync(join(out, "host.yaml"), "network: {}\n");
    const db2 = openDb(":memory:");
    importConfig(db2, out);
    for (const [a, b] of [[listPresets(db), listPresets(db2)], [listAgentProfiles(db), listAgentProfiles(db2)]] as const)
      expect(b.map((r) => [r.name, r.yaml])).toEqual(a.map((r) => [r.name, r.yaml]));
    expect(activeSeed(db2)!.text).toBe(activeSeed(db)!.text);
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
    savePreset(db, "rich", smoke.replace("agents: [bramble, sorrel, wren, fern]", "agents: [{ name: bramble, budget_usd: 3, effort: high }, sorrel]"));
    const { cfg, seed } = swarmFromPreset(db, "rich", { hostYaml: "network: {name: n}\n" });
    expect(cfg.agents.map((a) => [a.name, a.budgetUsd, a.effort])).toEqual([
      ["bramble", 3, "high"],
      ["sorrel", 2, loadSwarm("config/smoke.yaml").agents.find((a) => a.name === "sorrel")!.effort],
    ]);
    expect(seed.id).toBe(activeSeed(db)!.id);
    expect(cfg.snapshot).toContain("# --- preset:rich\n");
    expect(cfg.snapshot).toContain("# --- agents/bramble.yaml\n");
    expect(cfg.snapshot).toContain(`# --- ${HOST_SNAPSHOT_KEY}\nnetwork: {name: n}\n`);
    const back = swarmFromSnapshot(cfg.snapshot);
    expect(back.agents).toEqual(cfg.agents);
    expect(back.budgets).toEqual(cfg.budgets);
    expect(back.paths.swarm).toBe("preset:rich");
    expect(() => swarmFromPreset(db, "nope")).toThrow(/preset not found: nope \(presets: rich, smoke, swarm\)/);
  });
});
