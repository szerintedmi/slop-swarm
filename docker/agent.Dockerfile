# Agent image: one ephemeral container per wake (plan §7). CLI versions are pinned.
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.296
ARG CODEX_VERSION=0.162.1
# pi (OpenRouter agents); needs Node >= 22.19, which node:22 has.
ARG PI_VERSION=1.1.0
# Gitea's CLI, for the run's forge (plan §4.5). Checksums of the release's .xz assets.
ARG TEA_VERSION=0.16.0
ARG TEA_SHA256_ARM64=7ebeb8783ac0d69a1cac545e5a0d8f0c7dd7d6e943e73b32dfc051ef7686a60b
ARG TEA_SHA256_AMD64=92e0c966c98be0c6ca4c80b1912d08ff7887c7cb55e123542fa541842d875149
# GitHub's CLI, for the GitHub outlet (plan §4.6). Checksums of the release's .tar.gz assets.
ARG GH_VERSION=2.101.0
ARG GH_SHA256_ARM64=b57e8063f18862647c9d22727c32e9da1b963f8bf9db648fe123a6975695640f
ARG GH_SHA256_AMD64=9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 curl ca-certificates jq ripgrep procps xz-utils \
 && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH}" in arm64) sum="${TEA_SHA256_ARM64}" ;; amd64) sum="${TEA_SHA256_AMD64}" ;; *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; esac \
 && curl -fsSL -o /tmp/tea.xz "https://gitea.com/gitea/tea/releases/download/v${TEA_VERSION}/tea-${TEA_VERSION}-linux-${TARGETARCH}.xz" \
 && echo "${sum}  /tmp/tea.xz" | sha256sum -c - \
 && xz -d /tmp/tea.xz && install -m 0755 /tmp/tea /usr/local/bin/tea && rm -f /tmp/tea

RUN case "${TARGETARCH}" in arm64) sum="${GH_SHA256_ARM64}" ;; amd64) sum="${GH_SHA256_AMD64}" ;; *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; esac \
 && curl -fsSL -o /tmp/gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
 && echo "${sum}  /tmp/gh.tgz" | sha256sum -c - \
 && tar -xzf /tmp/gh.tgz -C /tmp && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh && rm -rf /tmp/gh.tgz /tmp/gh_*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && npm cache clean --force

# Web search through the run's relay (src/search.ts), for any runtime.
COPY --chmod=0755 websearch /usr/local/bin/websearch

# node:22 ships a `node` user with uid 1000; rename it to `agent` so files on the bind mounts line up.
RUN usermod -l agent -d /home/agent -m node && groupmod -n agent node

LABEL org.slopswarm.claude-code="${CLAUDE_CODE_VERSION}" \
      org.slopswarm.codex="${CODEX_VERSION}" \
      org.slopswarm.pi="${PI_VERSION}" \
      org.slopswarm.tea="${TEA_VERSION}" \
      org.slopswarm.gh="${GH_VERSION}"

# The root filesystem is mounted read-only at runtime; everything writable lives in /tmp (tmpfs)
# or the bind mounts (/home/agent, /runtime).
ENV HOME=/home/agent \
    TMPDIR=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    XDG_CONFIG_HOME=/tmp/.config \
    XDG_DATA_HOME=/tmp/.local/share \
    XDG_STATE_HOME=/tmp/.local/state \
    npm_config_cache=/tmp/.npm \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_CACHE_DIR=/tmp/.cache/pip \
    DISABLE_AUTOUPDATER=1 \
    GH_NO_UPDATE_NOTIFIER=1 \
    GH_PROMPT_DISABLED=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    PI_OFFLINE=1 \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0

USER agent
WORKDIR /home/agent
