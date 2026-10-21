#!/bin/bash
#
# Tests for images/base/callum-flow-dual-write-check (cbundy/dev-system#743): the read-only check
# that the old event table and the new event store agree, against a real PostgreSQL
# (scripts/test-pg.sh). The new events are written by the real callum-flow-event; the old lines are
# literal old-format lines the test writes itself (callum-flow-event no longer writes them,
# cbundy/dev-system#1143). Both are shipped by the real event-push-loop (old table) and
# factory-event-push-loop (new store). Skips cleanly with no server.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/../../.." && pwd)
BOOTSTRAP="$ROOT/images/base/factory-db-bootstrap"
CHECK="$ROOT/images/base/callum-flow-dual-write-check"
EVENT="$ROOT/images/base/callum-flow-event"
OLDLOOP="$ROOT/images/base/event-push-loop"
NEWLOOP="$ROOT/images/base/factory-event-push-loop"
TEST_REPO_ROOT=$ROOT
export TEST_REPO_ROOT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# shellcheck source=../../../scripts/test-pg.sh
. "$ROOT/scripts/test-pg.sh"

tmpdir=$(mktemp -d)
names=''
own_cluster=0
cleanup() {
  for n in $names; do factory_test_db_drop "$n" || :; done
  [ "$own_cluster" = 0 ] || test_pg_clean
  rm -rf "$tmpdir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -z "${FACTORY_TEST_PG_ADMIN_URL:-}" ]; then
  test_pg_setup || fail "no test server"
  own_cluster=1
fi
if [ -z "${FACTORY_TEST_PG_ADMIN_URL:-}" ]; then
  echo "callum-flow-dual-write-check tests skipped: no PostgreSQL server"
  exit 0
fi
ADMIN=$FACTORY_TEST_PG_ADMIN_URL

url_for() {
  local rest=${ADMIN#*://} scheme=${ADMIN%%://*} hostpart query=''
  case "$rest" in *\?*) query=${rest#*\?}; rest=${rest%%\?*} ;; esac
  hostpart=${rest##*@}
  hostpart=${hostpart%%/*}
  local cred=''
  if [ -n "${2:-}" ]; then cred="$2${3:+:$3}@"; fi
  printf '%s://%s%s/%s%s\n' "$scheme" "$cred" "$hostpart" "$1" "${query:+?$query}"
}
ADMIN_USER=$(printf '%s' "${ADMIN#*://}" | sed -n 's/^\([^:@/?]*\).*@.*/\1/p')
ADMIN_PW=$(printf '%s' "${ADMIN#*://}" | sed -n 's/^[^:@/?]*:\([^@/?]*\).*@.*/\1/p')
q() { psql -X -q -At -v ON_ERROR_STOP=1 "$(url_for "$1" "$ADMIN_USER" "$ADMIN_PW")" -c "$2"; }

unset AGENTSVIEW_PG_URL FACTORY_DB_WRITER_URL FACTORY_DB_READER_URL
export DEV_SECRETS_DIR="$tmpdir/secrets"
export DEV_WORKSPACE_SECRETS_DIR="$tmpdir/no-ws-secrets"
mkdir -p "$DEV_SECRETS_DIR"
export DEV_SYSTEM_SHARE="$ROOT/images/base"

WPW=wpw-$$-secret
RPW=rpw-$$-secret
OPW=opw-$$-secret
suffix=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
db="factory_test_$$_$suffix"
olddb="factory_test_$$_old$suffix"
names="$names $db $olddb"
FACTORY_DB_ADMIN_URL=$ADMIN FACTORY_DB_WRITER_PASSWORD=$WPW FACTORY_DB_READER_PASSWORD=$RPW \
  bash "$BOOTSTRAP" --db "$db" > "$tmpdir/boot.out" 2>&1 || fail "bootstrap: $(cat "$tmpdir/boot.out")"
q postgres "CREATE ROLE \"${olddb}_owner\" LOGIN PASSWORD '$OPW'"
q postgres "CREATE DATABASE \"$olddb\" OWNER \"${olddb}_owner\""
WURL=$(url_for "$db" "${db}_writer" "$WPW")
RURL=$(url_for "$db" "${db}_reader" "$RPW")
OURL=$(url_for "$olddb" "${olddb}_owner" "$OPW")
newrows() { q "$db" "SELECT count(*) FROM factory.event_store"; }
oldrows() { q "$olddb" "SELECT count(*) FROM factory.events"; }

EVDIR=$tmpdir/ev
mkdir -p "$EVDIR"
# ev ARGS...: the real writer, repo acme/widgets unless CALLUM_FLOW_REPO is set, device dev-box.
# An old-state call (not --type, not --new-only) also gets the literal old line the pre-cutover
# writer appended, sharing the new event's id and second (a skipped state gets its own id).
ev() {
  _repo=${EVREPO:-acme/widgets}
  _file=$(printf '%s' "$_repo" | sed 's#/#__#').jsonl
  _new=$EVDIR/factory/$_file
  _n=0
  [ ! -f "$_new" ] || _n=$(wc -l < "$_new")
  CALLUM_EVENTS_DIR=$EVDIR CALLUM_FLOW_REPO=$_repo DEV_MACHINE_NAME=${EVDEV:-dev-box} CLAUDE_CONFIG_DIR="$tmpdir/no-claude" \
    DEV_VERSIONS_FILE="$tmpdir/no-versions.json" bash "$EVENT" "$@" 2> /dev/null
  [ "$1" != --type ] || return 0
  case " $* " in *" --new-only "*) return 0 ;; esac
  _state=$1
  shift
  _issue='' _branch='' _note=''
  while [ $# -gt 0 ]; do
    case "$1" in --issue) _issue=$2 ;; --branch) _branch=$2 ;; --note) _note=$2 ;; esac
    shift 2
  done
  _line=
  [ ! -f "$_new" ] || _line=$(sed -n "$((_n + 1))p" "$_new")
  if [ -n "$_line" ]; then
    _id=$(printf '%s' "$_line" | jq -r .event_id)
    _ts=$(printf '%s' "$_line" | jq -r '.ts | sub("\\.[0-9]{3}Z$"; "Z")')
  else
    _id=$(cat /proc/sys/kernel/random/uuid)
    _ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  fi
  jq -nc --arg ts "$_ts" --arg repo "$_repo" --arg device "${EVDEV:-dev-box}" --arg state "$_state" --arg issue "$_issue" \
    --arg branch "$_branch" --arg note "$_note" --arg id "$_id" \
    '{v: 2, ts: $ts, repo: $repo, device: $device, session_id: null, actor: "agent", state: $state, issue: ($issue | tonumber),
      run_id: null, branch: (if $branch == "" then null else $branch end), pr: null, head: null,
      note: (if $note == "" then null else $note end), event_id: $id, base_image: null, dev_image: null,
      template_version: null, plugin_version: null}' >> "$EVDIR/$_file"
}
ship() {
  CALLUM_EVENTS_DIR=$EVDIR AGENTSVIEW_PG_URL="$OURL" timeout 60 bash "$OLDLOOP" --once > "$tmpdir/ship.out" 2>&1 || fail "old push: $(cat "$tmpdir/ship.out")"
  CALLUM_EVENTS_DIR=$EVDIR FACTORY_DB_WRITER_URL=$WURL timeout 60 bash "$NEWLOOP" --once > "$tmpdir/ship.out" 2>&1 || fail "new push: $(cat "$tmpdir/ship.out")"
}
# check ARGS...: the check as the reader (writer URL unset); output in $tmpdir/chk.out, status in $rc
check() {
  rc=0
  env -u FACTORY_DB_WRITER_URL DEV_MACHINE_NAME=dev-box AGENTSVIEW_PG_URL="$OURL" FACTORY_DB_READER_URL="$RURL" \
    timeout 60 bash "$CHECK" "$@" > "$tmpdir/chk.out" 2>&1 || rc=$?
}
count() { # the whole table row counts, to prove nothing is written
  printf '%s/%s\n' "$(oldrows)" "$(newrows)"
}

# -- 1. nothing shipped yet: no new rows and no --since exits 2
check
[ "$rc" = 2 ] || fail "no new rows should exit 2, got $rc: $(cat "$tmpdir/chk.out")"
grep -q "no new events" "$tmpdir/chk.out" || fail "message missing: $(cat "$tmpdir/chk.out")"
echo "ok: no new rows exits 2"

# Mixed states: claimed, ready, a skipped state (delegated), a transition re-logged with via=dual-write.
ev claimed --issue 7 --branch issue-7
ev delegated --issue 7
ev ready --issue 7
ev claimed --issue 8 --branch issue-8
ev transition --issue 8 --branch issue-8 --note "row=S0 life=l1 seq=1 from=none to=queued seqAt=1792182907816 since=1792182907816 resumeTo=none step=lease attempt=1 cut=no triages=0 fixes=0 round=0 approvedPatch=none prClosedAt=none via=dual-write brief=none question=none notes=none why=none"
ev delegated --issue 8
EVREPO=acme/gadgets ev claimed --issue 9 --branch issue-9
ship
[ "$(oldrows)" = 7 ] || fail "7 old rows expected, got $(oldrows)"
[ "$(newrows)" = 5 ] || fail "5 new rows expected (2 delegated are skipped), got $(newrows)"

# -- 2. equal: exit 0, equal counts per state
before=$(count)
check
[ "$rc" = 0 ] || fail "equal stores should exit 0, got $rc: $(cat "$tmpdir/chk.out")"
grep -q '^claimed: old=3 skipped=0 expected=3 found=3 missing=0 misses=0$' "$tmpdir/chk.out" || fail "claimed counts: $(cat "$tmpdir/chk.out")"
grep -q '^transition: old=1 skipped=0 expected=1 found=1 missing=0 misses=0$' "$tmpdir/chk.out" || fail "transition counts: $(cat "$tmpdir/chk.out")"
grep -q '^OK: missing=0 misses=0 extras=0$' "$tmpdir/chk.out" || fail "OK line: $(cat "$tmpdir/chk.out")"
echo "ok: mixed states are equal"

# -- 3. a skipped state counts as skipped, never missing
grep -q '^delegated: old=2 skipped=2 expected=0 found=0 missing=0 misses=0$' "$tmpdir/chk.out" || fail "delegated counts: $(cat "$tmpdir/chk.out")"
grep -q '^  skipped delegated=2$' "$tmpdir/chk.out" || fail "skip name: $(cat "$tmpdir/chk.out")"
echo "ok: skipped state is skipped"

# -- 4. no writer URL needed, no secrets in the output, nothing written
for pw in "$WPW" "$RPW" "$OPW" "$ADMIN_PW"; do
  [ -z "$pw" ] || ! grep -qF "$pw" "$tmpdir/chk.out" || fail "a password leaked"
done
grep -q 'postgres' "$tmpdir/chk.out" && fail "a URL leaked"
[ "$(count)" = "$before" ] || fail "row counts changed"
echo "ok: reader URL alone, nothing leaked, nothing written"

# -- 5. --repo narrows both sides
check --repo acme/gadgets
[ "$rc" = 0 ] || fail "--repo run: $(cat "$tmpdir/chk.out")"
grep -q '^old lines 1, new events 1$' "$tmpdir/chk.out" || fail "--repo should narrow both sides: $(cat "$tmpdir/chk.out")"
echo "ok: --repo narrows"

# -- 6. --since narrows both sides, and the default is the device's first new event
future=$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)
check --since "$future"
[ "$rc" = 0 ] || fail "--since future run: $(cat "$tmpdir/chk.out")"
grep -q '^old lines 0, new events 0$' "$tmpdir/chk.out" || fail "--since should narrow both sides: $(cat "$tmpdir/chk.out")"
first=$(q "$db" "SELECT to_char(date_trunc('second', min(ts)) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') FROM factory.event_store WHERE device = 'dev-box'")
check
grep -q "since=$first\$" "$tmpdir/chk.out" || fail "default since should be $first: $(cat "$tmpdir/chk.out")"
check --device nobody-box --since "$first"
[ "$rc" = 0 ] || fail "other device: $(cat "$tmpdir/chk.out")"
grep -q '^old lines 0, new events 0$' "$tmpdir/chk.out" || fail "--device should narrow: $(cat "$tmpdir/chk.out")"
check --device nobody-box
[ "$rc" = 2 ] || fail "device with no new rows and no --since should exit 2"
echo "ok: --since, --device and the default since"

