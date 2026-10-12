#!/bin/sh
#
# Plain-shell tests for orchestrator-watch.sh event flow (cbundy/dev-system#394): the single-shot window and rearm line, replay and catch-up.
# Shared setup, stubs and wait helpers: orchestrator-watch-lib.sh (read its
# header for the waiting rules). Split from the old orchestrator-watch.test.sh
# (cbundy/dev-system#478).
# shellcheck disable=SC2046,SC2086 # word-splitting of fixed option lists and pid lists is intended
set -eu

# shellcheck source=./orchestrator-watch-lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/orchestrator-watch-lib.sh"

# 2. Single-shot: exits 0 on the first event; the second event inside the
# window comes out in the same exit; the rearm line holds the carried
# baselines, and replaying it prints no event.
queue_seq 5
run_state RUNA feat/a parked aaa
runs_order RUNA
single="$tmpdir/s2.out"
# shellcheck disable=SC2086
(in_dir "$repo" timeout 30 env ORCHESTRATOR_WATCH_WINDOW=5 "$OW" $A \
  --queue-known none --pipeline-known feat/z=failed:zzz) > "$single" 2>/dev/null ||
  fail "single-shot did not exit 0"
grep -qx "parked feat/a RUNA head=aaa" "$single" || fail "single-shot pipeline line: $(cat "$single")"
grep -qx "queue-changed known=none now=5" "$single" || fail "single-shot queue line (window): $(cat "$single")"
rearm_line=$(tail -n 1 "$single")
[ "$(line_count "$single")" -eq 3 ] || fail "single-shot: want 2 events + rearm: $(cat "$single")"
case "$rearm_line" in
  "rearm --repo o/r --label ready --queue-interval 1 --pipeline-interval 1 --queue-known 5 --pipeline-known"*) ;;
  *) fail "rearm line: $rearm_line" ;;
esac
case "$rearm_line" in *"--pipeline-known feat/a=parked:aaa"*) ;; *) fail "rearm lacks feat/a: $rearm_line" ;; esac
case "$rearm_line" in *"--pipeline-known feat/z=failed:zzz"*) ;; *) fail "rearm lost the caller's baseline: $rearm_line" ;; esac
ok # single-shot: first event, window, rearm line

args=${rearm_line#rearm }
# The replay never re-delivers: the watcher runs until each child has polled
# (progress, not wall time, bounds the quiet window), and has
# printed nothing and not exited.
: > "$fakebin/nm-polls"
: > "$fakebin/gh-calls"
start_bg "$tmpdir/replay.out" "$repo" "$OW" $args
wait_lines "$fakebin/nm-polls" 2 # a re-delivered pipeline line comes on the first whole poll
wait_lines "$fakebin/gh-calls" 3 # a re-delivered queue line needs the second
alive "$bg_pid" || fail "replay exited: $(cat "$tmpdir/replay.out" "$tmpdir/replay.out.err")"
[ ! -s "$tmpdir/replay.out" ] || fail "replay re-delivered an event: $(cat "$tmpdir/replay.out")"
stop_bg
# and its deadline still ends it with timeout and a rearm line
replay=$(in_dir "$repo" timeout 30 "$OW" $args --deadline 2 2>&1) || fail "replay did not exit 0: $replay"
case "$replay" in
  "timeout
rearm "*) ;;
  *) fail "replay re-delivered an event: $replay" ;;
esac
ok # replaying the rearm line never re-delivers

# 8. Usage errors
st=0
d=$(in_dir "$repo" "$OW" --repo o/r) || st=$?
[ "$st" -eq 2 ] || fail "usage: exit $st"
case "$d" in "watcher-error usage"*) ;; *) fail "usage: $d" ;; esac
ok # usage error

# 11. A window that is not a whole number is a usage error.
st=0
w=$(in_dir "$repo" env ORCHESTRATOR_WATCH_WINDOW=1.5 "$OW" $A --stream 2>/dev/null) || st=$?
[ "$st" -eq 2 ] || fail "bad window: exit $st, want 2"
case "$w" in "watcher-error usage: ORCHESTRATOR_WATCH_WINDOW"*) ;; *) fail "bad window: $w" ;; esac
ok # ORCHESTRATOR_WATCH_WINDOW is validated

check_decoys

echo "ok - $passed orchestrator-watch scenarios passed"
