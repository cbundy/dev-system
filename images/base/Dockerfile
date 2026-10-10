# syntax=docker/dockerfile:1
#
# dev-system base image: ghcr.io/cbundy/dev-system/base
#
# A prebuilt agent dev environment - Node LTS, Claude Code, codex, no-mistakes,
# treehouse, uv, agentsview, gh and git - plus a fixed persistence contract under
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
  && apt-get install -y --no-install-recommends gh jq less openssh-client postgresql-client ripgrep shellcheck tini tmux \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Persistence contract: one directory per tool, owned by node (1000:1000) so a
# Docker named volume mounted here copies that ownership on first use. No
# VOLUME instruction on purpose - it would silently drop child images' changes
# under /persist and leave anonymous volumes behind.
RUN install -d -m 0755 /persist \
  && install -d -o 1000 -g 1000 -m 0700 \
    /persist/claude /persist/codex /persist/gh /persist/no-mistakes /persist/agentsview /persist/events

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

# uv (cbundy/dev-system#149): the Python bootstrapper, so a Python repo runs
# its gates with `uv run --with ...` / `uvx` and needs no per-repo image just
# for pip or venv (the Debian python3 ships neither). Its official installer
# puts uv and uvx in ~/.local/bin, already on PATH, and leaves the shell
# profiles alone. Its cache (~/.cache/uv), tools and managed Pythons
# (~/.local/share/uv) stay in node's home, never under /persist, and the
# install receipt in ~/.config/uv keeps `uv self update` working.
RUN curl -LsSf https://astral.sh/uv/install.sh \
    | env UV_NO_MODIFY_PATH=1 UV_INSTALL_DIR=/home/node/.local/bin sh \
  && uv --version \
  && uvx --version

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

# Coder CLI: talks to the Coder deployment this workspace runs on. Pinned by
# version and checksum to the deployment's server version
# (`curl -s "$CODER_AGENT_URL/api/v2/buildinfo"`): a mismatched CLI silently
# ignored --parameter before (cbundy/dev-system#108). Bump all three ARGs
# together when the server is upgraded (checksums: coder_<version>_checksums.txt
# in the release).
ARG CODER_VERSION=2.36.6
ARG CODER_SHA256_AMD64=5579b42bb03e6aa646a9f190862e65a3dadfa6353296ba99553fe95b850329c2
ARG CODER_SHA256_ARM64=8e87fd117dd76fbddd16be757803a58ae0cf11f52791d2ee97765d294e15bf9c
RUN arch=$(dpkg --print-architecture) \
  && case "$arch" in \
    amd64) sha256="$CODER_SHA256_AMD64" ;; \
    arm64) sha256="$CODER_SHA256_ARM64" ;; \
    *) echo "coder: unsupported architecture $arch" >&2; exit 1 ;; \
  esac \
  && tmp=$(mktemp -d) \
  && curl -fsSL -o "$tmp/coder.tar.gz" \
    "https://github.com/coder/coder/releases/download/v${CODER_VERSION}/coder_${CODER_VERSION}_linux_${arch}.tar.gz" \
  && echo "$sha256  $tmp/coder.tar.gz" | sha256sum -c - \
  && tar -xzf "$tmp/coder.tar.gz" -C "$tmp" ./coder \
  && install -m 0755 "$tmp/coder" /usr/local/bin/coder \
  && rm -rf "$tmp" \
  && coder version

# Shared scripts from the callum-tools feature, staged at the same path the
# feature uses (the callum-flow skills call the watchers and usage-check.sh
# there). usage-check.sh is image-only: the deprecated feature does not ship it.
COPY --chmod=0755 \
  features/src/callum-tools/recover-no-mistakes.sh \
  features/src/callum-tools/pin-codex-model.sh \
  features/src/callum-tools/check-pr-linkage.sh \
  features/src/callum-tools/pipeline-watch.sh \
  features/src/callum-tools/queue-watch.sh \
  features/src/callum-tools/usage-check.sh \
  /usr/local/share/callum-tools/

# systemctl replaces the base image's shim of the same name, which reports
# success without systemd (see the script, cbundy/dev-system#101).
COPY --chmod=0755 \
  images/base/dev-init \
  images/base/dev-doctor \
  images/base/dev-entrypoint \
  images/base/dev-remote-control \
  images/base/dev-prune-worktrees \
  images/base/dev-restart-self \
  images/base/dev-version \
  images/base/dev-query \
  images/base/dev-login \
  images/base/callum-flow-event \
  images/base/callum-flow-merge-guard \
  images/base/callum-flow-rollout \
  images/base/callum-flow-merge \
  images/base/callum-flow-fix-linkage \
  images/base/callum-flow-claim \
  images/base/callum-flow-sweep \
  images/base/callum-flow-evaluate \
  images/base/systemctl \
  /usr/local/bin/
