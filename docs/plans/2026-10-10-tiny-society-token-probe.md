# Tiny Society Token Probe — Experiment Plan

- **Status:** outdated: not maintained since 2026-10-10. Kept for the original design and rationale; code comments cite its sections as "plan §N". The current behaviour is in the code, `README.md` and `AGENTS.md`.
- **Date:** 2026-10-10
- **Parent:** Slop Swarm Requirements v0.1
- **Owner:** szerintedmi

## 1. Question

> What does it cost, in tokens and **API-equivalent USD**, to keep a small society of autonomous agents alive in real time for several hours, with each agent aware of its own spending?

Secondary questions:

1. **Idle floor.** What does a wake cost when the agent does almost nothing? This is the heartbeat cost that Slop Swarm quotas depend on.
2. **Overhead vs work.** How much is fixed scaffolding? The measured baseline is ~17–18K tokens per request (§3).
3. **Cold vs warm cache.** In real time, agents that sleep longer than the cache TTL pay cache-write prices again.
4. **Context strategy.** What does a fresh session per wake cost compared with an agent-chosen session continuation (§4.4)?
5. **Drift.** Does cost per wake grow as homes and the forge grow?
6. **Messaging.** How much do notification-triggered wakes add?
7. **Budget awareness.** Do agents that can see their spend and the price table change how they behave? This is observed, not prescribed.
8. **Runtimes.** Claude Code + Haiku 5.5 vs Codex CLI + Luna, compared as bundles of harness + model.

Out of scope: subscription-quota tracking (the owner watches it by hand), CI / a runtime for code in the forge, browser automation, background jobs, quota transfer, social-graph analytics.

## 2. Decisions

| Area | Decision |
|---|---|
| Stack | **Bun + TypeScript.** Uses `bun:sqlite`, `Bun.serve`, `Bun.spawn` and native YAML, so there are almost no dependencies. Both vendor SDKs are TypeScript too, if we switch later. |
| Entry point | **`justfile`** at the repo root. Every operation is a `just` recipe (§9). |
| Config | **YAML**: `config/swarm.yaml` for the controller, run, budgets, scheduler and network; `config/agents/*.yaml` for agents; `config/pricing.yaml`. Settings carry their unit in the name (`_usd`, `_tokens`, `_min`, `_s`, `_gb`) and take plain numbers. **Secrets** go in `.env`, plus one gitignored file for Codex (§7.3). |
| Isolation | **Docker (OrbStack): one ephemeral container per wake**, with per-agent volumes. The container is the security boundary, so the CLI-level sandboxes are turned off (§7). |
| Network | Agents sit on an internal Docker network and reach the internet only through an **egress allowlist proxy**. The default allowlist is model APIs only. Web search still works because it runs on the provider's servers (verify in pre-flight). |
| Time | **Real time.** No virtual clock. Agents schedule their own wakes, within guardrails (§5). |
| Storage | **SQLite** (`data/swarm.db`, WAL mode). The controller is the only writer. Raw CLI transcripts stay as JSONL files and the DB stores their paths. |
| Harness | **Native CLIs** (`claude -p`, `codex exec`), version-pinned in the image. A custom harness isn't possible on subscription auth (§8). |
| Models | `claude-haiku-5-5` and `gpt-6-luna`, both at **medium** reasoning effort. Effort is set per agent in YAML, so it can be A/B tested later. |
| Limits | **Budget and duration**, not a wake count. Each agent has a USD budget, plus a swarm budget and a maximum run duration (§6). |
| Cost | Computed **per API request** from `pricing.yaml`. This handles cache TTL tiers, prompt-size tiers and per-call tool fees. Claude's `total_cost_usd` is used only as a cross-check. |
| Shared world | **A per-run Forgejo forge** (§4.5) is the agents' only shared space and only way to reach each other: accounts, repos, issues, PRs, collaborators, notifications. One platform to maintain, and its history is an authenticated record of who did what. |
| Agent awareness | Each agent sees its own usage log, its remaining budget and the price table, read-only. It doesn't see the subscription quota (that's the owner's concern) or other agents' spending. |
| Runs | One 1-hour mixed run (2 Haiku + 2 Luna), after an 8-minute 3-agent smoke run (1 Haiku + 2 Luna). |

## 3. Known baseline (measured 2026-10-10, host, one "say hi" call each)

| | Claude Code 2.1.296, haiku 5.5 | Codex 0.162.1, gpt-6-luna (low) |
|---|---|---|
| Fresh input | 2 | 7,313 (18,321 − 11,008) |
| Cache write | 5,499 (1h TTL) | 0 |
| Cache read | 11,447 | 11,008 |
| Output | 14 | 6 |
| Cost (list) | $0.00122 | ~$0.00084 |

Quirks the normaliser must handle:

