# shellcheck shell=sh
#
# Shared setup for the orchestrator-watch suites (orchestrator-watch*.test.sh):
# sourced, never run, and named so the `*.test.sh` glob in scripts/test.sh does
# not pick it up. Plain-shell tests for orchestrator-watch.sh
# (cbundy/dev-system#394), the combined queue + pipeline watcher. Like the
# watcher suites (watchers-lib.sh) they run the scripts from their source
# location with stub `gh` and `no-mistakes` on PATH, so `npm test` runs them
# anywhere. Most scenarios drive the real queue-watch.sh and pipeline-watch.sh
# through the stubs; the process-lifecycle ones (fatal child, signals, lock)
# swap in fake children that record their pids. Everything uses private lock
# and temp directories; no tmux, no live watcher is touched.
#
# Waiting rules (cbundy/dev-system#478): a positive wait polls for the expected
# file, line or pid. A negative "nothing more happens" window never uses wall
# time: it is bounded by observed watcher progress, the stub call logs
# (fakebin/nm-polls: one line per `no-mistakes runs` call, one per pipeline
# poll; fakebin/gh-calls: one line per queue listing call, one per queue poll).
# Wall time appears only where the watcher itself is under test as a clock: the
# single-shot window, --deadline, and the interval of a killed sleep.
# shellcheck disable=SC2046,SC2086 # word-splitting of fixed option lists and pid lists is intended
# shellcheck disable=SC2034 # variables and helpers for the suites that source this file
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
  # the decoys, and the fake children recorded by the lifecycle scenarios
  for f in "$tmpdir"/fake/*pid; do
    [ -f "$f" ] || continue
    kill -9 $(cat "$f") 2>/dev/null || true
  done
  for p in ${decoys-}; do kill "$p" 2>/dev/null || true; done
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
  : > "$out"
  : > "$out.err"
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

# alive <pid>: the process exists and is not a zombie. A finished background
# child stays a zombie until it is waited for, and `kill -0` still succeeds on
# it, so kill -0 alone cannot tell a watcher that died from one that lives.
alive() {
  kill -0 "$1" 2>/dev/null || return 1
  [ ! -r "/proc/$1/stat" ] || case "$(sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null)" in Z*) return 1 ;; esac
  return 0
}

line_count() {
  wc -l < "$1" | tr -d ' '
}

# wait_lines <file> <n>: wait up to 15s until the file has at least n lines.
wait_lines() {
  i=0
  while [ "$(line_count "$1")" -lt "$2" ]; do
    i=$((i + 1))
    [ "$i" -le 150 ] || fail "timed out waiting for $2 line(s) in $1 - got: $(cat "$1")"
    sleep 0.1
  done
}

# wait_polls <call-log> <k>: wait up to 15s until the log shows k more polls
# than it does now. Its line is written when a poll starts, so k=3 proves two
# whole polls after the call (state change, restart) it follows.
wait_polls() {
  wait_lines "$1" $(($(line_count "$1") + $2))
}

expect_lines() {
  [ "$(cat "$1")" = "$2" ] || fail "expected:
$2
got:
$(cat "$1")"
}

# gone <pid>...: none of these processes exists (waits up to 15s)
gone() {
  for p in "$@"; do
    i=0
    while kill -0 "$p" 2>/dev/null; do
      i=$((i + 1))
      [ "$i" -le 150 ] || fail "process $p survived"
      sleep 0.1
    done
  done
}

# ---------------------------------------------------------------------------
# Stubs shared with watchers-lib.sh: gh (queue list) and no-mistakes (runs).
cat > "$fakebin/no-mistakes" <<'EOF'
#!/bin/sh
d=$(dirname "$0")
[ "$1" != runs ] || echo x >> "$d/nm-polls"
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
    echo x >> "$d/gh-calls"
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
: > "$fakebin/nm-polls"
: > "$fakebin/gh-calls"
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
# Fake children for the lifecycle scenarios: record the pid, write one stderr
# line, record a sleeping grandchild's pid, then stay quiet on stdout while
# adding a line to <name>-beats once a second (the progress that bounds their
# negative windows).
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
echo x >> "$d/$name-beats"
echo $! > "$d/$name-sleep-pid"
while :; do
  sleep 1
  echo x >> "$d/$name-beats"
done
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

# find_sleep and descendants_of: see the sleep-kill scenarios. Owner rule
# (cbundy/dev-system#420): kill ONLY a pid recorded from under our own watcher,
# never by name or pattern.
# find_sleep <root-pid> <seconds>: the pid of a `sleep <seconds>` anywhere under
# root (waits up to 15s). The distinct values tell a child's sleep from a timer's.
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
    [ "$i" -le 150 ] || fail "no 'sleep $2' under $1"
    sleep 0.1
  done
}
descendants_of() {
  for c in $(pgrep -P "$1" 2>/dev/null || :); do
    echo "$c"
    descendants_of "$c"
  done
}

# check_decoys: the decoys named like the watchers are all still alive (the
# watcher stopped only its own children), then stop them.
check_decoys() {
  for p in $decoys; do
    alive "$p" || fail "decoy process $p was killed: the watcher stopped something that was not its child"
    kill "$p" 2>/dev/null || true
  done
  ok # decoys named like the watchers survive
}
