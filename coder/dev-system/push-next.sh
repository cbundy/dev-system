#!/bin/sh
# Test a change to this Coder template from inside a workspace (cbundy/dev-system#118).
#
#   coder/dev-system/push-next.sh [push]   push this directory as the template dev-system-next
#   coder/dev-system/push-next.sh smoke    push, then create a throwaway workspace from it,
#                                          wait until its agent is ready, show its status and
#                                          startup log, and delete it again
#   coder/dev-system/push-next.sh cleanup  delete leftover next-smoke-* workspaces
#
# The template name is fixed: this script only ever pushes dev-system-next and only ever
# creates or deletes workspaces named next-smoke-* built from it. Promoting a change to the
# production dev-system template is the owner's step, not this script's.
#
# The token comes from the template-tester mount, which the template mounts only into a
# workspace with the template_testing parameter on (see "Testing template changes from a
# workspace" in README.md beside this script):
#   $DEV_TEMPLATE_TESTER_DIR/coder-session-token  a session token for a Template Admin user
# The template's variables come from terraform.tfvars beside this script, which coder reads
# on every push, exactly as for dev-system, except that template_tester_secrets_dir is always
# pushed empty, so dev-system-next workspaces never get the token.
# DEV_TEMPLATE_TESTER_DIR defaults to /run/secrets/dev-system-template-tester. The shared
# secrets mount (/run/secrets/dev-system, in every workspace) is deliberately not read. The
# deployment URL is CODER_URL, else the agent's CODER_AGENT_URL.
#
# The CLI used is CODER_BIN if set, else the workspace agent's own binary (downloaded from
# the server, so its version always matches: a mismatched CLI silently ignored --parameter
# in cbundy/dev-system#108), else `coder` on PATH.
#
# The token is never printed or put on a command line: it is passed to each coder call in
# the environment (CODER_SESSION_TOKEN) and not exported to anything else.
set -eu

TEMPLATE=dev-system-next
SMOKE_PREFIX=next-smoke-
SETUP_HINT='see "Testing template changes from a workspace" in coder/dev-system/README.md'

TEMPLATE_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
TESTER_DIR=${DEV_TEMPLATE_TESTER_DIR:-/run/secrets/dev-system-template-tester}
TOKEN_FILE=$TESTER_DIR/coder-session-token
OPT_IN_HINT="enable the template_testing parameter on this workspace (and push the template with its template_tester_secrets_dir variable set) - $SETUP_HINT"
# How long smoke waits for the new workspace's agent, and how often it looks.
TIMEOUT=${PUSH_NEXT_TIMEOUT:-600}
POLL=${PUSH_NEXT_POLL:-10}

die() {
  echo "push-next: $*" >&2
  exit 1
}

usage() {
  echo "usage: $0 [push|smoke|cleanup]" >&2
  echo "The template name is always $TEMPLATE and cannot be changed." >&2
  exit 2
}

cmd=${1:-push}
[ $# -le 1 ] || usage
case "$cmd" in
  push | smoke | cleanup) ;;
  *) usage ;;
esac
# coder create reads the template name from this variable: refuse rather than let it
# point a smoke test anywhere else.
[ -z "${CODER_TEMPLATE_NAME:-}" ] || die "CODER_TEMPLATE_NAME is set; this script only uses $TEMPLATE - unset it"

[ -d "$TESTER_DIR" ] || die "no template-tester directory at $TESTER_DIR: $OPT_IN_HINT"
[ -r "$TOKEN_FILE" ] || die "no Coder session token at $TOKEN_FILE: $OPT_IN_HINT"
token=$(cat "$TOKEN_FILE")
[ -n "$token" ] || die "$TOKEN_FILE is empty - $SETUP_HINT"

url=${CODER_URL:-${CODER_AGENT_URL:-}}
[ -n "$url" ] || die "no deployment URL: set CODER_URL (CODER_AGENT_URL is set inside a Coder workspace)"

