# shellcheck shell=bash
#
# Sourced by dev-init and dev-doctor. The persistence contract's directory
# list lives in one place, the image's PERSIST_DIRS build ARG, shipped as
# /usr/local/share/dev-system/persist-dirs (one path per line); the dev.cbundy.persist label
# and the build-time install come from the same ARG (cbundy/dev-system#269).

PERSIST_LIST=${DEV_PERSIST_LIST:-/usr/local/share/dev-system/persist-dirs}

# Prints every contract directory, one per line, honouring the env var that
# relocates a tool's directory.
persist_dirs() {
  local d
  [ -r "$PERSIST_LIST" ] || return 0
  while IFS= read -r d || [ -n "$d" ]; do
    case "$d" in
      /persist/claude) d=${CLAUDE_CONFIG_DIR:-$d} ;;
      /persist/codex) d=${CODEX_HOME:-$d} ;;
      /persist/gh) d=${GH_CONFIG_DIR:-$d} ;;
      /persist/no-mistakes) d=${NM_HOME:-$d} ;;
      /persist/agentsview) d=${AGENTSVIEW_DATA_DIR:-$d} ;;
      /persist/events) d=${CALLUM_EVENTS_DIR:-$d} ;;
    esac
    [ -n "$d" ] && printf '%s\n' "$d"
  done < "$PERSIST_LIST"
}

# The fix to show when a directory cannot be created or written.
persist_fix_cmd() { printf 'sudo install -d -o 1000 -g 1000 -m 0700 %s' "$1"; }
