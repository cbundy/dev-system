#!/bin/sh
#
# Plain-shell test for orchestrator-watch.sh catch-up (cbundy/dev-system#394): events that happen while nothing is armed are reported by the re-armed copy on its first poll.
# Shared setup, stubs and wait helpers: orchestrator-watch-lib.sh (read its
# header for the waiting rules). Split from the old orchestrator-watch.test.sh
# (cbundy/dev-system#478).
# shellcheck disable=SC2046,SC2086 # word-splitting of fixed option lists and pid lists is intended
set -eu

# shellcheck source=./orchestrator-watch-lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/orchestrator-watch-lib.sh"

# The arguments of a rearm line carrying the baselines of an earlier run: the
# queue at issue 5, feat/a parked at aaa.
args="--repo o/r --label ready --queue-interval 1 --pipeline-interval 1 --queue-known 5 --pipeline-known feat/a=parked:aaa"

# 3. Events while nothing is armed are reported by the re-armed copy on its
# first poll: a queue change and a pipeline transition.
queue_seq 5,6
run_state RUNA feat/a failed aaa
runs_order RUNA
# shellcheck disable=SC2086
caught=$(in_dir "$repo" timeout 30 env ORCHESTRATOR_WATCH_WINDOW=5 "$OW" $args) || fail "re-armed copy did not exit 0"
printf '%s\n' "$caught" | grep -qx "failed feat/a RUNA head=aaa" || fail "missed pipeline transition: $caught"
printf '%s\n' "$caught" | grep -qx "queue-changed known=5 now=5,6" || fail "missed queue change: $caught"
ok # events between exit and re-arm are caught up

check_decoys

echo "ok - $passed orchestrator-watch catch-up scenarios passed"
