#!/bin/bash
#
# Tests for the factory-database target of images/base/heartbeat-loop (cbundy/dev-system#742):
# against a real PostgreSQL (scripts/test-pg.sh) made with the real factory-db-bootstrap, with only
# FACTORY_DB_WRITER_URL set. Proves the writer role's grants suffice for the UPSERT and that no DDL
# is sent. Skips cleanly with no server.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/../../.." && pwd)
BOOTSTRAP="$ROOT/images/base/factory-db-bootstrap"
LOOP="$ROOT/images/base/heartbeat-loop"
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
  echo "heartbeat-loop factory-db tests skipped: no PostgreSQL server"
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
mkdir -p "$DEV_SECRETS_DIR" "$tmpdir/hb" "$tmpdir/events" "$tmpdir/share"

# the share: the real libraries and a heartbeat-state whose answer the test changes between beats
for f in agentsview.sh factory-db.sh workspace.sh mem-pressure.sh github-health.sh; do ln -s "$ROOT/images/base/$f" "$tmpdir/share/$f"; done
cat > "$tmpdir/share/heartbeat-state" <<STUB
#!/bin/sh
printf '{"state":"%s","in_flight":[],"chat_active_at":null,"sessions":[],"config":%s}\n' "\$(cat "$tmpdir/state")" "\$(cat "$tmpdir/config" 2>/dev/null || echo null)"
STUB
chmod +x "$tmpdir/share/heartbeat-state"

WPW=wpw-$$-secret
db="factory_test_$$_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
names="$names $db"
FACTORY_DB_ADMIN_URL=$ADMIN FACTORY_DB_WRITER_PASSWORD=$WPW \
  bash "$BOOTSTRAP" --db "$db" > "$tmpdir/boot.out" 2>&1 || fail "bootstrap: $(cat "$tmpdir/boot.out")"
WURL=$(url_for "$db" "${db}_writer" "$WPW")

# a gh stub, so no beat reaches GitHub: it answers a rate_limit reply, or fails when $tmpdir/gh-fail exists
cat > "$tmpdir/gh" <<STUB
#!/bin/sh
[ ! -e "$tmpdir/gh-fail" ] || exit 4
echo '{"resources":{"core":{"limit":5000,"remaining":4990,"reset":1700000000},"graphql":{"limit":5000,"remaining":12,"reset":1700000100}}}'
STUB
chmod +x "$tmpdir/gh"
export HEARTBEAT_GH="$tmpdir/gh"

beat() {
  DEV_SYSTEM_SHARE="$tmpdir/share" DEV_HEARTBEAT_DIR="$tmpdir/hb" DEV_VERSIONS_FILE="$tmpdir/versions.json" \
    DEV_MACHINE_NAME=dev-box CALLUM_EVENTS_DIR="$tmpdir/events" AGENTSVIEW_DATA_DIR="$tmpdir/av" \
    FACTORY_DB_WRITER_URL=$WURL timeout 120 bash "$LOOP" --once > "$tmpdir/beat.out" 2>&1
}

echo idle > "$tmpdir/state"
beat || fail "first beat should succeed: $(cat "$tmpdir/beat.out")"
[ "$(q "$db" "SELECT count(*) FROM factory.workers")" = 1 ] || fail "one row expected"
first=$(q "$db" "SELECT state || '|' || extract(epoch FROM last_seen) FROM factory.workers WHERE device = 'dev-box'")
[ "${first%%|*}" = idle ] || fail "state idle expected, got $first"
sleep 1
echo busy > "$tmpdir/state"
beat || fail "second beat should succeed: $(cat "$tmpdir/beat.out")"
[ "$(q "$db" "SELECT count(*) FROM factory.workers")" = 1 ] || fail "still one row expected"
second=$(q "$db" "SELECT state || '|' || extract(epoch FROM last_seen) FROM factory.workers WHERE device = 'dev-box'")
[ "${second%%|*}" = busy ] || fail "the second beat should update state, got $second"
awk -v a="${first#*|}" -v b="${second#*|}" 'BEGIN { exit !(b > a) }' || fail "last_seen should advance: $first -> $second"
[ "$(q "$db" "SELECT stale FROM factory.workers_status WHERE device = 'dev-box'")" = f ] || fail "the worker should not be stale"
# the stats call: the writer role updates the stats columns and inserts a sample, with no DDL
[ "$(q "$db" "SELECT procs > 0 AND stats_at IS NOT NULL FROM factory.workers_status WHERE device = 'dev-box'")" = t ] || fail "the worker row should carry the stats"
[ "$(q "$db" "SELECT count(*) FROM factory.worker_samples WHERE device = 'dev-box'")" = 2 ] || fail "one sample per running beat expected"
[ "$(q "$db" "SELECT string_agg(state, ',' ORDER BY sampled_at) FROM factory.worker_samples")" = idle,busy ] || fail "samples keep the beat's state"
grep -q 'stats write failed' "$tmpdir/beat.out" && fail "the stats write failed: $(cat "$tmpdir/beat.out")"
grep -q 'permission denied\|ERROR' "$tmpdir/beat.out" && fail "the writer beat logged an error: $(cat "$tmpdir/beat.out")"
echo "heartbeat-loop factory-db: ok"

