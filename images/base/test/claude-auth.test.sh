#!/bin/bash
# shellcheck disable=SC2016,SC2030,SC2031,SC1090,SC1091
#
# Plain-shell test for Claude's API-key mode (cbundy/dev-system#1113): dev-init's
# setup_claude_api_key (set, merge, remove, leave an owner's own helper alone), the
# dev-claude-api-key helper, dev-login's `wanted claude` and dev-remote-control's
# wait_for_api_key. The functions are taken from the scripts, so the test runs what
# ships. No Docker, network or real Claude.
# The suite runner starts suites with sh; the scripts are bash.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -eu

for name in $(env | sed -n 's/^\(DEV_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$name"
done

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
BASE="$SCRIPT_DIR/.."

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

for t in jq mktemp awk; do
  command -v "$t" >/dev/null 2>&1 || fail "$t is required to run this test"
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export CLAUDE_CONFIG_DIR="$tmp/claude"
mkdir "$CLAUDE_CONFIG_DIR"
SETTINGS="$CLAUDE_CONFIG_DIR/settings.json"
KEYFILE="$tmp/anthropic-api-key"
FAKE="sk-ant-fake-$$-key"

HELPER="$BASE/dev-claude-api-key"
export CLAUDE_API_KEY_HELPER=/usr/local/bin/dev-claude-api-key
LOGS="$tmp/log"
log() { echo "$*" >> "$LOGS"; }
# shellcheck source=../claude-auth.sh
. "$BASE/claude-auth.sh"

# --- the helper -------------------------------------------------------------
printf '\n  %s  \nsecond\n' "$FAKE" > "$KEYFILE"
[ "$(bash "$HELPER" "$KEYFILE")" = "$FAKE" ] || fail "helper must print the first non-blank line, trimmed"
if out=$(bash "$HELPER" "$tmp/missing" 2>&1); then fail "helper must fail on a missing file"; fi
case "$out" in *"$tmp/missing"*) ;; *) fail "helper error must name the path: $out" ;; esac
: > "$tmp/empty"
printf '  \n\n' > "$tmp/blank"
for f in "$tmp/empty" "$tmp/blank"; do
  if out=$(bash "$HELPER" "$f" 2>&1); then fail "helper must fail on $f"; fi
  case "$out" in *"$f"*) ;; *) fail "helper error must name $f: $out" ;; esac
done
printf '%s\n' "$FAKE" > "$tmp/k2"
bash "$HELPER" "$tmp/empty" >/dev/null 2>&1 && fail "helper must fail on an empty file"
out=$(bash "$HELPER" "$tmp/empty" 2>&1 || true)
case "$out" in *"$FAKE"*) fail "helper error must not hold a key" ;; esac
bash "$HELPER" >/dev/null 2>&1 && fail "helper without an argument must fail"

# --- claude_api_key_mode / ready ----------------------------------------------
claude_api_key_mode && fail "not api-key mode by default"
export DEV_CLAUDE_AUTH=api-key DEV_CLAUDE_API_KEY_FILE="$KEYFILE"
claude_api_key_mode || fail "api-key mode when DEV_CLAUDE_AUTH=api-key"
claude_api_key_ready || fail "ready with a non-blank key file"
DEV_CLAUDE_API_KEY_FILE="$tmp/blank" claude_api_key_ready && fail "a blank file is not ready"
DEV_CLAUDE_API_KEY_FILE="$tmp/missing" claude_api_key_ready && fail "a missing file is not ready"

# --- setup_claude_api_key -------------------------------------------------------
want="$CLAUDE_API_KEY_HELPER $KEYFILE"
# Merge into settings that lack a helper.
echo '{"enabledPlugins":{"a@b":true}}' > "$SETTINGS"
setup_claude_api_key
jq -e --arg h "$want" '.apiKeyHelper == $h and .enabledPlugins["a@b"] == true' "$SETTINGS" >/dev/null || fail "helper must be merged, keeping other keys"
[ "$(stat -c %a "$SETTINGS")" = 600 ] || fail "settings.json must be mode 0600"
grep -qF "$FAKE" "$SETTINGS" "$LOGS" 2>/dev/null && fail "the key must not appear in settings or logs"
: > "$LOGS"
setup_claude_api_key
grep -q 'already set' "$LOGS" || fail "a second run must say it is already set"
# No settings file at all.
rm -f "$SETTINGS"
setup_claude_api_key
jq -e --arg h "$want" '.apiKeyHelper == $h' "$SETTINGS" >/dev/null || fail "helper must be written to a new settings file"

