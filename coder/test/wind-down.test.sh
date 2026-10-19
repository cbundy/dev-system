#!/bin/sh
#
# Plain-shell test for coder/dev-system/wind-down.sh, the Coder stop script of the loop template.
# It runs the script against a temp CLAUDE_CONFIG_DIR with fake loop dirs, a fake
# callum-flow-event that records each --data, a fake heartbeat, and a background fake "loop"
# that writes the status files each case scripts.
# shellcheck disable=SC2016,SC2034 # fake_loop bodies are eval'd later; KEYS is used there
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)
SCRIPT=$ROOT/coder/dev-system/wind-down.sh
REAL_EVENT=$ROOT/images/base/callum-flow-event

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -f "$SCRIPT" ] || fail "$SCRIPT is missing"
command -v jq >/dev/null 2>&1 || fail "jq is required"

tmp=$(mktemp -d)
loop_pids=
cleanup() {
  # shellcheck disable=SC2086 # a list of PIDs this script started
  [ -z "$loop_pids" ] || kill $loop_pids 2>/dev/null || :
  rm -rf "${tmp:?}"
}
trap cleanup EXIT

bin=$tmp/bin
mkdir -p "$bin"
# Records "<repo><TAB><data>" per call in $EVENTS.
cat > "$bin/callum-flow-event" <<'EOF2'
#!/bin/sh
repo= data=
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo=$2; shift ;;
    --data) data=$2; shift ;;
  esac
  shift
done
printf '%s\t%s\n' "$repo" "$data" >> "$EVENTS"
EOF2
cat > "$bin/heartbeat" <<'EOF2'
#!/bin/sh
echo "$*" >> "$HEARTBEAT_CALLS"
EOF2
chmod +x "$bin/callum-flow-event" "$bin/heartbeat"

# setup <case>: a fresh config dir, workspaces dir and record files; $L is the loop dir of
# cbundy/demo.
setup() {
  case_dir=$tmp/$1
  mkdir -p "$case_dir/cfg/factory-loop" "$case_dir/ws"
  CFG=$case_dir/cfg
  WS=$case_dir/ws
  EVENTS=$case_dir/events
  HEARTBEAT_CALLS=$case_dir/heartbeat
  : > "$EVENTS"
  : > "$HEARTBEAT_CALLS"
  L=$CFG/factory-loop/cbundy__demo
  mkdir -p "$L"
  export EVENTS HEARTBEAT_CALLS
}

# run_script [extra env VAR=value...]: runs the script; leaves $rc, $err and $elapsed (seconds).
run_script() {
  start=$(date +%s)
  rc=0
  env CLAUDE_CONFIG_DIR="$CFG" WIND_DOWN_WORKSPACES="$WS" WIND_DOWN_POLL_S=0.2 \
    WIND_DOWN_HEARTBEAT="$bin/heartbeat" PATH="$bin:$PATH" "$@" \
    sh "$SCRIPT" > /dev/null 2> "$case_dir/err" || rc=$?
  elapsed=$(($(date +%s) - start))
  err=$(cat "$case_dir/err")
}

# status <loop dir> <requested_at> <idle> <stop_now> <cap_ms> <keys json>
status() {
  jq -n -c --arg at "$2" --argjson idle "$3" --argjson now "$4" --argjson cap "$5" --argjson keys "$6" \
    '{requested_at: $at, started_at: $at, cap_ms: $cap, running: {steps: $keys, gate: false, queue: false, release: false}, idle: $idle, stop_now: $now, at: $at}' \
    > "$1/wind-down.status.json.tmp" && mv "$1/wind-down.status.json.tmp" "$1/wind-down.status.json"
}

