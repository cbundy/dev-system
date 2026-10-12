#!/bin/sh
#
# Plain-shell tests for pipeline-watch.sh without --branches (cbundy/dev-system#134): the watch set is every branch with a run, re-read on every poll.
# Shared setup, stubs and wait helpers: watchers-lib.sh (read its header for the
# waiting rules: no fixed sleep as a wait, negative windows bounded by watcher
# progress). Split from the old watchers.test.sh (cbundy/dev-system#478).
set -eu

# shellcheck source=./watchers-lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/watchers-lib.sh"

# Handled baselines: feat/a parked, feat/b merge-ready.
run_state RUNA feat/a parked aaa
run_state RUNB feat/b running "$b_head"
echo "all CI checks passed" > "$nm_home/logs/RUNB/ci.log"

# 5. No --branches (cbundy/dev-system#134): the watch set is every branch
# with a run, re-read on every poll. A run that appears later - here two
# that failed at launch, with no log directory - is still reported: one
# resolved to its id through its branch's worktree, one with no source for
# its id reported as "unknown".
g -C "$repo" worktree add -q -b feat/c "$tmpdir/wt-c"
start_bg "$out" "$repo" "$PIPELINE_WATCH" --stream --interval 1 \
  --known feat/a=parked:aaa --known "feat/b=merge-ready:$b_head"
wait_polls "$fakebin/nm-polls" 2 # handled runs would re-fire within one whole poll
[ "$(line_count "$out")" -eq 0 ] || fail "handled runs re-fired: $(cat "$out")"
run_state RUNC feat/c failed ccc
runs_order RUNC RUNB RUNA
wait_lines "$out" 1
run_state RUND feat/d failed ddd
runs_order RUND RUNC RUNB RUNA
wait_lines "$out" 2
wait_polls "$fakebin/nm-polls" 2 # nothing else fires, and the first two do not repeat
stop_bg
expect_lines "$out" "failed feat/c RUNC head=ccc
failed feat/d unknown head=ddd"
ok # no --branches: new runs and launch failures watched

echo "ok - $passed pipeline-watch discovery scenarios passed"
