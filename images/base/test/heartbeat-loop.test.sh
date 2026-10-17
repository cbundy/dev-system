#!/bin/sh
# shellcheck disable=SC2015
#
# Plain-shell tests for images/base/heartbeat-loop (cbundy/dev-system#466):
# stub psql, dev-version and heartbeat-state, so no database, no network and no
# Docker. The real-Postgres checks are in sections/09-agentsview.sh.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT="$SCRIPT_DIR/../../.."
LOOP="$ROOT/images/base/heartbeat-loop"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
loop_pid=''
cleanup() {
  [ -z "$loop_pid" ] || kill "$loop_pid" 2> /dev/null || :
  rm -rf "$tmpdir"
}
trap cleanup EXIT

toolbin="$tmpdir/tools"
fakebin="$tmpdir/bin"
share="$tmpdir/share"
hbdir="$tmpdir/hb"
mkdir -p "$toolbin" "$fakebin" "$share" "$hbdir" "$tmpdir/default-secrets" "$tmpdir/home" "$tmpdir/events"
for t in jq sed tr cat mkdir mv dirname basename date sleep rm touch chmod stat flock timeout readlink getconf hostname grep head tail mktemp git wc node setsid nohup kill env true; do
  p=$(command -v "$t") || fail "$t not found"
  case "$p" in /*) ;; *) p=/usr/bin/$t ;; esac
  ln -s "$p" "$toolbin/$t"
done
BASH=$(command -v bash)
ln -s "$ROOT/images/base/agentsview.sh" "$share/agentsview.sh"
ln -s "$ROOT/images/base/workspace.sh" "$share/workspace.sh"
ln -s "$ROOT/images/base/factory-db.sh" "$share/factory-db.sh"

cat > "$fakebin/psql" <<'STUB'
#!/bin/sh
d=$(dirname "$0")
fail=0
[ -e "$d/psql-fail" ] && fail=1
[ -e "$d/psql-fail-${PGDATABASE:-}" ] && fail=1
n=$(($(if [ -f "$d/psql-calls" ]; then wc -l < "$d/psql-calls"; else echo 0; fi) + 1))
printf '%s\n' "$@" > "$d/psql-args-$n"
printf '%s\n' "${PGDATABASE:-}" > "$d/psql-db-$n"
cat > "$d/psql-sql-$n"
echo x >> "$d/psql-calls"
[ ! -e "$d/psql-hang" ] || exec sleep 60
if [ "$fail" = 1 ]; then
  # Recording a call does not mean its error response has reached the loop.
  sleep 0.2
  echo "psql: error: connection to postgres://app:s3cret@db/x failed password=s3cret" >&2
  exit 2
fi
STUB
cat > "$fakebin/dev-version" <<'STUB'
#!/bin/sh
d=$(dirname "$0")
case "$1" in
  --local)
    echo x >> "$d/dver-local-calls"
    [ ! -e "$d/dver-local-sleep" ] || sleep 60
    [ ! -e "$d/dver-snapshot-fail" ] || exit 2
    printf '%s\n' '{"device":"dev-box","role":"worker","ring":"canary","runtime":"coder","coder_workspace":"ws1","base_image":"2.29.0","dev_image":"1.0.0","template_version":"tpl-3","plugin_version":"0.32.0","components":[{"name":"base","running":"2.29.0","latest":null}]}' > "${DEV_VERSIONS_FILE:?}"
    ;;
  --json)
    echo started >> "$d/dver-json-calls"
    [ ! -e "$d/dver-json-hang" ] || exec sleep 30
    [ ! -e "$d/dver-json-fail" ] || exit 2
    echo '{"status":"OK","components":[{"name":"base","running":"2.29.0","latest":"2.30.0"}]}'
    ;;
esac
STUB
cat > "$share/heartbeat-state" <<'STUB'
#!/bin/sh
echo x >> "$(dirname "$0")/state-calls"
[ ! -e "$(dirname "$0")/state-hang" ] || exec sleep 60
echo '{"state":"busy","in_flight":[{"issue":1,"run_id":null,"branch":null,"state":"claimed"}],"chat_active_at":null,"sessions":[{"session_id":"s1","parent_session_id":null,"context_window":1000000}]}'
STUB
chmod +x "$fakebin/psql" "$fakebin/dev-version" "$share/heartbeat-state"

calls() { if [ -f "$fakebin/psql-calls" ]; then wc -l < "$fakebin/psql-calls" | tr -d ' '; else echo 0; fi; }
reset() { rm -f "$fakebin"/psql-calls "$fakebin"/psql-args-* "$fakebin"/psql-sql-* "$fakebin"/psql-db-* "$fakebin"/psql-fail-* "$fakebin/psql-fail" "$fakebin/psql-hang" "$fakebin/dver-local-calls" "$share/state-calls" "$hbdir"/dev-heartbeat*; }
hb_setup() {
  export PATH="$fakebin:$toolbin" DEV_SYSTEM_SHARE="$share" DEV_HEARTBEAT_DIR="$hbdir" DEV_VERSIONS_FILE="$tmpdir/versions.json" \
    DEV_MACHINE_NAME=dev-box CALLUM_EVENTS_DIR="$tmpdir/events" AGENTSVIEW_DATA_DIR="$tmpdir/av" HOME="$tmpdir/home" \
    NM_PUSH_STATE_DIR="$tmpdir/nm" DEV_REPO_URL=https://github.com/Acme/Widgets.git \
    HEARTBEAT_EVENT_LOCK="$tmpdir/ev.lock" HEARTBEAT_NM_LOCK="$tmpdir/nm.lock" HEARTBEAT_AV_LOCK="$tmpdir/av.lock" \
    AGENTSVIEW_PG_URL="${HB_URL-postgres://app:s3cret@db/x}" DEV_SECRETS_DIR="$tmpdir/default-secrets" DEV_WORKSPACE_SECRETS_DIR="$tmpdir/no-ws-secrets" \
    HEARTBEAT_FACTORY_EVENT_LOCK="$tmpdir/fev.lock"
  unset FACTORY_DB_WRITER_URL
}
hb() ( hb_setup; exec "$@" )
once() { hb env "$BASH" "$LOOP" --once; }
has_arg() { grep -qxF -- "$2" "$fakebin/psql-args-$1"; } # CALL name=value
wait_for() { # SECONDS COMMAND... : poll until it succeeds
  limit=$(($1 * 10)); shift
  t=0
  until "$@"; do
    t=$((t + 1))
    [ "$t" -lt "$limit" ] || return 1
    sleep 0.1
  done
}
calls_ge() { [ "$(calls)" -ge "$1" ]; }
gone() { ! kill -0 "$1" 2> /dev/null; }
# Each stat file is read on its own: a process can exit between the glob and the
# read, and mawk (the image's awk) stops at the first file it cannot open, which
# under load hid the loop's sleep (cbundy/dev-system#523).
sleeps_of() {
  for f in /proc/[0-9]*/stat; do cat "$f" 2> /dev/null || :; done |
    awk -v p="$1" '$2 == "(sleep)" && $3 != "Z" && $4 == p { print $1 }' | sort -n | tr '\n' ' '
}
one_sleep() { [ "$(sleeps_of "$loop_pid" | wc -w | tr -d ' ')" = 1 ]; }
new_sleep() { sleeps_of "$loop_pid" | grep -qvx "$1 "; }
sleep_gone() { ! sleeps_of "$loop_pid" | grep -qw "$1"; }
start_loop() {
  ( hb_setup; exec env "$@" "$BASH" "$LOOP" > "$tmpdir/loop.out" 2>&1 ) &
  loop_pid=$!
}

