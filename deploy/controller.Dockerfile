# The controller image (docs/plans/2026-10-12-hosted-control-plane.md §6.2): the service (`just serve`) with the
# dashboard prebuilt. It starts forges through the host's Docker socket, so it ships the docker CLI. Built by CI for
# linux/amd64 and deployed by digest (deploy/slopswarm-deploy); deploy/compose.yaml ships inside it.
FROM docker:29.9.2-cli AS dockercli

FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY package.json bun.lock ./
# The full install: the prebuilt dashboard's server bundle and `vite` (a source change rebuilds it) come from it.
RUN bun install --frozen-lockfile
COPY . .
RUN bun src/cli.ts ui-build
# Bumped when the DB schema or its migrations change: a deploy then waits until no run is active.
ARG SCHEMA_HASH=dev
LABEL org.slopswarm.schema=$SCHEMA_HASH
ENV SLOPSWARM_DATA_DIR=/var/lib/slopswarm \
    SLOPSWARM_SECRETS_DIR=/etc/slopswarm/secrets \
    NODE_ENV=production
# SIGTERM (compose stop, a deploy) detaches: the active run keeps running and the next controller resumes it.
STOPSIGNAL SIGTERM
CMD ["bun", "src/cli.ts", "serve"]
