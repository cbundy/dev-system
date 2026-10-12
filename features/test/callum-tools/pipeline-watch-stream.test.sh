#!/bin/sh
#
# Plain-shell tests for pipeline-watch.sh stream mode (cbundy/dev-system#54, #123): one line per change, a re-entered actionable state is a new event, --known baselines, fatal errors.
# Shared setup, stubs and wait helpers: watchers-lib.sh (read its header for the
# waiting rules: no fixed sleep as a wait, negative windows bounded by watcher
# progress). Split from the old watchers.test.sh (cbundy/dev-system#478).
set -eu

# shellcheck source=./watchers-lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/watchers-lib.sh"

# 1. Stream: several branches; one line per change; no repeats while the
# state is unchanged; a second branch is still reported after the first
# fired; a fatal error is reported. (Transient failures: pipeline-watch-blips.)
run_state RUNA feat/a parked aaa
run_state RUNB feat/b running "$b_head"
start_bg "$out" "$repo" "$PIPELINE_WATCH" --stream --interval 1 --branches feat/a,feat/b
wait_lines "$out" 1
wait_polls "$fakebin/nm-polls" 2 # a repeat would show within one whole poll
expect_lines "$out" "parked feat/a RUNA head=aaa"
ok # one line per change, no repeats while unchanged

# feat/b goes green: still reported after feat/a fired
echo "all CI checks passed" > "$nm_home/logs/RUNB/ci.log"
wait_lines "$out" 2
expect_lines "$out" "parked feat/a RUNA head=aaa
merge-ready feat/b RUNB head=$b_head"
ok # second branch reported after the first fired

# a branch that leaves an actionable state and returns to it (parked again
# at a later gate, same head) is a new event
run_state RUNA feat/a running aaa
wait_polls "$fakebin/nm-polls" 2 # the watcher has seen it leave the parked state
run_state RUNA feat/a parked aaa
wait_lines "$out" 3
sed -n 3p "$out" | grep -qx "parked feat/a RUNA head=aaa" || fail "line 3: $(cat "$out")"
ok # re-park on the same head reported

# fatal: no-mistakes disappears -> one watcher-error line, non-zero exit
mv "$fakebin/no-mistakes" "$fakebin/no-mistakes.off"
wait_lines "$out" 4
if wait "$bg_pid"; then fail "stream exited 0 on a fatal error"; fi
bg_pid=
sed -n 4p "$out" | grep -qx "watcher-error no-mistakes not on PATH" || fail "line 4: $(cat "$out")"
[ "$(line_count "$out")" -eq 4 ] || fail "extra output after watcher-error: $(cat "$out")"
mv "$fakebin/no-mistakes.off" "$fakebin/no-mistakes"
ok # fatal error -> watcher-error and non-zero exit

# 2. Stream: --known seeds the baseline, so an already-handled state does
# not fire; the other branch still does.
start_bg "$out" "$repo" "$PIPELINE_WATCH" --stream --interval 1 --branches feat/a,feat/b \
  --known feat/a=parked:aaa
wait_lines "$out" 1
wait_polls "$fakebin/nm-polls" 2 # a re-fire of the known state would show within one whole poll
stop_bg
# (stopped by a signal, as a harness does: a normal end, no watcher-error)
expect_lines "$out" "merge-ready feat/b RUNB head=$b_head"
ok # --known seeds stream mode; a signal stops it quietly

# 3. Stream: fatal at start (outside a git repo) and --deadline rejected,
# both as one watcher-error line and a non-zero exit.
st=0
(in_dir "$tmpdir" "$PIPELINE_WATCH" --stream --branches feat/a) > "$out" 2>/dev/null || st=$?
[ "$st" -ne 0 ] || fail "outside a git repo: exited 0"
expect_lines "$out" "watcher-error not inside a git repository"
st=0
(in_dir "$repo" "$PIPELINE_WATCH" --stream --deadline 60 --branches feat/a) > "$out" 2>/dev/null || st=$?
[ "$st" -eq 2 ] || fail "--stream --deadline: exit $st, want 2"
grep -q "^watcher-error usage: --deadline is single-shot only" "$out" || fail "--deadline: $(cat "$out")"
ok # fatal at start and --deadline rejected

echo "ok - $passed pipeline-watch stream scenarios passed"
