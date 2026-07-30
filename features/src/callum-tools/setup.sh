#!/bin/bash
#
# Post-create setup for the callum-tools feature. Runs as the remote user
# (via the feature's postCreateCommand), mirroring a hand-run install:
# per-user tools land under $HOME, not /root.
set -euo pipefail

. /usr/local/share/callum-tools/options.env

# Ensure a user-local bin dir exists and is preferred for this script, so the
# upstream installers (which pick ~/.local/bin only when it is already on
# PATH) install without sudo. Debian-family images add ~/.local/bin to PATH
# in login shells once the directory exists; non-login-shell consumers should
# also append it via remoteEnv/containerEnv.
mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"

# Each install is judged by its outcome (is the tool on PATH afterwards?),
# not by the installer's exit code: the no-mistakes installer, for example,
# also tries to start its daemon, and a best-effort daemon launch failing
# must not abort the remaining installs. A requested tool that is genuinely
# missing at the end still fails the whole setup.
FAILED=""

# 1. Claude Code CLI (global npm install; devcontainer Node images give the
#    remote user write access to the npm global prefix).
if [ "${INSTALL_CLAUDE_CODE}" = "true" ]; then
  if command -v npm >/dev/null 2>&1; then
    npm install -g @anthropic-ai/claude-code || true
    command -v claude >/dev/null 2>&1 || FAILED="$FAILED claude"
  else
    echo "callum-tools: npm not found - skipping Claude Code CLI install (use a Node base image or the node feature)" >&2
  fi
fi

# 2. no-mistakes pipeline CLI. Its installer places the binary under
#    ~/.no-mistakes/bin and symlinks it into ~/.local/bin. ~/.no-mistakes may
#    be a bind mount from the host; that is fine - the installer overwrites
#    the binary in place.
if [ "${INSTALL_NO_MISTAKES}" = "true" ]; then
  curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh || true
  command -v no-mistakes >/dev/null 2>&1 || FAILED="$FAILED no-mistakes"
fi

# 3. treehouse (reusable worktree pool for parallel agents).
if [ "${INSTALL_TREEHOUSE}" = "true" ]; then
  curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh || true
  command -v treehouse >/dev/null 2>&1 || FAILED="$FAILED treehouse"
fi

if [ -n "${FAILED}" ]; then
  echo "callum-tools: FAILED to install:${FAILED}" >&2
  exit 1
fi
echo "callum-tools setup complete."
