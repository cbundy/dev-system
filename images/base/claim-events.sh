# claim-events.sh - the one rule for who holds an issue's claim, sourced (POSIX sh) by
# callum-flow-claim and callum-flow-sweep. Found through CALLUM_FLOW_SHARE_DIR (default
# /usr/local/share/dev-system), the way callum-flow-issue-read finds trusted-authors.sh.
#
# The claim events are the states that start or end a claim; no other state counts. The
# noise states are housekeeping that is no lifecycle event of an issue: the factory loop's
# bookkeeping, review results and interventions. Both lists live here and nowhere else.
#
# An issue is HELD by a device when its last claim event is a `claimed` by that device.
# The events are this device's own log plus, when dev-query is configured, the newest claim
# event per issue in factory.events (with its device), ordered by ts. A failed central read
# warns and falls back to this device's log; exit 78 (not configured) falls back silently.
#
# The caller sets before calling: DEVQ (the dev-query command), EVENT (callum-flow-event),
# repo, CE_TOOL (its name, for warnings).

CE_CLAIM_JQ='"claimed", "ready", "reclaimed", "merged", "closed", "abandoned"'
CE_NOISE_JQ='"untrusted_stripped", "usage", "watcher_error", "test_weakened", "claim_lost", "renewed", "loop", "reviewed", "intervention", "prompt_denied", "prompt_waiting"'
CE_CLAIM_SQL=$(printf '%s' "$CE_CLAIM_JQ" | tr '"' "'")
CE_NOISE_SQL=$(printf '%s' "$CE_NOISE_JQ" | tr '"' "'")

# ce_device: this device's name (DEV_MACHINE_NAME, else the hostname)
ce_device() {
  _d=${DEV_MACHINE_NAME:-}
  [ -n "$_d" ] || _d=$(hostname 2>/dev/null) || _d=
  [ -n "$_d" ] || _d=$(cat /etc/hostname 2>/dev/null) || _d=unknown
  printf '%s\n' "$_d"
}

# ce_read_central OUT: JSON lines {ts, issue, state, device} of the latest lifecycle event
# and the latest claim event per issue in factory.events. OUT is empty when dev-query is
# absent or not configured (exit 78); a failure warns and leaves it empty.
ce_read_central() {
  : > "$1"
  command -v "$DEVQ" >/dev/null 2>&1 || return 0
  _rc=0
  "$DEVQ" -At -v "repo=$repo" -c "SELECT DISTINCT ON (issue, state IN ($CE_CLAIM_SQL)) to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') || '|' || issue || '|' || state || '|' || COALESCE(device, '')
    FROM factory.events WHERE repo = :'repo' AND issue IS NOT NULL
      AND state NOT IN ($CE_NOISE_SQL) ORDER BY issue, state IN ($CE_CLAIM_SQL), ts DESC, seq DESC" \
    > "$1.raw" 2> /dev/null < /dev/null || _rc=$?
  if [ "$_rc" -eq 0 ]; then
    jq -R -c 'split("|") | select(length == 4) | {ts: .[0], issue: (.[1] | tonumber), state: .[2], device: .[3]}' "$1.raw" > "$1" 2> /dev/null || : > "$1"
  elif [ "$_rc" -ne 78 ]; then
    echo "$CE_TOOL: warning: cannot read the central event log (dev-query exit $_rc), using this device's log only" >&2
  fi
  return 0
}

# ce_read_local OUT DEVICE: JSON lines {ts, issue, state, device} of this device's own
# lifecycle events. Fails only when the log's path cannot be located; a device with no log
# has no rows.
ce_read_local() {
  : > "$1"
  _lf=$("$EVENT" --path --repo "$repo" 2> /dev/null) || return 1
  [ -f "$_lf" ] || return 0
  jq -R -c --arg dev "$2" --argjson noise "[$CE_NOISE_JQ]" \
    'fromjson? | select(type == "object" and (.issue | type) == "number" and (.state | IN($noise[]) | not))
      | {ts: .ts, issue: .issue, state: .state, device: $dev}' "$_lf" > "$1" 2> /dev/null || : > "$1"
  return 0
}

# ce_load DIR DEVICE: build DIR/central, DIR/local and DIR/latest. Returns 1 when this
# device's log cannot be located (the other files are still built). DIR/latest has one line
# per issue, ordered by ts (jq sorts stably, so equal timestamps keep file order: central
# first, then this device's log):
#   <issue> <latest lifecycle state> <latest claim state or none> <its device or ->
ce_load() {
  ce_read_central "$1/central"
  _lrc=0
  ce_read_local "$1/local" "$2" || _lrc=1
  cat "$1/central" "$1/local" | jq -s -r --argjson claimev "[$CE_CLAIM_JQ]" \
    'sort_by(.ts) | group_by(.issue) | .[]
      | (map(select(.state | IN($claimev[]))) | last) as $c
      | "\(last | .issue) \(last | .state) \($c.state // "none") \(($c.device // "") | if . == "" then "-" else . end)"' \
    > "$1/latest" 2> /dev/null || : > "$1/latest"
  return "$_lrc"
}

# ce_held LATEST DEVICE [ISSUE]: the issues DEVICE holds (its last claim event is a `claimed`
# by it); with ISSUE, succeeds when that issue is held.
ce_held() {
  if [ $# -ge 3 ]; then
    awk -v dev="$2" -v n="$3" '$1 == n && $3 == "claimed" && $4 == dev { f = 1 } END { exit !f }' "$1"
  else
    awk -v dev="$2" '$3 == "claimed" && $4 == dev { print $1 }' "$1"
  fi
}
