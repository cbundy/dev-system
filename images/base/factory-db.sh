# shellcheck shell=bash
#
# factory-db.sh: per-role connection secrets for the factory database and the health check
# dev-doctor runs on them (cbundy/dev-system#647). Sourced, not run. Needs agentsview.sh
# (run_psql, mask_secrets), which it sources from beside itself.
#
# Each role has its own secret, separate from agentsview-pg-url: the writer URL arrives as
# FACTORY_DB_WRITER_URL in the environment (wins) or the file factory-db-writer-url in
# DEV_SECRETS_DIR (/run/secrets/dev-system), the reader URL likewise as FACTORY_DB_READER_URL or
# factory-db-reader-url. A workspace can use another database: a file of the same name in
# DEV_WORKSPACE_SECRETS_DIR (/run/secrets/dev-system-workspace) wins over the shared one, even when
# it is empty or unreadable. Neither ever falls back to AGENTSVIEW_PG_URL, and a file's value is never
# exported. The procedure is in docs/factory-db.md.

_FACTORY_DB_SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=agentsview.sh
. "$_FACTORY_DB_SELF_DIR/agentsview.sh"

# factory_db_url_shared_file ROLE / factory_db_url_workspace_file ROLE: the file's path in the
# shared folder and in the workspace's own folder (ROLE is writer or reader).
factory_db_url_shared_file() {
  echo "${DEV_SECRETS_DIR:-/run/secrets/dev-system}/factory-db-$1-url"
}
factory_db_url_workspace_file() {
  echo "${DEV_WORKSPACE_SECRETS_DIR:-/run/secrets/dev-system-workspace}/factory-db-$1-url"
}

# factory_db_url_file ROLE: the secret file in use: the workspace file when it exists, otherwise
# the shared one.
factory_db_url_file() {
  local ws
  ws=$(factory_db_url_workspace_file "$1")
  if [ -e "$ws" ]; then echo "$ws"; else factory_db_url_shared_file "$1"; fi
}

# factory_db_url_var ROLE: the environment variable's name.
factory_db_url_var() {
  case "$1" in
    writer) echo FACTORY_DB_WRITER_URL ;;
    reader) echo FACTORY_DB_READER_URL ;;
    *) return 1 ;;
  esac
}

