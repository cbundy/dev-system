#!/bin/sh
#
# Plain-shell tests for the watchers' stream mode and the queue watcher's
# debounce (cbundy/dev-system#54, #123). Like recover-no-mistakes.test.sh,
# this runs the scripts from their source location with stub `gh` and
# `no-mistakes` on PATH - no Docker, no container build - so `npm test` runs
# it anywhere. A one-second poll interval keeps it to seconds. The container
# suite (test.sh) keeps covering the single-shot states in depth.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
SRC="$SCRIPT_DIR/../../src/callum-tools"
PIPELINE_WATCH="$SRC/pipeline-watch.sh"
QUEUE_WATCH="$SRC/queue-watch.sh"

passed=0
fail() {
  echo "FAIL: $*" >&2
  exit 1
}
ok() {
  passed=$((passed + 1))
}

tmpdir=$(mktemp -d)
bg_pid=
cleanup() {
  stop_bg
  rm -rf "$tmpdir"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

fakebin="$tmpdir/bin"
toolbin="$tmpdir/tools"
mkdir -p "$fakebin" "$toolbin"
# A hermetic PATH: the stubs plus only the tools the scripts and stubs use,
# so a real gh or no-mistakes (the base image has both) can never answer.
for t in git awk sed ls head grep tr date sleep cat timeout env wc tail mv dirname cut stat sort paste; do
  p=$(command -v "$t") || fail "$t not found"
  ln -s "$p" "$toolbin/$t"
done
nm_home="$tmpdir/nm"

# in_dir <dir> <command...>: exec the command from dir with the stub PATH.
# Call it in a subshell: it changes directory and replaces the process.
in_dir() {
  cd "$1" || exit 1
  shift
  PATH="$fakebin:$toolbin"
  NO_MISTAKES_HOME="$nm_home"
  export PATH NO_MISTAKES_HOME
  exec "$@"
}

# start_bg <out-file> <dir> <command...>: run a stream watcher in the
# background; bg_pid is the watcher itself (the subshell execs it).
start_bg() {
  out=$1
  shift
  (in_dir "$@") > "$out" 2> "$out.err" &
  bg_pid=$!
}

# stop_bg: stop the background watcher and reap it.
stop_bg() {
  if [ -n "$bg_pid" ]; then
    kill "$bg_pid" 2>/dev/null || true
    wait "$bg_pid" 2>/dev/null || true
    bg_pid=
  fi
}

line_count() {
  wc -l < "$1" | tr -d ' '
}

# wait_lines <file> <n>: wait up to 15s until the file has at least n lines.
wait_lines() {
  i=0
  while [ "$(line_count "$1")" -lt "$2" ]; do
    i=$((i + 1))
    [ "$i" -le 75 ] || fail "timed out waiting for $2 line(s) in $1 - got: $(cat "$1")"
    sleep 0.2
  done
}

# expect_lines <file> <expected text>: the file holds exactly these lines.
expect_lines() {
  [ "$(cat "$1")" = "$2" ] || fail "expected:
$2
got:
$(cat "$1")"
}

# ---------------------------------------------------------------------------
# pipeline-watch.sh
#
# Stub no-mistakes, modelled on the real v1.84 output: `axi status --run
# <id>` prints runs/<id>.txt; `runs` prints one row per id in runs-order
# (newest first) - "  <status>  <branch> <short-head>  <date>", no run id;
# `axi status` with no --run prints the newest run of the cwd's branch, or,
# when that branch has none, the runs[N]{id,branch,status,head,pr} table.
# Every call fails while an nm-fail marker exists (a transient failure).
cat > "$fakebin/no-mistakes" <<'EOF'
#!/bin/sh
d=$(dirname "$0")
[ ! -e "$d/nm-fail" ] || exit 1
# row <id>: "<branch> <status> <short-head>" of a run
row() {
  f="$d/runs/$1.txt"
  b=$(sed -n 's/^  branch: //p' "$f")
  s=$(sed -n 's/^  status: //p' "$f")
  h=$(sed -n 's/^  head_sha: //p' "$f" | cut -c1-8)
  echo "$b $s ${h:--}"
}
order=$(cat "$d/runs-order" 2>/dev/null)
case "$1 ${2-} ${3-}" in
  "runs --limit "*)
    [ -n "$order" ] || { echo "  no runs yet."; exit 0; }
    for id in $order; do
      set -- $(row "$id")
      printf '  %-12s %s %s  2026-10-06 21:00\n' "$2" "$1" "$3"
    done
    ;;
  "axi status --run") cat "$d/runs/$4.txt" 2>/dev/null ;;
  "axi status ")
    cur=$(git rev-parse --abbrev-ref HEAD)
    for id in $order; do
      set -- $(row "$id")
      [ "$1" != "$cur" ] || exec cat "$d/runs/$id.txt"
    done
    echo "current_branch: $cur"
    [ ! -e "$d/no-table" ] || exit 0
    echo "runs[9]{id,branch,status,head,pr}:"
    for id in $order; do
      set -- $(row "$id")
      printf '  "%s",%s,%s,%s,""\n' "$id" "$1" "$2" "$3"
    done
    ;;
  *) exit 1 ;;
