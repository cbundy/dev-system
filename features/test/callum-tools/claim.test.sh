#!/bin/sh
#
# Plain-shell tests for callum-flow-claim and callum-flow-sweep
# (cbundy/dev-system#220). A stub gh backed by JSON fixture files stands in for
# GitHub and records every mutating call, so nothing here touches the real API.
# Hermetic PATH, no network, no Docker.
# shellcheck disable=SC2015  # A && B || fail is the idiom here
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
for t in jq sed tr cat mkdir mv dirname basename date find sort cut head tail wc git awk grep rm touch chmod hostname mktemp node; do
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
  'repo view')
    case "$*" in *defaultBranchRef*) echo main ;; *) echo o/r ;; esac ;;
  'pr list')
    # the merged PRs of the default branch (rule 7): pr-list.json, [] by default; the args are recorded
    echo "$*" >> "$d/pr-list-args"
    [ ! -f "$d/pr-list-fails" ] || exit 1
    if [ -f "$d/pr-list.json" ]; then cat "$d/pr-list.json"; else echo '[]'; fi ;;
  'pr view')
    # a PR's size and closing issues: pr-view-N.json, or a failing read without one
    echo "$*" >> "$d/pr-view-args"
    [ -f "$d/pr-view-$3.json" ] || exit 1
    cat "$d/pr-view-$3.json" ;;
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
          --arg s "$(cat "$d/head-sha-$n" 2>/dev/null || true)" \
          '{number: $n, title: "t", body: "b", user: $u, head: {ref: $r, sha: (if $s == "" then null else $s end)}}' ;;
      */issues/[0-9]*)
        n=${2##*/}
        jq --argjson n "$n" --argjson u "$(author_of author "$n")" --arg t "$(cat "$d/title-$n" 2>/dev/null || echo t)" --arg p "$(cat "$d/parent-url-$n" 2>/dev/null || true)" \
          '{number: $n, title: $t, body: "b", user: $u, state: (.state | ascii_downcase), state_reason: (.state_reason // null), labels: .labels, parent_issue_url: (if $p == "" then null else $p end)}' "$d/issue-$n.json" ;;
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
  rm -rf "$tmpdir/events"/*
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
  PATH="$toolbin${EXTRA_PATH:+:$EXTRA_PATH}" STUB_DIR="$d" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_REPO=o/r CALLUM_FLOW_CLAIM_EVENTS_SOURCE="${CLAIM_SRC-new}" \
    CALLUM_FLOW_EVENT_BIN="${CLAIM_EVENT_BIN:-$EVENT}" CALLUM_EVENTS_DIR="$tmpdir/events" DEV_MACHINE_NAME=devA \
    CALLUM_FLOW_FACTORY_STATE_BIN="${FS_BIN:-$tmpdir/no-factory-state}" CALLUM_FLOW_ISSUE_READ_BIN="${READ_BIN:-$READER}" CALLUM_FLOW_SHARE_DIR="$SHARE" CALLUM_FLOW_TRUSTED_AUTHORS="${TRUSTED-cbundy:13131067}" \
    "$SH" "$@"
}
rc_of() { set +e; run "$@" >"$tmpdir/out" 2>"$tmpdir/err"; rc=$?; set -e; }
expect_rc() { [ "$rc" = "$1" ] || fail "$2: exit $rc, wanted $1 (stderr: $(cat "$tmpdir/err"))"; }
calls() { cat "$d/calls"; }
no_calls() { [ ! -s "$d/calls" ] || fail "$1: unexpected writes: $(calls)"; }
# events: the new store, where the tools write (--type ... --data); old_events: the old log, which
# callum-flow-event no longer writes (cbundy/dev-system#1143): only old_seed, a literal old-format line, reaches it
events() { cat "$tmpdir/events"/factory/*.jsonl 2>/dev/null || true; }
old_events() { cat "$tmpdir/events"/*.jsonl 2>/dev/null || true; }
no_events() { [ -z "$(events)" ] || fail "$1: unexpected events: $(events)"; [ -z "$(old_events)" ] || fail "$1: unexpected old events: $(old_events)"; }
# old_seed <state> <issue> [run]: append a literal old-format line to this device's old log, for the
# tests that read the old source
old_seed() {
  mkdir -p "$tmpdir/events"
  os_n=1
  [ ! -f "$tmpdir/events/o__r.jsonl" ] || os_n=$(($(wc -l < "$tmpdir/events/o__r.jsonl") + 1))
  jq -nc --arg state "$1" --argjson issue "$2" --arg run "${3-}" --arg id "$(printf '00000000-0000-4000-8000-%012d' "$os_n")" \
    '{v: 2, ts: (now | strftime("%Y-%m-%dT%H:%M:%SZ")), repo: "o/r", device: "devA", session_id: null, actor: "agent", state: $state,
      issue: $issue, run_id: (if $run == "" then null else $run end), branch: null, pr: null, head: null, note: null, event_id: $id,
      base_image: null, dev_image: null, template_version: null, plugin_version: null}' >> "$tmpdir/events/o__r.jsonl"
}
# seed <state> <issue> : append a real event to this device's new log (and a literal line to the old
# one); the sweep's candidates are the issues the event log and factory-state list as live (v2 SPEC
# 3.6), never a label list (a reclaimed line needs its note to reach the new store)
seed() {
  old_seed "$1" "$2"
  case "$1" in
    reclaimed) rc_of "$EVENT" reclaimed --issue "$2" --repo o/r --note "lease expired" ;;
    verdict) rc_of "$EVENT" verdict --issue "$2" --repo o/r --note "CORRECT: F1 fixed" ;;
    prompt_denied) rc_of "$EVENT" prompt_denied --issue "$2" --repo o/r --note "tool=Bash why=x" ;;
    prompt_waiting) rc_of "$EVENT" prompt_waiting --issue "$2" --repo o/r --note "session=s1" ;;
    *) rc_of "$EVENT" "$1" --issue "$2" --repo o/r ;;
  esac
}
# nseed <type> <issue> <data-json>: a native event in the new store only. The old states delegated and
# superseded have no type there, so a lifecycle event after a claim is an implementer_routed one.
nseed() { rc_of "$EVENT" --type "$1" --issue "$2" --repo o/r --data "$3"; }
ROUTED='{"model":"sonnet","reason":"default","bucket":null,"opus_pct":0}'

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
events | jq -e '.type == "claimed" and .issue == 7 and .device == "devA" and .data.lease_minutes == 120' >/dev/null || fail "fresh: event: $(events)"

# lease override
reset
CALLUM_FLOW_LEASE_MINUTES=30 rc_of "$CLAIM" 7
expect_rc 0 "lease override"
jq -e '.[-1].body | startswith("claimed-by: devA at 2026-10-08T12:00:00Z lease: 30\n")' "$d/comments-7.json" >/dev/null || fail "lease override not recorded"
events | jq -e '.type == "claimed" and .data.lease_minutes == 30' >/dev/null || fail "lease override: claimed note: $(events)"

# the claimed event carries the issue's facts (callum-flow-event --data): the title, the labels
# without the ready label the claim just removed, the parent's number when it is in the same repo
cat > "$tmpdir/event-rec" <<'STUB'
#!/bin/sh
echo "$*" >> "${STUB_DIR:?}/event-calls"
STUB
chmod +x "$tmpdir/event-rec"
reset
issue 7 OPEN ready bug enhancement
echo 'Facts of seven' > "$d/title-7"
echo 'https://api.github.com/repos/o/r/issues/3' > "$d/parent-url-7"
brief | arr > "$d/comments-7.json"
CLAIM_EVENT_BIN="$tmpdir/event-rec" rc_of "$CLAIM" 7
expect_rc 0 "facts"
[ "$(cat "$d/event-calls")" = '--type claimed --issue 7 --data {"lease_minutes":120,"title":"Facts of seven","labels":["bug","enhancement"],"parent":3}' ] || fail "facts: claimed call: $(cat "$d/event-calls")"
# a parent in another repo, or none, is null
echo 'https://api.github.com/repos/x/y/issues/3' > "$d/parent-url-7"
rm -f "$d/event-calls"
CLAIM_EVENT_BIN="$tmpdir/event-rec" rc_of "$CLAIM" 7
expect_rc 0 "facts, other repo"
grep -qF '"parent":null}' "$d/event-calls" || fail "facts, other repo: $(cat "$d/event-calls")"
# a lost claim logs no claimed event
reset
cm 100 devB '2026-10-08T11:59:59Z' '2026-10-08T11:59:59Z' | jq -s '.' > "$d/inject-7.json"
CLAIM_EVENT_BIN="$tmpdir/event-rec" rc_of "$CLAIM" 7
expect_rc 3 "facts, collision loser"
grep -q -- '--type claimed' "$d/event-calls" 2>/dev/null && fail "facts, collision loser: claimed logged: $(cat "$d/event-calls")"
# the claim rule's score (CALLUM_FLOW_CLAIM_SCORE) joins the --data object when valid
SCORE='{"score":42,"factors":[{"name":"bug","points":25},{"name":"age","points":17}]}'
score_issue() {
  reset
  issue 7 OPEN ready bug enhancement
  echo 'Facts of seven' > "$d/title-7"
  echo 'https://api.github.com/repos/o/r/issues/3' > "$d/parent-url-7"
  brief | arr > "$d/comments-7.json"
}
score_issue
CALLUM_FLOW_CLAIM_SCORE=$SCORE CLAIM_EVENT_BIN="$tmpdir/event-rec" rc_of "$CLAIM" 7
expect_rc 0 "score"
[ "$(cat "$d/event-calls")" = '--type claimed --issue 7 --data {"lease_minutes":120,"title":"Facts of seven","labels":["bug","enhancement"],"parent":3,"score":42,"factors":[{"name":"bug","points":25},{"name":"age","points":17}]}' ] || fail "score: claimed call: $(cat "$d/event-calls")"
[ ! -s "$tmpdir/err" ] || fail "score: stderr: $(cat "$tmpdir/err")"
# unset and empty give today's call
for v in unset empty; do
  score_issue
  if [ "$v" = empty ]; then CALLUM_FLOW_CLAIM_SCORE="" CLAIM_EVENT_BIN="$tmpdir/event-rec" rc_of "$CLAIM" 7
  else CLAIM_EVENT_BIN="$tmpdir/event-rec" rc_of "$CLAIM" 7; fi
  expect_rc 0 "score $v"
  [ "$(cat "$d/event-calls")" = '--type claimed --issue 7 --data {"lease_minutes":120,"title":"Facts of seven","labels":["bug","enhancement"],"parent":3}' ] || fail "score $v: $(cat "$d/event-calls")"
  [ ! -s "$tmpdir/err" ] || fail "score $v: stderr: $(cat "$tmpdir/err")"
done
# invalid values: today's call, exit 0, one warning
for bad in 'not json' '{"score":"3","factors":[]}' '{"score":3,"factors":[{"name":"a"}]}' '{"score":3,"factors":[{"name":"a","points":1,"x":1}]}' '{"score":3,"factors":[],"x":1}' '{"score":1.5,"factors":[]}' '{"score":3,"factors":[{"name":"","points":1}]}' '[1]' '{"score":1,"factors":[]} {"score":2,"factors":[]}' '{"score":1,"factors":[]} 5'; do
  score_issue
  CALLUM_FLOW_CLAIM_SCORE=$bad CLAIM_EVENT_BIN="$tmpdir/event-rec" rc_of "$CLAIM" 7
  expect_rc 0 "bad score $bad"
  [ "$(cat "$d/event-calls")" = '--type claimed --issue 7 --data {"lease_minutes":120,"title":"Facts of seven","labels":["bug","enhancement"],"parent":3}' ] || fail "bad score $bad: $(cat "$d/event-calls")"
  [ "$(cat "$tmpdir/err")" = 'callum-flow-claim: warning: CALLUM_FLOW_CLAIM_SCORE is not valid - the claim is logged without a score' ] || fail "bad score $bad: stderr: $(cat "$tmpdir/err")"
  jq -e '.[-1].body | startswith("claimed-by: devA")' "$d/comments-7.json" >/dev/null || fail "bad score $bad: comment"
done
# when the issue facts fail to read, --data carries only score and factors
score_issue
printf '#!/bin/sh\n"%s" "$@" | jq -c "del(.issue)"\n' "$READER" > "$tmpdir/reader-noissue"
chmod +x "$tmpdir/reader-noissue"
READ_BIN="$tmpdir/reader-noissue" CALLUM_FLOW_CLAIM_SCORE=$SCORE CLAIM_EVENT_BIN="$tmpdir/event-rec" rc_of "$CLAIM" 7
unset READ_BIN
expect_rc 0 "score, no facts"
[ "$(cat "$d/event-calls")" = '--type claimed --issue 7 --data {"lease_minutes":120,"score":42,"factors":[{"name":"bug","points":25},{"name":"age","points":17}]}' ] || fail "score, no facts: $(cat "$d/event-calls")"
# a lost claim logs no claimed event and gives no warning
score_issue
cm 100 devB '2026-10-08T11:59:59Z' '2026-10-08T11:59:59Z' | jq -s '.' > "$d/inject-7.json"
CALLUM_FLOW_CLAIM_SCORE='not json' CLAIM_EVENT_BIN="$tmpdir/event-rec" rc_of "$CLAIM" 7
expect_rc 3 "score, collision loser"
grep -q -- '--type claimed' "$d/event-calls" 2>/dev/null && fail "score, loser: claimed logged"
grep -q 'CALLUM_FLOW_CLAIM_SCORE' "$tmpdir/err" && fail "score, loser: warned"
# end to end through the real callum-flow-event (the new store only)
score_issue
mkdir -p "$tmpdir/nodebin"
ln -sf "$(command -v node)" "$tmpdir/nodebin/node"
rm -rf "$tmpdir/events/factory" "$tmpdir/events/o__r.jsonl" # the seeds above wrote literal old lines; the real writer must add none
EXTRA_PATH="$tmpdir/nodebin" CALLUM_FLOW_CLAIM_SCORE=$SCORE rc_of "$CLAIM" 7
expect_rc 0 "score, real writer"
events | jq -e 'select(.type == "claimed") | .data.score == 42 and (.data.factors | length) == 2' >/dev/null || fail "score e2e: new log: $(cat "$tmpdir"/events/factory/*.jsonl 2>&1)"
[ -z "$(old_events)" ] || fail "score e2e: the old log must stay empty: $(old_events)"

# --- pre-check: a live foreign claim blocks, even with stale labels -------------
reset
cm 100 devB "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
rc_of "$CLAIM" 7
expect_rc 3 "foreign live claim"
no_calls "foreign live claim"
events | jq -e '.type == "claim_lost" and .issue == 7 and .data == {holder: "devB", holder_since: "2026-10-08T11:30:00Z", race: false}' >/dev/null || fail "foreign live claim: claim_lost event: $(events)"

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
events | jq -e '.type == "claim_lost" and .issue == 7 and .device == "devA" and .data == {holder: "devB", holder_since: null, race: true}' >/dev/null || fail "collision loser: claim_lost event: $(events)"
jq -e 'map(.id) == [100]' "$d/comments-7.json" >/dev/null || fail "loser left the winner's comment alone"

# --- collision: a foreign claim posted after ours loses -------------------------
reset
echo '2026-10-08T11:59:00Z' > "$d/post-created"
cm 100 devB '2026-10-08T11:59:59Z' '2026-10-08T11:59:59Z' | jq -s '.' > "$d/inject-7.json"
rc_of "$CLAIM" 7
expect_rc 0 "collision winner"
calls | grep -q 'DELETE' && fail "winner must not delete anything"
calls | grep -q 'issue edit 7' || fail "winner must swap labels"
events | jq -e '.type == "claimed"' >/dev/null || fail "winner event"

# --- own live claim: kept only while the log shows it held -----------------------
# held (a restart, a retry of a claim whose adoption failed): no second comment, no second claimed
reset
seed claimed 7
nseed implementer_routed 7 "$ROUTED"
cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
rc_of "$CLAIM" 7
expect_rc 0 "own live claim, held"
calls | grep -q 'POST' && fail "own live claim, held: posted again: $(calls)"
[ "$(events | jq -s 'map(select(.type == "claimed")) | length')" = 1 ] || fail "own live claim, held: claimed again: $(events)"
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
  events | jq -s -e 'last | .type == "claimed" and .issue == 7 and .data.lease_minutes == 120' >/dev/null || fail "own live claim after $end: no new claimed: $(events)"
  [ "$(events | jq -s 'map(select(.type == "claimed")) | length')" = "$(case "$end" in nolog | none) echo 1 ;; *) echo 2 ;; esac)" ] || fail "own live claim after $end: claimed count: $(events)"
done

# --- label failure withdraws the claim ------------------------------------------
reset
touch "$d/edit-fails"
rc_of "$CLAIM" 7
expect_rc 1 "label failure"
calls | grep -q '^DELETE 900$' || fail "label failure must withdraw the claim"
no_events "label failure"

# a failed write (the writer exits non-zero) warns and never fails the claim
printf '#!/bin/sh\nexit 1\n' > "$tmpdir/event-fails"
chmod +x "$tmpdir/event-fails"
reset
brief | arr > "$d/comments-7.json"
CLAIM_EVENT_BIN="$tmpdir/event-fails" rc_of "$CLAIM" 7
expect_rc 0 "claim, event write fails"
grep -q 'warning: could not log the claimed event' "$tmpdir/err" || fail "claim, event write fails: no warning: $(cat "$tmpdir/err")"

# --- heartbeat ------------------------------------------------------------------
reset
{ brief; cm 100 devA "$FRESH" "$FRESH"; cm 101 devB "$FRESH" "$FRESH"; } | arr > "$d/comments-7.json"
rc_of "$CLAIM" --heartbeat 7
expect_rc 0 "heartbeat"
[ "$(calls)" = "PATCH 100" ] || fail "heartbeat must PATCH only our claim comment: $(calls)"
[ "$(cat "$d/patched-100")" = "$(printf 'claimed-by: devA at %s lease: 120\n<!-- callum-flow-claim -->\nrenewed: 2026-10-08T12:00:00Z' "$FRESH")" ] || fail "heartbeat body: $(cat "$d/patched-100")"
[ "$(events | wc -l)" = 1 ] || fail "heartbeat: events: $(events)"
events | jq -e '.type == "claim_renewed" and .issue == 7 and .device == "devA" and .data.lease_minutes == 120' >/dev/null || fail "heartbeat: renewed event: $(events)"
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

# stub dev-query: prints $STUB_DIR/central (the DISTINCT ON rows: ts|issue|state|device), or fails with $STUB_DIR/central-rc.
# A --factory call is the new store: it prints central-new (empty by default), fails with central-new-rc and is
# logged to dq-calls-new, not dq-calls.
cat > "$tmpdir/dev-query" <<'STUB'
#!/bin/sh
d=${STUB_DIR:?}
if [ "$1" = --factory ]; then
  case "$*" in
    *"type = 'merged'"*)
      # the sweep's recorded-merges read (rule 7): the PR numbers, central-merged; central-merged-rc fails it
      echo "dev-query $*" >> "$d/dq-calls-merged"
      [ ! -f "$d/central-merged-rc" ] || { echo "dev-query: boom" >&2; exit "$(cat "$d/central-merged-rc")"; }
      [ ! -f "$d/central-merged" ] || cat "$d/central-merged"
      exit 0 ;;
  esac
  echo "dev-query $*" >> "$d/dq-calls-new"
  [ ! -f "$d/central-new-rc" ] || { echo "dev-query: boom" >&2; exit "$(cat "$d/central-new-rc")"; }
  [ ! -f "$d/central-new" ] || cat "$d/central-new"
  exit 0
fi
echo "dev-query $*" >> "$d/dq-calls"
[ ! -f "$d/central-rc" ] || { echo "dev-query: boom" >&2; exit "$(cat "$d/central-rc")"; }
[ ! -f "$d/central" ] || cat "$d/central"
STUB
chmod +x "$tmpdir/dev-query"

# no-argument form: the issues this device holds by the one shared rule (claim-events.sh): the
# last claim event of the issue, in this device's log and the newest central one by ts, is a
# `claimed` by this device. callum-flow-factory-state is never read.
fs_live() { jq -n --argjson i "$1" '{repos: [{repo: "o/r", issues: $i, recent: []}]}' > "$d/fs-json"; }
hb() { CALLUM_FLOW_DEV_QUERY_BIN="$tmpdir/dev-query" rc_of "$CLAIM" --heartbeat; }
no_renewed() { ! events | jq -e 'select(.type == "claim_renewed")' >/dev/null || fail "$1: renewed logged: $(events)"; }
# the reported bug: this device claimed #7 and merged it (both in its own log); factory-state would
# still list it with this device as holder (merged is not final), so it used to renew for ever
reset
seed claimed 7
seed merged 7
fs_live '[{"issue": 7, "holder": "devA"}]'
{ brief; cm 100 devA "$FRESH" "$FRESH"; } | arr > "$d/comments-7.json"
FS_BIN="$tmpdir/factory-state" rc_of "$CLAIM" --heartbeat
expect_rc 0 "heartbeat after merged"
no_calls "heartbeat after merged"
no_renewed "heartbeat after merged"
[ ! -e "$d/fs-calls" ] || fail "heartbeat read factory-state: $(cat "$d/fs-calls")"
# every other end in this device's own log stops it the same way
for end in ready reclaimed closed abandoned; do
  reset
  seed claimed 7
  seed "$end" 7
  cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
  rc_of "$CLAIM" --heartbeat
  expect_rc 0 "heartbeat after $end"
  no_calls "heartbeat after $end"
done
# the held issues are renewed: #7 (held here), not #8 (a later claim by devB in factory.events), not
# #9 (closed on GitHub)
reset
issue 8 OPEN
issue 9 CLOSED
for n in 7 8 9; do seed claimed "$n"; done
echo '2999-01-01T00:00:00Z|8|claimed|devB' > "$d/central-new"
{ brief; cm 100 devA "$FRESH" "$FRESH"; } | arr > "$d/comments-7.json"
cm 101 devA "$FRESH" "$FRESH" | arr > "$d/comments-8.json"
cm 102 devA "$FRESH" "$FRESH" | arr > "$d/comments-9.json"
hb
expect_rc 0 "heartbeat all"
[ "$(calls)" = "PATCH 100" ] || fail "heartbeat all: only #7 is renewed: $(calls)"
events | jq -e 'select(.type == "claim_renewed")' | jq -s -e 'length == 1 and .[0].issue == 7' >/dev/null || fail "heartbeat all: renewed event: $(events)"
# a claim logged here whose push has not reached factory.events is still renewed
reset
seed claimed 7
cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
hb
expect_rc 0 "heartbeat, push lagging"
[ "$(calls)" = "PATCH 100" ] || fail "heartbeat, push lagging: $(calls)"
grep -q -- '--factory' "$d/dq-calls-new" || fail "heartbeat, push lagging: no central query"
# an end another device logged after this device's claimed stops the heartbeat
for end in merged reclaimed closed abandoned; do
  reset
  seed claimed 7
  echo "2999-01-01T00:00:00Z|7|$(if [ "$end" = reclaimed ]; then echo requeued; else echo "$end"; fi)|devB" > "$d/central-new"
  cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
  hb
  expect_rc 0 "heartbeat, central $end"
  no_calls "heartbeat, central $end"
done
# ... but an end older than this device's claim does not
reset
seed claimed 7
echo '2000-01-01T00:00:00Z|7|merged|devB' > "$d/central-new"
cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
hb
[ "$(calls)" = "PATCH 100" ] || fail "heartbeat, older central end: $(calls)"
# the default source is new (cbundy/dev-system#906): the deciding row is in the new store, the old one is not read
reset
seed claimed 7
echo '2999-01-01T00:00:00Z|7|merged|devB' > "$d/central-new"
cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
CLAIM_SRC=
hb
unset CLAIM_SRC
expect_rc 0 "heartbeat, default source, end in the new store"
no_calls "heartbeat, default source, end in the new store"
no_renewed "heartbeat, default source, end in the new store"
grep -q -- '--factory' "$d/dq-calls-new" || fail "heartbeat, default source: no --factory query"
[ ! -e "$d/dq-calls" ] || fail "heartbeat, default source read the old store: $(cat "$d/dq-calls")"
# a row only in the old store does not stop it: the default does not read there
reset
echo '2026-10-10T10:00:00Z|7|claimed|devA' > "$d/central-new"
echo '2999-01-01T00:00:00Z|7|merged|devB' > "$d/central"
cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
CLAIM_SRC=
hb
unset CLAIM_SRC
[ "$(calls)" = "PATCH 100" ] || fail "heartbeat, default source ignores the old store: $(calls)"
# the central read failing warns once and renews from this device's log; unconfigured (78) is silent
reset
seed claimed 7
echo 3 > "$d/central-new-rc"
cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
hb
expect_rc 0 "heartbeat, central failing"
[ "$(calls)" = "PATCH 100" ] || fail "heartbeat, central failing: $(calls)"
[ "$(grep -c 'cannot read the central event log' "$tmpdir/err")" = 1 ] || fail "heartbeat, central failing: warning: $(cat "$tmpdir/err")"
reset
seed claimed 7
echo 78 > "$d/central-new-rc"
cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
hb
expect_rc 0 "heartbeat, central unconfigured"
[ "$(calls)" = "PATCH 100" ] || fail "heartbeat, central unconfigured: $(calls)"
[ ! -s "$tmpdir/err" ] || fail "heartbeat, central unconfigured should be silent: $(cat "$tmpdir/err")"
# nothing to renew is still success: another device holds #7
reset
echo '2999-01-01T00:00:00Z|7|claimed|devB' > "$d/central-new"
cm 100 devB "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
hb
expect_rc 0 "heartbeat nothing"
no_calls "heartbeat nothing"
no_events "heartbeat nothing"
# from the local log alone: #7 is claimed; #8 was claimed and then released; #9 claimed and closed;
# #10 claimed, then a v2 transition (a lifecycle event that is no release); #11 never claimed here.
reset
issue 8 OPEN
issue 9 OPEN
issue 10 OPEN
issue 11 OPEN
for n in 7 8 9 10; do rc_of "$EVENT" claimed --issue "$n" --repo o/r --note 'lease: 120'; done
seed reclaimed 8
rc_of "$EVENT" closed --issue 9 --repo o/r
rc_of "$EVENT" transition --issue 10 --repo o/r --note 'row=T1 life=a seq=1 from=queued to=designing'
rc_of "$EVENT" renewed --issue 7 --repo o/r --note 'lease: 120'
rc_of "$EVENT" ready --issue 11 --repo o/r
for n in 7 8 9 10 11; do cm "$((100 + n))" devA "$FRESH" "$FRESH" | arr > "$d/comments-$n.json"; done
before=$(events | wc -l)
rc_of "$CLAIM" --heartbeat
expect_rc 0 "heartbeat from the local log"
[ "$(calls | sort | tr '\n' ' ')" = "PATCH 107 PATCH 110 " ] || fail "heartbeat from the local log: only #7 and #10 are this device's unreleased claims: $(calls)"
[ "$(events | wc -l)" = "$((before + 2))" ] || fail "heartbeat from the local log: one renewed event each: $(events)"
# this device has no log: nothing claimed here, nothing renewed
reset
cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
rc_of "$CLAIM" --heartbeat
expect_rc 0 "heartbeat, no log"
no_calls "heartbeat, no log"
# this device's log cannot be located: an error, nothing renewed
reset
cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
cat > "$tmpdir/no-path-event" <<'STUB'
#!/bin/sh
[ "$1" != --path ] || exit 2
exec "$REAL_EVENT" "$@"
STUB
chmod +x "$tmpdir/no-path-event"
set +e
PATH="$toolbin" STUB_DIR="$d" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_REPO=o/r CALLUM_FLOW_CLAIM_EVENTS_SOURCE=old REAL_EVENT="$EVENT" \
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
[ "$(events | grep -c '"type":"requeued"')" = 1 ] || fail "stale: event: $(events)"
events | tail -n 1 | jq -e '.type == "requeued" and .issue == 7' >/dev/null || fail "stale: event"
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
[ "$(events | grep -c '"type":"closed"')" = 1 ] || fail "closed in dev: $(events)"
events | tail -n 1 | jq -e '.type == "closed" and .issue == 7 and .data.reason == "completed" and .actor == "sweep"' > /dev/null || fail "closed in dev event: $(events)"
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
  events | tail -n 1 | jq -e --arg r "$r" '.type == "closed" and .issue == 7 and .actor == "sweep" and (.data.reason // "") == $r' > /dev/null || fail "close [$r]: $(events)"
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

# H1's backfill of a closed issue's last stage (cbundy/dev-system#825, #1143): the old-state writer
# only ever writes the new log, with or without --new-only, so the old log's newest line stays
# `closed` and the sweep logs nothing.
# h1_event ARGS...: the real writer with node on PATH too (this suite's toolbin has none), so the
# translator runs
mkdir -p "$tmpdir/nodebin"
ln -sf "$(command -v node)" "$tmpdir/nodebin/node"
h1_event() {
  set +e
  PATH="$toolbin:$tmpdir/nodebin" CALLUM_FLOW_REPO=o/r CALLUM_EVENTS_DIR="$tmpdir/events" DEV_MACHINE_NAME=devA "$SH" "$EVENT" "$@" >"$tmpdir/out" 2>"$tmpdir/err"
  rc=$?
  set -e
}
H1NOTE='row=H1 life=x seq=3 from=merge-queue to=closed seqAt=1792182907816 since=1792182907816 resumeTo=none step=none attempt=1 cut=no triages=0 fixes=0 round=0 approvedPatch=none prClosedAt=none via=dual-write brief=none question=none notes=none why=none'
reset
closed_issue 7 completed
seed claimed 7
seed closed 7
n=$(old_events | wc -l)
h1_event transition --issue 7 --branch issue-7 --note "$H1NOTE" --new-only
expect_rc 0 "H1 backfill new-only"; [ ! -s "$tmpdir/err" ] || fail "H1 backfill stderr: $(cat "$tmpdir/err")"
[ "$(old_events | wc -l)" = "$n" ] || fail "new-only wrote to the old log: $(old_events)"
[ "$(events | grep -c '"type":"transition"')" -ge 1 ] || fail "new-only wrote no new event"
# the old source reads the old log, where the backfill left the closed event latest: the sweep adds nothing
n=$(events | wc -l)
CLAIM_SRC=old rc_of "$SWEEP"
expect_rc 0 "sweep after H1 backfill"
[ "$(events | wc -l)" = "$n" ] || fail "the sweep logged after a new-only backfill: $(events)"
# without --new-only the backfill is the same: the old log is untouched, the sweep adds nothing
reset
closed_issue 7 completed
seed claimed 7
seed closed 7
n=$(old_events | wc -l)
h1_event transition --issue 7 --branch issue-7 --note "$H1NOTE"
[ "$(old_events | wc -l)" = "$n" ] || fail "a plain backfill wrote to the old log: $(old_events)"
n=$(events | wc -l)
CLAIM_SRC=old rc_of "$SWEEP"
[ "$(events | wc -l)" = "$n" ] || fail "the sweep logged after a plain backfill: $(events)"

# the companion's prompt_denied and prompt_waiting are no lifecycle event: after closed they do not
# make the issue a candidate for a second closed
for noise in prompt_denied prompt_waiting; do
  reset
  closed_issue 7 completed
  seed claimed 7
  seed closed 7
  seed "$noise" 7
  n=$(events | wc -l)
  rc_of "$SWEEP"
  expect_rc 0 "sweep closed then $noise"
  [ "$(events | wc -l)" = "$n" ] || fail "closed then $noise: $(events)"
done

# merged is not final: a merged issue GitHub closed gets closed (owner decision on #345) ...
reset
closed_issue 7 completed
seed claimed 7
seed merged 7
rc_of "$SWEEP"
expect_rc 0 "sweep merged then closed"
events | tail -n 1 | jq -e '.type == "closed" and .issue == 7' > /dev/null || fail "merged then closed: $(events)"
# ... once
n=$(events | wc -l)
rc_of "$SWEEP"
[ "$(events | wc -l)" = "$n" ] || fail "merged then closed twice: $(events)"
# a stray event after closed (the real #239 shape: final, then verdict) closes it again
seed verdict 7
rc_of "$SWEEP"
events | tail -n 1 | jq -e '.type == "closed"' > /dev/null || fail "stray verdict after closed: $(events)"

# superseded is run-scoped and never final: a closed issue whose latest event is superseded still gets closed
reset
closed_issue 7 completed
seed claimed 7
rc_of "$EVENT" superseded --issue 7 --run r7a --repo o/r
old_seed superseded 7 r7a
# superseded has no type in the new store, so this reads the old log
CLAIM_SRC=old rc_of "$SWEEP"
expect_rc 0 "sweep superseded then closed"
events | tail -n 1 | jq -e '.type == "closed" and .issue == 7' > /dev/null || fail "superseded then closed: $(events)"

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
events | jq -e 'select(.type == "closed" and .issue == 7)' > /dev/null && fail "untrusted candidate was closed: $(events)"
events | jq -e 'select(.type == "closed" and .issue == 8)' > /dev/null || fail "trusted candidate not closed: $(events)"
reset
closed_issue 7 completed
closed_issue 8 completed
seed claimed 7
seed claimed 8
rm -f "$d/issue-7.json"
rc_of "$SWEEP"
expect_rc 1 "sweep candidate read failure"
events | jq -e 'select(.type == "closed" and .issue == 8)' > /dev/null || fail "other candidate not closed after a failure: $(events)"

dq() { CALLUM_FLOW_DEV_QUERY_BIN="$tmpdir/dev-query" rc_of "$SWEEP"; }
# --- sweep: housekeeping events never hide a closed issue (#465) ---------------------
# delegated, then a recurring untrusted_stripped: the issue is still closed on GitHub
reset
closed_issue 7 completed
seed claimed 7
nseed implementer_routed 7 "$ROUTED"
nseed untrusted_stripped 7 '{"source":"issue","refused":true,"count":null,"pr":null}'
rc_of "$SWEEP"
expect_rc 0 "sweep noise after delegated"
events | tail -n 1 | jq -e '.type == "closed" and .issue == 7 and .data.reason == "completed" and .actor == "sweep"' > /dev/null || fail "noise: $(events)"
n=$(events | wc -l)
rc_of "$SWEEP"
[ "$(events | wc -l)" = "$n" ] || fail "noise twice: $(events)"
# every other housekeeping event is ignored the same way: a final issue stays final
reset
closed_issue 7 completed
seed closed 7
nseed claim_renewed 7 '{"lease_minutes":120}'
nseed usage 7 '{"available":false,"five_hour_pct":null,"five_hour_resets_at":null,"seven_day_pct":null,"seven_day_resets_at":null,"source":null,"reasons":["x"]}'
nseed test_weakened 7 '{"branch":"b","pr":1,"head":"0123456","commit":"0123456","restored":false,"kinds":["k"],"files":["f"]}'
nseed claim_lost 7 '{"holder":"devB","holder_since":null,"race":true}'
nseed untrusted_stripped 7 '{"source":"issue","refused":true,"count":null,"pr":null}'
seed prompt_denied 7
seed prompt_waiting 7
# every one of them reached the new store, after the closed event
[ "$(events | jq -s '[.[].type] | sort | join(",")' -r)" = "claim_lost,claim_renewed,closed,prompt_denied,prompt_waiting,test_weakened,untrusted_stripped,usage" ] || fail "final then noise: seeds missing: $(events | jq -c .type)"
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
events | jq -e 'select(.type == "closed" and .issue == 7 and .actor == "sweep")' > /dev/null || fail "mirror-only not closed: $(events)"
[ "$(events | grep -c '"type":"closed"')" = 1 ] || fail "only the live closed issue gets closed (not recent #8, not open #9): $(events)"
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
events | tail -n 1 | jq -e '.type == "closed" and .issue == 7 and .actor == "sweep"' > /dev/null || fail "abandoned then mirror run not closed: $(events)"
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
echo '2026-10-10T10:00:00Z|9|finding_handled|devB' > "$d/central-new"
dq
expect_rc 0 "sweep central"
events | tail -n 1 | jq -e '.type == "closed" and .issue == 9 and .data.reason == "not_planned" and .actor == "sweep"' > /dev/null || fail "central: $(events)"
grep -q -- '--factory' "$d/dq-calls-new" || fail "central: no query"
n=$(events | wc -l)
dq
[ "$(events | wc -l)" = "$n" ] || fail "central twice: $(events)"
# the default source is new: an issue only another device saw, in the new store, is closed from there
reset
closed_issue 9 not_planned
echo '2026-10-10T10:00:00Z|9|transition|devB' > "$d/central-new"
CLAIM_SRC=
dq
unset CLAIM_SRC
expect_rc 0 "sweep central, default source"
events | tail -n 1 | jq -e '.type == "closed" and .issue == 9 and .data.reason == "not_planned" and .actor == "sweep"' > /dev/null || fail "central, default source: $(events)"
grep -q -- '--factory' "$d/dq-calls-new" || fail "central, default source: no --factory query"
[ ! -e "$d/dq-calls" ] || fail "central, default source read the old store: $(cat "$d/dq-calls")"
# an end another device logged in the new store is seen: nothing to close
reset
closed_issue 9 completed
seed claimed 9
echo '2999-01-01T00:00:00Z|9|closed|devB' > "$d/central-new"
CLAIM_SRC=
dq
unset CLAIM_SRC
[ "$(events | grep -c '"type":"closed"')" = 0 ] || fail "central final, default source: $(events)"
# central says closed later than the local log: nothing
reset
closed_issue 9 completed
seed claimed 9
echo '2999-01-01T00:00:00Z|9|closed|devB' > "$d/central-new"
dq
[ "$(events | grep -c '"type":"closed"')" = 0 ] || fail "central final: $(events)"
# local closed later than a stale central row: nothing
reset
closed_issue 9 completed
echo '2000-01-01T00:00:00Z|9|claimed|devB' > "$d/central-new"
seed closed 9
n=$(events | wc -l)
dq
[ "$(events | wc -l)" = "$n" ] || fail "local final over stale central: $(events)"
# not configured (exit 78): silent fallback to the local log
reset
closed_issue 7 completed
seed claimed 7
echo 78 > "$d/central-new-rc"
dq
expect_rc 0 "sweep central unconfigured"
events | tail -n 1 | jq -e '.type == "closed" and .issue == 7' > /dev/null || fail "unconfigured: $(events)"
[ ! -s "$tmpdir/err" ] || fail "unconfigured should be silent: $(cat "$tmpdir/err")"
# a failing central read warns and falls back
reset
closed_issue 7 completed
seed claimed 7
echo 3 > "$d/central-new-rc"
dq
expect_rc 0 "sweep central failing"
events | tail -n 1 | jq -e '.type == "closed" and .issue == 7' > /dev/null || fail "central failing: $(events)"
grep -q 'cannot read the central event log' "$tmpdir/err" || fail "central failing: no warning: $(cat "$tmpdir/err")"

# a claim that ended stays ended: a later event that is no claim event (the watcher's
# head_mismatch after the owner's drop) never brings its lapsed lease back, from either log
for after in head_mismatch parked central; do
  reset
  issue 7 OPEN
  if [ "$after" = central ]; then
    printf '%s\n' '2026-10-08T09:00:00Z|7|abandoned|devB' '2026-10-08T09:01:00Z|7|head_mismatch|devB' > "$d/central-new"
  else
    seed claimed 7
    seed abandoned 7
    seed "$after" 7
  fi
  cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
  n=$(events | wc -l)
  # head_mismatch and parked have no type in the new store: they are read from the old log
  if [ "$after" = central ]; then dq; else CLAIM_SRC=old dq; fi
  expect_rc 0 "sweep ended then $after"
  no_calls "sweep ended then $after"
  [ "$(events | wc -l)" = "$n" ] || fail "sweep ended then $after wrote: $(events)"
done

# --- sweep: merged PR (closing or Refs cross-reference) --------------------------
tl() { jq -n --arg m "$1" '[{event: "cross-referenced", actor: {login: "cbundy", id: 13131067}, source: {issue: {number: 55, user: {login: "cbundy", id: 13131067}, pull_request: {merged_at: (if $m == "" then null else $m end)}}}}]'; }
# a PR merged after the claim on the issue's own branch (issue-<N>, or issue-<N>-..., after any
# prefix/) ends a lapsed claim: the sweep logs one `merged` (pr, actor sweep) and writes nothing to GitHub
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
  [ "$(events | wc -l)" = $((n + 1)) ] || fail "sweep merged [$ref]: one event: $(events)"
  events | tail -n 1 | jq -e '.type == "merged" and .issue == 7 and .data.pr == 55 and .actor == "sweep" and .data.head == null' >/dev/null || fail "sweep merged [$ref]: event: $(events)"
done
# merged by hand, whoever holds the claim and however live it is: a claim kept live by renewals
# (devA's own, renewed a minute ago) still ends. The PR read's head sha rides along. A second sweep
# writes nothing, and the heartbeat afterwards renews nothing.
for who in devA devB; do
  reset
  echo feat/issue-7-claim > "$d/head-ref-55"
  echo 0123456789abcdef0123456789abcdef01234567 > "$d/head-sha-55"
  issue 7 OPEN
  seed claimed 7
  { brief; cm 100 "$who" "$STALE" "$FRESH"; } | arr > "$d/comments-7.json"
  tl '2026-10-08T09:00:00Z' > "$d/timeline-7.json"
  rc_of "$SWEEP"
  expect_rc 0 "sweep merged by hand, live claim of $who"
  no_calls "sweep merged by hand, live claim of $who"
  [ "$(events | jq -s 'map(select(.type == "merged")) | length')" = 1 ] || fail "merged by hand ($who): $(events)"
  events | tail -n 1 | jq -e '.type == "merged" and .data.pr == 55 and .actor == "sweep" and .data.head == "0123456789abcdef0123456789abcdef01234567"' >/dev/null || fail "merged by hand ($who): event: $(events)"
  events | tail -n 1 | jq -e '.data.files == null and .data.additions == null and .data.deletions == null' >/dev/null || fail "merged by hand ($who): the unread size is null: $(events)"
  grep -q 'could not read the size of PR #55' "$tmpdir/err" || fail "merged by hand ($who): no size warning: $(cat "$tmpdir/err")"
  n=$(events | wc -l)
  rc_of "$SWEEP"
  expect_rc 0 "sweep merged by hand twice"
  no_calls "sweep merged by hand twice"
  [ "$(events | wc -l)" = "$n" ] || fail "merged by hand twice wrote: $(events)"
  rc_of "$CLAIM" --heartbeat
  no_calls "heartbeat after a merge by hand"
done
# a live claim with no merged PR is still left alone and logs nothing
reset
issue 7 OPEN
seed claimed 7
cm 100 devB "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
echo feat/issue-7-claim > "$d/head-ref-55"
tl '2026-10-07T00:00:00Z' > "$d/timeline-7.json"
n=$(events | wc -l)
rc_of "$SWEEP"
no_calls "live claim, no merge"
[ "$(events | wc -l)" = "$n" ] || fail "live claim, no merge wrote: $(events)"
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

# --- double reclaim (cbundy/dev-system#660): one lapsed claim is reclaimed once, across devices ------
# devA's own log still says claimed, factory.events has devB's later reclaimed; the comment is stale and
# nothing merged. devA's sweep leaves the issue alone: no edit, no comment, no second reclaimed.
reset
issue 7 OPEN
seed claimed 7
echo '2999-01-01T00:00:00Z|7|requeued|devB' > "$d/central-new"
cm 100 devA "$STALE" "$STALE" | arr > "$d/comments-7.json"
n=$(events | wc -l)
dq
expect_rc 0 "sweep, reclaimed by another device"
no_calls "sweep, reclaimed by another device"
[ "$(events | wc -l)" = "$n" ] || fail "second reclaim wrote: $(events)"
# control: with no later end the same stale claim is reclaimed, once
reset
issue 7 OPEN
seed claimed 7
echo '2000-01-01T00:00:00Z|7|claimed|devB' > "$d/central-new"
cm 100 devA "$STALE" "$STALE" | arr > "$d/comments-7.json"
dq
[ "$(calls | grep -c -- '--add-label ready')" = 1 ] || fail "control reclaim: $(calls)"
[ "$(events | jq -s 'map(select(.type == "requeued")) | length')" = 1 ] || fail "control reclaim: $(events)"

# --- claim mode, across devices -------------------------------------------------------------
# an own live comment while factory.events shows a later end by another device: deleted, claimed fresh
reset
seed claimed 7
echo '2999-01-01T00:00:00Z|7|requeued|devB' > "$d/central-new"
cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
CALLUM_FLOW_DEV_QUERY_BIN="$tmpdir/dev-query" rc_of "$CLAIM" 7
expect_rc 0 "claim, central end"
[ "$(calls | grep -v '^issue edit')" = "$(printf 'DELETE 100\nPOST 7')" ] || fail "claim, central end: not a fresh claim: $(calls)"
# held by the combined rule (nothing later centrally): the live comment is kept
reset
seed claimed 7
echo '2000-01-01T00:00:00Z|7|requeued|devB' > "$d/central-new"
cm 100 devA "$FRESH" "$FRESH" | arr > "$d/comments-7.json"
CALLUM_FLOW_DEV_QUERY_BIN="$tmpdir/dev-query" rc_of "$CLAIM" 7
expect_rc 0 "claim, held"
calls | grep -q 'POST\|DELETE' && fail "claim, held: $(calls)"
grep -q -- '--factory' "$d/dq-calls-new" || fail "claim, held: no central query"

# --- the claim-event lists live in one file ---------------------------------------------------
grep -q '"claimed", "ready", "reclaimed", "merged", "closed", "abandoned"' "$SHARE/claim-events.sh" || fail "claim-events.sh lacks the claim-event list"
grep -q '"untrusted_stripped", "usage"' "$SHARE/claim-events.sh" || fail "claim-events.sh lacks the noise list"
for f in "$CLAIM" "$SWEEP"; do
  # code lines only: the header comments may name the states
  if grep -v '^[[:space:]]*#' "$f" | grep -Eq "ready.{1,4}reclaimed|untrusted_stripped|prompt_waiting"; then
    fail "$(basename "$f") repeats a state list from claim-events.sh"
  fi
done
! grep -v '^[[:space:]]*#' "$CLAIM" | grep -q 'FSTATE\|FACTORY_STATE_BIN\|factory-state' || fail "callum-flow-claim still reads factory-state"

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
no_factory_events() { [ -z "$(events | jq -c 'select(.type != "untrusted_stripped")')" ] || fail "$1: unexpected events: $(events)"; }
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
no_events_lost() { events | jq -e '.type == "claim_lost"' >/dev/null 2>&1 && fail "$1: claim_lost logged"; return 0; }
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
  events | jq -e 'select(.type == "closed")' > /dev/null && fail "sweep untrusted closed issue was closed: $(events)"
done
reset
issue 7 OPEN
seed claimed 7
echo "$STRANGER" > "$d/author-7"
cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
rc_of "$SWEEP"
expect_rc 0 "sweep untrusted open issue"
no_calls "sweep untrusted open issue"
[ -z "$(events | jq -c 'select(.type != "untrusted_stripped" and .type != "claimed")')" ] || fail "sweep untrusted open issue: unexpected events: $(events)"
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

# rule 4 carries the PR's size when it reads (files, additions and deletions)
reset
echo feat/issue-7-claim > "$d/head-ref-55"
issue 7 OPEN
seed claimed 7
cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
tl '2026-10-08T09:00:00Z' > "$d/timeline-7.json"
echo '{"files":[{"path":"a.js"},{"path":""},{"path":"b/c.sh"}],"additions":12,"deletions":3}' > "$d/pr-view-55.json"
rc_of "$SWEEP"
expect_rc 0 "sweep merged with a size"
events | tail -n 1 | jq -e '.type == "merged" and .issue == 7 and .data.files == ["a.js", "b/c.sh"] and .data.additions == 12 and .data.deletions == 3 and .data.by == "factory" and .data.recovered == false' >/dev/null || fail "rule 4 size: $(events)"
grep -qx 'pr view 55 --repo o/r --json files,additions,deletions' "$d/pr-view-args" || fail "rule 4 size read: $(cat "$d/pr-view-args")"

# --- sweep rule 7: unrecorded merges to main ---------------------------------------------------
# 2026-10-08T12:00:00Z now, a 7 day window (from 2026-10-01) and a one hour settle time (merged at or before 11:00)
H1=1111111111111111111111111111111111111111
H2=2222222222222222222222222222222222222222
H3=3333333333333333333333333333333333333333
# pl <number> <ref> <sha> <mergedAt>... : the stubbed `gh pr list` rows
pl() { jq -n '$ARGS.positional | . as $a | [range(0; length; 4) | {number: ($a[.] | tonumber), headRefName: $a[. + 1], headRefOid: $a[. + 2], mergedAt: $a[. + 3]}]' --args "$@" > "$d/pr-list.json"; }
# pv <number> [closing issue]... : the stubbed `gh pr view` of that PR
pv() {
  pn=$1
  shift
  jq -n --arg n "$*" '{closingIssuesReferences: [$n | split(" ")[] | select(. != "") | {number: tonumber, repository: {name: "r", owner: {login: "o"}}}], files: [{path: "x.js"}, {path: "y.sh"}], additions: 5, deletions: 1}' > "$d/pr-view-$pn.json"
  echo "feat/p$pn" > "$d/head-ref-$pn"
}
merged_rows() { events | jq -c 'select(.type == "merged")'; }
sweep7() { CALLUM_FLOW_DEV_QUERY_BIN="$tmpdir/dev-query" rc_of "$SWEEP"; }

# an unlinked merged PR is logged once: by hand, recovered, actor sweep, no issue; its head is GitHub's headRefOid
reset
pl 60 main-fix "$H1" 2026-10-07T10:00:00Z
pv 60
sweep7
expect_rc 0 "rule 7 unlinked"
no_calls "rule 7 unlinked"
[ "$(merged_rows | wc -l)" = 1 ] || fail "rule 7 unlinked: one event: $(events)"
merged_rows | jq -e --arg h "$H1" '.actor == "sweep" and (.issue == null) and .data == {pr: 60, branch: "main-fix", head: $h, by: "hand", recovered: true, files: ["x.js", "y.sh"], additions: 5, deletions: 1}' > /dev/null || fail "rule 7 unlinked: event: $(events)"
grep -q -- '--base main' "$d/pr-list-args" && grep -q -- 'merged:>=2026-10-01' "$d/pr-list-args" && grep -q -- '--limit 200' "$d/pr-list-args" || fail "rule 7 list args: $(cat "$d/pr-list-args")"
grep -q 'repo=o/r' "$d/dq-calls-merged" || fail "rule 7 central read: $(cat "$d/dq-calls-merged")"
# a second run writes nothing
n=$(events | wc -l)
sweep7
expect_rc 0 "rule 7 twice"
[ "$(events | wc -l)" = "$n" ] || fail "rule 7 twice wrote: $(events)"
# a second device whose central read holds the first device's row writes nothing
reset
pl 60 main-fix "$H1" 2026-10-07T10:00:00Z
pv 60
echo 60 > "$d/central-merged"
sweep7
expect_rc 0 "rule 7 recorded centrally"
[ -z "$(merged_rows)" ] || fail "rule 7 logged a merge another device recorded: $(events)"

# a trusted PR that closes #7 is logged with issue 7 (the lowest in this repo; another repo's issue never counts); an untrusted one without
reset
pl 61 feat/issue-3-x "$H1" 2026-10-07T10:00:00Z 62 feat/issue-9 "$H2" 2026-10-07T11:00:00Z
pv 61 9 7
jq '.closingIssuesReferences += [{number: 2, repository: {name: "other", owner: {login: "o"}}}]' "$d/pr-view-61.json" > "$d/t" && mv "$d/t" "$d/pr-view-61.json"
pv 62 9
echo '{"login":"mallory","id":1}' > "$d/pr-author-62"
sweep7
expect_rc 0 "rule 7 closing"
merged_rows | jq -e 'select(.data.pr == 61) | .issue == 7 and .data.by == "hand" and .data.recovered == true' > /dev/null || fail "rule 7 trusted closing: $(events)"
merged_rows | jq -e 'select(.data.pr == 62) | .issue == null and .actor == "sweep"' > /dev/null || fail "rule 7 untrusted: $(events)"
# the lifecycle of #7 is untouched by an untrusted PR, and the trusted one releases #7 as any merged does
# a PR that already has a merged event in this device's log (a different head, or none) is not logged
for hd in "$H3" null; do
  reset
  pl 63 feat/issue-7-x "$H1" 2026-10-07T10:00:00Z
  pv 63 7
  if [ "$hd" = null ]; then nseed merged 7 '{"pr":63,"branch":null,"head":null,"by":"factory","recovered":false}'; else nseed merged 7 "{\"pr\":63,\"branch\":null,\"head\":\"$hd\",\"by\":\"factory\",\"recovered\":false}"; fi
  n=$(events | wc -l)
  sweep7
  expect_rc 0 "rule 7 local row, head $hd"
  [ "$(events | wc -l)" = "$n" ] || fail "rule 7 logged a merge this device recorded (head $hd): $(events)"
done
# a merged event with another issue, or none, still names the PR
reset
pl 64 main-fix "$H1" 2026-10-07T10:00:00Z
pv 64
nseed merged 8 '{"pr":64,"branch":null,"head":null,"by":"hand","recovered":true}'
n=$(events | wc -l)
sweep7
[ "$(events | wc -l)" = "$n" ] || fail "rule 7 logged a merge recorded under another issue: $(events)"

# inside the settle time: not logged yet (merged at 11:30, now 12:00); a PR outside the window is not listed by the search
reset
pl 65 main-fix "$H1" 2026-10-08T11:30:00Z
pv 65
sweep7
expect_rc 0 "rule 7 settle"
[ -z "$(merged_rows)" ] || fail "rule 7 logged a merge inside the settle time: $(events)"
CALLUM_FLOW_SWEEP_MERGE_SETTLE_SECONDS=0 sweep7
[ "$(merged_rows | wc -l)" = 1 ] || fail "rule 7 with no settle time: $(events)"
reset
pl 65 main-fix "$H1" 2026-10-07T10:00:00Z
pv 65
CALLUM_FLOW_SWEEP_MERGE_WINDOW_SECONDS=86400 sweep7
grep -q 'merged:>=2026-10-07' "$d/pr-list-args" || fail "rule 7 window env: $(cat "$d/pr-list-args")"

# no central store: nothing is logged, one warning
reset
pl 66 main-fix "$H1" 2026-10-07T10:00:00Z
pv 66
echo 78 > "$d/central-merged-rc"
sweep7
expect_rc 0 "rule 7 unconfigured"
[ -z "$(merged_rows)" ] || fail "rule 7 logged without the central store (78): $(events)"
[ "$(grep -c 'unrecorded merges to main not checked' "$tmpdir/err")" = 1 ] || fail "rule 7 unconfigured: one warning: $(cat "$tmpdir/err")"
echo 3 > "$d/central-merged-rc"
sweep7
expect_rc 0 "rule 7 central failing"
[ -z "$(merged_rows)" ] || fail "rule 7 logged with a failing central read: $(events)"
[ "$(grep -c 'unrecorded merges to main not checked' "$tmpdir/err")" = 1 ] || fail "rule 7 failing: one warning: $(cat "$tmpdir/err")"
rc_of "$SWEEP"
[ -z "$(merged_rows)" ] || fail "rule 7 logged with no dev-query: $(events)"
grep -q 'unrecorded merges to main not checked' "$tmpdir/err" || fail "rule 7 no dev-query: no warning: $(cat "$tmpdir/err")"

# a failing PR read skips the PR with rc 1 and a later run retries it
reset
pl 67 main-fix "$H1" 2026-10-07T10:00:00Z 68 main-fix2 "$H2" 2026-10-07T10:00:00Z
pv 68
sweep7
expect_rc 1 "rule 7 failing PR read"
merged_rows | jq -e '.data.pr == 68' > /dev/null && [ "$(merged_rows | wc -l)" = 1 ] || fail "rule 7 failing PR read: the other PR is still logged: $(events)"
pv 67
sweep7
expect_rc 0 "rule 7 retry"
[ "$(merged_rows | wc -l)" = 2 ] || fail "rule 7 retry: $(events)"
# a failing trust read (not exit 3) skips the PR the same way
reset
pl 69 main-fix "$H1" 2026-10-07T10:00:00Z
pv 69
touch "$d/read-fails"
sweep7
expect_rc 1 "rule 7 failing trust read"
[ -z "$(merged_rows)" ] || fail "rule 7 logged a PR whose trust read failed: $(events)"
# a failing list read is an error and logs nothing
reset
pl 70 main-fix "$H1" 2026-10-07T10:00:00Z
pv 70
touch "$d/pr-list-fails"
sweep7
expect_rc 1 "rule 7 failing list"
[ -z "$(merged_rows)" ] || fail "rule 7 logged after a failing list: $(events)"
# a full page warns
reset
jq -n '[range(100; 300) | {number: ., headRefName: "b", headRefOid: "1111111", mergedAt: "2026-10-07T10:00:00Z"}]' > "$d/pr-list.json"
sweep7
grep -q 'full page of 200' "$tmpdir/err" || fail "rule 7 full page: no warning: $(cat "$tmpdir/err")"

# rule 4's row is seen by rule 7 in the same run: the merged PR is logged once, by rule 4
reset
echo feat/issue-7-claim > "$d/head-ref-55"
issue 7 OPEN
seed claimed 7
cm 100 devB "$STALE" "$STALE" | arr > "$d/comments-7.json"
tl '2026-10-08T09:00:00Z' > "$d/timeline-7.json"
pl 55 feat/issue-7-claim "$H1" 2026-10-07T10:00:00Z
pv 55 7
echo feat/issue-7-claim > "$d/head-ref-55"
sweep7
expect_rc 0 "rule 4 then rule 7"
[ "$(merged_rows | wc -l)" = 1 ] || fail "rule 4 then rule 7 logged twice: $(events)"
merged_rows | jq -e '.data.by == "factory" and .issue == 7' > /dev/null || fail "rule 4 then rule 7: $(events)"

echo "PASS: claim.test.sh"
