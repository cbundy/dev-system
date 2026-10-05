#!/bin/sh
# forbid-git-stash.sh - PreToolUse(Bash) hook: refuse any command that runs
# `git ... stash ...` as a real subcommand (dev-system#52).
#
# Why: refs/stash is ONE ref shared by every worktree of a repository.
# Parallel agents each work in their own treehouse worktree, so one agent's
# `git stash pop` can apply another agent's stashed changes onto the wrong
# branch, or silently drop its own. Reproduced 2026-09-28: a stash made in
# the main checkout showed up in a second worktree's `git stash list` and
# `git stash pop` applied it there.
#
# Detection (see forbid-git-stash.awk): for every segment of the command
# (split on ; & | newline and subshell/group boundaries ( ) { }, quote-aware
# so those characters inside a quoted string do not split it), find the
# command word - skipping leading VAR=value env assignments - and, if it is
# `git` (or a path ending in /git), skip git's own global options
# (-C <path>, -c <k=v>, --git-dir=..., --work-tree <path>, --no-pager, etc:
# anything starting with "--" and containing "=" is self-contained; a known
# set that takes a separate argument consumes the next token too; anything
# else starting with "-" is a no-arg flag) until the first non-option token,
# which is the real subcommand. Refuse only when that subcommand is exactly
# "stash" - so `git commit -m "stash cleanup"`, `grep stash file`,
# `git log --grep=stash` are never touched, because their subcommand
# (commit/grep n-a/log) is found and checked before the literal word "stash"
# is ever reached. `echo git stash` is deliberately NOT refused either (its
# command word is `echo`, not `git`) - it never runs stash, it only prints
# the words.
#
# Known limits: this is a heuristic parser, not a real shell grammar - it
# does not follow command substitution ($(...) or backticks), and it does
# not recurse into `sh -c '...'` / `bash -c "..."` strings.
#
# No jq, no node: POSIX sh + awk only. A consumer repo installing this
# plugin is not guaranteed to have either jq or a node runtime on PATH, but
# awk ships with every POSIX shell environment Claude Code hooks run in.
#
# Input shape (PreToolUse, https://code.claude.com/docs/en/hooks#pretooluse):
#   {"tool_name": "Bash", "tool_input": {"command": "..."}, ...}
#
# Deny form: JSON on stdout with hookSpecificOutput.permissionDecision
# "deny" (https://code.claude.com/docs/en/hooks) - the documented decision
# field whose reason "is shown to the user/Claude when the tool call is
# blocked" - rather than exit code 2, so the model sees exactly why.

set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

input=$(cat)
decision=$(printf '%s' "$input" | awk -f "$script_dir/forbid-git-stash.awk")

if [ "$decision" = "DENY" ]; then
  reason="git stash is refused: refs/stash is ONE ref shared by every worktree of this repo, so a stash made in one worktree can be applied or popped by a different parallel agent working in another worktree, silently corrupting or dropping work. Use one of these instead: commit your work-in-progress on your own branch (amend or squash it away later), or save a patch with 'git diff > <file>' (or 'git diff --cached > <file>' for staged changes) and restore it later with 'git apply <file>'."
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
fi

exit 0
