# OpenRouter models, the pi harness, a search relay and web fetch

- **Status:** open
- **Date:** 2026-10-11
- **Parent:** [Tiny Society Token Probe](2026-10-10-tiny-society-token-probe.md)

Let an agent run any OpenRouter model (open models first: GLM, DeepSeek, Kimi, Qwen…) with the same per-request costing as the Claude and Codex agents, and give those agents web search.

## Decisions

- **Harness:** a third harness (agent CLI; called "runtime" until the rename), `pi` (`@earendil-works/pi-coding-agent`, MIT, npm-pinned). It emits one `message_end` per API request with normalised usage (input excludes cache; cacheRead, cacheWrite, cacheWrite1h, reasoning) and the OpenRouter generation id (`responseId`); it has 4 small tools and a short prompt (low per-wake overhead), and `--session-id` lets the controller pick the session id. Claude Code and Codex stay on their own vendors' models: OpenRouter only guarantees Claude Code with Anthropic, and Codex is Responses-only and tuned to OpenAI tools.
- **Routing:** OpenRouter presets only, referenced in the model string: `model: z-ai/glm-5.3-flash@preset/sw-glm-5-3-flash`. The slug before `@` is the model we price; the preset (configured by the owner in OpenRouter, empty system prompt) holds provider routing. No routing settings in our config.
- **Keys:** plain env vars in `.env`. An agent names the variable (`key_env`, default `OPEN_ROUTER_API_KEY`); the owner may keep one key per model setup for a separate OpenRouter credit limit, but that's only a convention. OpenRouter keys can't be tied to a model or preset. The key reaches the container as `OPENROUTER_API_KEY` via `-e NAME` (never in argv), like the Claude token.
- **Prices:** fetched, not typed. At run start the controller reads `GET https://openrouter.ai/api/v1/models` (public, no key) for the OpenRouter models the run uses, converts them and merges them into the run's pricing snapshot (`runs.pricing_yaml`), so a run's costs stay reproducible. A model already in `config/pricing.yaml` keeps the hand-written price.
- **Cross-check:** after each wake, look up every request's generation id at `GET /api/v1/generation?id=…` (with the key) and store OpenRouter's charged cost and serving provider beside our computed cost. Our per-request cost stays authoritative (AGENTS.md invariant); the vendor number is the cross-check, as with Claude's `total_cost_usd`.
- **Search:** our own relay, not OpenRouter's web plugin (it searches on every request, pi's own `tools` array would override a preset's server tool, and its fee doesn't appear in pi's usage). Provider: Exa (`costDollars` in every response, per-key spend cap, no card). Kept swappable (Parallel is the runner-up).
- **Agent-visible prices:** each agent's `/self/pricing.yaml` holds only its own models (done in 537846c).

## 1. pi harness

Done (pi 1.1.0).

