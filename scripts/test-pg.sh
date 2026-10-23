# shellcheck shell=sh
# Sourced by scripts/test.sh (cbundy/dev-system#646): a real PostgreSQL for `npm test`, and one
# throwaway factory database per test.
#
#   test_pg_setup     uses the server in FACTORY_TEST_PG_ADMIN_URL when it is set (CI's
#                     postgres service); otherwise starts a private cluster from the highest
#                     /usr/lib/postgresql/*/bin (unix socket only, no TCP port, trust auth) and
#                     exports FACTORY_TEST_PG_ADMIN_URL. With no server and no binaries it
#                     sets TEST_PG_NOTE for the summary line, or fails under
#                     TEST_REQUIRE_POSTGRES=1. Honours TEST_PG_BIN_ROOT (tests stub it).
#   test_pg_check     prints `FAIL test isolation: database|role <name>` for each leftover
#                     factory_test_* database or role; non-zero if any
#   test_pg_clean     stops the private cluster and removes its directory
#   factory_test_db_new   makes factory_test_<pid>_<random> with the real bootstrap, prints
#                         its name 
#   factory_test_db_drop NAME   drops the database (WITH (FORCE)) and its five roles
#
# Each test makes its own database, so tests share a server without colliding, and the run
# fails when one is left behind.

TEST_PG_ROOT=""
TEST_PG_NOTE=""

test_pg_setup() {
  TEST_PG_NOTE=''
  if [ -n "${FACTORY_TEST_PG_ADMIN_URL:-}" ]; then
    export FACTORY_TEST_PG_ADMIN_URL
    return 0
  fi
  # The highest installed major version (TEST_PG_BIN_ROOT is a test hook).
  _tpg_initdb=''
  _tpg_best=0
  for _tpg_candidate in "${TEST_PG_BIN_ROOT:-/usr/lib/postgresql}"/*/bin; do
    [ -x "$_tpg_candidate/initdb" ] || continue
    [ -x "$_tpg_candidate/pg_ctl" ] || continue
    _tpg_major=${_tpg_candidate%/bin}
    _tpg_major=${_tpg_major##*/}
    case $_tpg_major in '' | *[!0-9]*) continue ;; esac
    if [ "$_tpg_major" -gt "$_tpg_best" ]; then
      _tpg_best=$_tpg_major
      _tpg_initdb=$_tpg_candidate
    fi
  done
  if [ -z "$_tpg_initdb" ]; then
    if [ "${TEST_REQUIRE_POSTGRES:-0}" = 1 ]; then
      echo "FAIL test setup: no PostgreSQL server (FACTORY_TEST_PG_ADMIN_URL unset, no initdb), and TEST_REQUIRE_POSTGRES=1" >&2
      return 1
    fi
    export TEST_PG_NOTE=" (database tests skipped: no PostgreSQL server; CI runs them)"
    return 0
  fi
  # A short path: a unix socket path is limited to 107 bytes.
  TEST_PG_ROOT=$(mktemp -d /tmp/pg.XXXXXX) || return 1
  if ! "$_tpg_initdb/initdb" -D "$TEST_PG_ROOT/data" -A trust -U postgres > "$TEST_PG_ROOT/initdb.log" 2>&1 \
    || ! "$_tpg_initdb/pg_ctl" -D "$TEST_PG_ROOT/data" -o "-k $TEST_PG_ROOT -c listen_addresses= -c fsync=off" \
      -w -l "$TEST_PG_ROOT/log" start > "$TEST_PG_ROOT/start.log" 2>&1; then
    echo "FAIL test setup: the private PostgreSQL cluster did not start" >&2
    cat "$TEST_PG_ROOT/initdb.log" "$TEST_PG_ROOT/start.log" "$TEST_PG_ROOT/log" >&2 2> /dev/null
    rm -rf "$TEST_PG_ROOT"
    TEST_PG_ROOT=''
    return 1
  fi
  TEST_PG_CTL="$_tpg_initdb/pg_ctl"
  # The clients (psql, pg_dump) come from the same install when the PATH has none.
  command -v psql > /dev/null 2>&1 || PATH="$_tpg_initdb:$PATH"
  export PATH
  FACTORY_TEST_PG_ADMIN_URL="postgresql://postgres@/postgres?host=$TEST_PG_ROOT"
  export FACTORY_TEST_PG_ADMIN_URL
}

# _tpg_psql SQL: runs one query against the admin URL's server, prints the rows unaligned.
_tpg_psql() {
  PGOPTIONS='-c client_min_messages=warning' psql -X -q -At -d "$FACTORY_TEST_PG_ADMIN_URL" -c "$1"
}

test_pg_check() {
  [ -n "${FACTORY_TEST_PG_ADMIN_URL:-}" ] || return 0
  _tpg_left=$(_tpg_psql "SELECT 'database ' || datname FROM pg_database WHERE datname LIKE 'factory\_test\_%' UNION ALL SELECT 'role ' || rolname FROM pg_roles WHERE rolname LIKE 'factory\_test\_%' ORDER BY 1" 2>&1) || _tpg_left="role (cannot query the server: $_tpg_left)"
  [ -z "$_tpg_left" ] && return 0
  printf '%s\n' "$_tpg_left" | sed 's/^/FAIL test isolation: /' >&2
  return 1
}

test_pg_clean() {
  if [ -n "${TEST_PG_ROOT:-}" ]; then
    "${TEST_PG_CTL:-pg_ctl}" -D "$TEST_PG_ROOT/data" -w stop -m fast > /dev/null 2>&1
    rm -rf "$TEST_PG_ROOT"
    TEST_PG_ROOT=''
  fi
}

# factory_test_db_new: prints the new database's name. Needs FACTORY_TEST_PG_ADMIN_URL and
# the repo's images/base/factory-db-bootstrap.
factory_test_db_new() {
  _tpg_name="factory_test_$$_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  FACTORY_DB_ADMIN_URL=$FACTORY_TEST_PG_ADMIN_URL \
    bash "${TEST_REPO_ROOT:-.}/images/base/factory-db-bootstrap" --db "$_tpg_name" > /dev/null || return 1
  printf '%s\n' "$_tpg_name"
}

factory_test_db_drop() {
  _tpg_psql "DROP DATABASE IF EXISTS \"$1\" WITH (FORCE)" > /dev/null
  _tpg_psql "DROP ROLE IF EXISTS \"${1}_panel\"" > /dev/null
  _tpg_psql "DROP ROLE IF EXISTS \"${1}_migrator\"" > /dev/null
  _tpg_psql "DROP ROLE IF EXISTS \"${1}_owner\"" > /dev/null
  _tpg_psql "DROP ROLE IF EXISTS \"${1}_writer\"" > /dev/null
  _tpg_psql "DROP ROLE IF EXISTS \"${1}_reader\"" > /dev/null
}
