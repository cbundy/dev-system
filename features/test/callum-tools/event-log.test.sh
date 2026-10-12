#!/bin/sh
#
# Plain-shell tests for the factory event log (cbundy/dev-system#218):
# callum-flow-event, event-push-loop (stub psql, no database) and the
# watchers' calls to it (stub callum-flow-event). Hermetic PATH, no network,
# no Docker, so `npm test` runs it anywhere.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT="$SCRIPT_DIR/../../.."
EVENT="$ROOT/images/base/callum-flow-event"
PUSH="$ROOT/images/base/event-push-loop"
SRC="$ROOT/features/src/callum-tools"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

toolbin="$tmpdir/tools"
fakebin="$tmpdir/bin"
mkdir -p "$toolbin" "$fakebin"
for t in jq sed tr cat mkdir mv dirname basename date find sort cut head tail wc git awk grep sleep rm touch chmod paste stat; do
  p=$(command -v "$t") || fail "$t not found"
  ln -s "$p" "$toolbin/$t"
done
SH=$(command -v sh)
BASH=$(command -v bash)

events="$tmpdir/events"
ev() { PATH="$toolbin" CLAUDE_CONFIG_DIR="$tmpdir/no-claude" CALLUM_EVENTS_DIR="$events" CALLUM_FLOW_REPO=o/r DEV_MACHINE_NAME=dev-box DEV_VERSIONS_FILE="${EV_VERSIONS:-$tmpdir/no-versions.json}" "$SH" "$EVENT" "$@"; }
log="$events/o__r.jsonl"

# --- callum-flow-event ------------------------------------------------------
ev claimed --issue 7 --note "it's \"quoted\"" --branch feat/issue-7-x --pr 9 --head abc --run r1 || fail "claimed should exit 0"
[ "$(wc -l < "$log" | tr -d ' ')" = 1 ] || fail "one line expected"
jq -e '.v == 2 and .repo == "o/r" and .device == "dev-box" and .state == "claimed" and .issue == 7
  and .pr == 9 and .head == "abc" and .run_id == "r1" and .branch == "feat/issue-7-x"
  and .note == "it'"'"'s \"quoted\"" and .session_id == null and .actor == "agent"
  and (.ts | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$"))' "$log" > /dev/null || fail "bad line: $(cat "$log")"

# version fields (#316): read from the snapshot, null without one, one line either way
[ "$(jq -c '[.base_image, .dev_image, .template_version, .plugin_version]' "$log")" = '[null,null,null,null]' ] || fail "no snapshot must give null version fields: $(cat "$log")"
printf '%s\n' '{"device":"x","base_image":"2.25.0","dev_image":null,"template_version":"tpl-1","plugin_version":7,"components":[]}' > "$tmpdir/versions.json"
EV_VERSIONS="$tmpdir/versions.json" ev ready --issue 7 || fail "snapshot event should exit 0"
[ "$(wc -l < "$log" | tr -d ' ')" = 2 ] || fail "one line per event"
[ "$(tail -n 1 "$log" | jq -c '[.v, .base_image, .dev_image, .template_version, .plugin_version, .device]')" = '[2,"2.25.0",null,"tpl-1",null,"dev-box"]' ] || fail "snapshot fields wrong: $(tail -n 1 "$log")"
printf 'not json{' > "$tmpdir/versions.json"
EV_VERSIONS="$tmpdir/versions.json" ev ready --issue 7 || fail "corrupt snapshot event should exit 0"
[ "$(tail -n 1 "$log" | jq -c '[.v, .base_image, .plugin_version]')" = '[2,null,null]' ] || fail "corrupt snapshot must give nulls: $(tail -n 1 "$log")"
head -n 1 "$log" > "$tmpdir/log1" && cp "$tmpdir/log1" "$log"
[ -e "$events/.wake" ] || fail "an event must touch the wake file"
rm -f "$events/.wake"
ev bogus --issue 1 2> /dev/null || :
[ ! -e "$events/.wake" ] || fail "a rejected call must not touch the wake file"
ev delegated --branch fix/issue-12-y || fail "issue from branch should exit 0"
[ "$(tail -n 1 "$log" | jq .issue)" = 12 ] || fail "issue should come from the branch"

rc=0
ev bogus --issue 1 2> "$tmpdir/err" || rc=$?
[ "$rc" = 2 ] || fail "unknown state should exit 2, got $rc"
rc=0
ev merged 2> /dev/null || rc=$?
[ "$rc" = 2 ] || fail "missing --issue should exit 2, got $rc"
rc=0
ev merged --issue x 2> /dev/null || rc=$?
[ "$rc" = 2 ] || fail "non-numeric --issue should exit 2, got $rc"
[ "$(wc -l < "$log" | tr -d ' ')" = 2 ] || fail "rejected calls must not write"

ev usage --note "five_hour=3" || fail "usage needs no issue"
[ "$(tail -n 1 "$log" | jq -r '.issue, .state' | tr '\n' ' ')" = "null usage " ] || fail "usage line wrong"

# every line carries a UUID event_id, and two lines differ (#229)
uuid_re='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
jq -s -e --arg re "$uuid_re" 'all(.[]; .event_id | type == "string" and test($re))' "$log" > /dev/null || fail "every line needs a UUID event_id: $(cat "$log")"
[ "$(jq -r .event_id "$log" | sort -u | wc -l | tr -d ' ')" = "$(wc -l < "$log" | tr -d ' ')" ] || fail "event_ids must be unique"
# an unreadable UUID source: the line is still written, without event_id, exit 0
before=$(wc -l < "$log" | tr -d ' ')
out=$(CALLUM_EVENT_UUID_SOURCE="$tmpdir/no-such-uuid" ev ready --issue 2 2>&1) || fail "a missing UUID source must exit 0"
case "$out" in *warning*event_id*) ;; *) fail "a missing UUID source should warn: $out" ;; esac
[ "$(wc -l < "$log" | tr -d ' ')" = $((before + 1)) ] || fail "the line must still be written"
[ "$(tail -n 1 "$log" | jq -r '.event_id')" = null ] || fail "event_id should be null without a source"

