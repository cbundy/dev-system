#!/bin/bash
# fresh-worktree.sh - SessionStart(startup) hook: start a Claude Code worktree at the
# remote tip of the default branch (dev-system#392).
#
# Why: Claude Code creates worktrees (--worktree, server-mode bridge-*, desktop) from
# the local origin/<default> and only fetches when .git/FETCH_HEAD is older than 24h.
# In this factory FETCH_HEAD is touched constantly by branch-specific fetches that never
# move origin/<default>, so new sessions trust a stale ref and start far behind. A
# WorktreeCreate hook would replace the native creation and lose its pid lock, sweep
# marker, .worktreeinclude, filter-driver screen and branch cleanup, so creation stays
# native and this hook fast-forwards the fresh worktree before the first turn.
#
# Acts only when ALL hold, otherwise silent exit 0 and nothing changes:
#   - source is "startup"
#   - cwd is the top of a linked worktree at <main-root>/.claude/worktrees/<name>,
#     on branch worktree-<name>
#   - the tree is clean (no changes, no untracked files)
#   - HEAD equals the cached origin/<default> (came from the "fresh" base, no own commits)
# The default branch comes from refs/remotes/origin/HEAD; without it, nothing happens.
# The fetch is non-interactive and time-bounded; on failure the worktree stays at the
# cached ref and one line goes to stderr. The update is fast-forward only. Never blocks
# or fails the session; silent without jq.

command -v jq >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

input=$(cat 2>/dev/null || true)
source_=$(printf '%s' "$input" | jq -r '.source // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[ "$source_" = "startup" ] || exit 0
[ -n "$cwd" ] || cwd=$PWD
cd "$cwd" 2>/dev/null || exit 0

top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
top=$(cd "$top" 2>/dev/null && pwd -P) || exit 0
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
common=$(cd "$common" 2>/dev/null && pwd -P) || exit 0
main_root=$(dirname "$common")

# Must be a linked worktree directly under <main-root>/.claude/worktrees/.
[ "$(dirname "$top")" = "$main_root/.claude/worktrees" ] || exit 0
name=$(basename "$top")
branch=$(git symbolic-ref --short -q HEAD 2>/dev/null) || exit 0
[ "$branch" = "worktree-$name" ] || exit 0

# Clean tree, including untracked files.
[ -z "$(git status --porcelain --untracked-files=all 2>/dev/null)" ] || exit 0

# Default branch from origin/HEAD, never hardcoded.
ref=$(git symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null) || exit 0
default=${ref#refs/remotes/origin/}
[ -n "$default" ] && [ "$default" != "$ref" ] || exit 0

old=$(git rev-parse -q --verify HEAD 2>/dev/null) || exit 0
cached=$(git rev-parse -q --verify "refs/remotes/origin/$default" 2>/dev/null) || exit 0
[ "$old" = "$cached" ] || exit 0

fetch=(git fetch --quiet origin "$default")
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes"
if command -v timeout >/dev/null 2>&1; then
  fetch=(timeout 15 "${fetch[@]}")
fi
if ! "${fetch[@]}" >/dev/null 2>&1; then
  echo "fresh-worktree: could not fetch origin/$default; worktree stays at cached ${old:0:9}" >&2
  exit 0
fi

new=$(git rev-parse -q --verify "refs/remotes/origin/$default" 2>/dev/null) || exit 0
[ "$new" != "$old" ] || exit 0
if git merge --ff-only --quiet "$new" >/dev/null 2>&1; then
  echo "This worktree was fast-forwarded from ${old:0:9} to ${new:0:9} (origin/$default) at session start."
fi
exit 0
