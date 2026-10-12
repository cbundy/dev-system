#!/bin/sh
#
# Plain-shell tests for pipeline-watch.sh ci-stalled (cbundy/dev-system#234).
# Shared setup, stubs and wait helpers: watchers-lib.sh (read its header for the
# waiting rules: no fixed sleep as a wait, negative windows bounded by watcher
# progress). Split from the old watchers.test.sh (cbundy/dev-system#478).
set -eu

# shellcheck source=./watchers-lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/watchers-lib.sh"

g -C "$repo" branch feat/s "$b_head"
g -C "$repo" push -q origin feat/s
run_state RUNS feat/s running "$b_head"
runs_order RUNS
mkdir -p "$nm_home/logs/RUNS"
slog="$nm_home/logs/RUNS/ci.log"
waiting="no CI checks reported yet, waiting for checks to register..."
# stalled_ci <seconds-old> <line>...: write ci.log and backdate it
stalled_ci() {
  age=$1
  shift
  printf '%s\n' "$@" > "$slog"
  touch -d "@$(($(date +%s) - age))" "$slog"
}
sw() {
  in_dir "$repo" timeout 10 env PIPELINE_WATCH_CI_GRACE=60 "$PIPELINE_WATCH" --interval 1 \
    --deadline 1 --branches feat/s "$@"
}
stalled_ci 120 "$waiting"
res=$(sw) || fail "ci-stalled no-workflow: did not exit 0"
[ "$res" = "ci-stalled feat/s RUNS reason=no-workflow head=$b_head" ] || fail "no-workflow: $res"
echo 2 > "$fakebin/gh-workflows"
res=$(sw) || fail "ci-stalled no-checks: did not exit 0"
[ "$res" = "ci-stalled feat/s RUNS reason=no-checks head=$b_head" ] || fail "no-checks: $res"
echo 0 > "$fakebin/gh-workflows"
res=$(sw) || fail "ci-stalled empty listing: did not exit 0"
[ "$res" = "ci-stalled feat/s RUNS reason=no-workflow head=$b_head" ] || fail "empty listing: $res"
rm "$fakebin/gh-workflows"
# --known suppresses the same head
res=$(sw --known "feat/s=ci-stalled:$b_head") || fail "ci-stalled known: did not exit 0"
[ "$res" = timeout ] || fail "ci-stalled with --known: $res"
# younger than the grace period
stalled_ci 5 "$waiting"
res=$(sw) || fail "ci-stalled young: did not exit 0"
[ "$res" = timeout ] || fail "ci.log younger than the grace: $res"
# checks registered since the waiting line
stalled_ci 120 "$waiting" "CI checks running, waiting for results..."
res=$(sw) || fail "ci-stalled running: did not exit 0"
[ "$res" = timeout ] || fail "ci.log moved past the waiting line: $res"
# GitHub reports a check
stalled_ci 120 "$waiting"
touch "$fakebin/gh-checks"
res=$(sw) || fail "ci-stalled checks: did not exit 0"
[ "$res" = timeout ] || fail "gh reports a check: $res"
rm "$fakebin/gh-checks"
# gh failing: nothing fires, no crash
touch "$fakebin/gh-fail"
res=$(sw) || fail "ci-stalled gh-fail: did not exit 0"
[ "$res" = timeout ] || fail "gh failing: $res"
rm "$fakebin/gh-fail"
# the grace variable is validated like --interval
st=0
res=$(in_dir "$repo" env PIPELINE_WATCH_CI_GRACE=abc "$PIPELINE_WATCH" --branches feat/s 2>&1) || st=$?
[ "$st" -eq 2 ] || fail "bad grace: exit $st"
case "$res" in *PIPELINE_WATCH_CI_GRACE*) ;; *) fail "bad grace message: $res" ;; esac
# stream: once per head, then merge-ready when checks pass
start_bg "$out" "$repo" env PIPELINE_WATCH_CI_GRACE=60 "$PIPELINE_WATCH" --stream --interval 1 --branches feat/s
wait_lines "$out" 1
wait_polls "$fakebin/nm-polls" 2 # a repeat of the line would show within one whole poll
expect_lines "$out" "ci-stalled feat/s RUNS reason=no-workflow head=$b_head"
echo "all CI checks passed" >> "$slog"
wait_lines "$out" 2
stop_bg
expect_lines "$out" "ci-stalled feat/s RUNS reason=no-workflow head=$b_head
merge-ready feat/s RUNS head=$b_head"

ok # ci-stalled: both reasons, grace, soft failures, fingerprint, then merge-ready

echo "ok - $passed ci-stalled scenarios passed"
