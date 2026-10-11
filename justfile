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

# start a new run (default: the 1-hour run), run the controller and serve the dashboard on localhost:7777
up swarm="config/swarm.yaml":
    {{cli}} up {{swarm}}

# 8-minute smoke run: 1 Claude + 2 Codex agents, checks wakes, costing and the forge
smoke:
    {{cli}} up config/smoke.yaml

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

# print a wake transcript in full (default: latest wake); --full also shows long tool output
logs NAME *args:
    {{cli}} logs {{NAME}} {{args}}

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
