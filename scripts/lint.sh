#!/bin/sh
# Canonical lint entrypoint (`npm run lint`; CLAUDE.md "Canonical commands").
#
# Shell scripts are discovered, not listed: every file under the directories below whose
# first line is a shell shebang or a `# shellcheck shell=...` directive is checked for the
# shell it declares, so a new script is covered without touching this file. Everything
# else (Dockerfile, README, .js, .json, .awk) is skipped.
#
# The check is `shellcheck -x -s <shell>` (config in the root .shellcheckrc) when shellcheck
# is on PATH - it is in the base image and on CI's runners. Without it, the check falls
# back to a syntax-only `sh -n` / `bash -n` and says so; CI still runs shellcheck.
# JavaScript gets `node --check`, including extensionless files with a node shebang under
# the directories above (images/base/callum-flow-evaluate).
#
# It also fails when a generated skill is stale (`node scripts/build-skills.js --check`),
# and runs terraform fmt and validate on coder/dev-system when terraform is on PATH.
#
# Quiet on success: one summary line, which also names any check skipped on this host.
set -u

cd "$(dirname "$0")/.." || exit 1

SHELL_DIRS="images/base features/src/callum-tools features/test plugins/callum-flow/hooks coder scripts"
JS_DIRS="images/base bin plugins scripts"

failures=0
checked=0
skipped=""

# Record a check skipped on this host, for the summary line.
skip() {
  skipped="${skipped:+$skipped; }$1"
}

fail() {
  echo "lint: FAIL $1" >&2
  failures=$((failures + 1))
}

# Print the shell a file declares on its first line (sh or bash), `node` for an extensionless
# node script, or nothing.
shell_of() {
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

if command -v shellcheck >/dev/null 2>&1; then
  have_shellcheck=1
else
  have_shellcheck=0
  skip "shellcheck not on PATH, syntax checks only; CI runs shellcheck"
fi

# A temp file, not a pipe, so the loops run in this shell and can count failures.
list=$(mktemp) || exit 1
trap 'rm -f "$list"' EXIT

# shellcheck disable=SC2086 # word-splitting the directory lists is intended
find $SHELL_DIRS -type f | sort > "$list"
while IFS= read -r file; do
  sh_name=$(shell_of "$file")
  case "$sh_name" in
    "") continue ;;
    node)
      checked=$((checked + 1))
      if ! out=$(node --check "$file" 2>&1); then
        fail "$file (node --check)"
        printf '%s\n' "$out" >&2
      fi
      continue
      ;;
    unknown)
      fail "$file: unrecognised shebang '$(head -n 1 "$file")'"
      continue
      ;;
  esac
  checked=$((checked + 1))
  if [ "$have_shellcheck" = 1 ]; then
    if ! out=$(shellcheck -x -s "$sh_name" "$file" 2>&1); then
      fail "$file (shellcheck -s $sh_name)"
      printf '%s\n' "$out" >&2
    fi
  elif ! out=$("$sh_name" -n "$file" 2>&1); then
    fail "$file ($sh_name -n)"
    printf '%s\n' "$out" >&2
  fi
done < "$list"

# shellcheck disable=SC2086 # word-splitting the directory list is intended
find $JS_DIRS -type f -name '*.js' | sort > "$list"
while IFS= read -r file; do
  checked=$((checked + 1))
  if ! out=$(node --check "$file" 2>&1); then
    fail "$file (node --check)"
    printf '%s\n' "$out" >&2
  fi
done < "$list"

# Generated skills (scripts/build-skills.js) must match their source doc.
checked=$((checked + 1))
# Its success line goes nowhere; a stale skill is reported on stderr.
if ! node scripts/build-skills.js --check > /dev/null; then
  fail "generated skills out of date (run npm run build:skills)"
fi

# Release notes (scripts/release-notes.js): every file valid, and notes for the package.json
# version, so a bump PR cannot pass ci without its notes.
checked=$((checked + 1))
if ! out=$(node scripts/release-notes.js --lint 2>&1); then
  fail "release notes invalid (run the release skill)"
  printf '%s\n' "$out" >&2
fi

# The Coder template (cbundy/dev-system#117): terraform fmt and validate. terraform is in
# this repo's dev image (.devcontainer/Dockerfile) and in CI (ci.yml), not on every
# host, so without it this is skipped with a note - unless LINT_REQUIRE_TERRAFORM=1 (CI),
# where a missing terraform must fail rather than pass unchecked.
TF_DIR=coder/dev-system
if command -v terraform >/dev/null 2>&1; then
  checked=$((checked + 1))
  if ! terraform -chdir="$TF_DIR" fmt -check -diff; then
    fail "$TF_DIR (terraform fmt -check; fix with terraform -chdir=$TF_DIR fmt)"
  fi
  # init and validate in a scratch copy, so lint writes nothing into the checkout (no
  # .terraform/ to ignore, works on a read-only mount). -lockfile=readonly fails when
  # main.tf's provider versions no longer match the committed lock file. init needs the
  # network once for the providers; the plugin cache saves the download on later runs.
  checked=$((checked + 1))
  tf_tmp=$(mktemp -d) || exit 1
  trap 'rm -f "$list"; rm -rf "$tf_tmp"' EXIT
  cp "$TF_DIR"/*.tf "$TF_DIR"/.terraform.lock.hcl "$tf_tmp"/
  TF_PLUGIN_CACHE_DIR=${TF_PLUGIN_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/terraform/plugin-cache}
  export TF_PLUGIN_CACHE_DIR
  mkdir -p "$TF_PLUGIN_CACHE_DIR"
  if ! out=$(terraform -chdir="$tf_tmp" init -backend=false -input=false -lockfile=readonly -no-color 2>&1); then
    fail "$TF_DIR (terraform init)"
    printf '%s\n' "$out" >&2
  elif ! out=$(terraform -chdir="$tf_tmp" validate -no-color 2>&1); then
    fail "$TF_DIR (terraform validate)"
    printf '%s\n' "$out" >&2
  fi
elif [ "${LINT_REQUIRE_TERRAFORM:-0}" = 1 ]; then
  checked=$((checked + 1))
  fail "terraform not on PATH, and LINT_REQUIRE_TERRAFORM=1"
else
  skip "terraform checks skipped: not on PATH; CI runs them"
fi

if [ "$failures" -gt 0 ]; then
  echo "lint: $failures of $checked file(s) failed" >&2
  exit 1
fi
echo "lint: $checked file(s) ok${skipped:+ ($skipped)}"