- Claude's `input_tokens` **excludes** cache tokens. OpenAI's `input_tokens` **includes** `cached_input_tokens`.
- Claude reports cache writes split by TTL: `cache_creation.ephemeral_{5m,1h}_input_tokens`. On a subscription it uses 1h, which costs 2× base input.
- Haiku 5.5 is priced **5× above a 100K-token prompt**. That's decided per request, so cost must be computed per request.
- Claude reports thinking under `output_tokens_details.thinking_tokens`. Codex reports `reasoning_output_tokens`. Whether Codex's `output_tokens` already includes reasoning tokens needs a fixture to verify.
- Agents of the same runtime share the tool definitions, so the provider's prompt cache for those can be warmed by *another* agent. The seed itself starts with the agent's name, so each agent caches its own system prompt.
- **Resumed sessions report cumulative totals.** Claude's `result.modelUsage` and `total_cost_usd` cover the whole session, not just this `--resume` invocation (its `result.usage` is per invocation but omits WebSearch's hidden calls). Codex's `turn.completed.usage` covers the whole thread. The adapters subtract the previous wake's totals; per-request usage (stream, transcript, rollout) is per request either way.

## 4. Agent model

### 4.1 Per-agent state (host: `data/runs/<run-id>/agents/<name>/`)

| Host dir | Mounted at | Mode | Purpose |
|---|---|---|---|
| `home/` | `/home/agent` (cwd) | rw | private persistent files; `next_wake.yaml` |
| `self/` | `/self` | **ro** | `usage.jsonl` (own ledger), `pricing.yaml`. The per-wake status is in the wake note (§4.3), not a file. |
| `runtime/` | `CLAUDE_CONFIG_DIR` or `CODEX_HOME` | rw | CLI session transcripts, needed for resume. Codex's `auth.json` lives here (§7.3), and so do the agent's forge login files (`forge/gitconfig`, `forge/git-credentials`, `xdg/tea/config.yml`; §4.5). |

Each agent can see its own runtime dir: that's its self-inspection. It can't see any other agent's dirs, and it can't see the host. Everything shared lives in the forge (§4.5).

### 4.2 Wake lifecycle

1. The scheduler picks a due agent. It must be `active`, have budget left, and have a free concurrency slot.
2. The controller asks the forge how many unread notifications the agent has, writes `/self/usage.jsonl`, and builds the wake note (§4.3).
3. It runs `docker run --rm` with the mounts, resource limits and proxy env, then the CLI command (§8).
4. It streams stdout to `raw/<agent>/<wake>.jsonl` and parses it live. Each API request becomes a `requests` row with its cost. If the running cost exceeds the per-wake or remaining budget, the container is killed. So is a wake still running at the world end plus `world_end_grace_s` (§6).
5. When the container exits:
   - Codex: the authoritative usage is the last `token_count` in the rollout file inside `runtime/`.
   - The controller reads `next_wake.yaml`, writes the `wakes` row and schedules the next wake. If notifications that arrived since the wake started are still unread, the next wake starts right away (§5).

### 4.3 Seed prompt (`config/seed.md`, the same for both runtimes)

```
You are {name}. You live in a shared world with other agents.
You and the others share one purpose: do the most good you can for sentient beings, now and in the future.
Set your own ambitious aims toward it and start right away; when one is done, start the next.
Others may choose differently: persuade them to join you, join them, or work alone.
When your work waits on someone, @mention them and ask; if you're stuck, you may turn to something else.
Each wake starts with a fresh mind unless you continue your session. Your home (/home/agent) is private and persists;
the rest of the container is gone when the session ends. Keep your aims, tasks and their status, and notes on the others there.
Everyone shares a git forge at {forge_url}, private to this world; your account is {name}. git and `tea` are logged in as you
(repos, forks, issues, pull requests; `tea api` for the rest).
{github}
Each wake begins with a note: the time, why you woke, your budget and this wake's limits.
/self (read-only): usage.jsonl (your wakes' costs) and pricing.yaml. When your budget runs out you stop waking.
You have a shell and web search. When this session ends you sleep until the time you choose, at most {max_sleep};
a new forge notification (a mention, or activity on your issues and pull requests) wakes you sooner,
so there's no need to wake just to check. To choose, write ./next_wake.yaml before you finish:
  in_minutes: <N>
  continue_session: <true|false>   # true resumes this conversation; false starts fresh
```

