#!/bin/sh
#
# Plain-shell tests for orchestrator-watch.sh --deadline (cbundy/dev-system#394, #420): timeout plus rearm in both modes, a killed timer sleep, and a leading-zero deadline.
# Shared setup, stubs and wait helpers: orchestrator-watch-lib.sh (read its
# header for the waiting rules). Split from the old orchestrator-watch.test.sh
# (cbundy/dev-system#478).
# shellcheck disable=SC2046,SC2086 # word-splitting of fixed option lists and pid lists is intended
set -eu

# shellcheck source=./orchestrator-watch-lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/orchestrator-watch-lib.sh"

# 4. --deadline in both modes: timeout plus rearm, exit 0.
queue_seq ""
: > "$fakebin/runs-order"
for mode in "" --stream; do
  # shellcheck disable=SC2086
  d=$(in_dir "$repo" timeout 30 "$OW" $A $mode --deadline 1) || fail "deadline ${mode:-single-shot}: did not exit 0: $d"
  [ "$d" = "timeout
rearm --repo o/r --label ready${mode:+ $mode} --deadline 1 --queue-interval 1 --pipeline-interval 1 --queue-known none" ] ||
    fail "deadline ${mode:-single-shot}: $d"
done
ok # --deadline gives timeout + rearm in both modes

# 10. The deadline timer's sleep is killed: timeout and rearm still print, and
# not before the deadline. The deadline (4s) differs from every interval, so the
# timer's `sleep 4` is told apart from the children's sleeps.
queue_seq 5
out="$tmpdir/s10.out"
t0=$(date +%s)
start_bg "$out" "$repo" "$OW" --repo o/r --label ready --queue-interval 61 --pipeline-interval 62 --stream --queue-known 5 --deadline 04
victim=$(find_sleep "$bg_pid" 4)
kill "$victim"
wait_lines "$out.err" 1 # it noticed, and says so
alive "$bg_pid" || fail "timer sleep kill: watcher died: $(cat "$out" "$out.err")"
wait_lines "$out" 2
[ $(($(date +%s) - t0)) -ge 4 ] || fail "timer sleep kill: deadline came early"
expect_lines "$out" "timeout
rearm --repo o/r --label ready --stream --deadline 04 --queue-interval 61 --pipeline-interval 62 --queue-known 5"
grep -q '^orchestrator-watch.sh: sleep interrupted' "$out.err" || fail "timer sleep kill: stderr: $(cat "$out.err")"
[ "$(line_count "$out.err")" -eq 1 ] || fail "timer sleep kill: extra stderr: $(cat "$out.err")"
wait "$bg_pid" || fail "timer sleep kill: did not exit 0"
bg_pid=
ok # a killed timer sleep still delivers the deadline

# 10b. A deadline with a leading zero that is not valid octal ("08") is read as
# 8: the timer's sleep is `sleep 8`. Seeing it is enough, so this does not wait
# the deadline out.
out="$tmpdir/s10b.out"
start_bg "$out" "$repo" "$OW" --repo o/r --label ready --queue-interval 61 --pipeline-interval 62 --stream --queue-known 5 --deadline 08
find_sleep "$bg_pid" 8 > /dev/null
alive "$bg_pid" || fail "leading-zero deadline: watcher died: $(cat "$out" "$out.err")"
stop_bg
ok # a leading-zero deadline is read as decimal

check_decoys

echo "ok - $passed orchestrator-watch deadline scenarios passed"
