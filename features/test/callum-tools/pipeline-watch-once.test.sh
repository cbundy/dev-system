#!/bin/sh
#
# Plain-shell tests for pipeline-watch.sh --once (docs/factory-loop/SPEC.md 3.4, DECISIONS D-20):
# one poll, one line per branch whose newest run is not completed, step= and pr= in the detail,
# actionable lines logged as a first sight, fatal errors as exit 1.
# Shared setup, stubs and wait helpers: watchers-lib.sh (read its header for the
# waiting rules). Every --once call here is a single bounded process, so no wait is needed.
set -eu

# shellcheck source=./watchers-lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/watchers-lib.sh"

# once [options]: one --once call from the gated repo, in a subshell (in_dir replaces its process).
once() {
  (in_dir "$repo" timeout 10 "$PIPELINE_WATCH" --once "$@")
}
# once_status <dir> [env assignments and options]: stdout to $out, stderr to $out.err, and the
# exit status in $st, for the calls that must fail.
once_status() {
  d=$1
  shift
  st=0
  (in_dir "$d" timeout 10 env "$@") > "$out" 2> "$out.err" || st=$?
}
# fail_step <run-id> <step>: the run's status table shows <step> as the failed one.
fail_step() {
  sed -i "s/^    review,completed,0,1\$/    $2,failed,1,1/" "$fakebin/runs/$1.txt"
}
# expect_fatal <label> <stderr line>: the last once_status call failed as --once must: exit 1,
# nothing on stdout, the reason on stderr.
expect_fatal() {
  if [ "$st" -ne 1 ] || [ -s "$out" ]; then fail "$1: exit $st, out $(cat "$out")"; fi
  grep -qxF "$2" "$out.err" || fail "$1: $(cat "$out.err")"
}
# set_status <run-id> <status>: the run's top-level status (cancelled, completed).
set_status() {
  sed -i "s/^  status: .*/  status: $2/" "$fakebin/runs/$1.txt"
}
# A stub callum-flow-event that records each call.
cat > "$fakebin/callum-flow-event" <<'EOF'
#!/bin/sh
echo "$*" >> "$(dirname "$0")/event-calls"
EOF
chmod +x "$fakebin/callum-flow-event"
calls="$fakebin/event-calls"

