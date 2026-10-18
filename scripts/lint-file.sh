#!/bin/sh
# Check one file for scripts/lint.sh (run through scripts/test-pool.sh by scripts/lint-files.sh).
#
# Usage: lint-file.sh <sh|bash|node|unknown> <file>
#
# sh and bash: `shellcheck -x -s <kind>` when shellcheck is on PATH, else `<kind> -n`.
# node: `node --check`. unknown: fails without a check (a shebang lint does not know).
# On failure prints `lint: FAIL <file> (<check>)` and the tool's output, and exits 1.
set -u

kind=${1:?usage: lint-file.sh <sh|bash|node|unknown> <file>}
file=${2:?usage: lint-file.sh <sh|bash|node|unknown> <file>}

case "$kind" in
  node)
    check="node --check"
    out=$(node --check "$file" 2>&1)
    ;;
  unknown)
    echo "lint: FAIL $file: unrecognised shebang '$(head -n 1 "$file")'"
    exit 1
    ;;
  sh | bash)
    if command -v shellcheck >/dev/null 2>&1; then
      check="shellcheck -s $kind"
      out=$(shellcheck -x -s "$kind" "$file" 2>&1)
    else
      check="$kind -n"
      out=$("$kind" -n "$file" 2>&1)
    fi
    ;;
  *)
    echo "lint-file: unknown kind '$kind'" >&2
    exit 2
    ;;
esac
status=$?
[ "$status" -eq 0 ] && exit 0
echo "lint: FAIL $file ($check)"
printf '%s\n' "$out"
exit 1
