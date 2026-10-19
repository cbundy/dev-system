#!/bin/sh
#
# The Coder stop script of the loop template (run_on_stop): asks each factory loop on this
# workspace to wind down (finish what runs, start nothing), waits for it, writes one wind_down
# event per loop, and gives the heartbeat its final beat. It leaves the request and status files in
# place (the next workspace start clears them, wind-down-start.sh). Spec: docs/factory-loop/v2/SPEC.md 10.11.
#
# A stop script that fails must never hold or break a stop: this uses `set -u`, never `-e`, and
# always exits 0. main.tf puts WIND_DOWN_CAP_MS (the template's wind_down_minutes in ms) in front
# of it. Every input is an environment variable with a default, so tests can point it at a fake:
#   CLAUDE_CONFIG_DIR         default /persist/claude
#   WIND_DOWN_WORKSPACES      default /workspaces (the repo layer of the config is under it)
#   WIND_DOWN_CAP_MS          the template's cap
#   WIND_DOWN_POLL_S          default 2
#   WIND_DOWN_FIRST_STATUS_S  default 180: no status by then means the loop is not passing
#   WIND_DOWN_HEARTBEAT       default /usr/local/share/dev-system/heartbeat-loop
set -u

CONFIG_DIR=${CLAUDE_CONFIG_DIR:-/persist/claude}
WORKSPACES=${WIND_DOWN_WORKSPACES:-/workspaces}
CAP_MS=${WIND_DOWN_CAP_MS:-600000}
POLL_S=${WIND_DOWN_POLL_S:-2}
FIRST_STATUS_S=${WIND_DOWN_FIRST_STATUS_S:-180}
HEARTBEAT=${WIND_DOWN_HEARTBEAT:-/usr/local/share/dev-system/heartbeat-loop}
BASE=${CONFIG_DIR%/}/factory-loop

