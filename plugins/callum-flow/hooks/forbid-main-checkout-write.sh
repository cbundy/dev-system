#!/bin/sh
# forbid-main-checkout-write.sh - PreToolUse(Bash, Edit, Write, MultiEdit, NotebookEdit)
# hook: refuse a sub-agent's write into the repo's main checkout (dev-system#624).
#
# Why: the main checkout is what the factory loop runs from and what every agent reads.
# Agents start there, so a brief's main-checkout paths are easy to copy. Seen 2026-10-14:
# two implementers ran `cd /workspaces/dev-system/plugins/... && python3 - <<'EOF'` and
# `sed -i` there instead of in their leased treehouse worktree, which dirtied the main
# checkout, held the loop and could have edited its running code.
#
# Who is checked: only sub-agents (the hook input carries agent_id, which Claude Code
# sets for a tool call made inside a sub-agent and never for the main session), and only
# in a repo that uses treehouse (treehouse.toml or .treehouse/ in the main checkout).
# Every factory-loop and orchestrator agent is a sub-agent, and the repo's rule is that
# any agent making code changes works in a treehouse worktree. A human-driven main
# session is never checked, so editing the main checkout on purpose keeps working.
#
# The main checkout: the parent of git's common dir for the session's start directory
# ($CLAUDE_PROJECT_DIR, else the input cwd). That is the main checkout even when the
# session started inside a linked worktree. Allowed under it: every linked worktree
# (git worktree list), .treehouse/ (the pool) and .claude/worktrees/ even before a
# worktree exists there, and the repo-local state files .claude/orchestrator-memory.md,
# .claude/factory-loop.json and .claude/agent-memory/**.
#
# Refused (see forbid-main-checkout-write.awk), for a path in the protected part:
#   Edit, Write, MultiEdit file_path; NotebookEdit notebook_path.
#   Bash, with the directory tracked through cd/pushd from the input cwd and paths
#   resolved (symlinks too, with realpath -m) and $VARS expanded from assignments in
#   the command and the environment: output redirections (> >> >| &> <>); sed -i,
#   perl -i, ruby -i, gawk -i inplace on files there; tee, rm, rmdir, touch, mkdir,
#   truncate, shred, unlink, chmod, chown, chgrp, mv operands; the destination of cp,
#   install, ln and rsync; dd of=; patch in or into it; find -delete or -exec of a
#   writer under it; xargs-fed writers run there; git checkout, switch, restore, reset,
#   clean, apply, am, commit, add, rm, mv, merge, rebase, cherry-pick, revert, pull and
#   stash run there (cwd, -C or --work-tree); inline python, node, ruby, perl or php
#   code (-c, -e, a heredoc on stdin) that looks like it writes files and runs there or
#   names a protected path; tar extraction, curl -o/-O and wget into it; any command
#   given --write or --fix (prettier, eslint) there; and all of this inside sh -c,
#   bash -c, eval and heredoc scripts fed to a shell. A writer fed by xargs is refused
#   when it runs there or the pipeline before it names a protected path, a for-loop
#   variable stands for its list, and a variable it cannot know (read, an earlier
#   call) makes a written path count as relative to the current directory.
#
# Allowed: every read (cat, sed -n, grep, git show, diff, log, status, fetch, copying
# out of the main checkout), every write inside .treehouse/ or outside the main
# checkout, and the main session.
#
# Known limits: a heuristic parser, not a sandbox. It does not run command
# substitutions (a path from $(...) or backticks counts as unknown: refused only when
# the command runs in the main checkout), does not look inside script files
# (python3 tools/fix.py), does not know build tools that write (npm, make), and leaves
# git's ref-only commands (branch -f, worktree remove) alone. It catches the slips
# agents make, not an agent set on getting around it.
#
# POSIX sh + awk + git (+ realpath when present); no jq, no node. Deny form matches the
# other guards: JSON on stdout with permissionDecision "deny", exit 0. Any failure to
# work out the main checkout allows the call.

set -eu

input=$(cat)

# Fast path: only a sub-agent's tool call carries agent_id.
case $input in
  *'"agent_id"'*) ;;
  *) exit 0 ;;
esac

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
awk_file="$script_dir/forbid-main-checkout-write.awk"

meta=$(printf '%s' "$input" | awk -v mode=meta -f "$awk_file" 2>/dev/null || true)
tool='' agent='' cwd=''
{ read -r tool && read -r agent && read -r cwd; } <<EOF || true
$meta
EOF
[ -n "$agent" ] || exit 0
case $tool in
  Bash | Edit | Write | MultiEdit | NotebookEdit) ;;
  *) exit 0 ;;
esac
command -v git >/dev/null 2>&1 || exit 0

start=${CLAUDE_PROJECT_DIR:-$cwd}
[ -n "$start" ] || exit 0
common=$(git -C "$start" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
case $common in
  */.git) main=${common%/.git} ;;
  *) exit 0 ;;
esac
[ -e "$main/treehouse.toml" ] || [ -d "$main/.treehouse" ] || exit 0
main_real=$(CDPATH='' cd -- "$main" 2>/dev/null && pwd -P) || exit 0

# Linked worktrees that live under the main checkout (a treehouse pool, Claude Code's
# .claude/worktrees, anything else): writes there are the point, so they are allowed.
worktrees=''
while IFS= read -r line; do
  case $line in
    'worktree '*)
      wt=$(CDPATH='' cd -- "${line#worktree }" 2>/dev/null && pwd -P) || continue
      case $wt in "$main_real"/*) worktrees="$worktrees$wt
" ;; esac
      ;;
  esac
done <<EOF
$(git -C "$main" worktree list --porcelain 2>/dev/null || true)
EOF

has_realpath=0
if realpath -m / >/dev/null 2>&1; then has_realpath=1; fi

decision=$(printf '%s' "$input" | MAIN_WRITE_WORKTREES="$worktrees" awk -v main="$main_real" -v main_lex="$main" -v has_realpath="$has_realpath" -f "$awk_file" 2>/dev/null || true)

case $decision in
  DENY*) ;;
  *) exit 0 ;;
esac

rel=$(printf '%s' "$decision" | cut -f2)
[ -n "$rel" ] || rel=.
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\t' '  '; }
reason="Refused: this writes into the repo's main checkout ($main_real, at $rel), which every agent reads and people work from. Never edit, write or run write commands there. Reading the main checkout (cat, grep, sed -n, git show, git diff, git log) stays allowed. Do the work in your own worktree instead: the same file is at the same relative path there ($main_real/$rel becomes <your worktree>/$rel), so use worktree-absolute paths from then on; every main-checkout path in a brief maps to the same relative path in your worktree. A factory-loop agent's worktree is the slot the loop started it in (its starting folder, named in its prompt): never lease, create or return a worktree, and a step that only reads writes nowhere in the repository (a scratch file outside it, such as under /tmp, is fine). Only on the manual path (an interactive session implementing an issue by hand) with no worktree yet: lease one as the implement-issue skill says (treehouse get --lease)."
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$(json_escape "$reason")"

exit 0