# memory pressure (cbundy/dev-system#1124): the five columns land in the worker row and in the sample.
# From here on the beats read a fixture cgroup; the second beat finds the rate against the first.
cg="$tmpdir/cg"
mkdir -p "$cg"
export HEARTBEAT_CGROUP_DIR="$cg"
printf 'low 0\nhigh 0\nmax 10\noom 1\noom_kill 1\n' > "$cg/memory.events"
printf 'some avg10=2.50 avg60=1.00 avg300=0.00 total=1\nfull avg10=1.25 avg60=0.50 avg300=0.00 total=1\n' > "$cg/memory.pressure"
rm -f "$tmpdir/hb/dev-heartbeat.mem"
beat || fail "beat with memory fixtures: $(cat "$tmpdir/beat.out")"
[ "$(q "$db" "SELECT mem_max_events || '|' || mem_oom_kills || '|' || mem_psi_some_avg10 || '|' || mem_psi_full_avg10 || '|' || coalesce(mem_max_rate_per_min::text, 'null') FROM factory.workers_status WHERE device = 'dev-box'")" = '10|1|2.5|1.25|null' ] || fail "memory columns of the first beat"
printf '10 %s\n' $(($(date +%s%N) / 1000 - 60000000)) > "$tmpdir/hb/dev-heartbeat.mem"
printf 'low 0\nhigh 0\nmax 40\noom 1\noom_kill 1\n' > "$cg/memory.events"
beat || fail "second beat with memory fixtures: $(cat "$tmpdir/beat.out")"
[ "$(q "$db" "SELECT mem_max_events FROM factory.workers_status WHERE device = 'dev-box'")" = 40 ] || fail "mem_max_events should follow the new reading"
[ "$(q "$db" "SELECT mem_max_rate_per_min > 0 AND mem_max_rate_per_min <= 30 FROM factory.workers_status WHERE device = 'dev-box'")" = t ] || fail "the rate should be set on the second beat"
[ "$(q "$db" "SELECT count(*) FROM factory.worker_samples WHERE mem_max_events = 40 AND mem_oom_kills = 1 AND mem_psi_full_avg10 = 1.25 AND mem_max_rate_per_min > 0")" = 1 ] || fail "the sample should carry the memory columns"
echo "heartbeat-loop memory pressure: ok"

# the settings snapshot: the writer role's config UPDATE lands, and a null config clears it
echo '{"v":1,"at":"2026-10-19T08:00:00Z","settings":{"a":1}}' > "$tmpdir/config"
beat || fail "beat with config: $(cat "$tmpdir/beat.out")"
[ "$(q "$db" "SELECT config->>'at' FROM factory.workers WHERE device = 'dev-box'")" = 2026-10-19T08:00:00Z ] || fail "config should carry the snapshot"
grep -q 'config write failed' "$tmpdir/beat.out" && fail "the config write failed: $(cat "$tmpdir/beat.out")"
echo null > "$tmpdir/config"
beat || fail "beat with null config: $(cat "$tmpdir/beat.out")"
[ "$(q "$db" "SELECT config IS NULL FROM factory.workers WHERE device = 'dev-box'")" = t ] || fail "a null config should clear the column"
echo "heartbeat-loop config (factory database): ok"

# GitHub health (cbundy/dev-system#1305): the budget lands in the worker row and in this beat's sample;
# a gh that fails writes NULL and the beat still succeeds
beat || fail "beat with github: $(cat "$tmpdir/beat.out")"
[ "$(q "$db" "SELECT github_core_remaining || '|' || github_core_limit || '|' || github_graphql_remaining || '|' || github_graphql_limit || '|' || (github_core_reset_at = '2023-11-14T22:13:20Z') || '|' || (github_graphql_reset_at = '2023-11-14T22:15:00Z') || '|' || (github_at IS NOT NULL) || '|' || coalesce(github_errors_1h::text, 'null') FROM factory.workers_status WHERE device = 'dev-box'")" = '4990|5000|12|5000|true|true|true|null' ] || fail "github columns of the worker row"
[ "$(q "$db" "SELECT github_core_remaining || '|' || github_graphql_remaining FROM factory.worker_samples WHERE device = 'dev-box' ORDER BY sampled_at DESC LIMIT 1")" = '4990|12' ] || fail "the newest sample should carry the github columns"
grep -q 'github write failed' "$tmpdir/beat.out" && fail "the github write failed: $(cat "$tmpdir/beat.out")"
touch "$tmpdir/gh-fail"
beat || fail "beat with a failing gh: $(cat "$tmpdir/beat.out")"
[ "$(q "$db" "SELECT github_core_remaining IS NULL AND github_core_reset_at IS NULL AND github_graphql_remaining IS NULL AND github_graphql_limit IS NULL AND github_at IS NOT NULL FROM factory.workers_status WHERE device = 'dev-box'")" = t ] || fail "a failing gh should write NULL"
rm -f "$tmpdir/gh-fail"
echo "heartbeat-loop github health (factory database): ok"

