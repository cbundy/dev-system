#!/bin/bash
# shellcheck disable=SC2016,SC2030,SC2031 # the stub script is written with literal $ on purpose
#
# Plain-shell test for dev-init's setup_coder_login (cbundy/dev-system#540): with
# DEV_CODER_TOKEN_FILE set, the coder CLI's session and url files are written from the
# mounted token (modes 0600 in a 0700 directory), `coder whoami` is run and logged, a bad
# input gives one WARNING and no session file, and the token never reaches argv or the log.
# coder is a stub on PATH that records its argv. No network or real login.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -eu

for name in $(env | sed -n 's/^\(DEV_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$name"
done
unset CODER_URL CODER_AGENT_URL CODER_CONFIG_DIR

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
BASE="$SCRIPT_DIR/.."

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
bin="$tmp/bin"
mkdir "$bin"

funcs="$tmp/funcs.sh"
{
  echo 'log() { echo "dev-init: $*" >&2; }'
  sed -n '/^setup_coder_login() {/,/^}/p' "$BASE/dev-init"
} > "$funcs"
[ "$(grep -c '^setup_coder_login() {' "$funcs")" = 1 ] || fail "setup_coder_login not found in dev-init"
grep -qE '^check_persist_dirs$' "$BASE/dev-init" || fail "main sequence not found"
main=$(grep -nE '^(check_persist_dirs|setup_coder_login|resume_restart_self)$' "$BASE/dev-init" | cut -d: -f2 | tr '\n' ' ')
[ "$main" = "check_persist_dirs setup_coder_login resume_restart_self " ] || fail "step order is wrong: $main"

cat > "$bin/coder" <<'STUB'
#!/bin/sh
echo "$*" >> "$FIX/coder.calls"
[ "${STUB_WHOAMI_FAIL:-}" != 1 ] || exit 1
echo "[ Coder is running at http://127.0.0.1:1, You're authenticated as alice !"
STUB
chmod +x "$bin/coder"

# run_case: sets $FIX, $cfg, $log, $rc for a fresh case; the caller sets env first.
run_case() {
  FIX=$(mktemp -d "$tmp/case.XXXXXX")
  export FIX
  cfg="$FIX/coderv2"
  log="$FIX/log"
  : > "$FIX/coder.calls"
  rc=0
  (
    export CODER_CONFIG_DIR="$cfg" PATH="$bin:$PATH"
    # shellcheck disable=SC1090
    . "$funcs"
    setup_coder_login
  ) > "$log" 2>&1 || rc=$?
  [ "$rc" = 0 ] || fail "setup_coder_login returned $rc: $(cat "$log")"
}

warnings() { grep -c 'WARNING' "$log" || true; }
# one_warning <what>: exactly one WARNING and no session file.
one_warning() {
  [ "$(warnings)" = 1 ] || fail "$1: expected one WARNING: $(cat "$log")"
  [ ! -e "$cfg/session" ] || fail "$1: a session file was written"
}

# 1. Unset: nothing written, an existing session untouched.
mkdir -p "$tmp/pre"
printf 'old' > "$tmp/pre/session"
CODER_CONFIG_DIR="$tmp/pre" run_case
[ "$(cat "$tmp/pre/session")" = old ] || fail "unset: existing session changed"
[ ! -e "$cfg/session" ] || fail "unset: session written"
[ ! -s "$FIX/coder.calls" ] || fail "unset: coder was run"

# 2. A valid file, trailing newline, CODER_AGENT_URL with a trailing slash.
tok="s3cretTOKENvalue"
printf '%s\n' "$tok" > "$tmp/token"
export DEV_CODER_TOKEN_FILE="$tmp/token" CODER_AGENT_URL="http://coder.test/"
run_case
[ "$(cat "$cfg/session")" = "$tok" ] || fail "session is not the token: $(cat "$cfg/session")"
[ "$(wc -c < "$cfg/session")" = "${#tok}" ] || fail "session holds more than the token"
[ "$(cat "$cfg/url")" = "http://coder.test" ] || fail "url: $(cat "$cfg/url")"
[ "$(stat -c %a "$cfg")" = 700 ] || fail "dir mode $(stat -c %a "$cfg")"
[ "$(stat -c %a "$cfg/session")" = 600 ] || fail "session mode $(stat -c %a "$cfg/session")"
grep -q '^whoami$' "$FIX/coder.calls" || fail "whoami not run: $(cat "$FIX/coder.calls")"
grep -q 'coder CLI is logged in as alice from DEV_CODER_TOKEN_FILE' "$log" || fail "no success line: $(cat "$log")"
! grep -q "$tok" "$FIX/coder.calls" "$log" || fail "token leaked to argv or log"

# 3. CODER_URL wins.
CODER_URL="http://primary.test///" run_case
# a single trailing slash is stripped; extra ones are the operator's problem
[ "$(cat "$cfg/url")" = "http://primary.test//" ] || fail "CODER_URL did not win: $(cat "$cfg/url")"
CODER_URL="http://primary.test/" run_case
[ "$(cat "$cfg/url")" = "http://primary.test" ] || fail "CODER_URL did not win: $(cat "$cfg/url")"

# 4. Bad inputs: one WARNING, no session file, return 0.
DEV_CODER_TOKEN_FILE="$tmp/missing" run_case
one_warning "missing file"
: > "$tmp/empty"
DEV_CODER_TOKEN_FILE="$tmp/empty" run_case
one_warning "empty file"
printf '\n  \n' > "$tmp/blank"
DEV_CODER_TOKEN_FILE="$tmp/blank" run_case
one_warning "blank file"
(unset CODER_AGENT_URL; run_case; one_warning "no url")

# 5. coder not on PATH.
FIX=$(mktemp -d "$tmp/case.XXXXXX")
rc=0
(
  export CODER_CONFIG_DIR="$FIX/coderv2" PATH="/nonexistent"
  # shellcheck disable=SC1090
  . "$funcs"
  setup_coder_login
) > "$FIX/log" 2>&1 || rc=$?
[ "$rc" = 0 ] || fail "no coder: returned $rc"
[ "$(grep -c WARNING "$FIX/log")" = 1 ] || fail "no coder: $(cat "$FIX/log")"
[ ! -e "$FIX/coderv2/session" ] || fail "no coder: a session file was written"

# 6. A failing whoami: a WARNING, return 0 (the session stays written).
STUB_WHOAMI_FAIL=1 run_case
[ "$(warnings)" = 1 ] || fail "whoami failure: $(cat "$log")"
! grep -q "$tok" "$log" || fail "token in the failure log"

echo "coder-login: ok"