esac
EOF
# Stub gh: `pr view` prints pr-status.txt; fails while a gh-fail marker exists.
cat > "$fakebin/gh" <<'EOF'
#!/bin/sh
d=$(dirname "$0")
[ ! -e "$d/gh-fail" ] || exit 1
case "$1 $2" in
  "pr view") cat "$d/pr-status.txt" ;;
  "pr checks")
    # a gh-checks marker means the PR has a check; else gh's no-checks reply
    if [ -e "$d/gh-checks" ]; then echo "ci	pass	1m"; exit 0; fi
    echo "no checks reported on the '$3' branch" >&2
    exit 1
    ;;
  "api repos/{owner}/{repo}/contents/.github/workflows")
    # a gh-workflows marker holds the number of workflow files; else a 404
    if [ -e "$d/gh-workflows" ]; then cat "$d/gh-workflows"; exit 0; fi
    echo "gh: Not Found (HTTP 404)" >&2
    exit 1
    ;;
  "issue list")
    # queue-watch: pop the first line of queue-seq.txt (the last one
    # repeats); a FAIL line is a failed call
    f="$d/queue-seq.txt"
    line=$(sed -n 1p "$f")
    if [ "$(wc -l < "$f")" -gt 1 ]; then
      tail -n +2 "$f" > "$f.next" && mv "$f.next" "$f"
    fi
    [ "$line" != FAIL ] || exit 1
    echo "$line"
    ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$fakebin/no-mistakes" "$fakebin/gh"
mkdir -p "$fakebin/runs"
echo "MERGEABLE CLEAN" > "$fakebin/pr-status.txt"

mkdir -p "$nm_home/logs/RUNA" "$nm_home/logs/RUNB"
touch -d "2026-01-01 00:00" "$nm_home/logs/RUNA"
touch -d "2026-01-01 00:01" "$nm_home/logs/RUNB"
# runs_order <id>...: the runs `no-mistakes runs` lists, newest first
runs_order() {
  printf '%s\n' "$@" > "$fakebin/runs-order"
}
runs_order RUNB RUNA

# run_state <run-id> <branch> <running|parked|failed> [head-sha]
run_state() {
  {
    printf '%s\n' "current_branch: main" "other_branch_run:" "  id: \"$1\"" "  branch: $2"
    case "$3" in
      failed) echo "  status: failed" ;;
      *) echo "  status: running" ;;
    esac
    [ -z "${4-}" ] || echo "  head_sha: $4"
    echo "  steps[2]{step,status,findings,duration_ms}:"
    case "$3" in
      parked) echo "    review,awaiting_approval,1,1" ;;
      *) echo "    review,completed,0,1" ;;
    esac
    echo "    push,pending,0,0"
  } > "$fakebin/runs/$1.txt.next"
  mv "$fakebin/runs/$1.txt.next" "$fakebin/runs/$1.txt"
}

