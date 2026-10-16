#!/bin/sh
#
# Plain-shell tests for callum-flow-claim and callum-flow-sweep
# (cbundy/dev-system#220). A stub gh backed by JSON fixture files stands in for
# GitHub and records every mutating call, so nothing here touches the real API.
# Hermetic PATH, no network, no Docker.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT="$SCRIPT_DIR/../../.."
CLAIM="$ROOT/images/base/callum-flow-claim"
SWEEP="$ROOT/images/base/callum-flow-sweep"
READER="$ROOT/images/base/callum-flow-issue-read"
SHARE="$ROOT/images/base"
EVENT="$ROOT/images/base/callum-flow-event"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
toolbin="$tmpdir/tools"
mkdir -p "$toolbin"
for t in jq sed tr cat mkdir mv dirname basename date find sort cut head tail wc git awk grep rm touch chmod hostname mktemp; do
  p=$(command -v "$t") || fail "$t not found"
  ln -s "$p" "$toolbin/$t"
done
SH=$(command -v sh)

d="$tmpdir/state"
cat > "$tmpdir/gh" <<'STUB'
#!/bin/sh
# State in $STUB_DIR: issue-N.json {state,labels}, comments-N.json, timeline-N.json,
# list.txt (the lagging label listing), date (server Date header), post-created,
# inject-N.json (comments that appear right after our POST). The reader's REST
# reads (cbundy/dev-system#310) are built from the same files: author-N (an issue's
# user JSON, default the owner), pr-author-N (a PR's), head-ref-N (a PR's branch).
d=${STUB_DIR:?}
now_iso=$(cat "$d/now-iso")
OWNER='{"login":"cbundy","id":13131067}'
author_of() { if [ -f "$d/$1-$2" ]; then cat "$d/$1-$2"; else echo "$OWNER"; fi; }
case "$1 $2" in
  'repo view') echo o/r ;;
  'api -i') printf 'HTTP/2 200\r\nDate: %s\r\n\r\n{}\n' "$(cat "$d/date")" ;;
  'issue list' | 'issue view') echo "raw issue read: gh $*" >&2; exit 1 ;;
  'issue edit')
    n=$3; shift 3
    echo "issue edit $n $*" >> "$d/calls"
    [ ! -f "$d/edit-fails" ] || exit 1
    while [ $# -gt 0 ]; do
      case "$1" in
        --add-label) jq --arg l "$2" '.labels += [{name:$l}]' "$d/issue-$n.json" > "$d/t" && mv "$d/t" "$d/issue-$n.json" ;;
        --remove-label) jq --arg l "$2" '.labels |= map(select(.name != $l))' "$d/issue-$n.json" > "$d/t" && mv "$d/t" "$d/issue-$n.json" ;;
      esac
      shift 2
    done ;;
  'issue comment') echo "issue comment $3 $*" >> "$d/calls" ;;
  'api --paginate')
    [ ! -f "$d/read-fails" ] || exit 1
    case "$3" in
      */comments) cat "$d/comments-$(echo "$3" | sed 's#.*/issues/\([0-9]*\)/comments#\1#').json" ;;
      */timeline) cat "$d/timeline-$(echo "$3" | sed 's#.*/issues/\([0-9]*\)/timeline#\1#').json" ;;
      */issues\?*)
        # the lagging label listing: list.txt names the issues, issue-N.json their state
        for n in $(cat "$d/list.txt"); do
          jq -n --argjson n "$n" --argjson u "$(author_of author "$n")" --slurpfile i "$d/issue-$n.json" \
            '{number: $n, title: "t", body: "b", user: $u, state: ($i[0].state | ascii_downcase), labels: $i[0].labels}'
        done | jq -s '.' ;;
    esac ;;
  'api repos/'*)
    [ ! -f "$d/read-fails" ] || exit 1
    case "$2" in
      */pulls/*)
        n=${2##*/}
        jq -n --argjson n "$n" --argjson u "$(author_of pr-author "$n")" --arg r "$(cat "$d/head-ref-$n")" \
          '{number: $n, title: "t", body: "b", user: $u, head: {ref: $r}}' ;;
      */issues/[0-9]*)
        n=${2##*/}
        jq --argjson n "$n" --argjson u "$(author_of author "$n")" \
          '{number: $n, title: "t", body: "b", user: $u, state: (.state | ascii_downcase), state_reason: (.state_reason // null), labels: .labels}' "$d/issue-$n.json" ;;
    esac ;;
  'api -X')
    verb=$3; path=$4
    case "$verb $path" in
      'POST '*/comments)
        n=$(echo "$path" | sed 's#.*/issues/\([0-9]*\)/comments#\1#')
        body=$(printf '%s\n' "$@" | sed -n 's/^body=//p;')
        # -f body=<multi-line>: take everything after the first "body=" argument
        for a in "$@"; do case "$a" in body=*) body=${a#body=} ;; esac; done
        echo "POST $n" >> "$d/calls"
        jq -n --arg b "$body" --arg c "$(cat "$d/post-created")" \
          '{id: 900, body: $b, created_at: $c, updated_at: $c, user: {login: "cbundy", id: 13131067}}' > "$d/posted.json"
        jq --slurpfile p "$d/posted.json" '. + $p' "$d/comments-$n.json" > "$d/t" && mv "$d/t" "$d/comments-$n.json"
        if [ -f "$d/inject-$n.json" ]; then
          jq -s 'add' "$d/comments-$n.json" "$d/inject-$n.json" > "$d/t" && mv "$d/t" "$d/comments-$n.json"
        fi
        cat "$d/posted.json" ;;
      'PATCH '*)
        id=${path##*/}
        for a in "$@"; do case "$a" in body=*) body=${a#body=} ;; esac; done
        echo "PATCH $id" >> "$d/calls"
        [ ! -f "$d/patch-fails" ] || exit 1
        printf '%s' "$body" > "$d/patched-$id"
        for f in "$d"/comments-*.json; do
          jq --argjson i "$id" --arg b "$body" --arg u "$now_iso" \
            'map(if .id == $i then .body = $b | .updated_at = $u else . end)' "$f" > "$d/t" && mv "$d/t" "$f"
        done ;;
      'DELETE '*)
        id=${path##*/}
        echo "DELETE $id" >> "$d/calls"
        for f in "$d"/comments-*.json; do
          jq --argjson i "$id" 'map(select(.id != $i))' "$f" > "$d/t" && mv "$d/t" "$f"
        done ;;
    esac ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$tmpdir/gh"
# stub callum-flow-factory-state: prints $STUB_DIR/fs-json (its --format json report), or fails
# without one
cat > "$tmpdir/factory-state" <<'STUB'
#!/bin/sh
echo "factory-state $*" >> "${STUB_DIR:?}/fs-calls"
[ -f "$STUB_DIR/fs-json" ] || { echo "factory-state: no database" >&2; exit 1; }
cat "$STUB_DIR/fs-json"
STUB
chmod +x "$tmpdir/factory-state"

NOW='2026-10-08T12:00:00Z'
FRESH='2026-10-08T11:30:00Z' # 30 minutes old: live under a 120 minute lease
STALE='2026-10-08T08:00:00Z' # 4 hours old: expired

# cm <id> <device> <created> <updated> [lease] - one claim comment
cm() {
  jq -n --argjson id "$1" --arg dev "$2" --arg c "$3" --arg u "$4" --arg l "${5:-120}" \
    '{id: $id, user: {login: "cbundy", id: 13131067}, created_at: $c, updated_at: $u,
      body: "claimed-by: \($dev) at \($c) lease: \($l)\n<!-- callum-flow-claim -->"}'
}
brief() { jq -n '{id: 5, user: {login: "cbundy", id: 13131067}, created_at: "2026-10-08T11:59:00Z", updated_at: "2026-10-08T11:59:00Z", body: "## Design brief"}'; }
arr() { jq -s '.'; }

