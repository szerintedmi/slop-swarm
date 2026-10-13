# Hosted control plane: worlds, a VPS controller, a runner on the agent host

- **Status:** open
- **Date:** 2026-10-12 (revised 2026-10-13 after review)
- **Parent:** [Tiny Society Token Probe](2026-10-10-tiny-society-token-probe.md)
- **Related:** [Credential proxy](2026-10-10-credential-proxy.md), which would keep model credentials out of agent containers. Parked here.

## Progress

Implementation log, so work can resume in a new session. `[x]` done and tested; `[~]` written but needs live infra (accounts, VPS, tailnet) to verify; `[ ]` not started. Section numbers match the plan below.

- §1 Credential hygiene
  - [ ] 1.1 / 1.2 swarm-only accounts and per-key credit limits (owner, by hand)
  - [x] 1.3 rotation checklist in README ("Credentials and rotation")
- §2 Runner
  - [x] `config/host.yaml` + `src/hostconfig.ts` (allowlist, container limits, runner limits; `checkHostFor`); `network:` / `controller.container:` left the swarm configs (old snapshots still parse)
  - [x] 2.2 `AgentHost` + `RunnerHost` (`src/host/agent-host.ts`), wire types `src/runner/protocol.ts`
  - [x] 2.3 runner daemon `src/runner/` (runner.ts, containers.ts, main.ts): `docker run -d` + `docker logs -f` into files + `docker wait`; reattach by label; hard timeout; watchdog; one wake per agent
  - [x] 2.4 runtime sync allowlist (`projects/`, `sessions/`) + known-excluded list, unknown entries reported (`HomeInfo.unknownRuntime`)
  - [x] snapshot stream (`src/runner/snapshot.ts`) instead of tar: path guards, no writes through links
  - [x] structured JSON logger `src/log.ts`
  - [x] tests: `test/runner.test.ts` (fake runtime: offsets, prepare, secrets, timeout, watchdog, reattach, pull/push + interrupted push, read confinement, host config kept over a restart)
  - [x] wake loop on `AgentHost` (`src/controller/wake.ts`): prepare (/self, forge/GitHub logins, relay token, pi models.json, system prompt, secrets by name) → startWake → stdout by offset; 5 s refresh mirrors the session files (`adapter.sessionDir`) into `data/worlds/<w>/agents/<n>/live/` for `finalizeUsage`; relay logs mirrored by offset; next_wake.yaml/stderr via the runner; runner kill retried by the runner
  - [x] controller restart re-follows running wakes (`Controller.recover` → `startWake(…, existing)`); wakes the runner lost are billed from the controller's copy
  - [x] Codex `auth.json` per agent: `secrets/codex/<world>/<agent>/auth.json`, seeded from the master, `ifMissing` at prepare, fetched back after each wake
  - [x] 2.6 home sync (`src/controller/host-files.ts`): pull after each wake (`home_sync` event, the agent's next wake waits), `gens/<N>` + `current` link swapped last, 2 kept, size warn/cap, unknown runtime entries warned; push at run start when the runner is behind
  - [x] 2.6 dashboard home browser live through the runner, else the VPS copy "as of generation N" (`src/dashboard/homes.ts`)
  - [x] 2.7.1 structured JSON logs `src/log.ts` (controller `data/logs/controller.jsonl`, runner `<runner>/logs/runner.jsonl`); relay `relayLogger` in `docker/search/relay.ts` (same field names, `slopswarm.world` from `SLOPSWARM_WORLD`; startup, each search/fetch outcome, auth refusals, errors; never queries, URLs or the key) to stdout and `<world relay>/log/relay.jsonl`, merged into the runner's `GET /v1/logs`; 2.7.2 runner timings → `timings` event; 2.7.3 remote runner logs pumped into `data/logs/runner.jsonl`; `just logs` (no name) merges them. Checked in a real relay container
  - [x] 2.8 image ref: `SLOPSWARM_AGENT_IMAGE` (registry digest, pulled by the runner) else this checkout's hash tag (built). CI build/push: §6
  - [x] `src/launch.ts` (connectAgentHost: `SLOPSWARM_RUNNER_URL` + `SLOPSWARM_RUNNER_TOKEN`, else an in-process runner on localhost; prepareRun; bringUpWorld; bringDownWorld); CLI `up`/`resume`/`kill`/`dash` use it; `just runner`, `just logs`
  - [~] 2.5 forge reachability: one port per world (`worlds.forge_port`) published on the VPS tailnet address too (`SLOPSWARM_FORGE_PUBLISH`); the runner's forwarder `slopswarm-forge-<world>` targets it (`forgeForwarderArgs`, `worldUp({forgeTarget})`); locally unchanged. Not yet tried over a real tailnet (OrbStack NAT check first, `docs/deploy.md` §3)
  - [x] real-docker check of the runner (scratch script, no model calls): exit codes, stdout/stderr split, secret by name, container removed, reattach after a runner restart with offsets kept, kill
  - [ ] 2.9.1 smoke run on the laptop through the runner (costs model spend; owner to run `just smoke`)
  - [ ] 2.9.2 runner in a second checkout over the tailnet (OrbStack NAT → VPS 100.x check first); 2.9.3 controller on the VPS
- §3 Worlds
  - [x] 3.1 schema: `worlds`, `world_agents`, `runs.world_id/brief/host_hash`, `controls.run_id` nullable (launch); `runsToWorlds` DB migration
  - [x] 3.2 layout: `data/worlds/<w>/{forge,relay,secrets,agents/<n>/{current,gens,live}}`; runner keeps its own copy under its data dir
  - [x] 3.3 `forgeHost/forgeUrl/forgeDataDir` take the world id; forge tokens stored per world (`secrets/forge/<agent>.token`), login files rewritten at every prepare
  - [x] 3.4/3.5 launch new or `--world W` (`just continue W`), active world refused, agents join/leave (`removed_at`), sessions carry over on the same harness; billed ids and resume baselines span the world's runs
  - [x] 3.6 brief added to each agent's first wake note of the run
  - [x] 3.7 migration of existing runs: DB rows (`openDb`) + dirs (`migrateWorldDirs` on up/resume/dash: forge, relay logs, forge token, Codex login, first home generation, local runner dirs)
  - [x] 3.8 tests: `test/worlds.test.ts` (new/continue, sessions across runs, generations + interrupted pull + push to a fresh host, Codex round trip, controller re-follow, migration); `just worlds`
- §4 Config in the DB
  - [x] 4.1 tables `seeds` (versions, one active), `agent_profiles`, `swarm_presets` (YAML text; parseAgent/parseSwarm validate on save) — `src/config-db.ts`
  - [x] 4.2 presets: run, budgets, scheduler, webfetch, forge image, agents with per-agent overrides (`- { name: sorrel, budget_usd: 3 }`, parseSwarm); allowlist + container limits in `config/host.yaml`
  - [x] 4.3 run start from a preset (`resolveSwarm`): snapshot = preset + profiles used + `host.yaml` chunk; `runs.host_hash` = the runner's applied hash; `config_yaml`/`seed_text`/`pricing_yaml` kept. A path (`just up config/x.yaml`) still loads files directly
  - [x] 4.4 config/ is the default set for an empty DB (`ensureConfigDefaults`); `just config list|seeds|import|export [dir]`
  - [x] 4.5 tests: `test/config-db.test.ts`
- §5 Controller service and API
  - [x] 5.1 always-on service `src/service.ts` (`just serve`): dashboard + API, resumes an active run on start (re-following wakes), polls `launch` controls (`run_id NULL`, result in `controls.result`), one run at a time; SIGTERM detaches (`Controller.detach`: no DB writes, run stays running, containers keep going); Ctrl-C stops gracefully, twice kills. `just up` = launch through the API of a running service and follow, else start the service in the foreground and launch; `resume` likewise
  - [x] 5.1 forges: one port per world (`worlds.forge_port`), `SLOPSWARM_ALL_FORGES=1` keeps every world's forge up (VPS), `SLOPSWARM_FORGE_PUBLISH` = tailnet address the forwarders also publish on (the per-world forge "router" for remote agent hosts; replaces a Caddy router)
  - [x] 5.2 HTTP API `src/api.ts` (endpoint list in its header): launch, stop, kill, extend, resume, pause/unpause/wake, status, runs, wakes, transcript, report, logs, worlds, homes, presets, agents, seeds, config bundle; bind `SLOPSWARM_BIND` (localhost + tailnet); bearer `SLOPSWARM_API_TOKEN` checked when sent; mutating needs `X-Slopswarm`, refuses `Sec-Fetch-Site: cross-site`
  - [x] 5.3 CLI through the API (`src/api-client.ts`; `SLOPSWARM_API`, else the local service via `data/service.json`); read-only commands read the local DB unless `SLOPSWARM_API` is set; `--json` on status, logs, worlds, config, up, stop, kill, extend, pause/unpause/wake, resume. Without any controller, controls fall back to the local queue (applied on resume)
  - [x] 5.4 dashboard: controls through the API (form post kept as the no-JS fallback, same `queueControl`); new pages Worlds (+ launch), World (agents, runs, home browser), Config (presets, agent profiles, seed versions, editable)
  - [x] tests: `test/api.test.ts` (auth/CSRF, read-only, controls, launches, config, worlds/homes, a service launch → wake → restart → stop cycle), dashboard page tests
  - [x] 5.5 README / AGENTS.md (with the API → CLI → just → UI rule), `.env.example`
- §6 VPS deploy (written and checked locally; nothing deployed yet)
  - [ ] 6.1 provision the VPS (owner; steps in `docs/deploy.md` §2)
  - [x] 6.2 controller image `deploy/controller.Dockerfile` (oven/bun 1.4.3-slim + docker CLI 27.5.1, dashboard prebuilt, `org.slopswarm.schema` label, compose + Caddyfile inside). Built and run locally: API + dashboard up, SIGTERM stops cleanly, no `.env`/secrets in it. Deviation: a full `bun install` (the prebuilt dashboard and a possible rebuild need the dev deps), not `--production`
  - [x] 6.3 `deploy/compose.yaml` (controller: host network, Docker socket, `/var/lib/slopswarm` same path in and out, `/etc/slopswarm/{slopswarm.env,secrets}`; Caddy under the `public` profile); `docker compose config` passes. The forge networks are created by the controller (`SLOPSWARM_ENSURE_NETWORKS`); a root controller chowns each forge dir to 1000
  - [x] 6.4 `.github/workflows/deploy.yml` (test → controller amd64 + agent amd64/arm64 to GHCR by digest → tailnet as `tag:ci` → forced-command ssh), gated on the repo variable `DEPLOY_ENABLED=true`; actionlint clean. `deploy/slopswarm-deploy` (lock, digest-only, schema-change wait, compose/Caddyfile from the image, health check, rollback); shellcheck clean. First VPS deploy done 2026-10-13; it needed sudoers `env_keep` for `SSH_ORIGINAL_COMMAND` (bootstrap.sh writes it)
  - [x] 6.5 deploys don't kill wakes (SIGTERM → `Controller.detach`; the new service resumes and re-follows); schema change waits for no active run
  - [x] 6.6 backups `src/backup.ts`: DB nightly (`VACUUM INTO`), a world's forge as plain files after its run and nightly when changed (stopped for the copy), keep N; `just backup`, `GET/POST /api/v1/backups`; dashboard header warns under 10% free disk. Tests: `test/backup.test.ts`
  - [x] 6.7 Forgejo upgrades: `worlds.forge_image`, `just forge-upgrade WORLD IMAGE` / `POST /api/v1/worlds/:id/forge-image` restarts an idle world's forge on the new image
  - [x] 6.8 runbook `docs/deploy.md` (tailnet ACLs, bootstrap, runner, CI, day to day, rollback, backups/restore, upgrades, public forge)
- §7 Public read-only forge (built and tested; going live is the owner's)
  - [x] 7.1 `PUBLIC_FORGE_DOMAIN` only in the VPS env file; docs/tests use `forge.example.com`
  - [x] 7.2 `deploy/Caddyfile` (`caddy validate` passes): `<world>.<domain>` + apex index, on-demand TLS asking the controller, GET/HEAD + `POST …/git-upload-pack` only, `/user/*` (not avatars), `/admin*`, `/api/v1/admin*`, archives refused, `Authorization`/`Cookie` stripped. Controller side `src/public-forge.ts` (localhost:7780): host → world → forge port, the same rules again, per-client rate limits (pages, clones), `/ask`, the index. Tests: `test/public-forge.test.ts`
  - [x] 7.3 `ROOT_URL` = the public URL (`publicForgeUrl`), agents' gitconfig `insteadOf` back to the internal forge. Checked live against Forgejo 16.0.4 (scratch, no model calls): controller API calls and `tea` on the internal URL work, clone links show the public URL, git clone + push through the public URL work via `insteadOf`. The "configured to be served on" notice is in the page template and shows only when the host differs from `ROOT_URL`: the owner over the tailnet, not public visitors
  - [x] 7.4 anonymous viewing on (`REQUIRE_SIGNIN_VIEW=false`), registration off, private repos 404 to anonymous (checked live), `hideAdmin` unchanged
  - [ ] 7.5 before going live: rotate every model key (§1), apply pending Forgejo security releases (owner)
- [x] Review pass (independent reviewer, 2026-10-13), all fixed with regression tests: relay-log mirrors serialized per file + search log de-duplicated by id (concurrent wakes double-billed and threw); recover follows a wake again when the runner errors (only a 404 closes it); a launch whose world fails to come up marks the run stopped and the world idle; names a snapshot can't carry are left out with a warning instead of failing every pull; runner reads open with `O_NOFOLLOW` and re-check the resolved file (symlink-swap race); Caddy gets only its two variables (`caddy.env`), not the secrets file; the dashboard/API refuses unknown `Host` names (DNS rebinding; `SLOPSWARM_ALLOWED_HOSTS`); a detached controller doesn't wait on pulls/cross-checks; launches wait for a running backup; in-progress forge backups are hidden (`.partial-*`)
- Not done / open
  - [ ] 2.9.1–2.9.3 live checks (smoke through the runner on the laptop; runner over the tailnet; controller on the VPS)
- Deviations from the text below: home sync uses a framed snapshot stream (`src/runner/snapshot.ts`) instead of rsync/tar; the VPS "forge router" is each world's forwarder publishing its port on the tailnet address too (`SLOPSWARM_FORGE_PUBLISH`), not Caddy; `network:`/`controller.container:` moved to `config/host.yaml` already in §2 (§4 needed it for the runner anyway).

Move the controller, dashboard and forges to a VPS. Agents run on a separate agent host through a runner: the laptop for now, ephemeral Boat VMs in a later, separate step. Introduce **worlds**, so a run can start fresh or continue an earlier world. Keep config in the DB, so tweaks don't need a redeploy.

## Requirements

1. **Hosting.** The controller, dashboard, DB and Forgejo run on one small VPS, deployed from CI.
2. **Agents elsewhere.** Agent containers run on an agent host behind a runner, with the same container flags, egress proxy and allowlist as today. The design must carry over to ephemeral VMs (Boat) without controller changes. Boat itself is out of scope.
3. **Worlds.** A world is a forge plus the agents' homes. A run is a time-boxed session in one world.
   - At launch you pick **new world** (fresh forge and homes) or **continue world X** (both carry over).
   - Agents can be added to or removed from a world between runs.
4. **Config in the DB.** The seed (versioned), agent profiles and swarm presets can be edited without a redeploy. Every run still freezes a snapshot of what it ran with.
5. **One way in for every feature.** Each action is an API endpoint first, then a CLI command (with `--json` for scripts), a `just` recipe and a dashboard control. Nothing exists only in the UI.
6. **Access.** The dashboard, API and SSH are reachable over the tailnet only. A public read-only page may come later.
7. **Public forge.** Each world's public repos, issues, PRs and comments are publicly readable, read-only.
   - The domain is **unlisted**: it's kept out of the repo, CI logs and committed config.
   - It isn't secret, though. It is the forge's `ROOT_URL`, so agents see it.
8. **Agent memory always browsable.** Homes are backed up to the VPS after every wake, so they can be read while the agent host is off.
9. **Keep the boundaries:**
   - Agents have no route out except through the allowlist proxy.
   - The forge has no route out.
   - Secrets never go into argv, the repo or home backups.
   - Web fetch stays GET-only and public-only.
   - The seed doesn't change for any of this.

## Decisions

- **Tailscale** links the VPS, the agent hosts, your devices and CI.
  - **Tags:**
    - `tag:swarm-control`: the VPS.
    - `tag:swarm-agents`: agent hosts.
    - `tag:ci`: CI jobs.
  - **Access rules:**
    - Your devices → VPS: dashboard, API, SSH.
    - VPS → agent hosts: runner port.
    - Agent hosts → VPS: forge ports only.
    - CI → VPS: SSH.
- **The VPS starts every connection**, except the agents' forge traffic. The controller calls the runner to start and stream wakes, read files, sync homes and fetch logs. The runner holds no VPS credentials, which is what an ephemeral VM needs.
- **One forge per world**, never one shared instance. A shared instance would leak between worlds through explore pages, user search and username collisions. Each forge is cheap: 134–195 MB RAM idle (Appendix A).
- **The forge hostname comes from the world id**, not the run id, so saved git remotes in homes stay valid across runs. Existing runs are migrated to worlds whose id *is* the run id, so their hostnames don't change either.
- **No repo selector and no migrations.** To work on repo X again, you continue that world, optionally with a run brief. `repository.DISABLE_MIGRATIONS` stays on.
- **Branching a world is deferred.** That means copying a stopped world into a new one. It works (tested in Appendix A), and a gitconfig `insteadOf` fixes the remotes.
- **The controller always talks to a runner, even locally.** On the laptop, `just up` starts one on localhost. That gives one code path, the same one an ephemeral VM will use.
- **The runner is addressed by world and agent, never by host path.** The runner owns the dir layout, so the worlds work (§3) hardly touches the wake loop once the runner (§2) is in.
- **Costing stays in the controller.** The runner serves files by offset, and the controller keeps its mid-wake 5 s re-read of the session file for authoritative usage and budget kills. Streamed numbers stay only a fallback.
- **Secrets are pushed by the controller, not stored on the runner.** The VPS env file and `secrets/` are the only source.
  - **Env secrets:** the Claude token and the OpenRouter keys go to the runner at `prepare`. The runner keeps them in memory and passes them to `docker run` as named env (`-e NAME`), as today.
  - **The relay's Exa key** goes to the runner at `ensureUp`.
  - **File secrets** (forge, tea, git and GitHub logins, the search token, pi's `auth.json`) are rewritten into the agent's runtime dir by every `prepare`. The home sync excludes them.
  - **Codex `auth.json`** is kept per agent at `secrets/codex/<world>/<agent>/auth.json` on the VPS, seeded from the master login. It is pushed at `prepare` when the runner lacks it, which covers a new VM, and fetched back after each wake because Codex rotates it. Two Codex agents never share a copy.
- **Homes: read live, back up after.**
  - **While the agent host is up,** the dashboard's home browser reads files live through the runner (`read(world, agent, path)`), mid-wake too, marked "live".
  - **When it's off,** the browser falls back to the VPS copy, marked "as of generation N".
  - **The VPS copy is a backup and offline view only,** so it just has to be consistent: one pull after container exit, never during a wake.
  - **Generations:** the generation is bumped only after a complete pull. The controller pushes a home at run start when the runner's generation is behind.
  - **Wake slot:** a pull doesn't hold the wake slot, but that agent's next wake waits for it.
- **Runs keep themselves bounded on the agent host.** The runner kills a wake at its hard timeout, which it receives in `startWake`. It also kills every container once it has gone a bounded time without hearing from the controller. A dead VPS therefore costs at most one wake's limit in model spend.
- **Egress stays on the agent host, as today.**
  - Model APIs go through tinyproxy.
  - Search and webfetch go through the relay container next to it, and Exa is reached directly from there.
  - Nothing is relayed through the VPS.
- **Agent-facing limits** (allowlist, container limits) live in one deployed file on the VPS, `config/host.yaml`. They can't be edited from the dashboard.
  - The controller pushes them to the runner at `ensureUp`.
  - The runner reports back the hash of the allowlist and limits it applied, and the run snapshot records it.
  - `pricing.yaml` stays with the controller.
- **One active run at a time**, to start with.
- **The controller stays the only DB writer.** The API runs inside the controller process.
- **The seed doesn't change.** Agents aren't told the forge is publicly readable.

## 1. Credential hygiene (now, before anything is hosted)

1. Use swarm-only accounts: a dedicated Claude subscription token and a dedicated ChatGPT login for Codex.
2. Give each OpenRouter key its own credit limit.
3. Write a short rotation checklist in the README. Rotate everything before the forge goes public (§7).

## 2. Runner (agent host split)

1. **Inventory first.** List every file and process touch in `src/controller/wake.ts`, `self-writer.ts`, `forge.ts`, `github.ts`, `search.ts` and the harness adapters, then write the interface from that list. Known so far:
   - **Before the wake:** `/self` (ledger and prices), forge/tea/git logins, the GitHub login, the search token, the Codex `auth.json` copy, pi's `models.json`, the system-prompt file.
   - **During the wake:** stdout, the stderr file (`wake.ts:417`), the session transcript or rollout, re-read every 5 s for usage and budget kills (`wake.ts:375`), and the relay's search log, read live (`wake.ts:240`).
   - **After the wake:** `next_wake.yaml`, the final transcript, the Codex `auth.json`.
2. **`AgentHost` interface** in the controller, keyed by `(world, agent)`:
   - `ensureUp(hostConfig, relaySecrets)`: a no-op locally; VM create/resume later.
   - `prepare(world, agent, files, envSecrets)`
   - `startWake(..., hardTimeout)`: returns a wake id.
   - `read(wakeId | (world, agent), path, offset)`: for stdout, stderr, transcripts, the search log and `next_wake.yaml`, plus live home browsing. Paths are checked against an allowlist; home paths are confined to the home.
   - `kill(wakeId)`
   - `pullHome` / `pushHome(world, agent, generation)`
   - `logs(since)`
   
   The only implementation is `RunnerHost`, which talks HTTP to a runner.
3. **Runner.** `src/runner/` is a Bun daemon on the agent host. It serves the interface over HTTP with a shared runner token, runs `docker run` as today, and owns the agent dirs, the proxy and the search/webfetch relay.
   - It always writes a wake's stdout and stderr to files and serves them by offset, so the controller's stream can resume.
   - After a restart, it reattaches to live containers by label.
   - The same mechanism lets a *controller* restart (deploy) re-follow running wakes instead of killing them.
   - **Hard timeout:** the runner kills a wake at the timeout it got in `startWake`.
   - **Watchdog:** the runner kills every container once it has had no controller contact for a bounded time.
   - The turn and budget limits stay in the controller, because they need the parsed stream (`wake.ts:400`). The timeout plus the watchdog bound the spend if the controller is gone.
4. **One runtime dir per agent; the split is in the sync.** The CLIs use the runtime dir as their home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) and write to its root, so it stays one mount. The home sync to the VPS copies the runtime dir from an explicit allowlist only:
   - **Claude:** `projects/` (`src/harnesses/claude.ts:184`).
   - **Codex:** `sessions/` (`codex.ts:113`).
   - **pi:** `sessions/` (`pi.ts:117`).
   
   Everything else in `runtime` is excluded: logins, tokens, `auth.json`, pi's `pi/` dir with its keys. Files that aren't on a known-excluded list raise a warning event.
5. **Forge reachability.**
   - Each active world gets its own tailnet port on the VPS forge router. The router forwards that port to that world's forge only, whatever `Host` header comes in.
   - On the agent host, a socat forwarder named `slopswarm-forge-<world>` targets exactly that port.
   - Agents get no route out and can't reach another world's forge.
   - Locally, the existing forwarder setup stays.
6. **Home sync.**
   - After container exit, the wake is reported finished. The VPS then pulls the home changes (rsync-style through the runner) as a separate `home_sync` event.
   - The pull goes into a temp dir that is renamed into place. The generation marker is written last, so an interrupted pull never counts.
   - There is a size cap, with a warning event when a home goes over it. Big dirs (`node_modules`, build output) are candidates for an exclude list.
   - **Dashboard home browser** (`src/dashboard/service.ts:109`):
     - Reads live through the runner while the agent host is up.
     - Falls back to the VPS copy, labelled "as of generation N", when it isn't.
7. **Logging** (OpenTelemetry itself is parked).
   1. Structured JSON logs from the controller, runner and relay. Every line carries `world`, `run`, `agent` and `wake_id`, named after OTel attributes so an exporter can be added later without renaming.
   2. The runner reports timings with each wake: image check, container start, CLI exit, home sync. They're stored in `events`, and the dashboard shows where a wake's time went.
   3. The controller pulls the runner's logs (`logs(since)`), so `just logs`, the CLI and the dashboard show them even when the agent host is off.
8. **Agent image.** CI builds it for `linux/amd64` and `linux/arm64` (the laptop) and pushes it to GHCR, and the runner pulls it by digest. Building locally by Dockerfile hash stays as a development fallback.
9. **Check.**
   1. Run the smoke run with everything on the laptop through the runner.
   2. Run it again with the runner in a second checkout on a separate Docker context, over the tailnet. First check that the socat forwarder container can reach a VPS `100.x` address through OrbStack's NAT on macOS. It's the one piece with no Linux equivalent today.
   3. Run it again with the controller on the VPS.
10. **Tests:**
    - The runner API against a fake docker.
    - Reading files by offset.
    - Reattaching after a runner restart and after a controller restart.
    - Home pull and push with generations, including an interrupted pull.
    - The runtime sync allowlist.
    - The runner's hard timeout and no-contact watchdog.
    - Codex `auth.json` round-trip per agent.

## 3. Worlds

1. **Schema.**
   - A new `worlds` table: `id`, `name`, `created_at`, `forge_image`, `status`.
   - New columns on `runs`: `world_id` and an optional `brief`.
   - New `world_agents(world_id, name, last_session_id, home_generation)` table, so session ids and home generations survive across runs. `agents` rows stay per run.
2. **Data layout** on the VPS:
   - `data/worlds/<world>/forge/`
   - `data/worlds/<world>/agents/<name>/{home,runtime-state}` (the backup copy)
   - `self/` and `raw/` stay per run.
   
   The runner keeps its own copy under its data dir.
3. **`forge.ts`.** `forgeHost`, `forgeUrl` and `forgeDataDir` take the world id.
4. **Provisioning on continue.** `provisionAgents` already creates missing accounts and re-keys existing ones (tested on a copied world, Appendix A).
5. **Launch.** You pick `new` or `continue <world>`, plus the preset. Continuing a world that has an active run is refused.
6. **What carries over on continue:**
   - Homes, CLI sessions (`last_session_id` from `world_agents`) and the forge.
   - The wake `seq` and the `/self` ledger (`self-writer.ts:107`) restart per run, and budgets are per run. Agents learn about earlier runs only from their own notes, their sessions and the forge. The optional run brief (added to the first wake note, e.g. "bramble/pubrepo has open PRs") can bridge the gap.
7. **Existing runs.** A migration turns each run into a world with the same id, and moves the dirs. The CLI keeps accepting run ids where it does today.
8. **Tests:** creating and continuing worlds, the migration, provisioning a continued world, carrying sessions over.

## 4. Config in the DB

1. **Tables:**
   - `seeds(id, text, sha256, note, created_at, active)`
   - `agent_profiles(name, yaml, updated_at)`
   - `swarm_presets(name, yaml, updated_at)`
   
   Each stores YAML text. The existing `parseAgent` and `parseSwarm` are the validators; there are no normalised columns.
2. **A preset holds:** run settings, budgets, scheduler, webfetch, forge image, and the agent list with per-agent overrides. Allowlist and container limits move to `config/host.yaml` (see Decisions).
3. **Run start.** The run snapshot is built from the DB rows plus `host.yaml` and the runner's applied-limits hash. `runs.config_yaml`, `seed_text` and `pricing_yaml` stay.
4. **Defaults and sync.** `config/` stays in git as the defaults loaded into an empty DB. `just config export | import` syncs files and DB.
5. **Tests:** validate-on-save, the export/import round-trip, building the snapshot from DB rows.

## 5. Controller service and API

1. **Always-on service.** The controller runs permanently. With no run active, it idles and polls for launches, which use a `controls` row with `run_id NULL` and action `launch`.
   - `just up` and `just smoke` become "launch through the API, then follow".
   - Locally, `just up` still starts the service (and the runner) in the foreground, as it starts the controller today.
2. **HTTP API**, in the controller process, bound to localhost plus the tailnet address.
   - **Endpoints:**
     - launch, stop, kill, extend
     - pause, unpause, wake
     - status, wakes, logs
     - seeds, agents, presets
     - worlds
     - home browsing
   - **Auth:** the dashboard relies on tailnet membership; scripts and CI use a bearer token from `.env`.
   - **CSRF:** every mutating endpoint requires an `X-Slopswarm` header and refuses `Sec-Fetch-Site: cross-site`.
3. **CLI.**
   - Commands that change something go through the API (`SLOPSWARM_API` picks the controller; local by default).
   - Read-only commands (`status`, `report`, `logs`, `dash`) read the local DB directly when it's present, so they work offline. Otherwise they use the API.
   - `--json` everywhere.
4. **Dashboard.** Status and controls go through the API. New pages: worlds, presets, agent profiles, seed versions, home browser.
5. **README and AGENTS.md.** Document the API, and add the rule "every feature: API → CLI → just → UI" to AGENTS.md.

## 6. VPS deploy

1. **VPS:** OVH, 2 vCores, 4 GB RAM, 40 GB disk, with Docker and Tailscale.
   - 40 GB is enough: worlds are small (6.5 MB for a test world). Backups keep a limited number of copies, and the dashboard warns about disk use.
   - Public firewall: only 80/443, opened in §7.
2. **Controller image:** a pinned `oven/bun` slim base with a production install. `deploy/compose.yaml` ships inside the image, as in scamsitter.
3. **Compose:**
   - **Controller.** It needs the Docker socket to start forges, which makes it root-equivalent on a single-purpose VPS.
   - **Forge router:** Caddy, with one tailnet port per active world.
   - **Data:** `/var/lib/slopswarm`.
   - **Env file:** `/etc/slopswarm/slopswarm.env`, root-only. It holds all secrets, the runner token and `PUBLIC_FORGE_DOMAIN`.
4. **CI** (`.github/workflows/deploy.yml`):
   1. Run the tests.
   2. Build the controller image (amd64) and the agent image (amd64 + arm64), and push both to GHCR by digest.
   3. Join the tailnet with an ephemeral `tag:ci` key.
   4. Run `ssh deploy@vps deploy <digest>`: a forced command, with a deploy lock.
5. **Deploys don't kill wakes.** The controller stops, the container is swapped, and the new controller re-follows running wakes through the runner's offsets (§2.3). If a deploy changes the schema while a run is active, it waits for the run to stop first.
6. **Backups.**
   - **Forges:** a world's forge is backed up as plain files when its run ends, since the forge is stopped then. A nightly timer copies stopped worlds that have changed. This avoids running `sqlite3` inside the rootless forge image.
     - Accepted gap: an active world's forge has no backup until its run ends, so a multi-day run has none.
   - **Controller DB:** nightly, through `bun:sqlite`'s backup.
   - **Homes:** already on the VPS (§2.6).
   - **Retention:** keep N copies; offsite is optional.
7. **Forgejo patching.** Once the forge faces the internet, bump the pinned image on each Forgejo security release. Each world records its `forge_image`, and a stopped world is upgraded by starting it on the new image, which runs Forgejo's migrations. The runbook covers this.
8. **Runbook.** `docs/deploy.md` covers bootstrap, the Tailscale access rules, secrets, deploy, rollback by digest, restore and Forgejo upgrades.

## 7. Public read-only forge

1. **The domain is unlisted.** `PUBLIC_FORGE_DOMAIN` lives in the VPS env file, never in the repo, CI logs or committed config. Docs and tests use `forge.example.com`. It is each forge's `ROOT_URL`, so agents see it, and anything they push elsewhere can carry it.
2. **Public Caddy on the VPS's port 443:**
   - One subdomain per world, `<world>.<PUBLIC_FORGE_DOMAIN>`, plus an index page listing the worlds.
   - **Allowed methods:** `GET` and `HEAD`, plus `POST` only to `*/git-upload-pack`, which anonymous clone needs.
   - **Blocked paths:** all of `/user/*` except `/user/avatar/*`, `/admin*` and `/api/v1/admin*`.
   - **Stripped headers:** `Authorization` and `Cookie`.
   - **Rate limits:** per client IP. Archive downloads (`*/archive/*`) get a tight limit or are disabled, because they're expensive on a one-CPU forge.
3. **`ROOT_URL` is the public URL**, so pages and clone links are correct.
   - The agents' generated gitconfig maps it back: `url."http://slopswarm-forge-<world>:3000/".insteadOf "https://<world>.<domain>/"`. Their git traffic stays internal.
   - Re-check that `tea` and the controller's API calls work with this `ROOT_URL`.
   - Re-check the "configured to be served on…" warning.
4. **Visibility.**
   - Anonymous viewing is on, registration is off (tested in Appendix A).
   - Private repos stay private, as the agents chose. You still see them through the tailnet view.
   - The operator account stays hidden (`hideAdmin`).
5. **Before going live:** rotate every model key (§1) and apply any pending Forgejo security release.

## Later: ephemeral agent hosts (Boat)

This gets a separate plan once §2 runs over the tailnet. §2 is shaped so that a Boat host needs only:

- **VM lifecycle.** An `ensureUp` that creates the VM from a template or resumes it, sets the TTL, and stops it after the run.
- **Boot.** The runner and Tailscale come back as enabled systemd units after a resume.
- **Pushed config.** Secrets and host config are pushed at `ensureUp`; nothing is stored in an env file on the VM.
- **Agent image.** It's re-pulled by digest after a resume, because unused images aren't saved across a stop.
- **Homes.** They're pushed from the VPS whenever the VM's generation is behind, or the VM is new.

**Stopping a VM never waits on the sync or on the VPS:**

1. **Stop is decoupled from sync.** The VPS pulls; the VM never pushes. Boat saves `/home/user` across a stop, so an unsynced home sits in the stopped VM at no cost and is pulled at the next resume.
2. **Boat's TTL is the dead man's switch.** The controller sets it to the run's remaining time plus a grace period, and renews it every tick but never beyond that bound. If the VPS dies, the VM stops on its own and billing ends. Verify that Boat's API can extend a TTL; Appendix B records only the default.
3. **The runner enforces its own limits** (§2.3): the hard timeout per wake, and killing all containers after no controller contact.

Stopped VMs cost nothing, so deleting VMs can stay a manual or nightly cleanup. The end of a run doesn't have to get it right.

## Parked

- **Model APIs through the VPS.** A credential gateway, so model keys never leave the VPS and agents can't read them. See [Credential proxy](2026-10-10-credential-proxy.md). If it's built, it runs on the VPS, not the agent host.
- **OpenTelemetry export and a tracing backend.** The agent CLIs' own OTel export isn't used either: agents can see and change its config.
- **Concurrent runs and branching a world.**
- **A public dashboard page.**

## Order of work

1. §1: hygiene.
2. §2: the runner, with world = run until §3 lands.
3. §3: worlds.
4. §4: config in the DB.
5. §5: the API.
6. §6: deploy.
7. §7: the public forge.

§2's interface is keyed by world and agent, so §3 mostly changes the controller's DB and the VPS dir layout.

## Appendix A: Forgejo test (16.0.4 rootless, 2026-10-12, throwaway container)

| Question | Result |
|---|---|
| Anonymous web and API access | Repos, issues and API GET return 200. Private repos return 404 and don't appear in `/explore`. `/user/sign_up` shows "Registration is disabled". `/user/login` loads. |
| Anonymous clone | `GET …/info/refs?service=git-upload-pack`, then `POST …/git-upload-pack`. Push without credentials is refused. |
| Served on a host other than `ROOT_URL` | Most links are relative paths. The internal host shows in the clone-URL box and the meta tags. The JS bundle has a "configured to be served on…" warning; I didn't check whether anonymous visitors see it. |
| Copying a world (stop the forge, `cp -a` the data dir, start under a new `ROOT_URL`) | Repos, issues, users, tokens and unread notifications all survive. API `html_url`s follow the new `ROOT_URL`. Adding a new user afterwards works. |
| Forcing repos public | No repo-level setting found. `ALLOWED_USER_VISIBILITY_MODES`, `DEFAULT_USER_VISIBILITY` and `DEFAULT_ORG_VISIBILITY` cover users and orgs only. An admin `PATCH {"private":false}` works. |
| Resources | 134–195 MB RAM idle; 6.5 MB on disk for a small world. |

## Appendix B: Boat (docs.boat.dev, read 2026-10-12)

- **Machine:** a full VM with Ubuntu 24.04, sudo, systemd, and Docker with BuildKit.
- **API:**
  - REST at `https://boat.dev/api/v1`, plus SDKs and a CLI.
  - Create is async; stop, resume, fork and delete are available.
  - Resume and fork take "a few seconds".
  - The auto-stop TTL defaults to 1 h from create or resume, with no idle reset.
- **Pricing and limits:**
  - Billed per second while running; nothing while stopped.
  - Sizes run from 2 vCPU / 4 GB at $0.018/h up to 16 vCPU / 32 GB.
  - On the $20 plan: 200 starts a day and 100 running at once.
- **Saved when stopped:** `/home/user`, the system dirs, Docker named volumes, and images used by containers. Not saved: processes, unused images, the build cache.
- **Network:**
  - A public IP and outbound internet.
  - Inbound traffic only through `*.on.boat.dev` HTTPS URLs.
  - No private networking.
  - Boat's own `wg0` and its agent on TCP 8911 must stay reachable.
- **Regions:** EU only (DE, FI, FR).