# --- --once: one upsert naming every column, values as -v variables ----------
reset
once > "$tmpdir/once.out" 2>&1 || fail "--once should succeed: $(cat "$tmpdir/once.out")"
[ "$(calls)" = 1 ] || fail "one psql call expected"
sql="$fakebin/psql-sql-1"
cols=$(tr '\n' ' ' < "$sql" | sed -n 's/.*INSERT INTO factory\.workers (\([^)]*\)).*/\1/p' | tr -d ' ')
[ "$cols" = device,repo,role,ring,runtime,coder_workspace,base_image,dev_image,template_version,plugin_version,versions,state,in_flight,chat_active_at,sessions,critical_failures,push,interval_s,started_at,last_seen ] ||
  fail "the INSERT must name exactly the workers columns, got: $cols"
grep -q 'ON CONFLICT (device) DO UPDATE' "$sql" || fail "upsert expected"
grep -q 'last_seen = now()' "$sql" || fail "last_seen must be now()"
grep -q ':.versions.::jsonb' "$sql" || fail "values must be psql variables"
for kv in device=dev-box repo=acme/widgets role=worker ring=canary runtime=coder coder_workspace=ws1 base_image=2.29.0 dev_image=1.0.0 template_version=tpl-3 plugin_version=0.32.0 state=busy interval_s=60; do
  has_arg 1 "$kv" || fail "psql variable $kv missing: $(tr '\n' ' ' < "$fakebin/psql-args-1")"
done
grep -q '^started_at=20' "$fakebin/psql-args-1" || fail "started_at should be the container start: $(tr '\n' ' ' < "$fakebin/psql-args-1")"
grep -q '^in_flight=\[{"issue":1' "$fakebin/psql-args-1" || fail "in_flight from heartbeat-state missing"
grep -q '^sessions=\[{"session_id":"s1"' "$fakebin/psql-args-1" || fail "sessions from heartbeat-state missing"
grep -q '^push={"events"' "$fakebin/psql-args-1" || fail "push document missing"
if grep -q 's3cret\|postgres:' "$fakebin/psql-args-1" "$tmpdir/once.out"; then fail "the URL leaked into argv or output"; fi
[ -e "$hbdir/dev-heartbeat.state" ] && grep -q '^state=busy$' "$hbdir/dev-heartbeat.state" || fail "the state file should be written after a beat"

# --- repo: from DEV_REPO_URL, else the origin of the checkout it runs in -------
reset
git init -q "$tmpdir/checkout"
git -C "$tmpdir/checkout" remote add origin git@github.com:Acme/Desk-Repo.git
(cd "$tmpdir/checkout" && hb env -u DEV_REPO_URL -u DEV_WORKSPACE "$BASH" "$LOOP" --once) > /dev/null 2>&1 || fail "--once in a checkout"
has_arg 1 repo=acme/desk-repo || fail "with no DEV_REPO_URL the repo comes from the checkout: $(tr '\n' ' ' < "$fakebin/psql-args-1")"

# --- critical_failures --------------------------------------------------------
cf() { sed -n 's/^critical_failures=//p' "$fakebin/psql-args-$1"; }
[ "$(cf 1)" = '["events_push_not_running","nm_push_not_running","agentsview_push_not_running"]' ] || fail "free locks must be reported: $(cf 1)"
reset
for l in ev nm av; do
  : > "$tmpdir/$l.lock"
  flock -n "$tmpdir/$l.lock" sleep 20 &