# every state of the closed vocabulary is accepted
for s in ready claimed briefed delegated run_started parked verdict fix_requested failed merge_ready head_mismatch conflict ci_stalled merged abandoned closed reclaimed claim_lost untrusted_stripped design_routed test_weakened watcher_error usage superseded renewed rebased_behind; do
  ev "$s" --issue 1 --run r1 || fail "$s should be accepted"
done

# superseded is run-scoped: --run is required, and the line carries it
rc=0; out=$(ev superseded --issue 1 2>&1) || rc=$?
[ "$rc" = 2 ] || fail "superseded without --run must exit 2, got $rc: $out"
case "$out" in *"--run is required"*) ;; *) fail "superseded without --run should say so: $out" ;; esac
ev superseded --issue 1 --run r9 --note "by feat/issue-1-x-v2" || fail "superseded with --run should be accepted"
[ "$(tail -n 1 "$log" | jq -r '.run_id')" = r9 ] || fail "superseded should record the run"

# --path prints the file a write appends to, and writes nothing
before=$(find "$events" -type f | sort | tr '\n' ' ')
[ "$(ev --path)" = "$log" ] || fail "--path should print the log: $(ev --path)"
[ "$(ev --path --repo acme/widgets)" = "$events/acme__widgets.jsonl" ] || fail "--path --repo wrong: $(ev --path --repo acme/widgets)"
[ "$(PATH="$toolbin" CALLUM_EVENTS_DIR="$events" CALLUM_FLOW_REPO=acme/widgets "$SH" "$EVENT" --path)" = "$events/acme__widgets.jsonl" ] || fail "--path should honour CALLUM_FLOW_REPO"
[ "$(PATH="$toolbin" CALLUM_FLOW_REPO=o/r "$SH" "$EVENT" --path)" = "/persist/events/o__r.jsonl" ] || fail "--path default dir"
ev closed --issue 31 --repo acme/widgets --note completed
[ "$(tail -n 1 "$events/acme__widgets.jsonl" | jq -r .state)" = closed ] || fail "closed write should land where --path says"
rm -f "$events/acme__widgets.jsonl"
[ "$(find "$events" -type f | sort | tr '\n' ' ')" = "$before" ] || fail "--path must not write"
rc=0
ev --path --bogus 2> /dev/null || rc=$?
[ "$rc" = 2 ] || fail "--path with a bad option should exit 2, got $rc"

