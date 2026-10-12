#!/bin/sh
#
# Plain-shell tests that a restarted watcher does not replay old events (cbundy/dev-system#344).
# Shared setup, stubs and wait helpers: watchers-lib.sh (read its header for the
# waiting rules: no fixed sleep as a wait, negative windows bounded by watcher
# progress). Split from the old watchers.test.sh (cbundy/dev-system#478).
set -eu

# shellcheck source=./watchers-lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/watchers-lib.sh"

# 15. Restarts do not replay old events (cbundy/dev-system#344).
real_event_log

# a branch whose newest run was cancelled, and one that failed at launch with
# no run id (the #147 shape); both are still terminal when the watcher starts
mkdir -p "$nm_home/logs/RUNX" "$nm_home/logs/RUNY"
run_state RUNX fix/issue-181-x failed 1111111111111111111111111111111111111111
sed -i 's/^  status: failed/  status: cancelled/' "$fakebin/runs/RUNX.txt"
run_state RUNY feat/issue-147-y failed 2222222222222222222222222222222222222222
runs_order RUNX RUNY
single_out() { (in_dir "$repo" timeout 10 "$PIPELINE_WATCH" --interval 1 --branches "$1"); }
first=$(single_out fix/issue-181-x) || fail "replay: first run did not exit 0"
case "$first" in "cancelled fix/issue-181-x "*) ;; *) fail "replay: printed '$first'" ;; esac
for i in 1 2 3; do
  again=$(single_out fix/issue-181-x) || fail "replay: restart did not exit 0"
  [ "$again" = "$first" ] || fail "replay: restart printed '$again', want '$first'"
done
[ "$(ev_count '"state":"failed"')" = 1 ] || fail "replay: want one failed line, got: $(cat "$evlog")"
second=$(single_out feat/issue-147-y) || fail "replay: #147 did not exit 0"
single_out feat/issue-147-y > /dev/null || fail "replay: #147 restart"
[ "$(grep -c '"branch":"feat/issue-147-y"' "$evlog")" = 1 ] || fail "replay: want one line for #147 ($second): $(cat "$evlog")"

# a changed fact is logged after a restart: the same branch, a new head
run_state RUNX fix/issue-181-x failed 3333333333333333333333333333333333333333
changed=$(single_out fix/issue-181-x) || fail "replay: changed head did not exit 0"
[ "$(grep -c '"branch":"fix/issue-181-x"' "$evlog")" = 2 ] || fail "replay: a new head must be logged ($changed): $(cat "$evlog")"

# stream: restarting with no baseline replays nothing
before=$(wc -l < "$evlog" | tr -d ' ')
for i in 1 2; do
  start_bg "$out" "$repo" "$PIPELINE_WATCH" --stream --interval 1 --branches fix/issue-181-x,feat/issue-147-y
  wait_lines "$out" 2
  wait_polls "$fakebin/nm-polls" 2 # any (wrongly) replayed event is logged by the end of the next whole poll
  stop_bg
done
[ "$(wc -l < "$evlog" | tr -d ' ')" = "$before" ] || fail "replay: stream restarts added events: $(cat "$evlog")"

ok # pipeline-watch single-shot and stream restarts do not replay old events

echo "ok - $passed replay scenarios passed"
