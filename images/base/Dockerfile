# syntax=docker/dockerfile:1
#
# dev-system base image: ghcr.io/cbundy/dev-system/base
#
# A prebuilt agent dev environment - Node LTS, Claude Code, codex, no-mistakes,
# treehouse, gh and git - plus a fixed persistence contract under /persist.
# See images/base/README.md for the contract, the tag policy and how to extend
# this image. Build context is the repo root, so the image can reuse the
# callum-tools feature scripts instead of forking them:
#
#   docker build -f images/base/Dockerfile .

ARG BASE_IMAGE=mcr.microsoft.com/devcontainers/javascript-node:24-trixie
FROM ${BASE_IMAGE}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Changing this value (the publish workflow passes the run date) invalidates
# every layer below it, so a scheduled rebuild really does pick up fresh OS
# packages and the latest tools instead of replaying cached layers.
ARG CACHE_BUST=static

# OS packages: security updates on top of the base image, the GitHub CLI from
# its official apt repo, and the few utilities the agent flow uses.
RUN echo "cache bust: ${CACHE_BUST}" \
  && install -d -m 0755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends gh jq less openssh-client ripgrep tmux \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Persistence contract: one directory per tool, owned by node (1000:1000) so a
# Docker named volume mounted here copies that ownership on first use. No
# VOLUME instruction on purpose - it would silently drop child images' changes
# under /persist and leave anonymous volumes behind.
RUN install -d -m 0755 /persist \
  && install -d -o 1000 -g 1000 -m 0700 \
    /persist/claude /persist/codex /persist/gh /persist/no-mistakes

# Agent toolchain, installed as node so every tool can update itself without
# root. Binaries live under /home/node and /usr/local/share/npm-global, never
# under /persist, so pulling a new image always brings fresh binaries.
USER node
ENV PATH=/home/node/.local/bin:${PATH}

# Claude Code: native installer -> ~/.local/bin/claude, versions under
# ~/.local/share/claude. Both are node-owned, so the built-in auto-updater
# works in a running container. DISABLE_AUTOUPDATER is deliberately not set.
# The installer's own config and download cache in ~ are dropped: at run time
# Claude keeps its state in CLAUDE_CONFIG_DIR.
RUN mkdir -p /home/node/.local/bin \
  && curl -fsSL https://claude.ai/install.sh | bash \
  && claude --version \
  && rm -rf /home/node/.claude /home/node/.claude.json

# codex: npm global install, checked to include its helper binaries (a
# standalone codex once shipped without codex-code-mode-host - dev-system#19).
# The base image's npm prefix is node-owned (setgid npm group), which keeps
# `npm i -g` and codex's own updates rootless.
RUN npm install -g @openai/codex \
  && codex --version \
  && find "$(npm prefix -g)/lib/node_modules/@openai/codex" -name codex-code-mode-host -type f -perm -u+x | grep -q .

# no-mistakes and treehouse: their install scripts put the binaries under
# ~/.no-mistakes/bin and ~/.local/bin. The no-mistakes installer also starts a
# daemon and writes state into its default home; that state belongs in
# /persist at run time, so everything but the binary is dropped here.
RUN curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh \
  && no-mistakes --version \
  && find /home/node/.no-mistakes -mindepth 1 -maxdepth 1 ! -name bin -exec rm -rf {} + \
  && ln -s /persist/no-mistakes/logs /home/node/.no-mistakes/logs
RUN curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh \
  && treehouse --version

# Scripts come after the tool installs, so editing one (or bumping the
# feature version) does not re-download every tool on the next build.
USER root

# Shared scripts from the callum-tools feature, staged at the same path the
# feature uses (the callum-flow skills call the watchers there). The codex
# model default is read from the feature's own option default, so the feature
# and the image cannot drift apart.
COPY --chmod=0755 \
  features/src/callum-tools/recover-no-mistakes.sh \
  features/src/callum-tools/pin-codex-model.sh \
  features/src/callum-tools/pipeline-watch.sh \
  features/src/callum-tools/queue-watch.sh \
  /usr/local/share/callum-tools/
COPY features/src/callum-tools/devcontainer-feature.json /tmp/callum-tools-feature.json
RUN install -d -m 0755 /usr/local/share/dev-system \
  && jq -er '.options.codexModel.default' /tmp/callum-tools-feature.json \
    > /usr/local/share/dev-system/codex-model.default \
  && rm /tmp/callum-tools-feature.json

COPY --chmod=0755 images/base/dev-init images/base/dev-doctor /usr/local/bin/

USER node

# Point each tool at its /persist directory. Set after the installs so no
# installer writes into /persist at build time - the directories ship empty.
# NO_MISTAKES_HOME is the name the callum-tools pipeline watcher reads.
ENV CLAUDE_CONFIG_DIR=/persist/claude \
  CODEX_HOME=/persist/codex \
  GH_CONFIG_DIR=/persist/gh \
  NM_HOME=/persist/no-mistakes \
  NO_MISTAKES_HOME=/persist/no-mistakes

ARG VERSION=0.0.0-dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.source="https://github.com/cbundy/dev-system" \
  org.opencontainers.image.revision="${REVISION}" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.created="${CREATED}" \
  org.opencontainers.image.title="dev-system base" \
  org.opencontainers.image.description="Prebuilt agent dev environment: Node LTS, Claude Code, codex, no-mistakes, treehouse, gh, git, with tool state persisted under /persist. Tags are mutable; pin by digest if you need reproducibility." \
  dev.cbundy.persist="/persist/claude,/persist/codex,/persist/gh,/persist/no-mistakes" \
  devcontainer.metadata="[{\"remoteUser\":\"node\",\"containerEnv\":{\"CLAUDE_CONFIG_DIR\":\"/persist/claude\",\"CODEX_HOME\":\"/persist/codex\",\"GH_CONFIG_DIR\":\"/persist/gh\",\"NM_HOME\":\"/persist/no-mistakes\",\"NO_MISTAKES_HOME\":\"/persist/no-mistakes\"},\"postStartCommand\":\"dev-init\",\"mounts\":[{\"type\":\"volume\",\"source\":\"dev-system-claude\",\"target\":\"/persist/claude\"},{\"type\":\"volume\",\"source\":\"dev-system-codex\",\"target\":\"/persist/codex\"},{\"type\":\"volume\",\"source\":\"dev-system-gh\",\"target\":\"/persist/gh\"},{\"type\":\"volume\",\"source\":\"dev-system-no-mistakes\",\"target\":\"/persist/no-mistakes\"}]}]"
