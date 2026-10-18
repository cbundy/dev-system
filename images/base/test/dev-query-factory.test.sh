#!/bin/bash
#
# Tests for dev-query --factory (cbundy/dev-system#904) against a real PostgreSQL
# (scripts/test-pg.sh) with a bootstrapped throwaway factory database. Skips cleanly with no server.
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
  echo "dev-query --factory tests skipped: no PostgreSQL server"
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

unset AGENTSVIEW_PG_URL FACTORY_DB_WRITER_URL FACTORY_DB_READER_URL
export DEV_SECRETS_DIR="$tmpdir/secrets"
export DEV_WORKSPACE_SECRETS_DIR="$tmpdir/no-ws-secrets"
mkdir -p "$DEV_SECRETS_DIR"
export DEV_SYSTEM_SHARE="$ROOT/images/base"

WPW=wpw-$$-secret
RPW=rpw-$$-secret
suffix=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
db="factory_test_$$_$suffix"
names="$names $db"
FACTORY_DB_ADMIN_URL=$ADMIN FACTORY_DB_WRITER_PASSWORD=$WPW FACTORY_DB_READER_PASSWORD=$RPW \
  bash "$BOOTSTRAP" --db "$db" > "$tmpdir/boot.out" 2>&1 || fail "bootstrap: $(cat "$tmpdir/boot.out")"
url_for "$db" "${db}_reader" "$RPW" > "$DEV_SECRETS_DIR/factory-db-reader-url"

run() { bash "$DQ" "$@" > "$tmpdir/out" 2> "$tmpdir/err" < /dev/null && rc=0 || rc=$?; }

run --factory -At -c 'select current_user'
[ "$rc" = 0 ] || fail "current_user: exit $rc: $(cat "$tmpdir/err")"
[ "$(cat "$tmpdir/out")" = "${db}_reader" ] || fail "current_user is '$(cat "$tmpdir/out")'"

run --factory -At -c 'select count(*) from factory.event_log'
[ "$rc" = 0 ] || fail "event_log: exit $rc: $(cat "$tmpdir/err")"
[ "$(cat "$tmpdir/out")" = 0 ] || fail "event_log count is '$(cat "$tmpdir/out")'"

run --factory -c "insert into factory.event_store default values"
[ "$rc" != 0 ] || fail "insert succeeded for the reader"
grep -q "$RPW" "$tmpdir/out" "$tmpdir/err" && fail "reader password in output"

echo "PASS: dev-query --factory (real PostgreSQL)"