done
sleep 0.5
once > /dev/null 2>&1 || fail "beat with locks held"
[ "$(cf 1)" = '[]' ] || fail "held locks must give []: $(cf 1)"
reset
touch "$fakebin/dver-snapshot-fail"
rm -f "$tmpdir/versions.json"
once > /dev/null 2>&1 || fail "beat without a snapshot"
[ "$(cf 1)" = '["versions_snapshot_missing"]' ] || fail "a missing snapshot must be reported: $(cf 1)"
has_arg 1 device=dev-box || fail "device falls back to DEV_MACHINE_NAME"
rm -f "$fakebin/dver-snapshot-fail"

# --- the latest cache: background, never waited for ---------------------------
reset
touch "$fakebin/dver-json-hang"
start=$(date +%s)
once > /dev/null 2>&1 || fail "beat with a hanging lookup"
[ $(($(date +%s) - start)) -lt 5 ] || fail "a hanging dev-version --json must not delay the beat"
grep -q '^versions=' "$fakebin/psql-args-1" && ! grep '^versions=' "$fakebin/psql-args-1" | grep -q '"latest":{' || fail "no cache yet: no latest"
rm -f "$fakebin/dver-json-hang"
# a successful lookup lands in the cache and the next beat carries it
reset
rm -f "$hbdir/dev-heartbeat-latest.lock"
once > /dev/null 2>&1
wait_for 10 test -s "$hbdir/dev-heartbeat-latest.json" || fail "the lookup should write the cache"
once > /dev/null 2>&1
grep '^versions=' "$fakebin/psql-args-2" | grep -q '"latest":{"status":"OK"' || fail "the cache should be merged into versions"
n=$(wc -l < "$fakebin/dver-json-calls" | tr -d ' ')
once > /dev/null 2>&1
[ "$(wc -l < "$fakebin/dver-json-calls" | tr -d ' ')" = "$n" ] || fail "the lookup runs at most every 15 minutes"
# a failing lookup for over an hour is critical
reset
rm -f "$hbdir"/dev-heartbeat-latest.*
touch "$fakebin/dver-json-fail"
once > /dev/null 2>&1
wait_for 10 test -e "$hbdir/dev-heartbeat-latest.failing" || fail "a failed lookup should leave a failing marker"
touch -d '2 hours ago' "$hbdir/dev-heartbeat-latest.failing"
once > /dev/null 2>&1
cf 2 | grep -q 'latest_lookup_failing' || fail "an hour of failures must be critical: $(cf 2)"
rm -f "$fakebin/dver-json-fail" "$fakebin/dver-json-calls"

# --- interval validation ------------------------------------------------------
for bad in 5 abc 1.5 ''; do
  reset
  hb env DEV_HEARTBEAT_INTERVAL="$bad" "$BASH" "$LOOP" --once > "$tmpdir/iv.out" 2>&1 || fail "--once with interval '$bad'"
  has_arg 1 interval_s=60 || fail "interval '$bad' must fall back to 60"
  if [ -n "$bad" ]; then grep -q 'using 60' "$tmpdir/iv.out" || fail "interval '$bad' must be logged"; fi
done
reset
hb env DEV_HEARTBEAT_INTERVAL=15 "$BASH" "$LOOP" --once > /dev/null 2>&1
has_arg 1 interval_s=15 || fail "a valid interval is kept"

# --- a failing database fails --once, with the secret masked ------------------
reset
touch "$fakebin/psql-fail"
rc=0
once > "$tmpdir/f.out" 2>&1 || rc=$?
[ "$rc" = 1 ] || fail "a failing database should give exit 1, got $rc"
if grep -q 's3cret' "$tmpdir/f.out"; then fail "the password leaked: $(cat "$tmpdir/f.out")"; fi
reset
rc=0
HB_URL='' hb env AGENTSVIEW_PG_URL= DEV_SECRETS_DIR="$tmpdir/nosecrets" "$BASH" "$LOOP" --once > /dev/null 2>&1 || rc=$?
[ "$rc" = 1 ] || fail "no URL should give exit 1"

# --- the loop: DDL once per process, resent after a failed beat ---------------
reset
start_loop DEV_HEARTBEAT_INTERVAL=60
wait_for 5 calls_ge 1 || fail "the loop should beat at once: $(cat "$tmpdir/loop.out")"
[ -e "$hbdir/dev-heartbeat.pid" ] && [ "$(cat "$hbdir/dev-heartbeat.pid")" = "$loop_pid" ] || fail "the pidfile should hold the loop pid"
grep -q 'CREATE TABLE IF NOT EXISTS factory.workers' "$fakebin/psql-sql-1" || fail "the first beat carries the DDL"
wait_for 5 one_sleep || fail "the loop should sleep between beats: $(sleeps_of "$loop_pid")"
s1=$(sleeps_of "$loop_pid" | tr -d ' ')
# An empty pid would make sleep_gone's grep -w match every line and never pass.
[ -n "$s1" ] || fail "no sleep pid read after the first beat"
kill -USR1 "$loop_pid"
wait_for 5 calls_ge 2 || fail "SIGUSR1 should beat at once"
wait_for 5 new_sleep "$s1" || fail "the loop should sleep again after the SIGUSR1 beat"
wait_for 2 sleep_gone "$s1" || fail "SIGUSR1 must not leave the interrupted sleep $s1 running: $(sleeps_of "$loop_pid")"
grep -q 'CREATE TABLE' "$fakebin/psql-sql-2" && fail "the DDL must be sent once per process"
touch "$fakebin/psql-fail"
kill -USR1 "$loop_pid"
wait_for 5 calls_ge 3 || fail "the failing beat should be tried"
# SIGUSR1 interrupts the interval sleep; wait for the failed beat to finish
# before requesting the retry, rather than signalling while psql is running.
wait_for 5 one_sleep || fail "the loop should sleep after the failed beat"
rm "$fakebin/psql-fail"
kill -USR1 "$loop_pid"
wait_for 5 calls_ge 4 || fail "the retry should run"
grep -q 'CREATE TABLE IF NOT EXISTS factory.workers' "$fakebin/psql-sql-4" || fail "a failed beat must make the next one resend the DDL"