# session id: CLAUDE_SESSION_ID, else the newest transcript of the working directory
CLAUDE_SESSION_ID=sess-1 ev ready --issue 3
[ "$(tail -n 1 "$log" | jq -r .session_id)" = sess-1 ] || fail "CLAUDE_SESSION_ID not used"
work="$tmpdir/work dir"
mkdir -p "$work"
proj="$tmpdir/claude/projects/$(cd "$work" && pwd -P | sed 's/[^a-zA-Z0-9]/-/g')"
mkdir -p "$proj"
: > "$proj/old.jsonl"
sleep 1
: > "$proj/new.jsonl"
(cd "$work" && PATH="$toolbin" CLAUDE_CONFIG_DIR="$tmpdir/claude" CALLUM_EVENTS_DIR="$events" CALLUM_FLOW_REPO=o/r "$SH" "$EVENT" ready --issue 4)
[ "$(tail -n 1 "$log" | jq -r .session_id)" = new ] || fail "newest transcript not used: $(tail -n 1 "$log")"

# an unwritable log is a warning, exit 0
mkdir -p "$tmpdir/ro"
chmod 0500 "$tmpdir/ro"
if [ "$(id -u)" != 0 ]; then
  out=$(PATH="$toolbin" CALLUM_EVENTS_DIR="$tmpdir/ro/sub" CALLUM_FLOW_REPO=o/r "$SH" "$EVENT" ready --issue 1 2>&1) || fail "write error must exit 0"
  case "$out" in *warning*) ;; *) fail "write error should warn: $out" ;; esac
fi
chmod 0700 "$tmpdir/ro"

# the origin remote names the repo and the file
git init -q "$tmpdir/repo"
git -C "$tmpdir/repo" remote add origin git@github.com:acme/widgets.git
(cd "$tmpdir/repo" && PATH="$toolbin" CALLUM_EVENTS_DIR="$events" "$SH" "$EVENT" ready --issue 1)
[ -f "$events/acme__widgets.jsonl" ] || fail "file should be named from the remote: $(ls "$events")"
[ "$(jq -r .repo "$events/acme__widgets.jsonl")" = acme/widgets ] || fail "repo should come from the remote"

# --if-changed (cbundy/dev-system#344): skip a line that repeats the subject's newest one
ic="$tmpdir/ic"
icev() { PATH="$toolbin" CLAUDE_CONFIG_DIR="$tmpdir/no-claude" CALLUM_EVENTS_DIR="$ic" CALLUM_FLOW_REPO=o/r DEV_MACHINE_NAME=dev-box "$SH" "$EVENT" "$@"; }
iclog="$ic/o__r.jsonl"
iclines() { wc -l < "$iclog" | tr -d ' '; }
icev failed --branch fix/issue-9-a --head h1 --run r1 --note cancelled --if-changed || fail "if-changed with no log should exit 0"
[ "$(iclines)" = 1 ] || fail "if-changed with no log must write"
icev failed --branch fix/issue-9-a --head h1 --run unknown --note cancelled --if-changed
[ "$(iclines)" = 1 ] || fail "same state, head and note (run_id differs) must not write"
icev failed --branch fix/issue-9-a --head h1 --run r1 --if-changed
[ "$(iclines)" = 2 ] || fail "a different note must write"
icev failed --branch fix/issue-9-a --head h2 --if-changed
[ "$(iclines)" = 3 ] || fail "a different head must write"
icev parked --branch fix/issue-9-a --head h2 --if-changed
[ "$(iclines)" = 4 ] || fail "a different state must write"
icev parked --branch fix/issue-9-a --head h2 --if-changed
[ "$(iclines)" = 4 ] || fail "a repeat must not write"
icev parked --branch fix/issue-9-a --head h2
[ "$(iclines)" = 5 ] || fail "without the flag an identical line still writes"
# the subject is the branch when given: another branch's newest line does not count
icev parked --branch fix/issue-10-b --head h2 --if-changed
[ "$(iclines)" = 6 ] || fail "another branch must write"
# else the issue
icev ready --issue 20 --if-changed
icev ready --issue 20 --if-changed
icev ready --issue 21 --if-changed
[ "$(iclines)" = 8 ] || fail "issue subject: want 8 lines, got $(iclines)"
# an interleaved line for the subject makes the repeat a change
icev claimed --issue 20
icev ready --issue 20 --if-changed
[ "$(iclines)" = 10 ] || fail "only the newest line for the subject counts: $(iclines)"
printf 'not json\n' >> "$iclog"
icev ready --issue 20 --if-changed
[ "$(iclines)" = 11 ] || fail "an unparseable line must be ignored, not stop the check: $(iclines)"

