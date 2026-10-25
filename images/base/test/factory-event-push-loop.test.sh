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
# The release collector is off for every case but its own (section 12): no test may reach GitHub.
export DEV_FACTORY_RELEASE_COLLECT_INTERVAL=0
unset FACTORY_RELEASE_COLLECT_BIN FACTORY_RELEASE_COLLECT_TIMEOUT

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
# -- 10. regime: lands in the column on a full database, NULL without the key
EVDIR=$tmpdir/ev10
mkdir -p "$EVDIR"
ev --type claimed --data '{"lease_minutes":5}' --issue 81 --regime testbed
ev claimed --issue 82 --branch issue-82
loop --once
[ "$rc" = 0 ] || fail "--once with regime should succeed: $(cat "$tmpdir/loop.out")"
[ "$(q "$db" "SELECT regime FROM factory.event_store WHERE issue = 81")" = testbed ] || fail "regime should land as testbed: $(cat "$tmpdir/loop.out")"
[ "$(q "$db" "SELECT count(*) FROM factory.event_store WHERE issue = 82 AND regime IS NULL")" = 1 ] || fail "a line without regime should land NULL"
[ "$(q "$db" "SELECT regime FROM factory.event_log WHERE issue = 81")" = testbed ] || fail "event_log should show regime"
grep -q "no regime column" "$tmpdir/loop.out" && fail "a migrated database must not warn about regime"
# a line with no regime key at all (an older writer) lands NULL too
EVDIR=$tmpdir/ev10b
mkdir -p "$EVDIR/factory"
jq -c 'del(.regime)' "$tmpdir/ev10/factory/acme__widgets.jsonl" | sed -n 1p | sed 's/"issue":81/"issue":83/;s/"event_id":"[^"]*"/"event_id":"11111111-1111-4111-8111-111111111111"/' > "$EVDIR/factory/acme__widgets.jsonl"
loop --once
[ "$(q "$db" "SELECT count(*) FROM factory.event_store WHERE issue = 83 AND regime IS NULL")" = 1 ] || fail "a line with no regime key should land NULL: $(cat "$tmpdir/loop.out")"
echo "ok: regime lands in its column"

