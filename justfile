# Tiny Society Token Probe. See docs/plans/2026-10-10-tiny-society-token-probe.md (§9).
set dotenv-load := false

cli := "bun src/cli.ts"

# list recipes
default:
    @just --list

# bun install, build the image, start the proxy, init the DB, create .env
setup:
    bun install
    {{cli}} setup

# run the pre-flight checks (optionally only some: just preflight 3 4)
preflight *checks:
    {{cli}} preflight {{checks}}

# start a run in a new world from a preset (default: swarm, the 1-hour run; a path loads that file), run the controller and serve the dashboard on localhost:7777; --world W continues a world, --brief "…" adds a note to each agent's first wake
up *args:
    {{cli}} up {{args}}

# start a run that continues world W (its forge, the agents' homes and sessions): just continue W [swarm.yaml] [--brief "…"]
continue world *args:
    {{cli}} continue {{world}} {{args}}

# config in the DB: list (presets, agent profiles, each seed's active version), seeds (every version), import / export [dir] (default config/); --json
config *args:
    {{cli}} config {{args}}

# back up now through the controller: the DB, and the forges of the given idle worlds (VPS: also nightly with SLOPSWARM_BACKUPS=1)
backup *worlds:
    {{cli}} backup {{worlds}}

# run an idle world's forge on a new Forgejo image (security releases; Forgejo migrates it on start)
forge-upgrade world image:
    {{cli}} forge-upgrade {{world}} {{image}}

# what a world's agents published (default: the newest world): each public repo's default branch as a static site (--json)
pages *args:
    {{cli}} pages {{args}}

# list worlds: runs, agents, home generations (--json)
worlds *args:
    {{cli}} worlds {{args}}

# the runner daemon for an agent host (env: SLOPSWARM_RUNNER_TOKEN, SLOPSWARM_RUNNER_HOST, SLOPSWARM_RUNNER_PORT, SLOPSWARM_RUNNER_DATA_DIR); `just up` starts one in-process otherwise
runner:
    {{cli}} runner

# the controller service in the foreground, idle until a launch (dashboard + API on :7777; the VPS runs this); env: SLOPSWARM_BIND, SLOPSWARM_API_TOKEN, SLOPSWARM_RUNNER_URL + SLOPSWARM_RUNNER_TOKEN, SLOPSWARM_ALL_FORGES, SLOPSWARM_FORGE_PUBLISH
serve:
    {{cli}} serve

# 8-minute smoke run: 1 Claude + 2 Codex agents, checks wakes, costing and the forge
smoke *args:
    {{cli}} up smoke {{args}}

# restart the controller on an existing run (default: latest)
resume run="":
    {{cli}} resume {{run}}

# more world time and/or budget for a run (default: latest): --time 1h, --swarm-usd 2, --agent-usd 0.5 (every agent), --agent-usd bramble=1 (one agent)
extend *args:
    {{cli}} extend {{args}}

# graceful stop: no new wakes, running ones finish
stop:
    {{cli}} stop

# EMERGENCY: docker kill the current run's containers and mark it stopped
kill:
    {{cli}} kill

# pause an agent (takes effect after its current wake)
pause NAME:
    {{cli}} pause {{NAME}}

# unpause an agent
unpause NAME:
    {{cli}} unpause {{NAME}}

# wake an agent now
wake NAME:
    {{cli}} wake {{NAME}}

# terminal table of agents: state, next wake, spend
status run="":
    {{cli}} status {{run}}

# print a wake transcript (`just logs NAME [wake] [--full]`), or with no NAME the controller's and runner's structured logs (`--since 30m`, `--json`)
logs *args:
    {{cli}} logs {{args}}

# dashboard for browsing past runs when no run is going (port 7777, override with PORT=); also serves that run's forge
dash run="":
    {{cli}} dash {{run}}

# Markdown cost summary
report run="":
    {{cli}} report {{run}}

# unit tests
test:
    bun test

# type-check
typecheck:
    bun run typecheck

# wipe data/ (asks first)
reset:
    {{cli}} reset

# compile the SvelteKit dashboard (also automatic before serving)
ui-build:
    {{cli}} ui-build

# dashboard development with HMR (read-only, no Docker required)
ui-dev:
    {{cli}} ui-dev
