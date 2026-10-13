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
mkdir -p "$toolbin" "$fakebin" "$share" "$hbdir" "$tmpdir/home" "$tmpdir/events"
for t in jq sed tr cat mkdir mv dirname basename date sleep rm touch chmod stat flock timeout readlink getconf hostname grep head tail mktemp git wc node setsid nohup kill env true; do
  p=$(command -v "$t") || fail "$t not found"
  case "$p" in /*) ;; *) p=/usr/bin/$t ;; esac
  ln -s "$p" "$toolbin/$t"
done
BASH=$(command -v bash)
ln -s "$ROOT/images/base/agentsview.sh" "$share/agentsview.sh"
ln -s "$ROOT/images/base/workspace.sh" "$share/workspace.sh"

cat > "$fakebin/psql" <<'STUB'
#!/bin/sh
d=$(dirname "$0")
fail=0
[ -e "$d/psql-fail" ] && fail=1
n=$(($(if [ -f "$d/psql-calls" ]; then wc -l < "$d/psql-calls"; else echo 0; fi) + 1))
printf '%s\n' "$@" > "$d/psql-args-$n"
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
reset() { rm -f "$fakebin"/psql-calls "$fakebin"/psql-args-* "$fakebin"/psql-sql-* "$fakebin/psql-fail" "$fakebin/psql-hang" "$fakebin/dver-local-calls" "$share/state-calls" "$hbdir"/dev-heartbeat*; }
hb_setup() {
  export PATH="$fakebin:$toolbin" DEV_SYSTEM_SHARE="$share" DEV_HEARTBEAT_DIR="$hbdir" DEV_VERSIONS_FILE="$tmpdir/versions.json" \
    DEV_MACHINE_NAME=dev-box CALLUM_EVENTS_DIR="$tmpdir/events" AGENTSVIEW_DATA_DIR="$tmpdir/av" HOME="$tmpdir/home" \
    NM_PUSH_STATE_DIR="$tmpdir/nm" DEV_REPO_URL=https://github.com/Acme/Widgets.git \
    HEARTBEAT_EVENT_LOCK="$tmpdir/ev.lock" HEARTBEAT_NM_LOCK="$tmpdir/nm.lock" HEARTBEAT_AV_LOCK="$tmpdir/av.lock" \
    AGENTSVIEW_PG_URL="${HB_URL-postgres://app:s3cret@db/x}"
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
sleeps_of() { awk -v p="$1" '$2 == "(sleep)" && $3 != "Z" && $4 == p { print $1 }' /proc/[0-9]*/stat 2> /dev/null | sort -n | tr '\n' ' '; }
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

echo "heartbeat-loop: ok"
