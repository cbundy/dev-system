#!/bin/sh
#
# Tests for factory-db-bootstrap's fourth role, its URL files and --migrate
# (cbundy/dev-system#884) against a real PostgreSQL: the private cluster or the CI service
# that scripts/test.sh sets up (scripts/test-pg.sh). The private cluster trusts every
# connection, so a password is proven only on CI's server; here a URL proves its user, host
# and database. Every database it makes is dropped on exit.
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
  echo "factory-db-bootstrap-secrets tests skipped: no PostgreSQL server"
  exit 0
fi
ADMIN=$FACTORY_TEST_PG_ADMIN_URL
export FACTORY_DB_ADMIN_URL="$ADMIN"
unset FACTORY_DB_WRITER_PASSWORD FACTORY_DB_READER_PASSWORD FACTORY_DB_MIGRATOR_PASSWORD FACTORY_DB_MIGRATOR_URL \
  FACTORY_DB_MIGRATIONS_DIR DEV_WORKSPACE_SECRETS_DIR
ME="$(id -u):$(id -g)"
export FACTORY_DB_SECRET_OWNER="$ME"

url_for() {
  case "$ADMIN" in
    *\?*) printf '%s&dbname=%s\n' "$ADMIN" "$1" ;;
    *) printf '%s?dbname=%s\n' "$ADMIN" "$1" ;;
  esac
}
# q DB SQL: runs SQL in DB as the admin, prints the rows unaligned.
q() { psql -X -q -At -v ON_ERROR_STOP=1 "$(url_for "$1")" -c "$2"; }
new_name() {
  new_db="factory_test_$$_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  names="$names $new_db"
}
# boot ARGS...: the real command; output in $tmpdir/out, status returned.
boot() { bash "$BOOTSTRAP" "$@" > "$tmpdir/out" 2>&1; }
# who FILE: what a URL file connects as: user|database, through the image's run_psql.
who() {
  bash -c '. "$1/images/base/agentsview.sh"; run_psql "$(head -n 1 "$2")" -At <<< "SELECT current_user || chr(124) || current_database()"' \
    _ "$ROOT" "$1" 2> /dev/null
}
# st FILE: inode.mtime mode owner
st() { stat -c '%i.%Y %a %u:%g' "$1"; }

EXPECTED=$(bash -c ". '$ROOT/images/base/factory-db.sh'; factory_db_expected_version")
[ "$EXPECTED" -ge 2 ] || fail "expected version should be at least 2, got '$EXPECTED'"

# --- a fresh server, two directories ----------------------------------------------------
new_name
db=$new_db
sd="$tmpdir/secrets"
md="$tmpdir/migrator"
mkdir "$sd"   # the migrator directory is created by the run
boot --db "$db" --secrets-dir "$sd" --migrator-dir "$md" || fail "first run failed: $(cat "$tmpdir/out")"
[ "$(wc -l < "$tmpdir/out")" = 1 ] || fail "expected one summary line: $(cat "$tmpdir/out")"
grep -qF "database $db ready (roles ${db}_owner, ${db}_writer, ${db}_reader, ${db}_migrator; created: ${db}_owner, ${db}_writer, ${db}_reader, ${db}_migrator; new passwords: ${db}_writer, ${db}_reader, ${db}_migrator; wrote: $sd/factory-db-writer-url, $sd/factory-db-reader-url, $md/factory-db-migrator-url), schema version $EXPECTED" "$tmpdir/out" \
  || fail "unexpected summary: $(cat "$tmpdir/out")"
for r in writer reader migrator; do
  [ "$(q postgres "SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname = '${db}_$r'")" = t ] \
    || fail "$r attributes"
  [ "$(q postgres "SELECT has_database_privilege('${db}_$r', '$db', 'CONNECT')")" = t ] || fail "$r cannot connect"
done
[ "$(q postgres "SELECT rolcanlogin FROM pg_roles WHERE rolname = '${db}_owner'")" = f ] || fail "the owner can log in"
[ "$(q postgres "SELECT string_agg(pg_get_userbyid(roleid) || ':' || set_option || ':' || inherit_option, ',') FROM pg_auth_members WHERE pg_get_userbyid(member) = '${db}_migrator'")" = "${db}_owner:true:false" ] \
  || fail "the migrator's memberships are not exactly owner with SET and no INHERIT"
