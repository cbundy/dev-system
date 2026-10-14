#!/bin/sh
#
# Static check that the Coder template writes the worker's final heartbeat on a workspace
# stop (cbundy/dev-system#467): a stop grace on the container and a run_on_stop script.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
TF="$SCRIPT_DIR/../dev-system/main.tf"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

grep -Eq '^[[:space:]]*destroy_grace_seconds[[:space:]]*=[[:space:]]*30[[:space:]]*$' "$TF" ||
  fail "docker_container.workspace does not set destroy_grace_seconds = 30"

block=$(awk '/^resource "coder_script" "heartbeat_stop"/ { f = 1 } f { print } f && /^}/ { exit }' "$TF")
[ -n "$block" ] || fail "no coder_script \"heartbeat_stop\" resource"
printf '%s\n' "$block" | grep -Eq 'run_on_stop[[:space:]]*=[[:space:]]*true' || fail "heartbeat_stop is not run_on_stop"
printf '%s\n' "$block" | grep -q 'agent_id[[:space:]]*=[[:space:]]*coder_agent.main.id' || fail "heartbeat_stop is not on coder_agent.main"
printf '%s\n' "$block" | grep -q 'heartbeat-loop' || fail "heartbeat_stop does not call heartbeat-loop"
printf '%s\n' "$block" | grep -q -- '--final' || fail "heartbeat_stop does not pass --final"
printf '%s\n' "$block" | grep -q 'timeout 10' || fail "heartbeat_stop is not bounded by timeout 10"
echo "ok: template-stop"
