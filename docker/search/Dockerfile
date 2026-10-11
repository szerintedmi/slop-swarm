# Web search relay (src/search.ts, docs/plans/2026-10-11-openrouter.md §3). One container per run.
# Holds EXA_API_KEY (passed by name at `docker run`, never baked in) and only calls api.exa.ai.
FROM oven/bun:1.2.19-alpine
WORKDIR /app
COPY relay.ts /app/relay.ts
# The image's `bun` user is uid 1000, like the agents, so the log on the bind mount lines up.
USER 1000:1000
EXPOSE 8080
CMD ["bun", "run", "/app/relay.ts"]