# -- 11. a database without the regime column: the line is pushed without it, never refused
mig_old=$tmpdir/mig-old
mkdir -p "$mig_old"
for f in "$ROOT"/images/base/factory-db/migrations/*; do
  case "$(basename "$f")" in 0027_regime.sql | 0028_* | 0029_* | 0030_* | 0031_* | 0034_*) ;; *) cp "$f" "$mig_old/" ;; esac
done
db_old="factory_test_$$_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
names="$names $db_old"
FACTORY_DB_MIGRATIONS_DIR=$mig_old FACTORY_DB_ADMIN_URL=$ADMIN FACTORY_DB_WRITER_PASSWORD=$WPW \
  bash "$BOOTSTRAP" --db "$db_old" > "$tmpdir/boot-old.out" 2>&1 || fail "old bootstrap: $(cat "$tmpdir/boot-old.out")"
[ "$(q "$db_old" "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'factory' AND table_name = 'event_store' AND column_name = 'regime'")" = 0 ] || fail "the old database should have no regime column"
WURL=$(url_for "$db_old" "${db_old}_writer" "$WPW")
EVDIR=$tmpdir/ev11
mkdir -p "$EVDIR"
ev --type claimed --data '{"lease_minutes":5}' --issue 91 --regime testbed
ev --type claimed --data '{"lease_minutes":5}' --issue 92
loop --once
[ "$rc" = 0 ] || fail "--once on an unmigrated database should succeed: $(cat "$tmpdir/loop.out")"
[ "$(q "$db_old" "SELECT count(*) FROM factory.event_store")" = 2 ] || fail "both lines should be pushed: $(cat "$tmpdir/loop.out")"
[ "$(cat "$EVDIR/factory/.pushed/acme__widgets.jsonl")" = 2 ] || fail "the cursor should move to 2"
[ ! -e "$EVDIR/factory/.refused/acme__widgets.jsonl" ] || fail "nothing may be set aside for a missing regime column"
[ "$(grep -c "no regime column" "$tmpdir/loop.out")" = 1 ] || fail "one line about the missing column per pass expected: $(cat "$tmpdir/loop.out")"
# after migrating, the next lines carry the regime again
FACTORY_DB_MIGRATIONS_DIR="$ROOT/images/base/factory-db/migrations" FACTORY_DB_ADMIN_URL=$ADMIN FACTORY_DB_WRITER_PASSWORD=$WPW \
  bash "$BOOTSTRAP" --db "$db_old" > "$tmpdir/boot-old2.out" 2>&1 || fail "re-bootstrap: $(cat "$tmpdir/boot-old2.out")"
ev --type claimed --data '{"lease_minutes":5}' --issue 93 --regime manual
loop --once
[ "$(q "$db_old" "SELECT regime FROM factory.event_store WHERE issue = 93")" = manual ] || fail "after the migration regime should land: $(cat "$tmpdir/loop.out")"
[ "$(q "$db_old" "SELECT count(*) FROM factory.event_store WHERE issue IN (91, 92) AND regime IS NULL")" = 2 ] || fail "lines pushed before the migration read NULL"
echo "ok: a missing regime column drops the field, not the line"

# -- 12. the release collector: cadence, and it never stops or delays the push
WURL=$(url_for "$db" "${db}_writer" "$WPW")
stub=$tmpdir/collector
cat > "$stub" <<'STUB'
#!/bin/bash
echo "$*" >> "$STUB_CALLS"
echo "callum-flow-released: collect o/r v1.0.0: collect (stub) postgres://u:hunter2secret@h/db" >&2
case "${STUB_MODE:-ok}" in
  fail) exit 1 ;;
  sleep) sleep 30 ;;
  write) CLAUDE_CONFIG_DIR=/nonexistent CALLUM_FLOW_REPO=acme/widgets DEV_MACHINE_NAME=dev-box DEV_VERSIONS_FILE="$NOVERS" bash "$EVENT_BIN" --type claimed --data '{"lease_minutes":5}' --issue 121 2> /dev/null ;;
esac
STUB
chmod +x "$stub"
export STUB_CALLS=$tmpdir/collector.calls EVENT_BIN=$EVENT NOVERS=$tmpdir/no-versions.json
collect_loop() { # MODE INTERVAL [BIN]
  rc=0
  STUB_MODE=$1 DEV_FACTORY_RELEASE_COLLECT_INTERVAL=$2 FACTORY_RELEASE_COLLECT_BIN=${3:-$stub} FACTORY_RELEASE_COLLECT_TIMEOUT=1 \
    CALLUM_EVENTS_DIR=$EVDIR FACTORY_DB_WRITER_URL=$WURL timeout 60 bash "$LOOP" --once > "$tmpdir/loop.out" 2>&1 || rc=$?
}
calls() { if [ -f "$STUB_CALLS" ]; then wc -l < "$STUB_CALLS" | tr -d ' '; else echo 0; fi; }

# cadence: two passes inside the interval call it once; its stderr reaches the log, masked
EVDIR=$tmpdir/ev12a
mkdir -p "$EVDIR"
ev --type claimed --data '{"lease_minutes":5}' --issue 120
rm -f "$STUB_CALLS"
collect_loop ok 900
[ "$rc" = 0 ] || fail "pass with the collector should succeed: $(cat "$tmpdir/loop.out")"
grep -q "collect o/r v1.0.0: collect (stub)" "$tmpdir/loop.out" || fail "the collector's stderr belongs in the log"
grep -q hunter2secret "$tmpdir/loop.out" && fail "the collector's output must be masked"
collect_loop ok 900
[ "$(calls)" = 1 ] || fail "two passes inside the interval must call the collector once, got $(calls)"
[ "$(cat "$STUB_CALLS")" = "--collect" ] || fail "the collector is run as --collect"
# an old stamp runs it again
touch -d '2 hours ago' "$EVDIR/factory/.released-collect"
collect_loop ok 900
[ "$(calls)" = 2 ] || fail "a stamp older than the interval must run the collector again, got $(calls)"
# interval 0 never calls it
rm -f "$STUB_CALLS" "$EVDIR/factory/.released-collect"
collect_loop ok 0
[ "$(calls)" = 0 ] || fail "interval 0 must never call the collector"
[ ! -e "$EVDIR/factory/.released-collect" ] || fail "interval 0 must not stamp"

# failure isolation: the pass still pushes, with one warning, and the stamp is set
n=0
for mode in fail sleep missing; do
  n=$((n + 1))
  EVDIR=$tmpdir/ev12b$n
  mkdir -p "$EVDIR"
  ev --type claimed --data '{"lease_minutes":5}' --issue 130
  before=$(rows)
  bin=$stub
  [ "$mode" != missing ] || bin=$tmpdir/no-such-collector
  collect_loop "$mode" 900 "$bin"
  [ "$rc" = 0 ] || fail "a $mode collector must not fail the pass: $(cat "$tmpdir/loop.out")"
  [ "$(($(rows) - before))" = 1 ] || fail "a $mode collector must not stop the push: $(cat "$tmpdir/loop.out")"
  [ "$(grep -c 'factory-event-push-loop: release collector' "$tmpdir/loop.out")" = 1 ] || fail "a $mode collector gives one warning: $(cat "$tmpdir/loop.out")"
  [ -e "$EVDIR/factory/.released-collect" ] || fail "the stamp is set whatever the collector did ($mode)"
done

# what the collector writes is pushed in the same pass
EVDIR=$tmpdir/ev12c
mkdir -p "$EVDIR"
before=$(rows)
collect_loop write 900
[ "$rc" = 0 ] || fail "pass with a writing collector: $(cat "$tmpdir/loop.out")"
[ "$(($(rows) - before))" = 1 ] || fail "an event the collector writes must be pushed in the same pass: $(cat "$tmpdir/loop.out")"
echo "ok: the release collector runs at its interval and never blocks the push"
echo "factory-event-push-loop tests passed"