# fake_loop <loop dir> <script body>: runs the body in a background subshell once the request
# exists, with $at set to its requested_at. Its PID is the recorded PIDs.
fake_loop() {
  (
    d=$1
    n=0
    while [ ! -f "$d/wind-down.request" ] && [ "$n" -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
    at=$(jq -r .requested_at "$d/wind-down.request")
    eval "$2"
  ) &
  loop_pids="$loop_pids $!"
}

end_loop() {
  for p in $loop_pids; do
    kill "$p" 2>/dev/null || :
    wait "$p" 2>/dev/null || :
  done
  loop_pids=
}

# ev <n> <jq filter>: the nth event's data through jq.
ev() {
  sed -n "${1}p" "$EVENTS" | cut -f2 | jq -r "$2"
}

# common_checks <expected event count>: what every run holds.
common_checks() {
  [ "$rc" -eq 0 ] || fail "$case_name: exit status $rc: $err"
  [ "$(wc -l < "$EVENTS" | tr -d ' ')" -eq "$1" ] || fail "$case_name: wanted $1 event(s): $(cat "$EVENTS")"
  [ "$(wc -l < "$HEARTBEAT_CALLS" | tr -d ' ')" -eq 1 ] || fail "$case_name: heartbeat not called once"
  [ "$(cat "$HEARTBEAT_CALLS")" = --final ] || fail "$case_name: heartbeat wanted --final: $(cat "$HEARTBEAT_CALLS")"
  i=1
  while [ "$i" -le "$1" ]; do
    ev "$i" '
      def t: type == "string" and test("^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$");
      (.requested_at | t) and (.stopped_at | t) and (.waited_ms | type == "number" and . >= 0)
      and (.cap_ms | type == "number") and (.outcome | IN("idle", "cap", "now", "off"))
      and (.running_at_request | type == "number") and (.running_at_request_keys | type == "array")
      and (.cut_at_stop | type == "number") and (.cut_at_stop_keys | type == "array")
      and (.trigger | IN("restart-self", "coder-stop"))
      and ((keys | length) == 10)' | grep -qx true || fail "$case_name: event $i is not a wind_down payload: $(sed -n "${i}p" "$EVENTS")"
    i=$((i + 1))
  done
}

# kept <loop dir>: the request and status stay (the loop starts nothing until the container is
# gone), and the one-shot stop-now file is removed.
kept() {
  [ -f "$1/wind-down.request" ] || fail "$case_name: $1/wind-down.request was removed"
  [ ! -e "$1/wind-down.stop-now" ] || fail "$case_name: $1/wind-down.stop-now was left behind"
}

# nothing_written <loop dir>: an off outcome writes no request.
nothing_written() {
  [ ! -e "$1/wind-down.request" ] || fail "$case_name: $1/wind-down.request was written"
  [ ! -e "$1/wind-down.stop-now" ] || fail "$case_name: $1/wind-down.stop-now was left behind"
}

expect() { # expect <n> <jq filter> <want>
  got=$(ev "$1" "$2")
  [ "$got" = "$3" ] || fail "$case_name: event $1 $2 is '$got', wanted '$3'"
}

KEYS='["i1/la/s1/build/a1","i2/lb/s1/build/a1"]'

# 1. Idle: one busy status, then idle.
case_name=idle
setup idle
fake_loop "$L" 'status "$d" "$at" false false 60000 "$KEYS"; sleep 1; status "$d" "$at" true false 60000 "[]"; sleep 30'
run_script WIND_DOWN_CAP_MS=60000
end_loop
common_checks 1
expect 1 .outcome idle
expect 1 .trigger coder-stop
expect 1 .running_at_request 2
expect 1 '.running_at_request_keys | join(",")' "i1/la/s1/build/a1,i2/lb/s1/build/a1"
expect 1 .cut_at_stop 0
expect 1 '.cut_at_stop_keys | length' 0
expect 1 .cap_ms 60000
[ "$elapsed" -lt 5 ] || fail "$case_name: took ${elapsed}s"
kept "$L"
[ "$(sed -n 1p "$EVENTS" | cut -f1)" = cbundy/demo ] || fail "$case_name: wrong repo: $(cat "$EVENTS")"

# 2. Cap: the template's cap is the smaller one.
case_name=cap-template
setup cap-template
fake_loop "$L" 'while :; do status "$d" "$at" false false 60000 "$KEYS"; sleep 0.2; done'
run_script WIND_DOWN_CAP_MS=2000
end_loop
common_checks 1
expect 1 .outcome cap
expect 1 .cap_ms 2000
expect 1 .cut_at_stop 2
expect 1 '.cut_at_stop_keys | length' 2
expect 1 .running_at_request 2
[ "$elapsed" -le 5 ] || fail "$case_name: took ${elapsed}s"
kept "$L"
[ "$(jq -r .requested_at "$L/wind-down.request")" = "$(ev 1 .requested_at)" ] || fail "$case_name: the request changed"
[ "$(jq -r .trigger "$L/wind-down.request")" = coder-stop ] || fail "$case_name: the request trigger changed"
[ -f "$L/wind-down.status.json" ] || fail "$case_name: the status was removed"

# 3. Cap: the status cap is the smaller one.
case_name=cap-status
setup cap-status
fake_loop "$L" 'while :; do status "$d" "$at" false false 2000 "$KEYS"; sleep 0.2; done'
run_script WIND_DOWN_CAP_MS=60000
end_loop
common_checks 1
expect 1 .outcome cap
expect 1 .cap_ms 2000
expect 1 .cut_at_stop 2
[ "$elapsed" -le 5 ] || fail "$case_name: took ${elapsed}s"
kept "$L"

# 4. Stop-now: the file appears mid-wait; the script ends within a poll or so.
case_name=stop-now
setup stop-now
fake_loop "$L" 'status "$d" "$at" false false 60000 "$KEYS"; sleep 1; : > "$d/wind-down.stop-now"; sleep 30'
run_script WIND_DOWN_CAP_MS=60000
end_loop
common_checks 1
expect 1 .outcome now
expect 1 .cut_at_stop 2
[ "$elapsed" -le 3 ] || fail "$case_name: took ${elapsed}s"
kept "$L"

# 5. Off: the repo layer, the user layer, and the OFF file.
case_name=off-repo
setup off-repo
mkdir -p "$WS/demo/.claude"
echo '{"windDownMinutes": 0}' > "$WS/demo/.claude/factory-loop.json"
run_script WIND_DOWN_CAP_MS=60000
common_checks 1
expect 1 .outcome off
expect 1 .waited_ms 0
expect 1 '.stopped_at == .requested_at' true
expect 1 .running_at_request 0
expect 1 .cut_at_stop 0
expect 1 '.running_at_request_keys | length' 0
nothing_written "$L"

case_name=off-user
setup off-user
echo '{"windDownMinutes": 0}' > "$CFG/factory-loop/config.json"
run_script WIND_DOWN_CAP_MS=60000
common_checks 1
expect 1 .outcome off
nothing_written "$L"

case_name=repo-layer-beats-user
setup repo-layer-beats-user
echo '{"windDownMinutes": 0}' > "$CFG/factory-loop/config.json"
mkdir -p "$WS/demo/.claude"
echo '{"windDownMinutes": 5}' > "$WS/demo/.claude/factory-loop.json"
run_script WIND_DOWN_CAP_MS=1000 WIND_DOWN_FIRST_STATUS_S=1
common_checks 1
expect 1 '.outcome != "off"' true

case_name=off-file
setup off-file
: > "$CFG/factory-loop/OFF"
run_script WIND_DOWN_CAP_MS=60000
common_checks 1
expect 1 .outcome off
nothing_written "$L"

# 6. No loop dir: no event, no files, the heartbeat still runs.
case_name=no-loop
setup no-loop
rmdir "$L"
run_script WIND_DOWN_CAP_MS=60000
common_checks 0
[ -z "$(ls -A "$CFG/factory-loop")" ] || fail "$case_name: created files: $(ls -A "$CFG/factory-loop")"

# 7. Restart-self: a fresh request is kept, a stale one is replaced.
case_name=restart-self
setup restart-self
at=$(date -u '+%Y-%m-%dT%H:%M:%S.%3NZ')
echo "{\"requested_at\": \"$at\", \"trigger\": \"restart-self\"}" > "$L/wind-down.request"
fake_loop "$L" 'status "$d" "$at" true false 60000 "[]"; sleep 30'
run_script WIND_DOWN_CAP_MS=60000
end_loop
common_checks 1
expect 1 .trigger restart-self
expect 1 .requested_at "$at"
expect 1 .outcome idle
kept "$L"

case_name=restart-self-stale
setup restart-self-stale
echo '{"requested_at": "2020-01-01T00:00:00.000Z", "trigger": "restart-self"}' > "$L/wind-down.request"
run_script WIND_DOWN_CAP_MS=1000 WIND_DOWN_FIRST_STATUS_S=1
common_checks 1
expect 1 .trigger coder-stop
expect 1 '.requested_at != "2020-01-01T00:00:00.000Z"' true

# 8. No status: the loop is not passing, so there is nothing to wait for.
case_name=no-status
setup no-status
run_script WIND_DOWN_CAP_MS=60000 WIND_DOWN_FIRST_STATUS_S=1
common_checks 1
expect 1 .outcome idle
expect 1 .running_at_request 0
expect 1 .cut_at_stop 0
[ "$elapsed" -le 4 ] || fail "$case_name: took ${elapsed}s"
kept "$L"

# 9. A stale status (another requested_at) says idle and is ignored.
case_name=stale-status
setup stale-status
status "$L" "2020-01-01T00:00:00.000Z" true false 60000 "[]"
run_script WIND_DOWN_CAP_MS=1500 WIND_DOWN_FIRST_STATUS_S=60
common_checks 1
expect 1 .outcome cap
kept "$L"

# 10. Two loops wind down together, each with its own event.
case_name=two-loops
setup two-loops
L2=$CFG/factory-loop/cbundy__other
mkdir -p "$L2"
fake_loop "$L" 'status "$d" "$at" true false 60000 "[]"; sleep 30'
fake_loop "$L2" 'status "$d" "$at" false false 60000 "$KEYS"; sleep 1; status "$d" "$at" true false 60000 "[]"; sleep 30'
run_script WIND_DOWN_CAP_MS=60000
end_loop
common_checks 2
cut -f1 "$EVENTS" | sort | tr '\n' ' ' | grep -qx 'cbundy/demo cbundy/other ' || fail "$case_name: repos: $(cut -f1 "$EVENTS")"
kept "$L"
kept "$L2"

# 11. callum-flow-event missing: a warning, exit 0.
case_name=no-event-cli
setup no-event-cli
: > "$CFG/factory-loop/OFF"
rm "$bin/callum-flow-event"
run_script WIND_DOWN_CAP_MS=60000 PATH="/usr/bin:/bin"
[ "$rc" -eq 0 ] || fail "$case_name: exit status $rc"
case "$err" in *callum-flow-event*) ;; *) fail "$case_name: no warning on stderr: $err" ;; esac
[ "$(cat "$HEARTBEAT_CALLS")" = --final ] || fail "$case_name: heartbeat not called"

