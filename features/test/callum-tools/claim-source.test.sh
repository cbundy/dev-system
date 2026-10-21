#!/bin/sh
#
# Tests for the claim tools' event source switch (cbundy/dev-system#905): claim-events.sh reads
# the old store (factory.events), the new one (factory.event_log) or both (shadow, opt-in, which
# decides on old and records a shadow_read event). The default is new. A stub dev-query stands in for both
# databases and honours the window the rule asks for; the events are written by the real
# callum-flow-event, so the local logs are the real old and new ones.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT="$SCRIPT_DIR/../../.."
SHARE="$ROOT/images/base"
REAL_EVENT="$SHARE/callum-flow-event"
SCHEMA="$ROOT/docs/factory-events/schemas/shadow_read.v1.json"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
toolbin="$tmpdir/tools"
mkdir -p "$toolbin"
for t in jq sed tr cat mkdir mv dirname basename date find sort cut head tail wc git awk grep rm touch chmod hostname mktemp node; do
  p=$(command -v "$t") || fail "$t not found"
  ln -s "$p" "$toolbin/$t"
done
SH=$(command -v sh)
S="$tmpdir/stub"
EV="$tmpdir/events"

# stub dev-query: the old store ($S/old) or, with --factory, the new one ($S/new) hold every row as
# ts|issue|state|device, oldest first. Like the real queries it applies the window (-v since / until, cut
# at whole seconds) and the -v floors device cut (a row of a device older than its floor is left out), and
# answers per issue the latest non-claim row and the latest claim row. The floor query (the SQL with min(ts))
# answers each device's first row as device|time. $S/floors-rc makes only that query fail.
# $S/old-rc and $S/new-rc make a store fail with that exit status. Calls are logged to $S/calls-old / calls-new.
cat > "$tmpdir/dev-query" <<'STUB'
#!/bin/sh
S=${STUB_DIR:?}
side=old
[ "$1" != --factory ] || { side=new; shift; }
echo "dev-query $*" >> "$S/calls-$side"
[ ! -f "$S/$side-rc" ] || { echo "dev-query: boom" >&2; exit "$(cat "$S/$side-rc")"; }
since='' until='' floors='' sql=''
while [ $# -gt 0 ]; do
  case "$1" in
    -v) case "$2" in since=*) since=${2#since=} ;; until=*) until=${2#until=} ;; floors=*) floors=${2#floors=} ;; esac; shift ;;
    -c) sql=$2; shift ;;
  esac
  shift
done
case "$sql" in
  *'min(ts)'*)
    echo "floor-query" >> "$S/calls-floors"
    [ ! -f "$S/floors-rc" ] || { echo "dev-query: boom" >&2; exit "$(cat "$S/floors-rc")"; }
    [ -f "$S/$side" ] || exit 0
    awk -F'|' '$4 != "" { t = substr($1, 1, 19) "Z"; if (!($4 in m) || t < m[$4]) m[$4] = t } END { for (d in m) print d "|" m[d] }' "$S/$side" | sort
    exit 0 ;;
esac
[ -f "$S/$side" ] || exit 0
[ -z "$floors" ] || printf '%s' "$floors" | jq -r 'to_entries[] | "\(.key)|\(.value)"' > "$S/floors-applied"
awk -F'|' -v since="$since" -v until="$until" -v ff="$S/floors-applied" '
  BEGIN { while ((getline l < ff) > 0) { split(l, p, "|"); fl[p[1]] = p[2] } }
  { t = substr($1, 1, 19) }
  since != "" && t < substr(since, 1, 19) { next }
  until != "" && t >= substr(until, 1, 19) { next }
  ($4 in fl) && t < substr(fl[$4], 1, 19) { next }
  { cl = ($3 ~ /^(claimed|ready|reclaimed|requeued|merged|closed|abandoned)$/) ? 1 : 0; k = $2 SUBSEP cl; row[k] = $0 }
  END { for (k in row) print row[k] }' "$S/$side"
STUB
chmod +x "$tmpdir/dev-query"

# a wrapper that fails the shadow write only
cat > "$tmpdir/event-nowrite" <<STUB
#!/bin/sh
[ "\$1" != --type ] || exit 3
exec "$REAL_EVENT" "\$@"
STUB
chmod +x "$tmpdir/event-nowrite"

