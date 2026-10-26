#!/bin/sh
# Sourced by scripts/test.sh (cbundy/dev-system#336): keeps `npm test` away from the shared,
# persistent state directories (the factory event log, agentsview).
#
#   test_sandbox_setup   one temp sandbox; exports CALLUM_EVENTS_DIR and AGENTSVIEW_DATA_DIR,
#                        each an empty dir inside it
#   test_sandbox_check   prints `FAIL test isolation: <file>` per stray entry; non-zero if any
#   test_sandbox_clean   removes the sandbox
#
# It also keeps a test off the workspace's real databases: the secrets folders point at a missing
# path, the database URL variables are unset, and a `psql` guard (scripts/test-db-guard) first on
# PATH refuses, and records, a connection to a host of the real configured URLs - which still
# catches a test that scrubs its env and falls back to a hard-coded default
# (cbundy/dev-system#1056). test_sandbox_check fails the run on such a record.
#
# The sandbox stays writable on purpose: fabriek-event warns and exits 0 when a write fails,
# so a read-only stand-in would hide a leak instead of catching it. Nothing assumes /persist.

# _tsb_deny_hosts: the hosts of the real database URLs, from the environment and secret files as
# they are before the scrub. Never prints a URL.
_tsb_deny_hosts() {
  {
    printenv AGENTSVIEW_PG_URL FACTORY_DB_WRITER_URL FACTORY_DB_READER_URL FACTORY_DB_MIGRATOR_URL
    for _tsb_d in "${DEV_SECRETS_DIR:-}" /run/secrets/dev-system /run/secrets/dev-system-workspace /run/secrets/dev-system-migrator "${TEST_SANDBOX_DENY_HOSTS_FROM:-}"; do
      [ -n "$_tsb_d" ] || continue
      for _tsb_f in agentsview-pg-url factory-db-writer-url factory-db-reader-url factory-db-migrator-url; do
        [ -r "$_tsb_d/$_tsb_f" ] && { cat -- "$_tsb_d/$_tsb_f"; echo; }
      done
    done
  } 2> /dev/null | sh "$_tsb_guard" --hosts | grep -v -e '^localhost$' -e '^127\.' -e '^::1$' -e '^/' || true
}

test_sandbox_setup() {
  # The guard script: beside this file, which test.sh sources from the repo root; a caller elsewhere
  # sets TEST_SANDBOX_GUARD.
  _tsb_guard=${TEST_SANDBOX_GUARD:-$(pwd)/scripts/test-db-guard}
  TEST_SANDBOX=$(mktemp -d) || return 1
  _tsb_real=$(command -v psql 2> /dev/null) || _tsb_real=
  if [ -n "$_tsb_real" ]; then
    mkdir -p "$TEST_SANDBOX/bin" || return 1
    _tsb_deny_hosts > "$TEST_SANDBOX/deny-hosts"
    chmod 600 "$TEST_SANDBOX/deny-hosts"
    {
      echo '#!/bin/sh'
      printf 'TEST_DB_GUARD_DENY=%s TEST_DB_GUARD_LOG=%s TEST_DB_GUARD_REAL=%s exec sh %s "$@"\n' \
        "'$TEST_SANDBOX/deny-hosts'" "'$TEST_SANDBOX/db-refused'" "'$_tsb_real'" "'$_tsb_guard'"
    } > "$TEST_SANDBOX/bin/psql"
    chmod 755 "$TEST_SANDBOX/bin/psql"
    PATH="$TEST_SANDBOX/bin:$PATH"
  fi
  CALLUM_EVENTS_DIR="$TEST_SANDBOX/events"
  AGENTSVIEW_DATA_DIR="$TEST_SANDBOX/agentsview"
  # Not created: a test never reads the host's secrets.
  DEV_SECRETS_DIR="$TEST_SANDBOX/no-secrets"
  DEV_WORKSPACE_SECRETS_DIR="$TEST_SANDBOX/no-workspace-secrets"
  DEV_MIGRATOR_SECRETS_DIR="$TEST_SANDBOX/no-migrator-secrets"
  unset AGENTSVIEW_PG_URL FACTORY_DB_WRITER_URL FACTORY_DB_READER_URL FACTORY_DB_MIGRATOR_URL
  mkdir -p "$CALLUM_EVENTS_DIR" "$AGENTSVIEW_DATA_DIR" || return 1
  export PATH TEST_SANDBOX CALLUM_EVENTS_DIR AGENTSVIEW_DATA_DIR DEV_SECRETS_DIR DEV_WORKSPACE_SECRETS_DIR DEV_MIGRATOR_SECRETS_DIR
}

test_sandbox_check() {
  _tsc_stray=$(find "$CALLUM_EVENTS_DIR" "$AGENTSVIEW_DATA_DIR" -mindepth 1 2>/dev/null)
  _tsc_refused=$(cat "$TEST_SANDBOX"/db-refused/* 2> /dev/null || true)
  [ -z "$_tsc_stray$_tsc_refused" ] && return 0
  [ -z "$_tsc_stray" ] || printf '%s\n' "$_tsc_stray" | sed 's/^/FAIL test isolation: /'  >&2
  [ -z "$_tsc_refused" ] || printf '%s\n' "$_tsc_refused" | sed 's/^/FAIL test isolation: non-test database /' >&2
  return 1
}

test_sandbox_clean() {
  [ -n "${TEST_SANDBOX:-}" ] && rm -rf "$TEST_SANDBOX"
}
