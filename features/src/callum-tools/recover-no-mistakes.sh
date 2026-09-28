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
# Called from setup.sh's postCreateCommand. Failures must never abort setup -
# every exit here is 0, and every message goes to stderr. Safe to run
# standalone too (e.g. from a shell test): it only touches state guarded by
# the checks above, and `no-mistakes daemon start` against an already-running
# daemon errors out rather than restarting it.
set -u

log() {
  echo "callum-tools: $*" >&2
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

  status_output=$(cd "$workspace_dir" && no-mistakes status 2>/dev/null)
  case "$status_output" in
    *"repo not initialized"*) ;;
    *) return 0 ;; # already registered (or status shape changed) - no-op
  esac

  log ".no-mistakes.yaml present but repo not registered - recovering no-mistakes runtime state in $workspace_dir"
  ( cd "$workspace_dir" && no-mistakes daemon start ) 2>&1 | while IFS= read -r line; do log "daemon start: $line"; done
  ( cd "$workspace_dir" && no-mistakes init ) 2>&1 | while IFS= read -r line; do log "init: $line"; done
  return 0
}

main() {
  command -v no-mistakes >/dev/null 2>&1 || return 0
  recover_no_mistakes "$(resolve_workspace_dir)"
  return 0
}

main
exit 0