# 12. The payload passes the real callum-flow-event shapes check.
case_name=real-event
setup real-event
: > "$CFG/factory-loop/OFF"
ln -s "$REAL_EVENT" "$bin/callum-flow-event"
events_dir=$case_dir/events-dir
mkdir -p "$events_dir"
run_script WIND_DOWN_CAP_MS=60000 CALLUM_EVENTS_DIR="$events_dir" DEV_SYSTEM_SHARE="$ROOT/images/base"
[ "$rc" -eq 0 ] || fail "$case_name: exit status $rc"
case "$err" in *warning*) fail "$case_name: warning on stderr: $err" ;; esac
grep -rq '"wind_down"' "$events_dir" || fail "$case_name: no wind_down event written under $events_dir"

# 13. The start script clears all three files in every loop dir, and says which request it cleared.
START=$ROOT/coder/dev-system/wind-down-start.sh
[ -f "$START" ] || fail "$START is missing"
run_start() { # run_start: runs the start script; leaves $rc and $out
  rc=0
  out=$(env CLAUDE_CONFIG_DIR="$CFG" sh "$START" 2>&1) || rc=$?
}

case_name=clears_on_start
setup clears_on_start
L2=$CFG/factory-loop/cbundy__other
L3=$CFG/factory-loop/not-a-loop-dir__
mkdir -p "$L2" "$L3"
for d in "$L" "$L2" "$L3"; do
  echo '{"requested_at": "2026-10-18T10:00:00.000Z", "trigger": "coder-stop"}' > "$d/wind-down.request"
  : > "$d/wind-down.status.json"
  : > "$d/wind-down.stop-now"