# -- 7. a deleted new row is missing, naming its state and event_id
victim=$(q "$db" "SELECT event_id FROM factory.event_store WHERE type = 'ready'")
q "$db" "DELETE FROM factory.event_store WHERE event_id = '$victim'" > /dev/null
check
[ "$rc" = 1 ] || fail "a missing row should exit 1, got $rc: $(cat "$tmpdir/chk.out")"
grep -q '^ready: old=1 skipped=0 expected=1 found=0 missing=1 misses=0$' "$tmpdir/chk.out" || fail "ready counts: $(cat "$tmpdir/chk.out")"
grep -q "^  missing ready $victim\$" "$tmpdir/chk.out" || fail "missing id: $(cat "$tmpdir/chk.out")"
echo "ok: a missing new row"

# -- 8. an extra new row is reported under its type
shipped=$(q "$db" "SELECT count(*) FROM factory.event_store")
# put the deleted row back, so only the invented one is extra
q "$db" "INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, device_seq, data) SELECT 1, '$victim', now(), 'ready', 1, 'acme/widgets', 'dev-box', 'x', 99, '{}'" > /dev/null
q "$db" "INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, device_seq, data) VALUES (1, '11111111-1111-4111-8111-111111111111', now(), 'ready', 1, 'acme/widgets', 'dev-box', 'x', 100, '{}')" > /dev/null
check
[ "$rc" = 1 ] || fail "an extra row should exit 1, got $rc: $(cat "$tmpdir/chk.out")"
grep -q '^extra ready: 1$' "$tmpdir/chk.out" || fail "extra count: $(cat "$tmpdir/chk.out")"
grep -q '^  extra ready 11111111-1111-4111-8111-111111111111$' "$tmpdir/chk.out" || fail "extra id: $(cat "$tmpdir/chk.out")"
[ "$(newrows)" = $((shipped + 2)) ] || fail "check changed the store"
echo "ok: an extra new row"

