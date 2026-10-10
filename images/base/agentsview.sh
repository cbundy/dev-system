# shellcheck shell=bash
#
# agentsview.sh: shared PostgreSQL URL lookup and secret masking for dev-init,
# dev-doctor, dev-query and the session, event and no-mistakes push loops;
# run_psql is shared by dev-query and the latter two loops
# (cbundy/dev-system#103). Sourced, not run.
#
# The URL is a secret and the image is public, so it only ever arrives at run
# time: as the file agentsview-pg-url in DEV_SECRETS_DIR (a read-only mount:
# the shared dev-system-secrets volume on Docker, a host directory on Coder, a
# Secret on Kubernetes), or as AGENTSVIEW_PG_URL in the environment, which
# wins. The file's value is never exported to the container; callers read it
# when needed (see images/base/README.md, "Each container: the URL, once per host").

# agentsview_pg_url_file: the secret file's path.
agentsview_pg_url_file() {
  echo "${DEV_SECRETS_DIR:-/run/secrets/dev-system}/agentsview-pg-url"
}

nm_push_state_dir() {
  local key
  key=$(node -e 'process.stdout.write(Buffer.from(process.env.DEV_MACHINE_NAME || require("node:os").hostname() || "unknown").toString("hex"))') || return
  printf '%s/device-%s\n' "${NM_PUSH_STATE_DIR:-${AGENTSVIEW_DATA_DIR:-/persist/agentsview}/nm-push}" "$key"
}

# agentsview_pg_url: prints the URL (surrounding whitespace and line ends
# trimmed) and returns 0. Returns 1 when none is configured (no
# AGENTSVIEW_PG_URL, no file: the push is off) and 2 when the file exists but
# is unreadable or empty.
agentsview_pg_url() {
  local file url
  if [ -n "${AGENTSVIEW_PG_URL:-}" ]; then
    printf '%s\n' "$AGENTSVIEW_PG_URL"
    return 0
  fi
  file=$(agentsview_pg_url_file)
  [ -e "$file" ] || return 1
  url=$(cat -- "$file" 2>/dev/null) || return 2
  url="${url#"${url%%[![:space:]]*}"}"
  url="${url%"${url##*[![:space:]]}"}"
  [ -n "$url" ] || return 2
  printf '%s\n' "$url"
}

# The sed -E script behind mask_secrets: hides credentials in PostgreSQL
# connection strings (postgres://user:pass@host -> postgres://***@host,
# password=...). The push loop runs sed with it directly, so a pipeline stage
# is sed itself rather than a second agentsview-push-loop shell.
MASK_SECRETS_SED='s#(://)[^@/[:space:]]*@#\1***@#g; s#([Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]=)[^[:space:]&]*#\1***#g'

# mask_secrets: a filter for anything that might echo the URL back into a log
# or a report.
mask_secrets() {
  sed -u -E "$MASK_SECRETS_SED"
}

# run_psql URL [PSQL_ARG...]: runs psql on stdin with URL's parts (percent-decoded) and its
# ssl* query parameters as PG* variables, so no secret is on the command line.
# With sslmode verify-ca or verify-full and no root cert (URL, environment or
# libpq's ~/.postgresql/root.crt) it trusts the system store, as the Go
# agentsview client does; psql 17 would otherwise fail on such a URL.
# Extra arguments go to psql just before "-f -" (dev-query passes its output
# flags this way). A non-empty DEV_PG_FORCE_OPTIONS in the caller's environment
# is appended to PGOPTIONS after the URL is parsed, so it wins over any
# options= in the URL (dev-query uses it for default_transaction_read_only).
run_psql() (
  local url=$1
  shift
  local rest=${url#*://} query='' db='' userinfo='' hostport kv k v
  case "$rest" in *\?*) query=${rest#*\?}; rest=${rest%%\?*} ;; esac
  case "$rest" in */*) db=${rest#*/}; rest=${rest%%/*} ;; esac
  case "$rest" in *@*) userinfo=${rest%@*}; rest=${rest##*@} ;; esac
  hostport=$rest
  dec() { local e=${1//\\/\\\\}; printf '%b' "${e//%/\\x}"; }
  set_pg() { [ -z "$2" ] || export "$1=$(dec "$2")"; }
  set_pg PGUSER "${userinfo%%:*}"
  case "$userinfo" in *:*) set_pg PGPASSWORD "${userinfo#*:}" ;; esac
  case "$hostport" in
    \[*\]*) set_pg PGHOST "${hostport%%]*}"; PGHOST=${PGHOST#[}; export PGHOST
      v=${hostport##*]}; set_pg PGPORT "${v#:}" ;;
    *:*) set_pg PGHOST "${hostport%%:*}"; set_pg PGPORT "${hostport#*:}" ;;
    *) set_pg PGHOST "$hostport" ;;
  esac
  set_pg PGDATABASE "$db"
  local IFS='&'
  for kv in $query; do
    k=${kv%%=*} v=${kv#*=}
    case "$k" in
      host) set_pg PGHOST "$v" ;;
      hostaddr) set_pg PGHOSTADDR "$v" ;;
      port) set_pg PGPORT "$v" ;;
      user) set_pg PGUSER "$v" ;;
      password) set_pg PGPASSWORD "$v" ;;
      dbname) set_pg PGDATABASE "$v" ;;
      service) set_pg PGSERVICE "$v" ;;
      options) set_pg PGOPTIONS "$v" ;;
      application_name) set_pg PGAPPNAME "$v" ;;
      connect_timeout) set_pg PGCONNECT_TIMEOUT "$v" ;;
      channel_binding) set_pg PGCHANNELBINDING "$v" ;;
      target_session_attrs) set_pg PGTARGETSESSIONATTRS "$v" ;;
      sslmode | sslrootcert | sslcert | sslkey | sslcrl | sslsni | gssencmode | krbsrvname | requirepeer)
        set_pg "PG$(printf '%s' "$k" | tr '[:lower:]' '[:upper:]')" "$v" ;;
      *) echo "ignoring unsupported PostgreSQL URL parameter '$k'" >&2 ;;
    esac
  done
  unset IFS
  case "${PGSSLMODE-}" in
    verify-ca | verify-full)
      [ -n "${PGSSLROOTCERT-}" ] || [ -e "${HOME:-/nonexistent}/.postgresql/root.crt" ] \
        || export PGSSLROOTCERT=system ;;
  esac
  export PGCONNECT_TIMEOUT=${PGCONNECT_TIMEOUT:-10}
  [ -z "${DEV_PG_FORCE_OPTIONS-}" ] || export PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }$DEV_PG_FORCE_OPTIONS"
  exec psql -X -q --single-transaction -v ON_ERROR_STOP=1 "$@" -f -
)
