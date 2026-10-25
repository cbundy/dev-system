# shellcheck shell=sh
#
# Shared setup for the watcher suites (queue-watch*.test.sh, watcher-replay-transition.test.sh and
# watcher-sleep-queue.test.sh): sourced, never run, and named so the `*.test.sh`
# glob in scripts/test.sh does not pick it up.
#
# Like recover-no-mistakes.test.sh, the suites run the scripts from their source
# location with a stub `gh` on PATH - no Docker, no container
# build - so `npm test` runs them anywhere. Most cases use a one-second poll
# interval; sleep-kill cases use longer intervals to check the remaining wait.
#
# Waiting rules (cbundy/dev-system#478): a positive wait polls for the expected
# file, line or pid (wait_lines, wait_events, wait_sleep). A negative "nothing
# more happens" window never uses wall time: it is bounded by observed watcher
# progress, the stub call logs below, so a loaded host can neither turn it into
# a false pass nor a false fail.
#   fakebin/gh-calls  one line per queue listing call (its epoch second):
#                     queue-watch makes exactly one per poll, except when its
#                     reader fails before asking gh (wait_polls)
# Elapsed-time assertions check --deadline, the interval a killed sleep must
# still wait out, and prompt signal shutdown; they do not bound quiet windows.
# Sourcing this file sets up a private tmpdir (removed on exit) and the stubs.
# shellcheck disable=SC2034 # variables and helpers for the suites that source this file
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
SRC="$SCRIPT_DIR/../../src/callum-tools"
QUEUE_WATCH="$SRC/queue-watch.sh"
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
  rm -rf "$tmpdir"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

fakebin="$tmpdir/bin"
toolbin="$tmpdir/tools"
mkdir -p "$fakebin" "$toolbin"
# A hermetic PATH: the stubs plus only the tools the scripts and stubs use,
# so a real gh (the base image has it) can never answer.
for t in git awk sed ls head grep tr date sleep cat timeout env wc tail mv dirname cut stat sort paste jq; do
  p=$(command -v "$t") || fail "$t not found"
  ln -s "$p" "$toolbin/$t"
done

# in_dir <dir> <command...>: exec the command from dir with the stub PATH.
# Call it in a subshell: it changes directory and replaces the process.
in_dir() {
  cd "$1" || exit 1
  shift
  PATH="$fakebin:$toolbin"
  # queue-watch lists through the real trusted-author reader (cbundy/dev-system#310)
  CALLUM_FLOW_ISSUE_READ_BIN="$READER"
  CALLUM_FLOW_SHARE_DIR="$SHARE"
  CALLUM_FLOW_TRUSTED_AUTHORS=cbundy:13131067
  export PATH CALLUM_FLOW_ISSUE_READ_BIN CALLUM_FLOW_SHARE_DIR CALLUM_FLOW_TRUSTED_AUTHORS
  exec "$@"
}

# start_bg <out-file> <dir> <command...>: run a stream watcher in the
# background; bg_pid is the watcher itself (the subshell execs it).
start_bg() {
  out=$1
  shift
  # create/truncate synchronously so wait_lines never sees a missing or stale file
  : > "$out"
  : > "$out.err"
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

# wait_polls <call-log> <k>: wait up to 15s until the watcher has made k more
# polls than the log shows now. The log line is written when a poll starts, so
# the poll before the last one counted has finished: wait_polls <log> 3 proves
# at least two whole polls ran after the call (state change, restart) it follows.
wait_polls() {
  wait_lines "$1" $(($(line_count "$1") + $2))
}

# expect_lines <file> <expected text>: the file holds exactly these lines.
expect_lines() {
  [ "$(cat "$1")" = "$2" ] || fail "expected:
$2
got:
$(cat "$1")"
}

# wait_sleep <watcher-pid>: print the pid of the watcher's sleep child, once it has one.
wait_sleep() {
  i=0
  while :; do
    p=$(pgrep -P "$1" -x sleep | head -n 1 || :)
    [ -z "$p" ] || { echo "$p"; return 0; }
    i=$((i + 1))
    [ "$i" -le 150 ] || fail "no sleep child under $1"
    sleep 0.1
  done
}

# gone <pid>: the process is gone (a short grace for the init reaper).
gone() {
  i=0
  while kill -0 "$1" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -le 50 ] || return 1
    sleep 0.1
  done
}

