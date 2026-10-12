#!/bin/sh
#
# Plain-shell test that queue-watch.sh survives a killed sleep (cbundy/dev-system#420).
# Shared setup, stubs and wait helpers: watchers-lib.sh (read its header for the
# waiting rules: no fixed sleep as a wait, negative windows bounded by watcher
# progress). Split from the old watchers.test.sh (cbundy/dev-system#478).
set -eu

# shellcheck source=./watchers-lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/watchers-lib.sh"

# ---------------------------------------------------------------------------
# A sleep killed from outside between polls is survived (cbundy/dev-system#420),
# and a signal to the watcher itself ends it at once with no orphan sleep.
# Owner rule: these tests kill ONLY PIDs they recorded - the watcher's own
# bg_pid, or its sleep child found with `pgrep -P <bg_pid> -x sleep`. Never by

# interrupted_lines <file>: how many "sleep interrupted" lines the file holds
interrupted_lines() { grep -c 'sleep interrupted' "$1" || :; }

# 16. queue-watch: kill its sleep. It lives on, says so once on stderr and
# nothing on stdout, waits out the original interval, and still reports a change.
rm -f "$fakebin/gh-calls"
queue_seq 305
# shellcheck disable=SC2086 # $qw is the command and its fixed options
start_bg "$out" "$tmpdir" $QUEUE_WATCH --repo o/r --label ready --interval 08 --stream --known 305
w=$bg_pid
victim=$(wait_sleep "$w")
kill "$victim"
wait_lines "$out.err" 1 # it noticed, and says so
alive "$w" || fail "queue-watch died with its sleep: $(cat "$out" "$out.err")"
[ "$(interrupted_lines "$out.err")" = 1 ] || fail "queue sleep kill: want one stderr line: $(cat "$out.err")"
[ "$(line_count "$out.err")" -eq 1 ] || fail "queue sleep kill: extra stderr: $(cat "$out.err")"
grep -q '^queue-watch.sh: sleep interrupted (status 143), sleeping the remaining [0-9]*s$' "$out.err" ||
  fail "queue sleep kill: stderr shape: $(cat "$out.err")"
[ ! -s "$out" ] || fail "queue sleep kill: stdout must stay empty: $(cat "$out")"
queue_seq 305,307
wait_lines "$fakebin/gh-calls" 2
wait_lines "$out" 1
expect_lines "$out" "queue-changed known=305 now=305,307"
first_call=$(sed -n 1p "$fakebin/gh-calls")
second_call=$(sed -n 2p "$fakebin/gh-calls")
[ $((second_call - first_call)) -ge 8 ] ||
  fail "queue sleep kill shortened the wait: polls at $first_call and $second_call"
third_call=$(sed -n 3p "$fakebin/gh-calls")
[ $((third_call - second_call)) -ge 8 ] ||
  fail "queue confirmation shortened the wait: polls at $second_call and $third_call"
# nothing more on stderr over the whole run, which spans three polls
[ "$(line_count "$out.err")" -eq 1 ] || fail "queue sleep kill: extra stderr at the end: $(cat "$out.err")"
stop_bg
ok # queue-watch survives a killed sleep and keeps the interval

echo "ok - $passed queue sleep-kill scenarios passed"
