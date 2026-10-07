#!/bin/sh
#
# Plain-shell test for the base image test layout (cbundy/dev-system#199): every section file
# in sections/ belongs to exactly one group of test.sh, and the test matrix in
# publish-base-image.yml lists exactly those groups, so a new section can neither go unrun in
# CI nor be run twice. No Docker needed.
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
WORKFLOW="$HERE/../../../.github/workflows/publish-base-image.yml"
fail=0
say_fail() {
  echo "FAIL: $*" >&2
  fail=1
}

groups=$("$HERE/test.sh" --list-groups)
[ -n "$groups" ] || say_fail "test.sh --list-groups printed nothing"

# Section numbers claimed by the groups table, one per line.
claimed=$(sed -n '/^GROUPS_TABLE="$/,/^"$/p' "$HERE/test.sh" | sed -n 's/^[a-z-]*: *//p' | tr ' ' '\n' | sed '/^$/d' | sort -n)
present=$(for f in "$HERE"/sections/*.sh; do basename "$f" | sed 's/^0*\([0-9]*\)-.*/\1/'; done | sort -n)
[ "$claimed" = "$present" ] || say_fail "groups claim sections [$(echo "$claimed" | tr '\n' ' ')] but sections/ has [$(echo "$present" | tr '\n' ' ')] (each exactly once)"

# The workflow's matrix: `group: [a, b, c]`.
matrix=$(sed -n 's/^ *group: \[\(.*\)\]$/\1/p' "$WORKFLOW" | tr -d ' ' | tr ',' '\n' | sort)
expected=$(echo "$groups" | sort)
[ "$matrix" = "$expected" ] || say_fail "the matrix in publish-base-image.yml ($(echo "$matrix" | tr '\n' ' ')) does not match test.sh groups ($(echo "$expected" | tr '\n' ' '))"

# An unknown group is refused before any docker call.
if "$HERE/test.sh" some-image no-such-group >/dev/null 2>&1; then
  say_fail "an unknown group was accepted"
fi

[ "$fail" -eq 0 ] && echo "groups.test.sh: ok"
exit "$fail"
