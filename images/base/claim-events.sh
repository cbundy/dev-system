# claim-events.sh - the one rule for who holds an issue's claim, sourced (POSIX sh) by
# fabriek-claim and fabriek-sweep. Found through FABRIEK_SHARE_DIR (default
# /usr/local/share/dev-system), the way fabriek-issue-read finds trusted-authors.sh.
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
# Source switch (cbundy/dev-system#905, docs/factory-events/replay.md "Source switch"):
# FABRIEK_CLAIM_EVENTS_SOURCE picks the store the rule reads.
#   old     factory.events through dev-query, and this device's old log (fabriek-event --path).
#           The way back: FABRIEK_CLAIM_EVENTS_SOURCE=old.
#   new     (the default, also when unset or empty) factory.event_log through dev-query --factory, and this device's new log
#           (fabriek-event --new-path). The new type names are read by name; requeued is
#           mapped back to reclaimed in DIR/latest, so ce_held and the sweep see one vocabulary.
#   shadow  opt-in, to re-measure: decide on old exactly as `old` does, then read both
#           sides over a window and write one shadow_read event (reader claim-events, tool
#           CE_TOOL) with how many issues the two sides decide differently. The decision never
#           depends on the new side, and a failed write only warns.
# Any other value warns once and uses old: the rule is sourced in the heartbeat and the sweep and
# must never fail them. The compared value per repo#issue is what the rule decides on: the
# lifecycle class (closed, abandoned or other), the latest claim type and its device.
# FABRIEK_SHADOW_WINDOW_SECONDS (default 604800) is how far back both sides are read (the
# production new store holds only dual-written events); `differences` counts the window cut
# FABRIEK_SHADOW_SETTLE_SECONDS (default 600) before now, so push lag is not a difference, and
# `live_differences` the whole window. Cuts are at whole seconds on both sides and both local logs.
# The window also reaches back before the new store's history: it holds only dual-written events and
# is not backfilled. So the shadow reads each device's first time in factory.event_log for the repo
# (the floor) once, and leaves out of both sides, and both local logs, every event of a device older
# than that floor. A device with no new row keeps all its events and still shows as a difference.
# The shadow_read event names this device's floor as scope_floor (null when it has none). The decision
# paths (ce_load without shadow, ce_held) do not read floors.
#
# The caller sets before calling: DEVQ (the dev-query command), EVENT (fabriek-event),
# repo, CE_TOOL (its name, for warnings).

CE_CLAIM_JQ='"claimed", "ready", "reclaimed", "merged", "closed", "abandoned"'
CE_NOISE_JQ='"untrusted_stripped", "usage", "watcher_error", "test_weakened", "claim_lost", "renewed", "loop", "reviewed", "intervention", "prompt_denied", "prompt_waiting"'
CE_CLAIM_SQL=$(printf '%s' "$CE_CLAIM_JQ" | tr '"' "'")
CE_NOISE_SQL=$(printf '%s' "$CE_NOISE_JQ" | tr '"' "'")
# The new side selects by name: the claim types, and the lifecycle types (those plus the types
# that stand in for the old verdict, delegated, fix_requested and merge_ready lines).
CE_NEW_CLAIM_JQ='"claimed", "ready", "requeued", "merged", "closed", "abandoned"'
CE_NEW_LIFE_JQ='"claimed", "ready", "requeued", "merged", "closed", "abandoned", "transition", "finding_handled", "implementer_routed"'
CE_NEW_CLAIM_SQL=$(printf '%s' "$CE_NEW_CLAIM_JQ" | tr '"' "'")
CE_NEW_LIFE_SQL=$(printf '%s' "$CE_NEW_LIFE_JQ" | tr '"' "'")

# ce_device: this device's name (DEV_MACHINE_NAME, else the hostname)
ce_device() {
  _d=${DEV_MACHINE_NAME:-}
  [ -n "$_d" ] || _d=$(hostname 2>/dev/null) || _d=
  [ -n "$_d" ] || _d=$(cat /etc/hostname 2>/dev/null) || _d=unknown
  printf '%s\n' "$_d"
}