# --- event-push-loop --------------------------------------------------------
cat > "$fakebin/psql" <<'STUB'
#!/bin/sh
# stub psql: records the connection argument and the SQL; a psql-fail marker
# makes it fail with an error that quotes the URL.
d=$(dirname "$0")
# Decide pass/fail first and append to psql-calls LAST: when the counter shows
# call N, call N is complete (SQL file written, outcome fixed), so the test can
# remove psql-fail afterwards without racing this call.
fail=0
[ -e "$d/psql-fail" ] && fail=1
n=$(($(if [ -f "$d/psql-calls" ]; then wc -l < "$d/psql-calls"; else echo 0; fi) + 1))
printf '%s\n' "$*" > "$d/psql-args"
{ echo "PGPASSWORD=${PGPASSWORD-}"; echo "PGUSER=${PGUSER-}"; echo "PGHOST=${PGHOST-}"; echo "PGDATABASE=${PGDATABASE-}"; echo "PGSSLMODE=${PGSSLMODE-}"; echo "PGSSLROOTCERT=${PGSSLROOTCERT-}"; } > "$d/psql-env"
cat > "$d/psql-sql-$n"
echo x >> "$d/psql-calls"
if [ "$fail" = 1 ]; then
  echo "psql: error: connection to postgres://app:s3cret@db/x failed password=s3cret" >&2
  exit 2
fi
STUB
chmod +x "$fakebin/psql"
pushdir="$tmpdir/push"
mkdir -p "$pushdir"
printf '%s\n' '{"v":1,"ts":"2026-10-08T10:00:00Z","repo":"o/r","device":"d1","state":"ready","issue":5,"note":"it'"'"'s"}' \
  '{"v":1,"ts":"2026-10-08T10:01:00Z","repo":"o/r","device":"d1","state":"claimed","issue":5}' \
  'not json' > "$pushdir/o__r.jsonl"
push() {
  PATH="$fakebin:$toolbin" CALLUM_EVENTS_DIR="$pushdir" DEV_SYSTEM_SHARE="$ROOT/images/base" \
    AGENTSVIEW_PG_URL="${PUSH_URL:-postgres://app:s3cret@db/x}" HOME="${PUSH_HOME:-$tmpdir/home}" "$BASH" "$PUSH" --once
}
calls() { wc -l < "$fakebin/psql-calls" | tr -d ' '; }

