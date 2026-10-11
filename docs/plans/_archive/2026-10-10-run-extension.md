# Run extension: more world time and budget for an existing run

- **Status:** done (archived)
- **Date:** 2026-10-10
- **Parent:** [Tiny Society Token Probe](../2026-10-10-tiny-society-token-probe.md)

## Goal

Continue a run where it ended instead of starting a new world: same agents, homes, CLI sessions, forge and cost history. The owner can add **world time**, **budget**, or both, and every extension is **logged**.

## Interface

```sh
just extend [run] --time 1h                          # world time
just extend [run] --swarm-usd 2 --agent-usd 0.5      # budget: swarm, and every agent
just extend [run] --time 30m --agent-usd bramble=1   # one agent only
```

- Amounts are additions, never absolute values, so a budget can't be lowered this way. Repeated flags add up (`--agent-usd 0.5 --agent-usd bramble=1` gives bramble $1.50).
- `just extend` only **enqueues** an `extend` control with its arguments as JSON in `controls.detail` (the CLI stays a non-writer). A live controller applies it on its next tick. Otherwise the command says to run `just resume [run]`. Resume applies it in its first tick, before any scheduling, because controls are consumed first.
- The CLI warns when the extension would not be enough to restart the run: the world has ended and there's no `--time`, no agent has budget left, or the swarm budget is spent.
- `just status` lists queued extensions, and points to `just resume` when a run is marked running but no controller is alive (a crash).

## What the controller does

In one transaction:

1. **World time.** `deadline_at = max(deadline_at, now) + time`. An extension after the end counts from now, so the stopped gap isn't world time.
2. **Agent budget.** `agents.budget_usd += amount`. A `depleted` agent that has budget again becomes `sleeping`, due now (trigger `timer`). A `failed` agent stays failed; `just wake NAME` revives it, as before.
3. **Swarm budget.** The effective swarm budget is the config snapshot's value plus the extensions' `swarm_usd`. The stop rule, each wake's spend cap, the dashboard, the report and `just status` all read it this way (`src/world.ts`).
4. **Log it.** It writes an `extensions` row and a `lifecycle / run_extended` event with a one-line summary ("world +1h; swarm +$2.00; every agent +$0.50"), which appears in the dashboard's activity feed.

Then:

- A wake still running gets the new world end, so it isn't stopped at the old one.
- If the controller was draining after the end or a stop, the run carries on. If it still can't go on, the next tick stops it again.

**Run state.** Resuming a run, extended or not, sets it back to `running` and clears `ended_at` and `stop_reason`. Before this change, resuming kept the old `stop_reason` and `ended_at`. Every controller start on an existing run logs `run_resumed`, including after a crash; world time is measured from these events.

## What turned out to be already there

The forge, wake-note and seed changes made several parts of the original plan unnecessary:

- **Telling the agents.** They are never told when the world ends, so extra time needs no notice. Each wake note already gives the agent's current budget ("Budget: $X left of $Y"), so the new amount reaches them on their next wake. No separate notice and no tracking of who was told.
- **Rescheduling.** Agents whose `next_wake_at` passed while the run was stopped are already due. `pickDue` takes them earliest first within `max_concurrent_wakes`, and they keep their trigger. `continue_session` is honoured as on any wake.
- **The dashboard's world-time meter.** It shows world time against what is left until the extended deadline. There are no per-extension ticks; the activity feed lists each extension.

## Report

- An **Extensions** section lists each extension.
- **World time** and **$/hour** come from the controller sessions (`run_created`/`run_resumed` to `run_finished`/`run_stopped`, or the last event after a crash). Stopped stretches don't count. The header also gives wall-clock time when the run was stopped in between.
- Wakes whose sleep spans a stopped stretch are cold-cache by construction. They are counted and kept out of the cache table.
- The world-end drain line also covers earlier world ends: an extension applied after the end means the world had ended once before.
- The run's row in Totals shows the effective swarm budget.

## Folded in

- **Crash recovery reads `next_wake.yaml`** (review follow-ups §1). A `next_wake.yaml` written during the crashed wake sets the next wake (counted from the recovery) and `continue_session`.
- **Stale "running" after a crash.** `just dash` serves the forge of a run marked running when no controller is alive. `just status` says so and points to `just resume`.
