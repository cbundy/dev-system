#!/bin/sh
#
# Best-effort auto-recovery of no-mistakes runtime state after a container
# rebuild (issue #18). The no-mistakes install (setup.sh) already reinstalls
# the binaries and best-effort starts the daemon, but two pieces of runtime
# state do not survive a rebuild:
#
#   - The daemon is a process, so it is gone after every rebuild.
#   - Repo registration (~/.no-mistakes/repos/) is machine-local. Even where
#     ~/.no-mistakes is a host bind mount, a rebuild on 2026-08-18 came up
#     with repos/ empty while the binaries survived - every command returned
#     "repo not initialized" until the confirmed recovery was run by hand.
#
# If the workspace has opted into the pipeline (a checked-in .no-mistakes.yaml)
# and `no-mistakes status` reports the repo unregistered, this runs that
# confirmed recovery: `no-mistakes daemon start` (init fails with a
# connection-refused error if the daemon is not up) then `no-mistakes init`
# (re-reads the checked-in .no-mistakes.yaml and reinstalls the gate).
# Idempotent: an already-registered repo, or one with no .no-mistakes.yaml at
# all, is a no-op.
#
# Every no-mistakes call has its own time limit (NM_CALL_LIMIT seconds):
# `daemon start` alone waits up to 135s for a daemon that never answers
# (cbundy/dev-system#101), and this runs during container start-up, where a
# hang holds up everything after it.
#
# Called from setup.sh's postCreateCommand. Failures must never abort setup -
# every exit here is 0, and every message goes to stderr. Safe to run
# standalone too (e.g. from a shell test): it only touches state guarded by
# the checks above, and `no-mistakes daemon start` against an already-running
# daemon errors out rather than restarting it.
set -u

NM_CALL_LIMIT="${NM_CALL_LIMIT:-30}"

log() {
  echo "callum-tools: $*" >&2
}

# bounded <command...>: runs a command under NM_CALL_LIMIT (when coreutils
# timeout is there), so a stuck no-mistakes cannot hang the caller. A command
# that hits the limit exits 124 (137 if it had to be killed).
bounded() {
  if command -v timeout >/dev/null 2>&1; then
    timeout -k 5 "$NM_CALL_LIMIT" "$@" </dev/null
  else
    "$@" </dev/null
  fi
}

# run_logged <label> <command...>: a bounded call, with its output logged line
# by line under the label and a timeout named with the fix. Returns the
# command's exit status.
run_logged() {
  label="$1"
  shift
  out=$(bounded "$@" 2>&1)
  rc=$?
  printf '%s\n' "$out" | while IFS= read -r line; do
    [ -z "$line" ] || log "$label: $line"
  done
  case "$rc" in
    124 | 137)
      log "$label: did not finish within ${NM_CALL_LIMIT}s - stopped."
      log "  Fix: see ${NM_HOME:-$HOME/.no-mistakes}/logs (cli.log, daemon-bootstrap.log), then run: no-mistakes $label"
      ;;
  esac
  return "$rc"
}

# containers.dev specifies that lifecycle hooks (postCreateCommand included)
# run with cwd already set to the workspace folder - "commands are executed
# from the context of the project workspace folder" (containers.dev
# /implementors/features/ and /implementors/json_reference/) - so trusting
# $PWD is correct per spec. Still walk up to the enclosing git toplevel
# defensively, in case a workspaceFolder is pointed below the repo root (e.g.
# a monorepo devcontainer.json) - that toplevel is still the repo whose
# .no-mistakes.yaml matters. If $PWD is not inside a git repo at all, fall
# back to $PWD itself; the .no-mistakes.yaml presence check below then
# naturally no-ops.
resolve_workspace_dir() {
  toplevel=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null) && {
    printf '%s\n' "$toplevel"
    return 0
  }
  printf '%s\n' "$PWD"
}

recover_no_mistakes() {
  workspace_dir="$1"

  [ -f "$workspace_dir/.no-mistakes.yaml" ] || return 0

  cd "$workspace_dir" || return 0
  status_output=$(bounded no-mistakes status 2>/dev/null)
  case "$status_output" in
    *"repo not initialized"*) ;;
    *) return 0 ;; # already registered (or status shape changed, or timed out) - no-op
  esac

  log ".no-mistakes.yaml present but repo not registered - recovering no-mistakes runtime state in $workspace_dir"
  run_logged "daemon start" no-mistakes daemon start
  # A daemon start that ran out of time leaves no daemon, so init would only
  # fail the same way.
  case $? in
    124 | 137) return 0 ;;
  esac
  run_logged init no-mistakes init
  return 0
}

main() {
  command -v no-mistakes >/dev/null 2>&1 || return 0
  recover_no_mistakes "$(resolve_workspace_dir)"
  return 0
}

main
exit 0
