# AGENTS.md

Token-cost probe for a small society of CLI agents. The original spec, `docs/plans/2026-10-10-tiny-society-token-probe.md`, gives the design and rationale but is no longer maintained; the current behaviour is in the code, `README.md` and this file.

- **Stack:** Bun + TypeScript for the controller; Svelte 5 / SvelteKit for the dashboard, compiled with Vite (also running on Bun). Dashboard startup automatically builds when sources change; `just ui-build` forces a build and `just ui-dev` starts read-only HMR. `just` is the entry point; every recipe calls `src/cli.ts`.
- **Verify:** run `just test` and `just typecheck` before you finish. `just preflight` needs Docker and the secrets.
- **Map:**
  - `src/controller/`: scheduler, wake, notification poller, budget and `/self` writer (`/self/pricing.yaml` is the run's price table cut to the agent's own models; costing uses the full table). It is the only DB writer; the CLI and dashboard only enqueue into `controls`.
  - `src/harnesses/`: one adapter per agent CLI, the *harness* (`claude`, `codex`, `pi` for OpenRouter models; agent YAML `harness:`). Not to be confused with an agent's runtime dir (mounted at `/runtime`), its CLI state. Fixture-tested in `test/fixtures/`.
  - `src/pricing/`: per-request USD from `config/pricing.yaml` (plus fetched OpenRouter list prices, frozen into the run).
  - `src/openrouter.ts`: OpenRouter catalogue (prices, pi's `models.json` entries) and the per-generation charged-cost cross-check. OpenRouter agents: `harness: pi`, `provider: openrouter`, `key_env` (default `OPEN_ROUTER_API_KEY`); keys go into containers by name only.
  - `src/docker.ts`, `src/proxy.ts`, `docker/`: the container and egress boundary.
  - `src/forge.ts`: the run's Forgejo (the agents' shared space): containers, accounts, agent logins, notification counts.
  - `src/github.ts`: the agents' public outlet: one GitHub org and shared account, logged in per wake from `secrets/github/token`.
  - `src/search.ts`, `docker/search/relay.ts`, `docker/websearch`: the web search relay (Exa) for agents with `search: relay`: one container per run on the internal + egress networks, per-wake tokens, `search/log/search.jsonl` billed to the wake as `exa-search` request rows. `EXA_API_KEY` reaches only the relay; api.exa.ai stays off the proxy allowlist.
  - `src/world.ts`: a run's world time and effective swarm budget, extensions included (`just extend`).
  - `src/dashboard/ui/`: SvelteKit routes/components; `src/dashboard/service.ts`: dashboard data and control queue; `src/dashboard/server.ts`: embedded Bun server. `src/report.ts`: read-only report.
- **Invariants:**
  - Cost is computed per API request; vendor totals are only a cross-check.
  - Never weaken the container flags or the egress allowlist without being asked. The forge container stays on the internal network only (no route out).
  - Never print or commit secrets (`.env`, `secrets/`).
  - Committed fixtures must be scrubbed of identities, but keep their token counts.
- **Worktrees:** each has its own `./data` (`SLOPSWARM_DATA_DIR` to point elsewhere). The dashboard defaults to port 7777 and the run's forge to `127.0.0.1:3300`; if either is taken, the next free port is used and printed (`PORT=` / `FORGE_PORT=` pick the starting port). After a run ends, `just up`/`smoke`/`resume` keep both up until Ctrl-C. The proxy has no host port. The egress proxy is shared; the agent image is tagged with the Dockerfile hash and built on demand.
- **Docs:** don't update the original spec or finished plans. Record behaviour changes in `README.md` / this file (and code comments); give new work its own plan in `docs/plans/`. Once every item in a plan is done, move it to `docs/plans/_archive/` and mark it done in its header; carry any leftovers to an open plan.
- **Don't** run `claude` or `codex` with `--dangerously-*` flags on the host; only inside the agent container.
