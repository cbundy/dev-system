#!/bin/sh
# Sourced by scripts/test.sh (cbundy/dev-system#336): keeps `npm test` away from the shared,
# persistent state directories (the factory event log, the no-mistakes mirror, agentsview).
#
#   test_sandbox_setup   one temp sandbox; exports CALLUM_EVENTS_DIR, NO_MISTAKES_HOME,
#                        NM_PUSH_STATE_DIR and AGENTSVIEW_DATA_DIR, each an empty dir inside it
#   test_sandbox_check   prints `FAIL test isolation: <file>` per stray entry; non-zero if any
#   test_sandbox_clean   removes the sandbox
#
# The sandbox stays writable on purpose: callum-flow-event warns and exits 0 when a write fails,
# so a read-only stand-in would hide a leak instead of catching it. Nothing assumes /persist.

test_sandbox_setup() {
  TEST_SANDBOX=$(mktemp -d) || return 1
  CALLUM_EVENTS_DIR="$TEST_SANDBOX/events"
  NO_MISTAKES_HOME="$TEST_SANDBOX/no-mistakes"
  NM_PUSH_STATE_DIR="$TEST_SANDBOX/nm-push-state"
  AGENTSVIEW_DATA_DIR="$TEST_SANDBOX/agentsview"
  TEST_SANDBOX_ACTIVE=1
  mkdir -p "$CALLUM_EVENTS_DIR" "$NO_MISTAKES_HOME" "$NM_PUSH_STATE_DIR" "$AGENTSVIEW_DATA_DIR" || return 1
  export TEST_SANDBOX TEST_SANDBOX_ACTIVE CALLUM_EVENTS_DIR NO_MISTAKES_HOME NM_PUSH_STATE_DIR AGENTSVIEW_DATA_DIR
}

test_sandbox_check() {
  _tsc_stray=$(find "$CALLUM_EVENTS_DIR" "$NO_MISTAKES_HOME" "$NM_PUSH_STATE_DIR" "$AGENTSVIEW_DATA_DIR" -mindepth 1 2>/dev/null)
  [ -z "$_tsc_stray" ] && return 0
  printf '%s\n' "$_tsc_stray" | sed 's/^/FAIL test isolation: /' >&2
  return 1
}

test_sandbox_clean() {
  [ -n "${TEST_SANDBOX:-}" ] && rm -rf "$TEST_SANDBOX"
}
