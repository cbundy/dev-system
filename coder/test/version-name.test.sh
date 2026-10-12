#!/bin/sh
#
# Plain-shell unit test for coder/version-name.sh: each case runs in a throwaway git repo
# with a private HOME so no host git config is read.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
VN="$SCRIPT_DIR/../version-name.sh"
[ -x "$VN" ] || { echo "FAIL: $VN is missing or not executable" >&2; exit 1; }

fail() { echo "FAIL: $*" >&2; exit 1; }

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
export HOME="$tmpdir/home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
mkdir -p "$HOME"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.test GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.test

TS='[0-9]{8}-[0-9]{6}'

# check <name> <regex>: the name matches the regex and Coder's rule (at most 64 chars).
check() {
  [ "${#1}" -le 64 ] || fail "'$1' is longer than 64 characters"
  printf '%s' "$1" | grep -Eq '^[a-zA-Z0-9]+([_.-][a-zA-Z0-9]+)*$' || fail "'$1' breaks Coder's name rule"
  printf '%s' "$1" | grep -Eq "$2" || fail "'$1' does not match $2"
}

new_repo() {
  r=$tmpdir/$1
  git init -q "$r"
  git -C "$r" commit -q --allow-empty -m one
  echo "$r"
}

# Untagged: short sha.
r=$(new_repo untagged)
check "$("$VN" "$r")" "^[0-9a-f]{7}-$TS\$"

# Tagged commit: the tag.
r=$(new_repo tagged)
git -C "$r" tag v1.2.3
check "$("$VN" "$r")" "^v1\\.2\\.3-$TS\$"

# One commit past the tag.
git -C "$r" commit -q --allow-empty -m two
check "$("$VN" "$r")" "^v1\\.2\\.3-1-g[0-9a-f]{7}-$TS\$"

# Uncommitted change to a tracked file.
echo a > "$r/f"; git -C "$r" add f; git -C "$r" commit -q -m three
echo b > "$r/f"
check "$("$VN" "$r")" "^v1\\.2\\.3-2-g[0-9a-f]{7}-dirty-$TS\$"

# A tag with characters Coder rejects.
r=$(new_repo oddtag)
git -C "$r" tag 'release/odd,tag__x'
check "$("$VN" "$r")" "^release-odd-tag-x-$TS\$"

# A very long tag is capped and still valid.
r=$(new_repo longtag)
git -C "$r" tag "v$(printf 'a%.0s' $(seq 1 120))"
check "$("$VN" "$r")" "^va+-$TS\$"

# No git at all.
mkdir "$tmpdir/plain"
check "$("$VN" "$tmpdir/plain")" "^nogit-$TS\$"

# Message: script, branch and describe; empty without git.
r=$(new_repo msg)
git -C "$r" tag v9.9.9
git -C "$r" checkout -q -b feat/x
m=$("$VN" --message push-next.sh "$r")
[ "$m" = "push-next.sh from feat/x @ v9.9.9" ] || fail "message wrong: '$m'"
[ -z "$("$VN" --message push.sh "$tmpdir/plain")" ] || fail "message without git should be empty"

# Bad usage.
if "$VN" >/dev/null 2>&1; then fail "no argument should fail"; fi
echo "version-name tests passed"
