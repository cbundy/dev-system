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
for f in agentsview.sh factory-db.sh workspace.sh; do ln -s "$ROOT/images/base/$f" "$tmpdir/share/$f"; done
cat > "$tmpdir/share/heartbeat-state" <<STUB
#!/bin/sh
printf '{"state":"%s","in_flight":[],"chat_active_at":null,"sessions":[]}\n' "\$(cat "$tmpdir/state")"
STUB
chmod +x "$tmpdir/share/heartbeat-state"

WPW=wpw-$$-secret
db="factory_test_$$_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
names="$names $db"
FACTORY_DB_ADMIN_URL=$ADMIN FACTORY_DB_WRITER_PASSWORD=$WPW \
  bash "$BOOTSTRAP" --db "$db" > "$tmpdir/boot.out" 2>&1 || fail "bootstrap: $(cat "$tmpdir/boot.out")"
WURL=$(url_for "$db" "${db}_writer" "$WPW")

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
grep -q 'permission denied\|ERROR' "$tmpdir/beat.out" && fail "the writer beat logged an error: $(cat "$tmpdir/beat.out")"
echo "heartbeat-loop factory-db: ok"

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
