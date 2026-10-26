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
# JavaScript gets `node --check`, ES modules (.mjs) included, and so do extensionless files with
# a node shebang under the directories above (images/base/fabriek-evaluate,
# plugins/factory-loop/bin/factory-answer).
#
# It also fails when a generated skill is stale (`node scripts/build-skills.js --check`), when the
# factory event docs, version lock or shapes are stale or a schema breaks the authoring or bump
# rules (`node scripts/build-event-docs.js --check`), when a factory database migration is not
# expand-only (`node scripts/migration-lint.js`; docs/factory-db.md "Schema compatibility"), when a
# file under plugins/factory-loop/hooks/ is over 600 lines (the size guard, scripts/size-guard.sh,
# whose allowlist is empty), when a tracked file uses a banned term (the list below), and runs terraform fmt and validate on coder/dev-system when
# terraform is on PATH.
#
# The per-file checks run in parallel through the test pool (scripts/lint-files.sh), sized by
# TEST_JOBS or the CPU count; failures print in file order whatever the size.
#
# Quiet on success: one summary line, which also names any check skipped on this host.
set -u

cd "$(dirname "$0")/.." || exit 1

SHELL_DIRS="images/base features/src/callum-tools features/test plugins/callum-flow/hooks plugins/factory-loop/bin plugins/factory-loop-workspace/bin coder scripts"
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

if ! command -v shellcheck >/dev/null 2>&1; then
  skip "shellcheck not on PATH, syntax checks only; CI runs shellcheck"
fi

# Files are checked in parallel through the test pool (scripts/lint-files.sh, scripts/lint-file.sh),
# TEST_JOBS or the CPU count at once; failures print in file order whatever the pool's size.
list=$(mktemp) || exit 1
results=$(mktemp -d) || exit 1
tf_tmp=""
cleanup() {
  rm -rf "$list" "$results" ${tf_tmp:+"$tf_tmp"}
}
trap cleanup EXIT

# The same two passes as ever: shell scripts by shebang, then .js/.mjs by extension.
# shellcheck disable=SC2086 # word-splitting the directory lists is intended
find $SHELL_DIRS -type f | sort > "$list"
counts=$(sh scripts/lint-files.sh "$list" "$results/shell") || exit $?
checked=$((checked + ${counts% *}))
failures=$((failures + ${counts#* }))

# shellcheck disable=SC2086 # word-splitting the directory list is intended
find $JS_DIRS -type f \( -name '*.js' -o -name '*.mjs' \) | sort > "$list"
counts=$(sh scripts/lint-files.sh "$list" "$results/js" --js) || exit $?
checked=$((checked + ${counts% *}))
failures=$((failures + ${counts#* }))

# Generated skills (scripts/build-skills.js) must match their source doc.
checked=$((checked + 1))
# Its success line goes nowhere; a stale skill is reported on stderr.
if ! node scripts/build-skills.js --check > /dev/null; then
  fail "generated skills out of date (run npm run build:skills)"
fi

# Factory event docs, version lock and shapes (scripts/build-event-docs.js) must match their
# schemas, and the schemas must keep the authoring and bump rules. It prints one line per problem.
checked=$((checked + 1))
if ! node scripts/build-event-docs.js --check > /dev/null; then
  fail "factory event docs out of date or schemas invalid (see above; run npm run build:events)"
fi

# Factory database migrations must be expand-only (scripts/migration-lint.js); its hits print
# on stderr as <file>:<line>: <what>.
checked=$((checked + 1))
if ! node scripts/migration-lint.js; then
  fail "images/base/factory-db/migrations: a migration that is not expand-only (see above; docs/factory-db.md)"
fi

# The factory loop's size guard (docs/factory-loop/v2/SPEC.md 2.5): no file under its hooks over
# 600 lines. No hooks file is over it now, so the allowlist (<file>:<cap>, each file capped at its
# size when listed) stays empty: a new oversized file is split, never listed.
HOOKS_DIR=plugins/factory-loop/hooks
HOOKS_MAX_LINES=600
HOOKS_OVERSIZED=""
checked=$((checked + 1))
# shellcheck disable=SC2086 # word-splitting the allowlist is intended
if ! sh scripts/size-guard.sh "$HOOKS_DIR" "$HOOKS_MAX_LINES" $HOOKS_OVERSIZED; then
  fail "$HOOKS_DIR: a file over $HOOKS_MAX_LINES lines or over its cap, or a stale entry of the size guard's allowlist"
fi

# Release notes (scripts/release-notes.js): every file valid, and notes for the package.json
# version, so a bump PR cannot pass ci without its notes.
checked=$((checked + 1))
if ! out=$(node scripts/release-notes.js --lint 2>&1); then
  fail "release notes invalid (run the release skill)"
  printf '%s\n' "$out" >&2
fi

# Banned words (owner, 2026-10-18): one label for findings is never used, in any tracked file.
# The pattern is split so this file does not match itself.
checked=$((checked + 1))
banned="sea""m[ -]bugs?"
if hits=$(git grep -n -i -E "$banned" -- . 2>/dev/null) && [ -n "$hits" ]; then
  fail "banned term \"sea""m bug\" (describe the finding in plain words instead):"
  printf '%s\n' "$hits" >&2
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
  cp "$TF_DIR"/*.tf "$TF_DIR"/*.tftest.hcl "$TF_DIR"/.terraform.lock.hcl "$TF_DIR"/wind-down.sh "$TF_DIR"/wind-down-start.sh "$tf_tmp"/
  TF_PLUGIN_CACHE_DIR=${TF_PLUGIN_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/terraform/plugin-cache}
  export TF_PLUGIN_CACHE_DIR
  mkdir -p "$TF_PLUGIN_CACHE_DIR"
  if ! out=$(terraform -chdir="$tf_tmp" init -backend=false -input=false -lockfile=readonly -no-color 2>&1); then
    fail "$TF_DIR (terraform init)"
    printf '%s\n' "$out" >&2
  elif ! out=$(terraform -chdir="$tf_tmp" validate -no-color 2>&1); then
    fail "$TF_DIR (terraform validate)"
    printf '%s\n' "$out" >&2
  elif ! out=$(terraform -chdir="$tf_tmp" test -no-color 2>&1); then
    fail "$TF_DIR (terraform test)"
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