done
mkdir -p "$CFG/factory-loop/-bad__dir"
: > "$CFG/factory-loop/-bad__dir/wind-down.request"
run_start
[ "$rc" -eq 0 ] || fail "$case_name: exit status $rc: $out"
for d in "$L" "$L2"; do
  for f in wind-down.request wind-down.status.json wind-down.stop-now; do
    [ ! -e "$d/$f" ] || fail "$case_name: $d/$f was left behind"
  done
done
[ -e "$L3/wind-down.request" ] || fail "$case_name: removed from a dir failing the name filter"
[ -e "$CFG/factory-loop/-bad__dir/wind-down.request" ] || fail "$case_name: removed from a dir failing the name filter"
[ "$(printf '%s\n' "$out" | grep -c 'requested_at 2026-10-18T10:00:00.000Z, trigger coder-stop')" -eq 2 ] || fail "$case_name: wanted one line per request: $out"
printf '%s\n' "$out" | grep -q "$L2" || fail "$case_name: no line names $L2: $out"

case_name=startnoloop
setup startnoloop
rmdir "$L"
run_start
[ "$rc" -eq 0 ] || fail "$case_name: exit status $rc: $out"
[ -z "$out" ] || fail "$case_name: printed: $out"
rm -rf "$CFG/factory-loop"
run_start
[ "$rc" -eq 0 ] || fail "$case_name: no factory-loop dir: exit status $rc: $out"

case_name=startunwritable
setup startunwritable
echo '{"requested_at": "2026-10-18T10:00:00.000Z", "trigger": "coder-stop"}' > "$L/wind-down.request"
chmod 555 "$L"
run_start
chmod 755 "$L"
[ "$rc" -eq 0 ] || fail "$case_name: exit status $rc: $out"

# Terraform inlines the start script into the startup script: no template sequences, no exit.
if grep -Eq '\$\{|%\{' "$START"; then fail "wind-down-start.sh holds a Terraform template sequence"; fi
if grep -Eq '(^|[^A-Za-z_])exit([^A-Za-z_]|$)' "$START"; then fail "wind-down-start.sh uses exit"; fi

echo "wind-down tests passed"
