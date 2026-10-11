#!/bin/sh
#
# Plain-shell tests for orchestrator-watch.sh (cbundy/dev-system#394): the
# combined queue + pipeline watcher. Like watchers.test.sh it runs the scripts
# from their source location with stub `gh` and `no-mistakes` on PATH, so
# `npm test` runs it anywhere. Most scenarios drive the real queue-watch.sh and
# pipeline-watch.sh through the stubs; the process-lifecycle ones (fatal child,
# signals, lock) swap in fake children that record their pids. Everything uses
# private lock and temp directories; no tmux, no live watcher is touched.
# shellcheck disable=SC2046,SC2086 # word-splitting of fixed option lists and pid lists is intended
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
SRC="$SCRIPT_DIR/../../src/callum-tools"
OW="$SRC/orchestrator-watch.sh"
SHARE="$SCRIPT_DIR/../../../images/base"
READER="$SHARE/callum-flow-issue-read"

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
  # fake children recorded by the lifecycle scenarios
  for f in "$tmpdir"/fake/*pid; do
    [ -f "$f" ] || continue
    kill -9 $(cat "$f") 2>/dev/null || true
  done
  rm -rf "$tmpdir"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

fakebin="$tmpdir/bin"
toolbin="$tmpdir/tools"
mkdir -p "$fakebin" "$toolbin" "$tmpdir/locks" "$tmpdir/fake"
for t in git awk sed ls head grep tr date sleep cat timeout env wc tail mv dirname cut stat sort paste jq \
  pgrep mkfifo mktemp mkdir rm sh; do
  p=$(command -v "$t") || fail "$t not found"
  ln -s "$p" "$toolbin/$t"
done
nm_home="$tmpdir/nm"

# in_dir <dir> <command...>: exec the command from dir with the stub PATH.
in_dir() {
  cd "$1" || exit 1
  shift
  PATH="$fakebin:$toolbin"
  NO_MISTAKES_HOME="$nm_home"
  CALLUM_FLOW_ISSUE_READ_BIN="$READER"
  CALLUM_FLOW_SHARE_DIR="$SHARE"
  CALLUM_FLOW_TRUSTED_AUTHORS=cbundy:13131067
  ORCHESTRATOR_WATCH_LOCK_DIR="$tmpdir/locks"
  export PATH NO_MISTAKES_HOME CALLUM_FLOW_ISSUE_READ_BIN CALLUM_FLOW_SHARE_DIR CALLUM_FLOW_TRUSTED_AUTHORS ORCHESTRATOR_WATCH_LOCK_DIR
  exec "$@"
}

start_bg() {
  out=$1
  shift
  (in_dir "$@") > "$out" 2> "$out.err" &
  bg_pid=$!
}

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

wait_lines() {
  i=0
  while [ "$(line_count "$1")" -lt "$2" ]; do
    i=$((i + 1))
    [ "$i" -le 75 ] || fail "timed out waiting for $2 line(s) in $1 - got: $(cat "$1")"
    sleep 0.2
  done
}

expect_lines() {
  [ "$(cat "$1")" = "$2" ] || fail "expected:
$2
got:
$(cat "$1")"
}

# gone <pid>...: none of these processes exists (waits up to 5s)
gone() {
  for p in "$@"; do
    i=0
    while kill -0 "$p" 2>/dev/null; do
      i=$((i + 1))
      [ "$i" -le 50 ] || fail "process $p survived"
      sleep 0.1
    done
  done
}

# ---------------------------------------------------------------------------
# Stubs shared with watchers.test.sh: gh (queue list) and no-mistakes (runs).
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
  "api --paginate")
    # queue-watch lists through callum-flow-issue-read, which asks for the REST
    # issue list: pop the first line of queue-seq.txt (the last one repeats);
    # a FAIL line is a failed call. Numbers are comma separated; an x prefix
    # (x307) marks an issue opened by an untrusted author.
    case "$3" in repos/o/r/issues\?*) ;; *) exit 1 ;; esac
    f="$d/queue-seq.txt"
    line=$(sed -n 1p "$f")
    if [ "$(wc -l < "$f")" -gt 1 ]; then
      tail -n +2 "$f" > "$f.next" && mv "$f.next" "$f"
    fi
    [ "$line" != FAIL ] || exit 1
    printf '%s' "$line" | tr ',' '\n' | jq -R -s -c '
      split("\n") | map(select(. != "")) | map(
        (startswith("x")) as $x | ltrimstr("x") | tonumber as $n
        | {number: $n, title: "t", body: "b", state: "open", labels: [],
           user: (if $x then {login: "mallory", id: 999} else {login: "cbundy", id: 13131067} end)})'
    ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$fakebin/no-mistakes" "$fakebin/gh"

mkdir -p "$nm_home/logs" "$fakebin/runs"
echo "MERGEABLE CLEAN" > "$fakebin/pr-status.txt"
runs_order() {
  printf '%s\n' "$@" > "$fakebin/runs-order"
}
: > "$fakebin/runs-order"

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
queue_seq() {
  printf '%s\n' "$@" > "$fakebin/queue-seq.txt.set"
  mv "$fakebin/queue-seq.txt.set" "$fakebin/queue-seq.txt"
}

g() { git -c user.name=t -c user.email=t@t -c init.defaultBranch=main "$@"; }
g init -q "$tmpdir/repo"
repo="$tmpdir/repo"

# Fake children for the lifecycle scenarios: record the pid and a sleeping
# grandchild's pid, then stay quiet (writing one stderr line if asked).
# FAKE_MODE: quiet | exit0 | error
cat > "$tmpdir/fake/child.sh" <<'FAKE'
#!/bin/sh
name=$1
d=$(dirname "$0")
echo $$ > "$d/$name-pid"
echo "fake $name backoff" >&2
case "${FAKE_MODE:-quiet}" in
  exit0) exit 0 ;;
  error) echo "watcher-error boom"; exit 1 ;;
esac
sleep 300 &
echo $! > "$d/$name-sleep-pid"
wait
FAKE
cat > "$tmpdir/fake/queue.sh" <<FAKE
#!/bin/sh
exec "$tmpdir/fake/child.sh" queue
FAKE
cat > "$tmpdir/fake/pipeline.sh" <<FAKE
#!/bin/sh
exec "$tmpdir/fake/child.sh" pipeline
FAKE
chmod +x "$tmpdir/fake"/*.sh
fake_env() {
  echo "ORCHESTRATOR_WATCH_QUEUE_BIN=$tmpdir/fake/queue.sh ORCHESTRATOR_WATCH_PIPELINE_BIN=$tmpdir/fake/pipeline.sh"
}
fake_pids() {
  cat "$tmpdir/fake"/*pid 2>/dev/null || true
}
reset_fakes() {
  rm -f "$tmpdir/fake"/*pid
}
wait_fakes() { # wait until both fake children have recorded their pids
  i=0
  while [ ! -s "$tmpdir/fake/queue-sleep-pid" ] || [ ! -s "$tmpdir/fake/pipeline-sleep-pid" ]; do
    i=$((i + 1))
    [ "$i" -le 75 ] || fail "fake children did not start"
    sleep 0.2
  done
}

A="--repo o/r --label ready --interval 1"

# Decoys named like the real watchers (and sleeping like them): the watcher and
# this test must only ever stop their own children, by pid, never by name. All
# of them must still be alive at the end.
mkdir -p "$tmpdir/decoy"
decoys=
for n in queue-watch.sh pipeline-watch.sh orchestrator-watch.sh; do
  printf '#!/bin/sh\nsleep 300 &\nwait\n' > "$tmpdir/decoy/$n"
  chmod +x "$tmpdir/decoy/$n"
  "$tmpdir/decoy/$n" > /dev/null 2>&1 &
  decoys="$decoys $!"
done

# 1. Stream: one queue change and one pipeline state both come out once,
# unchanged, and a quiet period adds nothing.
queue_seq 5
run_state RUNA feat/a parked aaa
runs_order RUNA
out="$tmpdir/s1.out"
# shellcheck disable=SC2086 # $A is a fixed option list
start_bg "$out" "$repo" "$OW" $A --stream --queue-known none
wait_lines "$out" 2
sleep 3
stop_bg
sort "$out" > "$out.sorted"
expect_lines "$out.sorted" "parked feat/a RUNA head=aaa
queue-changed known=none now=5"
ok # stream passes both children's lines through once

# 2. Single-shot: exits 0 on the first event; the second event inside the
# window comes out in the same exit; the rearm line holds the carried
# baselines, and replaying it prints no event.
queue_seq 5
runs_order RUNA
single="$tmpdir/s2.out"
# shellcheck disable=SC2086
(in_dir "$repo" timeout 30 env ORCHESTRATOR_WATCH_WINDOW=6 "$OW" $A \
  --queue-known none --pipeline-known feat/z=failed:zzz) > "$single" 2>/dev/null ||
  fail "single-shot did not exit 0"
grep -qx "parked feat/a RUNA head=aaa" "$single" || fail "single-shot pipeline line: $(cat "$single")"
grep -qx "queue-changed known=none now=5" "$single" || fail "single-shot queue line (window): $(cat "$single")"
rearm_line=$(tail -n 1 "$single")
[ "$(line_count "$single")" -eq 3 ] || fail "single-shot: want 2 events + rearm: $(cat "$single")"
case "$rearm_line" in
  "rearm --repo o/r --label ready --queue-interval 1 --pipeline-interval 1 --queue-known 5 --pipeline-known"*) ;;
  *) fail "rearm line: $rearm_line" ;;
esac
case "$rearm_line" in *"--pipeline-known feat/a=parked:aaa"*) ;; *) fail "rearm lacks feat/a: $rearm_line" ;; esac
case "$rearm_line" in *"--pipeline-known feat/z=failed:zzz"*) ;; *) fail "rearm lost the caller's baseline: $rearm_line" ;; esac
ok # single-shot: first event, window, rearm line

args=${rearm_line#rearm }
# shellcheck disable=SC2086
replay=$(in_dir "$repo" timeout 30 "$OW" $args --deadline 4 2>&1) || fail "replay did not exit 0: $replay"
case "$replay" in
  "timeout
rearm "*) ;;
  *) fail "replay re-delivered an event: $replay" ;;
esac
ok # replaying the rearm line never re-delivers

# 3. Events while nothing is armed are reported by the re-armed copy on its
# first poll: a queue change and a pipeline transition.
queue_seq 5,6
run_state RUNA feat/a failed aaa
# shellcheck disable=SC2086
caught=$(in_dir "$repo" timeout 30 env ORCHESTRATOR_WATCH_WINDOW=3 "$OW" $args) || fail "re-armed copy did not exit 0"
printf '%s\n' "$caught" | grep -qx "failed feat/a RUNA head=aaa" || fail "missed pipeline transition: $caught"
printf '%s\n' "$caught" | grep -qx "queue-changed known=5 now=5,6" || fail "missed queue change: $caught"
ok # events between exit and re-arm are caught up

# 4. --deadline in both modes: timeout plus rearm, exit 0.
queue_seq ""
: > "$fakebin/runs-order"
for mode in "" --stream; do
  # shellcheck disable=SC2086
  d=$(in_dir "$repo" timeout 30 "$OW" $A $mode --deadline 2) || fail "deadline ${mode:-single-shot}: did not exit 0: $d"
  [ "$d" = "timeout
rearm --repo o/r --label ready${mode:+ $mode} --deadline 2 --queue-interval 1 --pipeline-interval 1 --queue-known none" ] ||
    fail "deadline ${mode:-single-shot}: $d"
done
ok # --deadline gives timeout + rearm in both modes

# 4b. Stream mode survives the first event: it keeps printing until the deadline.
queue_seq 8
# shellcheck disable=SC2086
d=$(in_dir "$repo" timeout 30 "$OW" $A --stream --deadline 6 --queue-known none) || fail "stream deadline: did not exit 0: $d"
[ "$d" = "queue-changed known=none now=8
timeout
rearm --repo o/r --label ready --stream --deadline 6 --queue-interval 1 --pipeline-interval 1 --queue-known 8" ] ||
  fail "stream with event then deadline: $d"
ok # stream mode carries baselines across events

# 5. A child fatal error: watcher-error, non-zero exit, nothing left behind.
# 5a. the real pipeline-watch with no-mistakes missing
queue_seq ""
mv "$fakebin/no-mistakes" "$fakebin/no-mistakes.off"
st=0
# shellcheck disable=SC2086
d=$(in_dir "$repo" timeout 30 "$OW" $A --stream) || st=$?
mv "$fakebin/no-mistakes.off" "$fakebin/no-mistakes"
[ "$st" -ne 0 ] || fail "fatal child: exited 0"
[ "$d" = "watcher-error pipeline: no-mistakes not on PATH" ] || fail "fatal child: $d"
ok # real child fatal error reported

# 5b. fake children: one prints watcher-error; another exits 0 quietly
reset_fakes
st=0
# shellcheck disable=SC2086
d=$(in_dir "$repo" env FAKE_MODE=error $(fake_env) timeout 30 "$OW" $A --stream 2>/dev/null) || st=$?
[ "$st" -ne 0 ] || fail "fake error child: exited 0"
case "$d" in "watcher-error "*": boom") ;; *) fail "fake error child: $d" ;; esac
reset_fakes
st=0
# shellcheck disable=SC2086
d=$(in_dir "$repo" env FAKE_MODE=exit0 $(fake_env) timeout 30 "$OW" $A --stream 2>/dev/null) || st=$?
[ "$st" -ne 0 ] || fail "child exit 0: wrapper exited 0"
case "$d" in "watcher-error "*": exited with status 0") ;; *) fail "child exit 0: $d" ;; esac
ok # a child exit or watcher-error is never silent

# 5c. the surviving sibling is stopped when the other dies: pipeline errors,
# queue is a fake sleeper
reset_fakes
st=0
mv "$fakebin/no-mistakes" "$fakebin/no-mistakes.off"
# shellcheck disable=SC2086
d=$(in_dir "$repo" env ORCHESTRATOR_WATCH_QUEUE_BIN="$tmpdir/fake/queue.sh" timeout 30 "$OW" $A --stream 2>/dev/null) || st=$?
mv "$fakebin/no-mistakes.off" "$fakebin/no-mistakes"
[ "$st" -ne 0 ] || fail "sibling: exited 0"
# shellcheck disable=SC2046
gone $(fake_pids)
ok # no surviving child after a child failure

# 6. SIGTERM: no output, no surviving child; a quiet child with stderr output
# is not taken for dead.
reset_fakes
out="$tmpdir/s6.out"
# shellcheck disable=SC2086
start_bg "$out" "$repo" env $(fake_env) "$OW" $A --stream
wait_fakes
sleep 2
kill -0 "$bg_pid" 2>/dev/null || fail "a quiet child was taken for dead: $(cat "$out" "$out.err")"
grep -q "fake queue backoff" "$out.err" || fail "child stderr not passed through: $(cat "$out.err")"
fp=$(fake_pids)
kill -TERM "$bg_pid"
wait "$bg_pid" 2>/dev/null || true
bg_pid=
[ ! -s "$out" ] || fail "SIGTERM printed: $(cat "$out")"
# shellcheck disable=SC2086
gone $fp
ok # SIGTERM: quiet, children gone; stderr passes through

# 7. Never two copies; a lock left by a dead process is taken over.
reset_fakes
out="$tmpdir/s7.out"
# shellcheck disable=SC2086
start_bg "$out" "$repo" env $(fake_env) "$OW" $A --stream
first=$bg_pid
wait_fakes
st=0
# shellcheck disable=SC2086
second=$(in_dir "$repo" env $(fake_env) timeout 30 "$OW" $A --stream 2>/dev/null) || st=$?
[ "$st" -ne 0 ] || fail "second copy: exited 0"
# the first copy is the env/sh exec chain, so its pid is the watcher's own
[ "$second" = "watcher-error already-running pid=$first" ] || fail "second copy: '$second' (first=$first)"
kill -0 "$first" 2>/dev/null || fail "refused copy stopped the first"
orphans=$(fake_pids)
kill -9 "$first"
wait "$first" 2>/dev/null || true
bg_pid=
# the first copy's children outlive a kill -9; clear them so the next copy's are distinguishable
# shellcheck disable=SC2086
kill -9 $orphans 2>/dev/null || true
reset_fakes
out2="$tmpdir/s7b.out"
# shellcheck disable=SC2086
start_bg "$out2" "$repo" env $(fake_env) "$OW" $A --stream
wait_fakes
kill -0 "$bg_pid" 2>/dev/null || fail "takeover: new copy died: $(cat "$out2" "$out2.err")"
[ ! -s "$out2" ] || fail "takeover printed: $(cat "$out2")"
[ "$(cat "$tmpdir/locks"/*/pid)" = "$bg_pid" ] || fail "lock not taken over"
fp=$(fake_pids)
stop_bg
# shellcheck disable=SC2086
gone $fp
[ -z "$(ls "$tmpdir/locks")" ] || fail "lock left behind: $(ls "$tmpdir/locks")"
ok # one copy per repository; stale lock taken over; lock released on exit