# ce_source: sets CE_SRC to old, new or shadow from FABRIEK_CLAIM_EVENTS_SOURCE.
ce_source() {
  case "${FABRIEK_CLAIM_EVENTS_SOURCE:-}" in
    '' | new) CE_SRC=new ;;
    shadow) CE_SRC=shadow ;;
    old) CE_SRC=old ;;
    *)
      if [ "${CE_WARNED_SRC:-}" != "${FABRIEK_CLAIM_EVENTS_SOURCE}" ]; then
        echo "${CE_TOOL:-claim-events}: warning: FABRIEK_CLAIM_EVENTS_SOURCE='${FABRIEK_CLAIM_EVENTS_SOURCE}' is not old, new or shadow, reading the old log" >&2
        CE_WARNED_SRC=${FABRIEK_CLAIM_EVENTS_SOURCE}
      fi
      CE_SRC=old
      ;;
  esac
}

# ce_read_central SIDE OUT [SINCE [UNTIL [FLOORS]]]: JSON lines {ts, issue, state, device} of the latest
# lifecycle event and the latest claim event per issue, SIDE old (factory.events) or new
# (factory.event_log through dev-query --factory). SINCE and UNTIL are ISO times cut at whole
# seconds: the rows read are ts >= SINCE and ts < UNTIL (none given: all). FLOORS, when given, is a
# JSON object of ISO time by device: a row of a device in it, older than its time, is left out
# before the latest per issue is picked. OUT is empty when
# dev-query is absent or not configured (exit 78); a failure warns (unless CE_QUIET is set) and
# leaves it empty. CE_RC is the dev-query exit status (127 when it is absent).
ce_read_central() {
  _cside=$1 _cout=$2 _csince=${3:-} _cuntil=${4:-} _cfloors=${5:-}
  : > "$_cout"
  CE_RC=127
  command -v "$DEVQ" >/dev/null 2>&1 || return 0
  _crc=0
  _cw=''
  set -- -At -v "repo=$repo"
  if [ -n "$_csince" ]; then
    _cw="$_cw AND ts >= :'since'::timestamptz"
    set -- "$@" -v "since=$_csince"
  fi
  if [ -n "$_cuntil" ]; then
    _cw="$_cw AND ts < :'until'::timestamptz"
    set -- "$@" -v "until=$_cuntil"
  fi
  if [ -n "$_cfloors" ]; then
    _cw="$_cw AND ((:'floors'::jsonb ->> device) IS NULL OR ts >= (:'floors'::jsonb ->> device)::timestamptz)"
    set -- "$@" -v "floors=$_cfloors"
  fi
  if [ "$_cside" = new ]; then
    "$DEVQ" --factory "$@" -c "SELECT DISTINCT ON (issue, type IN ($CE_NEW_CLAIM_SQL)) to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') || '|' || issue || '|' || type || '|' || COALESCE(device, '')
      FROM factory.event_log WHERE repo = :'repo' AND issue IS NOT NULL${_cw}
        AND type IN ($CE_NEW_LIFE_SQL) ORDER BY issue, type IN ($CE_NEW_CLAIM_SQL), ts DESC, device DESC, device_seq DESC" \
      > "$_cout.raw" 2> /dev/null < /dev/null || _crc=$?
  else
    "$DEVQ" "$@" -c "SELECT DISTINCT ON (issue, state IN ($CE_CLAIM_SQL)) to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') || '|' || issue || '|' || state || '|' || COALESCE(device, '')
      FROM factory.events WHERE repo = :'repo' AND issue IS NOT NULL${_cw}
        AND state NOT IN ($CE_NOISE_SQL) ORDER BY issue, state IN ($CE_CLAIM_SQL), ts DESC, seq DESC" \
      > "$_cout.raw" 2> /dev/null < /dev/null || _crc=$?
  fi
  CE_RC=$_crc
  if [ "$_crc" -eq 0 ]; then
    jq -R -c 'split("|") | select(length == 4) | {ts: .[0], issue: (.[1] | tonumber), state: .[2], device: .[3]}' "$_cout.raw" > "$_cout" 2> /dev/null || : > "$_cout"
  elif [ "$_crc" -ne 78 ] && [ -z "${CE_QUIET:-}" ]; then
    if [ "$_cside" = new ]; then
      echo "$CE_TOOL: warning: cannot read the central event log (new source, dev-query --factory exit $_crc), using this device's log only" >&2
    else
      echo "$CE_TOOL: warning: cannot read the central event log (dev-query exit $_crc), using this device's log only" >&2
    fi
  fi
  return 0
}