COPY --chmod=0755 images/base/agentsview-push-loop images/base/event-push-loop images/base/nm-push-loop images/base/nm-export /usr/local/share/dev-system/
# models.env is the baked copy of the no-mistakes models: dev-init pins from
# the copy it fetches from main on every start, and falls back to this one
# (models.sh parses both).
COPY --chmod=0644 images/base/dev-login-page.js images/base/workspace.sh images/base/agentsview.sh \
  images/base/telemetry.sh images/base/codex-otel.sh images/base/models.sh images/base/models.env \
  images/base/gh.sh images/base/plugins.sh \
  /usr/local/share/dev-system/

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

# The Claude plugins every workspace gets (cbundy/dev-system#148): dev-init
# installs each one on every start, with or without a repo, so the callum-flow
# skills (issue-orchestrator, implement-issue, onboard, update-dev) are in
# every first Claude session. A whitespace-separated list of
# <plugin>@<marketplace>=<marketplace source> entries (see plugins.sh). A
# per-repo image (ENV DEV_DEFAULT_PLUGINS=...) or the runtime's environment
# can change it; empty installs none. The default is pinned to the plugin
# release current at image build (DEV_PLUGIN_REF, a tag such as v0.10.0, set by
# publish-base-image.yml, which fails without one), so a repo with no
# settings file gets a release, not main. A repo's committed .claude/settings.json
# that declares the marketplace wins over this pin
# (cbundy/dev-system#215).
# The empty default is only for ad-hoc local builds; published images always set it.
ARG DEV_PLUGIN_REF=
ENV DEV_DEFAULT_PLUGINS=callum-flow@callum=cbundy/dev-system${DEV_PLUGIN_REF:+#$DEV_PLUGIN_REF}

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
# The image's own release stamp (cbundy/dev-system#271): the same values as the OCI labels
# below, so dev-version compares the running image with the newest one published on GHCR
# without diffing files. A per-repo image layer stamps itself the same way, as
# image-release.d/<name> (see README.md, "Tags and versioning"). Late, so a changed
# revision invalidates only this layer.
USER root
RUN mkdir -p /usr/local/share/dev-system \
  && printf '%s\n' \
    "IMAGE=ghcr.io/cbundy/dev-system/base" \
    "VERSION=${VERSION}" \
    "REVISION=${REVISION}" \
    "CREATED=${CREATED}" \
    "DEV_PLUGIN_REF=${DEV_PLUGIN_REF}" \
    "AGENTSVIEW_VERSION=${AGENTSVIEW_VERSION}" \
    "CODER_VERSION=${CODER_VERSION}" \
    > /usr/local/share/dev-system/image-release \
  && chmod 0644 /usr/local/share/dev-system/image-release
USER node
LABEL org.opencontainers.image.source="https://github.com/cbundy/dev-system" \
  org.opencontainers.image.revision="${REVISION}" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.created="${CREATED}" \
  org.opencontainers.image.title="dev-system base" \
  org.opencontainers.image.description="Prebuilt agent dev environment: Node LTS, Claude Code, codex, no-mistakes, treehouse, uv, agentsview, gh, git, with tool state persisted under /persist. Tags are mutable; pin by digest if you need reproducibility." \
  dev.cbundy.persist="/persist/claude,/persist/codex,/persist/gh,/persist/no-mistakes,/persist/agentsview" \
  dev.cbundy.shared="/shared" \
  dev.cbundy.secrets="/run/secrets/dev-system" \
  devcontainer.metadata="[{\"remoteUser\":\"node\",\"updateRemoteUserUID\":false,\"containerEnv\":{\"CLAUDE_CONFIG_DIR\":\"/persist/claude\",\"CODEX_HOME\":\"/persist/codex\",\"GH_CONFIG_DIR\":\"/persist/gh\",\"NM_HOME\":\"/persist/no-mistakes\",\"NO_MISTAKES_HOME\":\"/persist/no-mistakes\",\"DEV_SHARED_DIR\":\"/shared\",\"DEV_SECRETS_DIR\":\"/run/secrets/dev-system\",\"DEV_REMOTE_CONTROL\":\"0\",\"DEV_DESKTOP\":\"1\",\"AGENTSVIEW_DATA_DIR\":\"/persist/agentsview\",\"AGENTSVIEW_TELEMETRY_ENABLED\":\"0\",\"AGENTSVIEW_DISABLE_UPDATE_CHECK\":\"1\"},\"postStartCommand\":\"dev-init && dev-remote-control --post-start\",\"mounts\":[{\"type\":\"volume\",\"source\":\"dev-system-gh\",\"target\":\"/persist/gh\"},\"type=volume,source=dev-system-secrets,target=/run/secrets/dev-system,readonly\"]}]"