# SIGTERM: one stopped beat, exit 0, pidfile removed
wait_for 5 one_sleep || fail "the loop should sleep after the retry"
kill -TERM "$loop_pid"
wait_for 8 gone "$loop_pid" || fail "the loop should exit on TERM"
rc=0
wait "$loop_pid" || rc=$?
[ "$rc" = 0 ] || fail "TERM should exit 0, got $rc"
loop_pid=''
[ "$(calls)" = 5 ] || fail "exactly one more (final) beat expected, got $(calls)"
has_arg 5 state=stopped || fail "the last beat must be stopped"
grep -q 'CREATE TABLE' "$fakebin/psql-sql-5" && fail "the stopped beat must not resend the DDL this loop already sent"
[ ! -e "$hbdir/dev-heartbeat.pid" ] || fail "the pidfile must be removed on exit"

# --final signals the running loop and waits
reset
start_loop DEV_HEARTBEAT_INTERVAL=60
wait_for 5 calls_ge 1 || fail "loop beat"
hb env "$BASH" "$LOOP" --final || fail "--final must exit 0"
gone "$loop_pid" || fail "--final should leave the loop stopped"
loop_pid=''
has_arg "$(calls)" state=stopped || fail "--final must leave a stopped beat"
# with no loop running it writes the beat itself, and exits 0 even when psql fails
reset
hb env "$BASH" "$LOOP" --final || fail "--final with no loop must exit 0"
[ "$(calls)" = 1 ] && has_arg 1 state=stopped || fail "--final with no loop writes the stopped beat"
grep -q '^in_flight=\[{"issue":1' "$fakebin/psql-args-1" || fail "the stopped beat carries in_flight from heartbeat-state"
has_arg 1 'sessions=[]' || fail "the stopped beat lists no live sessions"
has_arg 1 base_image=2.29.0 || fail "the stopped beat reuses the versions snapshot"
[ ! -e "$fakebin/dver-local-calls" ] || fail "the stopped beat must not run dev-version"
grep -q 'CREATE TABLE IF NOT EXISTS factory.workers' "$fakebin/psql-sql-1" || fail "a stopped beat from a process that sent no DDL sends it"
# The stopped beat runs under its own `timeout 5` and every stub hang is 60 s, so
# a --final that outlives a few of those timeouts is a real hang, not a slow host.
stop_timeout_ms=5000
hang_bound_ms=$((stop_timeout_ms * 3))
final_ms() {
  t0=$(date +%s%N)
  hb env "$BASH" "$LOOP" --final > /dev/null 2>&1 || fail "--final must exit 0 ($1)"
  ms=$((($(date +%s%N) - t0) / 1000000))
  [ "$ms" -lt "$hang_bound_ms" ] || fail "the stopped beat hung on $1: ${ms} ms"
}
# a hanging dev-version and heartbeat-state: the beat still lands, so it beat the outer timeout
reset
touch "$fakebin/dver-local-sleep" "$share/state-hang"
final_ms "a hanging dev-version and heartbeat-state"
rm -f "$fakebin/dver-local-sleep" "$share/state-hang"
[ "$(calls)" = 1 ] && has_arg 1 state=stopped && has_arg 1 'in_flight=[]' || fail "a hanging heartbeat-state still gives a stopped beat with no in_flight"
# an unreachable database that never answers is cut off by the stopped beat's timeout
reset
touch "$fakebin/psql-hang"
final_ms "a database that never answers"
[ "$(calls)" = 1 ] && has_arg 1 state=stopped || fail "the stopped beat should have been sent to the hanging database"
rm -f "$fakebin/psql-hang"
touch "$fakebin/psql-fail"
hb env "$BASH" "$LOOP" --final > /dev/null 2>&1 || fail "--final must exit 0 even when the beat fails"
rm -f "$fakebin/psql-fail"
reset
rc=0
HB_URL='' hb env AGENTSVIEW_PG_URL= DEV_SECRETS_DIR="$tmpdir/nosecrets" "$BASH" "$LOOP" --final || rc=$?
[ "$rc" = 0 ] && [ "$(calls)" = 0 ] || fail "--final with no URL writes nothing and exits 0"

# --- a removed URL stops the loop ---------------------------------------------
reset
mkdir -p "$tmpdir/secrets"
echo 'postgres://app:s3cret@db/x' > "$tmpdir/secrets/agentsview-pg-url"
HB_URL='' start_loop AGENTSVIEW_PG_URL= DEV_SECRETS_DIR="$tmpdir/secrets"
wait_for 5 calls_ge 1 || fail "loop with a secret file should beat: $(cat "$tmpdir/loop.out")"
wait_for 5 one_sleep || fail "the loop should sleep after its first beat"
rm "$tmpdir/secrets/agentsview-pg-url"
kill -USR1 "$loop_pid"
wait_for 8 gone "$loop_pid" || fail "the loop should stop when the URL goes away"
rc=0
wait "$loop_pid" || rc=$?
[ "$rc" = 0 ] || fail "stopping on a missing URL exits 0"
loop_pid=''
grep -q 'stopping' "$tmpdir/loop.out" || fail "stopping should be logged"

