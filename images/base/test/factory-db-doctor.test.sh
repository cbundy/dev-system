#!/bin/bash
#
# Tests for images/base/factory-db.sh (cbundy/dev-system#647): the per-role URL lookup and the
# factory database check dev-doctor runs, against a real PostgreSQL (scripts/test-pg.sh). It also
# follows the steps of docs/factory-db.md and ends with both checks OK.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/../../.." && pwd)
BOOTSTRAP="$ROOT/images/base/factory-db-bootstrap"
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
  chmod -R u+rwx "$tmpdir" 2> /dev/null || :
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
  echo "factory-db-doctor tests skipped: no PostgreSQL server"
  exit 0
fi
ADMIN=$FACTORY_TEST_PG_ADMIN_URL

# shellcheck source=../factory-db.sh
. "$ROOT/images/base/factory-db.sh"

# url_for DB [USER [PASSWORD]]: a URL on the test server. The server may be a unix socket
# (?host=DIR) or TCP; only the user, password and database change.
url_for() {
  local rest=${ADMIN#*://} scheme=${ADMIN%%://*} hostpart query=''
  case "$rest" in *\?*) query=${rest#*\?}; rest=${rest%%\?*} ;; esac
  hostpart=${rest##*@}
  hostpart=${hostpart%%/*}
  local cred=''
  if [ -n "${2:-}" ]; then cred="$2${3:+:$3}@"; fi
  printf '%s://%s%s/%s%s\n' "$scheme" "$cred" "$hostpart" "$1" "${query:+?$query}"
}
q() { psql -X -q -At -v ON_ERROR_STOP=1 "$(url_for "$1" "${ADMIN_USER:-}" "${ADMIN_PW:-}")" -c "$2"; }
ADMIN_USER=$(printf '%s' "${ADMIN#*://}" | sed -n 's/^\([^:@/?]*\).*@.*/\1/p')
ADMIN_PW=$(printf '%s' "${ADMIN#*://}" | sed -n 's/^[^:@/?]*:\([^@/?]*\)@.*/\1/p')

# Reads no ambient config.
unset AGENTSVIEW_PG_URL FACTORY_DB_WRITER_URL FACTORY_DB_READER_URL FACTORY_DB_MIGRATIONS_DIR
export DEV_WORKSPACE_SECRETS_DIR="$tmpdir/ws-secrets"  # never the ambient workspace folder
export DEV_SECRETS_DIR="$tmpdir/secrets"
mkdir -p "$DEV_SECRETS_DIR"

WPW=wpw-$$-secret
RPW=rpw-$$-secret
db="factory_test_$$_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
names="$names $db"

# check ROLE: runs factory_db_check in a fresh shell (the env as given), output in $out, status in $rc.
check() {
  rc=0
  out=$(bash -c '. "$1"; factory_db_check "$2"' _ "$ROOT/images/base/factory-db.sh" "$1" 2>&1) || rc=$?
}
expect() { # expect RC PATTERN...
  local want=$1 p
  shift
  [ "$rc" = "$want" ] || fail "expected status $want, got $rc: $out"
  for p in "$@"; do
    case "$out" in *"$p"*) ;; *) fail "expected '$p' in: $out" ;; esac
  done
}
absent() {
  case "$out" in *"$1"*) fail "'$1' must not appear in: $out" ;; esac
}

# -- 1. not configured: WARN naming both files and the doc; AGENTSVIEW_PG_URL is not a fallback
AGENTSVIEW_PG_URL=postgres://u:agentsview-pw@127.0.0.1:1/x check writer
expect 1 "WARN" "factory-db-writer-url" "factory-db-reader-url" "docs/factory-db.md"
absent agentsview-pw
echo "ok: not configured warns, never falls back to AGENTSVIEW_PG_URL"
(
  rc=0
  AGENTSVIEW_PG_URL=x factory_db_url reader > /dev/null || rc=$?
  [ "$rc" = 1 ] || exit 1
) || fail "factory_db_url fell back to AGENTSVIEW_PG_URL"

# -- 2. empty and unreadable files
: > "$DEV_SECRETS_DIR/factory-db-writer-url"
check writer
expect 2 "FAIL" "empty or not readable" "chown 1000:1000"
echo "ok: empty file fails with the fix"
if [ "$(id -u)" != 0 ]; then
  printf 'x\n' > "$DEV_SECRETS_DIR/factory-db-writer-url"
  chmod 000 "$DEV_SECRETS_DIR/factory-db-writer-url"
  check writer
  expect 2 "FAIL" "empty or not readable" "chmod 0600"
  chmod 600 "$DEV_SECRETS_DIR/factory-db-writer-url"
  echo "ok: unreadable file fails with the fix"
fi
rm -f "$DEV_SECRETS_DIR/factory-db-writer-url"

# -- 3. the doc's procedure: bootstrap with the passwords, compose the URLs, write the files
FACTORY_DB_ADMIN_URL=$ADMIN FACTORY_DB_WRITER_PASSWORD=$WPW FACTORY_DB_READER_PASSWORD=$RPW \
  bash "$BOOTSTRAP" --db "$db" > "$tmpdir/boot.out" 2>&1 || fail "bootstrap: $(cat "$tmpdir/boot.out")"
WURL=$(url_for "$db" "${db}_writer" "$WPW")
RURL=$(url_for "$db" "${db}_reader" "$RPW")
(umask 077 && printf '%s\n' "$WURL" > "$DEV_SECRETS_DIR/factory-db-writer-url" \
  && printf '%s\n' "$RURL" > "$DEV_SECRETS_DIR/factory-db-reader-url")
EXPECTED=$(factory_db_expected_version)
[ "$EXPECTED" = 21 ] || fail "expected version should be 21 for the shipped migrations, got $EXPECTED"
for role in writer reader; do
  check $role
  expect 0 "OK" "database $db" "${db}_$role" "schema version $EXPECTED"
  absent "$WPW"
  absent "$RPW"
  absent "postgres"
done
echo "ok: following the doc ends with both checks OK, no password in the output"

# -- 4. env wins over the file
rc=0
out=$(FACTORY_DB_WRITER_URL="$WURL" DEV_SECRETS_DIR="$tmpdir/none" bash -c '. "$1"; factory_db_check writer' _ "$ROOT/images/base/factory-db.sh" 2>&1) || rc=$?
expect 0 "OK" "FACTORY_DB_WRITER_URL"
echo "ok: the environment wins over the file"

# -- 4b. a workspace on another database: its own files win over the shared ones
db2="factory_test_$$_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')_ws"
names="$names $db2"
FACTORY_DB_ADMIN_URL=$ADMIN FACTORY_DB_WRITER_PASSWORD=$WPW FACTORY_DB_READER_PASSWORD=$RPW \
  bash "$BOOTSTRAP" --db "$db2" > "$tmpdir/boot2.out" 2>&1 || fail "bootstrap 2: $(cat "$tmpdir/boot2.out")"
WURL2=$(url_for "$db2" "${db2}_writer" "$WPW")
export DEV_WORKSPACE_SECRETS_DIR="$tmpdir/ws-secrets"
WSFILE="$DEV_WORKSPACE_SECRETS_DIR/factory-db-writer-url"
check writer
expect 0 "OK" "database $db " "$DEV_SECRETS_DIR/factory-db-writer-url"
absent "$DEV_WORKSPACE_SECRETS_DIR"
[ "$(factory_db_url_file writer)" = "$DEV_SECRETS_DIR/factory-db-writer-url" ] || fail "url_file should be the shared file"
echo "ok: with no workspace folder the shared file is used and named"
mkdir -p "$DEV_WORKSPACE_SECRETS_DIR"
printf '%s\n' "$WURL2" > "$WSFILE"
check writer
expect 0 "OK" "database $db2 " "$WSFILE"
absent "$WPW"
[ "$(factory_db_url_file writer)" = "$WSFILE" ] || fail "url_file should be the workspace file"
[ "$(factory_db_url writer)" = "$WURL2" ] || fail "factory_db_url should return the workspace URL"
[ "$(factory_db_url reader)" = "$RURL" ] || fail "the reader should still use the shared file"
check reader
expect 0 "OK" "database $db " "$DEV_SECRETS_DIR/factory-db-reader-url"
echo "ok: the workspace file wins, per role, and the shared database is untouched"
rc=0
out=$(FACTORY_DB_WRITER_URL="$WURL" bash -c '. "$1"; factory_db_check writer' _ "$ROOT/images/base/factory-db.sh" 2>&1) || rc=$?
expect 0 "OK" "database $db " "FACTORY_DB_WRITER_URL"
echo "ok: the environment wins over the workspace file"
: > "$WSFILE"
check writer
expect 2 "FAIL" "$WSFILE" "empty or not readable"
rc=0
factory_db_url writer > /dev/null || rc=$?
[ "$rc" = 2 ] || fail "an empty workspace file must return 2, got $rc"
echo "ok: an empty workspace file fails, with no fallback to the shared one"
rm -f "$WSFILE"
mv "$DEV_SECRETS_DIR/factory-db-writer-url" "$tmpdir/keep-writer"
check writer
expect 1 "WARN" "$DEV_WORKSPACE_SECRETS_DIR/factory-db-writer-url" "$DEV_SECRETS_DIR/factory-db-writer-url" "docs/factory-db.md"
echo "ok: not configured names both folders"
mv "$tmpdir/keep-writer" "$DEV_SECRETS_DIR/factory-db-writer-url"
export DEV_WORKSPACE_SECRETS_DIR="$tmpdir/no-ws-secrets"

# -- 5. wrong role
cp "$DEV_SECRETS_DIR/factory-db-reader-url" "$DEV_SECRETS_DIR/factory-db-writer-url"
check writer
expect 2 "FAIL" "${db}_reader" "_writer"
echo "ok: reader URL in the writer slot fails"
printf '%s\n' "$(url_for "$db" "$ADMIN_USER" "$ADMIN_PW")" > "$DEV_SECRETS_DIR/factory-db-writer-url"
check writer
expect 2 "FAIL" "expected a role ending in _writer"
echo "ok: an admin URL fails"
printf '%s\n' "$WURL" > "$DEV_SECRETS_DIR/factory-db-writer-url"
printf '%s\n' "$WURL" > "$DEV_SECRETS_DIR/factory-db-reader-url"
check reader
expect 2 "FAIL" "expected a role ending in _reader"
printf '%s\n' "$RURL" > "$DEV_SECRETS_DIR/factory-db-reader-url"

# a writer that can create in schema factory is refused
q "$db" "GRANT CREATE ON SCHEMA factory TO \"${db}_writer\"" > /dev/null
check writer
expect 2 "FAIL" "can create in schema factory"
q "$db" "REVOKE CREATE ON SCHEMA factory FROM \"${db}_writer\"" > /dev/null
check writer
expect 0 "OK"
echo "ok: a role that can create in schema factory fails"

# -- 6. wrong password and unreachable port: masked, bounded
printf '%s\n' "$(url_for "$db" "${db}_writer" "wrong-$WPW")" > "$DEV_SECRETS_DIR/factory-db-writer-url"
case "$ADMIN" in
  *host=/*) ;; # a unix socket with trust auth accepts any password
  *)
    check writer
    expect 2 "FAIL" "cannot connect" "sslmode=require"
    absent "wrong-$WPW"
    echo "ok: a wrong password fails, masked"
    ;;
esac
printf 'postgresql://%s_writer:%s@127.0.0.1:1/%s\n' "$db" "$WPW" "$db" > "$DEV_SECRETS_DIR/factory-db-writer-url"
start=$SECONDS
check writer
expect 2 "FAIL" "cannot connect" "sslmode=require"
absent "$WPW"
[ $((SECONDS - start)) -lt 25 ] || fail "the probe was not bounded"
echo "ok: an unreachable port fails, masked and bounded"
printf '%s\n' "$WURL" > "$DEV_SECRETS_DIR/factory-db-writer-url"

# -- 7. schema behind, ahead, and missing
mkdir "$tmpdir/mig-behind" "$tmpdir/mig-ahead"
cp "$ROOT"/images/base/factory-db/migrations/*.sql "$tmpdir/mig-behind/"
next=$((EXPECTED + 1)) # one migration more than the image ships
echo "SELECT 1;" > "$tmpdir/mig-behind/$(printf '%04d' "$next")_extra.sql"
rc=0
out=$(FACTORY_DB_MIGRATIONS_DIR="$tmpdir/mig-behind" bash -c '. "$1"; factory_db_check writer' _ "$ROOT/images/base/factory-db.sh" 2>&1) || rc=$?
expect 2 "FAIL" "behind" "factory-db-migrate" "--migrate" "migrations $next..$next"
if printf '%s\n' "$out" | grep -q 'admin URL'; then
  fail "the behind fix must not offer the admin URL: $out"
fi
echo "ok: schema behind fails with the migrate fix"
q "$db" "INSERT INTO factory.schema_migrations (version, name, sha256) VALUES ($next, 'future', 'x')" > /dev/null
check writer
expect 2 "FAIL" "ahead" "pull a newer image"
q "$db" "DELETE FROM factory.schema_migrations WHERE version = $next" > /dev/null
echo "ok: schema ahead fails"
echo "-- only a lower version" > "$tmpdir/mig-ahead/0000_none.sql"
rc=0
out=$(FACTORY_DB_MIGRATIONS_DIR="$tmpdir/mig-ahead" bash -c '. "$1"; factory_db_check writer' _ "$ROOT/images/base/factory-db.sh" 2>&1) || rc=$?
expect 2 "FAIL" "ahead" "pull a newer image"
echo "ok: a recorded version above the image's fails"

plain="factory_test_$$_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')_plain"
names="$names $plain"
psql -X -q -At -v ON_ERROR_STOP=1 "$ADMIN" -c "CREATE ROLE \"${plain}_writer\" LOGIN PASSWORD '$WPW'" -c "CREATE DATABASE \"$plain\"" > /dev/null
printf '%s\n' "$(url_for "$plain" "${plain}_writer" "$WPW")" > "$DEV_SECRETS_DIR/factory-db-writer-url"
check writer
expect 2 "FAIL" "no factory.schema_migrations" "factory-db-bootstrap --db $plain"
echo "ok: a database without schema_migrations fails with the bootstrap fix"

echo "factory-db-doctor tests passed"
