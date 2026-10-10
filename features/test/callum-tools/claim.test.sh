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
    CALLUM_FLOW_ISSUE_READ_BIN="${READ_BIN:-$READER}" CALLUM_FLOW_SHARE_DIR="$SHARE" CALLUM_FLOW_TRUSTED_AUTHORS="${TRUSTED-cbundy:13131067}" \
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
calls | grep -q 'issue edit 7 --remove-label In development --add-label ready --remove-assignee cbundy' || fail "stale: swap: $(calls)"
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

# --- sweep: closed issue loses the label, and the closure is logged (#342) --------
# seed <state> <issue> : append a real event to this device's log
seed() { rc_of "$EVENT" "$1" --issue "$2" --repo o/r; }
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
[ "$(calls)" = "issue edit 7 --remove-label In development" ] || fail "closed: $(calls)"
no_events "sweep closed (no prior event)"

# In development + closed + a prior claimed: label removed, one closed event, then nothing
reset
closed_issue 7 completed
jq '.labels = [{name: "In development"}]' "$d/issue-7.json" > "$d/t" && mv "$d/t" "$d/issue-7.json"
seed claimed 7
rc_of "$SWEEP"
expect_rc 0 "sweep closed in dev"
[ "$(calls)" = "issue edit 7 --remove-label In development" ] || fail "closed in dev: $(calls)"
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
grep -q 'skipped 1 logged issue' "$tmpdir/err" || fail "untrusted candidate not counted: $(cat "$tmpdir/err")"
reset
closed_issue 7 completed
closed_issue 8 completed
seed claimed 7
seed claimed 8
rm -f "$d/issue-7.json"
rc_of "$SWEEP"
expect_rc 1 "sweep candidate read failure"
events | jq -e 'select(.state == "closed" and .issue == 8)' > /dev/null || fail "other candidate not closed after a failure: $(events)"

# --- sweep: central factory.events via dev-query (#342) ----------------------------
dq() { CALLUM_FLOW_DEV_QUERY_BIN="$tmpdir/dev-query" rc_of "$SWEEP"; }
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
reset
echo feat/issue-7-claim > "$d/head-ref-55"
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
  echo feat/issue-7-claim > "$d/head-ref-55"
  tl "$m" > "$d/timeline-7.json"
  rc_of "$SWEEP"
  calls | grep -q -- '--add-label ready' || fail "PR merged [$m] must not shield a stale claim"
done
for ref in release/v0.11.0 feat/issue-77-other; do
  reset
  issue 7 OPEN 'In development'
  cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
  echo "$ref" > "$d/head-ref-55"
  tl '2026-10-08T09:00:00Z' > "$d/timeline-7.json"
  rc_of "$SWEEP"
  calls | grep -q -- '--add-label ready' || fail "merged PR on $ref must not count as issue 7 done"
done

# an unreadable PR never reclaims the issue
reset
issue 7 OPEN 'In development'
cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
rm -f "$d/head-ref-55"
tl '2026-10-08T09:00:00Z' > "$d/timeline-7.json"
rc_of "$SWEEP"
expect_rc 1 "sweep unreadable PR"
no_calls "sweep unreadable PR"
no_events "sweep unreadable PR"

# --- sweep: legacy claim without a comment is untouched --------------------------
reset
issue 7 OPEN 'In development'
brief | arr > "$d/comments-7.json"
rc_of "$SWEEP"
expect_rc 0 "sweep legacy"
no_calls "sweep legacy"
no_events "sweep legacy"
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
issue 7 OPEN 'In development'
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
issue 7 OPEN 'In development'
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
issue 7 OPEN 'In development'
rc_of "$CLAIM" --heartbeat
expect_rc 1 "heartbeat list failure"
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
issue 7 OPEN 'In development'
{ cm 100 devB "$STALE" "$STALE"; scm 101 devC "$FRESH" "$FRESH"; } | arr > "$d/comments-7.json"
rc_of "$SWEEP"
expect_rc 0 "sweep stranger's fresh claim"
calls | grep -q -- '--add-label ready' || fail "stranger's fresh claim shielded a stale one: $(calls)"
calls | grep "issue comment 7" | grep -q devB || fail "reclaim must name the trusted claim"
# a stranger's stale claim alone is no claim: legacy path, nothing reclaimed
reset
issue 7 OPEN 'In development'
scm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
rc_of "$SWEEP"
expect_rc 0 "sweep stranger's stale claim"
no_calls "sweep stranger's stale claim"
grep -q 'no claim comment' "$tmpdir/err" || fail "stranger's claim should read as no claim"
# an untrusted issue is skipped silently, apart from a count
for who in '{"login":"mallory","id":999}' '{"login":"cbundy","id":42}'; do
  reset
  issue 7 CLOSED 'In development'
  echo "$who" > "$d/author-7"
  rc_of "$SWEEP"
  expect_rc 0 "sweep untrusted issue"
  no_calls "sweep untrusted closed issue"
  grep -q 'skipped 1 ' "$tmpdir/err" || fail "sweep should count the skipped issue: $(cat "$tmpdir/err")"
done
reset
issue 7 OPEN 'In development'
echo "$STRANGER" > "$d/author-7"
cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
rc_of "$SWEEP"
expect_rc 0 "sweep untrusted open issue"
no_calls "sweep untrusted open issue"
no_factory_events "sweep untrusted open issue"
# an untrusted PR, or an untrusted actor, never counts as a merge
reset
echo feat/issue-7-claim > "$d/head-ref-55"
echo "$STRANGER" > "$d/pr-author-55"
issue 7 OPEN 'In development'
cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
tl '2026-10-08T09:00:00Z' > "$d/timeline-7.json"
rc_of "$SWEEP"
expect_rc 0 "sweep untrusted PR"
calls | grep -q -- '--add-label ready' || fail "an untrusted merged PR shielded a stale claim: $(calls)"
reset
echo feat/issue-7-claim > "$d/head-ref-55"
issue 7 OPEN 'In development'
cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
tl '2026-10-08T09:00:00Z' | jq --argjson u "$STRANGER" '.[0].actor = $u' > "$d/timeline-7.json"
rc_of "$SWEEP"
calls | grep -q -- '--add-label ready' || fail "an untrusted actor's cross-reference shielded a stale claim: $(calls)"
reset
echo feat/issue-7-claim > "$d/head-ref-55"
issue 7 OPEN 'In development'
cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
tl '2026-10-08T09:00:00Z' | jq --argjson u "$STRANGER" '.[0].source.issue.user = $u' > "$d/timeline-7.json"
rc_of "$SWEEP"
calls | grep -q -- '--add-label ready' || fail "an untrusted source issue shielded a stale claim: $(calls)"
# the trusted merged PR still counts (control)
reset
echo feat/issue-7-claim > "$d/head-ref-55"
issue 7 OPEN 'In development'
cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
tl '2026-10-08T09:00:00Z' > "$d/timeline-7.json"
rc_of "$SWEEP"
[ "$(calls)" = "issue edit 7 --remove-label In development" ] || fail "trusted merged PR control: $(calls)"
# a reader failure is an error for the sweep, never "no comments"
reset
issue 7 OPEN 'In development'
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
