# shellcheck shell=bash
# shellcheck disable=SC2016,SC2034,SC2154
#
# Shared helpers for the base image container tests (test.sh and sections/*.sh): the docker
# wrapper, the check/in_image/put_secret helpers, the pass counters and the cleanup trap.
# Sourced by test.sh after it sets IMAGE; never run directly.

# Every container these tests start reads its models from the image's baked
# models.env only (DEV_MODELS_URL empty): dev-init would otherwise fetch the
# file from GitHub on each start, so results would depend on the network and on
# what main holds. The fetch's own tests (section 5) set DEV_MODELS_URL inside
# the container, which wins over this. Likewise no default Claude plugins
# (DEV_DEFAULT_PLUGINS empty), or every dev-init would install callum-flow
# from GitHub: section 13's tests set it inside the container, and its one
# real install runs `command docker run` to keep the image's value. Exported,
# so the `bash -c` checks get it.
# xargs in cleanup runs the real docker, which is fine: it never runs a container.
# shellcheck disable=SC2032
docker() {
  if [ "${1:-}" = run ]; then
    shift
    command docker run -e DEV_MODELS_URL= -e DEV_DEFAULT_PLUGINS= "$@"
  else
    command docker "$@"
  fi
}
export -f docker
DEVCONTAINER="${DEVCONTAINER:-devcontainer}"
# The persistence contract's directory names, in the image's order (the
# PERSIST_DIRS ARG in the Dockerfile). Section 3 proves the image matches.
PERSIST_NAMES="claude codex gh no-mistakes agentsview events dev-restart-self"
RUN_ID="dsb-test-$$"
PASSES=0
FAILURES=0

pass() {
  echo "PASS: $*"
  PASSES=$((PASSES + 1))
}

fail() {
  echo "FAIL: $*"
  FAILURES=$((FAILURES + 1))
}

# check <description> <command...>: runs the command on the host
check() {
  local desc="$1"
  shift
  local out
  if out=$("$@" 2>&1); then
    pass "$desc"
  else
    fail "$desc"
    printf '%s\n' "$out" | sed 's/^/    /'
  fi
}

# in_image <bash script> [docker run args...]: runs a script as the image's
# default user in a throwaway container. Like any `docker run IMAGE bash`, it
# goes through the image ENTRYPOINT, so dev-init runs first (its report on
# stderr); tests that need the image's untouched state pass --entrypoint "".
in_image() {
  local script="$1"
  shift
  docker run --rm "$@" "$IMAGE" bash -c "$script"
}

# put_secret <volume> <value>: writes the agentsview URL into a secrets volume
# the way images/base/README.md tells you to (value on stdin, never in an
# argument), so the test also proves the documented command.
put_secret() {
  printf '%s\n' "$2" | docker run --rm -i --user root --entrypoint "" \
    -v "$1:/run/secrets/dev-system" "$IMAGE" \
    sh -c 'umask 077 && cat > "$DEV_SECRETS_DIR/agentsview-pg-url" && chown 1000:1000 "$DEV_SECRETS_DIR/agentsview-pg-url"'
}

# A recognisable password for every test URL, to prove it never shows up in
# a log, a report, a process list or docker inspect.
SECRET="dsb-secret-$$-pw"

# shellcheck disable=SC2033 # xargs runs the real docker on purpose, see docker() above
cleanup() {
  docker ps -aq --filter "label=$RUN_ID" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter "label=$RUN_ID" | xargs -r docker volume rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter "name=^$RUN_ID-" | xargs -r docker volume rm -f >/dev/null 2>&1 || true
  docker network ls -q --filter "label=$RUN_ID" | xargs -r docker network rm >/dev/null 2>&1 || true
  # An if, not `[ ... ] && rm`: a false test as the trap's last command would
  # become the script's exit status, failing a green run that skipped test 7.
  if [ -n "${WORKDIR:-}" ]; then rm -rf "$WORKDIR"; fi
}
trap cleanup EXIT

# run_bg <docker run args...>: starts a detached container, removed on exit
run_bg() {
  docker run -d --label "$RUN_ID" "$@"
}

# wait_until <seconds> <command...>: polls once a second until the command
# succeeds; a last failing run shows its output
wait_until() {
  local n="$1"
  shift
  while [ "$n" -gt 0 ]; do
    "$@" >/dev/null 2>&1 && return 0
    sleep 1
    n=$((n - 1))
  done
  "$@"
}

logs_have() {
  docker logs "$1" 2>&1 | grep -qF -- "$2"
}

# stops_within <container> <seconds>: docker stop (with a long timeout, so an
# ignored SIGTERM shows up as slow rather than as a kill) must finish in time
# and the container must exit 0
stops_within() {
  local start ms rc
  start=$(date +%s%N)
  docker stop -t 30 "$1" >/dev/null
  ms=$((($(date +%s%N) - start) / 1000000))
  rc=$(docker inspect -f '{{.State.ExitCode}}' "$1")
  echo "docker stop took ${ms}ms, exit code $rc"
  [ "$ms" -lt $(($2 * 1000)) ] && [ "$rc" = 0 ]
}

