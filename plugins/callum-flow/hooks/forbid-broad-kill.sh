#!/bin/sh
# forbid-broad-kill.sh - PreToolUse(Bash) hook: refuse process kills that select
# by name or pattern on the shared host (dev-system#421).
#
# Why: every agent shares one host. Reproduced 2026-10-11: an agent ran
# `kill $(pgrep -f '^sleep 300')` to clean up its own sleep and killed the
# orchestrator's watcher sleeps (and could as easily have killed any other
# agent's processes), stalling the queue. Killing by name is never safe here;
# only a PID you started and recorded is.
#
# Refused (see forbid-broad-kill.awk; same quote-aware segment parsing as
# forbid-tmux-kill): `pkill`, `killall`, `killall5` in any form; `kill` fed by a
# $(...) or backtick substitution running `pgrep` or `pidof`; `pgrep`/`pidof`
# piped into `xargs ... kill`; `kill -1`, `kill -9 -1`, `kill -- -1`.
#
# Allowed: kill of exact PIDs or variables (`kill 1234`, `kill "$pid"`,
# `kill -TERM $!`, `kill 0`); bare pgrep/pidof; commands that only mention these
# words (echo, grep, commit messages); selectors scoped by `-P <pid>` (unless
# the value is 0 or 1); selectors whose every name/pattern operand, with
# backslashes removed, contains an absolute path inside the agent's own linked
# git worktree (git top level of the input cwd, only when its git dir differs
# from its common dir, so the main checkout never counts) or inside a Claude
# scratchpad (/claude-<digits>/<slug>/<session>/scratchpad/). If git is missing
# or fails, only the scratchpad exemption applies.
#
# Fail-open, like forbid-tmux-kill: quoted heredoc bodies are data and skipped;
# an unmatched backtick or $( stops the nested scan and limits the segment scan
# to text before that opener; only a positively parsed match is refused; a
# non-Bash tool is allowed.
#
# Known limits: heuristic parser; does not follow variables ("kill $pids" after
# "pids=$(pgrep x)"), `kill $(cat pidfile)`, a substitution inside a double
# quoted sh -c payload, or backslash-escaped command spellings. Worktree paths
# are compared as written, so a symlinked spelling is not recognised.
#
# POSIX sh + awk + git (worktree exemption only); no jq, no node. Deny form
# matches forbid-tmux-kill.sh: JSON on stdout with permissionDecision "deny",
# exit 0.

set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
awk_file="$script_dir/forbid-broad-kill.awk"

input=$(cat)

worktree=''
cwd=$(printf '%s' "$input" | awk -v mode=cwd -f "$awk_file" 2>/dev/null || true)
if [ -n "$cwd" ] && command -v git >/dev/null 2>&1; then
  top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)
  gitdir=$(git -C "$cwd" rev-parse --absolute-git-dir 2>/dev/null || true)
  common=$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  if [ -n "$top" ] && [ -n "$gitdir" ] && [ -n "$common" ] && [ "$gitdir" != "$common" ]; then
    worktree=$top
  fi
fi

decision=$(printf '%s' "$input" | BROAD_KILL_WORKTREE="$worktree" awk -f "$awk_file")

if [ "$decision" = "DENY" ]; then
  # shellcheck disable=SC2016 # the $! and $pid are literal advice text
  reason='Refused: this kills processes by name or pattern (pkill, killall, kill of a pgrep/pidof result, or a kill of every process). All agents share this host, so a broad kill can stop the orchestrator watchers and other agents processes, not just yours. Kill only PIDs you started and recorded: start the process with cmd & pid=$!, then kill \"$pid\" when done. If you must match by pattern, scope it to a path in your own worktree or scratchpad (for example pkill -f /abs/path/to/your/worktree/server.js) or to your own children with pkill -P <pid>.'
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
fi

exit 0