# 8. Usage errors
st=0
d=$(in_dir "$repo" "$OW" --repo o/r) || st=$?
[ "$st" -eq 2 ] || fail "usage: exit $st"
case "$d" in "watcher-error usage"*) ;; *) fail "usage: $d" ;; esac
ok # usage error

# ---------------------------------------------------------------------------
# A sleep killed from outside is survived (cbundy/dev-system#420). Owner rule:
# kill ONLY a pid recorded from under our own watcher, never by name or pattern.

# find_sleep <root-pid> <seconds>: the pid of a `sleep <seconds>` anywhere under
# root (waits up to 10s). The distinct values tell a child's sleep from a timer's.
find_sleep() {
  i=0
  while :; do
    for p in $(descendants_of "$1"); do
      if [ "$({ tr '\0' ' ' < "/proc/$p/cmdline"; } 2>/dev/null)" = "sleep $2 " ]; then
        echo "$p"
        return 0
      fi
    done
    i=$((i + 1))
    [ "$i" -le 100 ] || fail "no 'sleep $2' under $1"
    sleep 0.1
  done
}
descendants_of() {
  for c in $(pgrep -P "$1" 2>/dev/null || :); do
    echo "$c"
    descendants_of "$c"
  done
}

# 9. A child's sleep is killed: no watcher-error, the watcher lives, the later
# queue change still passes through.
queue_seq 5
: > "$fakebin/runs-order"
out="$tmpdir/s9.out"
start_bg "$out" "$repo" "$OW" --repo o/r --label ready --queue-interval 3 --pipeline-interval 62 --stream --queue-known 5
victim=$(find_sleep "$bg_pid" 3)
kill "$victim"
sleep 1
kill -0 "$bg_pid" 2>/dev/null || fail "child sleep kill: watcher died: $(cat "$out" "$out.err")"
[ ! -s "$out" ] || fail "child sleep kill: stdout must stay empty: $(cat "$out")"
grep -q '^queue-watch.sh: sleep interrupted (status 143)' "$out.err" || fail "child sleep kill: stderr: $(cat "$out.err")"
queue_seq 5,6
wait_lines "$out" 1
expect_lines "$out" "queue-changed known=5 now=5,6"
stop_bg
ok # a killed child sleep is survived