# The watcher runs inside the gated repo: a clone whose origin has feat/b.
g() { git -c user.name=t -c user.email=t@t -c init.defaultBranch=main "$@"; }
g init -q --bare "$tmpdir/origin.git"
g clone -q "$tmpdir/origin.git" "$tmpdir/repo" 2>/dev/null
g -C "$tmpdir/repo" checkout -q -b feat/b
g -C "$tmpdir/repo" commit -q --allow-empty -m gated
g -C "$tmpdir/repo" push -q origin feat/b
b_head=$(g -C "$tmpdir/repo" rev-parse HEAD)

repo="$tmpdir/repo"

# 1. Stream: several branches; one line per change; no repeats while the
# state is unchanged; a second branch is still reported after the first
# fired; a transient failure is skipped; a fatal error is reported.
run_state RUNA feat/a parked aaa
run_state RUNB feat/b running "$b_head"
out="$tmpdir/pw.out"
start_bg "$out" "$repo" "$PIPELINE_WATCH" --stream --interval 1 --branches feat/a,feat/b
wait_lines "$out" 1
sleep 3
expect_lines "$out" "parked feat/a RUNA head=aaa"
ok # one line per change, no repeats while unchanged

# feat/b goes green: still reported after feat/a fired
echo "all CI checks passed" > "$nm_home/logs/RUNB/ci.log"
wait_lines "$out" 2
expect_lines "$out" "parked feat/a RUNA head=aaa
merge-ready feat/b RUNB head=$b_head"
ok # second branch reported after the first fired

# transient failure: nothing fires while no-mistakes fails, and the change
# made meanwhile is reported once it answers again
touch "$fakebin/nm-fail"
sleep 1
run_state RUNA feat/a failed aaa
sleep 3
[ "$(line_count "$out")" -eq 2 ] || fail "fired during a transient failure: $(cat "$out")"
rm "$fakebin/nm-fail"
wait_lines "$out" 3
sed -n 3p "$out" | grep -qx "failed feat/a RUNA head=aaa" || fail "line 3: $(cat "$out")"
ok # transient no-mistakes failure skipped

# a gh failure leaves merge-ready not-yet-known: no line, and no re-fire of
# the same merge-ready once gh answers again
touch "$fakebin/gh-fail"
sleep 3
rm "$fakebin/gh-fail"
sleep 2
[ "$(line_count "$out")" -eq 3 ] || fail "gh blip re-fired: $(cat "$out")"
ok # transient gh failure skipped, no repeat after it

# a branch that leaves an actionable state and returns to it (parked again
# at a later gate, same head) is a new event
run_state RUNA feat/a running aaa
sleep 3
run_state RUNA feat/a parked aaa
wait_lines "$out" 4
sed -n 4p "$out" | grep -qx "parked feat/a RUNA head=aaa" || fail "line 4: $(cat "$out")"
ok # re-park on the same head reported

# fatal: no-mistakes disappears -> one watcher-error line, non-zero exit
mv "$fakebin/no-mistakes" "$fakebin/no-mistakes.off"
wait_lines "$out" 5
if wait "$bg_pid"; then fail "stream exited 0 on a fatal error"; fi
bg_pid=
sed -n 5p "$out" | grep -qx "watcher-error no-mistakes not on PATH" || fail "line 5: $(cat "$out")"
[ "$(line_count "$out")" -eq 5 ] || fail "extra output after watcher-error: $(cat "$out")"
mv "$fakebin/no-mistakes.off" "$fakebin/no-mistakes"
ok # fatal error -> watcher-error and non-zero exit

# 2. Stream: --known seeds the baseline, so an already-handled state does
# not fire; the other branch still does.
start_bg "$out" "$repo" "$PIPELINE_WATCH" --stream --interval 1 --branches feat/a,feat/b \
  --known feat/a=parked:aaa
wait_lines "$out" 1
sleep 2
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