[ "$(q "$db" "SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'factory'::regnamespace AND c.relkind IN ('r', 'v', 'S') AND (has_table_privilege('${db}_migrator', c.oid, 'SELECT') OR has_table_privilege('${db}_migrator', c.oid, 'INSERT'))")" = 0 ] \
  || fail "the migrator holds a grant on a factory object"
[ "$(q "$db" "SELECT has_schema_privilege('${db}_migrator', 'factory', 'USAGE')")" = f ] || fail "the migrator can use schema factory"
[ "$(q "$db" "SELECT max(version) FROM factory.schema_migrations")" = "$EXPECTED" ] || fail "not at the latest schema"
[ "$(st "$md" | cut -d' ' -f2)" = 700 ] || fail "the created directory is not mode 700: $(st "$md")"
for pair in "$sd/factory-db-writer-url:${db}_writer" "$sd/factory-db-reader-url:${db}_reader" "$md/factory-db-migrator-url:${db}_migrator"; do
  f=${pair%%:*}
  [ "$(st "$f" | cut -d' ' -f2-)" = "600 $ME" ] || fail "$f is not mode 600 owned by $ME: $(st "$f")"
  [ "$(wc -l < "$f")" = 1 ] || fail "$f is not one line"
  [ "$(who "$f")" = "${pair#*:}|$db" ] || fail "$f does not connect as ${pair#*:} to $db: '$(who "$f")'"
  case "$(cat "$f")" in "postgresql://${pair#*:}:"*) ;; *) fail "$f has an unexpected shape" ;; esac
  [ "$(sed 's/.*://; s/@.*//' "$f" | wc -c)" = 65 ] || fail "$f: the password is not 64 hex characters"
done
[ -z "$(find "$sd" "$md" -name '.*' -type f)" ] || fail "a temp file was left behind"

# dev-doctor accepts the generated files.
for role in writer reader; do
  out=$(DEV_SECRETS_DIR=$sd DEV_WORKSPACE_SECRETS_DIR='' bash -c '. "$1"; factory_db_check "$2"' _ "$ROOT/images/base/factory-db.sh" "$role" 2>&1) \
    || fail "dev-doctor $role: $out"
  case "$out" in OK*) ;; *) fail "dev-doctor $role did not say OK: $out" ;; esac
done

