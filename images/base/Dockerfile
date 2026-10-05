# syntax=docker/dockerfile:1
#
# dev-system base image: ghcr.io/cbundy/dev-system/base
#
# A prebuilt agent dev environment - Node LTS, Claude Code, codex, no-mistakes,
# treehouse, agentsview, gh and git - plus a fixed persistence contract under
# /persist and a /shared mount point for NAS file sharing.
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
# its official apt repo, the few utilities the agent flow uses, and tini as
# PID 1 (signal forwarding and zombie reaping for dev-entrypoint).
RUN echo "cache bust: ${CACHE_BUST}" \
  && install -d -m 0755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends gh jq less openssh-client ripgrep tini tmux \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Persistence contract: one directory per tool, owned by node (1000:1000) so a
# Docker named volume mounted here copies that ownership on first use. No
# VOLUME instruction on purpose - it would silently drop child images' changes
# under /persist and leave anonymous volumes behind.
RUN install -d -m 0755 /persist \
  && install -d -o 1000 -g 1000 -m 0700 \
    /persist/claude /persist/codex /persist/gh /persist/no-mistakes /persist/agentsview

# Shared files: an empty mount point for a NAS share (NFS) beside the code -
# build artifacts and exchange files, never repo checkouts or tool state. The
# image has no default mount (the NAS is site-specific; the runtime supplies
# it) and, as for /persist, no VOLUME. Owned by node, so a plain Docker volume
# mounted here is writable too.
RUN install -d -o 1000 -g 1000 -m 0755 /shared

# Runtime secrets (cbundy/dev-system#103): an empty mount point for a
# read-only secrets directory the runtime supplies - the shared
# dev-system-secrets volume on Docker, a host directory on Coder, a Secret on
# Kubernetes. Never anything in the image: it is public. Owned by node with
# mode 0700, so a new Docker volume mounted here copies that and only node
# can read it. dev-init reads agentsview-pg-url from it (agentsview.sh).
RUN install -d -m 0755 /run/secrets \
  && install -d -o 1000 -g 1000 -m 0700 /run/secrets/dev-system

# Repo checkouts: dev-init clones DEV_REPO_URL into /workspaces/<repo name>
# (cbundy/dev-system#77). An empty mount point for the runtime's workspace
# volume (no VOLUME), owned by node so a Docker named volume mounted here
# copies that ownership and node can clone into it. A checkout lives in a
# directory of its own below it, so a volume root that is never empty (ext4's
# lost+found) does not get in the way. Desktop dev containers bind-mount their
# checkout at /workspaces/<folder> too.
RUN install -d -o 1000 -g 1000 -m 0755 /workspaces

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
# /persist at run time, so everything but the binary is dropped here, with
# the systemd user unit that daemon start leaves behind (for the build-time
# home, and no systemd runs here anyway).
RUN curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh \
  && no-mistakes --version \
  && find /home/node/.no-mistakes -mindepth 1 -maxdepth 1 ! -name bin -exec rm -rf {} + \
  && rm -rf /home/node/.config/systemd \
  && ln -s /persist/no-mistakes/logs /home/node/.no-mistakes/logs
RUN curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh \
  && treehouse --version

# Scripts come after the tool installs, so editing one (or bumping the
# feature version) does not re-download every tool on the next build.
USER root

# agentsview: pushes this machine's Claude and codex sessions to a central
# PostgreSQL that one `agentsview pg serve` reads (see images/base/README.md).
# Pinned by version and checksum rather than tracking latest: the pushers and
# the central server share a database schema, so an upgrade is a deliberate
# bump here, made together with the server.
ARG AGENTSVIEW_VERSION=0.44.0
ARG AGENTSVIEW_SHA256_AMD64=037ea7a46d52e06b20363b4aa7cd7f28e32f31d8215803d6e9a0c96bac5818e3
ARG AGENTSVIEW_SHA256_ARM64=6f3c76ebe119826a2def1ae226c3573b214d396a3ed7c477ef282b1063345b87
RUN arch=$(dpkg --print-architecture) \
  && case "$arch" in \
    amd64) sha256="$AGENTSVIEW_SHA256_AMD64" ;; \
    arm64) sha256="$AGENTSVIEW_SHA256_ARM64" ;; \
    *) echo "agentsview: unsupported architecture $arch" >&2; exit 1 ;; \
  esac \
  && tmp=$(mktemp -d) \
  && curl -fsSL -o "$tmp/agentsview.tar.gz" \
    "https://github.com/kenn-io/agentsview/releases/download/v${AGENTSVIEW_VERSION}/agentsview_${AGENTSVIEW_VERSION}_linux_${arch}.tar.gz" \
  && echo "$sha256  $tmp/agentsview.tar.gz" | sha256sum -c - \
  && tar -xzf "$tmp/agentsview.tar.gz" -C "$tmp" agentsview \
  && install -m 0755 "$tmp/agentsview" /usr/local/bin/agentsview \
  && rm -rf "$tmp" \
  && agentsview --version

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

# systemctl replaces the base image's shim of the same name, which reports
# success without systemd (see the script, cbundy/dev-system#101).
COPY --chmod=0755 \
  images/base/dev-init \
  images/base/dev-doctor \
  images/base/dev-entrypoint \
  images/base/dev-remote-control \
  images/base/dev-login \
  images/base/systemctl \
  /usr/local/bin/
COPY --chmod=0755 images/base/agentsview-push-loop /usr/local/share/dev-system/
COPY --chmod=0644 images/base/dev-login-page.js images/base/workspace.sh images/base/agentsview.sh \
  images/base/telemetry.sh /usr/local/share/dev-system/