# ce_read_local SIDE OUT DEVICE [SINCE [UNTIL]]: JSON lines {ts, issue, state, device} of this
# device's own lifecycle events, from the old log (SIDE old) or the new one (SIDE new), cut as
# ce_read_central cuts. Fails only when the log's path cannot be located; a device with no log
# has no rows.
ce_read_local() {
  _lside=$1 _lout=$2 _ldev=$3 _lsince=${4:-} _luntil=${5:-}
  : > "$_lout"
  if [ "$_lside" = new ]; then
    _lf=$("$EVENT" --new-path --repo "$repo" 2> /dev/null) || return 1
    [ -f "$_lf" ] || return 0
    jq -R -c --arg dev "$_ldev" --arg since "$_lsince" --arg until "$_luntil" --argjson life "[$CE_NEW_LIFE_JQ]" \
      'fromjson? | select(type == "object" and (.issue | type) == "number" and (.type | IN($life[])))
        | select(($since == "" or ((.ts | type) == "string" and .ts[0:19] >= $since[0:19])) and ($until == "" or ((.ts | type) == "string" and .ts[0:19] < $until[0:19])))
        | {ts: .ts, issue: .issue, state: .type, device: $dev}' "$_lf" > "$_lout" 2> /dev/null || : > "$_lout"
    return 0
  fi
  _lf=$("$EVENT" --path --repo "$repo" 2> /dev/null) || return 1
  [ -f "$_lf" ] || return 0
  jq -R -c --arg dev "$_ldev" --arg since "$_lsince" --arg until "$_luntil" --argjson noise "[$CE_NOISE_JQ]" \
    'fromjson? | select(type == "object" and (.issue | type) == "number" and (.state | IN($noise[]) | not))
      | select(($since == "" or ((.ts | type) == "string" and .ts[0:19] >= $since[0:19])) and ($until == "" or ((.ts | type) == "string" and .ts[0:19] < $until[0:19])))
      | {ts: .ts, issue: .issue, state: .state, device: $dev}' "$_lf" > "$_lout" 2> /dev/null || : > "$_lout"
  return 0
}

# ce_build_latest DIR SIDE: build DIR/latest from DIR/central and DIR/local. One line per issue,
# ordered by ts (jq sorts stably, so equal timestamps keep file order: central first, then this
# device's log):
#   <issue> <latest lifecycle state> <latest claim state or none> <its device or ->
# The new side's requeued is written reclaimed, so both sides share one vocabulary.
ce_build_latest() {
  if [ "$2" = new ]; then _bclaims=$CE_NEW_CLAIM_JQ; else _bclaims=$CE_CLAIM_JQ; fi
  cat "$1/central" "$1/local" | jq -s -r --argjson claimev "[$_bclaims]" \
    'sort_by(.ts) | group_by(.issue) | .[]
      | (map(select(.state | IN($claimev[]))) | last) as $c
      | "\(last | .issue) \(last | .state | if . == "requeued" then "reclaimed" else . end) \($c.state // "none" | if . == "requeued" then "reclaimed" else . end) \(($c.device // "") | if . == "" then "-" else . end)"' \
    > "$1/latest" 2> /dev/null || : > "$1/latest"
}

# ce_load DIR DEVICE: build DIR/central, DIR/local and DIR/latest (ce_build_latest) from the
# source ce_source names. Returns 1 when this device's log cannot be located (the other files
# are still built). In shadow mode the decision is built from the old side, then ce_shadow
# records how the new side compares; that never changes the status.
ce_load() {
  ce_source
  _kdir=$1 _kdev=$2
  _kside=old
  [ "$CE_SRC" != new ] || _kside=new
  CE_QUIET=''
  ce_read_central "$_kside" "$_kdir/central"
  _krc=0
  ce_read_local "$_kside" "$_kdir/local" "$_kdev" || _krc=1
  ce_build_latest "$_kdir" "$_kside"
  if [ "$CE_SRC" = shadow ]; then ce_shadow "$_kdir" "$_kdev" || :; fi
  return "$_krc"
}

# ce_tuples LATEST: one line per issue, `<issue> <class> <claim type> <device>`: what the rule
# decides on. The class is closed, abandoned or other; the claim type is in the new names.
ce_tuples() {
  awk '{ c = ($2 == "closed" || $2 == "abandoned") ? $2 : "other"; t = ($3 == "reclaimed") ? "requeued" : $3; print $1, c, t, $4 }' "$1"
}

