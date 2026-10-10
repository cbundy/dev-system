#!/bin/bash
# stale-image.sh - SessionStart and PostToolUseFailure(Bash) hook: tell the agent
# when the dev container is older than the base image the plugin expects
# (dev-system#294).
#
# Why: anything shipped in the image (dev-doctor, dev-init, dev-version) never
# reaches a stale container, so its own warnings cannot say the container is stale.
# The plugin does reach it, so the signal lives here. Reproduced 2026-10-10: on a
# container older than dev-query, `dev-query` fails as "command not found" and the
# agent has no hint that the fix is to rebuild the container.
#
# Modes (first argument):
#   session-start  Add context when a base-image tool or file is missing, or
#                  dev-version reports a STALE base image or image layer. Unpinned
#                  tool drift (claude, codex, ...) is never surfaced.
#   tool-failure   After a Bash call fails with exit 127 and "<tool>: command not
#                  found" for a tool the base image ships, add context naming the cause.
#
# Silent (no output, exit 0) outside a base-image container (no
# $DEV_SYSTEM_SHARE directory), when everything is current, when dev-version says
# only OK or UNKNOWN (offline, timed out), and without jq. Never blocks the session.

mode=${1:-}
share=${DEV_SYSTEM_SHARE:-/usr/local/share/dev-system}

# The one wording for the fix; images/base/dev-query and dev-init say the same.
FIX='rebuild the container (dev-restart-self, or Rebuild Container in a desktop dev container); do not install the tool by hand'

[ -d "$share" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# Tools on PATH, and internal files that are deliberately not on PATH.
PATH_TOOLS="psql dev-version dev-query"
SHARE_FILES="image-release event-push-loop nm-push-loop"

emit() { # event, context
  jq -n --arg e "$1" --arg c "$2" \
    '{hookSpecificOutput: {hookEventName: $e, additionalContext: $c}}'
}

session_start() {
  local missing="" t f out stale
  for t in $PATH_TOOLS; do
    command -v "$t" >/dev/null 2>&1 || missing="$missing
- $t (not on PATH)"
  done
  for f in $SHARE_FILES; do
    [ -e "$share/$f" ] || missing="$missing
- $share/$f (missing)"
  done
  if [ -n "$missing" ]; then
    emit SessionStart "This dev container is out of date: its image is older than the base image this plugin expects. Missing from the image:$missing
Fix: $FIX. Factory-data tools such as dev-query will fail as 'command not found' until then."
    return 0
  fi
  out=$(timeout -k 1 5 dev-version 2>/dev/null </dev/null) || true
  stale=$(printf '%s\n' "$out" | grep -E '^dev-version: STALE (base-image|image:)') || true
  if [ -n "$stale" ]; then
    emit SessionStart "This dev container is out of date: dev-version reports a newer image is published.
$stale
Fix: $FIX."
  fi
}

tool_failure() {
  local input err t="" c
  input=$(cat)
  err=$(printf '%s' "$input" | jq -r '.error // empty' 2>/dev/null) || return 0
  case $err in "Exit code 127"*) ;; *) return 0 ;; esac
  for c in $PATH_TOOLS nm-export event-push-loop nm-push-loop; do
    if printf '%s\n' "$err" | grep -qE "(^|[^A-Za-z0-9_.-])$c: command not found"; then t=$c; break; fi
  done
  [ -n "$t" ] || return 0
  case $t in
    nm-export | event-push-loop | nm-push-loop)
      if [ -e "$share/$t" ]; then
        emit PostToolUseFailure "$t is an internal tool of the base image and is deliberately not on PATH. Run it by its path, $share/$t. If that is not what you meant, it is not a missing tool."
      else
        emit PostToolUseFailure "$t is missing from this container: $share/$t does not exist, so the container's image is older than the base image that ships it. Fix: $FIX."
      fi
      ;;
    *)
      emit PostToolUseFailure "$t is not installed: this container's image is older than the base image that ships it. Fix: $FIX."
      ;;
  esac
}

case $mode in
  session-start) session_start ;;
  tool-failure) tool_failure ;;
esac
exit 0
