#!/bin/bash
# shellcheck disable=SC2016 # the stub scripts are written with literal $ on purpose
#
# Plain-shell test for dev-init's token step (cbundy/dev-system#728): with
# DEV_GH_TOKEN_FILE set, gh holds only that token's account, the identity file and git's
# user are written from it, and a bad token leaves no account and no identity. gh is a stub
# on PATH that records its argv and stdin; git is real except for clone and fetch, which a
# stub records (they must see no GIT_ASKPASS). No network, Docker or real login.
# The suite runner starts suites with sh; gh.sh and dev-init are bash.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -eu

for name in $(env | sed -n 's/^\(DEV_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$name"
done
unset GH_TOKEN GITHUB_TOKEN GIT_ASKPASS

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
BASE="$SCRIPT_DIR/.."

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

for t in jq git awk mktemp; do
  command -v "$t" >/dev/null 2>&1 || fail "$t is required to run this test"
done
REAL_GIT=$(command -v git)

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
bin="$tmp/bin"
FIX="$tmp/fix"
mkdir "$bin" "$FIX"
export FIX REAL_GIT

# dev-init's own functions, taken from the script so the test runs what ships.
funcs="$tmp/funcs.sh"
{
  echo '. "'"$BASE"'/gh.sh"'
  echo 'log() { echo "dev-init: $*" >&2; }'
  for f in gh_remove_accounts setup_gh_token has_git_credential git_reason sync_repo; do
    sed -n "/^$f() {/,/^}/p" "$BASE/dev-init"
  done
} > "$funcs"
[ "$(grep -c '^setup_gh_token() {' "$funcs")" = 1 ] || fail "setup_gh_token not found in dev-init"
[ "$(grep -c '^sync_repo() {' "$funcs")" = 1 ] || fail "sync_repo not found in dev-init"

cat > "$bin/gh" <<'STUB'
#!/bin/sh
echo "$*" >> "$FIX/gh.calls"
case "$1 ${2:-}" in
  "auth status")
    printf '{"hosts":{"github.com":['
    sep=""
    while IFS= read -r u; do
      [ -n "$u" ] || continue
      printf '%s{"login":"%s","active":true,"state":"success"}' "$sep" "$u"
      sep=","
    done < "$FIX/accounts"
    printf ']}}\n' ;;
  "auth logout")
    [ "$3 $4 $5 $6" = "--hostname github.com --user $6" ] || exit 1
    grep -vxF "$6" "$FIX/accounts" > "$FIX/accounts.new" || true
    mv "$FIX/accounts.new" "$FIX/accounts" ;;
  "auth login")
    cat > "$FIX/login.stdin"
    if grep -q BADTOKEN "$FIX/login.stdin"; then echo "error validating token" >&2; exit 1; fi
    echo tokenuser >> "$FIX/accounts" ;;
  "auth setup-git") : ;;
  "api user")
    [ ! -f "$FIX/api.fail" ] || exit 1
    cat "$FIX/user.json" ;;
  *) echo "unexpected gh $*" >> "$FIX/gh.unexpected"; exit 1 ;;
esac
STUB
cat > "$bin/git" <<'STUB'
#!/bin/sh
for a in "$@"; do
  case "$a" in
    clone | fetch)
      echo "${GIT_ASKPASS-unset}" >> "$FIX/git.askpass"
      case "$a" in clone) for last; do :; done; mkdir -p "$last/.git" ;; esac
      exit 0 ;;
  esac
done
exec "$REAL_GIT" "$@"
STUB
chmod +x "$bin/gh" "$bin/git"