find_coder() {
  if [ -n "${CODER_BIN:-}" ]; then
    echo "$CODER_BIN"
    return
  fi
  # The agent's bootstrap downloads it to a mktemp -d coder.XXXXXX directory.
  for bin in "${TMPDIR:-/tmp}"/coder.*/coder /tmp/coder.*/coder; do
    if [ -x "$bin" ]; then
      echo "$bin"
      return
    fi
  done
  command -v coder || die "no coder CLI: not in a Coder workspace and none on PATH (or set CODER_BIN)"
}
coder_bin=$(find_coder)

# A private config dir, so neither a stored login nor a keyring is read or written.
config_dir=$(mktemp -d)
smoke_ws=
cleanup_on_exit() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$smoke_ws" ]; then
    echo "push-next: deleting $smoke_ws" >&2
    if ! coder_run delete "$smoke_ws" --yes >&2; then
      echo "push-next: could not delete $smoke_ws - run: $0 cleanup" >&2
      [ "$status" -ne 0 ] || status=1
    fi
  fi
  rm -rf "$config_dir"
  exit "$status"
}
trap cleanup_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

coder_run() {
  CODER_SESSION_TOKEN=$token CODER_URL=$url CODER_CONFIG_DIR=$config_dir \
    CODER_NO_VERSION_WARNING=true "$coder_bin" "$@"
}

push() {
  # coder reads the variables from terraform.tfvars; the flag overrides the file's
  # template_tester_secrets_dir, so no dev-system-next workspace ever mounts the token.
  set -- templates push "$TEMPLATE" --directory "$TEMPLATE_DIR" --yes \
    --variable template_tester_secrets_dir=
  sha=$(git -C "$TEMPLATE_DIR" rev-parse --short HEAD 2>/dev/null || true)
  [ -z "$sha" ] || set -- "$@" --message "push-next.sh from $sha"
  echo "push-next: pushing $TEMPLATE_DIR as $TEMPLATE" >&2
  coder_run "$@"
}

# Print the state of workspace $1: ready, failed, or waiting.
smoke_state() {
  coder_run list --output json --search "owner:me name:$1" | jq -r --arg n "$1" '
    [.[] | select(.name == $n)] | first // empty
    | if .latest_build.status == "failed" then "failed"
      else [.latest_build.resources[]?.agents[]?.lifecycle_state]
        | if length == 0 then "waiting"
          elif all(. == "ready") then "ready"
          elif any(. == "start_error") then "failed"
          else "waiting" end
      end'
}

smoke() {
  push
  suffix=$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
  ws=$SMOKE_PREFIX$suffix
  # Set before create, so an interrupted or failed create is still cleaned up.
  smoke_ws=$ws
  echo "push-next: creating $ws from $TEMPLATE" >&2
  coder_run create "$ws" --template "$TEMPLATE" --use-parameter-defaults --yes

  deadline=$(($(date +%s) + TIMEOUT))
  while :; do
    state=$(smoke_state "$ws")
    case "$state" in
      ready) break ;;
      failed) die "$ws failed to start" ;;
    esac
    [ "$(date +%s)" -lt "$deadline" ] || die "$ws not ready after ${TIMEOUT}s (state: ${state:-unknown})"
    sleep "$POLL"
  done

  echo "push-next: $ws is ready" >&2
  coder_run list --search "owner:me name:$ws" --column workspace,template,status,healthy
  echo "--- startup log tail ($ws:/tmp/coder-startup-script.log)"
  coder_run ssh "$ws" -- tail -n 40 /tmp/coder-startup-script.log || true
  echo "push-next: smoke test passed" >&2
}

cleanup() {
  names=$(coder_run list --output json --search owner:me | jq -r --arg p "$SMOKE_PREFIX" --arg t "$TEMPLATE" \
    '.[] | select((.name | startswith($p)) and .template_name == $t) | .name')
  for ws in $names; do
    # Never the workspace this runs in.
    [ "$ws" != "${CODER_WORKSPACE_NAME:-}" ] || continue
    echo "push-next: deleting $ws" >&2
    coder_run delete "$ws" --yes
  done
}

"$cmd"
