#!/bin/sh
#
# Build-time installer for the callum-tools feature.
#
# Feature install scripts run as root while the image is being built, but the
# tools this feature provides (no-mistakes, treehouse, Claude Code CLI) are
# per-user installs that belong in the remote user's home - and in setups like
# Callum's, ~/.no-mistakes is a bind mount that only exists at run time. So
# this script installs nothing itself: it stages setup.sh plus the chosen
# options, and the feature's postCreateCommand runs setup.sh as the remote
# user once the container is up.
set -e

DEST=/usr/local/share/callum-tools
mkdir -p "$DEST"

cp "$(dirname "$0")/setup.sh" "$DEST/setup.sh"
chmod 755 "$DEST/setup.sh"
cp "$(dirname "$0")/pipeline-watch.sh" "$DEST/pipeline-watch.sh"
chmod 755 "$DEST/pipeline-watch.sh"
cp "$(dirname "$0")/queue-watch.sh" "$DEST/queue-watch.sh"
chmod 755 "$DEST/queue-watch.sh"
cp "$(dirname "$0")/recover-no-mistakes.sh" "$DEST/recover-no-mistakes.sh"
chmod 755 "$DEST/recover-no-mistakes.sh"
cp "$(dirname "$0")/pin-codex-model.sh" "$DEST/pin-codex-model.sh"
chmod 755 "$DEST/pin-codex-model.sh"

# Feature options arrive as uppercased env vars at build time only; persist
# them for setup.sh to read at post-create time.
cat > "$DEST/options.env" <<EOF
INSTALL_CLAUDE_CODE=${INSTALLCLAUDECODE:-true}
INSTALL_NO_MISTAKES=${INSTALLNOMISTAKES:-true}
INSTALL_TREEHOUSE=${INSTALLTREEHOUSE:-true}
CODEX_MODEL=${CODEXMODEL-gpt-6.1-sol}
EOF
chmod 644 "$DEST/options.env"

# Defensive fix for cbundy/dev-system#21: the Claude Code npm install now
# happens in setup.sh as the remote user, which is enough on the base
# images/features we have observed (they chown the npm global prefix to the
# remote user, setgid, at image-build time). But that ownership is set by
# the base image or the node feature, not by us - a different base image, an
# apt-installed Node, or any other build step that writes into the npm
# prefix as root would leave the remote user unable to install or update
# Claude Code there. So make it robust ourselves: while we are still root,
# make sure the npm global prefix tree is owned by (and writable by) the
# remote user, so whatever setup.sh does later as that user can create and
# replace every file under it. Best-effort and idempotent - skip cleanly
# when there is nothing to do.
if [ "${INSTALLCLAUDECODE:-true}" != "false" ] \
  && [ -n "${_REMOTE_USER:-}" ] && [ "${_REMOTE_USER}" != "root" ] \
  && command -v npm >/dev/null 2>&1; then
  NPM_GLOBAL_PREFIX=$(npm prefix -g 2>/dev/null || true)
  if [ -n "$NPM_GLOBAL_PREFIX" ] && [ -d "$NPM_GLOBAL_PREFIX" ]; then
    if getent group npm >/dev/null 2>&1; then
      NPM_PREFIX_GROUP=npm
    else
      NPM_PREFIX_GROUP=$(id -gn "$_REMOTE_USER" 2>/dev/null || echo "$_REMOTE_USER")
    fi
    if chown -R "$_REMOTE_USER:$NPM_PREFIX_GROUP" "$NPM_GLOBAL_PREFIX" 2>/dev/null; then
      echo "callum-tools: npm global prefix ($NPM_GLOBAL_PREFIX) owned by $_REMOTE_USER:$NPM_PREFIX_GROUP so Claude Code can install/update without root."
    else
      echo "callum-tools: could not chown npm global prefix ($NPM_GLOBAL_PREFIX) to $_REMOTE_USER - Claude Code install/update at post-create may fail if it is not already writable by that user." >&2
    fi
  fi
fi

echo "callum-tools staged; tools install at post-create as the remote user."