# Out of API-key mode: the image's helper is removed, other keys stay.
echo '{"enabledPlugins":{"a@b":true}}' | jq --arg h "$want" '.apiKeyHelper = $h' > "$SETTINGS"
unset DEV_CLAUDE_AUTH DEV_CLAUDE_API_KEY_FILE
setup_claude_api_key
jq -e 'has("apiKeyHelper") | not' "$SETTINGS" >/dev/null || fail "the image's helper must be removed out of API-key mode"
jq -e '.enabledPlugins["a@b"] == true' "$SETTINGS" >/dev/null || fail "removal must keep other keys"
# An owner's own helper stays.
echo '{"apiKeyHelper":"/home/me/mine"}' > "$SETTINGS"
setup_claude_api_key
jq -e '.apiKeyHelper == "/home/me/mine"' "$SETTINGS" >/dev/null || fail "an owner's helper must be left alone"
# No file: nothing is created.
rm -f "$SETTINGS"
setup_claude_api_key
[ ! -e "$SETTINGS" ] || fail "no settings file must be created out of API-key mode"

# --- dev-login: claude is not wanted in API-key mode ---------------------------------
{
  echo 'ALL_TOOLS="claude codex gh"'
  echo 'log() { :; }'
  sed -n '/^wanted_tools() {/,/^}/p;/^wanted() {/,/^}/p' "$BASE/dev-login"
} > "$tmp/login-funcs.sh"
[ "$(grep -c '^wanted() {' "$tmp/login-funcs.sh")" = 1 ] || fail "wanted not found in dev-login"
(
  . "$tmp/login-funcs.sh"
  wanted claude || fail "claude wanted outside API-key mode"
  export DEV_CLAUDE_AUTH=api-key
  wanted claude && fail "claude must not be wanted in API-key mode"
  wanted codex && wanted gh || fail "codex and gh are unchanged in API-key mode"
  exit 0
) || exit 1

# --- dev-remote-control: wait_for_api_key -----------------------------------------------
{
  echo 'REMIND_EVERY=3; POLL=0'
  echo 'log() { echo "$*" >> "$LOGS"; }'
  echo 'pause() { n=$((${n:-0} + 1)); [ "$n" -lt 8 ] || { echo "$n" > "$tmp/polls"; return 0; }; [ "$n" -ne 7 ] || cp "$tmp/k2" "$DEV_CLAUDE_API_KEY_FILE"; }'
  sed -n '/^wait_for_api_key() {/,/^}/p' "$BASE/dev-remote-control"
} > "$tmp/rc-funcs.sh"
[ "$(grep -c '^wait_for_api_key() {' "$tmp/rc-funcs.sh")" = 1 ] || fail "wait_for_api_key not found in dev-remote-control"
export DEV_CLAUDE_AUTH=api-key DEV_CLAUDE_API_KEY_FILE="$tmp/late-key" LOGS tmp
: > "$LOGS"
(
  . "$tmp/rc-funcs.sh"
  wait_for_api_key
)
hints=$(grep -c "Claude API-key mode: $tmp/late-key is missing, empty or unreadable - provision it on the Docker host" "$LOGS" || true)
# Polls 0..6 with a reminder every 3: polls 0, 3 and 6.
[ "$hints" = 3 ] || fail "expected 3 hints over 7 polls (once per period), got $hints"
grep -q 'Claude API key file found' "$LOGS" || fail "wait_for_api_key must return once the file appears"
[ ! -e "$tmp/polls" ] || fail "wait_for_api_key must stop polling once the file is readable"
grep -qF "$FAKE" "$LOGS" && fail "the log must not hold the key"

echo "claude-auth.test.sh: ok"
