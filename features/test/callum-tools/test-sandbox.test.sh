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

  [ "$(printf '%s\n' "$CALLUM_EVENTS_DIR" "$NO_MISTAKES_HOME" "$NM_PUSH_STATE_DIR" "$AGENTSVIEW_DATA_DIR" | sort -u | wc -l)" -eq 4 ] || fail "four distinct dirs expected"
  for d in "$CALLUM_EVENTS_DIR" "$NO_MISTAKES_HOME" "$NM_PUSH_STATE_DIR" "$AGENTSVIEW_DATA_DIR"; do
    [ -d "$d" ] || fail "$d should exist"
    case "$d" in /persist/*) fail "$d must be outside /persist" ;; esac
    [ -z "$(ls -A "$d")" ] || fail "$d should start empty"
  done
  test_sandbox_check 2> /dev/null || fail "check should pass on an empty sandbox"

  # A real event write with no events dir of its own lands in the sandbox, and the check names it.
  env -u CALLUM_FLOW_EVENT_BIN "$EVENT" ready --issue 1 --repo o/r > /dev/null 2>&1 || fail "event write should succeed"
  [ -f "$CALLUM_EVENTS_DIR/o__r.jsonl" ] || fail "event should land in the sandbox: $(ls -A "$CALLUM_EVENTS_DIR")"
  err=$(test_sandbox_check 2>&1) && fail "check should fail with a stray file"
  case "$err" in *"FAIL test isolation: $CALLUM_EVENTS_DIR/o__r.jsonl"*) ;; *) fail "check should name the file: $err" ;; esac

  sandbox=$TEST_SANDBOX
  test_sandbox_clean
  [ ! -e "$sandbox" ] || fail "clean should remove the sandbox"
  trap - EXIT
) || exit 1

# Under `npm test` the run is sandboxed: the events dir is set and not the shared default.
if [ "$under_npm_test" = 1 ]; then
  [ -n "$outer_events" ] || fail "CALLUM_EVENTS_DIR should be set under npm test"
  case "$outer_events" in /persist/*) fail "CALLUM_EVENTS_DIR must not be under /persist: $outer_events" ;; esac
fi
echo "test-sandbox.test.sh ok"