# factory_db_url ROLE: prints the URL (surrounding whitespace trimmed) and returns 0. Returns 1
# when none is configured and 2 when the file exists but is unreadable or empty. Same contract as
# agentsview_pg_url.
factory_db_url() {
  local var file url
  var=$(factory_db_url_var "$1") || return 1
  if [ -n "${!var:-}" ]; then
    printf '%s\n' "${!var}"
    return 0
  fi
  file=$(factory_db_url_file "$1")
  [ -e "$file" ] || return 1
  url=$(cat -- "$file" 2>/dev/null) || return 2
  url="${url#"${url%%[![:space:]]*}"}"
  url="${url%"${url##*[![:space:]]}"}"
  [ -n "$url" ] || return 2
  printf '%s\n' "$url"
}

# factory_db_migrations_dir: the shipped migrations, in factory-db-bootstrap's lookup order.
factory_db_migrations_dir() {
  if [ -n "${FACTORY_DB_MIGRATIONS_DIR:-}" ]; then
    echo "$FACTORY_DB_MIGRATIONS_DIR"
  elif [ -d "$_FACTORY_DB_SELF_DIR/factory-db/migrations" ]; then
    echo "$_FACTORY_DB_SELF_DIR/factory-db/migrations"
  else
    echo "${DEV_SYSTEM_SHARE:-/usr/local/share/dev-system}/factory-db/migrations"
  fi
}

# factory_db_expected_version: prints the highest NNNN among the shipped migrations. Returns 1
# when there is none.
factory_db_expected_version() {
  local dir f base best=''
  dir=$(factory_db_migrations_dir)
  [ -d "$dir" ] || return 1
  for f in "$dir"/[0-9][0-9][0-9][0-9]_*.sql; do
    [ -f "$f" ] || continue
    base=${f##*/}
    base=$((10#${base%%_*}))
    if [ -z "$best" ] || [ "$base" -gt "$best" ]; then best=$base; fi
  done
  [ -n "$best" ] || return 1
  printf '%s\n' "$best"
}

# _factory_db_probe URL: one bounded psql run. Prints, unaligned, a line "db|user|can_create|has_table"
# and, when factory.schema_migrations exists, a line with its highest version. The URL travels in
# the environment, not on a command line.
_factory_db_probe() {
  (
    export -f run_psql
    # shellcheck disable=SC2016,SC2031 # the inner shell expands the variable; this shell's value is the default
    FACTORY_DB_PROBE_URL=$1 PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-5}" \
      timeout "${FACTORY_DB_PROBE_TIMEOUT:-20}" bash -c 'run_psql "$FACTORY_DB_PROBE_URL" -At' 2>&1 <<'SQL'
SELECT to_regclass('factory.schema_migrations') IS NOT NULL AS has \gset
SELECT current_database(), current_user,
       EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'factory' AND has_schema_privilege(current_user, oid, 'CREATE')),
       :'has';
\if :has
SELECT coalesce(max(version), 0) FROM factory.schema_migrations;
\endif
SQL
  )
}

# factory_db_check ROLE: checks one role's secret and the database behind it. Prints the result
# as "OK <message>", "WARN <message>" or "FAIL <message>", then a "fix: <hint>" line for WARN
# and FAIL. Returns 0 for OK, 1 for WARN and 2 for FAIL. Never prints a URL or a password.
factory_db_check() {
  local role=$1 label="factory database ($1)" file var rc=0 url from out last
  local want db user can has recorded expected
  file=$(factory_db_url_file "$role")
  var=$(factory_db_url_var "$role") || { echo "FAIL $label: unknown role"; echo "fix: use writer or reader"; return 2; }
  url=$(factory_db_url "$role") || rc=$?
  if [ "$rc" -eq 1 ]; then
    echo "WARN $label is not configured: no $(factory_db_url_workspace_file "$role"), no $(factory_db_url_shared_file "$role") and no $var (nothing uses the factory database yet)"
    echo "fix: put the writer URL in $(factory_db_url_shared_file writer) and the reader URL in $(factory_db_url_shared_file reader), or in $(factory_db_url_workspace_file writer) / $(factory_db_url_workspace_file reader) for this workspace only (docs/factory-db.md)"
    return 1
  elif [ "$rc" -ne 0 ]; then
    echo "FAIL $label: $file is empty or not readable by $(id -un) ($(id -u):$(id -g))"
    echo "fix: make it a non-empty file readable by UID 1000 (chown 1000:1000, chmod 0600; Kubernetes: defaultMode 0440 with fsGroup 1000), then run: dev-doctor"
    return 2
  fi
  if [ -n "${!var:-}" ]; then from=$var; else from=$file; fi

  rc=0
  out=$(_factory_db_probe "$url") || rc=$?
  if [ "$rc" -ne 0 ]; then
    last=$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -n 1 | mask_secrets)
    [ "$rc" -ne 124 ] || last="timed out"
    echo "FAIL $label cannot connect (URL from $from): ${last:-psql failed}"
    echo "fix: check the URL (sslmode=require for a non-local host) and that the server is up"
    return 2
  fi
  IFS='|' read -r db user can has <<< "$(printf '%s\n' "$out" | sed -n 1p)"
  recorded=$(printf '%s\n' "$out" | sed -n 2p)
  case "$role" in writer) want=_writer ;; *) want=_reader ;; esac
  if [ "${user%"$want"}" = "$user" ] || [ "$can" = t ]; then
    if [ "${user%"$want"}" = "$user" ]; then
      echo "FAIL $label connected as role $user, expected a role ending in $want (database $db)"
    else
      echo "FAIL $label: role $user can create in schema factory, which a $role must not"
    fi
    echo "fix: use the URL of ${db}$want (docs/factory-db.md), never an admin or owner URL"
    return 2
  fi
  if [ "$has" != t ]; then
    echo "FAIL $label: database $db has no factory.schema_migrations"
    echo "fix: run factory-db-bootstrap --db $db with the admin URL (docs/factory-db.md)"
    return 2
  fi
  expected=$(factory_db_expected_version) || {
    echo "FAIL $label: this image ships no factory migrations in $(factory_db_migrations_dir)"
    echo "fix: pull a fresh ghcr.io/cbundy/dev-system/base"
    return 2
  }
  recorded=${recorded:-0}
  if [ "$recorded" -lt "$expected" ]; then
    echo "FAIL $label: schema version $recorded in database $db is behind this image's $expected"
    echo "fix: run factory-db-bootstrap --db $db with the admin URL to apply migrations $((recorded + 1))..$expected"
    return 2
  elif [ "$recorded" -gt "$expected" ]; then
    echo "FAIL $label: schema version $recorded in database $db is ahead of this image's $expected"
    echo "fix: pull a newer image"
    return 2
  fi
  echo "OK   $label: database $db as $user, schema version $recorded (URL from $from)"
}
