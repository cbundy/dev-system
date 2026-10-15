#!/bin/sh
# The size guard (docs/factory-loop/v2/SPEC.md 2.5): no file under a directory may be over a
# number of lines, but those an allowlist names. The allowlist only shrinks: a listed file at or
# under the limit fails too (its entry must go), and so does a listed file that is gone. lint.sh
# runs it on plugins/factory-loop/hooks/ with its allowlist; tests/size-guard.test.js runs it on
# fixtures.
#
# usage: size-guard.sh <dir> <max lines> [<listed file, relative to dir>...]
#
# Quiet on success. On failure, one line per file on stderr, and exit 1; exit 2 on bad usage.
set -u

if [ "$#" -lt 2 ] || [ ! -d "$1" ]; then
  echo "usage: size-guard.sh <dir> <max lines> [<listed file>...]" >&2
  exit 2
fi
dir=${1%/}
max=$2
shift 2
case $max in
  '' | *[!0-9]*)
    echo "size-guard: the limit must be a whole number, not '$max'" >&2
    exit 2
    ;;
esac

failed=0

# A temp file, not a pipe, so the loop runs in this shell and can count failures.
list=$(mktemp) || exit 1
trap 'rm -f "$list"' EXIT
find "$dir" -type f | sort > "$list"
while IFS= read -r file; do
  rel=${file#"$dir"/}
  lines=$(wc -l < "$file" | tr -d ' ')
  allowed=0
  for item in "$@"; do
    [ "$item" = "$rel" ] && allowed=1
  done
  if [ "$lines" -gt "$max" ] && [ "$allowed" = 0 ]; then
    echo "size-guard: $dir/$rel is $lines lines, over $max: split it by area and kind (v2 SPEC 2.5)" >&2
    failed=$((failed + 1))
  elif [ "$lines" -le "$max" ] && [ "$allowed" = 1 ]; then
    echo "size-guard: $dir/$rel is $lines lines, at or under $max: take it off the allowlist, which only shrinks" >&2
    failed=$((failed + 1))
  fi
done < "$list"
for item in "$@"; do
  if [ ! -f "$dir/$item" ]; then
    echo "size-guard: $dir/$item is on the allowlist and is gone: take it off" >&2
    failed=$((failed + 1))
  fi
done

[ "$failed" -eq 0 ] || exit 1
