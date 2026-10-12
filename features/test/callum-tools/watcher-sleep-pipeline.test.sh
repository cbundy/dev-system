#!/bin/sh
#
# Plain-shell tests that pipeline-watch.sh survives a killed sleep (cbundy/dev-system#420), that a signal ends each watcher at once with no orphan sleep, and that a failing sleep stays fatal.
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

# 17. pipeline-watch: the same shape with a fake run that turns parked.
mkdir -p "$nm_home/logs/RUNQ"
run_state RUNQ feat/issue-160-q running 5555555555555555555555555555555555555555
runs_order RUNQ
start_bg "$out" "$repo" "$PIPELINE_WATCH" --stream --interval 08 --branches feat/issue-160-q
w=$bg_pid
victim=$(wait_sleep "$w")
kill "$victim"
wait_lines "$out.err" 1 # it noticed, and says so
alive "$w" || fail "pipeline-watch died with its sleep: $(cat "$out" "$out.err")"
[ "$(interrupted_lines "$out.err")" = 1 ] || fail "pipeline sleep kill: want one stderr line: $(cat "$out.err")"
[ "$(line_count "$out.err")" -eq 1 ] || fail "pipeline sleep kill: extra stderr: $(cat "$out.err")"
grep -q '^pipeline-watch.sh: sleep interrupted (status 143), sleeping the remaining [0-9]*s$' "$out.err" ||
  fail "pipeline sleep kill: stderr shape: $(cat "$out.err")"
[ ! -s "$out" ] || fail "pipeline sleep kill: stdout must stay empty: $(cat "$out")"
run_state RUNQ feat/issue-160-q parked 5555555555555555555555555555555555555555
wait_lines "$out" 1
case "$(cat "$out")" in "parked feat/issue-160-q "*) ;; *) fail "pipeline sleep kill: printed '$(cat "$out")'" ;; esac
[ "$(line_count "$out.err")" -eq 1 ] || fail "pipeline sleep kill: extra stderr at the end: $(cat "$out.err")"
stop_bg
ok # pipeline-watch survives a killed sleep

# 18. A signal to the watcher ends it within about a second (not after the
# 60s interval), prints no watcher-error, and leaves no sleep behind.
# term_case <label> <dir> <command...>
term_case() {
  label=$1
  shift
  start_bg "$out" "$@"
  w=$bg_pid
  victim=$(wait_sleep "$w")
  t0=$(date +%s)
  kill -TERM "$w"
  rc=0
  wait "$w" || rc=$?
  bg_pid=
  [ $(($(date +%s) - t0)) -le 2 ] || fail "$label: TERM took more than 2s to end the watcher"
  [ "$rc" -eq 143 ] || fail "$label: exit $rc, want 143"
  ! grep -q watcher-error "$out" || fail "$label: printed watcher-error: $(cat "$out")"
  gone "$victim" || fail "$label: orphan sleep $victim left behind"
}
run_state RUNQ feat/issue-160-q running 5555555555555555555555555555555555555555
queue_seq 305
# shellcheck disable=SC2086 # the command and its fixed options
term_case "queue stream" "$tmpdir" $QUEUE_WATCH --repo o/r --label ready --interval 60 --stream --known 305
# shellcheck disable=SC2086
term_case "queue single-shot" "$tmpdir" $QUEUE_WATCH --repo o/r --label ready --interval 60 --known 305
term_case "pipeline stream" "$repo" "$PIPELINE_WATCH" --interval 60 --stream --branches feat/issue-160-q
term_case "pipeline single-shot" "$repo" "$PIPELINE_WATCH" --interval 60 --branches feat/issue-160-q
ok # a signal ends each watcher at once, with no orphan sleep

# 19. A sleep that fails without a signal stays fatal (no hot loop), in
# stream mode with a watcher-error line.
printf '#!/bin/sh\nexit 1\n' > "$fakebin/sleep"
chmod +x "$fakebin/sleep"
st=0
(in_dir "$repo" timeout 10 "$PIPELINE_WATCH" --interval 1 --stream --branches feat/issue-160-q) > "$out" 2>/dev/null || st=$?
rm "$fakebin/sleep"
[ "$st" -eq 1 ] || fail "failing sleep (pipeline): exit $st, want 1"
expect_lines "$out" "watcher-error exited with status 1"
ok # a non-signal sleep failure stays fatal

echo "ok - $passed pipeline sleep scenarios passed"
