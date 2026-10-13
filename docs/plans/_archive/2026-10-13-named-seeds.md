# Named seeds — done 2026-10-13

Seeds used to be one global list of versions with a single active one, so running a preset with a different seed
meant switching the active version before every run. Now a seed has a name.

- [x] `seeds.name` (migration: every earlier version is `default`, its active one stays active); versions and the
  active flag are per name (`src/config-db.ts`: `listSeeds(db, name?)`, `activeSeed(db, name)`, `activeSeeds`,
  `saveSeed(db, name, …)` which re-activates an earlier version with the same text, `deleteSeed`).
- [x] Preset `seed: <name>` (`parseSwarm`, `SwarmConfig.seed`, default `default`); a preset can't be saved naming a
  seed that doesn't exist; a seed a preset names (or `default`) can't be deleted. A file config reads
  `config/seeds/<name>.md` next to it.
- [x] Files: `config/seeds/<name>.md` (was `config/seed.md`); import/export/bundle carry every seed
  (`ConfigBundle.seeds`).
- [x] API: `GET /seeds[?name=]`, `POST /seeds {name?, text, note?}`, `POST /seeds/:id/activate`, `DELETE /seeds/:name`.
  CLI: `just config list` shows each seed's active version, `just config seeds` every version with its name.
  Dashboard Config page: seeds grouped by name, new seed (starting from the one shown), delete.
- [x] `config/shock.yaml` + `config/seeds/shock.md`: the `swarm` fleet, told to build software that runs in a browser.