# --- two targets: the agentsview database (old) and the factory database (new) --
FDB=postgres://w:s3cret@db/fdb
both() { hb env FACTORY_DB_WRITER_URL="$FDB" "$@"; }
dbof() { cat "$fakebin/psql-db-$1"; }
has_ddl() { grep -q 'CREATE TABLE\|DO \$' "$fakebin/psql-sql-$1"; }

reset
both "$BASH" "$LOOP" --once > "$tmpdir/b.out" 2>&1 || fail "--once with both URLs: $(cat "$tmpdir/b.out")"
[ "$(calls)" = 2 ] || fail "two psql calls expected, got $(calls)"
[ "$(dbof 1)" = x ] && [ "$(dbof 2)" = fdb ] || fail "old target first, then new: $(dbof 1) $(dbof 2)"
has_ddl 1 || fail "the old target carries the DDL on the first beat"
has_ddl 2 && fail "the factory database never gets DDL"
grep -q 'ON CONFLICT (device) DO UPDATE' "$fakebin/psql-sql-2" || fail "the factory database gets the UPSERT"
cmp -s "$fakebin/psql-args-1" "$fakebin/psql-args-2" || fail "both targets must get identical -v values"
[ "$(wc -l < "$fakebin/dver-local-calls" | tr -d ' ')" = 1 ] || fail "dev-version --local runs once per beat"
[ "$(wc -l < "$share/state-calls" | tr -d ' ')" = 1 ] || fail "heartbeat-state runs once per beat"
if grep -q 's3cret' "$tmpdir/b.out"; then fail "secret leaked"; fi

# one target failing never skips the other, names the target and fails --once
reset
touch "$fakebin/psql-fail-x"
rc=0
both "$BASH" "$LOOP" --once > "$tmpdir/b.out" 2>&1 || rc=$?
[ "$rc" = 1 ] || fail "old target failing: exit 1 expected, got $rc"
[ "$(calls)" = 2 ] && [ "$(dbof 2)" = fdb ] || fail "the new upsert is still sent after the old one failed"
grep -q 'agentsview database beat failed' "$tmpdir/b.out" || fail "the failure names the old target"
if grep -q 's3cret' "$tmpdir/b.out"; then fail "secret leaked: $(cat "$tmpdir/b.out")"; fi
[ -e "$hbdir/dev-heartbeat.state" ] || fail "the state file is written when one target succeeded"
reset
touch "$fakebin/psql-fail-fdb"
rc=0
both "$BASH" "$LOOP" --once > "$tmpdir/b.out" 2>&1 || rc=$?
[ "$rc" = 1 ] || fail "new target failing: exit 1 expected, got $rc"
[ "$(calls)" = 2 ] && [ "$(dbof 1)" = x ] || fail "the old upsert is still sent"
grep -q 'factory database beat failed' "$tmpdir/b.out" || fail "the failure names the new target"
if grep -q 's3cret' "$tmpdir/b.out"; then fail "secret leaked"; fi
reset
touch "$fakebin/psql-fail"
both "$BASH" "$LOOP" --once > /dev/null 2>&1 && fail "both failing must fail --once"
[ ! -e "$hbdir/dev-heartbeat.state" ] || fail "no state file when every target failed"

# only the writer URL: one call, no DDL, exit 0
reset
rc=0
HB_URL='' both env AGENTSVIEW_PG_URL= "$BASH" "$LOOP" --once > "$tmpdir/b.out" 2>&1 || rc=$?
[ "$rc" = 0 ] && [ "$(calls)" = 1 ] && [ "$(dbof 1)" = fdb ] || fail "writer only: one call to fdb, exit 0 (rc=$rc calls=$(calls))"
has_ddl 1 && fail "writer only: no DDL"
# neither URL
reset
rc=0
HB_URL='' hb env AGENTSVIEW_PG_URL= "$BASH" "$LOOP" --once > /dev/null 2>&1 || rc=$?
[ "$rc" = 1 ] && [ "$(calls)" = 0 ] || fail "neither URL: exit 1, no call"

# an unreadable writer secret counts as not configured
reset
mkdir -p "$tmpdir/badsec"
: > "$tmpdir/badsec/factory-db-writer-url"
hb env DEV_SECRETS_DIR="$tmpdir/badsec" "$BASH" "$LOOP" --once > /dev/null 2>&1 || fail "an empty writer secret is not configured: the old target alone succeeds"
[ "$(calls)" = 1 ] && [ "$(dbof 1)" = x ] || fail "empty writer secret: old target only"

# the loop: DDL resend is the old target's only; the new one never has DDL
reset
start_loop DEV_HEARTBEAT_INTERVAL=60 FACTORY_DB_WRITER_URL="$FDB"
wait_for 5 calls_ge 2 || fail "the loop should beat both targets at once: $(cat "$tmpdir/loop.out")"
has_ddl 1 && ! has_ddl 2 || fail "first loop beat: DDL to old only"
kick() { # N: SIGUSR1 and wait until N calls were made and the loop sleeps again
  s=$(sleeps_of "$loop_pid" | tr -d ' ')
  kill -USR1 "$loop_pid"
  wait_for 5 calls_ge "$1" || fail "SIGUSR1 beat expected ($1 calls)"
  wait_for 5 new_sleep "$s" || fail "the loop should sleep again"
}
wait_for 5 one_sleep || fail "sleep after first beat"
kick 4
has_ddl 3 || has_ddl 4 && fail "no DDL on the second beat"
touch "$fakebin/psql-fail-x"
kick 6
[ "$(dbof 6)" = fdb ] || fail "the new target is still sent when the old fails"
rm "$fakebin/psql-fail-x"
kick 8
has_ddl 7 && [ "$(dbof 7)" = x ] || fail "the old target resends its DDL after a failed beat"
has_ddl 8 && fail "the new target never gets DDL"
# SIGTERM: the stopped beat goes to both
kill -TERM "$loop_pid"
wait_for 8 gone "$loop_pid" || fail "the loop should exit on TERM"
wait "$loop_pid" || fail "TERM exits 0"
loop_pid=''
[ "$(calls)" = 10 ] || fail "two stopped beats expected, got $(calls) calls"
has_arg 9 state=stopped && has_arg 10 state=stopped && [ "$(dbof 9)" = x ] && [ "$(dbof 10)" = fdb ] || fail "stopped beat to both targets"
has_ddl 9 && fail "the stopped beat must not resend DDL the loop already sent"