# -- 8b. an event written natively (callum-flow-event --type) has no old row, so it is an extra under
# its type and the check exits 1. This pins the current behavior (cbundy/dev-system#743): the check
# proves dual write only where no producer writes natively.
ev --type claim_renewed --issue 7 --data '{"lease_minutes":30}'
ship
native=$(q "$db" "SELECT event_id FROM factory.event_store WHERE type = 'claim_renewed'")
[ -n "$native" ] || fail "the native event was not shipped to the new store"
[ "$(q "$olddb" "SELECT count(*) FROM factory.events WHERE event_id = '$native'")" = 0 ] || fail "a native event should have no old row"
check
[ "$rc" = 1 ] || fail "a native event should exit 1, got $rc: $(cat "$tmpdir/chk.out")"
grep -q '^extra claim_renewed: 1$' "$tmpdir/chk.out" || fail "native extra count: $(cat "$tmpdir/chk.out")"
grep -q "^  extra claim_renewed $native\$" "$tmpdir/chk.out" || fail "native extra id: $(cat "$tmpdir/chk.out")"
q "$db" "DELETE FROM factory.event_store WHERE event_id = '$native'" > /dev/null
echo "ok: a native event is an extra"

# -- 8c. H1's backfill (--new-only) writes a via=dual-write transition to the new log only: not an extra
oldbefore=$(oldrows)
ev transition --issue 8 --branch issue-8 --new-only --note "row=H1 life=l1 seq=2 from=queued to=building seqAt=1792182907816 since=1792182907816 resumeTo=none step=build attempt=1 cut=no triages=0 fixes=0 round=0 approvedPatch=none prClosedAt=none via=dual-write brief=none question=none notes=none why=none"
ship
[ "$(oldrows)" = "$oldbefore" ] || fail "--new-only wrote to the old log"
nov=$(q "$db" "SELECT count(*) FROM factory.event_store WHERE type = 'transition' AND data::jsonb->>'via' = 'dual-write' AND data::jsonb->>'seq' = '2'")
[ "$nov" = 1 ] || fail "the new-only transition was not shipped ($nov)"
check
grep -q '^extra transition' "$tmpdir/chk.out" && fail "a new-only via=dual-write transition was reported: $(cat "$tmpdir/chk.out")"
echo "ok: a new-only via=dual-write transition is not an extra"