# the driver: sources the rule as the tools do, loads into \$OUT and prints the status
cat > "$tmpdir/drv.sh" <<'DRV'
. "$SHARE/claim-events.sh"
DEVQ=${DEVQ_BIN:-$TMP/dev-query}
EVENT=${EVENT_BIN:-$REAL_EVENT}
CE_TOOL=${DRV_TOOL:-callum-flow-sweep}
repo=o/r
mkdir -p "$OUT"
rc=0
ce_load "$OUT" devA || rc=$?
echo "rc=$rc"
DRV

reset() {
  rm -rf "$S" "$EV" "$tmpdir/out"
  mkdir -p "$S" "$EV"
}
# drive [VAR=VALUE]...: runs the driver; stdout in $tmpdir/stdout, stderr in $tmpdir/stderr
drive() {
  rm -rf "$tmpdir/out" "$S/calls-old" "$S/calls-new" "$S/calls-floors" "$S/floors-applied"
  : > "$S/floors-applied"
  set +e
  env -i PATH="$toolbin" HOME="$tmpdir" TMP="$tmpdir" SHARE="$SHARE" REAL_EVENT="$REAL_EVENT" OUT="$tmpdir/out" STUB_DIR="$S" \
    CALLUM_EVENTS_DIR="$EV" DEV_MACHINE_NAME=devA CLAUDE_SESSION_ID= CLAUDE_CODE_SESSION_ID= "$@" "$SH" "$tmpdir/drv.sh" > "$tmpdir/stdout" 2> "$tmpdir/stderr"
  set -e
}
now=$(date -u +%s)
iso() { date -u -d "@$((now + $1))" +%Y-%m-%dT%H:%M:%SZ; }
isoms() { date -u -d "@$((now + $1))" +%Y-%m-%dT%H:%M:%S.250Z; }
# row SIDE OFFSET ISSUE STATE DEVICE: append a central row to the old or new store, OFFSET seconds from now
row() {
  if [ "$1" = new ]; then t=$(isoms "$2"); else t=$(iso "$2"); fi
  echo "$t|$3|$4|$5" >> "$S/$1"
}
# both OFFSET ISSUE OLDSTATE NEWSTATE DEVICE: the same event in both stores
both() { row old "$1" "$2" "$3" "$5"; row new "$1" "$2" "$4" "$5"; }
old_line() {
  ol_state=$1
  shift
  ol_issue='' ol_note=''
  while [ $# -gt 0 ]; do
    case "$1" in --issue) ol_issue=$2 ;; --note) ol_note=$2 ;; esac
    shift 2
  done
  ol_n=1
  [ ! -f "$EV/o__r.jsonl" ] || ol_n=$(($(wc -l < "$EV/o__r.jsonl") + 1))
  jq -nc --arg state "$ol_state" --argjson issue "$ol_issue" --arg note "$ol_note" --arg id "$(printf '00000000-0000-4000-8000-%012d' "$ol_n")" \
    '{v: 2, ts: (now | strftime("%Y-%m-%dT%H:%M:%SZ")), repo: "o/r", device: "devA", session_id: null, actor: "agent", state: $state,
      issue: $issue, run_id: null, branch: null, pr: null, head: null, note: (if $note == "" then null else $note end), event_id: $id,
      base_image: null, dev_image: null, template_version: null, plugin_version: null}' >> "$EV/o__r.jsonl"
}
# local_event STATE --issue N [--note TEXT]: the event on this device in both local stores. The new
# store gets it from the real writer; the old log (which callum-flow-event no longer writes,
# cbundy/dev-system#1143) gets a literal old-format line the test writes itself.
local_event() {
  old_line "$@"
  env -i PATH="$toolbin" HOME="$tmpdir" CALLUM_EVENTS_DIR="$EV" DEV_MACHINE_NAME=devA "$SH" "$REAL_EVENT" "$@" --repo o/r > /dev/null 2> "$tmpdir/lerr" || fail "callum-flow-event $*: $(cat "$tmpdir/lerr")"
}
shadow_events() { cat "$EV"/factory/*.jsonl 2>/dev/null | jq -c 'select(.type == "shadow_read")' || true; }
latest() { cat "$tmpdir/out/latest"; }
tuples() { sh -c '. "$1/claim-events.sh"; ce_tuples "$2"' sh "$SHARE" "$tmpdir/out/latest"; }
held() { sh -c '. "$1/claim-events.sh"; ce_held "$2" devA' sh "$SHARE" "$tmpdir/out/latest"; }
expect_stderr_empty() { [ ! -s "$tmpdir/stderr" ] || fail "$1: stderr: $(cat "$tmpdir/stderr")"; }
rc_is() { grep -qx "rc=$1" "$tmpdir/stdout" || fail "$2: $(cat "$tmpdir/stdout") $(cat "$tmpdir/stderr")"; }

# --- the lifecycle, written both ways ------------------------------------------------
# #7 (this device): claimed, requeued, claimed, merged; #8 (this device): claimed, closed;
# #9 (devB): claimed, requeued, claimed (held by devB); #10 (this device) claimed, delegated, then
# still held; #11 (this device): claimed, requeued (released).
build_lifecycle() {
  reset
  for n in 7 8 10 11; do local_event claimed --issue "$n"; done
  local_event reclaimed --issue 7 --note "lease expired"
  local_event claimed --issue 7
  local_event merged --issue 7
  local_event closed --issue 8
  local_event delegated --issue 10
  local_event reclaimed --issue 11 --note "lease expired"
  both -4000 9 claimed claimed devB
  both -3900 9 reclaimed requeued devB
  both -3800 9 claimed claimed devB
  both -3700 12 claimed claimed devB
  both -3600 12 closed closed devB
}

build_lifecycle
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=old
rc_is 0 "old"
expect_stderr_empty "old"
latest > "$tmpdir/latest-old"
tuples > "$tmpdir/tuples-old"
held > "$tmpdir/held-old"
[ "$(cat "$tmpdir/held-old")" = "10" ] || fail "old: devA holds only #10: $(cat "$tmpdir/held-old")"
grep -q '^7 merged merged devA$' "$tmpdir/latest-old" || fail "old: latest for #7: $(cat "$tmpdir/latest-old")"
grep -q '^9 claimed claimed devB$' "$tmpdir/latest-old" || fail "old: latest for #9"
[ ! -e "$S/calls-new" ] || fail "old reads only the old store: $(cat "$S/calls-new")"
# the old call is the one the tools always made
[ "$(head -c 33 "$S/calls-old")" = "dev-query -At -v repo=o/r -c SELE" ] || fail "old: dev-query call: $(cat "$S/calls-old")"
grep -q 'FROM factory.events WHERE repo = :.repo. AND issue IS NOT NULL$' "$S/calls-old" || fail "old: query is unbounded: $(cat "$S/calls-old")"
[ -z "$(shadow_events)" ] || fail "old writes no shadow_read event"

drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=new
rc_is 0 "new"
expect_stderr_empty "new"
tuples > "$tmpdir/tuples-new"
held > "$tmpdir/held-new"
cmp -s "$tmpdir/tuples-old" "$tmpdir/tuples-new" || fail "new decides differently from old: $(diff "$tmpdir/tuples-old" "$tmpdir/tuples-new")"
cmp -s "$tmpdir/held-old" "$tmpdir/held-new" || fail "new holds differently from old"
grep -q '^7 merged merged devA$' "$tmpdir/out/latest" || fail "new: latest for #7: $(latest)"
grep -q 'factory.event_log' "$S/calls-new" || fail "new: reads factory.event_log: $(cat "$S/calls-new")"
grep -q "'requeued'" "$S/calls-new" || fail "new: selects requeued by name"
grep -q "'transition'" "$S/calls-new" || fail "new: selects transition by name"
grep -q 'device_seq DESC' "$S/calls-new" || fail "new: orders by device_seq"
[ ! -e "$S/calls-old" ] || fail "new reads only the new store"
# the sweep's is_final and released give the same answers (its awk, on each latest file)
released() { awk -v n="$2" '$1 == n && $3 != "claimed" && $3 != "none" { f = 1 } END { exit !f }' "$1"; }
final() { awk -v n="$2" '$1 == n && ($2 == "closed" || $2 == "abandoned") { f = 1 } END { exit !f }' "$1"; }
for n in 7 8 9 10 11 12; do
  for fn in released final; do
    a=0 b=0
    "$fn" "$tmpdir/latest-old" "$n" || a=1
    "$fn" "$tmpdir/out/latest" "$n" || b=1
    [ "$a" = "$b" ] || fail "$fn #$n differs between old and new"
  done
done
final "$tmpdir/out/latest" 8 || fail "#8 is final"
released "$tmpdir/out/latest" 11 || fail "#11 is released (requeued)"
! released "$tmpdir/out/latest" 9 || fail "#9 is not released"

# the default is new: unset and empty decide like the `new` run, read factory.event_log and not
# the old store, and write no shadow_read event
for setting in unset empty; do
  if [ "$setting" = unset ]; then drive; else drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=; fi
  rc_is 0 "default ($setting)"
  expect_stderr_empty "default ($setting)"
  tuples > "$tmpdir/tuples-default"
  held > "$tmpdir/held-default"
  cmp -s "$tmpdir/tuples-new" "$tmpdir/tuples-default" || fail "default ($setting) decides differently from new: $(diff "$tmpdir/tuples-new" "$tmpdir/tuples-default")"
  cmp -s "$tmpdir/tuples-old" "$tmpdir/tuples-default" || fail "default ($setting) decides differently from old"
  cmp -s "$tmpdir/held-new" "$tmpdir/held-default" || fail "default ($setting): held"
  grep -q 'factory.event_log' "$S/calls-new" || fail "default ($setting) reads factory.event_log: $(cat "$S/calls-new" 2> /dev/null)"
  [ ! -e "$S/calls-old" ] || fail "default ($setting) does not read the old store: $(cat "$S/calls-old")"
  [ -z "$(shadow_events)" ] || fail "default ($setting) writes no shadow_read event"
done

# shadow, when asked for: the decision is old's, on the same history, and a shadow_read is written
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow
rc_is 0 "shadow"
cmp -s "$tmpdir/latest-old" "$tmpdir/out/latest" || fail "shadow decides on old: $(diff "$tmpdir/latest-old" "$tmpdir/out/latest")"
[ "$(held)" = "$(cat "$tmpdir/held-old")" ] || fail "shadow: held"
[ -n "$(shadow_events)" ] || fail "shadow: no shadow_read event"
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow
[ "$(shadow_events | wc -l)" = 2 ] || fail "shadow writes one event per run"

# an invalid value warns once, names the variable and the value, and reads old
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=bogus
rc_is 0 "invalid"
[ "$(wc -l < "$tmpdir/stderr")" = 1 ] || fail "invalid: one warning: $(cat "$tmpdir/stderr")"
grep -q "CALLUM_FLOW_CLAIM_EVENTS_SOURCE='bogus'" "$tmpdir/stderr" || fail "invalid: names the variable and value: $(cat "$tmpdir/stderr")"
cmp -s "$tmpdir/latest-old" "$tmpdir/out/latest" || fail "invalid value: old's decision"
[ "$(shadow_events | wc -l)" = 2 ] || fail "invalid value writes no shadow_read event"

# --- failures on the new side ----------------------------------------------------------
build_lifecycle
echo 78 > "$S/new-rc"
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=new
rc_is 0 "new, exit 78"
expect_stderr_empty "new, exit 78"
grep -q '^7 merged merged devA$' "$tmpdir/out/latest" || fail "new, exit 78: the local log still decides"
! grep -q '^9 ' "$tmpdir/out/latest" || fail "new, exit 78: no central rows"
echo 1 > "$S/new-rc"
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=new
rc_is 0 "new, exit 1"
grep -q "warning: cannot read the central event log (new source, dev-query --factory exit 1), using this device's log only" "$tmpdir/stderr" || fail "new, exit 1: $(cat "$tmpdir/stderr")"
! grep -q '^9 ' "$tmpdir/out/latest" || fail "new, exit 1: local log only"
# shadow: the decision stays old's; exit 78 records nothing, exit 1 records new_ok=false
echo 78 > "$S/new-rc"
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow
rc_is 0 "shadow, new exit 78"
expect_stderr_empty "shadow, new exit 78"
cmp -s "$tmpdir/latest-old" "$tmpdir/out/latest" || fail "shadow, new exit 78: decision"
[ -z "$(shadow_events)" ] || fail "shadow, new exit 78 writes no event: $(shadow_events)"
echo 1 > "$S/new-rc"
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow
rc_is 0 "shadow, new exit 1"
cmp -s "$tmpdir/latest-old" "$tmpdir/out/latest" || fail "shadow, new exit 1: decision"
[ "$(wc -l < "$tmpdir/stderr")" = 1 ] || fail "shadow, new exit 1: one warning: $(cat "$tmpdir/stderr")"
shadow_events | jq -e '.data.new_ok == false and .data.old_ok == true and .data.differences == 0 and .data.compared == 0 and .data.diff_keys == []' > /dev/null || fail "shadow, new exit 1: $(shadow_events)"
rm "$S/new-rc"
# the old store failing is the old behaviour: its warning, the local log
echo 3 > "$S/old-rc"
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=old
grep -q "warning: cannot read the central event log (dev-query exit 3), using this device's log only" "$tmpdir/stderr" || fail "old, exit 3: $(cat "$tmpdir/stderr")"
rm "$S/old-rc"

# --- the shadow_read event ---------------------------------------------------------------
# validate EVENT_JSON_FILE: the data against shadow_read.v1.json (required, additionalProperties,
# types, pattern, bounds)
validate() {
  node -e '
    const s = require(process.argv[1]);
    const e = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const d = e.data, bad = [];
    for (const k of s.required) if (!(k in d)) bad.push("missing " + k);
    for (const [k, v] of Object.entries(d)) {
      const p = s.properties[k];
      if (!p) { bad.push("extra " + k); continue; }
      const types = [].concat(p.type);
      const t = v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
      if (!types.includes(t)) bad.push(k + " is " + t);
      if (p.pattern && !new RegExp(p.pattern).test(v)) bad.push(k + " pattern");
      if (p.minimum !== undefined && v < p.minimum) bad.push(k + " minimum");
      if (p.maxLength !== undefined && typeof v === "string" && [...v].length > p.maxLength) bad.push(k + " maxLength");
      if (p.maxItems !== undefined && v.length > p.maxItems) bad.push(k + " maxItems");
    }
    if (e.type !== "shadow_read" || e.issue !== null) bad.push("envelope");
    if (bad.length) { console.error(bad.join(", ")); process.exit(1); }
  ' "$SCHEMA"
}

# equal stores: no differences
reset
for n in 20 21 22; do both -4000 "$n" claimed claimed devB; done
both -3000 21 reclaimed requeued devB
local_event claimed --issue 23
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow DRV_TOOL=callum-flow-claim
rc_is 0 "equal"
expect_stderr_empty "equal"
ev=$(shadow_events)
[ "$(printf '%s\n' "$ev" | wc -l)" = 1 ] || fail "one shadow_read per compare: $ev"
printf '%s\n' "$ev" | validate || fail "equal: the event breaks shadow_read.v1: $ev"
printf '%s\n' "$ev" | jq -e '.data == {reader: "claim-events", tool: "callum-flow-claim", compared: 4, differences: 0, live_differences: 0, diff_keys: [], old_ok: true, new_ok: true, settle_seconds: 600, detail: null, scope_floor: null}' > /dev/null || fail "equal: $ev"
# the same events in both stores and the local logs, not just central ones: nothing differs
printf '%s\n' "$ev" | jq -e '.repo == "o/r"' > /dev/null || fail "equal: repo"

# a difference older than the settle window counts in both, one inside it in live only; the key is listed
reset
both -4000 30 claimed claimed devB
row old -3000 31 claimed devB
row old -5 32 claimed devB
row old -700000 33 claimed devB
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow
rc_is 0 "differences"
ev=$(shadow_events)
printf '%s\n' "$ev" | validate || fail "differences: the event breaks shadow_read.v1: $ev"
printf '%s\n' "$ev" | jq -e '.data | .compared == 3 and .differences == 1 and .live_differences == 2 and .diff_keys == ["o/r#31", "o/r#32"] and .old_ok and .new_ok' > /dev/null || fail "differences: $ev"
printf '%s\n' "$ev" | jq -e '.data.detail == "o/r#31 old: other claimed devB, new: none"' > /dev/null || fail "differences: detail: $ev"
# the decision is still old's, with the issue outside the window
grep -q '^33 claimed claimed devB$' "$tmpdir/out/latest" || fail "differences: the decision read is unbounded: $(latest)"
# a window narrower than the oldest difference leaves it out
reset
both -4000 30 claimed claimed devB
row old -3000 31 claimed devB
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow CALLUM_FLOW_SHADOW_WINDOW_SECONDS=2000
shadow_events | jq -e '.data | .compared == 0 and .differences == 0' > /dev/null || fail "window: $(shadow_events)"
# a longer settle time moves the older difference into live only
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow CALLUM_FLOW_SHADOW_SETTLE_SECONDS=4000
shadow_events | tail -1 | jq -e '.data | .differences == 0 and .live_differences == 1 and .settle_seconds == 4000 and .diff_keys == ["o/r#31"]' > /dev/null || fail "settle: $(shadow_events | tail -1)"
# a difference on a deciding value only: the claim device, the lifecycle class
reset
both -4000 40 claimed claimed devB
both -3900 41 closed closed devB
both -3900 42 claimed claimed devB
row old -3000 40 claimed devC
row new -3000 41 claimed devB
row new -3000 42 transition devB
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow
shadow_events | jq -e '.data | .compared == 3 and .differences == 2 and .diff_keys == ["o/r#40", "o/r#41"]' > /dev/null || fail "deciding values: $(shadow_events)"
# a non-deciding lifecycle type on one side only is no difference
reset
both -4000 43 claimed claimed devB
row new -3000 43 transition devB
row new -2900 43 finding_handled devB
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow
shadow_events | jq -e '.data | .compared == 1 and .differences == 0' > /dev/null || fail "non-deciding types: $(shadow_events)"

# --- the scope floor: history from before a device's first new-store row ------------------
# devB's first new row is at -3000: its older old-store rows are out of scope on both sides and no
# difference; an old row of devB after the floor still is. devC has no new row at all, so its old
# rows stay and show as differences. devA's own first new row sets scope_floor.
reset
row old -5000 80 claimed devB
row old -4500 80 closed devB
both -3000 81 claimed claimed devB
row old -2900 82 claimed devB
row old -5000 83 claimed devC
row old -3500 84 claimed devB
row old -5000 85 claimed ''
both -3500 86 claimed claimed devA
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow
rc_is 0 "floor"
expect_stderr_empty "floor"
ev=$(shadow_events)
printf '%s\n' "$ev" | validate || fail "floor: the event breaks shadow_read.v1: $ev"
printf '%s\n' "$ev" | jq -e '.data | .differences == 3 and .live_differences == 3 and .diff_keys == ["o/r#82", "o/r#83", "o/r#85"] and .old_ok and .new_ok and (.scope_floor | startswith("20")) and (.scope_floor | length) == 20' > /dev/null || fail "floor: $ev"
# the decision is old's and keeps the out-of-scope rows
grep -q '^80 closed closed devB$' "$tmpdir/out/latest" || fail "floor: the decision keeps the old history: $(latest)"
floor_calls=$(wc -l < "$S/calls-floors")
[ "$floor_calls" = 1 ] || fail "floor: one floor read per compare: $floor_calls"
# both central reads carry the floors and cut on them before picking the latest per issue
for side in old new; do
  grep -q "floors={" "$S/calls-$side" || fail "floor: the $side read passes the floors: $(cat "$S/calls-$side")"
  grep -q ":'floors'::jsonb ->> device" "$S/calls-$side" || fail "floor: the $side read cuts on the floors"
done
# old and new make no floor read
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=old
[ ! -e "$S/calls-floors" ] || fail "old reads no floors"
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=new
[ ! -e "$S/calls-floors" ] || fail "new reads no floors"
# devB with no new row: its old rows show as differences (the floor is per device)
grep -v '|devB$' "$S/new" > "$S/new.nob" || :
mv "$S/new.nob" "$S/new"
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow
shadow_events | tail -1 | jq -e '.data.diff_keys | index("o/r#80") != null and index("o/r#81") != null' > /dev/null || fail "no floor for devB: $(shadow_events | tail -1)"
# a row in the floor's own second is kept on both sides (old whole second, new .250)
reset
row new -3000 90 claimed devB
row old -3000 90 claimed devB
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow
shadow_events | jq -e '.data | .compared == 1 and .differences == 0 and .live_differences == 0' > /dev/null || fail "floor second: $(shadow_events)"
# this device's local logs are cut at its floor: a floor in the future leaves the local event out
reset
local_event claimed --issue 91
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow
shadow_events | jq -e '.data | .compared == 1 and .scope_floor == null' > /dev/null || fail "local, no floor: $(shadow_events)"
row new 3600 92 claimed devA
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow
shadow_events | tail -1 | jq -e '.data | .compared == 0 and .differences == 0 and .scope_floor != null' > /dev/null || fail "local floor: $(shadow_events | tail -1)"
# a failing floor read: new_ok false, one warning, the decision still old's; exit 78 records nothing
reset
both -4000 93 claimed claimed devB
echo 1 > "$S/floors-rc"
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow
rc_is 0 "floor read fails"
[ "$(wc -l < "$tmpdir/stderr")" = 1 ] || fail "floor read fails: one warning: $(cat "$tmpdir/stderr")"
grep -q '^93 claimed claimed devB$' "$tmpdir/out/latest" || fail "floor read fails: the decision"
ev=$(shadow_events)
printf '%s\n' "$ev" | validate || fail "floor read fails: the event breaks shadow_read.v1: $ev"
printf '%s\n' "$ev" | jq -e '.data | .new_ok == false and .old_ok == true and .compared == 0 and .differences == 0 and .scope_floor == null' > /dev/null || fail "floor read fails: $ev"
echo 78 > "$S/floors-rc"
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow
expect_stderr_empty "floor read exit 78"
[ "$(shadow_events | wc -l)" = 1 ] || fail "floor read exit 78 records nothing"
rm "$S/floors-rc"

# more than 50 differing keys: the list is clipped, the count is not
reset
i=100
while [ "$i" -lt 160 ]; do row old -3000 "$i" claimed devB; i=$((i + 1)); done
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow
ev=$(shadow_events)
printf '%s\n' "$ev" | validate || fail "clip: the event breaks shadow_read.v1"
printf '%s\n' "$ev" | jq -e '.data | .differences == 60 and .live_differences == 60 and (.diff_keys | length) == 50 and .diff_keys[0] == "o/r#100" and .diff_keys[49] == "o/r#149"' > /dev/null || fail "clip: $ev"

# the detail is at most 500 characters
reset
long=$(awk 'BEGIN { for (i = 0; i < 700; i++) printf "x" }')
row old -3000 50 claimed "$long"
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow
ev=$(shadow_events)
printf '%s\n' "$ev" | validate || fail "detail: the event breaks shadow_read.v1"
printf '%s\n' "$ev" | jq -e '.data.detail | length == 500 and startswith("o/r#50 old: other claimed xxx")' > /dev/null || fail "detail clip: $ev"

# a failing write warns once, leaves the status and the decision alone
reset
row old -3000 60 claimed devB
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow EVENT_BIN="$tmpdir/event-nowrite"
rc_is 0 "write fails"
[ "$(wc -l < "$tmpdir/stderr")" = 1 ] || fail "write fails: one warning: $(cat "$tmpdir/stderr")"
grep -q 'warning: cannot record the shadow_read event' "$tmpdir/stderr" || fail "write fails: $(cat "$tmpdir/stderr")"
grep -q '^60 claimed claimed devB$' "$tmpdir/out/latest" || fail "write fails: the decision"
[ -z "$(shadow_events)" ] || fail "write fails: no event"

# without dev-query nothing is compared and nothing is recorded
reset
local_event claimed --issue 70
drive CALLUM_FLOW_CLAIM_EVENTS_SOURCE=shadow DEVQ_BIN="$tmpdir/no-such-dev-query"
rc_is 0 "no dev-query"
expect_stderr_empty "no dev-query"
grep -q '^70 claimed claimed devA$' "$tmpdir/out/latest" || fail "no dev-query: the local log decides: $(latest)"
[ -z "$(shadow_events)" ] || fail "no dev-query: nothing compared"
echo "ok"