# 4. Single-shot is unchanged: prints the first actionable line and exits 0;
# --deadline still gives the timeout heartbeat.
run_state RUNA feat/a parked aaa
single=$(in_dir "$repo" timeout 10 env PIPELINE_WATCH_INTERVAL=1 "$PIPELINE_WATCH" \
  --branches feat/a,feat/b) || fail "single-shot did not exit 0"
[ "$single" = "merge-ready feat/b RUNB head=$b_head" ] || fail "single-shot: $single"
single=$(in_dir "$repo" timeout 10 "$PIPELINE_WATCH" --interval 1 --deadline 1 --branches feat/quiet) ||
  fail "deadline: did not exit 0"
[ "$single" = timeout ] || fail "deadline: $single"
ok # single-shot unchanged

# 5. No --branches (cbundy/dev-system#134): the watch set is every branch
# with a run, re-read on every poll. A run that appears later - here two
# that failed at launch, with no log directory - is still reported: one
# resolved to its id through its branch's worktree, one with no source for
# its id reported as "unknown".
g -C "$repo" worktree add -q -b feat/c "$tmpdir/wt-c"
start_bg "$out" "$repo" "$PIPELINE_WATCH" --stream --interval 1 \
  --known feat/a=parked:aaa --known "feat/b=merge-ready:$b_head"
sleep 2
[ "$(line_count "$out")" -eq 0 ] || fail "handled runs re-fired: $(cat "$out")"
run_state RUNC feat/c failed ccc
runs_order RUNC RUNB RUNA
wait_lines "$out" 1
run_state RUND feat/d failed ddd
runs_order RUND RUNC RUNB RUNA
wait_lines "$out" 2
sleep 2
stop_bg
expect_lines "$out" "failed feat/c RUNC head=ccc
failed feat/d unknown head=ddd"
ok # no --branches: new runs and launch failures watched

# 6. --branches still restricts the set: the newer failed runs on other
# branches do not fire.
single=$(in_dir "$repo" timeout 10 "$PIPELINE_WATCH" --interval 1 --branches feat/b) ||
  fail "--branches: did not exit 0"
[ "$single" = "merge-ready feat/b RUNB head=$b_head" ] || fail "--branches: $single"
ok # --branches filters

# 7. From a checkout whose branch has no run, the run id comes from the
# `axi status` run table, so the run with no log directory and no worktree
# is reported with its id.
g -C "$repo" worktree add -q -b idle "$tmpdir/wt-idle"
single=$(in_dir "$tmpdir/wt-idle" timeout 10 "$PIPELINE_WATCH" --interval 1 --branches feat/d) ||
  fail "run table: did not exit 0"
[ "$single" = "failed feat/d RUND head=ddd" ] || fail "run table: $single"
ok # run id resolved from the run table

# 8. The worktree a branch is checked out in is found automatically: a
# local commit the green run never gated is a head-mismatch with no
# --worktree mapping.
g -C "$repo" worktree add -q -b feat/e "$tmpdir/wt-e"
g -C "$tmpdir/wt-e" push -q origin feat/e
run_state RUNE feat/e running "$b_head"
mkdir -p "$nm_home/logs/RUNE"
echo "all CI checks passed" > "$nm_home/logs/RUNE/ci.log"
runs_order RUNE RUND RUNC RUNB RUNA
single=$(in_dir "$repo" timeout 10 "$PIPELINE_WATCH" --interval 1 --branches feat/e) ||
  fail "auto worktree: did not exit 0"
[ "$single" = "merge-ready feat/e RUNE head=$b_head" ] || fail "auto worktree, in sync: $single"
g -C "$tmpdir/wt-e" commit -q --allow-empty -m "ungated"
e_head=$(g -C "$tmpdir/wt-e" rev-parse HEAD)
single=$(in_dir "$repo" timeout 10 "$PIPELINE_WATCH" --interval 1 --branches feat/e) ||
  fail "auto worktree: did not exit 0"
[ "$single" = "head-mismatch feat/e RUNE run=$b_head branch=$b_head worktree=$e_head head=$b_head" ] ||
  fail "auto worktree, ungated commit: $single"
ok # worktree mapped automatically