# -- 9. an old row the translator misses is reported as a miss
q "$olddb" "INSERT INTO factory.events (device, repo, seq, ts, state, issue, raw, event_id) VALUES ('dev-box', 'acme/widgets', 900, now(), 'claimed', 77, '{\"state\":\"claimed\",\"repo\":\"acme/widgets\",\"device\":\"dev-box\",\"issue\":77,\"event_id\":\"22222222-2222-4222-8222-222222222222\",\"ts\":\"bad\"}', '22222222-2222-4222-8222-222222222222')" > /dev/null
check
[ "$rc" = 1 ] || fail "a miss should exit 1, got $rc"
grep -q '^  miss claimed: ' "$tmpdir/chk.out" || fail "miss reason: $(cat "$tmpdir/chk.out")"
grep -q 'misses=1' "$tmpdir/chk.out" || fail "misses count: $(cat "$tmpdir/chk.out")"
echo "ok: a translator miss"

# -- 10. outages and missing config exit 2 with a masked message
rc=0
env -u FACTORY_DB_WRITER_URL -u FACTORY_DB_READER_URL -u AGENTSVIEW_PG_URL timeout 60 bash "$CHECK" > "$tmpdir/chk.out" 2>&1 || rc=$?
[ "$rc" = 2 ] || fail "no URL should exit 2, got $rc"
rc=0
env -u FACTORY_DB_WRITER_URL AGENTSVIEW_PG_URL="$OURL" FACTORY_DB_READER_URL="postgresql://${db}_reader:$RPW@127.0.0.1:1/$db" \
  timeout 60 bash "$CHECK" > "$tmpdir/chk.out" 2>&1 || rc=$?
[ "$rc" = 2 ] || fail "unreachable store should exit 2, got $rc: $(cat "$tmpdir/chk.out")"
grep -qF "$RPW" "$tmpdir/chk.out" && fail "password leaked"
rc=0
timeout 60 bash "$CHECK" --bogus > "$tmpdir/chk.out" 2>&1 || rc=$?
[ "$rc" = 2 ] || fail "usage error should exit 2"
echo "ok: errors exit 2"
echo "callum-flow-dual-write-check tests passed"
