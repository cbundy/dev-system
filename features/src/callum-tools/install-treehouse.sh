#!/bin/sh
#
# Install the latest treehouse release without the GitHub REST API.
#
# treehouse's upstream installer looks the latest tag up through
# api.github.com, whose anonymous limit (60 requests/hour/IP) makes CI and
# image builds flake with a 403 (cbundy/dev-system#356). This script resolves
# the tag from the https://github.com/<repo>/releases/latest redirect instead,
# which that limit does not cover, then downloads the release asset by URL.
#
# Usage: install-treehouse.sh [install-dir]   (default: $HOME/.local/bin)
# Test hooks: TREEHOUSE_CURL (curl binary), TREEHOUSE_BASE_URL (GitHub base).
set -eu

REPO=kunchenguid/treehouse
BASE=${TREEHOUSE_BASE_URL:-https://github.com}
CURL=${TREEHOUSE_CURL:-curl}
DEST=${1:-$HOME/.local/bin}

die() {
  echo "treehouse: $*" >&2
  exit 1
}

case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "unsupported OS: $(uname -s)" ;;
esac
case $(uname -m) in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

tmp=$(mktemp -d) || die "could not create a temp dir"
trap 'rm -rf "$tmp"; rm -f "$DEST/treehouse.new"' EXIT

final=$("$CURL" -fsSLI --retry 3 --retry-connrefused -o /dev/null -w '%{url_effective}' \
  "$BASE/$REPO/releases/latest") || die "could not resolve the latest release"
case $final in
  */releases/tag/*) tag=${final##*/releases/tag/} ;;
  *) die "could not resolve the latest release tag (landed on $final)" ;;
esac
[ -n "$tag" ] || die "could not resolve the latest release tag"

asset="treehouse-$tag-$os-$arch.tar.gz"
"$CURL" -fsSL --retry 3 --retry-connrefused -o "$tmp/$asset" \
  "$BASE/$REPO/releases/download/$tag/$asset" || die "download of $asset failed"
mkdir "$tmp/x" || die "could not create a temp dir"
tar -xzf "$tmp/$asset" -C "$tmp/x" || die "could not extract $asset"
bin=$(find "$tmp/x" -type f -name treehouse | head -n 1)
[ -n "$bin" ] || die "no treehouse binary in $asset"

mkdir -p "$DEST" || die "could not create $DEST"
cp "$bin" "$DEST/treehouse.new" || die "could not write to $DEST"
chmod 755 "$DEST/treehouse.new" || die "could not make $DEST/treehouse.new executable"
mv "$DEST/treehouse.new" "$DEST/treehouse" || die "could not install $DEST/treehouse"
echo "treehouse: installed $tag to $DEST/treehouse"
