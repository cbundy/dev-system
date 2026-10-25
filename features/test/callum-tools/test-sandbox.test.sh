#!/bin/sh
#
# Tests for scripts/test-sandbox.sh (cbundy/dev-system#336): the sandbox that keeps `npm test`
# off the shared event log, and the check that fails a run when a suite writes to the defaults.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT="$SCRIPT_DIR/../../.."
EVENT="$ROOT/images/base/callum-flow-event"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Isolated from whatever sandbox an outer `npm test` exported: this suite makes its own.
outer_events=${CALLUM_EVENTS_DIR:-}
under_npm_test=${TEST_RESULTS_DIR:+1}

(
  . "$ROOT/scripts/test-sandbox.sh"
  test_sandbox_setup || fail "setup failed"
  trap test_sandbox_clean EXIT

  [ "$(printf '%s\n' "$CALLUM_EVENTS_DIR" "$AGENTSVIEW_DATA_DIR" | sort -u | wc -l)" -eq 2 ] || fail "two distinct dirs expected"
  for d in "$CALLUM_EVENTS_DIR" "$AGENTSVIEW_DATA_DIR"; do
    [ -d "$d" ] || fail "$d should exist"
    case "$d" in /persist/*) fail "$d must be outside /persist" ;; esac
    [ -z "$(ls -A "$d")" ] || fail "$d should start empty"
  done
  test_sandbox_check 2> /dev/null || fail "check should pass on an empty sandbox"

  # A real event write with no events dir of its own lands in the sandbox, and the check names it.
  env -u CALLUM_FLOW_EVENT_BIN "$EVENT" ready --issue 1 --repo o/r > /dev/null 2>&1 || fail "event write should succeed"
  [ -f "$CALLUM_EVENTS_DIR/factory/o__r.jsonl" ] || fail "event should land in the sandbox: $(ls -A "$CALLUM_EVENTS_DIR")"
  err=$(test_sandbox_check 2>&1) && fail "check should fail with a stray file"
  case "$err" in *"FAIL test isolation: $CALLUM_EVENTS_DIR/factory/o__r.jsonl"*) ;; *) fail "check should name the file: $err" ;; esac

  # Secrets folders point inside the sandbox at missing paths; the URL variables are gone.
  for d in "$DEV_SECRETS_DIR" "$DEV_WORKSPACE_SECRETS_DIR" "$DEV_MIGRATOR_SECRETS_DIR"; do
    case "$d" in "$TEST_SANDBOX"/*) ;; *) fail "secrets dir $d should be inside the sandbox" ;; esac
    [ ! -e "$d" ] || fail "secrets dir $d should not exist"
  done
  [ -z "${AGENTSVIEW_PG_URL:-}${FACTORY_DB_WRITER_URL:-}${FACTORY_DB_READER_URL:-}${FACTORY_DB_MIGRATOR_URL:-}" ] || fail "URL variables should be unset"

  sandbox=$TEST_SANDBOX
  test_sandbox_clean
  [ ! -e "$sandbox" ] || fail "clean should remove the sandbox"
  trap - EXIT
) || exit 1

# The psql tripwire: a fake psql records its calls; a seeded deny host is refused, any other passes.
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/bin" "$scratch/secrets"
# shellcheck disable=SC2016
printf '#!/bin/sh\necho "called $PGHOST $*" >> "%s/calls"\n' "$scratch" > "$scratch/bin/psql"
chmod +x "$scratch/bin/psql"
printf 'postgres://u:pw@denied.example:5432/x\n' > "$scratch/secrets/agentsview-pg-url"
(
  # shellcheck disable=SC2031
  PATH="$scratch/bin:$PATH"
  TEST_SANDBOX_DENY_HOSTS_FROM="$scratch/secrets"
  TEST_SANDBOX_GUARD="$ROOT/scripts/test-db-guard"
  AGENTSVIEW_PG_URL=postgres://u:pw@denied2.example/x
  export PATH TEST_SANDBOX_DENY_HOSTS_FROM TEST_SANDBOX_GUARD AGENTSVIEW_PG_URL
  . "$ROOT/scripts/test-sandbox.sh"
  test_sandbox_setup || fail "setup failed"
  trap test_sandbox_clean EXIT
  [ "$(stat -c %a "$TEST_SANDBOX/deny-hosts")" = 600 ] || fail "deny-hosts should be mode 600"
  ! grep -q -e pw -e '://' "$TEST_SANDBOX/deny-hosts" || fail "deny-hosts must hold hostnames only"

  refuse() { # NAME ARGS...: runs psql with a scrubbed env, expects a refusal
    name=$1; shift
    if env -i PATH="$PATH" "$@" > /dev/null 2>&1; then fail "$name should be refused"; fi
    [ ! -e "$scratch/calls" ] || fail "$name reached the real psql"
  }
  refuse url psql "postgres://u@denied.example/x" -c 'select 1'
  refuse env-url psql "postgresql://u@denied2.example/x"
  refuse PGHOST env PGHOST=denied.example psql -c 'select 1'
  refuse flag psql -h denied.example -c 'select 1'
  refuse longflag psql --host=denied.example -c 'select 1'
  refuse conninfo psql "host=denied.example dbname=x"
  refuse query-host psql "postgres:///x?host=denied.example"
  err=$(test_sandbox_check 2>&1) && fail "check should fail on a refusal"
  case "$err" in *"FAIL test isolation: non-test database denied.example ("*) ;; *) fail "check should name the host: $err" ;; esac
  case "$err" in *pw*) fail "check must not print a password: $err" ;; esac

  # An allowed host or a socket passes through to the real psql.
  env -i PATH="$PATH" psql "postgres://u@ok.example/x" > /dev/null 2>&1 || fail "allowed host should pass"
  env -i PATH="$PATH" psql -h /tmp/sock > /dev/null 2>&1 || fail "socket should pass"
  [ "$(wc -l < "$scratch/calls")" -eq 2 ] || fail "two calls should reach the real psql"

  # The real path: heartbeat-loop with a denied agentsview URL cannot reach its database.
  rm -f "$scratch/calls"
  mkdir "$scratch/hb" "$scratch/ev"
  : > "$scratch/versions"
  AGENTSVIEW_PG_URL=postgres://u@denied.example/x DEV_VERSIONS_FILE="$scratch/versions" DEV_HEARTBEAT_DIR="$scratch/hb" \
    CALLUM_EVENTS_DIR="$scratch/ev" bash "$ROOT/images/base/heartbeat-loop" --once > /dev/null 2>&1 || true
  # (heartbeat-loop's own `psql --version` probe is no connection.)
  ! grep -v -e ' --version$' "$scratch/calls" || fail "heartbeat-loop connected through the real psql"
  ls "$TEST_SANDBOX"/db-refused/* > /dev/null 2>&1 || fail "heartbeat-loop's refusal should be recorded"
  test_sandbox_clean
  trap - EXIT
) || exit 1

# Under `npm test` the run is sandboxed: the events dir is set and not the shared default.
if [ "$under_npm_test" = 1 ]; then
  [ -n "$outer_events" ] || fail "CALLUM_EVENTS_DIR should be set under npm test"
  case "$outer_events" in /persist/*) fail "CALLUM_EVENTS_DIR must not be under /persist: $outer_events" ;; esac
fi
echo "test-sandbox.test.sh ok"