# Stub gh: answers the queue listing; fails while a gh-fail marker exists.
cat > "$fakebin/gh" <<'EOF'
#!/bin/sh
d=$(dirname "$0")
[ ! -e "$d/gh-fail" ] || exit 1
case "$1 $2" in
  "api --paginate")
    # queue-watch lists through callum-flow-issue-read, which asks for the REST
    # issue list: pop the first line of queue-seq.txt (the last one repeats);
    # a FAIL line is a failed call. Each issue is titled "title N", labelled ready and bug, and has a
    # same-repo parent N+1000 when N mod 3 is 1, a parent in another repo when it is 2, none when 0. Numbers are comma separated; an x prefix
    # (x307) marks an issue opened by an untrusted author.
    case "$3" in repos/o/r/issues\?*) ;; *) exit 1 ;; esac
    date +%s >> "$d/gh-calls"
    f="$d/queue-seq.txt"
    line=$(sed -n 1p "$f")
    if [ "$(wc -l < "$f")" -gt 1 ]; then
      tail -n +2 "$f" > "$f.next" && mv "$f.next" "$f"
    fi
    [ "$line" != FAIL ] || exit 1
    printf '%s' "$line" | tr ',' '\n' | jq -R -s -c '
      split("\n") | map(select(. != "")) | map(
        (startswith("x")) as $x | ltrimstr("x") | tonumber as $n
        | {number: $n, title: "title \($n)", body: "b", state: "open", labels: [{name: "ready"}, {name: "bug"}],
           parent_issue_url: (if $n % 3 == 1 then "https://api.github.com/repos/o/r/issues/\($n + 1000)"
             elif $n % 3 == 2 then "https://api.github.com/repos/other/repo/issues/77" else null end),
           user: (if $x then {login: "mallory", id: 999} else {login: "cbundy", id: 13131067} end)})'
    ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$fakebin/gh"
: > "$fakebin/gh-calls"

# queue_seq <line>...: what successive queue listing calls return
queue_seq() {
  printf '%s\n' "$@" > "$fakebin/queue-seq.txt.set"
  mv "$fakebin/queue-seq.txt.set" "$fakebin/queue-seq.txt"
}
qw="$QUEUE_WATCH --repo o/r --label ready --interval 1"

out="$tmpdir/out"

# quiet_run <label> <counter-file> <known> [VAR=value...]: a single-shot
# watcher that must neither fire nor exit. It runs until the counter file shows
# three more polls (so two whole polls after the start), then must still be
# alive with empty stdout. Progress, not wall time, bounds the window.
quiet_run() {
  label=$1
  counter=$2
  known=$3
  shift 3
  : > "$counter"
  # shellcheck disable=SC2086 # $qw is the command and its fixed options
  start_bg "$out" "$tmpdir" env "$@" $qw --known "$known"
  n=0
  while [ "$(line_count "$counter")" -lt 3 ]; do
    alive "$bg_pid" || fail "$label: the watcher exited: $(cat "$out" "$out.err")"
    n=$((n + 1))
    [ "$n" -le 150 ] || fail "$label: timed out waiting for 3 polls"
    sleep 0.1
  done
  alive "$bg_pid" || fail "$label: the watcher exited: $(cat "$out" "$out.err")"
  [ ! -s "$out" ] || fail "$label: fired: $(cat "$out")"
  stop_bg
}

# real_event_log: the real callum-flow-event writes a real new-format log (evlog) under a
# private directory; the watchers print as always (cbundy/dev-system#344). It never writes the old
# log (oldevlog; cbundy/dev-system#1143).
real_event_log() {
  evdir="$tmpdir/real-events"
  mkdir -p "$evdir"
  # the dual write (the new event) needs node, a temp file and the directory tools
  for t in node mktemp rm mkdir chmod touch; do
    [ -e "$toolbin/$t" ] || ln -s "$(command -v "$t")" "$toolbin/$t"
  done
  evlog="$evdir/factory/o__r.jsonl"
  oldevlog="$evdir/o__r.jsonl"
  cat > "$fakebin/callum-flow-event" <<EOF
#!/bin/sh
PATH="$toolbin" CALLUM_EVENTS_DIR="$evdir" CALLUM_FLOW_REPO=o/r DEV_MACHINE_NAME=box CLAUDE_SESSION_ID=s DEV_SYSTEM_SHARE="$SHARE" exec "$SHARE/callum-flow-event" "\$@"
EOF
  chmod +x "$fakebin/callum-flow-event"
}
# no_event_log <what>: the real event log (real_event_log) holds nothing, old or new
no_event_log() {
  [ ! -e "$oldevlog" ] || fail "$1: the watcher wrote the old event log: $(cat "$oldevlog")"
  [ ! -e "$evdir/factory" ] || fail "$1: the watcher wrote the new event log: $(ls -A "$evdir/factory")"
}
# wait_events <pattern> <n>: wait up to 15s for n log lines matching the pattern
# (the watcher prints a line before it logs it).
wait_events() {
  i=0
  while [ "$(ev_count "$1")" -lt "$2" ]; do
    i=$((i + 1))
    [ "$i" -le 150 ] || fail "timed out waiting for $2 '$1' event(s): $(cat "$evlog" 2>/dev/null)"
    sleep 0.1
  done
}
ev_count() { if [ -f "$evlog" ]; then grep -c "$1" "$evlog" || :; else echo 0; fi; }
