#!/bin/sh
# shellcheck disable=SC2016 # the stub scripts are written with literal $ on purpose
#
# Plain-shell test for images/base/dev-login (cbundy/dev-system#375): checking logins must
# not spend GitHub API calls, and `watch` must back off.
#
# gh, claude, codex, tmux, sleep and curl are stubs on PATH answering from files in $FIX, so
# no network, Docker or real login is involved. The gh stub counts every `auth status` call
# (the only GitHub API call dev-login makes) in $FIX/status.calls; `auth token` is local.
set -eu

# Start from a clean host environment. Only settings assigned by this suite below
# may reach dev-login, including direct concurrent and timeout invocations.
for name in $(env | sed -n 's/^\(DEV_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$name"
done
unset GH_TOKEN GITHUB_TOKEN KUBERNETES_SERVICE_HOST
for name in $(env | sed -n 's/^\(CODER_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$name"
done

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
BASE="$SCRIPT_DIR/.."
CMD="$BASE/dev-login"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -f "$CMD" ] || fail "$CMD is missing"
for t in jq flock sha256sum; do
  command -v "$t" >/dev/null 2>&1 || fail "$t is required to run this test"
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
bin="$tmp/bin"
FIX="$tmp/fix"
mkdir "$bin" "$FIX"
export FIX

cat > "$bin/gh" <<'STUB'
#!/bin/sh
case "$1 ${2:-}" in
  "auth token") [ -f "$FIX/token" ] && cat "$FIX/token" ;;
  "auth status")
    echo "$*" >> "$FIX/status.calls"
    case " $* " in
      *" --active "*) ;;
      *) [ ! -f "$FIX/multiple-accounts" ] || echo "$*" >> "$FIX/status.calls" ;;
    esac
    reply=$(cat "$FIX/status.json")
    if [ "${GH_TEST_BLOCK:-0}" = 1 ]; then
      : > "$FIX/status.blocked"
      read -r release < "$FIX/status.release"
    fi
    printf '%s\n' "$reply" ;;
  *) echo "unexpected gh $*" >> "$FIX/gh.unexpected"; exit 1 ;;
esac
STUB
cat > "$bin/claude" <<'STUB'
#!/bin/sh
if [ -f "$FIX/claude-in" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'; else echo '{"loggedIn":false}'; fi
STUB
cat > "$bin/codex" <<'STUB'
#!/bin/sh
[ -f "$FIX/codex-in" ]
STUB
cat > "$bin/tmux" <<'STUB'
#!/bin/sh
cmd=$1
shift
name=""
while [ $# -gt 0 ]; do
  case $1 in -s | -t) name=$2; shift ;; esac
  shift
done
case $cmd in
  new-session) echo "$name" >> "$FIX/tmux.started"; : > "$FIX/session.$name" ;;
  has-session) [ -f "$FIX/session.$name" ]; exit $? ;;
  kill-session) rm -f "$FIX/session.$name" ;;
esac
exit 0
STUB
# sleep: instant. A wait of 10s or more is a `watch` backoff step: it is logged, and after
# $FIX/flip-after of them claude logs in, which ends the watch.
cat > "$bin/sleep" <<'STUB'
#!/bin/sh
if [ "$1" -ge 10 ] 2>/dev/null; then
  if [ -f "$FIX/login-gh-after-sleep" ]; then
    printf 'tok1\n' > "$FIX/token"
    rm "$FIX/login-gh-after-sleep"
  fi
  echo "$1" >> "$FIX/sleeps"
  n=$(wc -l < "$FIX/sleeps")
  [ "$n" -lt "$(cat "$FIX/flip-after" 2>/dev/null || echo 1000)" ] || : > "$FIX/claude-in"
  [ "$n" -lt 100 ] || exit 1