# ce_diff OLD_TUPLES NEW_TUPLES: `D <issue> <old tuple> | <new tuple>` for each issue the two
# files decide differently (a missing one reads `none`), by issue number, then `N <issues>`.
ce_diff() {
  awk -v f1="$1" '
    FILENAME == f1 { o[$1] = $2 " " $3 " " $4; k[$1] = 1; next }
    { n[$1] = $2 " " $3 " " $4; k[$1] = 1 }
    END {
      for (i in k) {
        a = (i in o) ? o[i] : "none"; b = (i in n) ? n[i] : "none"
        if (a != b) print "D", i, a, "|", b
        c++
      }
      print "N", c + 0
    }' "$1" "$2" | sort -k1,1 -k2,2n
}

# ce_read_floors OUT: sets CE_FLOORS to the JSON object of each device's first time in the new store
# (factory.event_log) for the repo, in whole seconds, by device. CE_RC is the dev-query exit status
# (127 when it is absent); on a failure CE_FLOORS is empty. The shadow's compare alone reads it.
ce_read_floors() {
  CE_FLOORS=''
  CE_RC=127
  command -v "$DEVQ" >/dev/null 2>&1 || return 0
  _frc=0
  "$DEVQ" --factory -At -v "repo=$repo" -c "SELECT device || '|' || to_char(date_trunc('second', min(ts)) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')
      FROM factory.event_log WHERE repo = :'repo' AND device IS NOT NULL GROUP BY device ORDER BY device" \
    > "$1.raw" 2> /dev/null < /dev/null || _frc=$?
  CE_RC=$_frc
  if [ "$_frc" -eq 0 ]; then
    CE_FLOORS=$(jq -R -s -c 'split("\n") | map(select(contains("|")) | split("|") | {key: .[0], value: .[1]}) | from_entries' "$1.raw" 2> /dev/null) || CE_FLOORS=''
    [ -n "$CE_FLOORS" ] || CE_RC=1
  elif [ "$_frc" -ne 78 ] && [ -z "${CE_QUIET:-}" ]; then
    echo "$CE_TOOL: warning: cannot read the central event log (new source, dev-query --factory exit $_frc), using this device's log only" >&2
  fi
  return 0
}

# ce_side DIR SIDE DEVICE SINCE UNTIL [FLOORS]: the latest file DIR/latest of one side over one window,
# without the events older than their device's floor (FLOORS as ce_read_central takes it; this
# device's local log is cut at its own floor, as late as SINCE). Sets CE_SIDE_OK to 0 when its central
# read or its local log failed (not configured counts as a failure here: a compare needs both sides).
ce_side() {
  mkdir -p "$1" 2> /dev/null || return 1
  CE_SIDE_OK=0
  _sdsince=$4
  if [ -n "${6:-}" ]; then
    _sdsince=$(printf '%s' "$6" | jq -r --arg d "$3" --arg s "$4" '[(.[$d] // ""), $s] | max' 2> /dev/null) || _sdsince=$4
  fi
  ce_read_central "$2" "$1/central" "$4" "$5" "${6:-}"
  [ "$CE_RC" -ne 0 ] || CE_SIDE_OK=1
  ce_read_local "$2" "$1/local" "$3" "$_sdsince" "$5" || CE_SIDE_OK=0
  ce_build_latest "$1" "$2"
}

