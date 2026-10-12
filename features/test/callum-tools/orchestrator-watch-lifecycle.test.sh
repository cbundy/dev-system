#!/bin/sh
#
# Plain-shell tests for orchestrator-watch.sh process lifecycle (cbundy/dev-system#394, #420): a fatal or exiting child, SIGTERM, the one-copy lock, and a killed child sleep.
# Shared setup, stubs and wait helpers: orchestrator-watch-lib.sh (read its
# header for the waiting rules). Split from the old orchestrator-watch.test.sh
# (cbundy/dev-system#478).
# shellcheck disable=SC2046,SC2086 # word-splitting of fixed option lists and pid lists is intended
set -eu

# shellcheck source=./orchestrator-watch-lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/orchestrator-watch-lib.sh"

# 5. A child fatal error: watcher-error, non-zero exit, nothing left behind.
# 5a. the real pipeline-watch with no-mistakes missing
queue_seq ""
mv "$fakebin/no-mistakes" "$fakebin/no-mistakes.off"
st=0
# shellcheck disable=SC2086
d=$(in_dir "$repo" timeout 30 "$OW" $A --stream) || st=$?
mv "$fakebin/no-mistakes.off" "$fakebin/no-mistakes"
[ "$st" -ne 0 ] || fail "fatal child: exited 0"
[ "$d" = "watcher-error pipeline: no-mistakes not on PATH" ] || fail "fatal child: $d"
ok # real child fatal error reported

# 5b. fake children: one prints watcher-error; another exits 0 quietly
reset_fakes
st=0
# shellcheck disable=SC2086
d=$(in_dir "$repo" env FAKE_MODE=error $(fake_env) timeout 30 "$OW" $A --stream 2>/dev/null) || st=$?
[ "$st" -ne 0 ] || fail "fake error child: exited 0"
case "$d" in "watcher-error "*": boom") ;; *) fail "fake error child: $d" ;; esac
reset_fakes
st=0
# shellcheck disable=SC2086
d=$(in_dir "$repo" env FAKE_MODE=exit0 $(fake_env) timeout 30 "$OW" $A --stream 2>/dev/null) || st=$?
[ "$st" -ne 0 ] || fail "child exit 0: wrapper exited 0"
case "$d" in "watcher-error "*": exited with status 0") ;; *) fail "child exit 0: $d" ;; esac
ok # a child exit or watcher-error is never silent

# 5c. the surviving sibling is stopped when the other dies: pipeline errors,
# queue is a fake sleeper
reset_fakes
st=0
mv "$fakebin/no-mistakes" "$fakebin/no-mistakes.off"
# shellcheck disable=SC2086
d=$(in_dir "$repo" env ORCHESTRATOR_WATCH_QUEUE_BIN="$tmpdir/fake/queue.sh" timeout 30 "$OW" $A --stream 2>/dev/null) || st=$?
mv "$fakebin/no-mistakes.off" "$fakebin/no-mistakes"
[ "$st" -ne 0 ] || fail "sibling: exited 0"
# shellcheck disable=SC2046
gone $(fake_pids)
ok # no surviving child after a child failure

# 6. SIGTERM: no output, no surviving child; a quiet child with stderr output
# is not taken for dead.
reset_fakes
out="$tmpdir/s6.out"
# shellcheck disable=SC2086
start_bg "$out" "$repo" env $(fake_env) "$OW" $A --stream
wait_fakes
# both children have said their one stderr line and gone quiet
wait_lines "$out.err" 2
alive "$bg_pid" || fail "a quiet child was taken for dead: $(cat "$out" "$out.err")"
grep -q "fake queue backoff" "$out.err" || fail "child stderr not passed through: $(cat "$out.err")"
fp=$(fake_pids)
kill -TERM "$bg_pid"
wait "$bg_pid" 2>/dev/null || true
bg_pid=
[ ! -s "$out" ] || fail "SIGTERM printed: $(cat "$out")"
# shellcheck disable=SC2086
gone $fp
ok # SIGTERM: quiet, children gone; stderr passes through

# 7. Never two copies; a lock left by a dead process is taken over.
reset_fakes
out="$tmpdir/s7.out"
# shellcheck disable=SC2086
start_bg "$out" "$repo" env $(fake_env) "$OW" $A --stream
first=$bg_pid
wait_fakes
st=0
# shellcheck disable=SC2086
second=$(in_dir "$repo" env $(fake_env) timeout 30 "$OW" $A --stream 2>/dev/null) || st=$?
[ "$st" -ne 0 ] || fail "second copy: exited 0"
# the first copy is the env/sh exec chain, so its pid is the watcher's own
[ "$second" = "watcher-error already-running pid=$first" ] || fail "second copy: '$second' (first=$first)"
alive "$first" || fail "refused copy stopped the first"
orphans=$(fake_pids)
kill -9 "$first"
wait "$first" 2>/dev/null || true
bg_pid=
# the first copy's children outlive a kill -9; clear them so the next copy's are distinguishable
# shellcheck disable=SC2086
kill -9 $orphans 2>/dev/null || true
reset_fakes
out2="$tmpdir/s7b.out"
# shellcheck disable=SC2086
start_bg "$out2" "$repo" env $(fake_env) "$OW" $A --stream
wait_fakes
alive "$bg_pid" || fail "takeover: new copy died: $(cat "$out2" "$out2.err")"
[ ! -s "$out2" ] || fail "takeover printed: $(cat "$out2")"
[ "$(cat "$tmpdir/locks"/*/pid)" = "$bg_pid" ] || fail "lock not taken over"
fp=$(fake_pids)
stop_bg
# shellcheck disable=SC2086
gone $fp
[ -z "$(ls "$tmpdir/locks")" ] || fail "lock left behind: $(ls "$tmpdir/locks")"
ok # one copy per repository; stale lock taken over; lock released on exit

# 9. A child's sleep is killed: no watcher-error, the watcher lives, the later
# queue change still passes through. The queue already differs from the baseline,
# so the child's first poll leaves it pending and naps the 3s confirmation
# interval - the sleep that is killed - and the second poll fires the change.
queue_seq 5,6
: > "$fakebin/runs-order"
out="$tmpdir/s9.out"
start_bg "$out" "$repo" "$OW" --repo o/r --label ready --queue-interval 3 --pipeline-interval 62 --stream --queue-known 5
victim=$(find_sleep "$bg_pid" 3)
kill "$victim"
wait_lines "$out.err" 1 # it noticed, and says so
alive "$bg_pid" || fail "child sleep kill: watcher died: $(cat "$out" "$out.err")"
[ ! -s "$out" ] || fail "child sleep kill: stdout must stay empty: $(cat "$out")"
grep -q '^queue-watch.sh: sleep interrupted (status 143)' "$out.err" || fail "child sleep kill: stderr: $(cat "$out.err")"
[ "$(line_count "$out.err")" -eq 1 ] || fail "child sleep kill: extra stderr: $(cat "$out.err")"
wait_lines "$out" 1
expect_lines "$out" "queue-changed known=5 now=5,6"
[ "$(line_count "$out.err")" -eq 1 ] || fail "child sleep kill: extra stderr at the end: $(cat "$out.err")"
stop_bg
ok # a killed child sleep is survived

check_decoys

echo "ok - $passed orchestrator-watch lifecycle scenarios passed"
