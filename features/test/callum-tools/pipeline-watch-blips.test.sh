#!/bin/sh
#
# Plain-shell tests for pipeline-watch.sh stream mode under transient failures (cbundy/dev-system#54, #123): a no-mistakes failure and a gh failure are skipped, and a branch that re-enters an actionable state is a new event.
# Shared setup, stubs and wait helpers: watchers-lib.sh (read its header for the
# waiting rules: no fixed sleep as a wait, negative windows bounded by watcher
# progress). Split from the old watchers.test.sh (cbundy/dev-system#478).
set -eu

# shellcheck source=./watchers-lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/watchers-lib.sh"

# The watcher starts from handled baselines: feat/a parked at aaa and feat/b
# merge-ready, so the first polls print nothing (pipeline-watch-stream covers --known).
run_state RUNA feat/a parked aaa
run_state RUNB feat/b running "$b_head"
echo "all CI checks passed" > "$nm_home/logs/RUNB/ci.log"
start_bg "$out" "$repo" "$PIPELINE_WATCH" --stream --interval 1 --branches feat/a,feat/b \
  --known feat/a=parked:aaa --known "feat/b=merge-ready:$b_head"

# transient failure: nothing fires while no-mistakes fails, and the change
# made meanwhile is reported once it answers again
touch "$fakebin/nm-fail"
wait_polls "$fakebin/nm-polls" 2 # a poll has hit the failure
run_state RUNA feat/a failed aaa
wait_polls "$fakebin/nm-polls" 2 # and one whole poll after the change, still failing
[ "$(line_count "$out")" -eq 0 ] || fail "fired during a transient failure: $(cat "$out")"
rm "$fakebin/nm-fail"
wait_lines "$out" 1
sed -n 1p "$out" | grep -qx "failed feat/a RUNA head=aaa" || fail "line 1: $(cat "$out")"
ok # transient no-mistakes failure skipped

# a gh failure leaves merge-ready not-yet-known: no line, and no re-fire of
# the same merge-ready once gh answers again
touch "$fakebin/gh-fail"
wait_polls "$fakebin/nm-polls" 2 # the merge-ready probe has failed on whole polls
rm "$fakebin/gh-fail"
wait_polls "$fakebin/nm-polls" 2 # and gh answers again for one whole poll
[ "$(line_count "$out")" -eq 1 ] || fail "gh blip re-fired: $(cat "$out")"
ok # transient gh failure skipped, no repeat after it

stop_bg

echo "ok - $passed pipeline-watch blip scenarios passed"