# ce_shadow DIR DEVICE: the shadow compare and its shadow_read event (see the header). Nothing
# is recorded when dev-query is absent or not configured (exit 78) on either side: there is
# nothing to compare. A failing write warns once.
ce_shadow() {
  _swin=${FABRIEK_SHADOW_WINDOW_SECONDS:-604800}
  _sset=${FABRIEK_SHADOW_SETTLE_SECONDS:-600}
  case $_swin in '' | *[!0-9]*) _swin=604800 ;; esac
  case $_sset in '' | *[!0-9]*) _sset=600 ;; esac
  _snow=$(date -u +%s) || return 0
  _siso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
  _ssince=$(_siso $((_snow - _swin))) || return 0
  _scut=$(_siso $((_snow - _sset))) || return 0
  _slive=$(_siso $((_snow + 1))) || return 0
  _sd="$1/shadow"
  rm -rf "$_sd" 2> /dev/null
  _sold_ok=1 _snew_ok=1
  mkdir -p "$_sd" 2> /dev/null || return 0
  # each device's first new-store time: the history before it is out of scope on both sides
  CE_QUIET=''
  ce_read_floors "$_sd/floors"
  [ "$CE_RC" -ne 78 ] && [ "$CE_RC" -ne 127 ] || return 0
  _sfloors=$CE_FLOORS
  _sfloor=''
  if [ "$CE_RC" -ne 0 ]; then
    _snew_ok=0
  else
    _sfloor=$(printf '%s' "$_sfloors" | jq -r --arg d "$2" '.[$d] // empty' 2> /dev/null) || _sfloor=''
  fi
  for _sw in settled live; do
    [ "$_snew_ok" -eq 1 ] || break
    if [ "$_sw" = settled ]; then _suntil=$_scut; else _suntil=$_slive; fi
    CE_QUIET=1
    ce_side "$_sd/old-$_sw" old "$2" "$_ssince" "$_suntil" "$_sfloors" || return 0
    [ "$CE_RC" -ne 78 ] && [ "$CE_RC" -ne 127 ] || return 0
    [ "$CE_SIDE_OK" -eq 1 ] || _sold_ok=0
    # the new side warns once, on its first read
    if [ "$_sw" = settled ]; then CE_QUIET=''; fi
    ce_side "$_sd/new-$_sw" new "$2" "$_ssince" "$_suntil" "$_sfloors" || return 0
    [ "$CE_RC" -ne 78 ] && [ "$CE_RC" -ne 127 ] || return 0
    [ "$CE_SIDE_OK" -eq 1 ] || _snew_ok=0
    ce_tuples "$_sd/old-$_sw/latest" > "$_sd/old-$_sw/tuples"
    ce_tuples "$_sd/new-$_sw/latest" > "$_sd/new-$_sw/tuples"
    ce_diff "$_sd/old-$_sw/tuples" "$_sd/new-$_sw/tuples" > "$_sd/diff-$_sw"
  done
  _scompared=0 _sdiffs=0 _slivediffs=0 _sdetail=''
  : > "$_sd/keys"
  if [ "$_sold_ok" -eq 1 ] && [ "$_snew_ok" -eq 1 ]; then
    _scompared=$(awk '$1 == "N" { print $2 }' "$_sd/diff-live")
    _sdiffs=$(grep -c '^D ' "$_sd/diff-settled" || :)
    _slivediffs=$(grep -c '^D ' "$_sd/diff-live" || :)
    # the settled differences first, then those only the live window shows
    awk '$1 == "D" && !seen[$2]++ { print $2 }' "$_sd/diff-settled" "$_sd/diff-live" > "$_sd/keys"
    _sfirst=$(awk '$1 == "D" { print; exit }' "$_sd/diff-settled")
    [ -n "$_sfirst" ] || _sfirst=$(awk '$1 == "D" { print; exit }' "$_sd/diff-live")
    if [ -n "$_sfirst" ]; then
      _sdetail=$(printf '%s\n' "$_sfirst" | awk -v repo="$repo" '{
        key = $2; $1 = ""; $2 = ""; sub(/^ +/, ""); split($0, p, " [|] ")
        printf "%s#%s old: %s, new: %s", repo, key, p[1], p[2] }')
    fi
  elif [ "$_snew_ok" -eq 0 ]; then
    _sdetail="the new read failed, nothing compared"
  else
    _sdetail="the old read failed, nothing compared"
  fi
  _sdata=$(jq -n -c --arg tool "$CE_TOOL" --arg repo "$repo" --argjson compared "$_scompared" --argjson diffs "$_sdiffs" \
    --argjson live "$_slivediffs" --argjson oldok "$([ "$_sold_ok" -eq 1 ] && echo true || echo false)" \
    --argjson newok "$([ "$_snew_ok" -eq 1 ] && echo true || echo false)" --argjson settle "$_sset" --arg detail "$_sdetail" \
    --rawfile keys "$_sd/keys" --arg floor "$_sfloor" \
    '{reader: "claim-events", tool: $tool, compared: $compared, differences: $diffs, live_differences: $live,
      diff_keys: ($keys | split("\n") | map(select(. != "") | "\($repo)#\(.)") | .[0:50]),
      old_ok: $oldok, new_ok: $newok, settle_seconds: $settle,
      detail: (if $detail == "" then null else $detail[0:500] end),
      scope_floor: (if $floor == "" then null else $floor end)}') || return 0
  "$EVENT" --type shadow_read --data "$_sdata" --repo "$repo" > /dev/null 2>&1 \
    || echo "$CE_TOOL: warning: cannot record the shadow_read event" >&2
  return 0
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
