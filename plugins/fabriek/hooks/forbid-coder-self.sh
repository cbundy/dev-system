#!/bin/sh
# forbid-coder-self.sh - PreToolUse(Bash) hook: refuse `coder restart|stop|update`
# aimed at the workspace this session runs in (dev-system#263).
#
# Why: stopping your own workspace kills the session issuing the command before
# it can start the workspace again, so the workspace stays stopped (reproduced
# in testbed builds #6/#8/#10). `coder update` stops a running workspace first,
# so it has the same trap. `dev-restart-self` does it safely.
#
# Refused (see forbid-coder-self.awk): `coder [opts] restart|stop|update <target>`
# where <target> is $CODER_WORKSPACE_NAME or $CODER_WORKSPACE_OWNER_NAME/<name>
# (me/<name> too), each with an optional .<agent> suffix, written literally or
# as an unexpanded $CODER_WORKSPACE_NAME / ${CODER_WORKSPACE_NAME} reference
# (owner may be $CODER_WORKSPACE_OWNER_NAME), anywhere in a compound
# command, behind VAR=... prefixes and sudo/env/exec/nohup/time, and inside
# sh|bash -c and eval. Allowed: other workspaces, other coder subcommands, text
# that only mentions these words, and every command when CODER_WORKSPACE_NAME
# is unset.
#
# Quoted heredoc bodies are skipped as literal data. An unmatched backtick or
# $( fails open from that opener onward; the preceding text is still checked.
# An unfinished quoted segment is ignored, but completed segments before it
# are checked. Only a positively parsed self-target is refused (see #209).
#
# POSIX sh + awk only. Deny form matches forbid-tmux-kill.sh.

set -eu

[ -n "${CODER_WORKSPACE_NAME:-}" ] || exit 0

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

input=$(cat)
case $input in
  *coder*) ;;
  *) exit 0 ;;
esac
decision=$(printf '%s' "$input" | awk -f "$script_dir/forbid-coder-self.awk")

if [ "$decision" = "DENY" ]; then
  reason="Refused: this would stop the Coder workspace this session runs in, which kills the session before it can start the workspace again (the workspace then stays stopped). Never run 'coder restart', 'coder stop' or 'coder update' on your own workspace. A factory-loop agent never restarts or rebuilds the workspace at all (it would stop the loop and every agent in it): say what you need in your answer. In an interactive session, to pick up a new image or template version, run 'dev-restart-self' instead: it asks Coder for a start build that replaces the container and the session resumes by itself, with a scheduled-restart fallback."
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
fi

exit 0
