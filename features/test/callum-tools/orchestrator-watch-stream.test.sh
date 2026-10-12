#!/bin/sh
#
# Plain-shell tests for orchestrator-watch.sh stream mode (cbundy/dev-system#394): both children passed through once, and a stream that survives an event until its deadline.
# Shared setup, stubs and wait helpers: orchestrator-watch-lib.sh (read its
# header for the waiting rules). Split from the old orchestrator-watch.test.sh
# (cbundy/dev-system#478).
# shellcheck disable=SC2046,SC2086 # word-splitting of fixed option lists and pid lists is intended
set -eu

# shellcheck source=./orchestrator-watch-lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/orchestrator-watch-lib.sh"

# 1. Stream: one queue change and one pipeline state both come out once,
# unchanged, and a quiet period adds nothing.
queue_seq 5
run_state RUNA feat/a parked aaa
runs_order RUNA
out="$tmpdir/s1.out"
# shellcheck disable=SC2086 # $A is a fixed option list
start_bg "$out" "$repo" "$OW" $A --stream --queue-known none
wait_lines "$out" 2
# a quiet period adds nothing: wait for whole polls of both children (a
# repeated queue line needs two more queue polls to be confirmed)
nm_mark=$(line_count "$fakebin/nm-polls")
gh_mark=$(line_count "$fakebin/gh-calls")
wait_lines "$fakebin/nm-polls" $((nm_mark + 2))
wait_lines "$fakebin/gh-calls" $((gh_mark + 3))
stop_bg
sort "$out" > "$out.sorted"
expect_lines "$out.sorted" "parked feat/a RUNA head=aaa
queue-changed known=none now=5"
ok # stream passes both children's lines through once

# 4b. Stream mode survives the first event: it keeps printing until the deadline.
queue_seq 8
: > "$fakebin/runs-order"
# shellcheck disable=SC2086
d=$(in_dir "$repo" timeout 30 "$OW" $A --stream --deadline 6 --queue-known none) || fail "stream deadline: did not exit 0: $d"
[ "$d" = "queue-changed known=none now=8
timeout
rearm --repo o/r --label ready --stream --deadline 6 --queue-interval 1 --pipeline-interval 1 --queue-known 8" ] ||
  fail "stream with event then deadline: $d"
ok # stream mode carries baselines across events

check_decoys

echo "ok - $passed orchestrator-watch stream scenarios passed"