reset() {
  rm -rf "$d"
  mkdir -p "$d" "$tmpdir/events"
  rm -f "$tmpdir/events"/*
  : > "$d/calls"
  echo "$NOW" > "$d/now-iso"
  echo 'Thu, 08 Oct 2026 12:00:00 GMT' > "$d/date"
  echo '2026-10-08T12:00:00Z' > "$d/post-created"
  echo 7 > "$d/list.txt"
  issue 7 OPEN ready
  echo '[]' > "$d/comments-7.json"
  echo '[]' > "$d/timeline-7.json"
}
# issue <n> <state> <label>... ; list.txt is left alone (it lags)
issue() {
  n=$1 st=$2
  shift 2
  labels=$(for l in "$@"; do printf '%s\n' "$l"; done | jq -R '{name: .}' | jq -s '.')
  jq -n --arg s "$st" --argjson l "$labels" '{state: $s, labels: $l}' > "$d/issue-$n.json"
}

run() {
  PATH="$toolbin" STUB_DIR="$d" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_REPO=o/r \
    CALLUM_FLOW_EVENT_BIN="$EVENT" CALLUM_EVENTS_DIR="$tmpdir/events" DEV_MACHINE_NAME=devA \
    CALLUM_FLOW_FACTORY_STATE_BIN="${FS_BIN:-$tmpdir/no-factory-state}" CALLUM_FLOW_ISSUE_READ_BIN="${READ_BIN:-$READER}" CALLUM_FLOW_SHARE_DIR="$SHARE" CALLUM_FLOW_TRUSTED_AUTHORS="${TRUSTED-cbundy:13131067}" \
    "$SH" "$@"
}
rc_of() { set +e; run "$@" >"$tmpdir/out" 2>"$tmpdir/err"; rc=$?; set -e; }
expect_rc() { [ "$rc" = "$1" ] || fail "$2: exit $rc, wanted $1 (stderr: $(cat "$tmpdir/err"))"; }
calls() { cat "$d/calls"; }
no_calls() { [ ! -s "$d/calls" ] || fail "$1: unexpected writes: $(calls)"; }
events() { cat "$tmpdir/events"/*.jsonl 2>/dev/null || true; }
no_events() { [ -z "$(events)" ] || fail "$1: unexpected events: $(events)"; }
# seed <state> <issue> : append a real event to this device's log; the sweep's candidates are the
# issues the event log and factory-state list as live (v2 SPEC 3.6), never a label list
seed() { rc_of "$EVENT" "$1" --issue "$2" --repo o/r; }

# --- usage ----------------------------------------------------------------------
reset
for args in "" "abc" "7 8" "--bogus" "--heartbeat x"; do
  # shellcheck disable=SC2086
  rc_of "$CLAIM" $args
  expect_rc 2 "claim usage [$args]"
done
rc_of "$SWEEP" x
expect_rc 2 "sweep usage"
CALLUM_FLOW_LEASE_MINUTES=zero rc_of "$CLAIM" 7
expect_rc 2 "bad lease"
no_calls usage

# --- fresh claim ----------------------------------------------------------------
reset
brief | arr > "$d/comments-7.json"
rc_of "$CLAIM" 7
expect_rc 0 "fresh claim"
calls | grep -q '^POST 7$' || fail "fresh: no comment posted"
calls | grep -qx 'issue edit 7 --remove-label ready --add-assignee @me' || fail "fresh: ready off and assigned: $(calls)"
# the claim adds no label: the comment and its events are the claim (v2 SPEC 3.6)
calls | grep -q -- '--add-label' && fail "fresh: the claim must add no label: $(calls)"
[ "$(calls | grep -c '^POST')" = 1 ] || fail "fresh: more than one comment"
jq -e '.[-1].body == "claimed-by: devA at 2026-10-08T12:00:00Z lease: 120\n<!-- callum-flow-claim -->"' "$d/comments-7.json" >/dev/null ||
  fail "fresh: comment format: $(jq -r '.[-1].body' "$d/comments-7.json")"
[ "$(events | wc -l)" = 1 ] || fail "fresh: event: $(events)"
events | jq -e '.state == "claimed" and .issue == 7 and .device == "devA" and .note == "lease: 120"' >/dev/null || fail "fresh: event: $(events)"

# lease override
reset
CALLUM_FLOW_LEASE_MINUTES=30 rc_of "$CLAIM" 7
expect_rc 0 "lease override"
jq -e '.[-1].body | startswith("claimed-by: devA at 2026-10-08T12:00:00Z lease: 30\n")' "$d/comments-7.json" >/dev/null || fail "lease override not recorded"
events | jq -e '.state == "claimed" and .note == "lease: 30"' >/dev/null || fail "lease override: claimed note: $(events)"

# --- pre-check: a live foreign claim blocks, even with stale labels -------------
reset
cm 100 devB "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
rc_of "$CLAIM" 7
expect_rc 3 "foreign live claim"
no_calls "foreign live claim"
events | jq -e '.state == "claim_lost" and .issue == 7 and (.note | contains("devB"))' >/dev/null || fail "foreign live claim: claim_lost event: $(events)"

# --- expired foreign claim does not block ---------------------------------------
reset
cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
rc_of "$CLAIM" 7
expect_rc 0 "expired foreign claim"
calls | grep -q '^POST 7$' || fail "expired foreign: not claimed"

# --- collision: a foreign claim posted before ours wins -------------------------
reset
cm 100 devB '2026-10-08T11:59:59Z' '2026-10-08T11:59:59Z' | jq -s '.' > "$d/inject-7.json"
rc_of "$CLAIM" 7
expect_rc 3 "collision loser"
[ "$(calls)" = "$(printf 'POST 7\nDELETE 900')" ] || fail "loser must only post and delete its own comment: $(calls)"
[ "$(events | wc -l)" = 1 ] || fail "collision loser: events: $(events)"
events | jq -e '.state == "claim_lost" and .issue == 7 and .device == "devA" and (.note | contains("devB"))' >/dev/null || fail "collision loser: claim_lost event: $(events)"
jq -e 'map(.id) == [100]' "$d/comments-7.json" >/dev/null || fail "loser left the winner's comment alone"

# --- collision: a foreign claim posted after ours loses -------------------------
reset
echo '2026-10-08T11:59:00Z' > "$d/post-created"
cm 100 devB '2026-10-08T11:59:59Z' '2026-10-08T11:59:59Z' | jq -s '.' > "$d/inject-7.json"
rc_of "$CLAIM" 7
expect_rc 0 "collision winner"
calls | grep -q 'DELETE' && fail "winner must not delete anything"
calls | grep -q 'issue edit 7' || fail "winner must swap labels"
events | jq -e '.state == "claimed"' >/dev/null || fail "winner event"

# --- own live claim: kept only while the log shows it held -----------------------
# held (a restart, a retry of a claim whose adoption failed): no second comment, no second claimed
reset
seed claimed 7
seed delegated 7
cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
rc_of "$CLAIM" 7
expect_rc 0 "own live claim, held"
calls | grep -q 'POST' && fail "own live claim, held: posted again: $(calls)"
[ "$(events | jq -s 'map(select(.state == "claimed")) | length')" = 1 ] || fail "own live claim, held: claimed again: $(events)"
# not held: every other log starts a new life, a fresh comment, lease and one claimed event.
# nolog and none: a claim interrupted after its POST and before its event (a reload mid-claim),
# with no log, or a log with no claim event for the issue. An end (R2-F5): the comment and its
# lease outlive a release, a drop, a rejection or a merge; the end counts whatever follows it
# (a closing transition logged after merged)
for end in nolog none reclaimed abandoned merged closed ready; do
  reset
  case "$end" in
    nolog | none) ;;
    *) seed claimed 7; seed "$end" 7 ;;
  esac
  [ "$end" = nolog ] || rc_of "$EVENT" transition --issue 7 --repo o/r --note "life=x seq=2 from=merge-queue to=closed"
  cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
  rc_of "$CLAIM" 7
  expect_rc 0 "own live claim after $end"
  [ "$(calls | grep -v '^issue edit')" = "$(printf 'DELETE 100\nPOST 7')" ] || fail "own live claim after $end: not a fresh claim: $(calls)"
  jq -e 'map(.id) == [900]' "$d/comments-7.json" >/dev/null || fail "own live claim after $end: comments: $(cat "$d/comments-7.json")"
  events | jq -s -e 'last | .state == "claimed" and .issue == 7 and .note == "lease: 120"' >/dev/null || fail "own live claim after $end: no new claimed: $(events)"
  [ "$(events | jq -s 'map(select(.state == "claimed")) | length')" = "$(case "$end" in nolog | none) echo 1 ;; *) echo 2 ;; esac)" ] || fail "own live claim after $end: claimed count: $(events)"
done

# --- label failure withdraws the claim ------------------------------------------
reset
touch "$d/edit-fails"
rc_of "$CLAIM" 7
expect_rc 1 "label failure"
calls | grep -q '^DELETE 900$' || fail "label failure must withdraw the claim"
no_events "label failure"

# --- heartbeat ------------------------------------------------------------------
reset
{ brief; cm 100 devA "$FRESH" "$FRESH"; cm 101 devB "$FRESH" "$FRESH"; } | arr > "$d/comments-7.json"
rc_of "$CLAIM" --heartbeat 7
expect_rc 0 "heartbeat"
[ "$(calls)" = "PATCH 100" ] || fail "heartbeat must PATCH only our claim comment: $(calls)"
[ "$(cat "$d/patched-100")" = "$(printf 'claimed-by: devA at %s lease: 120\n<!-- callum-flow-claim -->\nrenewed: 2026-10-08T12:00:00Z' "$FRESH")" ] || fail "heartbeat body: $(cat "$d/patched-100")"
[ "$(events | wc -l)" = 1 ] || fail "heartbeat: events: $(events)"
events | jq -e '.state == "renewed" and .issue == 7 and .device == "devA" and .note == "lease: 120"' >/dev/null || fail "heartbeat: renewed event: $(events)"
# again: the renewed line is replaced, not duplicated
echo '2026-10-08T12:10:00Z' > "$d/now-iso"
: > "$d/calls"
rc_of "$CLAIM" --heartbeat 7
[ "$(grep -c '^renewed: ' "$d/patched-100")" = 1 ] || fail "heartbeat duplicated the renewed line"

# a failing PATCH logs nothing
reset
cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
touch "$d/patch-fails"
rc_of "$CLAIM" --heartbeat 7
expect_rc 1 "heartbeat patch failure"
no_events "heartbeat patch failure"

# no-argument form: the claims this device still holds, as its own event log shows them (the
# test callum-flow-claim <N> uses: the last of its claimed, ready, reclaimed, merged, closed and
# abandoned events is claimed), never a label list and never factory.events, so a lagging push
# cannot stop the renewals (M2). #7 is claimed and renewed; #8 was claimed and then released; #9
# claimed and closed; #10 claimed, then a v2 transition (a lifecycle event that is no release);
# #11 never claimed here; #12 claimed by this device but devB holds the comment; #13 claimed but
# GitHub has closed it (the log lags a close).
fs_live() { jq -n --argjson i "$1" '{repos: [{repo: "o/r", issues: $i, recent: []}]}' > "$d/fs-json"; }
reset
for n in 8 9 10 11 12; do issue "$n" OPEN; done
issue 13 CLOSED
for n in 7 8 9 10 12 13; do rc_of "$EVENT" claimed --issue "$n" --repo o/r --note 'lease: 120'; done
rc_of "$EVENT" reclaimed --issue 8 --repo o/r
rc_of "$EVENT" closed --issue 9 --repo o/r
rc_of "$EVENT" transition --issue 10 --repo o/r --note 'row=T1 life=a seq=1 from=queued to=designing'
rc_of "$EVENT" renewed --issue 7 --repo o/r --note 'lease: 120'
rc_of "$EVENT" ready --issue 11 --repo o/r
for n in 7 8 9 10 11 13; do cm "$((100 + n))" devA "$FRESH" "$FRESH" | arr > "$d/comments-$n.json"; done
cm 112 devB "$FRESH" "$FRESH" | arr > "$d/comments-12.json"
# factory.events lags this device's push: factory-state reads fine and lists none of them
fs_live '[]'
before=$(events | wc -l)
FS_BIN="$tmpdir/factory-state" rc_of "$CLAIM" --heartbeat
expect_rc 0 "heartbeat all"
[ "$(calls | sort | tr '\n' ' ')" = "PATCH 107 PATCH 110 " ] || fail "heartbeat all: only #7 and #10 are this device's held claims: $(calls)"
[ "$(events | wc -l)" = "$((before + 2))" ] || fail "heartbeat all: one renewed event per renewed claim: $(events)"
# an issue merged but left open (research, Refs) is no longer held, though factory-state lists it
# live at stage merged with this device as the holder (M2)
reset
issue 7 OPEN
rc_of "$EVENT" claimed --issue 7 --repo o/r --note 'lease: 120'
rc_of "$EVENT" merged --issue 7 --repo o/r
rc_of "$EVENT" transition --issue 7 --repo o/r --note 'life=x seq=2 from=merge-queue to=closed'
cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
fs_live '[{"issue": 7, "stage": "merged", "holder": "devA"}]'
before=$(events | wc -l)
FS_BIN="$tmpdir/factory-state" rc_of "$CLAIM" --heartbeat
expect_rc 0 "heartbeat, merged and open"
no_calls "heartbeat, merged and open"
[ "$(events | wc -l)" = "$before" ] || fail "heartbeat, merged and open: renewed: $(events)"
# nothing to renew is still success
reset
rc_of "$EVENT" claimed --issue 7 --repo o/r --note 'lease: 120'
cm 100 devB "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
before=$(events | wc -l)
rc_of "$CLAIM" --heartbeat
expect_rc 0 "heartbeat nothing"
no_calls "heartbeat nothing"
[ "$(events | wc -l)" = "$before" ] || fail "heartbeat nothing: renewed: $(events)"
# this device has no log: nothing claimed here, nothing renewed
reset
cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
rc_of "$CLAIM" --heartbeat
expect_rc 0 "heartbeat, no log"
no_calls "heartbeat, no log"
# the log cannot be located: an error, nothing renewed
reset
cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
cat > "$tmpdir/no-path-event" <<'STUB'
#!/bin/sh
[ "$1" != --path ] || exit 2
exec "$REAL_EVENT" "$@"
STUB
chmod +x "$tmpdir/no-path-event"
set +e
PATH="$toolbin" STUB_DIR="$d" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_REPO=o/r REAL_EVENT="$EVENT" \
  CALLUM_FLOW_EVENT_BIN="$tmpdir/no-path-event" CALLUM_EVENTS_DIR="$tmpdir/events" DEV_MACHINE_NAME=devA \
  CALLUM_FLOW_ISSUE_READ_BIN="$READER" CALLUM_FLOW_SHARE_DIR="$SHARE" \
  CALLUM_FLOW_TRUSTED_AUTHORS=cbundy:13131067 "$SH" "$CLAIM" --heartbeat >"$tmpdir/out" 2>"$tmpdir/err"
rc=$?
set -e
expect_rc 1 "heartbeat list failure"
no_calls "heartbeat list failure"
grep -q 'cannot list' "$tmpdir/err" || fail "heartbeat list failure: $(cat "$tmpdir/err")"

# --- sweep: stale claim is reclaimed ---------------------------------------------
reset
issue 7 OPEN 'factory:building'
seed claimed 7
{ brief; cm 100 devB "$STALE" "$STALE"; } | arr > "$d/comments-7.json"
rc_of "$SWEEP"
expect_rc 0 "sweep stale"
# ready back and the claimant unassigned; no other label is touched (the loop owns factory:*)
calls | grep -qx 'issue edit 7 --add-label ready --remove-assignee cbundy' || fail "stale: ready back: $(calls)"
calls | grep -q -- '--remove-label' && fail "stale: the sweep must remove no label: $(calls)"
jq -e '.labels | map(.name) == ["factory:building", "ready"]' "$d/issue-7.json" > /dev/null || fail "stale: labels: $(cat "$d/issue-7.json")"
[ "$(calls | grep -c '^issue comment 7')" = 1 ] || fail "stale: comment count"
calls | grep "issue comment 7" | grep -q devB || { calls >&2; cat "$tmpdir/err" >&2; fail "stale: comment names the device"; }
[ "$(events | grep -c '"state":"reclaimed"')" = 1 ] || fail "stale: event: $(events)"
events | tail -n 1 | jq -e '.state == "reclaimed" and .issue == 7' >/dev/null || fail "stale: event"
# the second run writes nothing: the issue's latest event is now reclaimed
: > "$d/calls"
n=$(events | wc -l)
rc_of "$SWEEP"
expect_rc 0 "sweep twice"
no_calls "sweep twice"
[ "$(events | wc -l)" = "$n" ] || fail "sweep twice wrote: $(events)"

# a live claim is left alone
reset
issue 7 OPEN
seed claimed 7
cm 100 devB "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
rc_of "$SWEEP"
expect_rc 0 "sweep live"
no_calls "sweep live"

# a renewed claim is live even though it was created long ago
reset
issue 7 OPEN
seed claimed 7
cm 100 devB "$STALE" "$FRESH" | arr > "$d/comments-7.json"
rc_of "$SWEEP"
no_calls "sweep renewed"

# an issue already back in the queue, or merged, is not read for a claim at all
for last in ready reclaimed merged; do
  reset
  issue 7 OPEN
  seed claimed 7
  seed "$last" 7
  cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
  rc_of "$SWEEP"
  expect_rc 0 "sweep released [$last]"
  no_calls "sweep released [$last]"
done

# an issue only factory-state lists (no event on this device) with a lapsed claim is reclaimed too
reset
issue 7 OPEN
fs_live '[{"issue": 7, "holder": "devB"}]'
cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
FS_BIN="$tmpdir/factory-state" rc_of "$SWEEP"
expect_rc 0 "sweep listed only"
calls | grep -qx 'issue edit 7 --add-label ready --remove-assignee cbundy' || fail "listed only: $(calls)"

# --- sweep: a closed issue's closure is logged (#342); its labels are left alone ----
# closed_issue <n> <reason> : a closed issue with GitHub's close reason
closed_issue() { jq -n --arg r "$2" '{state: "CLOSED", labels: [], state_reason: (if $r == "" then null else $r end)}' > "$d/issue-$1.json"; }
# stub dev-query: prints $STUB_DIR/central (the DISTINCT ON rows), or fails with $STUB_DIR/central-rc
cat > "$tmpdir/dev-query" <<'STUB'
#!/bin/sh
d=${STUB_DIR:?}
echo "dev-query $*" >> "$d/dq-calls"
[ ! -f "$d/central-rc" ] || { echo "dev-query: boom" >&2; exit "$(cat "$d/central-rc")"; }
[ ! -f "$d/central" ] || cat "$d/central"
STUB
chmod +x "$tmpdir/dev-query"
unset CALLUM_FLOW_DEV_QUERY_BIN 2> /dev/null || true

reset
issue 7 CLOSED 'In development'
rc_of "$SWEEP"
expect_rc 0 "sweep closed"
no_calls "sweep closed: no event, so no candidate, and no label read"
no_events "sweep closed (no prior event)"

# closed + a label + a prior claimed: one closed event, the labels untouched, then nothing
reset
closed_issue 7 completed
jq '.labels = [{name: "In development"}, {name: "factory:parked"}]' "$d/issue-7.json" > "$d/t" && mv "$d/t" "$d/issue-7.json"
seed claimed 7
rc_of "$SWEEP"
expect_rc 0 "sweep closed in dev"
no_calls "closed in dev"
[ "$(events | grep -c '"state":"closed"')" = 1 ] || fail "closed in dev: $(events)"
events | tail -n 1 | jq -e '.state == "closed" and .issue == 7 and .note == "completed" and .actor == "sweep"' > /dev/null || fail "closed in dev event: $(events)"
: > "$d/calls"
n=$(events | wc -l)
rc_of "$SWEEP"
expect_rc 0 "sweep closed in dev twice"
no_calls "sweep closed in dev twice"
[ "$(events | wc -l)" = "$n" ] || fail "closed in dev twice wrote: $(events)"

# manual close, duplicate close, not_planned and no reason: one closed line each, note verbatim
for r in completed duplicate not_planned ''; do
  reset
  closed_issue 7 "$r"
  seed claimed 7
  n=$(events | wc -l)
  rc_of "$SWEEP"
  expect_rc 0 "sweep close [$r]"
  no_calls "sweep close [$r]"
  [ "$(events | wc -l)" = $((n + 1)) ] || fail "close [$r]: $(events)"
  events | tail -n 1 | jq -e --arg r "$r" '.state == "closed" and .issue == 7 and .actor == "sweep" and (.note // "") == $r' > /dev/null || fail "close [$r]: $(events)"
  # repeat run right after: nothing
  rc_of "$SWEEP"
  expect_rc 0 "sweep close repeat [$r]"
  no_calls "sweep close repeat [$r]"
  [ "$(events | wc -l)" = $((n + 1)) ] || fail "close repeat [$r]: $(events)"
done

# an issue that already ended (closed, abandoned) gets no event
for fin in closed abandoned; do
  reset
  closed_issue 7 completed
  seed claimed 7
  seed "$fin" 7
  n=$(events | wc -l)
  rc_of "$SWEEP"
  expect_rc 0 "sweep final $fin"
  [ "$(events | wc -l)" = "$n" ] || fail "final $fin: $(events)"
done

# merged is not final: a merged issue GitHub closed gets closed (owner decision on #345) ...
reset
closed_issue 7 completed
seed claimed 7
seed merged 7
rc_of "$SWEEP"
expect_rc 0 "sweep merged then closed"
events | tail -n 1 | jq -e '.state == "closed" and .issue == 7' > /dev/null || fail "merged then closed: $(events)"
# ... once
n=$(events | wc -l)
rc_of "$SWEEP"
[ "$(events | wc -l)" = "$n" ] || fail "merged then closed twice: $(events)"
# a stray event after closed (the real #239 shape: final, then verdict) closes it again
seed verdict 7
rc_of "$SWEEP"
events | tail -n 1 | jq -e '.state == "closed"' > /dev/null || fail "stray verdict after closed: $(events)"

# superseded is run-scoped and never final: a closed issue whose latest event is superseded still gets closed
reset
closed_issue 7 completed
seed claimed 7
rc_of "$EVENT" superseded --issue 7 --run r7a --repo o/r
rc_of "$SWEEP"
expect_rc 0 "sweep superseded then closed"
events | tail -n 1 | jq -e '.state == "closed" and .issue == 7' > /dev/null || fail "superseded then closed: $(events)"

# a merged issue that is still open (research, Refs) gets nothing
reset
issue 7 OPEN
seed merged 7
n=$(events | wc -l)
rc_of "$SWEEP"
expect_rc 0 "sweep merged open"
no_calls "sweep merged open"
[ "$(events | wc -l)" = "$n" ] || fail "merged open: $(events)"

# an open issue whose latest event is not final: no event, no write
reset
issue 7 OPEN
seed claimed 7
n=$(events | wc -l)
rc_of "$SWEEP"
expect_rc 0 "sweep open candidate"
no_calls "sweep open candidate"
[ "$(events | wc -l)" = "$n" ] || fail "open candidate: $(events)"

# a closed issue the log never saw gets no event
reset
closed_issue 7 completed
rc_of "$SWEEP"
expect_rc 0 "sweep unseen"
no_events "sweep unseen"

# untrusted candidate: skipped and counted; reader failure: exit 1, the others are still logged
reset
closed_issue 7 completed
closed_issue 8 completed
echo '{"login":"mallory","id":1}' > "$d/author-7"
seed claimed 7
seed claimed 8
rc_of "$SWEEP"
expect_rc 0 "sweep untrusted candidate"
events | jq -e 'select(.state == "closed" and .issue == 7)' > /dev/null && fail "untrusted candidate was closed: $(events)"
events | jq -e 'select(.state == "closed" and .issue == 8)' > /dev/null || fail "trusted candidate not closed: $(events)"
reset
closed_issue 7 completed
closed_issue 8 completed
seed claimed 7
seed claimed 8
rm -f "$d/issue-7.json"
rc_of "$SWEEP"
expect_rc 1 "sweep candidate read failure"
events | jq -e 'select(.state == "closed" and .issue == 8)' > /dev/null || fail "other candidate not closed after a failure: $(events)"

dq() { CALLUM_FLOW_DEV_QUERY_BIN="$tmpdir/dev-query" rc_of "$SWEEP"; }
# --- sweep: housekeeping events never hide a closed issue (#465) ---------------------
# delegated, then a recurring untrusted_stripped: the issue is still closed on GitHub
reset
closed_issue 7 completed
seed delegated 7
seed untrusted_stripped 7
rc_of "$SWEEP"
expect_rc 0 "sweep noise after delegated"
events | tail -n 1 | jq -e '.state == "closed" and .issue == 7 and .note == "completed" and .actor == "sweep"' > /dev/null || fail "noise: $(events)"
n=$(events | wc -l)
rc_of "$SWEEP"
[ "$(events | wc -l)" = "$n" ] || fail "noise twice: $(events)"
# every other housekeeping event is ignored the same way: a final issue stays final
reset
closed_issue 7 completed
seed closed 7
for s in renewed usage watcher_error test_weakened claim_lost; do seed "$s" 7; done
rc_of "$EVENT" loop --issue 7 --repo o/r --note "kind=tell key=tell:closed:7 status=done"
n=$(events | wc -l)
rc_of "$SWEEP"
[ "$(events | wc -l)" = "$n" ] || fail "final then noise wrote: $(events)"
# an issue known only from a mirror run (factory-state lists it, no events): closed on GitHub gets closed
reset
closed_issue 7 completed
closed_issue 8 completed
issue 9 OPEN
echo '[]' > "$d/comments-9.json"
echo '{"repos":[{"repo":"o/r","issues":[{"issue":7,"stage":"in pipeline"},{"issue":9,"stage":"parked"}],"recent":[{"issue":8}]}]}' > "$d/fs-json"
FS_BIN="$tmpdir/factory-state" rc_of "$SWEEP"
expect_rc 0 "sweep mirror-only"
events | jq -e 'select(.state == "closed" and .issue == 7 and .actor == "sweep")' > /dev/null || fail "mirror-only not closed: $(events)"
[ "$(events | grep -c '"state":"closed"')" = 1 ] || fail "only the live closed issue gets closed (not recent #8, not open #9): $(events)"
# the stubbed tool keeps listing it, but the log now ends it, so the second run must not double-log
n=$(events | wc -l)
FS_BIN="$tmpdir/factory-state" rc_of "$SWEEP"
[ "$(events | wc -l)" = "$n" ] || fail "mirror-only twice: $(events)"
# abandoned, then a later mirror run (factory-state lists it again, no new events): closed on GitHub gets closed
reset
closed_issue 7 completed
seed abandoned 7
echo '{"repos":[{"repo":"o/r","issues":[{"issue":7,"stage":"in pipeline"}],"recent":[]}]}' > "$d/fs-json"
FS_BIN="$tmpdir/factory-state" rc_of "$SWEEP"
expect_rc 0 "sweep abandoned then mirror run"
events | tail -n 1 | jq -e '.state == "closed" and .issue == 7 and .actor == "sweep"' > /dev/null || fail "abandoned then mirror run not closed: $(events)"
n=$(events | wc -l)
FS_BIN="$tmpdir/factory-state" rc_of "$SWEEP"
[ "$(events | wc -l)" = "$n" ] || fail "abandoned then mirror run twice: $(events)"
# abandoned and not listed (no new life): stays final, nothing logged
reset
closed_issue 7 completed
seed abandoned 7
echo '{"repos":[{"repo":"o/r","issues":[],"recent":[{"issue":7}]}]}' > "$d/fs-json"
n=$(events | wc -l)
FS_BIN="$tmpdir/factory-state" rc_of "$SWEEP"
[ "$(events | wc -l)" = "$n" ] || fail "abandoned without new life was closed: $(events)"
unset FS_BIN

# --- sweep: central factory.events via dev-query (#342) ----------------------------
# an issue only another device saw (no local event) is closed from the central read
reset
closed_issue 9 not_planned
echo '2026-10-10T10:00:00Z|9|verdict' > "$d/central"
dq
expect_rc 0 "sweep central"
events | tail -n 1 | jq -e '.state == "closed" and .issue == 9 and .note == "not_planned" and .actor == "sweep"' > /dev/null || fail "central: $(events)"
grep -q 'factory.events' "$d/dq-calls" || fail "central: no query"
n=$(events | wc -l)
dq
[ "$(events | wc -l)" = "$n" ] || fail "central twice: $(events)"
# central says closed later than the local log: nothing
reset
closed_issue 9 completed
seed claimed 9
echo '2999-01-01T00:00:00Z|9|closed' > "$d/central"
dq
[ "$(events | grep -c '"state":"closed"')" = 0 ] || fail "central final: $(events)"
# local closed later than a stale central row: nothing
reset
closed_issue 9 completed
echo '2000-01-01T00:00:00Z|9|claimed' > "$d/central"
seed closed 9
n=$(events | wc -l)
dq
[ "$(events | wc -l)" = "$n" ] || fail "local final over stale central: $(events)"
# not configured (exit 78): silent fallback to the local log
reset
closed_issue 7 completed
seed claimed 7
echo 78 > "$d/central-rc"
dq
expect_rc 0 "sweep central unconfigured"
events | tail -n 1 | jq -e '.state == "closed" and .issue == 7' > /dev/null || fail "unconfigured: $(events)"
[ ! -s "$tmpdir/err" ] || fail "unconfigured should be silent: $(cat "$tmpdir/err")"
# a failing central read warns and falls back
reset
closed_issue 7 completed
seed claimed 7
echo 3 > "$d/central-rc"
dq
expect_rc 0 "sweep central failing"
events | tail -n 1 | jq -e '.state == "closed" and .issue == 7' > /dev/null || fail "central failing: $(events)"
grep -q 'cannot read the central event log' "$tmpdir/err" || fail "central failing: no warning: $(cat "$tmpdir/err")"

# --- sweep: merged PR (closing or Refs cross-reference) --------------------------
tl() { jq -n --arg m "$1" '[{event: "cross-referenced", actor: {login: "cbundy", id: 13131067}, source: {issue: {number: 55, user: {login: "cbundy", id: 13131067}, pull_request: {merged_at: (if $m == "" then null else $m end)}}}}]'; }
# a PR merged after the claim on the issue's own branch (issue-<N>, or issue-<N>-..., after any
# prefix/) leaves a lapsed claim alone
for ref in feat/issue-7-claim issue-7 fix/issue-7 issue-7-x; do
  reset
  echo "$ref" > "$d/head-ref-55"
  issue 7 OPEN
  seed claimed 7
  cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
  tl '2026-10-08T09:00:00Z' > "$d/timeline-7.json"
  n=$(events | wc -l)
  rc_of "$SWEEP"
  expect_rc 0 "sweep merged [$ref]"
  no_calls "sweep merged [$ref]"
  [ "$(events | wc -l)" = "$n" ] || fail "sweep merged [$ref] wrote: $(events)"
done
# a PR merged before the claim, or not merged at all, does not count
for m in '2026-10-07T00:00:00Z' ''; do
  reset
  issue 7 OPEN
  seed claimed 7
  cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
  echo feat/issue-7-claim > "$d/head-ref-55"
  tl "$m" > "$d/timeline-7.json"
  rc_of "$SWEEP"
  calls | grep -q -- '--add-label ready' || fail "PR merged [$m] must not shield a stale claim"
done
for ref in release/v0.11.0 feat/issue-77-other issue-70 issue-7x feat/notissue-7; do
  reset
  issue 7 OPEN
  seed claimed 7
  cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
  echo "$ref" > "$d/head-ref-55"
  tl '2026-10-08T09:00:00Z' > "$d/timeline-7.json"
  rc_of "$SWEEP"
  calls | grep -q -- '--add-label ready' || fail "merged PR on $ref must not count as issue 7 done"
done

# an unreadable PR never reclaims the issue
reset
issue 7 OPEN
seed claimed 7
cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
rm -f "$d/head-ref-55"
tl '2026-10-08T09:00:00Z' > "$d/timeline-7.json"
n=$(events | wc -l)
rc_of "$SWEEP"
expect_rc 1 "sweep unreadable PR"
no_calls "sweep unreadable PR"
[ "$(events | wc -l)" = "$n" ] || fail "sweep unreadable PR wrote: $(events)"

# --- sweep: legacy claim without a comment is untouched --------------------------
reset
issue 7 OPEN
seed claimed 7
brief | arr > "$d/comments-7.json"
n=$(events | wc -l)
rc_of "$SWEEP"
expect_rc 0 "sweep legacy"
no_calls "sweep legacy"
[ "$(events | wc -l)" = "$n" ] || fail "sweep legacy wrote: $(events)"
grep -q 'no claim comment' "$tmpdir/err" || fail "legacy: no stderr note"

# --- trust (cbundy/dev-system#310): untrusted text is ignored or refused -----------
# the reader logs untrusted_stripped when it refuses; no other event may appear
no_factory_events() { [ -z "$(events | jq -c 'select(.state != "untrusted_stripped")')" ] || fail "$1: unexpected events: $(events)"; }
STRANGER='{"login":"mallory","id":999}'
# scm <id> <device> <created> <updated> - a claim comment by an untrusted author
scm() { cm "$@" | jq --argjson u "$STRANGER" '.user = $u'; }

# a stranger's older, unexpired claim neither blocks nor wins
reset
scm 100 devB "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
rc_of "$CLAIM" 7
expect_rc 0 "stranger's live claim does not block"
calls | grep -q '^POST 7$' || fail "stranger's live claim blocked the claim: $(calls)"
calls | grep -q 'DELETE' && fail "stranger's live claim won the re-read"
no_events_lost() { events | jq -e '.state == "claim_lost"' >/dev/null 2>&1 && fail "$1: claim_lost logged"; return 0; }
no_events_lost "stranger's live claim"

# in the re-read race a stranger's earlier claim does not win
reset
scm 100 devB '2026-10-08T11:59:59Z' '2026-10-08T11:59:59Z' | jq -s '.' > "$d/inject-7.json"
rc_of "$CLAIM" 7
expect_rc 0 "stranger does not win the race"
calls | grep -q 'DELETE' && fail "race: our claim was deleted"
calls | grep -q 'issue edit 7' || fail "race: labels not swapped"

# a trusted live claim still blocks when a stranger also claimed
reset
{ scm 101 devC "$FRESH" "$FRESH"; cm 100 devB "$FRESH" "$FRESH"; } | arr > "$d/comments-7.json"
rc_of "$CLAIM" 7
expect_rc 3 "trusted claim still blocks"
no_calls "trusted claim still blocks"

# heartbeat ignores a stranger's claim even when it names this device
reset
scm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
rc_of "$CLAIM" --heartbeat 7
expect_rc 0 "heartbeat ignores stranger"
no_calls "heartbeat ignores stranger"
reset
seed claimed 7
scm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
rc_of "$CLAIM" --heartbeat
expect_rc 0 "heartbeat all ignores stranger"
no_calls "heartbeat all ignores stranger"

# an untrusted issue is refused: nothing written, no event
for who in '{"login":"mallory","id":999}' '{"login":"cbundy","id":42}'; do
  reset
  printf '%s\n' "$who" > "$d/author-7"
  cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
  rc_of "$CLAIM" 7
  expect_rc 1 "untrusted issue $who"
  no_calls "untrusted issue"
  no_factory_events "untrusted issue"
  grep -q 'not by a trusted author' "$tmpdir/err" || fail "untrusted issue reason: $(cat "$tmpdir/err")"
done
# heartbeat skips an untrusted issue silently
reset
seed claimed 7
echo "$STRANGER" > "$d/author-7"
cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
rc_of "$CLAIM" --heartbeat 7
expect_rc 0 "heartbeat untrusted issue"
no_calls "heartbeat untrusted issue"
rc_of "$CLAIM" --heartbeat
expect_rc 0 "heartbeat all, untrusted issue"
no_calls "heartbeat all, untrusted issue"

# a reader failure is an error, never "no comments": nothing is claimed
reset
touch "$d/read-fails"
rc_of "$CLAIM" 7
expect_rc 1 "claim reader failure"
no_calls "claim reader failure"
rc_of "$CLAIM" --heartbeat 7
expect_rc 1 "heartbeat reader failure"
no_calls "heartbeat reader failure"
seed claimed 7
rc_of "$CLAIM" --heartbeat
expect_rc 1 "heartbeat all, reader failure"
no_calls "heartbeat all, reader failure"
# an unusable trusted list fails closed too
reset
TRUSTED='' rc_of "$CLAIM" 7
expect_rc 1 "claim with no trusted list"
no_calls "claim with no trusted list"
unset TRUSTED
READ_BIN="$tmpdir/missing-reader" rc_of "$CLAIM" 7
expect_rc 1 "claim with no reader"
no_calls "claim with no reader"
unset READ_BIN

# --- sweep trust ------------------------------------------------------------------
# a stranger's fresh claim does not shield a stale trusted claim
reset
issue 7 OPEN
seed claimed 7
{ cm 100 devB "$STALE" "$STALE"; scm 101 devC "$FRESH" "$FRESH"; } | arr > "$d/comments-7.json"
rc_of "$SWEEP"
expect_rc 0 "sweep stranger's fresh claim"
calls | grep -q -- '--add-label ready' || fail "stranger's fresh claim shielded a stale one: $(calls)"
calls | grep "issue comment 7" | grep -q devB || fail "reclaim must name the trusted claim"
# a stranger's stale claim alone is no claim: legacy path, nothing reclaimed
reset
issue 7 OPEN
seed claimed 7
scm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
rc_of "$SWEEP"
expect_rc 0 "sweep stranger's stale claim"
no_calls "sweep stranger's stale claim"
grep -q 'no claim comment' "$tmpdir/err" || fail "stranger's claim should read as no claim"
# an untrusted issue is skipped silently
for who in '{"login":"mallory","id":999}' '{"login":"cbundy","id":42}'; do
  reset
  issue 7 CLOSED
  seed claimed 7
  echo "$who" > "$d/author-7"
  rc_of "$SWEEP"
  expect_rc 0 "sweep untrusted issue"
  no_calls "sweep untrusted closed issue"
  events | jq -e 'select(.state == "closed")' > /dev/null && fail "sweep untrusted closed issue was closed: $(events)"
done
reset
issue 7 OPEN
seed claimed 7
echo "$STRANGER" > "$d/author-7"
cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
rc_of "$SWEEP"
expect_rc 0 "sweep untrusted open issue"
no_calls "sweep untrusted open issue"
[ -z "$(events | jq -c 'select(.state != "untrusted_stripped" and .state != "claimed")')" ] || fail "sweep untrusted open issue: unexpected events: $(events)"
# an untrusted PR, or an untrusted actor, never counts as a merge
reset
echo feat/issue-7-claim > "$d/head-ref-55"
echo "$STRANGER" > "$d/pr-author-55"
issue 7 OPEN
seed claimed 7
cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
tl '2026-10-08T09:00:00Z' > "$d/timeline-7.json"
rc_of "$SWEEP"
expect_rc 0 "sweep untrusted PR"
calls | grep -q -- '--add-label ready' || fail "an untrusted merged PR shielded a stale claim: $(calls)"
reset
echo feat/issue-7-claim > "$d/head-ref-55"
issue 7 OPEN
seed claimed 7
cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
tl '2026-10-08T09:00:00Z' | jq --argjson u "$STRANGER" '.[0].actor = $u' > "$d/timeline-7.json"
rc_of "$SWEEP"
calls | grep -q -- '--add-label ready' || fail "an untrusted actor's cross-reference shielded a stale claim: $(calls)"
reset
echo feat/issue-7-claim > "$d/head-ref-55"
issue 7 OPEN
seed claimed 7
cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
tl '2026-10-08T09:00:00Z' | jq --argjson u "$STRANGER" '.[0].source.issue.user = $u' > "$d/timeline-7.json"
rc_of "$SWEEP"
calls | grep -q -- '--add-label ready' || fail "an untrusted source issue shielded a stale claim: $(calls)"
# the trusted merged PR still counts (control)
reset
echo feat/issue-7-claim > "$d/head-ref-55"
issue 7 OPEN
seed claimed 7
cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
tl '2026-10-08T09:00:00Z' > "$d/timeline-7.json"
rc_of "$SWEEP"
no_calls "trusted merged PR control"
# a reader failure is an error for the sweep, never "no comments"
reset
issue 7 OPEN
seed claimed 7
cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
touch "$d/read-fails"
rc_of "$SWEEP"
expect_rc 1 "sweep reader failure"
no_calls "sweep reader failure"
READ_BIN="$tmpdir/missing-reader" rc_of "$SWEEP"
expect_rc 1 "sweep with no reader"
no_calls "sweep with no reader"
unset READ_BIN

echo "PASS: claim.test.sh"