# Opt-in OpenTelemetry export (cbundy/dev-system#68): telemetry.sh turns
# Claude Code's export on only when the runtime sets
# OTEL_EXPORTER_OTLP_ENDPOINT. Login shells (coder ssh, tmux windows) read
# /etc/profile.d and interactive bash (docker exec -it ... bash) reads
# /etc/bash.bashrc, so a claude started by hand gets it too;
# dev-remote-control sources it itself.
RUN printf '%s\n' '# Opt-in OpenTelemetry export (cbundy/dev-system#68), see telemetry.sh.' \
    '. /usr/local/share/dev-system/telemetry.sh' > /etc/profile.d/dev-system-telemetry.sh \
  && chmod 0644 /etc/profile.d/dev-system-telemetry.sh \
  && printf '\n%s\n' '. /etc/profile.d/dev-system-telemetry.sh' >> /etc/bash.bashrc

USER node

# Point each tool at its /persist directory. Set after the installs so no
# installer writes into /persist at build time - the directories ship empty.
# NO_MISTAKES_HOME is the name the callum-tools pipeline watcher reads.
# agentsview's anonymous telemetry ping and update check are off: the image
# pins its version, and these containers report nothing they were not asked to.
# DEV_SHARED_DIR names the shared files mount point, so scripts and agents
# never hard-code /shared; DEV_SECRETS_DIR names the runtime secrets mount
# point the same way.
ENV CLAUDE_CONFIG_DIR=/persist/claude \
  CODEX_HOME=/persist/codex \
  GH_CONFIG_DIR=/persist/gh \
  NM_HOME=/persist/no-mistakes \
  NO_MISTAKES_HOME=/persist/no-mistakes \
  AGENTSVIEW_DATA_DIR=/persist/agentsview \
  AGENTSVIEW_TELEMETRY_ENABLED=0 \
  AGENTSVIEW_DISABLE_UPDATE_CHECK=1 \
  DEV_SHARED_DIR=/shared \
  DEV_SECRETS_DIR=/run/secrets/dev-system

# Headless runs (docker run, Kubernetes, Coder) start Claude with Remote
# Control by default: dev-entrypoint runs dev-init, then the command, which
# defaults to dev-remote-control. tini is PID 1, so docker stop / pod deletion
# reaches the running command at once and orphans are reaped. A command
# (docker run IMAGE bash, k8s args:) replaces only the CMD.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dev-entrypoint"]
CMD ["dev-remote-control"]

# Desktop dev containers never run that entrypoint: the devcontainer CLI and
# VS Code replace it (overrideCommand). The metadata's postStartCommand runs
# dev-init, then starts Remote Control only if the consumer sets
# DEV_REMOTE_CONTROL=1 in containerEnv; the default 0 here also keeps it off
# for a consumer that sets overrideCommand false. DEV_DESKTOP=1 marks these
# containers for dev-doctor: they open the bind-mounted checkout, so a
# missing DEV_REPO_URL is expected there.
#
# devcontainer.metadata sets updateRemoteUserUID false: on a Linux host whose
# user is not UID 1000, the devcontainer CLI would otherwise renumber node to
# the host UID, and node could no longer write the 1000-owned /persist volumes.
#
# Its mounts are the volumes shared by every repo on the Docker host: gh, and
# dev-system-secrets read-only at DEV_SECRETS_DIR, so a secret written into it
# once (the agentsview URL, cbundy/dev-system#103) reaches every repo; an
# absent volume is created empty, which leaves the push off. The string form
# is the one that can say readonly. The other
# /persist volumes must be per repo (cbundy/dev-system#73), and the
# devcontainer CLI expands no variables such as ${devcontainerId} in image
# metadata - they come out empty, so every repo would share them - so the
# consumer's devcontainer.json declares those (see README.md).
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.source="https://github.com/cbundy/dev-system" \
  org.opencontainers.image.revision="${REVISION}" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.created="${CREATED}" \
  org.opencontainers.image.title="dev-system base" \
  org.opencontainers.image.description="Prebuilt agent dev environment: Node LTS, Claude Code, codex, no-mistakes, treehouse, agentsview, gh, git, with tool state persisted under /persist. Tags are mutable; pin by digest if you need reproducibility." \
  dev.cbundy.persist="/persist/claude,/persist/codex,/persist/gh,/persist/no-mistakes,/persist/agentsview" \
  dev.cbundy.shared="/shared" \
  dev.cbundy.secrets="/run/secrets/dev-system" \
  devcontainer.metadata="[{\"remoteUser\":\"node\",\"updateRemoteUserUID\":false,\"containerEnv\":{\"CLAUDE_CONFIG_DIR\":\"/persist/claude\",\"CODEX_HOME\":\"/persist/codex\",\"GH_CONFIG_DIR\":\"/persist/gh\",\"NM_HOME\":\"/persist/no-mistakes\",\"NO_MISTAKES_HOME\":\"/persist/no-mistakes\",\"DEV_SHARED_DIR\":\"/shared\",\"DEV_SECRETS_DIR\":\"/run/secrets/dev-system\",\"DEV_REMOTE_CONTROL\":\"0\",\"DEV_DESKTOP\":\"1\",\"AGENTSVIEW_DATA_DIR\":\"/persist/agentsview\",\"AGENTSVIEW_TELEMETRY_ENABLED\":\"0\",\"AGENTSVIEW_DISABLE_UPDATE_CHECK\":\"1\"},\"postStartCommand\":\"dev-init && dev-remote-control --post-start\",\"mounts\":[{\"type\":\"volume\",\"source\":\"dev-system-gh\",\"target\":\"/persist/gh\"},\"type=volume,source=dev-system-secrets,target=/run/secrets/dev-system,readonly\"]}]"
