# shellcheck shell=bash
#
# agentsview.sh: where the agentsview session push finds its PostgreSQL URL,
# shared by dev-init, dev-doctor and agentsview-push-loop
# (cbundy/dev-system#103). Sourced, not run.
#
# The URL is a secret and the image is public, so it only ever arrives at run
# time: as the file agentsview-pg-url in DEV_SECRETS_DIR (a read-only mount:
# the shared dev-system-secrets volume on Docker, a host directory on Coder, a
# Secret on Kubernetes), or as AGENTSVIEW_PG_URL in the environment, which
# wins. The file's value is never exported to the container: only the push
# loop and dev-doctor's own check get it, in their environment.

# agentsview_pg_url_file: the secret file's path.
agentsview_pg_url_file() {
  echo "${DEV_SECRETS_DIR:-/run/secrets/dev-system}/agentsview-pg-url"
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
