# Web search + web fetch relay (src/search.ts, docs/plans/2026-10-11-openrouter.md §3, §4). One container per run.
# Holds EXA_API_KEY (passed by name at `docker run`, never baked in); /search only calls api.exa.ai, /fetch only
# public addresses (docker/search/webfetch.ts). Bun 1.4.4: same as the host tests; its node:https pins the address
# and checks the certificate against the SNI hostname (1.2.19's fetch-based node:https did not use servername).
FROM oven/bun:1.4.4-alpine
WORKDIR /app
COPY relay.ts webfetch.ts /app/
# The image's `bun` user is uid 1000, like the agents, so the log on the bind mount lines up.
USER 1000:1000
EXPOSE 8080
CMD ["bun", "run", "/app/relay.ts"]
