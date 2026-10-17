#!/bin/sh
#
# Tests for images/base/factory-db-bootstrap (cbundy/dev-system#646) against a real PostgreSQL:
# the private cluster or the CI service that scripts/test.sh sets up (scripts/test-pg.sh).
# Run alone, the suite starts its own cluster. Every database it makes is dropped on exit.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT="$SCRIPT_DIR/../../.."
BOOTSTRAP="$ROOT/images/base/factory-db-bootstrap"
TEST_REPO_ROOT=$(CDPATH='' cd -- "$ROOT" && pwd)
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
  echo "factory-db-bootstrap tests skipped: no PostgreSQL server"
  exit 0
fi
ADMIN=$FACTORY_TEST_PG_ADMIN_URL

# url_for DB: the admin URL pointed at DB.
url_for() {
  case "$ADMIN" in
    *\?*) printf '%s&dbname=%s\n' "$ADMIN" "$1" ;;
    *) printf '%s?dbname=%s\n' "$ADMIN" "$1" ;;
  esac
}
# q DB SQL: runs SQL in DB, prints the rows unaligned.
q() { psql -X -q -At -v ON_ERROR_STOP=1 "$(url_for "$1")" -c "$2"; }
# as DB ROLE SQL: the same, as ROLE (SET ROLE).
as() { q "$1" "SET ROLE \"$2\"; $3"; }
# new_name: sets $new_db to a fresh unique database name, registered for the drop on exit.
# (Not a command substitution: the registration must reach this shell.)
new_name() {
  new_db="factory_test_$$_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  names="$names $new_db"
}
# boot ARGS...: the real command against the test server; output in $tmpdir/out, status returned.
boot() {
  FACTORY_DB_ADMIN_URL=$ADMIN bash "$BOOTSTRAP" "$@" > "$tmpdir/out" 2>&1
}
# denied DB ROLE SQL: SQL as ROLE must fail with a permission error.
denied() {
  if out=$(as "$1" "$2" "$3" 2>&1); then fail "$2 was allowed: $3"; fi
  case "$out" in
    *"permission denied"* | *"must be owner"*) ;;
    *) fail "$2: expected a permission error for '$3', got: $out" ;;
  esac
}
# snapshot DB: roles, grants, schema objects and schema_migrations as text.
snapshot() {
  db=$1
  q "$db" "
    SELECT 'role', rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole
      FROM pg_roles WHERE rolname LIKE '${db}\\_%' ORDER BY 2;
    SELECT 'member', pg_get_userbyid(roleid), pg_get_userbyid(member), admin_option, inherit_option, set_option
      FROM pg_auth_members WHERE roleid IN (SELECT oid FROM pg_roles WHERE rolname LIKE '${db}\\_%') ORDER BY 2, 3;
    SELECT 'db', datname, pg_get_userbyid(datdba), datacl FROM pg_database WHERE datname = '${db}';
    SELECT 'schema', nspname, pg_get_userbyid(nspowner), nspacl FROM pg_namespace
      WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 2;
    SELECT 'rel', c.oid::regclass, c.relkind, pg_get_userbyid(c.relowner), c.relacl
      FROM pg_class c WHERE c.relnamespace = 'factory'::regnamespace ORDER BY 2;
    SELECT 'def', indexdef FROM pg_indexes WHERE schemaname = 'factory' ORDER BY 2;
    SELECT 'view', c.relname, pg_get_viewdef(c.oid) FROM pg_class c
      WHERE c.relnamespace = 'factory'::regnamespace AND c.relkind = 'v' ORDER BY 2;
    SELECT 'func', pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.pronamespace = 'factory'::regnamespace ORDER BY 2;
    SELECT 'trigger', pg_get_triggerdef(t.oid) FROM pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'factory'::regnamespace) ORDER BY 2;
    SELECT 'defacl', pg_get_userbyid(defaclrole), defaclobjtype, defaclacl FROM pg_default_acl ORDER BY 2, 3;
    SELECT 'grant', grantee, table_name, privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'factory' AND grantee LIKE '${db}\\_%' ORDER BY 2, 3, 4;
    SELECT 'migration', version, name, sha256 FROM factory.schema_migrations ORDER BY 2;
  "
}

