#!/bin/sh
#
# Plain-shell tests that a restarted watcher does not replay old events (cbundy/dev-system#344): an observed transition, and queue-watch.
# Shared setup, stubs and wait helpers: watchers-lib.sh (read its header for the
# waiting rules: no fixed sleep as a wait, negative windows bounded by watcher
# progress). Split from the old watchers.test.sh (cbundy/dev-system#478).
set -eu

# shellcheck source=./watchers-lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/watchers-lib.sh"

# 15. Restarts do not replay old events (cbundy/dev-system#344).
real_event_log

# an observed transition is logged: parked, running (quiet), parked on the same head
rm -f "$evlog"
mkdir -p "$nm_home/logs/RUNP"
run_state RUNP feat/issue-150-p parked 4444444444444444444444444444444444444444
runs_order RUNP
start_bg "$out" "$repo" "$PIPELINE_WATCH" --stream --interval 1 --branches feat/issue-150-p
wait_lines "$out" 1
run_state RUNP feat/issue-150-p running 4444444444444444444444444444444444444444
wait_polls "$fakebin/nm-polls" 2 # the watcher has seen it leave the parked state
run_state RUNP feat/issue-150-p parked 4444444444444444444444444444444444444444
wait_lines "$out" 2
wait_events '"state":"parked"' 2
stop_bg
[ "$(ev_count '"state":"parked"')" = 2 ] || fail "transition: want two parked lines: $(cat "$evlog")"
start_bg "$out" "$repo" "$PIPELINE_WATCH" --stream --interval 1 --branches feat/issue-150-p
wait_lines "$out" 1
wait_polls "$fakebin/nm-polls" 2 # a replayed parked line is logged by the end of the next whole poll
stop_bg
[ "$(ev_count '"state":"parked"')" = 2 ] || fail "transition: a restart added a parked line: $(cat "$evlog")"
ok # pipeline-watch: an observed transition is logged, a restart does not replay it

# queue-watch: a restart with no baseline logs each issue once; a joiner after
# the first poll is logged even when the log already ends with its ready event
rm -f "$evlog"
for i in 1 2; do
  queue_seq 5,6
  # shellcheck disable=SC2086 # $qw is the command and its fixed options
  q=$(in_dir "$tmpdir" timeout 10 $qw) || fail "queue replay: did not exit 0"
  [ "$q" = "queue-changed known=none now=5,6" ] || fail "queue replay: printed '$q'"
done
[ "$(ev_count '"state":"ready"')" = 2 ] || fail "queue replay: want one ready line per issue: $(cat "$evlog")"
"$fakebin/callum-flow-event" ready --issue 7
queue_seq 5 5,7
# shellcheck disable=SC2086 # $qw is the command and its fixed options
start_bg "$out" "$tmpdir" $qw --stream --known 5
wait_lines "$out" 1
wait_events '"issue":7' 2
stop_bg
[ "$(grep -c '"issue":7' "$evlog")" = 2 ] || fail "queue joiner: a seen joiner must be logged: $(cat "$evlog")"
rm "$fakebin/callum-flow-event"
ok # queue-watch restarts do not replay ready events

echo "ok - $passed replay transition scenarios passed"
