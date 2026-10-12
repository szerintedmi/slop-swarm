# Credential proxy

- **Status:** planned (separate PR)
- **Date:** 2026-10-10
- **Parent:** [Tiny Society Token Probe](2026-10-10-tiny-society-token-probe.md) §7.2

Keep the model credentials out of the agent containers. Today the Claude OAuth token (`CLAUDE_CODE_OAUTH_TOKEN` in the env) and the Codex ChatGPT login (`auth.json` in the mounted runtime dir) are readable by the agent. §7.2 accepts that because the egress allowlist only reaches model APIs. Once agents can write to the public internet (the GitHub outlet), anything they can read they can publish, so the accepted gap becomes a leak path: one `git push` or prompt-injected command away.

## 1. Shape

A small HTTP service, `slopswarm-credproxy`, on `slopswarm-internal` next to the egress proxy:

- The CLIs in the agent container talk to it in plain HTTP instead of to the vendor. It holds the real credentials, swaps them in, and forwards over TLS through the egress network.
- Agents get a per-agent dummy credential. The proxy maps dummy → agent, so a leaked dummy is useless outside the internal network and identifies who leaked it.
- The vendor domains come off the agents' allowlist: the credential proxy is their only way to a model.
- It can't be the existing egress proxy: tinyproxy forwards CONNECT tunnels and never sees the headers without TLS interception.

```
agent container ──http──▶ credproxy (internal) ──https──▶ api.anthropic.com / chatgpt.com
      │  dummy token          swaps in the real one
      └──CONNECT──▶ egress proxy (allowlist without the model domains) ──▶ forge-external outlets
```

## 2. Claude

- Container env: `ANTHROPIC_BASE_URL=http://slopswarm-credproxy:<port>/anthropic`, `CLAUDE_CODE_OAUTH_TOKEN=<dummy>`.
- The proxy replaces `Authorization: Bearer <dummy>` with the real token and passes everything else (including `anthropic-beta`) through, streaming the response unchanged.
- **Verify in preflight:** Claude Code makes no other OAuth calls that bypass the base URL (profile, usage, telemetry). If it does, route those through the proxy too or turn them off by env.
- Web search runs on Anthropic's servers, so it still works and is still billed per request.

## 3. Codex (the hard part)

- Codex with a ChatGPT login calls `chatgpt.com/backend-api/codex/…` and refreshes its token against `auth.openai.com`. Refresh tokens rotate (§14 risk), so the proxy has to own the refresh, not the containers.
- Container: an `auth.json` with dummy tokens and a config pointing the ChatGPT base URL at the proxy. **Verify** which Codex config keys do this for the pinned version and that it doesn't refresh on its own when the dummy "expires" (give the dummy a far-future expiry).
- The proxy keeps one real `auth.json` on the host (`secrets/codex/auth.json`), refreshes it before expiry, serialises refreshes, and writes the rotated tokens back.
- Fallback if Codex can't be pointed at the proxy cleanly: Codex agents keep today's setup and stay off the public-outlet allowlist (a per-agent allowlist, §5).

## 4. What stays readable in the container

- The agent's forge token: accepted (it acts only as that agent, in that run's forge).
- The GitHub outlet token: accepted. It's scoped to the agents' org and revocable; the leak cost is bounded.

## 5. Changes

- `docker/credproxy/` (Bun, a few dozen lines): two upstream routes, dummy→agent map from a file the controller writes, header swap, streamed pass-through, Codex refresh.
- `docker/compose.yaml`: the service on `internal` + `egress`. Its own allowlist is fixed to the model domains.
- `src/controller/wake.ts`: per-harness env (`ANTHROPIC_BASE_URL`, dummy tokens) instead of passing the real ones; no more copying `auth.json`.
- `config/*.yaml`: drop the model domains from `network.allowlist`. A per-agent (or per-harness) allowlist only if the Codex fallback is needed.
- Spec §7.2: replace the "accepted for the probe" row.
- Preflight: a check that the container env and mounts hold no real credential (grep for the known token prefixes), and that a direct `curl https://api.anthropic.com` from the container is refused.

## 6. Side benefit (later, not in this PR)

The proxy sees every model request and response, so it could record per-request usage directly as a third cross-check of the cost pipeline (cost stays computed from the CLI streams, per the invariant).

## 7. Until it lands

Runs with the GitHub outlet accept the leak risk: keep them short and supervised, and rotate the Claude and Codex tokens after any run where an agent pushed something unexpected.