# 8b. --resolve <branch> (cbundy/dev-system#243): a one-shot lookup that
# prints the branch's newest run id alone, never polls and never records an
# event. A stub callum-flow-event records any call it gets.
cat > "$fakebin/callum-flow-event" <<'EOF'
#!/bin/sh
echo "$*" >> "$(dirname "$0")/event-calls"
EOF
chmod +x "$fakebin/callum-flow-event"
resolve() { in_dir "$1" timeout 10 "$PIPELINE_WATCH" --resolve "$2"; }

# from the branch's own worktree (its `axi status` run detail)
res=$(resolve "$tmpdir/wt-e" feat/e) || fail "--resolve worktree: did not exit 0"
[ "$res" = RUNE ] || fail "--resolve worktree: $res"
# from the run table, when the cwd branch has no run
res=$(resolve "$tmpdir/wt-idle" feat/d) || fail "--resolve table: did not exit 0"
[ "$res" = RUND ] || fail "--resolve table: $res"
# the newest of two runs on one branch
run_state RUNOLD feat/d failed old
runs_order RUNE RUND RUNC RUNB RUNA RUNOLD
res=$(resolve "$tmpdir/wt-idle" feat/d) || fail "--resolve newest: did not exit 0"
[ "$res" = RUND ] || fail "--resolve newest run: $res"
# from the log directories, when the table has nothing
touch "$fakebin/no-table"
mkdir -p "$nm_home/logs/RUND"
res=$(resolve "$tmpdir/wt-idle" feat/d) || fail "--resolve log directory: did not exit 0"
[ "$res" = RUND ] || fail "--resolve log directory: $res"
rm "$fakebin/no-table"
# no run: exit 1, nothing on stdout
st=0
res=$(resolve "$tmpdir/wt-idle" feat/none) || st=$?
if [ "$st" -ne 1 ] || [ -n "$res" ]; then fail "--resolve no run: exit $st, out '$res'"; fi
# a failing lookup: exit 1, nothing on stdout
touch "$fakebin/nm-fail"
st=0
res=$(resolve "$tmpdir/wt-idle" feat/d) || st=$?
rm "$fakebin/nm-fail"
if [ "$st" -ne 1 ] || [ -n "$res" ]; then fail "--resolve lookup failure: exit $st, out '$res'"; fi
# no other option
st=0
res=$(in_dir "$tmpdir/wt-idle" "$PIPELINE_WATCH" --resolve feat/d --branches feat/d 2>/dev/null) || st=$?
if [ "$st" -ne 2 ] || [ -n "$res" ]; then fail "--resolve with --branches: exit $st, out '$res'"; fi
[ ! -e "$fakebin/event-calls" ] || fail "--resolve recorded an event: $(cat "$fakebin/event-calls")"
rm "$fakebin/callum-flow-event"
runs_order RUNE RUND RUNC RUNB RUNA
ok # --resolve: id from each source, newest run, no run, failure, no events

# 8c. ci-stalled (cbundy/dev-system#234): ci.log still ends in "no CI checks
# reported yet" after the grace period and GitHub confirms the PR has none.
g -C "$repo" branch feat/s "$b_head"
g -C "$repo" push -q origin feat/s
run_state RUNS feat/s running "$b_head"
runs_order RUNS RUNE RUND RUNC RUNB RUNA
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
    --deadline 2 --branches feat/s "$@"
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
sleep 3
expect_lines "$out" "ci-stalled feat/s RUNS reason=no-workflow head=$b_head"
echo "all CI checks passed" >> "$slog"
wait_lines "$out" 2
stop_bg
expect_lines "$out" "ci-stalled feat/s RUNS reason=no-workflow head=$b_head
merge-ready feat/s RUNS head=$b_head"
runs_order RUNE RUND RUNC RUNB RUNA
ok # ci-stalled: both reasons, grace, soft failures, fingerprint, then merge-ready

# ---------------------------------------------------------------------------
# queue-watch.sh