# writer only loop keeps beating; removing URLs one at a time
reset
mkdir -p "$tmpdir/secrets2"
echo 'postgres://app:s3cret@db/x' > "$tmpdir/secrets2/agentsview-pg-url"
echo "$FDB" > "$tmpdir/secrets2/factory-db-writer-url"
HB_URL='' start_loop AGENTSVIEW_PG_URL= DEV_SECRETS_DIR="$tmpdir/secrets2"
wait_for 5 calls_ge 2 || fail "loop with both secret files"
wait_for 5 one_sleep || fail "sleep"
rm "$tmpdir/secrets2/factory-db-writer-url"
kick 3
[ "$(dbof 3)" = x ] || fail "writer URL removed: the loop keeps beating the old target"
echo "$FDB" > "$tmpdir/secrets2/factory-db-writer-url"
rm "$tmpdir/secrets2/agentsview-pg-url"
kick 4
[ "$(dbof 4)" = fdb ] && ! has_ddl 4 || fail "agentsview URL removed: the loop keeps beating the new target"
rm "$tmpdir/secrets2/factory-db-writer-url"
kill -USR1 "$loop_pid"
wait_for 8 gone "$loop_pid" || fail "the loop should stop when neither URL is left"
rc=0
wait "$loop_pid" || rc=$?
[ "$rc" = 0 ] || fail "stopping exits 0"
loop_pid=''
grep -q 'stopping' "$tmpdir/loop.out" && grep -q 'FACTORY_DB_WRITER_URL' "$tmpdir/loop.out" && grep -q 'AGENTSVIEW_PG_URL' "$tmpdir/loop.out" || fail "stopping names both sources"

# --final with no loop: both targets, and with only the writer URL
reset
both "$BASH" "$LOOP" --final || fail "--final"
[ "$(calls)" = 2 ] && has_arg 1 state=stopped && has_arg 2 state=stopped && [ "$(dbof 2)" = fdb ] || fail "--final with no loop sends to both"
reset
HB_URL='' both env AGENTSVIEW_PG_URL= "$BASH" "$LOOP" --final || fail "--final writer only"
[ "$(calls)" = 1 ] && has_arg 1 state=stopped && [ "$(dbof 1)" = fdb ] || fail "--final with only the writer URL still sends"

# critical_failures: factory_events_push_not_running only with the writer URL
reset
both "$BASH" "$LOOP" --once > /dev/null 2>&1
cf 1 | grep -q factory_events_push_not_running || fail "writer URL and a free lock: code expected: $(cf 1)"
reset
: > "$tmpdir/fev.lock"
flock -n "$tmpdir/fev.lock" sleep 20 &
holder=$!
sleep 0.3
both "$BASH" "$LOOP" --once > /dev/null 2>&1
kill "$holder" 2> /dev/null || :
cf 1 | grep -q factory_events_push_not_running && fail "a held lock must not report the code: $(cf 1)"
reset
once > /dev/null 2>&1
cf 1 | grep -q factory_events_push_not_running && fail "no writer URL: no code"

# push.factory_events
reset
pushof() { sed -n 's/^push=//p' "$fakebin/psql-args-1" | jq -c "$1"; }
once > /dev/null 2>&1
[ "$(pushof .factory_events)" = '{"last_write":null,"last_push":null}' ] || fail "no files: nulls: $(pushof .factory_events)"
mkdir -p "$tmpdir/events/factory/.pushed"
touch -d '2024-01-02 03:04:05 UTC' "$tmpdir/events/factory/x.jsonl"
touch -d '2024-02-03 04:05:06 UTC' "$tmpdir/events/factory/.pushed/x.jsonl"
reset
once > /dev/null 2>&1
[ "$(pushof .factory_events)" = '{"last_write":"2024-01-02T03:04:05Z","last_push":"2024-02-03T04:05:06Z"}' ] || fail "factory_events mtimes: $(pushof .factory_events)"
[ "$(pushof .events)" = '{"last_write":null,"last_push":null}' ] || fail "the existing events key is unchanged: $(pushof .events)"
rm -rf "$tmpdir/events/factory"