# a workspace on another database: the writer file in its own folder (no env var) takes the beat
db2="factory_test_$$_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')_ws"
names="$names $db2"
FACTORY_DB_ADMIN_URL=$ADMIN FACTORY_DB_WRITER_PASSWORD=$WPW \
  bash "$BOOTSTRAP" --db "$db2" > "$tmpdir/boot2.out" 2>&1 || fail "bootstrap 2: $(cat "$tmpdir/boot2.out")"
mkdir -p "$tmpdir/ws-secrets"
printf '%s\n' "$(url_for "$db2" "${db2}_writer" "$WPW")" > "$tmpdir/ws-secrets/factory-db-writer-url"
printf '%s\n' "$WURL" > "$DEV_SECRETS_DIR/factory-db-writer-url"
q "$db" "DELETE FROM factory.workers" > /dev/null
echo idle > "$tmpdir/state"
DEV_SYSTEM_SHARE="$tmpdir/share" DEV_HEARTBEAT_DIR="$tmpdir/hb" DEV_VERSIONS_FILE="$tmpdir/versions.json" \
  DEV_MACHINE_NAME=dev-box CALLUM_EVENTS_DIR="$tmpdir/events" AGENTSVIEW_DATA_DIR="$tmpdir/av" \
  DEV_WORKSPACE_SECRETS_DIR="$tmpdir/ws-secrets" timeout 120 bash "$LOOP" --once > "$tmpdir/beat.out" 2>&1 \
  || fail "workspace-override beat should succeed: $(cat "$tmpdir/beat.out")"
[ "$(q "$db2" "SELECT count(*) FROM factory.workers")" = 1 ] || fail "the beat should land in the workspace database"
[ "$(q "$db" "SELECT count(*) FROM factory.workers")" = 0 ] || fail "the shared database must stay untouched"
echo "heartbeat-loop workspace override: ok"

# the agentsview database (old target): a worker table from before the stats columns is migrated by
# the loop's own DDL (columns, the view, worker_samples with its prune trigger), and then takes stats
db3="factory_test_$$_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')_av"
names="$names $db3"
psql -X -q -At -v ON_ERROR_STOP=1 "$ADMIN" -c "CREATE DATABASE \"$db3\"" > /dev/null
q "$db3" "CREATE SCHEMA factory; CREATE TABLE factory.workers (device text PRIMARY KEY, repo text, role text, ring text, runtime text,
  coder_workspace text, base_image text, dev_image text, template_version text, plugin_version text, versions jsonb, state text,
  in_flight jsonb NOT NULL DEFAULT '[]'::jsonb, chat_active_at timestamptz, sessions jsonb NOT NULL DEFAULT '[]'::jsonb,
  critical_failures jsonb NOT NULL DEFAULT '[]'::jsonb, push jsonb, interval_s int, started_at timestamptz, last_seen timestamptz);
  CREATE VIEW factory.workers_status AS SELECT w.*, now() - w.last_seen AS age,
  (now() - w.last_seen) > make_interval(secs => 3 * coalesce(w.interval_s, 60)) AS stale FROM factory.workers w" > /dev/null