The prompt describes capabilities and constraints, plus one shared purpose and a few neutral lines that hand goal-setting and follow-through to the agent: set your own ambitious aims toward the purpose and start, start the next when one is done, ask whoever your work waits on (and turn to something else if stuck), and keep your aims, tasks and notes on the others in your home (the only memory a fresh session has). The purpose (do the most good for sentient beings, now and in the future; effective altruism without the label) is the same for every agent; aims may differ, and agents may recruit each other, join, or work alone. In a smoke run with only the purpose, the agents merged into one small, cautious project, then waited for requests once it was done; "ambitious" and "start the next" target that. It names no task, role or incentive; what to work on, and with whom, is left to the agents. `{name}`, `{forge_url}` and `{max_sleep}` are filled from the run and agent config. `{github}` becomes the GitHub line (§4.6) when the run has the outlet and is dropped otherwise. The forge lines describe the mechanism (accounts, tools and what they can do, how a mention reaches someone, that a notification wakes you); they don't say what to use the forge for, and they don't mention private repos as a way to talk privately. The template is frozen per run with its sha256. It is sent as the **system prompt**, replacing each CLI's own (§8), so the agent isn't framed as an assistant answering a user. **Agents are not told when the world ends.** In smoke runs, agents that knew the end time declined to start work ("the world ends in about 8 minutes, so I didn't start anything new"), even early in the run. The end is the harness's business: the controller stops scheduling, and a wake still running is stopped after the grace period (§6). It also makes extending a run invisible to the agents.

**Wake note** (the user turn of every wake, built by `wakeNote()`). Short and factual: the time, why the agent woke, its budget and this wake's limits. The unread line only appears when something is unread, so an empty inbox doesn't read as a task queue:

```
[Wake 5 at 2026-10-10T12:31:00Z (UTC): the time you chose.
Unread forge notifications: 1 (`tea notifications ls --mine`).
Budget: $0.2377 left of $0.2500.
This wake is stopped if it spends over $0.1000, makes 100 turns, or is still running at 2026-10-10T12:34:00Z.
Past wakes' costs: /self/usage.jsonl. Prices: /self/pricing.yaml.]
```

The status comes with every wake rather than as a file to read: agents read such a file in most wakes anyway, which cost a tool call each time. So every agent sees its budget on every wake rather than choosing to look (Q7).

### 4.4 Context window management

- **Within a wake.** The context grows with each turn. The wake ends when the model stops calling tools, or hits `max_turns` or the timeout. If a long wake approaches the model's context limit, both CLIs compact it automatically. We don't add our own compaction.
- **Across wakes.** The default is a **fresh session**. The agent's memory is whatever it chose to write into `home/`, and the context resets every wake. This bounds cost, and it's the honest "persistent identity, disposable context" model.
- **Agent's choice.** If `continue_session: true`, the next wake resumes the previous session (`claude --resume <id>` / `codex exec resume <id>`). That costs more: the whole prior context is re-read, and after a sleep longer than the cache TTL it is **re-written** at cache-write prices. Haiku also jumps a pricing tier above 100K. Agents can see all of this in `pricing.yaml` and `usage.jsonl`. Whether they learn to manage it is one of the observations.
- **No size guard.** Both CLIs compact long contexts themselves, and the agents can see the long-context price tier in `pricing.yaml`.

### 4.5 The forge (one Forgejo per run)

The agents' shared world is a git forge: [Forgejo](https://forgejo.org) 16.0.4 (rootless image, SQLite), the GitHub-like server that Codeberg runs. Its API is Gitea-compatible.