1. ✅ **Spike** (in the agent image through the egress proxy, real key, under a cent). Found:
   - The literal model string reaches OpenRouter and the preset applies (the generation record has a `preset_id`). pi warns "not found … using custom model id" and builds the model from the provider's *default* model's metadata (Kimi's), whose `max_tokens` (943,717) some of the preset's providers reject with a 400. So the controller writes `models.json` for pi agents with an explicit entry per model (§2: from the OpenRouter catalogue, `maxTokens` capped).
   - `message_end` usage as documented: `input` excludes `cacheRead`; `reasoning` is inside `output`; `responseId` is the `gen-…` id. `message_update.usage` has no id and stays 0 until the end, so only `message_end` is used. pi exits 0 even when every retry failed: the parser decides from the last stop reason.
   - Caching: GLM via the preset caches implicitly (`cacheRead` on the next request, `cacheWrite` 0); no `cacheControlFormat` needed.
   - Resume with `--session-id` works (same session file, earlier context cached). New sessions use pi's own id from the `session` header.
   - With `--offline` and `PI_TELEMETRY=0` only `openrouter.ai` is contacted. The wake prompt overhead with the real seed is ~1.1K tokens.
   - Fixtures: `test/fixtures/pi-hi.jsonl`, `pi-resume-wake2.jsonl`, `pi-session.jsonl`, `pi-error.jsonl`.
2. ✅ `docker/agent.Dockerfile`: pinned pi (node:22 has 22.23), labelled, `PI_OFFLINE`/`PI_TELEMETRY=0` set.
3. ✅ `src/harnesses/pi.ts`: command, env (`PI_CODING_AGENT_DIR=/runtime/pi`, sessions in `/runtime/sessions`), parser, `finalizeUsage` from the session file.
4. ✅ **Max turns:** the parser emits `turn_start`; the controller stops the wake past `max_turns` (adapter `maxTurnsBy: "turns"`; Codex is `"tool_calls"`).
5. ✅ `Harness` gains `pi`; `config.ts` accepts it. Fixture tests in `test/harnesses.test.ts`.

## 2. OpenRouter wiring

Done.

1. ✅ Agent config: `provider: openrouter` (default `native`), `key_env` (default `OPEN_ROUTER_API_KEY`, must be an env var name). `harness: pi` ⇔ `provider: openrouter` for now. Run start fails naming the variable if it's unset; the parser fails if `openrouter.ai` isn't on the allowlist. The key goes in as `-e OPENROUTER_API_KEY`, its value only in the `docker run` child's env (`docker.ts` `dockerProcessEnv`).
2. ✅ Pricing: tiers accept `per_mtok` absolute prices next to multipliers (fields a tier lacks keep the base price). `src/openrouter.ts` maps the catalogue (`min_prompt_tokens` overrides → tier above `min − 1`; time-window overrides not modelled) and inserts the entries as text into the `models:` block of the run's snapshot, other top-level sections untouched. A model in neither the catalogue nor `config/pricing.yaml` fails the run start. The same fetch writes pi's `models.json` per pi agent (needed for presets, §1.1): catalogue metadata, thinking-level map from `supported_efforts`, output capped at 32K.
3. ✅ Cross-check: `requests.vendor_cost_usd` / `vendor_provider`, filled after the wake from `/api/v1/generation` (404s retried a few times; failures logged as `openrouter_cost` events). The wake's `reported_cost_usd` is their sum when every request resolved, so the existing report line and dashboard stat cover it; the report adds a by-provider table, the dashboard's request chips show the charge.
4. ✅ `openrouter.ai` on the allowlist in `config/*.yaml`.
5. ✅ Sample agent `config/agents/fern.yaml`; `.env.example`; preflight check 8 (models.json, one lean pi wake through the proxy, computed vs charged) and an `openrouter.ai` probe in check 3.

**Finding:** the catalogue price is the list price; a preset routes to cheaper providers. In preflight check 8 (GLM 5.3 Flash via StreamLake) we computed $0.00184 and OpenRouter charged $0.00084 (−55%). Per-provider prices are at `/api/v1/models/<slug>/endpoints`; pricing each request at its serving provider's price (from the generation lookup) would close the gap, but is not done: our number is an upper bound.

## 3. Search relay

**Done** (code in `src/search.ts`, `docker/search/`, `docker/websearch`). Choices beyond the list below: one relay container per run (`slopswarm-search-<run>`, like the forge), not a shared compose service, so each run's log and tokens stay in its data dir; it reaches api.exa.ai over the egress network directly (the only host it calls, enforced in code), so api.exa.ai never goes on the proxy allowlist. Tokens are per wake (hash in the relay's tokens file, revoked at wake end). Searches are billed as request rows (model `exa-search`, `web_searches` 1, no tokens; `wakes.requests` stays model requests only) priced from a `search:` section in `pricing.yaml`; failed searches are logged, not billed. Per agent `search: native | relay`, checked against the harness (adapter `searchModes`: claude/codex both, default `native`; pi `relay` only); `relay` turns Claude's WebSearch tool / Codex's `web_search` off; relay agents get one prompt line and `exa-search` in `/self/pricing.yaml`. Preflight check 9. Open: a search still in flight when its wake is killed is logged after billing and stays unbilled (Exa charges it).