# --- a second run changes nothing ---------------------------------------------------------
before=$(for f in "$sd"/* "$md"/*; do st "$f"; done)
sleep 1
boot --db "$db" --secrets-dir "$sd" --migrator-dir "$md" || fail "second run failed: $(cat "$tmpdir/out")"
grep -qF "created: none; new passwords: none; wrote: none), schema version $EXPECTED" "$tmpdir/out" || fail "second run: $(cat "$tmpdir/out")"
[ "$before" = "$(for f in "$sd"/* "$md"/*; do st "$f"; done)" ] || fail "the second run rewrote a file"

# --- a missing file rotates only that role --------------------------------------------------
wbefore=$(st "$sd/factory-db-writer-url")
mbefore=$(st "$md/factory-db-migrator-url")
oldr=$(cat "$sd/factory-db-reader-url")
rm "$sd/factory-db-reader-url"
sleep 1
boot --db "$db" --secrets-dir "$sd" --migrator-dir "$md" || fail "rotation run failed: $(cat "$tmpdir/out")"
grep -qF "created: none; new passwords: ${db}_reader; wrote: $sd/factory-db-reader-url)" "$tmpdir/out" || fail "rotation: $(cat "$tmpdir/out")"
[ "$wbefore" = "$(st "$sd/factory-db-writer-url")" ] || fail "the writer file was rewritten"
[ "$mbefore" = "$(st "$md/factory-db-migrator-url")" ] || fail "the migrator file was rewritten"
[ "$(cat "$sd/factory-db-reader-url")" != "$oldr" ] || fail "the reader URL did not change"
[ "$(who "$sd/factory-db-reader-url")" = "${db}_reader|$db" ] || fail "the new reader URL does not connect"
# A superuser admin also rotates a role that has no password.
oldw=$(cat "$sd/factory-db-writer-url")
q postgres "ALTER ROLE \"${db}_writer\" PASSWORD NULL" > /dev/null
boot --db "$db" --secrets-dir "$sd" --migrator-dir "$md" || fail "no-password run failed: $(cat "$tmpdir/out")"
grep -qF "new passwords: ${db}_writer; wrote: $sd/factory-db-writer-url)" "$tmpdir/out" || fail "no-password: $(cat "$tmpdir/out")"
[ "$(cat "$sd/factory-db-writer-url")" != "$oldw" ] || fail "the writer URL did not change"
# Without a directory nothing is generated or written.
boot --db "$db" || fail "run without directories failed: $(cat "$tmpdir/out")"
grep -qF "created: none; new passwords: none; wrote: none)" "$tmpdir/out" || fail "no directories: $(cat "$tmpdir/out")"

# --- an explicit password wins, and is encoded ---------------------------------------------
EPW='p@ss:w/rd%?#&x'
FACTORY_DB_WRITER_PASSWORD=$EPW boot --db "$db" --secrets-dir "$sd" --migrator-dir "$md" || fail "explicit run failed: $(cat "$tmpdir/out")"
grep -qF "new passwords: ${db}_writer; wrote: $sd/factory-db-writer-url)" "$tmpdir/out" || fail "explicit: $(cat "$tmpdir/out")"
grep -qF -- "$EPW" "$tmpdir/out" && fail "the explicit password reached the output"
grep -qF 'p%40ss%3Aw%2Frd%25%3F%23%26x' "$sd/factory-db-writer-url" || fail "the explicit password is not percent-encoded in the file"
[ "$(who "$sd/factory-db-writer-url")" = "${db}_writer|$db" ] || fail "the explicit-password URL does not connect"
[ "$(wc -l < "$sd/factory-db-writer-url")" = 1 ] || fail "the explicit URL file is not one line"

# --- a socket admin URL and ssl parameters are carried over ----------------------------------
out=$(bash -c '
  admin_url=$1 name=$2
  eval "$(sed -n "/^urlenc() {/,/^}/p; /^role_url() {/,/^}/p" "$3")"
  role_url r1 "a b"
' _ 'postgresql://adm:secret@db.example.com:6543/postgres?sslmode=verify-full&sslrootcert=/ca.pem&options=-c%20x&sslcert=/c.pem&application_name=x&sslsni=0' dbn "$BOOTSTRAP")
[ "$out" = 'postgresql://r1:a%20b@db.example.com:6543/dbn?sslmode=verify-full&sslrootcert=/ca.pem&sslsni=0' ] || fail "URL construction: $out"
out=$(bash -c '
  admin_url=$1 name=$2
  eval "$(sed -n "/^urlenc() {/,/^}/p; /^role_url() {/,/^}/p" "$3")"
  role_url r1 pw
' _ 'postgresql://postgres@/postgres?host=/tmp/pg.X&port=5433' dbn "$BOOTSTRAP")
[ "$out" = 'postgresql://r1:pw@/dbn?host=/tmp/pg.X&port=5433' ] || fail "socket URL construction: $out"

# --- secrets never leak ------------------------------------------------------------------------
new_name
ldb=$new_db
lsd="$tmpdir/lsecrets"
lmd="$tmpdir/lmigrator"
mkdir "$lsd" "$lmd"
PROBE=argv-$$-$(date +%s%N)
(
  FACTORY_ARGV_PROBE=$PROBE bash "$BOOTSTRAP" --db "$ldb" --secrets-dir "$lsd" --migrator-dir "$lmd" > "$tmpdir/lout" 2>&1
) &
bpid=$!
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
wait "$bpid" || fail "run for the leak check failed: $(cat "$tmpdir/lout")"
# The sampler really sees an argv.
FACTORY_ARGV_PROBE=$PROBE sh -c 'sleep 2; :' "decoy-$$" &
dpid=$!
sample_argv "$dpid" "$tmpdir/decoy"
wait "$dpid" || :
grep -qF -- "decoy-$$" "$tmpdir/decoy" || fail "the argv sampler does not see a process's arguments"
for f in "$lsd/factory-db-writer-url" "$lsd/factory-db-reader-url" "$lmd/factory-db-migrator-url"; do
  [ -s "$f" ] || fail "$f was not written"
  pw=$(sed 's/.*://; s/@.*//' "$f")
  [ "${#pw}" = 64 ] || fail "$f: unexpected password length"
  grep -qF -- "$pw" "$tmpdir/lout" && fail "a generated password reached the output"
  grep -qF -- "$pw" "$tmpdir/argv" && fail "a generated password reached a process's argv"
  grep -qF -- "$(cat "$f")" "$tmpdir/lout" && fail "a URL reached the output"
  grep -qF -- "$(cat "$f")" "$tmpdir/argv" && fail "a URL reached a process's argv"
done
admin_pw=$(printf '%s' "$ADMIN" | sed -n 's#^[a-z]*://[^:@/]*:\([^@/]*\)@.*#\1#p')
if [ -n "$admin_pw" ]; then
  grep -qF -- ":$admin_pw@" "$tmpdir/argv" && fail "the admin password reached argv"
fi
grep -qF -- "$ADMIN" "$tmpdir/argv" && fail "the admin URL reached argv"

# --- the owner check: before any connection -------------------------------------------------
if [ "$(id -u)" != 0 ]; then
  new_name
  odb=$new_db
  if FACTORY_DB_SECRET_OWNER=4242:4242 boot --db "$odb" --secrets-dir "$tmpdir/o1"; then fail "a foreign owner was accepted"; fi
  grep -q -- '--user root' "$tmpdir/out" || fail "no --user root hint: $(cat "$tmpdir/out")"
  [ "$(wc -l < "$tmpdir/out")" = 1 ] || fail "the owner refusal is not one line"
  [ "$(q postgres "SELECT count(*) FROM pg_database WHERE datname = '$odb'")" = 0 ] || fail "a database was made before the check"
  [ "$(q postgres "SELECT count(*) FROM pg_roles WHERE rolname LIKE '${odb}\\_%'")" = 0 ] || fail "roles were made before the check"
  mkdir "$tmpdir/ro"
  chmod 500 "$tmpdir/ro"
  if boot --db "$odb" --secrets-dir "$tmpdir/ro"; then fail "an unwritable directory was accepted"; fi
  grep -q -- '--user root' "$tmpdir/out" || fail "unwritable directory: no hint: $(cat "$tmpdir/out")"
  [ "$(q postgres "SELECT count(*) FROM pg_database WHERE datname = '$odb'")" = 0 ] || fail "a database was made before the directory check"
  chmod 700 "$tmpdir/ro"
fi

# --- adoption --------------------------------------------------------------------------------
new_name
adb=$new_db
q postgres "
  CREATE ROLE \"${adb}_owner\" NOLOGIN;
  CREATE ROLE \"${adb}_migrator\" LOGIN CREATEDB PASSWORD 'handset';
  GRANT \"${adb}_owner\" TO \"${adb}_migrator\" WITH ADMIN TRUE, INHERIT TRUE, SET TRUE;
  GRANT pg_read_all_data TO \"${adb}_migrator\";
  CREATE ROLE \"${adb}_writer\" LOGIN REPLICATION BYPASSRLS PASSWORD 'handset';
" > /dev/null
pwhash() { q postgres "SELECT md5(rolpassword) FROM pg_authid WHERE rolname = '${adb}_$1'"; }
m_pw=$(pwhash migrator)
w_pw=$(pwhash writer)
asd="$tmpdir/asec"
amd="$tmpdir/amig"
mkdir "$asd" "$amd"
printf 'dummy-migrator\n' > "$amd/factory-db-migrator-url"
printf 'dummy-writer\n' > "$asd/factory-db-writer-url"
boot --db "$adb" --secrets-dir "$asd" --migrator-dir "$amd" || fail "adoption run failed: $(cat "$tmpdir/out")"
grep -qF "created: ${adb}_reader; new passwords: ${adb}_reader; wrote: $asd/factory-db-reader-url)" "$tmpdir/out" || fail "adoption summary: $(cat "$tmpdir/out")"
[ "$(q postgres "SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname IN ('${adb}_migrator') ")" = t ] || fail "the adopted migrator's attributes are not corrected"
[ "$(q postgres "SELECT NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname = '${adb}_writer'")" = t ] || fail "the adopted writer's attributes are not corrected"
[ "$(q postgres "SELECT string_agg(pg_get_userbyid(roleid) || ':' || admin_option || ':' || set_option || ':' || inherit_option, ',') FROM pg_auth_members WHERE pg_get_userbyid(member) = '${adb}_migrator'")" = "${adb}_owner:false:true:false" ] \
  || fail "the adopted migrator's memberships are wrong"
[ "$m_pw" = "$(pwhash migrator)" ] || fail "an adopted migrator's password changed although its file was there"
[ "$w_pw" = "$(pwhash writer)" ] || fail "an adopted writer's password changed although its file was there"
[ "$(cat "$amd/factory-db-migrator-url")" = dummy-migrator ] || fail "the migrator file was rewritten"
[ "$(cat "$asd/factory-db-writer-url")" = dummy-writer ] || fail "the writer file was rewritten"
# A re-run on correct roles issues no ALTER: it succeeds even for a non-superuser's rules, and changes nothing.
boot --db "$adb" --secrets-dir "$asd" --migrator-dir "$amd" || fail "adoption re-run failed: $(cat "$tmpdir/out")"
grep -qF "created: none; new passwords: none; wrote: none)" "$tmpdir/out" || fail "adoption re-run: $(cat "$tmpdir/out")"

# --- --migrate ---------------------------------------------------------------------------------
old_migs="$tmpdir/old-migs"
mkdir "$old_migs"
cp "$ROOT"/images/base/factory-db/migrations/0001_*.sql "$old_migs/"
new_name
mdb=$new_db
msd="$tmpdir/msec"
mmd="$tmpdir/mmig"
FACTORY_DB_MIGRATIONS_DIR=$old_migs boot --db "$mdb" --secrets-dir "$msd" --migrator-dir "$mmd" || fail "run with only 0001 failed: $(cat "$tmpdir/out")"
grep -q 'schema version 1$' "$tmpdir/out" || fail "not at version 1: $(cat "$tmpdir/out")"
mfile="$mmd/factory-db-migrator-url"
version_now() { q "$mdb" "SELECT string_agg(version::text, ',' ORDER BY version) FROM factory.schema_migrations"; }
[ "$(version_now)" = 1 ] || fail "not at version 1"

# Refusals first: one line each, no change.
refuse() { # refuse PATTERN ARGS...: runs with the environment as set by the caller
  pat=$1
  shift
  if boot "$@"; then fail "accepted: $*"; fi
  [ "$(wc -l < "$tmpdir/out")" = 1 ] || fail "not one line: $(cat "$tmpdir/out")"
  grep -q -- "$pat" "$tmpdir/out" || fail "expected '$pat': $(cat "$tmpdir/out")"
  [ "$(version_now)" = 1 ] || fail "a refused --migrate changed schema_migrations"
}
refuse "connected as '${mdb}_writer'" --db "$mdb" --migrate --migrator-url-file "$msd/factory-db-writer-url"
refuse "connected as '${mdb}_reader'" --db "$mdb" --migrate --migrator-url-file "$msd/factory-db-reader-url"
FACTORY_DB_MIGRATOR_URL=$ADMIN refuse "connected as 'postgres'" --db "$mdb" --migrate
env -u FACTORY_DB_MIGRATOR_URL bash "$BOOTSTRAP" --db "$mdb" --migrate > "$tmpdir/out" 2>&1 && fail "--migrate ran without a migrator URL"
grep -q 'no migrator URL' "$tmpdir/out" || fail "no migrator URL: $(cat "$tmpdir/out")"
[ "$(version_now)" = 1 ] || fail "the admin URL was used as a fallback"
refuse -- '--secrets-dir is not allowed' --db "$mdb" --migrate --migrator-url-file "$mfile" --secrets-dir "$msd"
refuse -- '--migrator-dir is not allowed' --db "$mdb" --migrate --migrator-url-file "$mfile" --migrator-dir "$mmd"
refuse -- '--admin-url-file is not allowed' --db "$mdb" --migrate --migrator-url-file "$mfile" --admin-url-file "$mfile"
refuse -- 'needs --migrate' --db "$mdb" --migrator-url-file "$mfile"
# An owner-ish URL: the migrator's own URL but a role that can create roles is refused.
q postgres "ALTER ROLE \"${mdb}_migrator\" CREATEDB" > /dev/null
refuse "must be ${mdb}_migrator without superuser, CREATEROLE or CREATEDB" --db "$mdb" --migrate --migrator-url-file "$mfile"
q postgres "ALTER ROLE \"${mdb}_migrator\" NOCREATEDB" > /dev/null

# The upgrade, as the migrator only.
boot --db "$mdb" --migrate --migrator-url-file "$mfile" || fail "--migrate failed: $(cat "$tmpdir/out")"
[ "$(cat "$tmpdir/out")" = "factory-db-bootstrap: database $mdb migrated as ${mdb}_migrator from schema version 1 to $EXPECTED" ] \
  || fail "unexpected --migrate line: $(cat "$tmpdir/out")"
[ "$(version_now)" = "$(seq -s, 1 "$EXPECTED")" ] || fail "not all versions are recorded"
q "$mdb" "SET ROLE \"${mdb}_writer\"; INSERT INTO factory.workers (device, state, last_seen) VALUES ('d1', 'idle', now())" > /dev/null \
  || fail "the writer cannot write after --migrate"
q "$mdb" "SET ROLE \"${mdb}_reader\"; SELECT count(*) FROM factory.event_log" > /dev/null || fail "the reader cannot read after --migrate"
[ "$(q "$mdb" "SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'factory'::regnamespace AND c.relkind IN ('r', 'v') AND has_table_privilege('${mdb}_migrator', c.oid, 'SELECT')")" = 0 ] \
  || fail "the migrator holds a grant after --migrate"
# FACTORY_DB_MIGRATOR_URL works the same, and a second run is from N to N.
FACTORY_DB_MIGRATOR_URL=$(cat "$mfile") boot --db "$mdb" --migrate || fail "--migrate with the variable failed: $(cat "$tmpdir/out")"
grep -qF "from schema version $EXPECTED to $EXPECTED" "$tmpdir/out" || fail "second --migrate: $(cat "$tmpdir/out")"

# A database without the factory schema is refused, and nothing is created.
new_name
bdb=$new_db
bsd="$tmpdir/bsec"
bmd="$tmpdir/bmig"
boot --db "$bdb" --secrets-dir "$bsd" --migrator-dir "$bmd" || fail "run for the empty database failed"
q "$bdb" "DROP SCHEMA factory CASCADE" > /dev/null 2>&1
if boot --db "$bdb" --migrate --migrator-url-file "$bmd/factory-db-migrator-url"; then fail "--migrate accepted a database without the factory schema"; fi
grep -q 'schema_migrations does not exist' "$tmpdir/out" || fail "no schema_migrations refusal: $(cat "$tmpdir/out")"
[ "$(wc -l < "$tmpdir/out")" = 1 ] || fail "the refusal is not one line"
[ "$(q "$bdb" "SELECT count(*) FROM pg_namespace WHERE nspname = 'factory'")" = 0 ] || fail "--migrate created the schema"

# Two --migrate runs at once: each version once, one from 1, one from N.
new_name
cdb=$new_db
csd="$tmpdir/csec"
cmd="$tmpdir/cmig"
FACTORY_DB_MIGRATIONS_DIR=$old_migs boot --db "$cdb" --secrets-dir "$csd" --migrator-dir "$cmd" || fail "run for the concurrent check failed"
bash "$BOOTSTRAP" --db "$cdb" --migrate --migrator-url-file "$cmd/factory-db-migrator-url" > "$tmpdir/c1" 2>&1 &
p1=$!
bash "$BOOTSTRAP" --db "$cdb" --migrate --migrator-url-file "$cmd/factory-db-migrator-url" > "$tmpdir/c2" 2>&1 &
p2=$!
wait "$p1" || fail "concurrent --migrate 1 failed: $(cat "$tmpdir/c1")"
wait "$p2" || fail "concurrent --migrate 2 failed: $(cat "$tmpdir/c2")"
[ "$(q "$cdb" "SELECT count(*) || '/' || count(DISTINCT version) FROM factory.schema_migrations")" = "$EXPECTED/$EXPECTED" ] || fail "a version was recorded twice"
froms=$(cat "$tmpdir/c1" "$tmpdir/c2" | sed 's/.*from schema version //' | sort | tr '\n' ' ')
[ "$froms" = "$(printf '%s\n%s\n' "1 to $EXPECTED" "$EXPECTED to $EXPECTED" | sort | tr '\n' ' ')" ] || fail "unexpected from/to pair: '$froms'"

# --- the helpers know the fourth role -------------------------------------------------------
tdb=$(factory_test_db_new) || fail "factory_test_db_new failed"
names="$names $tdb"
factory_test_db_drop "$tdb"
[ "$(q postgres "SELECT count(*) FROM pg_roles WHERE rolname LIKE '${tdb}\\_%'")" = 0 ] || fail "factory_test_db_drop left a role"

# --help describes the new surface.
for word in --secrets-dir --migrator-dir --migrate --migrator-url-file FACTORY_DB_MIGRATOR_PASSWORD FACTORY_DB_SECRET_OWNER "password rule" NAME_migrator; do
  bash "$BOOTSTRAP" --help | grep -q -- "$word" || fail "--help does not mention $word"
done
echo "factory-db-bootstrap-secrets tests passed"
