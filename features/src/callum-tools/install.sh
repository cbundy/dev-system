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

# Feature options arrive as uppercased env vars at build time only; persist
# them for setup.sh to read at post-create time.
cat > "$DEST/options.env" <<EOF
INSTALL_CLAUDE_CODE=${INSTALLCLAUDECODE:-true}
INSTALL_NO_MISTAKES=${INSTALLNOMISTAKES:-true}
INSTALL_TREEHOUSE=${INSTALLTREEHOUSE:-true}
CODEX_MODEL=${CODEXMODEL-gpt-5.6-sol}
EOF
chmod 644 "$DEST/options.env"

echo "callum-tools staged; tools install at post-create as the remote user."