# --- machine stats: a second, separate call per target -------------------------------
cg="$tmpdir/cgroup"
pd="$tmpdir/proc"
mkdir -p "$cg" "$pd"
stats_once() { hb env HEARTBEAT_CGROUP_DIR="$cg" HEARTBEAT_PROC_DIR="$pd" "$BASH" "$LOOP" --once; }
sarg() { sed -n "s/^$2=//p" "$fakebin/stats-args-$1"; } # CALL name
fake_cg() { # QUOTA PERIOD USAGE MEM LIMIT
  rm -f "$cg"/*
  printf '%s %s\n' "$1" "$2" > "$cg/cpu.max"
  printf 'usage_usec %s\nuser_usec 1\nsystem_usec 2\n' "$3" > "$cg/cpu.stat"
  printf '%s\n' "$4" > "$cg/memory.current"
  printf '%s\n' "$5" > "$cg/memory.max"
}
rm -rf "${pd:?}"/*
for pid in 1 20 300 4000 55000; do
  mkdir "$pd/$pid"
  case "$pid" in 20 | 4000) echo claude > "$pd/$pid/comm" ;; *) echo bash > "$pd/$pid/comm" ;; esac
done
mkdir "$pd/self" "$pd/sys"   # not pids: never counted
echo claude > "$pd/self/comm"
now_us() { echo $(($(date +%s%N) / 1000)); }

reset
fake_cg 200000 100000 5000000 123456 1000000
stats_once > "$tmpdir/s.out" 2>&1 || fail "--once with stats: $(cat "$tmpdir/s.out")"
[ "$(calls)" = 1 ] && [ "$(wc -l < "$fakebin/stats-calls" | tr -d ' ')" = 1 ] || fail "one UPSERT call and one stats call expected"
head -n 1 "$fakebin/stats-sql-1" | grep -qx -- '-- heartbeat stats' || fail "the stats SQL is marked"
grep -q 'UPDATE factory.workers SET' "$fakebin/stats-sql-1" && grep -q 'INSERT INTO factory.worker_samples' "$fakebin/stats-sql-1" || fail "the stats call updates workers and inserts a sample"
grep -q 'stats_at = now()' "$fakebin/stats-sql-1" || fail "stats_at must be the database's now()"
sed -n '/^INSERT INTO factory.workers (/,$p' "$fakebin/psql-sql-1" | grep -qi 'worker_samples\|cpu_pct\|stats_at' && fail "the UPSERT must not touch the stats or worker_samples"
[ "$(sarg 1 device)" = dev-box ] && [ "$(sarg 1 state)" = busy ] || fail "device/state: $(tr '\n' ' ' < "$fakebin/stats-args-1")"
[ "$(sarg 1 cpu_limit_cores)" = 2 ] && [ "$(sarg 1 cpu_quota_set)" = true ] || fail "cpu.max 200000/100000: $(tr '\n' ' ' < "$fakebin/stats-args-1")"
[ "$(sarg 1 mem_used_bytes)" = 123456 ] && [ "$(sarg 1 mem_limit_bytes)" = 1000000 ] || fail "memory: $(tr '\n' ' ' < "$fakebin/stats-args-1")"
[ "$(sarg 1 claude_interactive)" = 1 ] && [ "$(sarg 1 claude_headless)" = 2 ] || fail "the session split comes from heartbeat-state"
[ "$(sarg 1 claude_procs)" = 2 ] && [ "$(sarg 1 procs)" = 5 ] || fail "proc counts by comm: $(tr '\n' ' ' < "$fakebin/stats-args-1")"
[ -z "$(sarg 1 cpu_pct)" ] || fail "cpu_pct must be NULL (empty) on the first beat"
[ "$(cut -d' ' -f1 "$hbdir/dev-heartbeat.cpu")" = 5000000 ] || fail "the first reading is saved: $(cat "$hbdir/dev-heartbeat.cpu")"
# the second beat: 5 s of cpu on 2 cores over the wall time since the seeded reading. The
# expectation comes from the wall the loop itself saved, so it holds however long the loop took to start.
prev_wall=$(($(now_us) - 10000000))
printf '%s %s\n' 0 "$prev_wall" > "$hbdir/dev-heartbeat.cpu"
rm -f "$fakebin"/stats-* "$fakebin"/psql-calls
stats_once > /dev/null 2>&1 || fail "second stats beat"
pct=$(sarg 1 cpu_pct)
saved_wall=$(cut -d' ' -f2 "$hbdir/dev-heartbeat.cpu")
dw=$((saved_wall - prev_wall))
[ "$dw" -ge 10000000 ] || fail "the saved wall should be at least 10 s past the seeded one, got dw=$dw"
[ -n "$pct" ] && jq -ne --argjson p "$pct" --argjson du 5000000 --argjson dw "$dw" --argjson c 2 \
  '$p == ($du / ($dw * $c) * 100 * 100 | round / 100)' > /dev/null || fail "cpu_pct should be 5 s of cpu over $dw us on 2 cores, got '$pct'"
# a counter reset (usage below the previous reading) is NULL again
printf '%s %s\n' 999999999 $(($(now_us) - 10000000)) > "$hbdir/dev-heartbeat.cpu"
rm -f "$fakebin"/stats-* "$fakebin"/psql-calls
stats_once > /dev/null 2>&1 || fail "reset stats beat"
[ -z "$(sarg 1 cpu_pct)" ] || fail "cpu_pct must be NULL after a counter reset"

# no quota: the online CPU count and cpu_quota_set false; memory.max max is NULL
reset
fake_cg max 100000 5000000 777 max
stats_once > /dev/null 2>&1 || fail "stats beat with max limits"
cores=$(getconf _NPROCESSORS_ONLN)
[ "$(sarg 1 cpu_limit_cores)" = "$cores" ] && [ "$(sarg 1 cpu_quota_set)" = false ] || fail "cpu.max max: $(tr '\n' ' ' < "$fakebin/stats-args-1")"
[ "$(sarg 1 mem_used_bytes)" = 777 ] && [ -z "$(sarg 1 mem_limit_bytes)" ] || fail "memory.max max is NULL: $(tr '\n' ' ' < "$fakebin/stats-args-1")"

# missing files give NULLs (cgroup v1, no /proc), the beat still succeeds
reset
rm -rf "${cg:?}"/*
rc=0
hb env HEARTBEAT_CGROUP_DIR="$cg" HEARTBEAT_PROC_DIR="$tmpdir/no-proc" "$BASH" "$LOOP" --once > /dev/null 2>&1 || rc=$?
[ "$rc" = 0 ] && [ "$(calls)" = 1 ] || fail "missing stat files must not fail the beat"
for k in cpu_pct cpu_limit_cores cpu_quota_set mem_used_bytes mem_limit_bytes claude_procs procs; do
  [ -z "$(sarg 1 "$k")" ] || fail "$k must be NULL with no source file, got '$(sarg 1 "$k")'"
done
[ ! -e "$hbdir/dev-heartbeat.cpu" ] || fail "no cpu.stat: no state file"
# garbage is no number either
printf 'lots\n' > "$cg/memory.current"
printf 'usage_usec abc\n' > "$cg/cpu.stat"
reset
stats_once > /dev/null 2>&1 || fail "garbage stat files"
[ -z "$(sarg 1 mem_used_bytes)" ] && [ -z "$(sarg 1 cpu_pct)" ] || fail "garbage must be NULL"

# no stats on the stopped beat, and the stopped beat does not touch the stats columns
reset
fake_cg 200000 100000 5000000 123456 1000000
hb env HEARTBEAT_DDL_SENT=1 HEARTBEAT_CGROUP_DIR="$cg" HEARTBEAT_PROC_DIR="$pd" "$BASH" "$LOOP" --final || fail "--final"
[ "$(calls)" = 1 ] && has_arg 1 state=stopped || fail "the stopped beat is still sent"
[ ! -e "$fakebin/stats-calls" ] || fail "the stopped beat must send no stats"
grep -qi 'cpu_pct\|stats_at' "$fakebin/psql-sql-1" && fail "the UPSERT never touches the stats columns"

# a failing stats write: logged, masked, exit 0, the UPSERT delivered
reset
touch "$fakebin/psql-fail-stats"
rc=0
stats_once > "$tmpdir/s.out" 2>&1 || rc=$?
[ "$rc" = 0 ] || fail "a stats failure must not fail --once, got $rc"
[ "$(calls)" = 1 ] && grep -q 'ON CONFLICT (device)' "$fakebin/psql-sql-1" || fail "the UPSERT must still be sent"
[ "$(wc -l < "$fakebin/stats-calls" | tr -d ' ')" = 1 ] || fail "the stats call was tried once"
grep -q 'heartbeat-loop: agentsview database stats write failed' "$tmpdir/s.out" || fail "the failure is logged: $(cat "$tmpdir/s.out")"
grep -q 's3cret' "$tmpdir/s.out" && fail "the stats failure leaked the password"
grep -q 'CREATE TABLE' "$fakebin/stats-sql-1" && fail "a stats call never carries DDL"
# a failed UPSERT sends no stats for that target
reset
touch "$fakebin/psql-fail"
rc=0
stats_once > /dev/null 2>&1 || rc=$?
[ "$rc" = 1 ] && [ ! -e "$fakebin/stats-calls" ] || fail "no stats after a failed UPSERT (rc=$rc)"

# the DDL migrates the stat columns and makes the samples table, its prune function and trigger
reset
stats_once > /dev/null 2>&1
for w in cpu_pct cpu_limit_cores cpu_quota_set mem_used_bytes mem_limit_bytes claude_interactive claude_headless claude_procs "'procs'" stats_at \
  'CREATE TABLE IF NOT EXISTS factory.worker_samples' 'PRIMARY KEY (device, sampled_at)' 'SECURITY DEFINER SET search_path = factory, pg_temp' \
  'CREATE TRIGGER worker_samples_prune AFTER INSERT ON factory.worker_samples'; do
  grep -qF -- "$w" "$fakebin/psql-sql-1" || fail "the DDL lacks: $w"
done

# the counts never read a command line or an environment
reads=$(grep -v '^ *#' "$LOOP" | grep -c 'cmdline\|environ' || :)
[ "$reads" = 1 ] && grep -v '^ *#' "$LOOP" | grep 'cmdline\|environ' | grep -q 'kill\|heartbeat-loop' || fail "only the --final pidfile check may read a cmdline or environ ($reads lines)"

# the loop: two targets each get the stats call, after their own UPSERT
reset
fake_cg 200000 100000 5000000 123456 1000000
hb env FACTORY_DB_WRITER_URL="$FDB" HEARTBEAT_CGROUP_DIR="$cg" HEARTBEAT_PROC_DIR="$pd" "$BASH" "$LOOP" --once > "$tmpdir/s.out" 2>&1 || fail "two targets with stats"
[ "$(calls)" = 2 ] && [ "$(wc -l < "$fakebin/stats-calls" | tr -d ' ')" = 2 ] || fail "each target gets a UPSERT and a stats call"
[ "$(cat "$fakebin/stats-db-1")" = x ] && [ "$(cat "$fakebin/stats-db-2")" = fdb ] || fail "stats go to each target in order"
cmp -s "$fakebin/stats-args-1" "$fakebin/stats-args-2" || fail "both targets get the same stats values"
grep -q 'CREATE TABLE' "$fakebin/stats-sql-2" && fail "the factory database never gets DDL"
# a stats failure on one target never skips the other
reset
touch "$fakebin/psql-fail-x"
hb env FACTORY_DB_WRITER_URL="$FDB" HEARTBEAT_CGROUP_DIR="$cg" HEARTBEAT_PROC_DIR="$pd" "$BASH" "$LOOP" --once > /dev/null 2>&1 && fail "old target failing fails --once"
[ "$(wc -l < "$fakebin/stats-calls" | tr -d ' ')" = 1 ] && [ "$(cat "$fakebin/stats-db-1")" = fdb ] || fail "only the target whose UPSERT landed gets stats"

echo "heartbeat-loop: ok"
