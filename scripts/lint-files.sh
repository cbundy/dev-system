#!/bin/sh
# Check a list of files for scripts/lint.sh, in parallel through scripts/test-pool.sh.
#
# Usage: lint-files.sh <list-file> <results-dir> [--js]
#
# Each line of <list-file> is a path, in the order failures are reported. A path is classified by
# its first line (the shell it declares, `node` for a node shebang); anything else is skipped.
# With --js a .js or .mjs path is also `node`, whatever its first line. Each checked file is one pool job (scripts/lint-file.sh), so the pool's size is
# TEST_JOBS or the CPU count, and each failing file's output is printed to stderr as one block, in
# list order. The last stdout line is `<checked> <failed>`; a file with an unrecognised shell
# shebang counts as failed but not as checked. Exits 0 even when files failed; exits the pool's
# status when it did not run to the end (a bad TEST_JOBS: 2; interrupted: 130, 143).
set -u

here=$(cd "$(dirname "$0")" && pwd) || exit 1
list=${1:?usage: lint-files.sh <list-file> <results-dir> [--js]}
results=${2:?usage: lint-files.sh <list-file> <results-dir> [--js]}
by_ext=${3:-}

# Print the kind of a file: sh, bash, node, unknown, or nothing when it is not a script.
shell_of() {
  if [ "$by_ext" = --js ]; then
    case "$1" in
      *.js | *.mjs)
        echo node
        return
        ;;
    esac
  fi
  first=$(head -n 1 "$1")
  case "$first" in
    '#!/bin/sh' | '#!/bin/sh '* | '#!/usr/bin/env sh' | '#!/usr/bin/env sh '*) echo sh ;;
    '#!/bin/bash' | '#!/bin/bash '* | '#!/usr/bin/env bash' | '#!/usr/bin/env bash '*) echo bash ;;
    '#!/usr/bin/env node' | '#!/usr/bin/env node '*) echo node ;;
    '# shellcheck shell=sh') echo sh ;;
    '# shellcheck shell=bash') echo bash ;;
    # A shell script with a shebang this does not know must not slip through unchecked.
    '#!'*sh | '#!'*sh' '*) echo unknown ;;
  esac
}

quote() { # single-quote a path for sh
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

mkdir -p "$results" || exit 1
jobs="$results/jobs"
: > "$jobs"
checked=0
unknown=0
while IFS= read -r file || [ -n "$file" ]; do
  [ -n "$file" ] || continue
  kind=$(shell_of "$file")
  [ -n "$kind" ] || continue
  if [ "$kind" = unknown ]; then
    unknown=$((unknown + 1))
  else
    checked=$((checked + 1))
  fi
  printf 'sh %s %s %s\n' "$(quote "$here/lint-file.sh")" "$kind" "$(quote "$file")" >> "$jobs"
done < "$list"

# Failing blocks go to stderr; exit 1 only means some file failed, which the count reports.
sh "$here/test-pool.sh" "$results" "$jobs"
status=$?
[ "$status" -le 1 ] || exit "$status"
failed=$(cat "$results/failed" 2>/dev/null || echo 0)
echo "$checked $failed"