mkdir -p "$tmpdir/home"
push > "$tmpdir/push.out" 2>&1 || fail "push should succeed: $(cat "$tmpdir/push.out")"
grep -qx 'PGSSLROOTCERT=' "$fakebin/psql-env" || fail "no sslmode must leave PGSSLROOTCERT unset"
[ "$(calls)" = 1 ] || fail "one psql call expected"
if grep -q 's3cret\|postgres:' "$fakebin/psql-args"; then fail "the URL or password reached psql's argv: $(cat "$fakebin/psql-args")"; fi
grep -qx 'PGPASSWORD=s3cret' "$fakebin/psql-env" || fail "psql should get the password in its environment"
grep -qx 'PGUSER=app' "$fakebin/psql-env" || fail "psql should get the user"
grep -qx 'PGHOST=db' "$fakebin/psql-env" || fail "psql should get the host"
grep -qx 'PGDATABASE=x' "$fakebin/psql-env" || fail "psql should get the database"
sql="$fakebin/psql-sql-1"
grep -q 'CREATE TABLE IF NOT EXISTS factory.events' "$sql" || fail "DDL missing"
grep -q "VALUES ('d1', 'o/r', '1', '2026-10-08T10:00:00Z', 'ready', '5'" "$sql" || fail "row 1 missing: $(cat "$sql")"
grep -q "'it''s'" "$sql" || fail "quotes must be doubled"
grep -q "'d1', 'o/r', '2'," "$sql" || fail "row 2 (seq 2) missing"
grep -q ' ON CONFLICT DO NOTHING;' "$sql" || fail "idempotency clause missing"
[ "$(grep -c '^INSERT' "$sql")" = 2 ] || fail "the unparseable line must be skipped, not pushed"
[ "$(cat "$pushdir/.pushed/o__r.jsonl")" = 3 ] || fail "progress should count all 3 lines"

push > /dev/null 2>&1 || fail "second push should succeed"
[ "$(calls)" = 1 ] || fail "nothing new, nothing sent"

printf '%s\n' '{"v":1,"ts":"2026-10-08T10:02:00Z","repo":"o/r","device":"d1","state":"merged","issue":5}' >> "$pushdir/o__r.jsonl"
push > /dev/null 2>&1 || fail "third push should succeed"
[ "$(calls)" = 2 ] || fail "one new line, one call"
[ "$(grep -c '^INSERT' "$fakebin/psql-sql-2")" = 1 ] || fail "one row expected"
grep -q "'d1', 'o/r', '4'," "$fakebin/psql-sql-2" || fail "only seq 4 expected"

printf '%s\n' '{"v":1,"ts":"2026-10-08T10:03:00Z","repo":"o/r","device":"d1","state":"abandoned","issue":6}' >> "$pushdir/o__r.jsonl"
touch "$fakebin/psql-fail"
rc=0
push > "$tmpdir/push.out" 2>&1 || rc=$?
[ "$rc" != 0 ] || fail "a failing database should fail the pass"
[ "$(cat "$pushdir/.pushed/o__r.jsonl")" = 4 ] || fail "progress must not advance on failure"
if grep -q 's3cret' "$tmpdir/push.out"; then fail "the password leaked: $(cat "$tmpdir/push.out")"; fi
rm "$fakebin/psql-fail"
push > /dev/null 2>&1 || fail "retry should succeed"
[ "$(cat "$pushdir/.pushed/o__r.jsonl")" = 5 ] || fail "retry should catch up"

rc=0
DEV_SECRETS_DIR="$tmpdir/nosecrets" PATH="$fakebin:$toolbin" CALLUM_EVENTS_DIR="$pushdir" DEV_SYSTEM_SHARE="$ROOT/images/base" \
  "$BASH" "$PUSH" --once > /dev/null 2>&1 || rc=$?
[ "$rc" != 0 ] || fail "no URL should end the pass non-zero"

# sslrootcert defaulting (#241): each case pushes one new line and reads psql's env
n=0
ssl_case() { # URL expected-PGSSLROOTCERT [VAR=value to set in the environment]
  extra=${3-}
  n=$((n + 1))
  printf '%s\n' "{\"v\":1,\"ts\":\"2026-10-08T11:0$n:00Z\",\"repo\":\"o/r\",\"device\":\"d1\",\"state\":\"ready\",\"issue\":$n}" >> "$pushdir/o__r.jsonl"
  (
    case "$extra" in
      PGSSLROOTCERT=*) PGSSLROOTCERT=${extra#*=}; export PGSSLROOTCERT ;;
      PGSSLMODE=*) PGSSLMODE=${extra#*=}; export PGSSLMODE ;;
    esac
    PUSH_URL="$1" push > /dev/null 2>&1
  ) || fail "ssl case $1 ($extra): push should succeed"
  grep -qx "PGSSLROOTCERT=$2" "$fakebin/psql-env" || fail "ssl case $1 ($extra): want PGSSLROOTCERT=$2, got: $(grep SSL "$fakebin/psql-env" | tr '\n' ' ')"
}
base=postgres://app:s3cret@db/x
ssl_case "$base?sslmode=verify-full" system
ssl_case "$base?sslmode=verify-ca" system
ssl_case "$base?sslmode=verify-full&sslrootcert=/etc/ca.pem" /etc/ca.pem
ssl_case "$base?sslmode=verify-full" /x PGSSLROOTCERT=/x
ssl_case "$base?sslmode=require" ""
ssl_case "$base?sslmode=prefer" ""
ssl_case "$base" system PGSSLMODE=verify-full
mkdir -p "$tmpdir/home2/.postgresql"
: > "$tmpdir/home2/.postgresql/root.crt"
PUSH_HOME="$tmpdir/home2" ssl_case "$base?sslmode=verify-full" ""

