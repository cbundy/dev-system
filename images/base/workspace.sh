# shellcheck shell=bash
#
# workspace.sh: the workspace helpers shared by dev-entrypoint, dev-init,
# dev-remote-control and dev-doctor (cbundy/dev-system#77), and the helpers
# for the workspace repo's Claude plugins (#112). Sourced, not run.
#
# DEV_WORKSPACE is where dev-init and Claude run. An explicit value always
# wins. Unset (or empty) with DEV_REPO_URL set, it becomes
# /workspaces/<repo name>, the directory dev-init clones the repo into (the
# runtime mounts its workspace volume at /workspaces); sourcing this file sets
# and exports it, so every script and everything they start agree on it.

# repo_name <url>: the repo name in a clone URL - its last path part, without
# a trailing / or .git (my-repo for https://github.com/me/my-repo.git and for
# git@github.com:me/my-repo.git).
repo_name() {
  local url="${1%/}"
  url="${url%.git}"
  url="${url##*/}"
  echo "${url##*:}"
}

# workspace [start dir]: the directory to run in - DEV_WORKSPACE once it
# exists (a clone may still be pending), else the start directory (default:
# the current one) unless it is /, else $HOME.
workspace() {
  local start="${1:-$PWD}"
  if [ -n "${DEV_WORKSPACE:-}" ] && [ -d "$DEV_WORKSPACE" ]; then
    echo "$DEV_WORKSPACE"
  elif [ "$start" != / ]; then
    echo "$start"
  else
    echo "$HOME"
  fi
}

# repo_settings [dir]: the committed Claude settings of the repo the
# directory (default: the workspace) is in - .claude/settings.json at its top
# level. Fails when there is no repo or no such file. A checkout git refuses
# to read ("dubious ownership") counts when the directory itself holds .git.
repo_settings() {
  local dir="${1:-$(workspace)}" top
  if ! top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null); then
    [ -e "$dir/.git" ] || return 1
    top="$dir"
  fi
  [ -f "$top/.claude/settings.json" ] || return 1
  echo "$top/.claude/settings.json"
}

# enabled_plugins <settings file>: each <plugin>@<marketplace> that its
# enabledPlugins sets to true, one per line. Fails on a file jq cannot parse.
enabled_plugins() {
  jq -r '.enabledPlugins | if type == "object" then to_entries[] | select(.value == true) | .key | select(test("^[^@]+@[^@]+$")) else empty end' "$1" 2>/dev/null
}

# claude_plugin_cli <args...>: runs `claude plugin <args>` limited to
# CLAUDE_PLUGIN_LIMIT seconds (default 60), with no stdin, and from / rather
# than a checkout: a plugin command run inside a repo can rewrite the repo's
# own .claude/settings.json (`marketplace remove` does).
claude_plugin_cli() {
  (cd / && timeout -k 5 "${CLAUDE_PLUGIN_LIMIT:-60}" claude plugin "$@" </dev/null)
}

# installed_plugins: the ids (<plugin>@<marketplace>) of the plugins Claude
# has installed, one per line. Fails when the CLI cannot list them.
installed_plugins() {
  local out
  out=$(CLAUDE_PLUGIN_LIMIT=30 claude_plugin_cli list --json 2>/dev/null) || return 1
  printf '%s\n' "$out" | jq -r '.[].id'
}

# A name that is no usable directory (a URL ending in : or /.git) leaves
# DEV_WORKSPACE unset; dev-init warns about it.
if [ -z "${DEV_WORKSPACE:-}" ] && [ -n "${DEV_REPO_URL:-}" ]; then
  case "$(repo_name "$DEV_REPO_URL")" in
    "" | . | ..) ;;
    *)
      DEV_WORKSPACE="/workspaces/$(repo_name "$DEV_REPO_URL")"
      export DEV_WORKSPACE
      ;;
  esac
fi