# --- a bad or missing --db is refused before any connection ----------------------
export FACTORY_DB_ADMIN_URL='postgresql://nobody:unreachable-secret@127.0.0.1:1/postgres'
too_long=$(printf 'a%.0s' $(seq 1 49))
for bad in 'Bad' '1abc' 'a-b' 'a b' "$too_long" 'a;drop' ''; do
  if bash "$BOOTSTRAP" --db "$bad" > "$tmpdir/out" 2>&1; then fail "--db '$bad' was accepted"; fi
  grep -q 'not valid\|is required' "$tmpdir/out" || fail "--db '$bad': no name error: $(cat "$tmpdir/out")"
  grep -q 'could not\|connection' "$tmpdir/out" && fail "--db '$bad' reached a connection: $(cat "$tmpdir/out")"
done
if bash "$BOOTSTRAP" > "$tmpdir/out" 2>&1; then fail "a missing --db was accepted"; fi
grep -q -- '--db NAME is required' "$tmpdir/out" || fail "a missing --db: no usage error"
if env -u FACTORY_DB_ADMIN_URL bash "$BOOTSTRAP" --db okname > "$tmpdir/out" 2>&1; then fail "no admin URL was accepted"; fi
grep -q 'no admin URL' "$tmpdir/out" || fail "no admin URL: unhelpful error: $(cat "$tmpdir/out")"
bash "$BOOTSTRAP" --help | grep -q -- '--admin-url-file' || fail "--help does not describe --admin-url-file"
export FACTORY_DB_ADMIN_URL="$ADMIN"

# The version the shipped migrations reach, and the numbers the scratch migrations below take.
EXPECTED=$(bash -c ". '$ROOT/images/base/factory-db.sh'; factory_db_expected_version")
[ "$EXPECTED" -ge 2 ] || fail "expected version should be at least 2, got '$EXPECTED'"
PROBE_VER=$((EXPECTED + 1))
BROKEN=$((EXPECTED + 2))
ALL_VERSIONS=$(seq -s, 1 "$EXPECTED")
PROBE_VERSIONS=$(seq -s, 1 "$PROBE_VER")
PROBE_FILE=$(printf '%04d_probe.sql' "$PROBE_VER")
BROKEN_FILE=$(printf '%04d_broken.sql' "$BROKEN")

# --- creates the database, is idempotent -------------------------------------------
new_name
db=$new_db
[ "$(q postgres "SELECT count(*) FROM pg_database WHERE datname = '$db'")" = 0 ] || fail "$db exists before the run"
boot --db "$db" || fail "first run failed: $(cat "$tmpdir/out")"
[ "$(wc -l < "$tmpdir/out")" = 1 ] || fail "expected one summary line, got: $(cat "$tmpdir/out")"
grep -q "database $db ready (roles ${db}_owner, ${db}_writer, ${db}_reader), schema version $EXPECTED\$" "$tmpdir/out" \
  || fail "unexpected summary: $(cat "$tmpdir/out")"