# event identity (#229): the INSERT carries the validated event_id, and the DDL migrates
ev_dir="$tmpdir/push-id"
mkdir -p "$ev_dir"
id1=0b0e3c1a-5d9f-4e2b-8a41-1c2d3e4f5a6b
printf '%s\n' \
  '{"ts":"2026-10-08T10:00:00Z","repo":"o/r","device":"d1","state":"ready","event_id":"'"$id1"'"}' \
  '{"ts":"2026-10-08T10:01:00Z","repo":"o/r","device":"d1","state":"ready","event_id":"not-a-uuid'"'"'; drop table x"}' \
  '{"ts":"2026-10-08T10:02:00Z","repo":"o/r","device":"d1","state":"ready"}' > "$ev_dir/o__r.jsonl"
rm -f "$fakebin/psql-calls"
idpush() { PATH="$fakebin:$toolbin" CALLUM_EVENTS_DIR="$ev_dir" DEV_SYSTEM_SHARE="$ROOT/images/base" AGENTSVIEW_PG_URL=postgres://app:s3cret@db/x HOME="$tmpdir/home" "$BASH" "$PUSH" --once; }
idpush > "$tmpdir/idpush.out" 2>&1 || fail "id push should succeed: $(cat "$tmpdir/idpush.out")"
sql="$fakebin/psql-sql-1"
grep -q 'actor, v, event_id, base_image, dev_image, template_version, plugin_version, raw) VALUES' "$sql" || fail "INSERT should name event_id"
grep -q "'$id1', NULL, NULL, NULL, NULL, '{" "$sql" || fail "a valid event_id should be passed on"
[ "$(grep -c "NULL, NULL, NULL, NULL, NULL, '{" "$sql")" -ge 2 ] || fail "a malformed or missing event_id must be NULL"
grep 'not-a-uuid' "$sql" | grep -q "NULL, NULL, NULL, NULL, NULL, '{" || fail "the malformed event_id column must be NULL"
for frag in 'ADD COLUMN IF NOT EXISTS event_id uuid' 'events_event_id_key' 'WHERE event_id IS NOT NULL' 'events_legacy_key' 'WHERE event_id IS NULL' 'DROP CONSTRAINT' 'pg_advisory_xact_lock'; do
  grep -q "$frag" "$sql" || fail "the DDL should contain: $frag"
done
# a file with fewer lines than its marker is pushed again from the start, with one log line
printf '5\n' > "$ev_dir/.pushed/o__r.jsonl"
idpush > "$tmpdir/idpush.out" 2>&1 || fail "replaced-file push should succeed"
[ "$(grep -c '^INSERT' "$fakebin/psql-sql-2")" = 3 ] || fail "all 3 lines should be pushed again"
[ "$(grep -c 'file replaced' "$tmpdir/idpush.out")" = 1 ] || fail "one log line expected: $(cat "$tmpdir/idpush.out")"
[ "$(cat "$ev_dir/.pushed/o__r.jsonl")" = 3 ] || fail "the marker should be 3 again"

# version columns (#316): the INSERT names them and carries the values; null when absent
vdir="$tmpdir/push-ver"
mkdir -p "$vdir"
printf '%s\n' \
  '{"v":2,"ts":"2026-10-08T10:00:00Z","repo":"o/r","device":"d1","state":"ready","base_image":"2.25.0","dev_image":null,"template_version":"tpl-1","plugin_version":"0.26.1"}' \
  '{"v":1,"ts":"2026-10-08T10:01:00Z","repo":"o/r","device":"d1","state":"ready","plugin_version":{"x":1}}' > "$vdir/o__r.jsonl"
rm -f "$fakebin/psql-calls"
PATH="$fakebin:$toolbin" CALLUM_EVENTS_DIR="$vdir" DEV_SYSTEM_SHARE="$ROOT/images/base" AGENTSVIEW_PG_URL=postgres://app:s3cret@db/x HOME="$tmpdir/home" "$BASH" "$PUSH" --once > /dev/null 2>&1 || fail "version push should succeed"
sql="$fakebin/psql-sql-1"
grep -q 'event_id, base_image, dev_image, template_version, plugin_version, raw) VALUES' "$sql" || fail "INSERT should name the version columns"
grep -q "'2.25.0', NULL, 'tpl-1', '0.26.1', '{" "$sql" || fail "version values wrong: $(grep INSERT "$sql")"
[ "$(grep -c "NULL, NULL, NULL, NULL, NULL, '{" "$sql")" = 1 ] || fail "a v1 line (or a non-string version) must push null versions"
for frag in 'ADD COLUMN IF NOT EXISTS base_image text' 'ADD COLUMN IF NOT EXISTS plugin_version text' "pg_notify('factory_events'" 'AFTER INSERT ON factory.events' 'pg_trigger' 'pg_proc'; do
  grep -q "$frag" "$sql" || fail "the DDL should contain: $frag"
done

# push on write and DDL once (#316): a long interval, woken by the wake file
wdir="$tmpdir/push-wake"
mkdir -p "$wdir"
printf '%s\n' '{"v":2,"ts":"2026-10-08T10:00:00Z","repo":"o/r","device":"d1","state":"ready","issue":1}' > "$wdir/o__r.jsonl"
rm -f "$fakebin/psql-calls"
wline() { printf '%s\n' "{\"v\":2,\"ts\":\"2026-10-08T10:0$1:00Z\",\"repo\":\"o/r\",\"device\":\"d1\",\"state\":\"ready\",\"issue\":$1}" >> "$wdir/o__r.jsonl"; }
ncalls() { if [ -f "$fakebin/psql-calls" ]; then calls; else echo 0; fi; }
wait_for() { # SECONDS COMMAND... : poll until the command succeeds, bounded
  limit=$(($1 * 10)); shift
  t=0
  until "$@"; do
    t=$((t + 1))
    [ "$t" -lt "$limit" ] || return 1
    sleep 0.1
  done
}
calls_ge() { [ "$(ncalls)" -ge "$1" ]; }
wait_calls() { wait_for "$2" calls_ge "$1"; } # N SECONDS
pushed_is() { [ "$(cat "$wdir/.pushed/o__r.jsonl" 2> /dev/null)" = "$1" ]; }
PATH="$fakebin:$toolbin" CALLUM_EVENTS_DIR="$wdir" DEV_SYSTEM_SHARE="$ROOT/images/base" DEV_EVENT_PUSH_INTERVAL=30 \
  AGENTSVIEW_PG_URL=postgres://app:s3cret@db/x HOME="$tmpdir/home" "$BASH" "$PUSH" > "$tmpdir/loop.out" 2>&1 &
loop_pid=$!
trap 'kill "$loop_pid" 2> /dev/null; rm -rf "$tmpdir"' EXIT
wait_calls 1 5 || fail "the loop should push the first pass at once"
grep -q 'CREATE TABLE IF NOT EXISTS' "$fakebin/psql-sql-1" || fail "the first batch should carry the DDL"
sleep 1.5
wline 2
sleep 2.5
[ "$(calls)" = 1 ] || fail "with no wake, nothing may be pushed before the interval"
touch "$wdir/.wake"
wait_calls 2 5 || fail "a wake must push within 5 s: $(cat "$tmpdir/loop.out")"
grep -q 'CREATE TABLE IF NOT EXISTS' "$fakebin/psql-sql-2" && fail "the DDL must be sent once per process"
grep -q "'d1', 'o/r', '2'," "$fakebin/psql-sql-2" || fail "the woken pass should push the new line"
touch "$fakebin/psql-fail"
wline 3
touch "$wdir/.wake"
wait_calls 3 5 || fail "the failing batch should be tried"
rm "$fakebin/psql-fail"
touch "$wdir/.wake"
wait_calls 4 5 || fail "the retry should run on the next wake"
grep -q 'CREATE TABLE IF NOT EXISTS' "$fakebin/psql-sql-4" || fail "a failed batch must make the next pass resend the DDL"
wait_for 5 pushed_is 3 || fail "retry should catch up"
kill "$loop_pid" 2> /dev/null || :
wait "$loop_pid" 2> /dev/null || :
trap 'rm -rf "$tmpdir"' EXIT

# --- the watchers call callum-flow-event ------------------------------------
cat > "$fakebin/callum-flow-event" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$(dirname "$0")/event-calls"
exit 3
STUB
# queue-watch lists through the trusted-author reader (cbundy/dev-system#310), which
# asks the REST issue list: two issues by the owner
cat > "$fakebin/gh" <<'STUB'
#!/bin/sh
[ "$1 $2" = "api --paginate" ] || exit 1
echo '[{"number":4,"title":"a","user":{"login":"cbundy","id":13131067}},{"number":9,"title":"b","user":{"login":"cbundy","id":13131067}}]'
STUB
chmod +x "$fakebin/callum-flow-event" "$fakebin/gh"
: > "$fakebin/event-calls"
out=$(PATH="$fakebin:$toolbin" CALLUM_FLOW_ISSUE_READ_BIN="$ROOT/images/base/callum-flow-issue-read" CALLUM_FLOW_SHARE_DIR="$ROOT/images/base" \
  CALLUM_FLOW_TRUSTED_AUTHORS=cbundy:13131067 "$SH" "$SRC/queue-watch.sh" --repo o/r --label ready --interval 1 --known 4 2> /dev/null) || fail "queue-watch should exit 0 (a failing event call must not matter)"
[ "$out" = "queue-changed known=4 now=4,9" ] || fail "queue-watch stdout changed: $out"
[ "$(cat "$fakebin/event-calls")" = "ready --issue 9 --if-changed --actor watcher" ] || fail "queue-watch should record only the new issue, as a first sight (--if-changed): $(cat "$fakebin/event-calls")"

: > "$fakebin/event-calls"
rc=0
out=$(PATH="$fakebin:$toolbin" "$SH" "$SRC/pipeline-watch.sh" --stream 2> /dev/null) || rc=$?
[ "$rc" != 0 ] || fail "pipeline-watch without no-mistakes should fail"
[ "$out" = "watcher-error no-mistakes not on PATH" ] || fail "pipeline-watch stdout changed: $out"
grep -q '^watcher_error --note pipeline-watch: no-mistakes not on PATH --actor watcher$' "$fakebin/event-calls" || fail "pipeline-watch should record watcher_error: $(cat "$fakebin/event-calls")"

: > "$fakebin/event-calls"
now=$(date +%s)
mkdir -p "$tmpdir/state"
printf '{"recorded_at":%s,"rate_limits":{"five_hour":{"used_percentage":41.2,"resets_at":%s},"seven_day":{"used_percentage":50,"resets_at":%s}}}\n' \
  "$now" "$((now + 3600))" "$((now + 86400))" > "$tmpdir/state/usage.json"
out=$(PATH="$fakebin:$toolbin" CALLUM_USAGE_STATE="$tmpdir/state/usage.json" HOME="$tmpdir" "$SH" "$SRC/usage-check.sh") || fail "usage-check should exit 0"
case "$out" in five_hour=42*source=statusline) ;; *) fail "usage-check stdout changed: $out" ;; esac
grep -qF "usage --actor watcher --note $out" "$fakebin/event-calls" || fail "usage-check should record the line: $(cat "$fakebin/event-calls")"

echo "event-log: ok"
