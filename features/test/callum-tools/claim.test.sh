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
EVENT="$ROOT/images/base/callum-flow-event"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
toolbin="$tmpdir/tools"
mkdir -p "$toolbin"
for t in jq sed tr cat mkdir mv dirname basename date find sort cut head tail wc git awk grep rm touch chmod hostname; do
  p=$(command -v "$t") || fail "$t not found"
  ln -s "$p" "$toolbin/$t"
done
SH=$(command -v sh)

d="$tmpdir/state"
cat > "$tmpdir/gh" <<'STUB'
#!/bin/sh
# State in $STUB_DIR: issue-N.json {state,labels}, comments-N.json, timeline-N.json,
# list.txt (the lagging label listing), date (server Date header), post-created,
# inject-N.json (comments that appear right after our POST).
d=${STUB_DIR:?}
now_iso=$(cat "$d/now-iso")
case "$1 $2" in
  'repo view') echo o/r ;;
  'api -i') printf 'HTTP/2 200\r\nDate: %s\r\n\r\n{}\n' "$(cat "$d/date")" ;;
  'issue list') cat "$d/list.txt" ;;
  'issue view') cat "$d/issue-$3.json" ;;
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
    case "$3" in
      */comments) cat "$d/comments-$(echo "$3" | sed 's#.*/issues/\([0-9]*\)/comments#\1#').json" ;;
      */timeline) cat "$d/timeline-$(echo "$3" | sed 's#.*/issues/\([0-9]*\)/timeline#\1#').json" ;;
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
          '{id: 900, body: $b, created_at: $c, updated_at: $c, user: {login: "me"}}' > "$d/posted.json"
        jq --slurpfile p "$d/posted.json" '. + $p' "$d/comments-$n.json" > "$d/t" && mv "$d/t" "$d/comments-$n.json"
        if [ -f "$d/inject-$n.json" ]; then
          jq -s 'add' "$d/comments-$n.json" "$d/inject-$n.json" > "$d/t" && mv "$d/t" "$d/comments-$n.json"
        fi
        cat "$d/posted.json" ;;
      'PATCH '*)
        id=${path##*/}
        for a in "$@"; do case "$a" in body=*) body=${a#body=} ;; esac; done
        echo "PATCH $id" >> "$d/calls"
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

NOW='2026-10-08T12:00:00Z'
FRESH='2026-10-08T11:30:00Z' # 30 minutes old: live under a 120 minute lease
STALE='2026-10-08T08:00:00Z' # 4 hours old: expired

# cm <id> <device> <created> <updated> [lease] - one claim comment
cm() {
  jq -n --argjson id "$1" --arg dev "$2" --arg c "$3" --arg u "$4" --arg l "${5:-120}" \
    '{id: $id, user: {login: "me"}, created_at: $c, updated_at: $u,
      body: "claimed-by: \($dev) at \($c) lease: \($l)\n<!-- callum-flow-claim -->"}'
}
brief() { jq -n '{id: 5, user: {login: "me"}, created_at: "2026-10-08T11:59:00Z", updated_at: "2026-10-08T11:59:00Z", body: "## Design brief"}'; }
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
    "$SH" "$@"
}
rc_of() { set +e; run "$@" >"$tmpdir/out" 2>"$tmpdir/err"; rc=$?; set -e; }
expect_rc() { [ "$rc" = "$1" ] || fail "$2: exit $rc, wanted $1 (stderr: $(cat "$tmpdir/err"))"; }
calls() { cat "$d/calls"; }
no_calls() { [ ! -s "$d/calls" ] || fail "$1: unexpected writes: $(calls)"; }
events() { cat "$tmpdir/events"/*.jsonl 2>/dev/null || true; }
no_events() { [ -z "$(events)" ] || fail "$1: unexpected events: $(events)"; }

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
calls | grep -qx 'issue edit 7 --add-label In development --remove-label ready --add-assignee @me' || fail "fresh: label swap: $(calls)"
[ "$(calls | grep -c '^POST')" = 1 ] || fail "fresh: more than one comment"
jq -e '.[-1].body == "claimed-by: devA at 2026-10-08T12:00:00Z lease: 120\n<!-- callum-flow-claim -->"' "$d/comments-7.json" >/dev/null ||
  fail "fresh: comment format: $(jq -r '.[-1].body' "$d/comments-7.json")"
[ "$(events | wc -l)" = 1 ] || fail "fresh: event: $(events)"
events | jq -e '.state == "claimed" and .issue == 7 and .device == "devA"' >/dev/null || fail "fresh: event: $(events)"

# lease override
reset
CALLUM_FLOW_LEASE_MINUTES=30 rc_of "$CLAIM" 7
expect_rc 0 "lease override"
jq -e '.[-1].body | startswith("claimed-by: devA at 2026-10-08T12:00:00Z lease: 30\n")' "$d/comments-7.json" >/dev/null || fail "lease override not recorded"

# --- pre-check: a live foreign claim blocks, even with stale labels -------------
reset
cm 100 devB "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
rc_of "$CLAIM" 7
expect_rc 3 "foreign live claim"
no_calls "foreign live claim"
no_events "foreign live claim"

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
no_events "collision loser"
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

# --- own live claim: no second comment ------------------------------------------
reset
cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
rc_of "$CLAIM" 7
expect_rc 0 "own live claim"
calls | grep -q 'POST' && fail "own live claim posted again"

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
# again: the renewed line is replaced, not duplicated
echo '2026-10-08T12:10:00Z' > "$d/now-iso"
: > "$d/calls"
rc_of "$CLAIM" --heartbeat 7
[ "$(grep -c '^renewed: ' "$d/patched-100")" = 1 ] || fail "heartbeat duplicated the renewed line"

# no-argument form: only this device's live claims on open In development issues
reset
issue 7 OPEN 'In development'
issue 8 OPEN 'In development'
printf '7\n8\n' > "$d/list.txt"
{ brief; cm 100 devA "$FRESH" "$FRESH"; } | arr > "$d/comments-7.json"
{ cm 101 devB "$FRESH" "$FRESH"; } | arr > "$d/comments-8.json"
rc_of "$CLAIM" --heartbeat
expect_rc 0 "heartbeat all"
[ "$(calls)" = "PATCH 100" ] || fail "heartbeat all: $(calls)"
# nothing to renew is still success
reset
issue 7 OPEN 'In development'
cm 100 devB "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
rc_of "$CLAIM" --heartbeat
expect_rc 0 "heartbeat nothing"
no_calls "heartbeat nothing"

# --- sweep: stale claim is reclaimed ---------------------------------------------
reset
issue 7 OPEN 'In development'
{ brief; cm 100 devB "$STALE" "$STALE"; } | arr > "$d/comments-7.json"
rc_of "$SWEEP"
expect_rc 0 "sweep stale"
calls | grep -q 'issue edit 7 --remove-label In development --add-label ready --remove-assignee me' || fail "stale: swap: $(calls)"
[ "$(calls | grep -c '^issue comment 7')" = 1 ] || fail "stale: comment count"
calls | grep "issue comment 7" | grep -q devB || { calls >&2; cat "$tmpdir/err" >&2; fail "stale: comment names the device"; }
[ "$(events | wc -l)" = 1 ] || fail "stale: event"
events | jq -e '.state == "reclaimed" and .issue == 7' >/dev/null || fail "stale: event"
# label-lag debounce: list.txt still returns 7; the second run writes nothing
: > "$d/calls"
rm -f "$tmpdir/events"/*
rc_of "$SWEEP"
expect_rc 0 "sweep twice"
no_calls "sweep twice"
no_events "sweep twice"

# a live claim is left alone
reset
issue 7 OPEN 'In development'
cm 100 devB "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
rc_of "$SWEEP"
expect_rc 0 "sweep live"
no_calls "sweep live"

# a renewed claim is live even though it was created long ago
reset
issue 7 OPEN 'In development'
cm 100 devB "$STALE" "$FRESH" | arr > "$d/comments-7.json"
rc_of "$SWEEP"
no_calls "sweep renewed"

# --- sweep: closed issue loses the label silently --------------------------------
reset
issue 7 CLOSED 'In development'
rc_of "$SWEEP"
expect_rc 0 "sweep closed"
[ "$(calls)" = "issue edit 7 --remove-label In development" ] || fail "closed: $(calls)"
no_events "sweep closed"

# --- sweep: merged PR (closing or Refs cross-reference) --------------------------
tl() { jq -n --arg m "$1" '[{event: "cross-referenced", source: {issue: {pull_request: {merged_at: (if $m == "" then null else $m end)}}}}]'; }
reset
issue 7 OPEN 'In development'
cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
tl '2026-10-08T09:00:00Z' > "$d/timeline-7.json"
rc_of "$SWEEP"
expect_rc 0 "sweep merged"
[ "$(calls)" = "issue edit 7 --remove-label In development" ] || fail "merged: $(calls)"
no_events "sweep merged"
# a PR merged before the claim, or not merged at all, does not count
for m in '2026-10-07T00:00:00Z' ''; do
  reset
  issue 7 OPEN 'In development'
  cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
  tl "$m" > "$d/timeline-7.json"
  rc_of "$SWEEP"
  calls | grep -q -- '--add-label ready' || fail "PR merged [$m] must not shield a stale claim"
done

# --- sweep: legacy claim without a comment is untouched --------------------------
reset
issue 7 OPEN 'In development'
brief | arr > "$d/comments-7.json"
rc_of "$SWEEP"
expect_rc 0 "sweep legacy"
no_calls "sweep legacy"
no_events "sweep legacy"
grep -q 'no claim comment' "$tmpdir/err" || fail "legacy: no stderr note"

echo "PASS: claim.test.sh"
