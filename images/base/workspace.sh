# shellcheck shell=bash
#
# workspace.sh: the workspace helpers shared by dev-entrypoint, dev-init,
# dev-remote-control and dev-doctor (cbundy/dev-system#77). Sourced, not run.
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
