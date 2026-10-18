#!/bin/bash
#
# Real-PostgreSQL test for `dev-query --factory` (cbundy/dev-system#897): it reads factory.event_log
# as the reader role and cannot write. Follows the factory-db-doctor.test.sh pattern; skips cleanly
# with no server.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/../../.." && pwd)
BOOTSTRAP="$ROOT/images/base/factory-db-bootstrap"
DQ="$ROOT/images/base/dev-query"
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
  echo "dev-query-factory tests skipped: no PostgreSQL server"
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
export DEV_SYSTEM_SHARE="$ROOT/images/base"
mkdir -p "$DEV_SECRETS_DIR"

RPW=rpw-$$-secret
db="factory_test_$$_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
names="$names $db"
FACTORY_DB_ADMIN_URL=$ADMIN FACTORY_DB_WRITER_PASSWORD=wpw-$$ FACTORY_DB_READER_PASSWORD=$RPW \
  bash "$BOOTSTRAP" --db "$db" > "$tmpdir/boot.out" 2>&1 || fail "bootstrap: $(cat "$tmpdir/boot.out")"
(umask 077 && url_for "$db" "${db}_reader" "$RPW" > "$DEV_SECRETS_DIR/factory-db-reader-url")

q "$db" "INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, device_seq, data) VALUES (1, '11111111-1111-4111-8111-111111111111', now(), 'ready', 1, 'acme/widgets', 'dev-box', 'x', 1, '{}')" > /dev/null

# the reader selects from factory.event_log
got=$(bash "$DQ" --factory -At -c 'select count(*) from factory.event_log' < /dev/null 2> "$tmpdir/err") || fail "select failed: $(cat "$tmpdir/err")"
[ "$got" = 1 ] || fail "expected 1 row from factory.event_log, got '$got'"
echo "ok: --factory reads factory.event_log as the reader"

# a write fails
rc=0
bash "$DQ" --factory -c "insert into factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, device_seq, data) values (1, '22222222-2222-4222-8222-222222222222', now(), 'ready', 1, 'a/b', 'd', 'x', 2, '{}')" \
  < /dev/null > "$tmpdir/out" 2> "$tmpdir/err" || rc=$?
[ "$rc" != 0 ] || fail "an INSERT must fail"
grep -qi "read-only\|permission denied" "$tmpdir/err" || fail "unexpected error: $(cat "$tmpdir/err")"
[ "$(q "$db" 'select count(*) from factory.event_store')" = 1 ] || fail "the INSERT landed"
grep -q "$RPW" "$tmpdir/err" "$tmpdir/out" && fail "password leaked"
echo "ok: an INSERT is refused"
echo "dev-query-factory tests passed"