SECRET=ghp_SECRETTOKENVALUE
reset() {
  rm -rf "${tmp:?}/home" "${tmp:?}/gh" "${FIX:?}"/* "${tmp:?}/ws"
  mkdir -p "$tmp/home" "$tmp/gh"
  printf 'olduser\nother\n' > "$FIX/accounts"
  printf 'github.com:\n    users:\n        olduser:\n    user: olduser\n' > "$tmp/gh/hosts.yml"
  printf 'editor: vim\n' >> "$tmp/gh/hosts.yml"
  echo '{"login":"TokenUser","id":4242,"name":"Token User"}' > "$FIX/user.json"
  printf '%s\n' "$SECRET" > "$tmp/token"
}
# run <function> [env...]: the function under a clean HOME and GH_CONFIG_DIR.
run() {
  fn=$1
  shift
  set +e
  env HOME="$tmp/home" GH_CONFIG_DIR="$tmp/gh" PATH="$bin:$PATH" "$@" bash -c ". '$funcs'; $fn" > "$tmp/out" 2>&1
  rc=$?
  set -e
}
IDF="$tmp/gh/dev-system-identity.json"
accounts() { tr '\n' ' ' < "$FIX/accounts"; }
no_secret() { ! grep -rqF --exclude=login.stdin "$SECRET" "$tmp/out" "$FIX" "$tmp/home" "$tmp/gh" 2>/dev/null || fail "$1: the token leaked"; }
single_line() { [ "$(grep -c . "$tmp/out")" = 1 ] || fail "$1: expected one log line, got: $(cat "$tmp/out")"; }

echo "token mode on: login, identity, git config"
reset
run setup_gh_token DEV_GH_TOKEN_FILE="$tmp/token"
[ "$rc" = 0 ] || fail "step exited $rc"
[ "$(cat "$FIX/login.stdin")" = "$SECRET" ] || fail "the token did not arrive on stdin"
grep -qxF "auth login --hostname github.com --with-token" "$FIX/gh.calls" || fail "login argv: $(cat "$FIX/gh.calls")"
! grep -qF "$SECRET" "$FIX/gh.calls" || fail "token in argv"
grep -qxF "auth logout --hostname github.com --user olduser" "$FIX/gh.calls" || fail "olduser not logged out"
grep -qxF "auth logout --hostname github.com --user other" "$FIX/gh.calls" || fail "other not logged out"
[ "$(accounts)" = "tokenuser " ] || fail "accounts left: $(accounts)"
grep -qxF "auth setup-git" "$FIX/gh.calls" || fail "setup-git not run"
! grep -q '^github.com:' "$tmp/gh/hosts.yml" || fail "hosts.yml still has github.com"
grep -qxF "editor: vim" "$tmp/gh/hosts.yml" || fail "hosts.yml lost unrelated config"
[ "$(stat -c %a "$IDF")" = 600 ] || fail "identity mode $(stat -c %a "$IDF")"
[ "$(jq -c . "$IDF")" = '{"login":"TokenUser","id":4242,"name":"Token User","email":"4242+TokenUser@users.noreply.github.com"}' ] \
  || fail "identity: $(cat "$IDF")"
[ "$(HOME="$tmp/home" git config --global user.name)" = "Token User" ] || fail "git user.name"
[ "$(HOME="$tmp/home" git config --global user.email)" = "4242+TokenUser@users.noreply.github.com" ] || fail "git user.email"
no_secret "token mode on"
for f in "$tmp"/gh/.identity.*; do [ ! -e "$f" ] || fail "temp file left behind"; done

echo "DEV_GIT_EMAIL override and name fallback"
reset
echo '{"login":"TokenUser","id":4242,"name":null}' > "$FIX/user.json"
run setup_gh_token DEV_GH_TOKEN_FILE="$tmp/token" DEV_GIT_EMAIL=me@example.com
[ "$(jq -r '.email + "|" + .name' "$IDF")" = "me@example.com|TokenUser" ] || fail "override/fallback: $(cat "$IDF")"
[ "$(HOME="$tmp/home" git config --global user.email)" = "me@example.com" ] || fail "git email override"

echo "bad token files: one line, no identity, no account"
for case_ in missing empty unreadable rejected apifail; do
  reset
  echo '{"login":"stale","id":1}' > "$IDF"
  case $case_ in
    missing) rm "$tmp/token"; want="does not exist" ;;
    empty) : > "$tmp/token"; want="is empty" ;;
    unreadable) chmod 000 "$tmp/token"; want="not readable"; [ "$(id -u)" != 0 ] || continue ;;
    rejected) echo BADTOKEN > "$tmp/token"; want="GitHub rejected the token" ;;
    apifail) touch "$FIX/api.fail"; want="gh api user failed" ;;
  esac
  run setup_gh_token DEV_GH_TOKEN_FILE="$tmp/token"
  [ "$rc" = 0 ] || fail "$case_: exit $rc"
  single_line "$case_"
  grep -qF "$tmp/token" "$tmp/out" || fail "$case_: path not named: $(cat "$tmp/out")"
  grep -qF "$want" "$tmp/out" || fail "$case_: cause missing: $(cat "$tmp/out")"
  [ ! -e "$IDF" ] || fail "$case_: identity file kept"
  [ -z "$(accounts)" ] || fail "$case_: accounts left: $(accounts)"
  no_secret "$case_"
  [ ! -f "$tmp/token" ] || chmod 600 "$tmp/token"
done

echo "token mode off: nothing happens"
reset
echo '{"login":"stale","id":1}' > "$IDF"
run setup_gh_token
[ "$rc" = 0 ] || fail "off: exit $rc"
[ ! -s "$tmp/out" ] || fail "off: output $(cat "$tmp/out")"
[ ! -f "$FIX/gh.calls" ] || fail "off: gh called: $(cat "$FIX/gh.calls")"
[ -e "$IDF" ] || fail "off: identity file touched"
[ "$(accounts)" = "olduser other " ] || fail "off: accounts changed"

echo "clone and fetch see no GIT_ASKPASS in token mode"
reset
run sync_repo DEV_GH_TOKEN_FILE="$tmp/token" GIT_ASKPASS=/bin/askpass DEV_REPO_URL=https://github.com/o/r.git DEV_WORKSPACE="$tmp/ws"
[ "$(cat "$FIX/git.askpass")" = unset ] || fail "clone saw GIT_ASKPASS: $(cat "$FIX/git.askpass")"
rm -f "$FIX/git.askpass"
rm -rf "$tmp/ws"
"$REAL_GIT" init -q "$tmp/ws"
"$REAL_GIT" -C "$tmp/ws" remote add origin https://github.com/o/r.git
run sync_repo DEV_GH_TOKEN_FILE="$tmp/token" GIT_ASKPASS=/bin/askpass DEV_REPO_URL=https://github.com/o/r.git DEV_WORKSPACE="$tmp/ws"
[ "$(cat "$FIX/git.askpass")" = unset ] || fail "fetch saw GIT_ASKPASS: $(cat "$FIX/git.askpass" 2>&1)"

echo "without token mode, GIT_ASKPASS is kept"
reset
run sync_repo GIT_ASKPASS=/bin/askpass DEV_REPO_URL=https://github.com/o/r.git DEV_WORKSPACE="$tmp/ws"
[ "$(cat "$FIX/git.askpass")" = /bin/askpass ] || fail "askpass dropped outside token mode: $(cat "$FIX/git.askpass")"

echo "OK"