# queue_seq <line>...: what successive `gh issue list` calls return
queue_seq() {
  printf '%s\n' "$@" > "$fakebin/queue-seq.txt.set"
  mv "$fakebin/queue-seq.txt.set" "$fakebin/queue-seq.txt"
}
qw="$QUEUE_WATCH --repo o/r --label ready --interval 1"

# 9. Debounce: a one-poll blip (label-list lag) does not fire.
queue_seq 305,307 305
st=0
# shellcheck disable=SC2086 # $qw is the command and its fixed options
blip=$(in_dir "$tmpdir" timeout 5 $qw --known 305) || st=$?
if [ "$st" -ne 124 ] || [ -n "$blip" ]; then fail "one-poll blip: exit $st, output '$blip'"; fi
ok # debounce ignores a one-poll blip

# 10. Single-shot: a change seen on two polls fires and exits 0; a failed
# poll between them neither fires nor clears the pending change.
queue_seq 305,307 FAIL 305,307
# shellcheck disable=SC2086 # $qw is the command and its fixed options
single=$(in_dir "$tmpdir" timeout 10 $qw --known 305) || fail "single-shot queue: did not exit 0"
[ "$single" = "queue-changed known=305 now=305,307" ] || fail "single-shot queue: $single"
ok # single-shot queue fires on a confirmed change

# 11. Stream: one line per confirmed change, `now` carried forward as the new
# baseline, no repeats, an emptied queue reported as none.
queue_seq 305 305,307
# shellcheck disable=SC2086 # $qw is the command and its fixed options
start_bg "$out" "$tmpdir" $qw --stream --known 305
wait_lines "$out" 1
sleep 3
expect_lines "$out" "queue-changed known=305 now=305,307"
queue_seq ""
wait_lines "$out" 2
sleep 2
expect_lines "$out" "queue-changed known=305 now=305,307
queue-changed known=305,307 now=none"
stop_bg
ok # stream queue: one line per change, baseline carried forward

# 11b. --known in any order is the same set: the watcher sorts the baseline
# numerically, so an unsorted list never fires a spurious queue-changed.
queue_seq 114,153,219
st=0
# shellcheck disable=SC2086 # $qw is the command and its fixed options
unsorted=$(in_dir "$tmpdir" timeout 6 $qw --known 219,114,153) || st=$?
if [ "$st" -ne 124 ] || [ -n "$unsorted" ]; then fail "unsorted --known fired: exit $st, output '$unsorted'"; fi
queue_seq 9,10,100
st=0
# shellcheck disable=SC2086 # $qw is the command and its fixed options
unsorted=$(in_dir "$tmpdir" timeout 6 $qw --known 100,9,10) || st=$?
if [ "$st" -ne 124 ] || [ -n "$unsorted" ]; then fail "numeric (not text) order: exit $st, output '$unsorted'"; fi
ok # an unsorted --known does not fire queue-changed

# 12. Stream: gh missing is fatal and reported.
mv "$fakebin/gh" "$fakebin/gh.off"
st=0
# shellcheck disable=SC2086 # $qw is the command and its fixed options
(in_dir "$tmpdir" $qw --stream) > "$out" 2>/dev/null || st=$?
mv "$fakebin/gh.off" "$fakebin/gh"
[ "$st" -ne 0 ] || fail "queue stream without gh: exited 0"
expect_lines "$out" "watcher-error gh not on PATH"
ok # queue stream fatal error reported

# 13. Stream: an unexpected failure (here `sleep` itself failing) still ends
# with a watcher-error line, never a silent exit.
printf '#!/bin/sh\nexit 3\n' > "$fakebin/sleep"
chmod +x "$fakebin/sleep"
queue_seq 305
st=0
# shellcheck disable=SC2086 # $qw is the command and its fixed options
(in_dir "$tmpdir" timeout 10 $qw --stream --known 305) > "$out" 2>/dev/null || st=$?
rm "$fakebin/sleep"
[ "$st" -eq 3 ] || fail "unexpected failure: exit $st, want 3"
expect_lines "$out" "watcher-error exited with status 3"
ok # unexpected exit reported

echo "ok - $passed watcher scenarios passed"