# 1. One call reports every branch whose newest run is not completed, in the runs' order (newest
# first): each actionable state with its detail, step= for parked and failed, pr= for every run
# with a PR (from the status, or from the runs row when no source knows the run), running for a
# run in flight, pending for one no source can place, and nothing for a completed run.
run_state RUNA feat/a parked aaa
run_pr RUNA 11
run_state RUNB feat/b running "$b_head"
run_pr RUNB 12
echo "all CI checks passed" > "$nm_home/logs/RUNB/ci.log"
for id in RUNR RUNC RUNX RUNM; do mkdir -p "$nm_home/logs/$id"; done
run_state RUNR feat/r running rrr
run_state RUNC feat/c failed ccc
fail_step RUNC test
run_state RUNX feat/x running xxx
set_status RUNX cancelled
run_pr RUNX 14
run_state RUNM feat/m running mmm
set_status RUNM completed
run_pr RUNM 15
run_state RUNF feat/f failed fff # failed at launch: no log directory, no worktree
run_pr RUNF 77
run_state RUNU feat/u running abcabc # no source knows its id either
runs_order RUNU RUNF RUNM RUNX RUNC RUNR RUNB RUNA
: > "$calls"
res=$(once) || fail "every state: did not exit 0"
[ "$res" = "pending feat/u unknown head=abcabc
failed feat/f unknown step=unknown pr=77 head=fff
cancelled feat/x RUNX pr=14 head=xxx
failed feat/c RUNC step=test head=ccc
running feat/r RUNR head=rrr
merge-ready feat/b RUNB pr=12 head=$b_head
parked feat/a RUNA step=review pr=11 head=aaa" ] || fail "every state: $res"
ok # one line per run in flight, with step= and pr=

# Actionable lines are logged as a first sight, with the note the watch modes log (no step= or
# pr=); running and pending are not logged.
expect_lines "$calls" "failed --branch feat/f --run unknown --head fff --note  --if-changed --actor watcher
failed --branch feat/x --run RUNX --head xxx --note cancelled --if-changed --actor watcher
failed --branch feat/c --run RUNC --head ccc --note  --if-changed --actor watcher
merge_ready --branch feat/b --run RUNB --head $b_head --note  --if-changed --actor watcher
parked --branch feat/a --run RUNA --head aaa --note  --if-changed --actor watcher"
ok # actionable lines logged as a first sight, with the watch modes' notes

# --branches restricts the set.
res=$(once --branches feat/a,feat/r) || fail "--branches: did not exit 0"
[ "$res" = "running feat/r RUNR head=rrr
parked feat/a RUNA step=review pr=11 head=aaa" ] || fail "--branches: $res"
ok # --branches filters --once

# 2. The green run's other outcomes: GitHub still computing mergeability, or gh failing, is
# pending; a conflict is reported with its PR.
echo "UNKNOWN UNKNOWN" > "$fakebin/pr-status.txt"
res=$(once --branches feat/b) || fail "unknown mergeability: did not exit 0"
[ "$res" = "pending feat/b RUNB pr=12 head=$b_head" ] || fail "unknown mergeability: $res"
echo "MERGEABLE CLEAN" > "$fakebin/pr-status.txt"
touch "$fakebin/gh-fail"
res=$(once --branches feat/b) || fail "gh failing: did not exit 0"
rm "$fakebin/gh-fail"
[ "$res" = "pending feat/b RUNB pr=12 head=$b_head" ] || fail "gh failing: $res"
echo "CONFLICTING DIRTY" > "$fakebin/pr-status.txt"
res=$(once --branches feat/b) || fail "conflict: did not exit 0"
echo "MERGEABLE CLEAN" > "$fakebin/pr-status.txt"
[ "$res" = "conflict feat/b RUNB pr=12 head=$b_head" ] || fail "conflict: $res"
ok # pending while mergeability is unknown, conflict with its PR

# A head-mismatch keeps its SHAs ahead of pr=.
g clone -q "$tmpdir/origin.git" "$tmpdir/wt-b" 2>/dev/null
g -C "$tmpdir/wt-b" checkout -q feat/b
g -C "$tmpdir/wt-b" commit -q --allow-empty -m ungated
wt_head=$(g -C "$tmpdir/wt-b" rev-parse HEAD)
res=$(once --branches feat/b --worktree "feat/b=$tmpdir/wt-b") || fail "head-mismatch: did not exit 0"
[ "$res" = "head-mismatch feat/b RUNB run=$b_head branch=$b_head worktree=$wt_head pr=12 head=$b_head" ] ||
  fail "head-mismatch: $res"
ok # head-mismatch detail, then pr=

# A ci-stalled run keeps its reason ahead of pr=.
mkdir -p "$nm_home/logs/RUNS"
run_state RUNS feat/s running "$b_head"
run_pr RUNS 16
printf '%s\n' "no CI checks reported yet, waiting for checks to register..." > "$nm_home/logs/RUNS/ci.log"
touch -d "@$(($(date +%s) - 120))" "$nm_home/logs/RUNS/ci.log"
runs_order RUNS RUNU RUNF RUNM RUNX RUNC RUNR RUNB RUNA
res=$(in_dir "$repo" timeout 10 env PIPELINE_WATCH_CI_GRACE=60 "$PIPELINE_WATCH" --once --branches feat/s) ||
  fail "ci-stalled: did not exit 0"
[ "$res" = "ci-stalled feat/s RUNS reason=no-workflow pr=16 head=$b_head" ] || fail "ci-stalled: $res"
ok # ci-stalled reason, then pr=

# 3. The real event log: a repeated --once adds nothing, a new head is logged again.
real_event_log
mkdir -p "$nm_home/logs/RUNI"
run_state RUNI feat/issue-201-i parked 5555555555555555555555555555555555555555
runs_order RUNI
for i in 1 2 3; do
  res=$(once) || fail "replay: did not exit 0"
  [ "$res" = "parked feat/issue-201-i RUNI step=review head=5555555555555555555555555555555555555555" ] ||
    fail "replay: $res"
done
[ "$(ev_count '"state":"parked"')" = 1 ] || fail "replay: want one parked line: $(cat "$evlog")"
run_state RUNI feat/issue-201-i parked 6666666666666666666666666666666666666666
once > /dev/null || fail "replay: new head did not exit 0"
[ "$(ev_count '"state":"parked"')" = 2 ] || fail "replay: a new head must be logged: $(cat "$evlog")"
grep -q 'step=' "$evlog" && fail "replay: the log must carry the watch modes' note: $(cat "$evlog")"
ok # repeated --once calls do not replay events

# 4. Fatal: exit 1, the reason on stderr, nothing on stdout, and no event (a failed source the
# caller reports itself).
cat > "$fakebin/callum-flow-event" <<'EOF'
#!/bin/sh
echo "$*" >> "$(dirname "$0")/event-calls"
EOF
: > "$calls"
mv "$fakebin/no-mistakes" "$fakebin/no-mistakes.off"
once_status "$repo" "$PIPELINE_WATCH" --once
mv "$fakebin/no-mistakes.off" "$fakebin/no-mistakes"
expect_fatal "no no-mistakes" "pipeline-watch.sh: no-mistakes not on PATH"
mv "$fakebin/gh" "$fakebin/gh.off"
once_status "$repo" "$PIPELINE_WATCH" --once
mv "$fakebin/gh.off" "$fakebin/gh"
expect_fatal "no gh" "pipeline-watch.sh: gh not on PATH"
once_status "$tmpdir" "$PIPELINE_WATCH" --once
expect_fatal "outside a repo" "pipeline-watch.sh: not inside a git repository"
touch "$fakebin/nm-fail"
once_status "$repo" "$PIPELINE_WATCH" --once
rm "$fakebin/nm-fail"
expect_fatal "failing runs listing" "pipeline-watch.sh: no-mistakes runs failed"
[ ! -s "$calls" ] || fail "a fatal --once logged: $(cat "$calls")"
ok # fatal errors exit 1 with the reason, log nothing

# No runs at all is an empty answer, not an error.
runs_order
res=$(once) || fail "no runs: did not exit 0"
[ -z "$res" ] || fail "no runs: $res"
ok # no runs, no lines

# 5. --once takes no option except --branches and --worktree. (With --stream named, the usage
# error is also reported as stream mode reports one: a watcher-error line on stdout.)
for opt in --stream "--known feat/a=parked:aaa" "--deadline 5" "--interval 1" "--resolve feat/a"; do
  # shellcheck disable=SC2086 # $opt is an option and its value
  once_status "$repo" "$PIPELINE_WATCH" --once $opt
  [ "$st" -eq 2 ] || fail "--once $opt: exit $st"
  [ "$opt" = --stream ] || [ ! -s "$out" ] || fail "--once $opt: printed $(cat "$out")"
  grep -q "^pipeline-watch.sh: --once takes no option except --branches and --worktree" "$out.err" ||
    fail "--once $opt: $(cat "$out.err")"
done
rm "$fakebin/callum-flow-event"
ok # conflicting options are usage errors

echo "ok - $passed pipeline-watch --once scenarios passed"