rm -f "$DEV_SECRETS_DIR/factory-db-writer-url"
av_beat() {
  DEV_SYSTEM_SHARE="$tmpdir/share" DEV_HEARTBEAT_DIR="$tmpdir/hb" DEV_VERSIONS_FILE="$tmpdir/versions.json" \
    DEV_MACHINE_NAME=dev-box CALLUM_EVENTS_DIR="$tmpdir/events" AGENTSVIEW_DATA_DIR="$tmpdir/av" \
    AGENTSVIEW_PG_URL="$(url_for "$db3" "$ADMIN_USER" "$ADMIN_PW")" timeout 120 bash "$LOOP" --once > "$tmpdir/beat.out" 2>&1
}
echo busy > "$tmpdir/state"
av_beat || fail "agentsview beat 1: $(cat "$tmpdir/beat.out")"
av_beat || fail "agentsview beat 2 (DDL again, no change): $(cat "$tmpdir/beat.out")"
grep -q 'stats write failed' "$tmpdir/beat.out" && fail "the agentsview stats write failed: $(cat "$tmpdir/beat.out")"
[ "$(q "$db3" "SELECT procs > 0 AND stats_at IS NOT NULL FROM factory.workers_status WHERE device = 'dev-box'")" = t ] || fail "the rebuilt view should show the stats"
[ "$(q "$db3" "SELECT count(*) FROM factory.worker_samples WHERE mem_max_events = 40 AND mem_psi_some_avg10 = 2.5")" = 2 ] || fail "the agentsview samples should carry the memory columns, added by the loop's DDL"
[ "$(q "$db3" "SELECT count(*) FROM factory.worker_samples")" = 2 ] || fail "two samples expected on the agentsview database"
[ "$(q "$db3" "SELECT count(*) FROM pg_trigger WHERE tgname = 'worker_samples_prune' AND NOT tgisinternal")" = 1 ] || fail "one prune trigger expected"
q "$db3" "INSERT INTO factory.worker_samples (device, sampled_at) VALUES ('dev-box', now() - interval '40 days')" > /dev/null
av_beat || fail "agentsview beat 3"
[ "$(q "$db3" "SELECT count(*) FROM factory.worker_samples WHERE sampled_at < now() - interval '30 days'")" = 0 ] || fail "the old sample should be pruned"
echo "heartbeat-loop agentsview stats DDL: ok"

# the agentsview target gets the column from the guarded DDL, then takes config
echo '{"v":1,"at":"2026-10-19T10:00:00Z"}' > "$tmpdir/config"
av_beat || fail "agentsview beat with config: $(cat "$tmpdir/beat.out")"
grep -q 'config write failed' "$tmpdir/beat.out" && fail "the agentsview config write failed: $(cat "$tmpdir/beat.out")"
[ "$(q "$db3" "SELECT config->>'at' FROM factory.workers WHERE device = 'dev-box'")" = 2026-10-19T10:00:00Z ] || fail "the agentsview database should take config"
echo "heartbeat-loop config (agentsview database): ok"

echo '{"v":1,"at":"2026-10-19T09:00:00Z"}' > "$tmpdir/config"
echo busy > "$tmpdir/state"
# a database without the column still records the beat; only the config write fails
q "$db" "ALTER TABLE factory.workers DROP COLUMN config CASCADE" > /dev/null
before=$(q "$db" "SELECT extract(epoch FROM last_seen) FROM factory.workers WHERE device = 'dev-box'")
sleep 1
beat || fail "a missing config column must not fail the beat: $(cat "$tmpdir/beat.out")"
after=$(q "$db" "SELECT extract(epoch FROM last_seen) FROM factory.workers WHERE device = 'dev-box'")
awk -v a="$before" -v b="$after" 'BEGIN { exit !(b > a) }' || fail "last_seen should still advance: $before -> $after"
grep -q 'factory database config write failed' "$tmpdir/beat.out" || fail "the config failure is logged: $(cat "$tmpdir/beat.out")"
grep -q 'stats write failed' "$tmpdir/beat.out" && fail "stats must still land: $(cat "$tmpdir/beat.out")"
echo "heartbeat-loop config (column dropped): ok"

# a factory database still without the memory columns (migration 0019): the beat is recorded, only the
# stats call fails (logged), and the config call still lands
q "$db" "ALTER TABLE factory.workers DROP COLUMN mem_max_events, DROP COLUMN mem_max_rate_per_min, DROP COLUMN mem_oom_kills,
  DROP COLUMN mem_psi_some_avg10, DROP COLUMN mem_psi_full_avg10 CASCADE; ALTER TABLE factory.workers ADD COLUMN config jsonb" > /dev/null
echo '{"v":1,"at":"2026-10-19T11:00:00Z"}' > "$tmpdir/config"
before=$(q "$db" "SELECT extract(epoch FROM last_seen) FROM factory.workers WHERE device = 'dev-box'")
sleep 1
beat || fail "missing memory columns must not fail the beat: $(cat "$tmpdir/beat.out")"
after=$(q "$db" "SELECT extract(epoch FROM last_seen) FROM factory.workers WHERE device = 'dev-box'")
awk -v a="$before" -v b="$after" 'BEGIN { exit !(b > a) }' || fail "last_seen should still advance: $before -> $after"
grep -q 'factory database stats write failed' "$tmpdir/beat.out" || fail "the stats failure is logged: $(cat "$tmpdir/beat.out")"
grep -q 'config write failed' "$tmpdir/beat.out" && fail "config must still land: $(cat "$tmpdir/beat.out")"
[ "$(q "$db" "SELECT config->>'at' FROM factory.workers WHERE device = 'dev-box'")" = 2026-10-19T11:00:00Z ] || fail "config should land without the memory columns"
echo "heartbeat-loop memory columns missing: ok"
