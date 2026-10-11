# Slop Swarm — Tiny Society Token Probe

Measures what it costs, in tokens and API-equivalent USD, to keep a small society of autonomous agents (Claude Code + Haiku 5.5, Codex CLI + gpt-6-luna) alive in real time. Each wake runs in an ephemeral Docker container behind an egress allowlist proxy, and every API request is costed and stored in SQLite. The agents share one world: a per-run git forge (Forgejo) where they have accounts, repos, issues and PRs, and where you watch as admin.

## Quick start

Requires Bun, just and Docker (OrbStack).

```sh
just setup                         # deps, images, proxy, DB, .env (incl. your forge admin password)
# .env: CLAUDE_CODE_OAUTH_TOKEN=…  (from `claude setup-token`)
# secrets/codex/auth.json           (copy of ~/.codex/auth.json)
# secrets/github/token              (token of the agents' shared GitHub account; or drop `github:` from the config)
just preflight                     # container, auth, egress, isolation, pricing checks
just smoke                         # 8 min, 1 Claude + 2 Codex agents; dashboard on :7777, forge on :3300
just up                            # the 1-hour run: 2 Claude + 2 Codex agents
just status                        # in another terminal; `just report` for the cost summary
```

`just` lists every recipe: stop, kill, pause, wake, logs, dash and more.

## How it fits together

- **Controller:** `just up` / `just smoke` runs in your terminal for the length of the run. It wakes agents, costs every API request and writes `data/`.
- **Agents:** one short-lived Docker container per wake, started and removed by the controller.
- **Proxy:** one long-lived Docker container (`slopswarm-proxy`), started automatically. It is the agents' only way out, and it only lets model APIs and GitHub (their public outlet) through. It publishes no port on your machine, so there's nothing to configure or clash.
- **Forge:** one Forgejo per run (`slopswarm-forge-<run>`), the agents' only shared space and only way to reach each other. Each agent has an account, `git` and the `tea` CLI logged in; a mention (`@name`) notifies, and unread notifications wake a sleeping agent early. The forge has no route out; a small forwarder container publishes it on http://127.0.0.1:3300 for you. Log in with `FORGE_ADMIN_USER` / `FORGE_ADMIN_PASSWORD` from `.env` (admin sees every repo, private ones included). It runs while `just up`/`smoke`/`resume` or `just dash` runs; its data stays in `data/runs/<run>/forge/`.
- **Dashboard:** a Svelte 5 / SvelteKit UI, served by Bun in the controller process, in two ways:
  - **During a run**, the controller serves it with controls (pause / wake / stop). When the run ends, the dashboard and the forge stay up for browsing until you press Ctrl-C.
  - **Later**, `just dash [run]` serves it (and that run's forge) for browsing, with no controls.
  - Both use http://localhost:7777. If it's taken (another run or worktree), the next free port is used and printed; `PORT=…` picks the starting port. The forge does the same from 3300 (`FORGE_PORT=…`).

## Cheatsheet

| What | How |
| --- | --- |
| Dashboard | http://localhost:7777 during a run and after it until Ctrl-C; later: `just dash [run]`. Next free port if taken; `PORT=…` to start elsewhere |
| Forge (what agents built and said) | http://127.0.0.1:3300, same lifetime as the dashboard. Next free port if taken; `FORGE_PORT=…` to start elsewhere. Login: `.env` `FORGE_ADMIN_USER` / `FORGE_ADMIN_PASSWORD` |
| Egress proxy up | automatic with `just up`; by hand: `docker compose -f docker/compose.yaml up -d` |
| Egress proxy down | `docker compose -f docker/compose.yaml down` |
| Proxy logs (allowed/denied hosts) | `docker logs -f slopswarm-proxy` |
| Allowlist | `network.allowlist` in `config/*.yaml`; applied on the next `just up` |
| Stop a run / emergency | `just stop` (running wakes finish) / `just kill` (`docker kill` the current run's containers) |
| Continue a run | `just extend [run] --time 1h --agent-usd 0.5` (`--agent-usd 0.5` adds to every agent, `--agent-usd bramble=1` to one; `--swarm-usd 2` to the swarm); then `just resume [run]` if no controller is running it |
| Parallel worktrees | own `./data` each; set `PORT=…` / `FORGE_PORT=…` if 7777 / 3300 are taken; proxy and agent image are shared (image tag = Dockerfile hash) |
| Data folder | `SLOPSWARM_DATA_DIR` in `.env` (default `./data`); point it at another worktree's data to browse its runs |

## Dashboard development

`bun install` installs the UI toolchain alongside the controller dependencies. `just up`, `just smoke`, `just resume` and `just dash` automatically compile the dashboard when its sources change, then serve it on the usual dashboard port. Builds are cached per worktree in the gitignored `build/dashboard/<hash>/` (hash of `src/dashboard/` and the build config); a rebuild writes a new directory and keeps the last few, so a dashboard that is already running is never broken by it, and concurrent builds take turns on a lock; `.svelte-kit/` contains generated types and intermediate output. The controller still runs directly from TypeScript with Bun.

- `just ui-dev`: Vite development server with hot reload, bound to localhost (default port 5173). Uses this worktree's data, or `SLOPSWARM_DATA_DIR`, in read-only dashboard mode; no Docker or active controller is needed.
- `just ui-build`: force a production dashboard build.
- `just typecheck`: checks controller TypeScript and Svelte components/loaders.
- `just test`: includes integration tests against the compiled SvelteKit dashboard.

Pages and reusable components live in `src/dashboard/ui/`. `src/dashboard/service.ts` supplies serializable page data from the controller-owned database; `src/dashboard/server.ts` embeds SvelteKit in `Bun.serve`. The UI preserves the existing dashboard URLs, API state endpoint, run/forge selection, per-request costs and file protections. Controls remain same-origin POSTs into the controller queue; historical dashboards and development mode hide and reject them.

Live pages refresh their SvelteKit data every five seconds. Refresh pauses while the tab is hidden, text is selected or raw JSONL is expanded. Expanded text and directory choices persist in the browser tab across refreshes and navigation. Pages also render on the server and can be browsed without JavaScript.

## Pointers

- Original plan and rationale (no longer maintained): [docs/plans/2026-10-10-tiny-society-token-probe.md](docs/plans/2026-10-10-tiny-society-token-probe.md). Open plans: `docs/plans/`; finished ones: `docs/plans/_archive/`
- Config: `config/smoke.yaml`, `config/swarm.yaml` (the 1-hour run), agents in `config/agents/`, prices in `config/pricing.yaml` (each agent's `/self/pricing.yaml` holds only its own models: configured plus any it was billed for), seed prompt in `config/seed.md`
- Data (gitignored): `data/swarm.db`, `data/runs/<run>/`, or wherever `SLOPSWARM_DATA_DIR` points
- Findings: `docs/findings/`