# 10. The deadline timer's sleep is killed: timeout and rearm still print, and
# not before the deadline.
queue_seq 5
out="$tmpdir/s10.out"
t0=$(date +%s)
start_bg "$out" "$repo" "$OW" --repo o/r --label ready --queue-interval 61 --pipeline-interval 62 --stream --queue-known 5 --deadline 7
victim=$(find_sleep "$bg_pid" 7)
kill "$victim"
sleep 1
kill -0 "$bg_pid" 2>/dev/null || fail "timer sleep kill: watcher died: $(cat "$out" "$out.err")"
[ ! -s "$out" ] || fail "timer sleep kill: fired early: $(cat "$out")"
wait_lines "$out" 2
[ $(($(date +%s) - t0)) -ge 7 ] || fail "timer sleep kill: deadline came early"
[ "$(sed -n 1p "$out")" = timeout ] || fail "timer sleep kill: $(cat "$out")"
grep -q '^orchestrator-watch.sh: sleep interrupted' "$out.err" || fail "timer sleep kill: stderr: $(cat "$out.err")"
wait "$bg_pid" || fail "timer sleep kill: did not exit 0"
bg_pid=
ok # a killed timer sleep still delivers the deadline

# 11. A window that is not a whole number is a usage error.
st=0
w=$(in_dir "$repo" env ORCHESTRATOR_WATCH_WINDOW=1.5 "$OW" $A --stream 2>/dev/null) || st=$?
[ "$st" -eq 2 ] || fail "bad window: exit $st, want 2"
case "$w" in "watcher-error usage: ORCHESTRATOR_WATCH_WINDOW"*) ;; *) fail "bad window: $w" ;; esac
ok # ORCHESTRATOR_WATCH_WINDOW is validated

for p in $decoys; do
  kill -0 "$p" 2>/dev/null || fail "decoy process $p was killed: the watcher stopped something that was not its child"
  kill "$p" 2>/dev/null || true
done
ok # decoys named like the watchers survive

echo "ok - $passed orchestrator-watch scenarios passed"