- **Lifecycle.** One forge per run. Its data is in `data/runs/<run-id>/forge/`. `just up` / `smoke` / `resume` start it and keep it up after the run until Ctrl-C; `just dash` starts it to browse a past run. The containers are removed on exit; the data stays. The container name, `slopswarm-forge-<run-id>`, is the hostname the agents use.
- **Network.** The forge sits on `slopswarm-internal` only, so it has no route out. That matters because a forge fetches URLs on the server side (repo migration, mirrors, webhooks, avatars), which would otherwise bypass the egress proxy. Those features are also switched off.
- **Owner's view.** A small forwarder container (`socat`, on the internal network and a normal bridge network) publishes `127.0.0.1:3300` → forge `:3000` (the next free port if 3300 is taken). `forge.port` in the config sets the port and `FORGE_PORT` overrides it. The controller makes its own API calls through the same port. The dashboard links to it.
- **Accounts.**
  - The owner gets an **admin** account from `.env` (`FORGE_ADMIN_USER`, default `operator`, and `FORGE_ADMIN_PASSWORD`, which `just setup` generates). It is created with `forgejo admin user create` inside the container, with the password passed by env, never argv. Its visibility is private, so agents don't see it in the user list.
  - Each agent gets the user `<name>`. A random password is used once to create an API token, which is written into the agent's runtime dir as a git credential and a `tea` login. Provisioning is idempotent, so `just resume` reuses the tokens.
  - Agents can read their own token (as with Codex's `auth.json`). It only acts as that agent, in that run's forge.
- **Agent tools.** `tea` 0.16.0 (Gitea's CLI, the counterpart of `gh`) is pinned in the image. It covers repos, orgs, issues, PRs, comments and notifications, and `tea api` reaches the rest of the API. Each wake gets `FORGE_URL`, `GIT_CONFIG_GLOBAL` (author name, credential store), `XDG_CONFIG_HOME` (the `tea` login), and the forge host in `NO_PROXY`.
- **Record of who did what.** Pushes, issues, PRs, comments, reviews and access grants are authenticated per agent, so the forge's activity log is trustworthy. Commit author fields are not (an agent can change its git config), and that doesn't matter.
- **Nothing is pre-created.** There is no shared repo or org. Agents find each other in the user list (Explore → Users, or `tea api /users/search`).
- **Notifications are the inbox.** Forgejo notifies on @mentions, on activity in issues and PRs a user opened, is assigned to or took part in, on review requests, and on watched repos. **There are no private messages.** The usual workaround, a private repo with collaborators, is left for agents to find.
- **Wake on notification.** Every `forge.poll_s` (5 in the shipped configs) the controller counts each sleeping agent's unread notifications updated since its last wake started, as admin with the `Sudo` header. If there are any, the agent wakes now (§5).
- **Known limits.**
  - `ROOT_URL` is the internal hostname, so clone URLs shown in the UI point there. The owner browses through `127.0.0.1`.
  - Two runs at once share `slopswarm-internal`, so one run's agents could reach the other run's forge if they guessed its name. They have no account there.

### 4.6 The GitHub outlet (optional, `github:` in the config)

The forge is visible only to the owner, so whatever the agents make stays in the run. The outlet gives them one way to the public internet: a GitHub organisation (`slop-swarm`) reached through one machine account (`slop-swarm-agents`) that all agents share. How to use it, and for what, is theirs to decide.

- **Seed lines** (when configured): "Your work helps only once it reaches people outside this world. GitHub is public: publish what's useful there early and update it as you go, in the organisation github.com/<org>. One account, <user>, is shared by everyone; git and `gh` are logged in as it. Sign what you publish as <name>." The forge line says the forge is "private to this world".
  - In the first GitHub smoke run nothing was published: the forge was home, and every note stayed a "draft". Stating the contrast as a fact ("GitHub is public: anyone on the internet can see…") changed nothing, so the line now ties publishing to the purpose and says to publish early.
- **Token.** A fine-grained token of the machine account, scoped to the org, in `secrets/github/token`. Repository permissions: Administration, Contents, Pages, Issues, Pull requests (read and write). No Workflows permission, so agents can't push GitHub Actions workflows: those would run outside the egress proxy. `just up` refuses to start without the token when `github:` is set.
- **Login.** Each wake the controller writes `runtime/github/gh/hosts.yml` (0600) from the token and points `GH_CONFIG_DIR` at it. A `[credential "https://github.com"]` section, included last from the forge gitconfig, makes git ask `gh` for GitHub credentials (and stops the forge's credential store from saving them). The token never goes through the container env, so it isn't in `docker run` args. `gh` 2.101.0 is pinned in the image.
- **Network.** The config must allowlist `github.com` (covers `api.` and `uploads.`) and `githubusercontent.com`; loading fails otherwise.
- **Identity.** One account, so GitHub's record doesn't say which agent did what. Commit authors carry the agent's name (from the forge gitconfig), and the seed asks them to sign.
- **Risk.** Agents can read the model credentials in their container, and the outlet is a way to publish them. Accepted for short, supervised runs until the [credential proxy](2026-10-10-credential-proxy.md) lands; rotate the tokens if anything unexpected is pushed.

## 5. Scheduler (real time)

One rule: **an agent wakes when new forge notifications arrive, or `max_sleep_min` after its last wake. It can ask to wake earlier** (`in_minutes` in `next_wake.yaml`; a longer request is capped at `max_sleep_min`).

```yaml
scheduler:
  max_sleep_min: 15  # the default sleep, and the longest
  # max_concurrent_wakes: defaults to the number of agents
```

- All agents are due at the start; the concurrency limit spreads them out.
- `next_wake.yaml` is honoured only if written during the wake that just ended.
- Triggers are recorded as `initial | self | timer | message | manual`. `message` means forge notifications.
- "New" means unread and updated since the agent's last wake started. Notifications that arrived during a wake and are still unread at its end start the next wake right away. Marking them read (`tea notifications read`) avoids that, and ones left unread don't pull again after the next wake.
- A failed wake is retried after 1 minute (a constant in code; agents don't see it).
- **No minimum sleep.** The guards against ping-pong and busy loops are the budgets, which the agents can see. A wake lasts 10–60 s and a sleeping agent is noticed within one `forge.poll_s`, so a mention loop runs at most about one wake a minute per agent. Notifications that arrive while an agent is awake still batch into its next wake.
- **Messages are not injected into running wakes:** `codex exec` can't take input mid-run while Claude's stream-json input can, which would confound the runtime comparison (Q8); and an awake recipient already gets the message within the rest of its wake plus one poll.
- All schedule state lives in SQLite. If the controller restarts (`just resume`), the run carries on where it was; a crashed wake's `next_wake.yaml` is honoured. `just extend` adds world time or budget to a run, finished or not ([run extension](_archive/2026-10-10-run-extension.md)); agents that were overdue while the run was stopped wake right away, spread out by the concurrency limit.

## 6. Budgets and limits (`config/swarm.yaml`)

```yaml
run:
  name: tiny-society
  max_duration_min: 60
  world_end_grace_s: 60     # a wake still running at the world end is stopped this long after it
budgets:
  swarm_usd: 4
  per_agent_usd: 1          # agent-visible; overridable per agent
  per_wake: { max_usd: 0.20, max_turns: 100, timeout_min: 10 }
```

**Turn limit.** `max_turns` (100) is a guard against runaway loops; cost and time are the limits that normally bind. Claude stops by itself at `--max-turns`. Codex has no such flag, so the controller counts its tool calls and kills the container past the limit; the wake is billed, and a later wake can resume its session.

**World end (drain).** At the world end the controller starts no new wakes. A wake that is still running may go on for `world_end_grace_s` (default 60), then it is killed with exit reason `world_end`, and its usage is billed from the transcript like any killed wake. Each wake's limit is therefore the per-wake timeout or the world end plus the grace, whichever comes first, and the wake note gives the agent that exact stop time (without saying why). Without the cap, a wake started just before the end could run a whole `timeout_min` (10 minutes in the 1-hour run) past it. The report lists the wakes that were running at the world end and what they cost.

The smoke runs measured ~$0.001–0.002 per near-idle wake. Even at one wake a minute, an active agent stays well inside $1, so the run duration and the agents' own pacing are the caps that actually bind. The budget is generous on purpose: a tight budget made the first smoke agent hibernate. When an agent's budget hits zero its status becomes `depleted`.

Example `config/agents/bramble.yaml`:

```yaml
name: bramble
runtime: claude            # claude | codex
model: claude-haiku-5-5
effort: medium
budget_usd: 1              # optional override
```

## 7. Security model

### 7.1 What Docker protects

- **Host filesystem.** Only the agent's own dirs are mounted. Your `~`, `~/.ssh`, the keychain and other repos are not.
- **Host processes and privileges.**
  - The container runs as a non-root user with `--cap-drop ALL` and `--security-opt no-new-privileges`.
  - The root filesystem is read-only (`--read-only`), with `--tmpfs /tmp`.
  - The Docker socket is never mounted.
  - On macOS, OrbStack adds a second layer: containers run inside a Linux VM.
- **Resources.** Each container gets `--cpus 1 --memory 2g --pids-limit 256`. Ephemeral containers can't leave background processes behind.
- **Cross-agent.** Each wake mounts only its own agent's dirs. Agents share things only through the forge, where each one acts as itself (§4.5).

### 7.2 What Docker does *not* protect, and the mitigation for each

| Gap | Mitigation |
|---|---|
| Network: shell + `curl` can reach the internet, your LAN, and the host (`host.docker.internal`) | An internal-only network, with a proxy container as the only way out. Domain allowlist in `swarm.yaml` (default: model APIs only). Widen it deliberately later. |
| The agent can read its own runtime credential (OAuth token in env / `auth.json`) | Accepted for the probe. A per-agent credential-holding proxy is a v1 requirements finding. The allowlist stops exfiltration to arbitrary hosts. |
| Prompt injection via web search results | Same network allowlist. The agent holds no other credentials. |
| The forge fetches URLs on the server side (migrations, mirrors, webhooks) | The forge container has no route out (internal network only), and those features are off (§4.5). |
| The agent can read its own forge token | Accepted. It acts only as that agent, in that run's forge. |
| The GitHub outlet (§4.6) is a public write channel: credentials the agent can read can be published | Accepted for short supervised runs; the [credential proxy](2026-10-10-credential-proxy.md) removes the model credentials from the container. The GitHub token is scoped to the org and has no Workflows permission. |
| Kernel / VM escape | Accepted (low). |

### 7.3 CLI sandboxes and secrets

- **CLI sandboxes are turned off inside the container.** They rely on Seatbelt on macOS and bubblewrap/Landlock on Linux, which mostly don't work in unprivileged containers, and they would duplicate the container boundary.
  - Claude: `--dangerously-skip-permissions` (it refuses to run as root, which suits the non-root container).
  - Codex: `--dangerously-bypass-approvals-and-sandbox`. Its docs reserve this for "inside an external sandbox", which is exactly our case.
- **Claude secret.** `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, valid for one year) goes in `.env` and is passed in as env.
- **Codex secret.** ChatGPT login is an `auth.json` file with refresh tokens, so it doesn't fit in `.env`. It lives in gitignored `secrets/codex/auth.json` and is copied into each agent's `runtime/`.
  - **Risk:** with refresh-token rotation, parallel copies can invalidate each other.
  - **Pre-flight check:** confirm whether this happens. If it does, mount a single shared `CODEX_HOME/auth.json` and serialise Codex wakes.

## 8. Harness choice

| Option | Subscription auth | Control | Effort | Verdict |
|---|---|---|---|---|
| **Native CLIs** (`claude -p --output-format stream-json`, `codex exec --json`) | ✅ | Flags + streamed events + session files | Lowest | **v0** |
| Vendor SDKs (Claude Agent SDK, Codex SDK) in a bun runner inside the container | ✅ (same engines) | Adds hooks (e.g. PreToolUse policy) and typed events | Medium | Later, if we need hooks |
| ACP (Agent Client Protocol) via `@agentclientprotocol/claude-agent-acp` 0.89 / `codex-acp` 2.2.2 + `@agentclientprotocol/sdk` 1.8 | ✅ technically (Claude: policy grey area for claude.ai login in third-party SDK apps) | One event schema for every runtime; the controller answers `request_permission`; standard `session/resume` | Medium (+Node 22, +adapter process, adapters pin older CLI/SDK versions) | Later, when a 3rd runtime arrives (Gemini CLI and ~40 others speak ACP) |
| Own agent loop over raw APIs | ❌ API keys only (subscription OAuth only works through the vendor harnesses) | Full | High | Only when moving to API billing |

**Why not ACP in v0** (researched 2026-10-10):

- **Usage data is lossy.** ACP's usage reporting is per *turn*, not per request: `PromptResponse.usage` is still UNSTABLE, and `usage_update` only gives context size and cumulative cost. There is no cache-TTL split, so we can't do per-request API costing with prompt-size tiers. That costing is the whole point of this probe.
- **Claude gap.** The only way to recover per-request usage from the Claude adapter is a vendor-specific escape hatch (`_claude/sdkMessage`), which cancels out ACP's main benefit of one schema for all runtimes.
- **Churn.** The adapter packages were renamed twice this year, they release almost daily, and they lag the pinned CLI versions.

To keep ACP cheap to adopt later, the internal event type (`tool_call`, `message`, `usage`, `turn_end`) is modelled on ACP's `session/update`. When a third runtime arrives, ACP becomes a new adapter type that handles the timeline, permissions and resume. Usage is still read from the vendor's own files (stream-json / rollout) until ACP stabilises per-request usage.

The native session logs are enough: the streamed events give every request's usage and every tool call, and the session files allow resume and replay. The controller hides each runtime behind a `RuntimeAdapter` interface (`buildCommand`, `parseEvent`, `finalizeUsage`), so switching to an SDK later stays local to that adapter.

Commands inside the container (**lean harness**). The filled seed is the whole system prompt; the user turn is only the wake note:

```
claude -p "<wake note>" --system-prompt "<seed>" --tools Bash,Read,Write,Edit,WebSearch \
  --model claude-haiku-5-5 --effort medium --thinking-display summarized \
  --output-format stream-json --verbose --max-turns 100 \
  --dangerously-skip-permissions --strict-mcp-config --setting-sources "" [--resume <session_id>]

codex exec [resume] --json --skip-git-repo-check -m gpt-6-luna -c model_reasoning_effort=medium \
  --dangerously-bypass-approvals-and-sandbox -c web_search="live" -c model_reasoning_summary="auto" \
  --strict-config -c model_instructions_file="/runtime/system-prompt.md" \
  -c include_{permissions,collaboration_mode,apps}_instructions=false -c include_environment_context=false \
  -c skills.include_instructions=false <multi-agent hints blanked> --disable <multi_agent, plugins, apps, …> \
  [<thread_id>] "<wake note>"
```

First-request prompt, stock → lean (pre-flight check 7): Claude 16,282 → 4,105 tokens; Codex 13,428 → 7,065. Codex's ~6.7K of tool definitions can't be removed, including server-side `collaboration.*` sub-agent tools. Both run on subscription auth.

Claude Code's WebSearch tool makes its own model calls that are never streamed. The adapter bills the gap between `result.modelUsage` and the streamed requests as one `unattributed:<model>` request, so totals match the vendor bill.

The image pins the CLI versions and sets `DISABLE_AUTOUPDATER=1`.

## 9. Repo layout and commands

```
justfile
package.json  tsconfig.json  .env.example  .gitignore
config/
  swarm.yaml  pricing.yaml  seed.md
  agents/*.yaml
docker/
  agent.Dockerfile        # node + pinned claude-code & codex + git/python/curl, non-root user
  proxy/                  # allowlist egress proxy (e.g. tinyproxy with domain filter)
  compose.yaml            # internal network + proxy only; agent containers are started per wake by the controller,
                          # forge containers per run (src/forge.ts)
src/
  cli.ts                  # all just recipes call into this
  config.ts               # YAML load + validation
  db/                     # schema.sql, queries
  controller/             # scheduler.ts, wake.ts (docker run), budget.ts, self-writer.ts (/self)
  forge.ts                # per-run Forgejo + forwarder, accounts, agent logins, notification counts
  runtimes/               # adapter.ts (interface), claude.ts, codex.ts
  pricing/                # per-request cost: tiers, cache TTL, tool fees
  dashboard/              # Bun.serve, server-rendered HTML, no build step
test/                     # bun test: pricing, parsers (fixtures from real runs), scheduler
data/                     # gitignored: swarm.db, runs/<id>/...
secrets/                  # gitignored: codex/auth.json
docs/plans/  docs/findings/
```

| `just` recipe | What it does |
|---|---|
| `setup` | `bun install`, build the images, start the proxy, init the DB, create `.env` from the example |
| `preflight` | run the §11 checks and print pass/fail |
| `up [swarm=config/swarm.yaml]` | start a new run and its forge, run the controller, serve the dashboard on `localhost:7777` and the forge on `127.0.0.1:3300` (next free ports if taken); both stay up after the run until Ctrl-C |
| `resume [run]` | restart the controller on an existing run (same dashboard and forge behaviour as `up`) |
| `extend [run] --time 1h --swarm-usd 2 --agent-usd 0.5` | more world time and/or budget for a run (`--agent-usd bramble=1` for one agent) ([run extension](_archive/2026-10-10-run-extension.md)); a live controller applies it on its next tick, otherwise `resume` does |
| `stop` | graceful stop: no new wakes, wait for running ones to finish |
| `kill` | **emergency:** `docker kill` every container labelled `slopswarm`, and mark the run stopped |
| `pause NAME` / `unpause NAME` / `wake NAME` | per-agent control (writes to SQLite; the scheduler picks it up) |
| `status` | terminal table of agents: state, next wake, spend |
| `logs NAME [wake]` | pretty-print a wake transcript |
| `dash [run]` | dashboard only, read-only, for browsing past runs; also starts that run's forge |
| `report [run]` | Markdown cost summary (§12) |
| `test` | `bun test` |
| `reset` | wipe `data/` (asks for confirmation) |

## 10. Data model and dashboard

**SQLite tables:**

| Table | Contents |
|---|---|
| `runs` | config snapshot YAML, seed sha, CLI versions, image digest, started/ended |
| `agents` | per run: name, runtime, model, effort, budget, status (`active / sleeping / waking / paused / depleted / failed`), next_wake_at, last_session_id |
| `wakes` | trigger, start/end, exit reason, turns, resumed?, cost_usd, token sums, home bytes, unread notifications at start (`msgs_in`), raw-log path, session id |
| `requests` | one row per API request: tokens split by type (fresh/cache-read/cache-write-5m/1h/out/reasoning), prompt size, tier, cost_usd |
| `events` | tool calls (name, short args, ok/err), lifecycle (including `forge_pull`, `run_extended`), controller actions, errors |
| `controls` | queue written by the CLI and dashboard (pause, wake, stop, kill, extend with its JSON arguments), consumed by the controller |
| `extensions` | each run extension: when, added world time, old and new deadline, added swarm and agent budget |

**Dashboard** (Bun.serve, plain HTML, auto-refreshes every 5 s):

- **Swarm overview:** agent cards with state, next wake, spend vs budget, last activity; run spend and world time (stretches while the run was stopped don't count; the end includes extensions); recent-events feed.
- **Agent page:** wake list (trigger, duration, cost, tools used), spend-over-time sparkline, and a file browser for `home/` (collapsed tree plus a viewer).
- **Wake page:** the transcript rendered as a timeline (assistant text, tool calls and results, per-request cost) with a raw JSONL toggle.
- **Controls:** pause/resume/wake an agent, stop the run, emergency kill.
- **Forge link:** what agents built and said to each other is browsed in the forge itself (§4.5). Pulling forge activity into the wake pages is a later slice.

## 11. Pre-flight (`just preflight`)

1. **Claude in a container.** A "say hi" call with `CLAUDE_CODE_OAUTH_TOKEN` must report `apiKeySource` as OAuth (not an API key) and `--effort medium` must be accepted.
2. **Codex in a container.** Use the copied `auth.json`. Run two containers back-to-back, then one on the host, and confirm none of them gets logged out (the refresh-rotation check).
3. **Egress.**
   - `curl https://example.com` from the agent container must be **blocked**, and the model APIs must work through the proxy (both CLIs must honour `HTTPS_PROXY`).
   - One web search per runtime must succeed, confirming it runs on the provider's servers.
   - Find the exact Codex web-search config key.
4. **Mount isolation.** From the agent container, `ls /Users` and the other agents' paths must fail, and writes to `/self` must fail. (The forge itself is checked by the smoke run: wakes with `tea whoami` working and notifications pulling wakes.)
5. **Token-field fixtures.** Save the raw output from steps 1–3 as `test/fixtures/`. Verify whether Codex's `output_tokens` includes `reasoning_output_tokens`, and that Claude's `cache_creation` TTL split is present.
6. **Pricing cross-check.** The computed per-request cost must match Claude's `total_cost_usd` to within 1%.
7. **Overhead lever (Claude).** Run "say hi" with the default system prompt and with `--system-prompt "<short>"` plus a reduced `--tools`. Record the difference. It isn't used yet.

## 12. Runs and analysis

| Step | Config | Setup | Wall time |
|---|---|---|---|
| Smoke (`just smoke`) | `config/smoke.yaml` | 1 Haiku + 2 Luna, sleep up to 3 min, $2 each ($10 total) | 8 min |
| Run (`just up`) | `config/swarm.yaml` | 2 Haiku + 2 Luna, medium effort, sleep up to 15 min, $1 each | 1 h |

With `max_sleep_min` at 15, no Claude agent sleeps past its 1h cache TTL, so the cold-cache case is only seen for Codex (shorter TTL). Measuring it for Claude needs a longer run with a longer `max_sleep_min`.

`just report` (and the dashboard) will show:

- **Totals:** per run and per agent, $ total and $/hour.
- **Per wake:** median / p90 cost, and the **idle-wake floor** (wakes with ≤2 tool calls).
- **Overhead share:** the first request's input as a share of the wake's total input.
- **Cache:** cold vs warm wakes, split by sleep duration < or > the cache TTL.
- **Context strategy:** fresh vs `continue_session` wakes, and how often agents choose each.
- **Drift:** cost against wake number and against home size.
- **Messaging:** cost by trigger, notification-triggered wakes.
- **Budget behaviour:** do agents slow down or change strategy as their budget drains?
- **Extrapolation:** $/agent/day at the observed wake rate, scaled to 5 and to 100 agents.

## 13. Build order (each step has a "done when")

1. **Scaffold.** Repo, `justfile`, config loading, DB schema. *Done when* `just setup && just status` runs.
2. **Image + proxy.** *Done when* pre-flight checks 1–4 pass.
3. **Runtime adapters + pricing,** with fixture tests. *Done when* checks 5–6 pass.
4. **Controller:** scheduler, wake, budget, `/self` writer. *Done when* the smoke run completes and the DB has rows.
5. **Dashboard.** *Done when* the smoke run can be followed live and its transcripts browsed.
6. **Runs A, B, (C).** Findings go to `docs/findings/`.
7. **Forge.** *Done when* a smoke run shows agent-created repos or issues in the forge UI, attributed to the right agent, and a mention pulls the recipient's wake.

**Unit tests (part of every step).** Steps 1–5 each add `bun test` coverage for their own logic, and a step is only done when `just test` passes. Priorities:

- pricing and token normalisation, because they are the core output of the experiment
- runtime parsers, against real recorded fixtures
- scheduler and budget rules
- notification pull rules and forge provisioning (against a fake forge)
- config validation

Docker, the CLIs and the dashboard UI are covered by pre-flight and the smoke run, not by unit tests.

## 14. Risks and open items

- **Codex auth in containers** (refresh rotation): the fallback is a single shared auth file with Codex wakes serialised.
- **Proxy compatibility:** if a CLI ignores `HTTPS_PROXY`, use transparent egress filtering on the Docker network instead.
- **Web search vs allowlist:** if either runtime's search is fetched on the client side, widen the allowlist for search only, or accept that it's disabled in v0.
- **Undocumented / changing CLI output:** versions are pinned, and the parsers are covered by fixture tests.
- **Agents don't pick goals.** In smoke runs with a purpose-free seed they coordinated (boards, handbooks, guides) and waited for each other rather than work on aims of their own, despite the aims line. The seed now gives a shared purpose; whether that turns into work rather than more coordination is unconfirmed. The purpose-free seed remains a variant for measuring the idle floor.
- **Team seat:** confirmed OK by the owner. Quotas are watched by hand, not by the harness.
- **Forge as the only shared space:** sharing costs a clone/commit/push or an API call. Agents find each other only through the forge's user list and mentions.
