#!/bin/sh
# The size guard (docs/factory-loop/v2/SPEC.md 2.5): no file under a directory may be over a
# number of lines, but those an allowlist names, each with a cap of its own: the lines it had when
# it was listed. Both only shrink: a listed file over its cap fails (it may not grow), a listed file
# at or under the limit fails (its entry must go), and so does a listed file that is gone. lint.sh
# runs it on plugins/factory-loop/hooks/ with its allowlist; tests/size-guard.test.js runs it on
# fixtures.
#
# usage: size-guard.sh <dir> <max lines> [<listed file, relative to dir>:<its cap>...]
#
# Quiet on success. On failure, one line per file on stderr, and exit 1; exit 2 on bad usage.
set -u

if [ "$#" -lt 2 ] || [ ! -d "$1" ]; then
  echo "usage: size-guard.sh <dir> <max lines> [<listed file>:<cap>...]" >&2
  exit 2
fi
dir=${1%/}
max=$2
shift 2
whole() {
  case $1 in
    '' | *[!0-9]*) return 1 ;;
  esac
}
if ! whole "$max"; then
  echo "size-guard: the limit must be a whole number, not '$max'" >&2
  exit 2
fi
for item in "$@"; do
  if ! whole "${item##*:}" || [ "${item%:*}" = "$item" ] || [ "${item%:*}" = "" ]; then
    echo "size-guard: an allowlist entry is <file>:<cap>, not '$item'" >&2
    exit 2
  fi
done

failed=0

# A temp file, not a pipe, so the loop runs in this shell and can count failures.
list=$(mktemp) || exit 1
trap 'rm -f "$list"' EXIT
find "$dir" -type f | sort > "$list"
while IFS= read -r file; do
  rel=${file#"$dir"/}
  lines=$(wc -l < "$file" | tr -d ' ')
  cap=''
  for item in "$@"; do
    [ "${item%:*}" = "$rel" ] && cap=${item##*:}
  done
  if [ "$lines" -gt "$max" ] && [ "$cap" = '' ]; then
    echo "size-guard: $dir/$rel is $lines lines, over $max: split it by area and kind (v2 SPEC 2.5)" >&2
    failed=$((failed + 1))
  elif [ "$lines" -le "$max" ] && [ "$cap" != '' ]; then
    echo "size-guard: $dir/$rel is $lines lines, at or under $max: take it off the allowlist, which only shrinks" >&2
    failed=$((failed + 1))
  elif [ "$cap" != '' ] && [ "$lines" -gt "$cap" ]; then
    echo "size-guard: $dir/$rel is $lines lines, over its cap of $cap: a listed file may only shrink, so move what it gained into a module of its own (v2 SPEC 2.5)" >&2
    failed=$((failed + 1))
  fi
done < "$list"
for item in "$@"; do
  if [ ! -f "$dir/${item%:*}" ]; then
    echo "size-guard: $dir/${item%:*} is on the allowlist and is gone: take it off" >&2
    failed=$((failed + 1))
  fi
done

[ "$failed" -eq 0 ] || exit 1
