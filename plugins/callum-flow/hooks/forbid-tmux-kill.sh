#!/bin/sh
# forbid-tmux-kill.sh - PreToolUse(Bash) hook: refuse commands that kill the
# default tmux server or its sessions (dev-system#177).
#
# Why: the long-running Claude session (the orchestrator, started by
# dev-remote-control) lives in a tmux session on the DEFAULT tmux socket.
# Reproduced 2026-10-06: an agent ran `tmux kill-server` to get a clean tmux
# for a test and killed the host's own session, and with it every other
# session on that socket.
#
# Refused (see forbid-tmux-kill.awk; same quote-aware segment parsing as
# forbid-git-stash): `tmux [global opts] kill-server|kill-session` with no
# private socket selected (-L <name> or -S <path>), and `pkill`/`killall`
# aimed at tmux. Everything else is allowed - other tmux subcommands, any
# command using -L/-S, and commands that only mention these words (echo,
# grep, commit messages).
#
# Known limits: heuristic parser; does not follow command substitution or
# `sh -c '...'` strings.
#
# POSIX sh + awk only (no jq, no node). Deny form matches forbid-git-stash.sh:
# JSON on stdout with permissionDecision "deny", exit 0.

set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

input=$(cat)
decision=$(printf '%s' "$input" | awk -f "$script_dir/forbid-tmux-kill.awk")

if [ "$decision" = "DENY" ]; then
  reason="Refused: this would kill the default tmux server or its sessions. The default tmux socket hosts the long-running Claude session (the orchestrator, started by dev-remote-control), so killing the server or its sessions kills the agent running this command and every other session on the host. If you need tmux for a test, use a private socket instead, for example 'tmux -L <unique-name> new-session ...' and clean up with 'tmux -L <unique-name> kill-server'. Never touch the default socket, and never pkill or killall tmux."
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
fi

exit 0
