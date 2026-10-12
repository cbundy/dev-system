#!/bin/sh
#
# Plain-shell tests for queue-watch.sh stream mode: one line per confirmed change, the baseline carried forward (cbundy/dev-system#54, #123).
# Shared setup, stubs and wait helpers: watchers-lib.sh (read its header for the
# waiting rules: no fixed sleep as a wait, negative windows bounded by watcher
# progress). Split from the old watchers.test.sh (cbundy/dev-system#478).
set -eu

# shellcheck source=./watchers-lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/watchers-lib.sh"

# 11. Stream: one line per confirmed change, `now` carried forward as the new
# baseline, no repeats, an emptied queue reported as none.
queue_seq 305 305,307
# shellcheck disable=SC2086 # $qw is the command and its fixed options
start_bg "$out" "$tmpdir" $qw --stream --known 305
wait_lines "$out" 1
wait_polls "$fakebin/gh-calls" 3 # a repeat would show within two whole polls
expect_lines "$out" "queue-changed known=305 now=305,307"
queue_seq ""
wait_lines "$out" 2
wait_polls "$fakebin/gh-calls" 3
expect_lines "$out" "queue-changed known=305 now=305,307
queue-changed known=305,307 now=none"
stop_bg
ok # stream queue: one line per change, baseline carried forward

echo "ok - $passed queue-watch stream scenarios passed"
