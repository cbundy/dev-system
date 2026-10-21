#!/bin/bash
#
# Tests for images/base/factory-event-push-loop (cbundy/dev-system#740): the new factory event log
# shipped to factory.event_store as the writer role, against a real PostgreSQL (scripts/test-pg.sh).
# Lines are written by the real callum-flow-event. Skips cleanly with no server.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/../../.." && pwd)
BOOTSTRAP="$ROOT/images/base/factory-db-bootstrap"
LOOP="$ROOT/images/base/factory-event-push-loop"
EVENT="$ROOT/images/base/callum-flow-event"
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
looppid=''
cleanup() {
  [ -z "$looppid" ] || kill "$looppid" 2> /dev/null || :
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
  echo "factory-event-push-loop tests skipped: no PostgreSQL server"
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
db="factory_test_$$_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
names="$names $db"
FACTORY_DB_ADMIN_URL=$ADMIN FACTORY_DB_WRITER_PASSWORD=$WPW \
  bash "$BOOTSTRAP" --db "$db" > "$tmpdir/boot.out" 2>&1 || fail "bootstrap: $(cat "$tmpdir/boot.out")"
WURL=$(url_for "$db" "${db}_writer" "$WPW")
rows() { q "$db" "SELECT count(*) FROM factory.event_store"; }

# ev ARGS...: the real writer, into $EVDIR
ev() {
  CALLUM_EVENTS_DIR=$EVDIR CALLUM_FLOW_REPO=acme/widgets DEV_MACHINE_NAME=dev-box CLAUDE_CONFIG_DIR="$tmpdir/no-claude" \
    DEV_VERSIONS_FILE="$tmpdir/no-versions.json" bash "$EVENT" "$@" 2> /dev/null
}
# loop ARGS...: the loop as the writer; stdout+stderr in $tmpdir/loop.out, status in $rc
loop() {
  rc=0
  CALLUM_EVENTS_DIR=$EVDIR FACTORY_DB_WRITER_URL=$WURL timeout 60 bash "$LOOP" "$@" > "$tmpdir/loop.out" 2>&1 || rc=$?
}
NEW() { echo "$EVDIR/factory/acme__widgets.jsonl"; }

# -- 1. real lines land with columns equal to the envelope
EVDIR=$tmpdir/ev1
mkdir -p "$EVDIR"
ev claimed --issue 7 --branch issue-7
ev ready --issue 7
ev claimed --issue 8 --branch issue-8
[ "$(wc -l < "$(NEW)" | tr -d ' ')" = 3 ] || fail "writer should have written 3 new lines"
loop --once
[ "$rc" = 0 ] || fail "--once should succeed: $(cat "$tmpdir/loop.out")"
[ "$(rows)" = 3 ] || fail "3 rows expected, got $(rows): $(cat "$tmpdir/loop.out")"
n=0
while IFS= read -r line; do
  n=$((n + 1))
  got=$(q "$db" "SELECT jsonb_build_object('envelope', envelope, 'event_id', event_id, 'type', type, 'type_version', type_version, 'repo', repo, 'device', device, 'actor', actor, 'session_id', session_id, 'issue', issue, 'base_image', base_image, 'dev_image', dev_image, 'template_version', template_version, 'plugin_version', plugin_version, 'data', data, 'device_seq', device_seq, 'ts_ok', ts = '$(printf '%s' "$line" | jq -r .ts)'::timestamptz) FROM factory.event_store WHERE event_id = '$(printf '%s' "$line" | jq -r .event_id)'")
  want=$(printf '%s' "$line" | jq -c --argjson n "$n" '{envelope, event_id, type, type_version, repo, device, actor, session_id, issue, base_image, dev_image, template_version, plugin_version, data, device_seq: $n, ts_ok: true}')
  [ "$(printf '%s' "$got" | jq -cS .)" = "$(printf '%s' "$want" | jq -cS .)" ] || fail "row $n differs: $got vs $want"
done < "$(NEW)"
[ "$(cat "$EVDIR/factory/.pushed/acme__widgets.jsonl")" = 3 ] || fail "cursor should be 3"
echo "ok: lines land with equal columns"

# -- 1b. a shadow record (factory/.shadow/<tool>.jsonl) is never pushed
mkdir -p "$EVDIR/factory/.shadow"
head -n 1 "$(NEW)" > "$EVDIR/factory/.shadow/x.jsonl"
before=$(rows)
loop --once
[ "$rc" = 0 ] || fail "--once with a shadow file should succeed: $(cat "$tmpdir/loop.out")"
[ "$(rows)" = "$before" ] || fail "a .shadow line was pushed"
[ ! -e "$EVDIR/factory/.pushed/x.jsonl" ] || fail "a .shadow file got a cursor"
echo "ok: .shadow records are not pushed"

# -- 2. a second run adds nothing
before=$(cat "$EVDIR/factory/.pushed/acme__widgets.jsonl")
loop --once
if [ "$rc" != 0 ] || [ "$(rows)" != 3 ] || [ "$(cat "$EVDIR/factory/.pushed/acme__widgets.jsonl")" != "$before" ]; then fail "second run changed things"; fi
echo "ok: second run is a no-op"

# -- 3. old files untouched, and no old .pushed
EVDIR=$tmpdir/ev3
mkdir -p "$EVDIR/.pushed"
ev claimed --issue 9 --branch issue-9
# callum-flow-event writes no old line any more (#1143): the old file is a literal old-format line
printf '%s\n' '{"v":2,"ts":"2026-10-08T10:00:00Z","repo":"acme/widgets","device":"dev-box","state":"claimed","issue":9}' > "$EVDIR/acme__widgets.jsonl"
echo 1 > "$EVDIR/.pushed/acme__widgets.jsonl"
old_sum=$(cat "$EVDIR/acme__widgets.jsonl" "$EVDIR/.pushed/acme__widgets.jsonl" | sha256sum)
loop --once
[ "$rc" = 0 ] || fail "run: $(cat "$tmpdir/loop.out")"
[ "$(cat "$EVDIR/acme__widgets.jsonl" "$EVDIR/.pushed/acme__widgets.jsonl" | sha256sum)" = "$old_sum" ] || fail "old files changed"
[ "$(find "$EVDIR/.pushed" -type f | wc -l | tr -d ' ')" = 1 ] || fail "old .pushed must not gain files"
echo "ok: old files untouched"

# -- 4. a replaced (shorter) file is pushed again, with no duplicates
EVDIR=$tmpdir/ev4
mkdir -p "$EVDIR"
ev claimed --issue 21 --branch issue-21
ev ready --issue 21
loop --once
total=$(rows)
head -n 1 "$(NEW)" > "$tmpdir/short" && cp "$tmpdir/short" "$(NEW)"
loop --once
[ "$rc" = 0 ] || fail "restart run: $(cat "$tmpdir/loop.out")"
grep -q "file replaced" "$tmpdir/loop.out" || fail "restart warning missing: $(cat "$tmpdir/loop.out")"
[ "$(rows)" = "$total" ] || fail "restart must not duplicate rows"
[ "$(cat "$EVDIR/factory/.pushed/acme__widgets.jsonl")" = 1 ] || fail "cursor after restart should be 1"
echo "ok: replaced file restarts without duplicates"

# -- 5. bad lines are set aside, good lines after them land
EVDIR=$tmpdir/ev5
mkdir -p "$EVDIR"
ev claimed --issue 31 --branch issue-31
good=$(sed -n 1p "$(NEW)")
bad_uuid=$(printf '%s' "$good" | jq -c '.event_id = "not-a-uuid"')
trunc=${good:0:40}
ev ready --issue 31
printf '%s\n' "$trunc" "$bad_uuid" >> "$(NEW)"
ev ready --issue 32
before=$(rows)
loop --once
[ "$rc" = 0 ] || fail "set-aside run should succeed: $(cat "$tmpdir/loop.out")"
[ "$(rows)" = $((before + 3)) ] || fail "3 good rows expected, got $(($(rows) - before))"
[ "$(cat "$EVDIR/factory/.pushed/acme__widgets.jsonl")" = 5 ] || fail "cursor should reach the end"
ref="$EVDIR/factory/.refused/acme__widgets.jsonl"
[ "$(wc -l < "$ref" | tr -d ' ')" = 2 ] || fail "2 set aside expected: $(cat "$ref")"
[ "$(jq -r .line "$ref" | paste -sd, -)" = 3,4 ] || fail "line numbers: $(cat "$ref")"
[ "$(jq -r 'select(.line == 3) | .text' "$ref")" = "$trunc" ] || fail "raw text of line 3"
jq -e 'select(.line == 4) | .error | test("uuid")' "$ref" > /dev/null || fail "error of line 4: $(cat "$ref")"
jq -e 'select(.line == 3) | .error | test("json")' "$ref" > /dev/null || fail "error of line 3: $(cat "$ref")"
if ! grep -q "acme__widgets.jsonl line 3 refused" "$tmpdir/loop.out" || ! grep -q "acme__widgets.jsonl line 4 refused" "$tmpdir/loop.out"; then fail "warning missing: $(cat "$tmpdir/loop.out")"; fi
# judged again after a restart: still only one record each
printf '%s\n' 0 > "$EVDIR/factory/.pushed/acme__widgets.jsonl"
cp "$ref" "$tmpdir/ref.keep"
loop --once
[ "$(wc -l < "$ref" | tr -d ' ')" = 2 ] || fail "second run must add no second set-aside record"
echo 9 > "$EVDIR/factory/.pushed/acme__widgets.jsonl"
loop --once
[ "$(wc -l < "$ref" | tr -d ' ')" = 2 ] || fail "restart must not duplicate set-aside records"
echo "ok: refused lines set aside once, the rest land"

# -- 6. unreachable / missing role: non-zero, cursor stays, nothing set aside
EVDIR=$tmpdir/ev6
mkdir -p "$EVDIR"
ev claimed --issue 41 --branch issue-41
for bad in "postgresql://${db}_writer:$WPW@127.0.0.1:1/$db" "$(url_for "$db" "no_such_role_$$" "$WPW")"; do
  rc=0
  CALLUM_EVENTS_DIR=$EVDIR FACTORY_DB_WRITER_URL=$bad timeout 60 bash "$LOOP" --once > "$tmpdir/loop.out" 2>&1 || rc=$?
  [ "$rc" != 0 ] || fail "--once should fail for $bad"
  [ ! -s "$EVDIR/factory/.pushed/acme__widgets.jsonl" ] || [ "$(cat "$EVDIR/factory/.pushed/acme__widgets.jsonl")" = 0 ] || fail "cursor must not move"
  [ ! -e "$EVDIR/factory/.refused" ] || [ -z "$(ls -A "$EVDIR/factory/.refused")" ] || fail "nothing may be set aside"
  grep -q "$WPW" "$tmpdir/loop.out" && fail "password leaked"
done
echo "ok: outages move nothing and set nothing aside"

# -- 7. no URL: exits, pushes nothing
EVDIR=$tmpdir/ev7
mkdir -p "$EVDIR"
ev claimed --issue 51 --branch issue-51
before=$(rows)
rc=0
CALLUM_EVENTS_DIR=$EVDIR timeout 60 bash "$LOOP" --once > "$tmpdir/loop.out" 2>&1 || rc=$?
[ "$rc" != 0 ] || fail "no URL must fail --once"
rc=0
CALLUM_EVENTS_DIR=$EVDIR AGENTSVIEW_PG_URL=$WURL timeout 60 bash "$LOOP" --once > "$tmpdir/loop.out" 2>&1 || rc=$?
[ "$rc" != 0 ] || fail "AGENTSVIEW_PG_URL alone must not be used"
[ "$(rows)" = "$before" ] || fail "nothing may be pushed"
rc=0
CALLUM_EVENTS_DIR=$EVDIR DEV_FACTORY_EVENT_PUSH_INTERVAL=1 timeout 20 bash "$LOOP" > "$tmpdir/loop.out" 2>&1 || rc=$?
[ "$rc" = 0 ] || fail "without --once the loop must exit 0 when the URL is gone: $rc"
grep -q "stopping" "$tmpdir/loop.out" || fail "stop line missing"
echo "ok: no writer URL"

# -- 8. no DDL in the script, and the password never printed
grep -Eiq '(^|[^A-Za-z_])(CREATE|ALTER|DROP|DELETE|TRUNCATE)([^A-Za-z_]|$)' "$LOOP" && fail "the loop's text must hold no DDL or DELETE"
EVDIR=$tmpdir/ev8
mkdir -p "$EVDIR"
ev claimed --issue 61 --branch issue-61
loop --once
grep -q "$WPW" "$tmpdir/loop.out" && fail "password leaked"
echo "ok: no DDL"

# -- 9. push on write: a running loop ships a new line within seconds
EVDIR=$tmpdir/ev9
mkdir -p "$EVDIR"
ev claimed --issue 71 --branch issue-71
CALLUM_EVENTS_DIR=$EVDIR FACTORY_DB_WRITER_URL=$WURL DEV_FACTORY_EVENT_PUSH_INTERVAL=300 bash "$LOOP" > "$tmpdir/loop.out" 2>&1 &
looppid=$!
before=$(rows)
for _ in $(seq 1 20); do [ "$(rows)" -gt "$before" ] && break; sleep 0.5; done
[ "$(rows)" -gt "$before" ] || fail "first pass should push"
before=$(rows)
sleep 1.5
ev ready --issue 71
for _ in $(seq 1 16); do [ "$(rows)" -gt "$before" ] && break; sleep 0.5; done
[ "$(rows)" -gt "$before" ] || fail "the wake after the append should push within seconds"
kill "$looppid" 2> /dev/null || :
wait "$looppid" 2> /dev/null || :
looppid=''
grep -q "$WPW" "$tmpdir/loop.out" && fail "password leaked"
echo "ok: push on write"
echo "factory-event-push-loop tests passed"
