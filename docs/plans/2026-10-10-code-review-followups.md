# Code review follow-ups

- **Status:** open
- **Date:** 2026-10-10
- **Parent:** [Tiny Society Token Probe](2026-10-10-tiny-society-token-probe.md)

Open items from the 2026-10-10 code review and the [run extension](_archive/2026-10-10-run-extension.md). Each needs a product decision or wasn't worth the risk yet. Done items are removed (history is in git).

## 1. Preflight check 2 needs `codex` on the host

The host login check throws when the `codex` binary is missing, failing the whole check instead of skipping the host part. Wrap the spawn and report "host check skipped".

## 2. Simplification (when touching the area)

The dashboard's dynamic import of the runtimes module can be a static import.

## 3. Checks after the 1-hour run

Cross-check the cost pipeline against the vendor numbers: resumed Claude wakes should match `total_cost_usd` deltas within 1%, and Codex rollout sums should match the per-turn deltas.

## 4. Run extension leftovers

- A queued extension can't be cancelled before it is applied.
- The controller lock is per data dir, not per run. `just extend` on a run marked running reports "applied on the next tick" if any controller is alive, even one running another run.

## 5. Existing data

Runs recorded with an older config or seed format don't load in the current code (their config snapshots use old setting names). Discard them with `just reset` rather than resume or report on them.