# A stub claude: `auth status` reports a claude.ai login once /tmp/logged-in
# exists; `--version` prints a version and exits (dev-version asks; it is no session); `auth login` behaves like the real one (a sign-in URL, then a
# prompt for the code; attempt N accepts good-code-N, anything else gets
# "Invalid code"); a session first asks for Remote Control consent, as the
# real CLI does, while remoteDialogSeen is not true in .claude.json (it records
# /tmp/claude-consent-prompt and waits for an answer, so it never starts
# unattended), then records its directory and arguments in /tmp/claude-starts
# (its arguments one per line in /tmp/claude-argv-<start number>, and its
# environment in /tmp/claude-env) and runs until /tmp/claude-exit exists and
# exits 3.
STUB='#!/bin/bash
if [ "$1 ${2:-}" = "auth login" ]; then
  n=$(( $(cat /tmp/claude-logins 2>/dev/null || echo 0) + 1 )); echo $n > /tmp/claude-logins
  echo "Opening browser to sign in..."
  echo "If the browser did not open, visit: https://claude.com/cai/oauth/authorize?code=true&state=attempt$n"
  while read -r -p "Paste code here if prompted > " code; do
    [ "$code" = "good-code-$n" ] && { touch /tmp/logged-in; echo "Login successful."; exit 0; }
    echo "Invalid code. Please make sure the full code was copied."
  done
  exit 1
fi
if [ "$1" = --version ]; then
  echo "0.0.0 (Claude Code)"
  exit 0
fi
if [ "$1" = auth ]; then
  [ -e /tmp/logged-in ] && { echo "{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}"; exit 0; }
  echo "{\"loggedIn\":false,\"authMethod\":\"none\"}"
  exit 1
fi
if [ "$(jq -r .remoteDialogSeen "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.claude.json" 2>/dev/null)" != true ]; then
  touch /tmp/claude-consent-prompt
  read -r -p "Enable Remote Control? (y/n) " answer
  [ "$answer" = y ] || exit 0
fi
env | sort > /tmp/claude-env
echo "$PWD $*" >> /tmp/claude-starts
printf "%s\n" "$@" > /tmp/claude-argv-$(grep -c . /tmp/claude-starts)
until [ -e /tmp/claude-exit ]; do sleep 0.2; done
exit 3'
# Stub codex and gh device logins: a URL and a one-time code; approving is
# touching /tmp/<tool>-approve, which logs the tool in (gh then runs
# `auth setup-git`, recorded in /tmp/gh-setup-git, which also gives git a
# credential helper, as the real one does); /tmp/<tool>-expire ends
# the attempt without a login, as an expired code does. gh's login records
# its arguments in /tmp/gh-login-args and grants the workflow scope when asked
# for it (/tmp/gh-workflow); `auth status --json` reports the scopes, and
# `auth refresh --scopes workflow` adds the scope on /tmp/gh-approve, with its
# own code (cbundy/dev-system#181).
STUB_CODEX='#!/bin/bash
case "$1 ${2:-}" in
  "login status") [ -e /tmp/codex-in ]; exit ;;
  "login --device-auth")
    n=$(( $(cat /tmp/codex-logins 2>/dev/null || echo 0) + 1 )); echo $n > /tmp/codex-logins
    printf "1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n"
    printf "2. Enter this one-time code (expires in 15 minutes)\n   CDX$n-ABCDE\n"
    until [ -e /tmp/codex-approve ]; do
      [ -e /tmp/codex-expire ] && { rm -f /tmp/codex-expire; echo "Device code expired"; exit 1; }
      sleep 0.2
    done
    touch /tmp/codex-in ;;
esac'
STUB_GH='#!/bin/bash
case "$1 ${2:-}" in
  "auth status")
    [ -e /tmp/gh-in ] || exit 1
    if [ "${3:-}" = --json ]; then
      scopes="gist, read:org, repo"
      [ -e /tmp/gh-workflow ] && scopes="$scopes, workflow"
      printf "{\"hosts\":{\"github.com\":[{\"state\":\"success\",\"active\":true,\"scopes\":\"%s\"}]}}\n" "$scopes"
    fi ;;
  "auth setup-git")
    touch /tmp/gh-setup-git
    git config --global credential.helper "!f() { echo username=stub; echo password=stub; }; f" ;;
  "auth login")
    echo "$*" > /tmp/gh-login-args
    echo "! First copy your one-time code: GH12-3456"
    echo "Open this URL to continue in your web browser: https://github.com/login/device"
    until [ -e /tmp/gh-approve ]; do sleep 0.2; done
    case " $* " in *" --scopes workflow "*) touch /tmp/gh-workflow ;; esac
    touch /tmp/gh-in ;;
  "auth refresh")
    echo "$*" > /tmp/gh-refresh-args
    echo "! First copy your one-time code: GH56-7890"
    echo "Open this URL to continue in your web browser: https://github.com/login/device"
    until [ -e /tmp/gh-approve ]; do sleep 0.2; done
    case " $* " in *" --scopes workflow "*) touch /tmp/gh-workflow ;; esac ;;
esac'
# Installs $STUB, $STUB_CODEX and $STUB_GH first on PATH (an empty one is a
# CLI that is always logged in, so the codex and gh stubs only matter where
# a test passes them), then runs the rest of the command line.
WITH_STUB='mkdir -p /tmp/stub && printf "%s\n" "$STUB" > /tmp/stub/claude && printf "%s\n" "${STUB_CODEX:-}" > /tmp/stub/codex && printf "%s\n" "${STUB_GH:-}" > /tmp/stub/gh && chmod +x /tmp/stub/* && PATH=/tmp/stub:$PATH'