# stamp: sets NOW_ISO (UTC, three millisecond digits) and NOW_MS from one clock read.
stamp() {
  _s=$(date -u '+%Y-%m-%dT%H:%M:%S.%3NZ %s%3N' 2>/dev/null) || _s=
  NOW_ISO=${_s% *}
  NOW_MS=${_s#* }
}

# iso_ms: an ISO time as epoch milliseconds, empty when it does not parse.
iso_ms() {
  date -u -d "$1" '+%s%3N' 2>/dev/null
}

# wind_down_minutes_of <repo>: the loop's effective windDownMinutes: the repo layer, then the
# user layer, else 10 (register.ts runtime; config.ts default).
wind_down_minutes_of() {
  _q='if (.windDownMinutes | type) == "number" and .windDownMinutes >= 0 and .windDownMinutes == (.windDownMinutes | floor) then .windDownMinutes else empty end'
  _v=$(jq -r "$_q" "$WORKSPACES/$1/.claude/factory-loop.json" 2>/dev/null | head -n 1)
  [ -n "$_v" ] || _v=$(jq -r "$_q" "$BASE/config.json" 2>/dev/null | head -n 1)
  printf '%s' "${_v:-10}"
}

# emit <owner/repo> <json>: one event; a missing callum-flow-event only warns.
emit() {
  if command -v callum-flow-event >/dev/null 2>&1; then
    timeout 15 callum-flow-event --type wind_down --repo "$1" --data "$2" \
      || echo "wind-down: callum-flow-event failed for $1" >&2
  else
    echo "wind-down: warning: callum-flow-event is not on PATH; no wind_down event for $1" >&2
  fi
}

# wind_one <loop dir name>: the whole wind-down of one loop. Runs in a background subshell.
wind_one() {
  name=$1
  dir=$BASE/$name
  owner=${name%%__*}
  repo=${name#*__}
  req=$dir/wind-down.request
  status=$dir/wind-down.status.json
  stopnow=$dir/wind-down.stop-now
  stamp
  begin_ms=$NOW_MS
  trigger=coder-stop
  requested_at=$NOW_ISO
  outcome=
  running=0
  running_keys='[]'
  cut=0
  cut_keys='[]'
  cap=$CAP_MS
  have_first=0

  minutes=$(wind_down_minutes_of "$repo")
  if [ "$minutes" = 0 ] || [ -e "${BASE}/OFF" ]; then
    outcome=off
    stopped_at=$requested_at
    waited=0
  else
    # a fresh restart-self request is kept: its time and trigger stand
    keep=0
    if [ -f "$req" ] && [ "$(jq -r '.trigger // empty' "$req" 2>/dev/null)" = restart-self ]; then
      at=$(jq -r '.requested_at // empty' "$req" 2>/dev/null)
      at_ms=$(iso_ms "$at")
      if [ -n "$at_ms" ] && [ "$at_ms" -le $((NOW_MS + 60000)) ] && [ $((NOW_MS - at_ms)) -le $((CAP_MS + 300000)) ]; then
        keep=1
        requested_at=$at
        trigger=restart-self
      fi
    fi
    if [ "$keep" = 0 ]; then
      jq -n -c --arg at "$requested_at" '{requested_at: $at, trigger: "coder-stop"}' > "$req.tmp.$$" 2>/dev/null \
        && mv "$req.tmp.$$" "$req" 2>/dev/null
      rm -f "$req.tmp.$$"
    fi
    req_ms=$(iso_ms "$requested_at")
    [ -n "$req_ms" ] || req_ms=$NOW_MS
    while :; do
      if [ -e "$stopnow" ]; then outcome=now; fi
      if [ -f "$status" ]; then
        line=$(jq -r 'select(type == "object") | [.requested_at, (.idle == true), (.stop_now == true), (.cap_ms // "" | tostring), ((.running.steps // []) | length), ((.running.steps // []) | tojson)] | @tsv' "$status" 2>/dev/null)
        if [ -n "$line" ]; then
          IFS='	' read -r s_at s_idle s_now s_cap s_n s_keys <<EOF2
$line
EOF2
          if [ "$s_at" = "$requested_at" ]; then
            if [ "$have_first" = 0 ]; then
              have_first=1
              running=$s_n
              running_keys=$s_keys
            fi
            cut=$s_n
            cut_keys=$s_keys
            case "$s_cap" in
              '' | *[!0-9]*) ;;
              *) [ "$s_cap" -lt "$cap" ] && cap=$s_cap ;;
            esac
            if [ -z "$outcome" ]; then
              if [ "$s_now" = true ]; then
                outcome=now
              elif [ "$s_idle" = true ]; then
                outcome=idle
              fi
            fi
          fi
        fi
      fi
      stamp
      if [ -z "$outcome" ]; then
        if [ $((NOW_MS - req_ms)) -ge "$cap" ]; then
          outcome=cap
        elif [ "$have_first" = 0 ] && [ $((NOW_MS - begin_ms)) -ge $((FIRST_STATUS_S * 1000)) ]; then
          # the loop is not passing: it has no steps to wait for
          outcome=idle
          running=0
          running_keys='[]'
        fi
      fi
      [ -z "$outcome" ] || break
      sleep "$POLL_S"
    done
    stamp
    stopped_at=$NOW_ISO
    waited=$((NOW_MS - req_ms))
    [ "$waited" -ge 0 ] || waited=0
    case "$outcome" in
      idle) cut=0 cut_keys='[]' ;;
    esac
    [ "$have_first" = 1 ] || { cut=0; cut_keys='[]'; }
  fi
  if [ "$outcome" = off ]; then
    cap=$CAP_MS
  fi

  data=$(jq -n -c \
    --arg requested_at "$requested_at" --arg stopped_at "$stopped_at" \
    --argjson waited_ms "$waited" --argjson cap_ms "$cap" --arg outcome "$outcome" \
    --argjson running "$running" --argjson running_keys "$running_keys" \
    --argjson cut "$cut" --argjson cut_keys "$cut_keys" --arg trigger "$trigger" \
    '{requested_at: $requested_at, stopped_at: $stopped_at, waited_ms: $waited_ms, cap_ms: $cap_ms,
      outcome: $outcome, running_at_request: $running, running_at_request_keys: $running_keys,
      cut_at_stop: $cut, cut_at_stop_keys: $cut_keys, trigger: $trigger}' 2>/dev/null)
  if [ -n "$data" ]; then
    emit "$owner/$repo" "$data"
  else
    echo "wind-down: could not build the event for $name" >&2
  fi
  # The stop-now file is one shot, consumed by this stop. The request and status stay: the
  # container still runs until Coder stops it, and the loop must start nothing in those seconds
  # (#931). The workspace's next start clears them (wind-down-start.sh, v2 SPEC 10.11).
  rm -f "$dir/wind-down.stop-now"
}

pids=
if command -v jq >/dev/null 2>&1; then
  for d in "$BASE"/*__*; do
    [ -d "$d" ] || continue
    n=${d##*/}
    case "$n" in
      *[!A-Za-z0-9._-]* | [!A-Za-z0-9]* | __* | *__) continue ;;
    esac
    wind_one "$n" &
    pids="$pids $!"
  done
else
  echo "wind-down: warning: jq is not installed; no wind-down" >&2
fi
for p in $pids; do
  wait "$p"
done

# the final heartbeat, so the stop shows as a stop
if [ -x "$HEARTBEAT" ]; then
  timeout 10 "$HEARTBEAT" --final || true
fi
exit 0
