#!/bin/sh
# Print the Coder template version name (or push message) for a template directory
# (cbundy/dev-system#514), so versions in the Coder UI map back to source.
#
#   version-name.sh <dir>                    the name: <git describe>-<UTC timestamp>, e.g.
#                                            v0.34.0-2-gb3ae3f3-20261012-200455
#   version-name.sh --message <script> <dir> the push message: "<script> from <branch> @ <describe>"
#                                            (empty without git)
#
# The describe is `git describe --tags --always --dirty`: the release tag at a tagged commit,
# <tag>-<n>-g<sha> after it, a bare short sha with no reachable tag, -dirty with uncommitted
# changes. The timestamp is required: Coder rejects a duplicate version name per template and
# the same commit is routinely pushed more than once. Without git the name is nogit-<timestamp>.
#
# Coder accepts ^[a-zA-Z0-9]+(?:[_.-]{1}[a-zA-Z0-9]+)*$ of at most 64 characters, so any other
# character becomes "-", separator runs collapse, the ends are trimmed and the describe is
# capped: a push can never fail on an odd tag.
set -eu

max=64
msg_script=
if [ "${1:-}" = --message ]; then
  [ $# -eq 3 ] || { echo "usage: version-name.sh [--message <script>] <dir>" >&2; exit 2; }
  msg_script=$2
  shift 2
fi
[ $# -eq 1 ] || { echo "usage: version-name.sh [--message <script>] <dir>" >&2; exit 2; }
dir=$1

describe=$(git -C "$dir" describe --tags --always --dirty --abbrev=7 2>/dev/null || true)

if [ -n "$msg_script" ]; then
  [ -z "$describe" ] && exit 0
  branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
  printf '%s from %s @ %s\n' "$msg_script" "$branch" "$describe"
  exit 0
fi

stamp=$(date -u +%Y%m%d-%H%M%S)
trim() { sed -E 's/^[_.-]+//; s/[_.-]+$//'; }
if [ -z "$describe" ]; then
  printf 'nogit-%s\n' "$stamp"
  exit 0
fi
room=$((max - ${#stamp} - 1))
clean=$(printf '%s' "$describe" | tr -c 'a-zA-Z0-9_.\n-' '-' | sed -E 's/([_.-])[_.-]+/-/g' \
  | trim | cut -c "1-$room" | trim)
[ -n "$clean" ] || clean=unknown
printf '%s-%s\n' "$clean" "$stamp"
