#!/bin/sh
# Canonical lint entrypoint (`npm run lint`; CLAUDE.md "Canonical commands").
#
# Interim: syntax-only checks (`sh -n` / `bash -n` / `node --check`) until shellcheck
# replaces the `-n` checks (see #116).
#
# Shell scripts are discovered, not listed: every file under the directories below whose
# first line is a shell shebang or a `# shellcheck shell=...` directive is checked with the
# shell it declares, so a new script is covered without touching this file. Everything
# else (Dockerfile, README, .js, .json, .awk) is skipped.
set -u

cd "$(dirname "$0")/.." || exit 1

SHELL_DIRS="images/base features/src/callum-tools features/test plugins/callum-flow/hooks"
JS_DIRS="bin plugins"

failures=0
checked=0

fail() {
  echo "lint: FAIL $1" >&2
  failures=$((failures + 1))
}

# Print the shell a file declares on its first line (sh or bash), or nothing.
shell_of() {
  first=$(head -n 1 "$1")
  case "$first" in
    '#!/bin/sh' | '#!/bin/sh '* | '#!/usr/bin/env sh' | '#!/usr/bin/env sh '*) echo sh ;;
    '#!/bin/bash' | '#!/bin/bash '* | '#!/usr/bin/env bash' | '#!/usr/bin/env bash '*) echo bash ;;
    '# shellcheck shell=sh') echo sh ;;
    '# shellcheck shell=bash') echo bash ;;
    # A shell script with a shebang this does not know must not slip through unchecked.
    '#!'*sh | '#!'*sh' '*) echo unknown ;;
  esac
}

# A temp file, not a pipe, so the loops run in this shell and can count failures.
list=$(mktemp) || exit 1
trap 'rm -f "$list"' EXIT

# shellcheck disable=SC2086 # word-splitting the directory lists is intended
find $SHELL_DIRS -type f | sort > "$list"
while IFS= read -r file; do
  sh_name=$(shell_of "$file")
  case "$sh_name" in
    "") continue ;;
    unknown)
      fail "$file: unrecognised shebang '$(head -n 1 "$file")'"
      continue
      ;;
  esac
  checked=$((checked + 1))
  if ! out=$("$sh_name" -n "$file" 2>&1); then
    fail "$file ($sh_name -n)"
    printf '%s\n' "$out" >&2
  fi
done < "$list"

# shellcheck disable=SC2086
find $JS_DIRS -type f -name '*.js' | sort > "$list"
while IFS= read -r file; do
  checked=$((checked + 1))
  if ! out=$(node --check "$file" 2>&1); then
    fail "$file (node --check)"
    printf '%s\n' "$out" >&2
  fi
done < "$list"

if [ "$failures" -gt 0 ]; then
  echo "lint: $failures of $checked file(s) failed" >&2
  exit 1
fi
echo "lint: $checked file(s) ok"
