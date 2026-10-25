#!/bin/bash
#
# Post-create setup for the callum-tools feature. Runs as the remote user
# (via the feature's postCreateCommand), mirroring a hand-run install:
# per-user tools land under $HOME, not /root.
set -euo pipefail

# shellcheck disable=SC1091 # written by install.sh at feature install time, not in the repo
. /usr/local/share/callum-tools/options.env

# Ensure a user-local bin dir exists and is preferred for this script, so the
# upstream installers (which pick ~/.local/bin only when it is already on
# PATH) install without sudo. Debian-family images add ~/.local/bin to PATH
# in login shells once the directory exists; non-login-shell consumers should
# also append it via remoteEnv/containerEnv.
mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"

# Each install is judged by its outcome (is the tool on PATH afterwards?),
# not by the installer's exit code, so a best-effort step failing does not
# abort the remaining installs. A requested tool that is genuinely
# missing at the end still fails the whole setup.
FAILED=""

# 1. Claude Code CLI (global npm install; devcontainer Node images/features
#    normally give the remote user write access to the npm global prefix,
#    and install.sh also chowns it defensively at build time - see
#    cbundy/dev-system#21). Check writability up front so a permissions
#    problem produces a clear, actionable error instead of a swallowed
#    `npm install -g` failure that just leaves `claude` missing.
if [ "${INSTALL_CLAUDE_CODE}" = "true" ]; then
  if command -v npm >/dev/null 2>&1; then
    NPM_GLOBAL_PREFIX=$(npm prefix -g 2>/dev/null || true)
    if [ -n "$NPM_GLOBAL_PREFIX" ] && [ -d "$NPM_GLOBAL_PREFIX" ] && [ ! -w "$NPM_GLOBAL_PREFIX" ]; then
      echo "callum-tools: npm global prefix '$NPM_GLOBAL_PREFIX' is not writable by $(id -un) - Claude Code cannot be installed or auto-updated here. This is a base-image/feature setup issue (the prefix should be chowned to the remote user); see cbundy/dev-system#21." >&2
    fi
    npm install -g @anthropic-ai/claude-code || true
    if ! command -v claude >/dev/null 2>&1; then
      FAILED="$FAILED claude"
    elif [ -n "$NPM_GLOBAL_PREFIX" ] && [ -d "$NPM_GLOBAL_PREFIX/lib/node_modules/@anthropic-ai" ] \
      && [ ! -w "$NPM_GLOBAL_PREFIX/lib/node_modules/@anthropic-ai" ]; then
      echo "callum-tools: claude installed but '$NPM_GLOBAL_PREFIX/lib/node_modules/@anthropic-ai' is not writable by $(id -un) - 'claude update' will fail later even though install succeeded now; see cbundy/dev-system#21." >&2
    fi
  else
    echo "callum-tools: npm not found - skipping Claude Code CLI install (use a Node base image or the node feature)" >&2
  fi
fi

# 2. treehouse (reusable worktree pool for parallel agents).
if [ "${INSTALL_TREEHOUSE}" = "true" ]; then
  /usr/local/share/callum-tools/install-treehouse.sh || true
  command -v treehouse >/dev/null 2>&1 || FAILED="$FAILED treehouse"
fi

if [ -n "${FAILED}" ]; then
  echo "callum-tools: FAILED to install:${FAILED}" >&2
  exit 1
fi
echo "callum-tools setup complete."