1. `docker/search/` (Bun, small): an HTTP service on `slopswarm-internal` + egress, holding `EXA_API_KEY` from `.env`. `POST /search {query, …}` → Exa `/search` (`type: auto`, ~8 results, highlights with a character cap) → compact text/JSON for the agent.
2. Agents authenticate with a per-agent token the controller writes to the runtime dir (identifies agent + wake; useless outside the internal network).
3. Every search is logged (agent, wake, query, result count, our computed cost, Exa's `costDollars.total`) to `data/runs/<run>/search.jsonl`; the controller ingests it into the DB as usage (it stays the only DB writer), counted in the per-wake and per-agent budgets. Our cost = Exa's documented formula; `costDollars` is the cross-check.
4. `websearch "query"` CLI in the agent image; one line in the pi system prompt. Errors (Exa down, cap reached → 402) return a short message to the agent, never fail the wake.
5. Claude and Codex agents keep their vendors' native search; recorded as a known difference.

## 4. Web fetch (`webfetch`)

**Done** (owner decision "option B": agents of every harness may read pages and download files, without opening the egress proxy). Code in `docker/search/webfetch.ts` (guard, fetch, HTML → text), `docker/search/relay.ts` (`POST /fetch`), `docker/webfetch` (CLI), `src/webfetch.ts` (prompt block, log reader).

1. ✅ Config: optional swarm-wide `webfetch: {max_mb, timeout_s, max_redirects}` (defaults 20 / 30 / 5; bounds 100 MB / 120 s / 10); absent or `false` = off. On in `config/swarm.yaml` and `config/smoke.yaml`.
2. ✅ The relay runs when an agent has `search: relay` **or** the world has webfetch; then every wake gets a relay token, `search: false` unless the agent searches through the relay (such tokens get 403 on `/search`). The limits reach the relay as `WEBFETCH_*` env; without them `/fetch` answers 503.
3. ✅ Guard: http/https only, ports 80/443 only, no credentials in URLs, GET only with a fixed User-Agent and no agent headers/cookies/body. The relay resolves the hostname and refuses if any address is not public unicast (IPv4 special-purpose ranges incl. RFC 1918, CGNAT, 169.254/16, 198.18/15, multicast, reserved; IPv6 outside 2000::/3 and its documentation/Teredo blocks; mapped/NAT64/6to4 judged by their IPv4). Single-label names (Docker containers) and .local/.internal/.localhost/… are refused before DNS. The connection goes to the vetted address (`node:https` with `host` = IP, `servername` = hostname, so SNI and the certificate check use the name); redirects are followed by hand and each hop is checked the same way. One deadline for the whole fetch, a byte cap on the decoded body (Content-Length up front, then while streaming; gzip/deflate decoded under the cap).
4. ✅ Answers: HTML → markdown-ish text by a small dependency-free converter (drops script/style/nav/footer/aside, prefers `<main>`/`<article>`, keeps headings, lists, code blocks, table rows, `[text](absolute url)` links), cut at 40K characters; other text types as text; binary without `-o` → "use -o" (exit 8); `-o` returns the bytes. A one-line header gives final URL, status, type and size. The relay image moved to Bun 1.4.3 (1.2.19's fetch-based `node:https` ignored `servername`).
5. ✅ Log: `search/log/fetch.jsonl` (agent, wake, url, final_url, status, relay_status, content_type, bytes, redirects, raw, latency, blocked/error). Free, so not in the DB: `just report` has a "Web fetch" section, the wake page a "web fetches" stat.
6. ✅ Prompt: two lines for every harness (claude `--system-prompt`, codex `model_instructions_file`, pi `--system-prompt`), built from the limits; Claude's own WebFetch stays off.
7. ✅ Tests (`test/webfetch.test.ts`) and preflight check 10 (public page as text and raw; metadata, loopback, dashboard port, proxy, the relay itself, a private and an IPv4-mapped address, `file:` all blocked; a fetch-only token can't search; direct `curl` still refused).

Open: no per-wake fetch count or rate limit (fetches are free; the log shows abuse after the fact). Data can leave in URLs (query strings), as through the GitHub outlet. IPv6-only hosts are fetched only if the relay's network routes IPv6 (IPv4 is preferred).

## Not verified yet

- ~~pi passes `…@preset/…` through unchanged~~ (yes, with a `models.json` entry; §1.1).
- ~~OpenRouter's Anthropic-style caching for GLM via pi~~ (not needed: GLM caches implicitly; §1.1). Models that need explicit `cache_control` (Anthropic, some Gemini) aren't covered yet.
- Compaction usage: parsed from `compaction_end` and the session file's `compaction` entries, tested on a synthetic stream only.
- Exa `costDollars` equals the bill.
- A full `just smoke`-style run with a pi agent (only unit/controller tests and preflight check 8 so far).
- Compaction and long-context tiers on real OpenRouter traffic.
- ~~Whether Exa `/search` bills highlights per page~~ (no: a live search with highlights for 2 results cost $0.007 by `costDollars.total`, our old formula said $0.009; `per_page_usd.highlights` is now 0, checked 2026-10-11, and the live test asserts computed = Exa's cost). Text and summary pages on `/search` are still unverified (the relay doesn't ask for them).
