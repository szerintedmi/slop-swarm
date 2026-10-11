# OpenRouter models, the pi runtime and a search relay

- **Status:** open
- **Date:** 2026-10-11
- **Parent:** [Tiny Society Token Probe](2026-10-10-tiny-society-token-probe.md)

Let an agent run any OpenRouter model (open models first: GLM, DeepSeek, Kimi, Qwen…) with the same per-request costing as the Claude and Codex agents, and give those agents web search.

## Decisions

- **Harness:** a third runtime, `pi` (`@earendil-works/pi-coding-agent`, MIT, npm-pinned). It emits one `message_end` per API request with normalised usage (input excludes cache; cacheRead, cacheWrite, cacheWrite1h, reasoning) and the OpenRouter generation id (`responseId`); it has 4 small tools and a short prompt (low per-wake overhead), and `--session-id` lets the controller pick the session id. Claude Code and Codex stay on their own vendors' models: OpenRouter only guarantees Claude Code with Anthropic, and Codex is Responses-only and tuned to OpenAI tools.
- **Routing:** OpenRouter presets only, referenced in the model string: `model: z-ai/glm-5.3-flash@preset/sw-glm-5-3-flash`. The slug before `@` is the model we price; the preset (configured by the owner in OpenRouter, empty system prompt) holds provider routing. No routing settings in our config.
- **Keys:** plain env vars in `.env`. An agent names the variable (`key_env`, default `OPEN_ROUTER_API_KEY`); the owner may keep one key per model setup for a separate OpenRouter credit limit, but that's only a convention. OpenRouter keys can't be tied to a model or preset. The key reaches the container as `OPENROUTER_API_KEY` via `-e NAME` (never in argv), like the Claude token.
- **Prices:** fetched, not typed. At run start the controller reads `GET https://openrouter.ai/api/v1/models` (public, no key) for the OpenRouter models the run uses, converts them and merges them into the run's pricing snapshot (`runs.pricing_yaml`), so a run's costs stay reproducible. A model already in `config/pricing.yaml` keeps the hand-written price.
- **Cross-check:** after each wake, look up every request's generation id at `GET /api/v1/generation?id=…` (with the key) and store OpenRouter's charged cost and serving provider beside our computed cost. Our per-request cost stays authoritative (AGENTS.md invariant); the vendor number is the cross-check, as with Claude's `total_cost_usd`.
- **Search:** our own relay, not OpenRouter's web plugin (it searches on every request, pi's own `tools` array would override a preset's server tool, and its fee doesn't appear in pi's usage). Provider: Exa (`costDollars` in every response, per-key spend cap, no card). Kept swappable (Parallel is the runner-up).
- **Agent-visible prices:** each agent's `/self/pricing.yaml` holds only its own models (done in 537846c).

## 1. pi runtime

1. **Spike first** (in the agent image, real key, a few cents): run pi headless against `z-ai/glm-5.3-flash@preset/sw-glm-5-3-flash` through the egress proxy. Check: the literal model string reaches OpenRouter (pi's `--model` fuzzy-matches its catalogue; a `models.json` entry under `providers.openrouter.models` may be needed); `message_end` usage and `responseId` shape; session resume with `--session-id`; offline/telemetry off; nothing blocked or hanging on the allowlist. Save a scrubbed fixture (`test/fixtures/pi-*.jsonl`, keep token counts).
2. `docker/agent.Dockerfile`: install pinned pi (Node ≥ 22.19; bump the base image if needed). Label the version.
3. `src/runtimes/pi.ts`: `buildCommand` (`--mode json`, `--system-prompt <file>`, `--session-id`, `--session-dir` on the runtime mount, `--tools read,bash,edit,write`, no extensions/skills/MCP, offline), `containerEnv`, a parser (assistant text, tool calls/results, reasoning; usage from `message_end`, upserted by `responseId` because `message_update` usage is cumulative; compaction usage counted too), `finalizeUsage` from pi's session file. Split lines on LF only.
4. **Max turns:** pi has no flag. The controller counts turns from the stream and stops the container, like the budget kill.
5. `Runtime` gains `pi`; `config.ts` accepts it. Fixture tests like the Claude/Codex ones.

## 2. OpenRouter wiring

1. Agent config: `provider: openrouter` (default `native`), `key_env` (default `OPEN_ROUTER_API_KEY`). `runtime: pi` requires `provider: openrouter` for now. Validation: the env var is set at run start (name it in the error, never the value).
2. Pricing: extend tiers to accept absolute per-field prices (OpenRouter `overrides[].min_prompt_tokens` + prices) next to today's multipliers. Map `prompt`→input, `completion`→output, `input_cache_read`→cache_read, `input_cache_write`→cache_write_5m, `input_cache_write_1h`→cache_write_1h, `web_search`→tool fee; per-token → per-Mtok. Price key = the slug before `@` (and before any `:` suffix that isn't a separate catalogue entry). Models without cache-write pricing → 0. Fail the run start if a used model isn't in the catalogue and not hand-priced.
3. Cross-check: `requests` gains vendor cost + provider columns (nullable); filled after the wake; report and dashboard show the delta. Failures to fetch are logged, never fatal.
4. `openrouter.ai` on the allowlist in `config/*.yaml`.
5. A sample agent `config/agents/<name>.yaml` on `z-ai/glm-5.3-flash@preset/sw-glm-5-3-flash` (not added to the default runs). `.env.example`: `OPEN_ROUTER_API_KEY=`. Preflight: pi auth + one request through the proxy.

## 3. Search relay

1. `docker/search/` (Bun, small): an HTTP service on `slopswarm-internal` + egress, holding `EXA_API_KEY` from `.env`. `POST /search {query, …}` → Exa `/search` (`type: auto`, ~8 results, highlights with a character cap) → compact text/JSON for the agent.
2. Agents authenticate with a per-agent token the controller writes to the runtime dir (identifies agent + wake; useless outside the internal network).
3. Every search is logged (agent, wake, query, result count, our computed cost, Exa's `costDollars.total`) to `data/runs/<run>/search.jsonl`; the controller ingests it into the DB as usage (it stays the only DB writer), counted in the per-wake and per-agent budgets. Our cost = Exa's documented formula; `costDollars` is the cross-check.
4. `websearch "query"` CLI in the agent image; one line in the pi system prompt. Errors (Exa down, cap reached → 402) return a short message to the agent, never fail the wake.
5. Claude and Codex agents keep their vendors' native search; recorded as a known difference.

## Not verified yet

- pi passes `…@preset/…` through unchanged (spike, §1.1).
- OpenRouter's Anthropic-style caching for GLM via pi (`compat.cacheControlFormat`).
- Exa `costDollars` equals the bill.