fi
exit 0
STUB
cat > "$bin/dev-init" <<'STUB'
#!/bin/sh
echo "$*" >> "$FIX/dev-init.args"
exit 1
STUB
cat > "$bin/curl" <<'STUB'
#!/bin/sh
echo "$*" >> "$FIX/curl.log"
STUB
chmod +x "$bin"/*

ok_json='{"hosts":{"github.com":[{"state":"success","active":true,"scopes":"repo, workflow"}]}}'
noscope_json='{"hosts":{"github.com":[{"state":"success","active":true,"scopes":"repo"}]}}'
ratelimit_json='{"hosts":{"github.com":[{"state":"error","active":true,"error":"HTTP 403: API rate limit exceeded for user"}]}}'
bad_json='{"hosts":{"github.com":[{"state":"error","active":true,"error":"HTTP 401: Bad credentials"}]}}'

# reset <token|none> <status json>: a fresh run dir, call counters and gh answers
reset() {
  rm -rf "$FIX" "$tmp/run"
  mkdir "$FIX"
  if [ "$1" = none ]; then rm -f "$FIX/token"; else printf '%s\n' "$1" > "$FIX/token"; fi
  printf '%s\n' "$2" > "$FIX/status.json"
  : > "$FIX/claude-in"
}

# dl <args...>: dev-login against the stubs and the checkout, as a normal user
dl() {
  env PATH="$bin:$PATH" DEV_SYSTEM_SHARE="$BASE" DEV_LOGIN_RUN_DIR="$tmp/run" HOSTNAME=testbox \
    DEV_LOGIN_TOOLS="${TOOLS:-claude,codex,gh}" bash "$CMD" "$@"
}

calls() {
  if [ -f "$FIX/status.calls" ]; then wc -l < "$FIX/status.calls" | tr -d ' '; else echo 0; fi
}

expect_calls() {
  [ "$(calls)" = "$1" ] || fail "$2: expected $1 gh auth status call(s), got $(calls)"
}

gh_state() {
  dl status --json "$@" 2>/dev/null | jq -r .gh.state
}

expect_state() {
  got=$1
  [ "$got" = "$2" ] || fail "$3: expected gh state $2, got $got"
}

# --- steady state: one call, then none ---------------------------------------------------
reset tok1 "$ok_json"
: > "$FIX/multiple-accounts"
expect_state "$(gh_state)" in "first check"
expect_calls 1 "first check"
i=0
while [ $i -lt 20 ]; do
  gh_state >/dev/null
  gh_state --cached >/dev/null
  i=$((i + 1))
done
expect_calls 1 "20 status + 20 status --cached"
dl status 2>/dev/null | grep -qx 'gh: in' || fail "text status should say gh: in"
expect_calls 1 "text status"
grep -q . "$tmp/run/gh-state" || fail "no cache file"
grep -q tok1 "$tmp/run/gh-state" && fail "the cache must hold a fingerprint, not the token"

# TTL expired: one more call; --cached never calls for an existing entry, however old
DEV_LOGIN_GH_TTL=0 gh_state >/dev/null
expect_calls 2 "expired TTL"
DEV_LOGIN_GH_TTL=0 gh_state --cached >/dev/null
expect_calls 2 "expired TTL with --cached"

# a changed token (a login, refresh or logout elsewhere) invalidates, even with --cached
printf 'tok2\n' > "$FIX/token"
printf '%s\n' "$noscope_json" > "$FIX/status.json"
expect_state "$(gh_state --cached)" scope "token changed"
expect_calls 3 "token changed with --cached"
expect_state "$(gh_state --cached)" scope "token changed, again"
expect_calls 3 "token changed, second look"

# --- no local token: out, no call --------------------------------------------------------
reset none "$ok_json"
expect_state "$(gh_state)" out "no token"
expect_state "$(gh_state --cached)" out "no token, cached"
expect_calls 0 "no token"

# GH_TOKEN: no gh call at all
reset tok1 "$ok_json"
expect_state "$(GH_TOKEN=x gh_state)" token "GH_TOKEN"
expect_calls 0 "GH_TOKEN"

# --- failures other than a bad token keep the previous state -----------------------------
reset tok1 "$ratelimit_json"
expect_state "$(gh_state)" in "rate limit, no previous state"
expect_calls 1 "rate limit"
gh_state >/dev/null
gh_state --cached >/dev/null
expect_calls 1 "rate limit is not retried within the TTL"

reset tok1 "$noscope_json"
expect_state "$(gh_state)" scope "previous scope"
printf '%s\n' "$ratelimit_json" > "$FIX/status.json"
expect_state "$(DEV_LOGIN_GH_TTL=0 gh_state)" scope "rate limit keeps the previous state"
expect_calls 2 "rate limit after scope"
printf '%s\n' "$bad_json" > "$FIX/status.json"
expect_state "$(DEV_LOGIN_GH_TTL=0 gh_state)" out "401 is out"
printf '%s\n' 'not json' > "$FIX/status.json"
expect_state "$(DEV_LOGIN_GH_TTL=0 gh_state)" out "malformed reply keeps the previous state"

reset tok1 "$ok_json"
expect_state "$(gh_state)" in "previous valid token"
printf '%s\n' '{"hosts":{"github.com":[{"state":"error","active":true,"error":"proxyconnect tcp: dial tcp 127.0.0.1:1401: connect: connection refused"}]}}' > "$FIX/status.json"
expect_state "$(DEV_LOGIN_GH_TTL=0 gh_state)" in "connection error containing 401 keeps the previous state"
expect_calls 2 "connection error after valid token"
expect_state "$(gh_state)" in "cached connection error"
expect_state "$(gh_state --cached)" in "cached connection error with --cached"
expect_calls 2 "connection error is cached"
printf '%s\n' '{"hosts":{"github.com":[{"state":"success","active":false,"scopes":"repo"}]}}' > "$FIX/status.json"
expect_state "$(DEV_LOGIN_GH_TTL=0 gh_state)" in "no active account keeps the previous state"
expect_calls 3 "no active account"
expect_state "$(gh_state --cached)" in "cached reply without an active account"
expect_calls 3 "reply without an active account is cached"

for transition in revoked logout; do
  reset tok1 "$ok_json"
  expect_state "$(gh_state)" in "before concurrent $transition"
  printf '%s\n' "$ratelimit_json" > "$FIX/status.json"
  mkfifo "$FIX/status.release"
  timeout 10 env PATH="$bin:$PATH" DEV_SYSTEM_SHARE="$BASE" DEV_LOGIN_RUN_DIR="$tmp/run" HOSTNAME=testbox \
    DEV_LOGIN_GH_TTL=0 GH_TEST_BLOCK=1 bash "$CMD" status --json > "$FIX/first.json" 2> "$FIX/first.err" &
  first_pid=$!
  i=0
  while [ ! -f "$FIX/status.blocked" ]; do
    i=$((i + 1))
    [ "$i" -lt 100 ] || fail "first $transition check did not reach gh"
    sleep 0.05
  done
  if [ "$transition" = revoked ]; then
    printf '%s\n' "$bad_json" > "$FIX/status.json"
  else
    rm -f "$FIX/token"
  fi
  rc=0
  timeout 1 env PATH="$bin:$PATH" DEV_SYSTEM_SHARE="$BASE" DEV_LOGIN_RUN_DIR="$tmp/run" HOSTNAME=testbox \
    DEV_LOGIN_GH_TTL=0 bash "$CMD" status --json > "$FIX/second.json" 2> "$FIX/second.err" || rc=$?
  [ "$rc" = 124 ] || fail "concurrent $transition must wait for the in-flight cache update (exit $rc)"
  expect_calls 2 "blocked concurrent $transition"
  printf 'release\n' > "$FIX/status.release"
  wait "$first_pid" || fail "first $transition check failed"
  expect_state "$(jq -r .gh.state "$FIX/first.json")" in "transient failure during $transition"
  expect_state "$(DEV_LOGIN_GH_TTL=0 gh_state)" out "serialized $transition"
  expect_state "$(gh_state --cached)" out "cached state after $transition"
  if [ "$transition" = revoked ]; then
    expect_calls 3 "serialized revocation"
  else
    expect_calls 2 "serialized logout"
    [ ! -f "$tmp/run/gh-state" ] || fail "logout must remove the cached token state"
  fi
done

# --- optional codex ----------------------------------------------------------------------
reset tok1 "$ok_json"
dl status --json 2>/dev/null | jq -e '.codex.optional == true and .codex.state == "out" and (.claude | has("optional") | not)' >/dev/null \
  || fail "status --json should mark codex optional"
dl start >/dev/null 2>&1
[ ! -f "$FIX/tmux.started" ] || fail "start must not start codex (optional): $(cat "$FIX/tmux.started")"
dl start --optional >/dev/null
grep -qx login-codex "$FIX/tmux.started" || fail "start --optional should start codex"
rm -f "$FIX/tmux.started" "$FIX/session.login-codex"
# the watcher does not wait for it, and exits at once
timeout 20 env PATH="$bin:$PATH" DEV_SYSTEM_SHARE="$BASE" DEV_LOGIN_RUN_DIR="$tmp/run" HOSTNAME=testbox bash "$CMD" watch >/dev/null 2>&1 \
  || fail "watch should exit 0 with only codex missing"
[ ! -f "$FIX/tmux.started" ] || fail "watch must not start codex"
[ ! -f "$FIX/sleeps" ] || fail "watch should not have slept"
[ ! -f "$FIX/dev-init.args" ] || fail "plain watch must not invoke dev-init"
# an empty DEV_LOGIN_OPTIONAL makes codex required again
DEV_LOGIN_OPTIONAL="" dl status --json 2>/dev/null | jq -e '.codex | has("optional") | not' >/dev/null \
  || fail "DEV_LOGIN_OPTIONAL= should make codex required"

reset tok1 "$ok_json"
: > "$FIX/codex-in"
for tool in claude codex gh; do
  : > "$FIX/session.login-$tool"
done
timeout 20 env PATH="$bin:$PATH" DEV_SYSTEM_SHARE="$BASE" DEV_LOGIN_RUN_DIR="$tmp/run" HOSTNAME=testbox bash "$CMD" watch >/dev/null 2>&1 \
  || fail "watch should exit 0 with all tools logged in"
for tool in claude codex gh; do
  [ ! -f "$FIX/session.login-$tool" ] || fail "watch must clean up the completed $tool attempt"
done
[ ! -f "$FIX/tmux.started" ] || fail "watch must not start attempts with all tools logged in"
[ ! -f "$FIX/sleeps" ] || fail "watch should not sleep with all tools logged in"
expect_calls 1 "completed attempts cleanup"
[ ! -f "$FIX/dev-init.args" ] || fail "plain watch must not invoke dev-init"

# --- watch backs off, and gives up on gh's scope -----------------------------------------
reset tok1 "$noscope_json"
rm -f "$FIX/claude-in"
: > "$FIX/codex-in"
echo 7 > "$FIX/flip-after"
err="$tmp/watch.err"
timeout 60 env PATH="$bin:$PATH" DEV_SYSTEM_SHARE="$BASE" DEV_LOGIN_RUN_DIR="$tmp/run" HOSTNAME=testbox \
  DEV_LOGIN_WATCH_MAX=80 DEV_NOTIFY_URL=http://notify.invalid/t bash "$CMD" watch --name t >/dev/null 2>"$err" \
  || { cat "$err" >&2; fail "watch did not finish"; }
[ "$(tr '\n' ' ' < "$FIX/sleeps")" = "15 30 60 80 80 80 80 " ] \
  || fail "backoff steps should double and cap: $(tr '\n' ' ' < "$FIX/sleeps")"
[ "$(grep -c 'not refreshing it unattended' "$err")" = 1 ] || fail "gh scope should be reported once: $(cat "$err")"
[ "$(grep -c 'needs the workflow scope' "$FIX/curl.log")" = 1 ] || fail "one notification for the scope: $(cat "$FIX/curl.log")"
[ "$(grep -c 'Log in to claude' "$FIX/curl.log")" = 1 ] || fail "one notification for claude: $(cat "$FIX/curl.log")"
{ [ "$(grep -c . "$FIX/tmux.started")" = 1 ] && grep -qx login-claude "$FIX/tmux.started"; } \
  || fail "only one claude attempt, no gh refresh and no codex: $(cat "$FIX/tmux.started")"
expect_calls 1 "a whole watch"
[ ! -f "$FIX/session.login-claude" ] || fail "watch must clean up Claude's attempt after an external login"
[ ! -f "$FIX/gh.unexpected" ] || fail "unexpected gh calls: $(cat "$FIX/gh.unexpected")"

[ ! -f "$FIX/dev-init.args" ] || fail "plain watch must not invoke dev-init"

# a changed set of pending logins starts the backoff over
reset tok1 "$ok_json"
rm -f "$FIX/claude-in"
echo 4 > "$FIX/flip-after"
timeout 60 env PATH="$bin:$PATH" DEV_SYSTEM_SHARE="$BASE" DEV_LOGIN_RUN_DIR="$tmp/run" HOSTNAME=testbox \
  DEV_LOGIN_WATCH_MAX=80 bash "$CMD" watch >/dev/null 2>&1 || fail "second watch did not finish"
[ "$(tr '\n' ' ' < "$FIX/sleeps")" = "15 30 60 80 " ] || fail "backoff steps: $(tr '\n' ' ' < "$FIX/sleeps")"

[ ! -f "$FIX/dev-init.args" ] || fail "plain watch must not invoke dev-init"

# A GitHub login transition must not clone a repo inherited from the host.
reset none "$ok_json"
rm -f "$FIX/claude-in"
: > "$FIX/login-gh-after-sleep"
echo 2 > "$FIX/flip-after"
timeout 20 env PATH="$bin:$PATH" DEV_SYSTEM_SHARE="$BASE" DEV_LOGIN_RUN_DIR="$tmp/run" HOSTNAME=testbox \
  bash "$CMD" watch > /dev/null 2>"$err" \
  || { cat "$err" >&2; fail "plain GitHub transition watch did not finish"; }
[ ! -f "$FIX/dev-init.args" ] || fail "plain watch must not invoke dev-init"

# Explicit repo configuration reaches only the failing stub, never host dev-init.
reset none "$ok_json"
: > "$FIX/login-gh-after-sleep"
timeout 20 env PATH="$bin:$PATH" DEV_SYSTEM_SHARE="$BASE" DEV_LOGIN_RUN_DIR="$tmp/run" HOSTNAME=testbox \
  DEV_REPO_URL=https://repo.invalid/test.git bash "$CMD" watch >/dev/null 2>&1 \
  || fail "explicit repo watch did not finish"
[ "$(cat "$FIX/dev-init.args")" = '--repo' ] || fail "dev-init stub must receive --repo once"

# --- the exec hint names the way in for this environment (#98) ---------------------------
reset none "$ok_json"
dl status 2>/dev/null | grep -q 'docker exec -it testbox' || fail "no Coder: hint should say docker exec"
out=$(DEV_CODER_WORKSPACE=ws1 dl status 2>/dev/null)
echo "$out" | grep -q 'coder ssh ws1 -- tmux attach -t login-gh' || fail "Coder hint missing: $out"
echo "$out" | grep -q 'docker exec' && fail "Coder hint must not say docker exec"

echo "dev-login: ok"
