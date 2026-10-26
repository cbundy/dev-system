#!/bin/sh
#
# Plain-shell tests that a restarted watcher does not replay old events (cbundy/dev-system#344): queue-watch.
# Shared setup, stubs and wait helpers: watchers-lib.sh (read its header for the
# waiting rules: no fixed sleep as a wait, negative windows bounded by watcher
# progress). Split from the old watchers.test.sh (cbundy/dev-system#478).
set -eu

# shellcheck source=./watchers-lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/watchers-lib.sh"

# 15. Restarts do not replay old events (cbundy/dev-system#344).
real_event_log

# queue-watch: a restart with no baseline logs each issue once; a joiner after
# the first poll is logged even when the log already ends with its ready event
rm -f "$evlog"
for i in 1 2; do
  queue_seq 5,6
  # shellcheck disable=SC2086 # $qw is the command and its fixed options
  q=$(in_dir "$tmpdir" timeout 10 $qw) || fail "queue replay: did not exit 0"
  [ "$q" = "queue-changed known=none now=5,6" ] || fail "queue replay: printed '$q'"
done
[ "$(ev_count '"type":"ready"')" = 2 ] || fail "queue replay: want one ready line per issue: $(cat "$evlog")"
"$fakebin/fabriek-event" ready --issue 7
queue_seq 5 5,7
# shellcheck disable=SC2086 # $qw is the command and its fixed options
start_bg "$out" "$tmpdir" $qw --stream --known 5
wait_lines "$out" 1
wait_events '"issue":7' 2
stop_bg
[ "$(grep -c '"issue":7' "$evlog")" = 2 ] || fail "queue joiner: a seen joiner must be logged: $(cat "$evlog")"
rm "$fakebin/fabriek-event"
ok # queue-watch restarts do not replay ready events

echo "ok - $passed replay transition scenarios passed"