[ "$(q postgres "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$db'")" = "${db}_owner" ] \
  || fail "the database is not owned by ${db}_owner"
snapshot "$db" > "$tmpdir/snap1" || fail "snapshot 1 failed"
[ -s "$tmpdir/snap1" ] || fail "empty snapshot"
boot --db "$db" || fail "second run failed: $(cat "$tmpdir/out")"
grep -q "schema version $EXPECTED\$" "$tmpdir/out" || fail "second run: unexpected summary: $(cat "$tmpdir/out")"
snapshot "$db" > "$tmpdir/snap2" || fail "snapshot 2 failed"
cmp -s "$tmpdir/snap1" "$tmpdir/snap2" || fail "run 2 changed the database: $(diff "$tmpdir/snap1" "$tmpdir/snap2")"
[ "$(q "$db" "SELECT string_agg(version::text, ',' ORDER BY version) FROM factory.schema_migrations")" = "$ALL_VERSIONS" ] \
  || fail "schema_migrations does not hold versions $ALL_VERSIONS"
# pg_dump too, when its version can read the server.
server_major=$(q postgres "SHOW server_version_num")
server_major=$((server_major / 10000))
dump_major=$(pg_dump --version | sed -n 's/^[^0-9]*\([0-9][0-9]*\).*/\1/p')
if [ "${dump_major:-0}" -ge "$server_major" ]; then
  # (the \restrict token is random per dump)
  pg_dump --schema-only "$(url_for "$db")" 2> /dev/null | grep -v '^.\{0,1\}\(un\)\{0,1\}restrict ' > "$tmpdir/dump1" || fail "pg_dump failed"
  boot --db "$db" || fail "third run failed"
  pg_dump --schema-only "$(url_for "$db")" 2> /dev/null | grep -v '^.\{0,1\}\(un\)\{0,1\}restrict ' > "$tmpdir/dump2" || fail "pg_dump failed"
  cmp -s "$tmpdir/dump1" "$tmpdir/dump2" || fail "pg_dump differs between runs: $(diff "$tmpdir/dump1" "$tmpdir/dump2")"
  grep -q 'ALTER DEFAULT PRIVILEGES' "$tmpdir/dump1" || fail "the dump has no default privileges"
fi
# --admin-url-file works the same.
printf '%s\n' "$ADMIN" > "$tmpdir/url"
chmod 600 "$tmpdir/url"
env -u FACTORY_DB_ADMIN_URL bash "$BOOTSTRAP" --db "$db" --admin-url-file "$tmpdir/url" > "$tmpdir/out" 2>&1 \
  || fail "--admin-url-file run failed: $(cat "$tmpdir/out")"

# --- a pre-existing database owned by the admin is taken over ---------------------
main_db=$db   # snapshot() reassigns db; restored below for the sections that follow
new_name
pre_db=$new_db
q postgres "CREATE DATABASE \"$pre_db\"" > /dev/null || fail "cannot create the pre-existing database"
[ "$(q postgres "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$pre_db'")" != "${pre_db}_owner" ] \
  || fail "the pre-existing database is already owned by the factory owner"
boot --db "$pre_db" || fail "taking over an existing database failed: $(cat "$tmpdir/out")"
[ "$(wc -l < "$tmpdir/out")" = 1 ] || fail "takeover: expected one summary line: $(cat "$tmpdir/out")"
grep -q "schema version $EXPECTED\$" "$tmpdir/out" || fail "takeover: unexpected summary: $(cat "$tmpdir/out")"
[ "$(q postgres "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$pre_db'")" = "${pre_db}_owner" ] \
  || fail "the taken-over database is not owned by ${pre_db}_owner"
[ "$(q "$pre_db" "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'factory'")" = "${pre_db}_owner" ] \
  || fail "the factory schema in the taken-over database is not owned by ${pre_db}_owner"
snapshot "$pre_db" > "$tmpdir/psnap1" || fail "takeover snapshot 1 failed"
boot --db "$pre_db" || fail "second run on the taken-over database failed"
snapshot "$pre_db" > "$tmpdir/psnap2" || fail "takeover snapshot 2 failed"
cmp -s "$tmpdir/psnap1" "$tmpdir/psnap2" || fail "run 2 changed the taken-over database: $(diff "$tmpdir/psnap1" "$tmpdir/psnap2")"
db=$main_db

# --- the schemas ------------------------------------------------------------------
[ "$(q "$db" "SELECT string_agg(nspname, ',' ORDER BY nspname) FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'")" = "factory,public" ] \
  || fail "unexpected schemas (nomistakes must not exist)"
[ "$(q "$db" "SELECT count(*) FROM pg_class WHERE relnamespace = 'factory'::regnamespace AND relname IN ('events')")" = 0 ] \
  || fail "factory.events exists"

# --- the roles --------------------------------------------------------------------
[ "$(q postgres "SELECT rolcanlogin FROM pg_roles WHERE rolname = '${db}_owner'")" = f ] || fail "the owner can log in"
[ "$(q postgres "SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole FROM pg_roles WHERE rolname = '${db}_writer'")" = t ] || fail "writer attributes"
[ "$(q postgres "SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole FROM pg_roles WHERE rolname = '${db}_reader'")" = t ] || fail "reader attributes"
[ "$(q postgres "SELECT has_database_privilege('${db}_writer', '$db', 'CONNECT') AND has_database_privilege('${db}_reader', '$db', 'CONNECT')")" = t ] || fail "writer and reader cannot connect"
[ "$(q postgres "SELECT has_database_privilege('public_probe_absent', '$db', 'CONNECT')" 2> /dev/null || echo err)" = err ] || :
[ "$(q postgres "SELECT has_database_privilege(0::oid, oid, 'CONNECT') FROM pg_database WHERE datname = '$db'")" = f ] || fail "PUBLIC can still connect"
[ "$(q postgres "SELECT has_database_privilege(0::oid, oid, 'TEMP') FROM pg_database WHERE datname = '$db'")" = f ] || fail "PUBLIC can still create temp tables"
[ "$(q "$db" "SELECT has_schema_privilege(0::oid, 'public', 'CREATE')")" = f ] || fail "PUBLIC can create in public"

ev="INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
    VALUES (1, gen_random_uuid(), now(), 'claimed', 1, 'o/r', 'd', 'agent', 1, 1, '{\"lease_minutes\": 120}')"
as "$db" "${db}_writer" "$ev" > /dev/null || fail "the writer cannot insert an event"
as "$db" "${db}_writer" "INSERT INTO factory.workers (device, state, last_seen) VALUES ('d1', 'idle', now())
    ON CONFLICT (device) DO UPDATE SET state = 'busy', last_seen = now()" > /dev/null || fail "the writer cannot upsert a worker"
as "$db" "${db}_writer" "INSERT INTO factory.workers (device, state, last_seen) VALUES ('d1', 'idle', now())
    ON CONFLICT (device) DO UPDATE SET state = 'busy', last_seen = now()" > /dev/null || fail "the writer cannot upsert a worker twice"
denied "$db" "${db}_writer" "DELETE FROM factory.event_store"
denied "$db" "${db}_writer" "TRUNCATE factory.event_store"
denied "$db" "${db}_writer" "DELETE FROM factory.workers"
as "$db" "${db}_writer" "UPDATE factory.workers SET cpu_pct = 12.5, procs = 40, stats_at = now() WHERE device = 'd1'" > /dev/null || fail "the writer cannot update the stats columns"
as "$db" "${db}_writer" "INSERT INTO factory.worker_samples (device, sampled_at, state, cpu_pct, procs)
    VALUES ('d1', now() - interval '31 days', 'busy', 1, 1), ('d2', now() - interval '31 days', 'busy', 1, 1)" > /dev/null || fail "the writer cannot insert old samples"
[ "$(q "$db" "SELECT count(*) FROM factory.worker_samples")" = 2 ] || fail "an insert prunes only samples more than 30 days older than itself"
as "$db" "${db}_writer" "INSERT INTO factory.worker_samples (device, sampled_at, state, cpu_pct, procs) VALUES ('d1', now(), 'idle', 2, 2)" > /dev/null \
  || fail "the writer cannot insert a sample"
[ "$(q "$db" "SELECT string_agg(device || '/' || state, ',' ORDER BY device, state) FROM factory.worker_samples")" = "d1/idle,d2/busy" ] \
  || fail "the next insert should prune only that device's old sample: $(q "$db" "SELECT device, state FROM factory.worker_samples")"
denied "$db" "${db}_writer" "DELETE FROM factory.worker_samples"
[ "$(q "$db" "SELECT pg_get_userbyid(proowner) || '|' || prosecdef || '|' || proconfig[1] FROM pg_proc WHERE proname = 'worker_samples_prune'")" = "${db}_owner|true|search_path=factory, pg_temp" ] \
  || fail "the prune function is not a SECURITY DEFINER owned by the owner with a pinned search_path: $(q "$db" "SELECT pg_get_userbyid(proowner), prosecdef, proconfig FROM pg_proc WHERE proname = 'worker_samples_prune'")"
denied "$db" "${db}_writer" "CREATE TABLE factory.t (a int)"
denied "$db" "${db}_writer" "CREATE TABLE public.t (a int)"
denied "$db" "${db}_writer" "INSERT INTO factory.schema_migrations (version, name, sha256) VALUES (99, 'x', 'y')"
denied "$db" "${db}_writer" "UPDATE factory.schema_migrations SET name = 'x'"
denied "$db" "${db}_writer" "INSERT INTO factory.event_log (event_id) VALUES (gen_random_uuid())"
as "$db" "${db}_reader" "SELECT count(*) FROM factory.event_log" > /dev/null || fail "the reader cannot read event_log"
as "$db" "${db}_reader" "SELECT count(*) FROM factory.workers_status" > /dev/null || fail "the reader cannot read workers_status"
as "$db" "${db}_reader" "SELECT cpu_pct FROM factory.workers_status" > /dev/null || fail "the reader cannot read workers_status.cpu_pct"
as "$db" "${db}_reader" "SELECT count(*) FROM factory.worker_samples" > /dev/null || fail "the reader cannot read worker_samples"
denied "$db" "${db}_reader" "INSERT INTO factory.worker_samples (device, sampled_at) VALUES ('x', now())"
as "$db" "${db}_reader" "SELECT count(*) FROM factory.schema_migrations" > /dev/null || fail "the reader cannot read schema_migrations"
denied "$db" "${db}_reader" "$ev"
denied "$db" "${db}_reader" "UPDATE factory.workers SET state = 'x'"
denied "$db" "${db}_reader" "CREATE TABLE factory.t (a int)"
[ "$(q "$db" "SELECT count(*) FROM factory.event_log")" = 1 ] || fail "the inserted event is not in event_log"
# The notify trigger fires on an event insert.
[ "$(q "$db" "SELECT count(*) FROM pg_trigger WHERE tgname = 'event_store_notify' AND NOT tgisinternal")" = 1 ] || fail "no notify trigger on event_store"

# --- default privileges and the migration refusals ---------------------------------
migs="$tmpdir/migs"
mkdir "$migs"
cp "$ROOT"/images/base/factory-db/migrations/*.sql "$migs/"
cat > "$migs/$PROBE_FILE" << 'SQL'
CREATE TABLE factory.probe (id int PRIMARY KEY, note text);
SQL
FACTORY_DB_MIGRATIONS_DIR=$migs boot --db "$db" || fail "run with $PROBE_FILE failed: $(cat "$tmpdir/out")"
grep -q "schema version $PROBE_VER\$" "$tmpdir/out" || fail "version is not $PROBE_VER: $(cat "$tmpdir/out")"
[ "$(q "$db" "SELECT string_agg(version::text, ',' ORDER BY version) FROM factory.schema_migrations")" = "$PROBE_VERSIONS" ] || fail "only the probe should have been added"
as "$db" "${db}_writer" "INSERT INTO factory.probe VALUES (1, 'a'); UPDATE factory.probe SET note = 'b'" > /dev/null || fail "the writer has no grants on the probe table"
as "$db" "${db}_reader" "SELECT * FROM factory.probe" > /dev/null || fail "the reader has no grants on the probe table"
denied "$db" "${db}_writer" "DELETE FROM factory.probe"
denied "$db" "${db}_reader" "INSERT INTO factory.probe VALUES (2, 'c')"
[ "$(q "$db" "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'factory.probe'::regclass")" = "${db}_owner" ] || fail "the probe table is not owned by the owner"
# An edited applied migration.
echo "-- edited" >> "$migs/$PROBE_FILE"
if FACTORY_DB_MIGRATIONS_DIR=$migs boot --db "$db"; then fail "an edited migration was accepted"; fi
grep -q "$PROBE_FILE (version $PROBE_VER)" "$tmpdir/out" || fail "the edit refusal does not name the migration: $(cat "$tmpdir/out")"
[ "$(wc -l < "$tmpdir/out")" = 1 ] || fail "the refusal is not one line"
# A recorded version with no file.
if boot --db "$db"; then fail "a recorded version with no file was accepted"; fi
grep -q "version $PROBE_VER " "$tmpdir/out" || fail "the missing-file refusal does not name the version: $(cat "$tmpdir/out")"
# A failing migration names its file and rolls back.
cat > "$migs/$PROBE_FILE" << 'SQL'
CREATE TABLE factory.probe (id int PRIMARY KEY, note text);
SQL
printf 'CREATE TABLE factory.half (a int);\nSELECT * FROM factory.nope;\n' > "$migs/$BROKEN_FILE"
if FACTORY_DB_MIGRATIONS_DIR=$migs boot --db "$db"; then fail "a broken migration was accepted"; fi
grep -q "$BROKEN_FILE" "$tmpdir/out" || fail "the broken migration is not named: $(cat "$tmpdir/out")"
[ "$(q "$db" "SELECT count(*) FROM pg_class WHERE relname = 'half'")" = 0 ] || fail "a failed migration was not rolled back"
# A mistyped migration file name.
echo 'SELECT 1;' > "$migs/oops.sql"
if FACTORY_DB_MIGRATIONS_DIR=$migs boot --db "$db"; then fail "a badly named migration was accepted"; fi
grep -q 'oops.sql' "$tmpdir/out" || fail "the bad file name is not reported"

# --- an upgrade: a database at 0001 gets 0002 and keeps its rows ---------------------
old_migs="$tmpdir/old-migs"
mkdir "$old_migs"
cp "$ROOT"/images/base/factory-db/migrations/0001_*.sql "$old_migs/"
new_name
udb=$new_db
FACTORY_DB_MIGRATIONS_DIR=$old_migs boot --db "$udb" || fail "upgrade: run with only 0001 failed: $(cat "$tmpdir/out")"
grep -q 'schema version 1$' "$tmpdir/out" || fail "upgrade: not at version 1 first: $(cat "$tmpdir/out")"
as "$udb" "${udb}_writer" "INSERT INTO factory.event_store (envelope, event_id, ts, type, type_version, repo, device, actor, issue, device_seq, data)
    VALUES (1, gen_random_uuid(), now(), 'gate_run', 1, 'o/r', 'd', 'loop', 815, 1,
    '{\"life\": \"tn0brb\", \"seq\": 6, \"head\": null, \"result\": \"pass\", \"wait_ms\": 184000, \"run_ms\": 412000, \"concurrency\": 1, \"queued_behind\": 2, \"started_at\": \"2026-10-16T15:49:06.252Z\"}')" > /dev/null \
  || fail "upgrade: cannot insert the gate_run event"
boot --db "$udb" || fail "upgrade: run with the shipped migrations failed: $(cat "$tmpdir/out")"
grep -q "schema version $EXPECTED\$" "$tmpdir/out" || fail "upgrade: unexpected summary: $(cat "$tmpdir/out")"
[ "$(q "$udb" "SELECT string_agg(version::text, ',' ORDER BY version) FROM factory.schema_migrations")" = "$ALL_VERSIONS" ] \
  || fail "upgrade: schema_migrations does not hold versions $ALL_VERSIONS"
[ "$(as "$udb" "${udb}_reader" "SELECT result, wait_ms, run_ms, concurrency, queued_behind, to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS') FROM factory.event_log WHERE type = 'gate_run'")" \
  = "pass|184000|412000|1|2|2026-10-16T15:49:06.252" ] || fail "upgrade: the reader does not see the gate_run columns"
snapshot "$udb" > "$tmpdir/usnap1" || fail "upgrade snapshot 1 failed"
boot --db "$udb" || fail "upgrade: third run failed"
snapshot "$udb" > "$tmpdir/usnap2" || fail "upgrade snapshot 2 failed"
cmp -s "$tmpdir/usnap1" "$tmpdir/usnap2" || fail "upgrade: a further run changed the database: $(diff "$tmpdir/usnap1" "$tmpdir/usnap2")"
db=$main_db

# --- secrets: not in output, not in argv ------------------------------------------
new_name
sdb=$new_db
WPW=wsecret-$$-pw
RPW=rsecret-$$-pw
# Marks the bootstrap's own process tree (it runs no `env -i`, so every child inherits it).
# Never exported in this shell: only the bootstrap and the decoy carry it.
PROBE=argv-$$-$(date +%s%N)
(
  FACTORY_ARGV_PROBE=$PROBE FACTORY_DB_WRITER_PASSWORD=$WPW FACTORY_DB_READER_PASSWORD=$RPW FACTORY_DB_ADMIN_URL=$ADMIN \
    bash "$BOOTSTRAP" --db "$sdb" > "$tmpdir/sout" 2>&1
) &
bpid=$!
# sample_argv PID FILE: the command line of every process marked with $PROBE, until PID
# exits. Other suites run at the same time and put the same admin URL on their own psql
# command lines, so unmarked processes must not be sampled. A process that exits between
# listing and reading is ignored.
sample_argv() {
  : > "$2"
  while kill -0 "$1" 2> /dev/null; do
    grep -lzF -- "FACTORY_ARGV_PROBE=$PROBE" /proc/[0-9]*/environ 2> /dev/null \
      | sed 's#environ$#cmdline#' \
      | while IFS= read -r f; do cat "$f" 2> /dev/null || :; done \
      | tr '\0' ' ' >> "$2"
  done
}
sample_argv "$bpid" "$tmpdir/argv"
wait "$bpid" || fail "run with passwords failed: $(cat "$tmpdir/sout")"
# The sampler really sees an argv: a decoy process carrying a secret is found.
# An unmarked outsider, like another suite's psql, carries the admin URL meanwhile.
FACTORY_ARGV_PROBE=$PROBE sh -c 'sleep 2; :' "decoy-$WPW" &
dpid=$!
sh -c 'sleep 3; :' "outsider-$WPW" "$ADMIN" &
opid=$!
sample_argv "$dpid" "$tmpdir/decoy"
grep -qF -- "decoy-$WPW" "$tmpdir/decoy" || fail "the argv sampler does not see a process's arguments"
grep -qF -- "outsider-$WPW" "$tmpdir/decoy" && fail "the argv sampler sees processes outside the bootstrap"
wait "$opid" || :
pass_part=$(printf '%s' "$ADMIN" | sed -n 's#^[a-z]*://[^:@/]*:\([^@/]*\)@.*#\1#p')
# The bare admin password may be a common word (CI uses "postgres", also a database
# name in argv), so it is matched in the credential position ":pw@" only.
for secret in "$WPW" "$RPW" "$ADMIN" ":$pass_part@"; do
  [ "$secret" != ":@" ] || continue
  grep -qF -- "$secret" "$tmpdir/sout" && fail "a secret reached the output"
  grep -qF -- "$secret" "$tmpdir/argv" && fail "a secret reached a process's argv"
done
[ "$(q postgres "SELECT count(*) FROM pg_authid WHERE rolname IN ('${sdb}_writer', '${sdb}_reader') AND rolpassword IS NOT NULL")" = 2 ] \
  || fail "the passwords were not set"
# Without the variables, a later run leaves them alone.
boot --db "$sdb" || fail "run without passwords failed"
[ "$(q postgres "SELECT count(*) FROM pg_authid WHERE rolname IN ('${sdb}_writer', '${sdb}_reader') AND rolpassword IS NOT NULL")" = 2 ] \
  || fail "a run without passwords cleared them"
# A failure does not leak the URL either.
new_name
if FACTORY_DB_ADMIN_URL="${ADMIN%%@*}:badpw@127.0.0.1:1/postgres" bash "$BOOTSTRAP" --db "$new_db" > "$tmpdir/out" 2>&1; then
  fail "a broken URL was accepted"
fi
grep -q 'badpw' "$tmpdir/out" && fail "the broken URL's password reached the error output"
grep -qF -- "$ADMIN" "$tmpdir/out" && fail "the URL reached the error output"

# --- two concurrent runs serialise ---------------------------------------------------
new_name
cdb=$new_db
boot_to() { FACTORY_DB_ADMIN_URL=$ADMIN bash "$BOOTSTRAP" --db "$cdb" > "$1" 2>&1; }
boot_to "$tmpdir/c1" &
p1=$!
boot_to "$tmpdir/c2" &
p2=$!
wait "$p1" || fail "concurrent run 1 failed: $(cat "$tmpdir/c1")"
wait "$p2" || fail "concurrent run 2 failed: $(cat "$tmpdir/c2")"
[ "$(q "$cdb" "SELECT count(*) || '/' || count(DISTINCT version) FROM factory.schema_migrations")" = "$EXPECTED/$EXPECTED" ] || fail "concurrent runs recorded a version twice"

# --- the test helpers --------------------------------------------------------------
# A leftover database is reported, with its roles, and a clean one is not.
ldb=$(factory_test_db_new) || fail "factory_test_db_new failed"
names="$names $ldb"
if test_pg_check 2> "$tmpdir/iso"; then fail "test_pg_check passed with a leftover database"; fi
grep -qx "FAIL test isolation: database $ldb" "$tmpdir/iso" || fail "no isolation FAIL line for the database: $(cat "$tmpdir/iso")"
grep -qx "FAIL test isolation: role ${ldb}_writer" "$tmpdir/iso" || fail "no isolation FAIL line for the role"
factory_test_db_drop "$ldb"
test_pg_check 2> "$tmpdir/iso" || :
grep -q "$ldb" "$tmpdir/iso" && fail "the dropped database is still reported: $(cat "$tmpdir/iso")"
[ "$(q postgres "SELECT count(*) FROM pg_roles WHERE rolname LIKE '${ldb}\\_%'")" = 0 ] || fail "factory_test_db_drop left roles"

# No server and no binaries: a note in the summary, or a failure under TEST_REQUIRE_POSTGRES=1.
note=$(unset FACTORY_TEST_PG_ADMIN_URL TEST_REQUIRE_POSTGRES; TEST_PG_BIN_ROOT=$tmpdir/none; test_pg_setup && printf '%s' "$TEST_PG_NOTE") \
  || fail "the skip path failed"
case "$note" in *"database tests skipped"*) ;; *) fail "no skip note: '$note'" ;; esac
if (unset FACTORY_TEST_PG_ADMIN_URL; TEST_PG_BIN_ROOT=$tmpdir/none TEST_REQUIRE_POSTGRES=1; test_pg_setup) 2> "$tmpdir/req"; then
  fail "TEST_REQUIRE_POSTGRES=1 did not fail without a server"
fi
grep -q 'TEST_REQUIRE_POSTGRES' "$tmpdir/req" || fail "the required-server failure is not explained"

# A private cluster starts on a socket only, answers, and is removed.
if ls /usr/lib/postgresql/*/bin/initdb > /dev/null 2>&1; then
  (
    unset FACTORY_TEST_PG_ADMIN_URL
    test_pg_setup || exit 1
    root=$TEST_PG_ROOT
    [ -n "$root" ] && [ -d "$root" ] || exit 2
    case "$FACTORY_TEST_PG_ADMIN_URL" in *"host=$root"*) ;; *) exit 3 ;; esac
    [ "$(psql -X -q -At "$FACTORY_TEST_PG_ADMIN_URL" -c 'SHOW listen_addresses')" = "" ] || exit 4
    test_pg_clean
    [ ! -e "$root" ] || exit 5
    ! psql -X -q "$FACTORY_TEST_PG_ADMIN_URL" -c 'SELECT 1' > /dev/null 2>&1 || exit 6
  ) || fail "the private cluster lifecycle failed (step $?)"
fi
echo "factory-db-bootstrap tests passed"
