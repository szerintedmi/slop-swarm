// Backups on the VPS (docs/plans/2026-10-12-hosted-control-plane.md §6.6) and forge upgrades (§6.7).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDb, backupForge, diskUse, lastForgeBackup, listBackups, newestMtime } from "../src/backup.ts";
import { ensureConfigDefaults } from "../src/config-db.ts";
import { openDb, worldDirs } from "../src/db/index.ts";
import type { ForgeClient } from "../src/forge.ts";
import { ControllerService } from "../src/service.ts";
import { fakeAgentHost, silentLogger, TEST_HOST } from "./helpers/agent-host.ts";

const dataDir = mkdtempSync(join(tmpdir(), "slopswarm-backup-"));
process.env.SLOPSWARM_DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe("backups", () => {
  test("the DB: a consistent copy that opens, newest N kept", () => {
    const db = openDb(":memory:");
    ensureConfigDefaults(db);
    const files: string[] = [];
    for (let i = 0; i < 4; i++) files.push(backupDb(db, { keep: 2, now: Date.UTC(2026, 9, 13, i) }));
    expect(listBackups().db).toEqual(files.slice(2).map((f) => f.split("/").at(-1)!));
    const copy = openDb(files.at(-1)!, { readonly: true });
    expect(copy.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM swarm_presets").get()!.n).toBe(3);
  });

  test("a forge as plain files; the last backup time is read back from its name", () => {
    const w = "20261013-0000-w-ab12";
    const forge = worldDirs(w).forge;
    mkdirSync(join(forge, "git", "repos"), { recursive: true });
    writeFileSync(join(forge, "gitea.db"), "sqlite bytes");
    expect(lastForgeBackup(w)).toBe(0);
    const t = Date.UTC(2026, 9, 13, 3, 4, 5, 678);
    const dest = backupForge(w, { now: t })!;
    expect(readFileSync(join(dest, "gitea.db"), "utf8")).toBe("sqlite bytes");
    expect(lastForgeBackup(w)).toBe(t);
    expect(newestMtime(forge)).toBeGreaterThan(0);
    expect(backupForge("no-forge-here")).toBeNull();
    expect(diskUse()!.totalBytes).toBeGreaterThan(0);
  });

  test("through the service: an idle world's forge is stopped for the copy and started again; not an active world's; upgrades too", async () => {
    process.env.FORGE_ADMIN_PASSWORD ||= "test-admin";
    const db = openDb(":memory:");
    const w = "20261013-0100-idle-cd34";
    db.query("INSERT INTO worlds (id, name, created_at, forge_image, status) VALUES (?, 'idle', 0, 'forgejo:16.0.4', 'idle')").run(w);
    mkdirSync(worldDirs(w).forge, { recursive: true });
    writeFileSync(join(worldDirs(w).forge, "app.ini"), "x");
    const events: string[] = [];
    const forge = { baseUrl: "http://127.0.0.1:1" } as unknown as ForgeClient;
    const agentHost = fakeAgentHost({ dataDir, behave: () => "" });
    const service = new ControllerService({
      db, agentHost: { host: agentHost.host, url: "fake", local: true, stop: () => {} }, hostCfg: TEST_HOST, log: silentLogger,
      port: 0, bind: ["127.0.0.1"], forgeBasePort: 3300, forgePublish: [], allForges: true,
      startForge: async (o) => (events.push(`start ${o.world} ${o.image}`), forge),
      backups: { keep: 3, hourUtc: 3 },
    });
    await service.start();
    expect(events).toEqual([`start ${w} forgejo:16.0.4`]);
    const r = await service.backupNow({ worlds: [w] });
    expect(r.db).toContain("swarm-");
    expect(Object.keys(r.forges)).toEqual([w]);
    expect(events).toEqual([`start ${w} forgejo:16.0.4`, `start ${w} forgejo:16.0.4`]); // stopped for the copy, started again
    await service.upgradeForge(w, "codeberg.org/forgejo/forgejo:16.0.5-rootless");
    expect(events.at(-1)).toBe(`start ${w} codeberg.org/forgejo/forgejo:16.0.5-rootless`);
    expect(db.query<{ i: string }, [string]>("SELECT forge_image AS i FROM worlds WHERE id = ?").get(w)!.i).toBe("codeberg.org/forgejo/forgejo:16.0.5-rootless");
    await expect(service.upgradeForge(w, "bad image; rm -rf")).rejects.toThrow(/not an image/);
    // The API: backups listed with disk use.
    const res = await fetch(`${service.urls[0]}/api/v1/backups`);
    const list = (await res.json()) as { forges: Record<string, string[]>; disk: { totalBytes: number } };
    expect(list.forges[w]).toHaveLength(1);
    expect(list.disk.totalBytes).toBeGreaterThan(0);
    await service.close();
  }, 30_000); // service.start() builds the dashboard when no build matches the sources (a cold checkout): seconds, not ms
});
