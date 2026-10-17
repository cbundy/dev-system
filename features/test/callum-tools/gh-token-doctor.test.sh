#!/bin/bash
# shellcheck disable=SC2016 # the stub scripts are written with literal $ on purpose
#
# Plain-shell tests for the token-mode half of dev-doctor and the effective trusted list
# (cbundy/dev-system#728): gh_token_doctor (images/base/gh.sh) with the identity file and gh
# stubbed, and trusted_authors_effective. No network, Docker or real login.
# The suite runner starts suites with sh; gh.sh and dev-init are bash.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -eu

for name in $(env | sed -n 's/^\(DEV_[A-Za-z0-9_]*\)=.*/\1/p; s/^\(GIT_\(AUTHOR\|COMMITTER\)_[A-Z]*\)=.*/\1/p'); do
  unset "$name"
done
unset CALLUM_FLOW_TRUSTED_AUTHORS GH_TOKEN GITHUB_TOKEN

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
BASE="$SCRIPT_DIR/../../../images/base"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || fail "jq is required to run this test"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin" "$tmp/cfg"
cat > "$tmp/bin/gh" <<'STUB'
#!/bin/sh
[ "$1 $2" = "auth status" ] || exit 1
[ -z "$ACTIVE" ] || printf '{"hosts":{"github.com":[{"login":"%s","active":true,"state":"success"}]}}\n' "$ACTIVE"
STUB
chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH" GH_CONFIG_DIR="$tmp/cfg"

# shellcheck source=/dev/null
. "$BASE/gh.sh"
# shellcheck source=/dev/null
. "$BASE/trusted-authors.sh"

ok() { echo "OK   $1"; }
info() { echo "INFO $1"; }
fail_() { printf 'FAIL %s\n     fix: %s\n' "$1" "$2"; }
IDF="$tmp/cfg/dev-system-identity.json"
echo 'x' > "$tmp/token"

doctor() {
  # fail is the test's own reporter inside the doctor; restore it afterwards
  eval 'fail() { fail_ "$@"; }'
  gh_token_doctor
  eval 'fail() { echo "FAIL: $*" >&2; exit 1; }'
}
good_identity() { printf '%s\n' '{"login":"TokenBot","id":777,"name":"Token Bot","email":"777+TokenBot@users.noreply.github.com"}' > "$IDF"; }
expect() { printf '%s\n' "$out" | grep -qF -- "$1" || fail "$2: '$1' missing from: $out"; }
refuse() { ! printf '%s\n' "$out" | grep -qF -- "$1" || fail "$2: '$1' present in: $out"; }

export DEV_GH_TOKEN_FILE="$tmp/token"
export CALLUM_FLOW_TRUSTED_AUTHORS=cbundy:13131067

echo "healthy token mode"
good_identity
out=$(ACTIVE=tokenbot doctor)
refuse FAIL "healthy"
expect "gh's active github.com login is the token's account" healthy

echo "effective list: merged, deduplicated by id and login case"
[ "$(trusted_authors_effective)" = "cbundy:13131067,TokenBot:777" ] || fail "effective: $(trusted_authors_effective)"
[ "$(CALLUM_FLOW_TRUSTED_AUTHORS=cbundy:13131067,tokenbot:777 trusted_authors_effective)" = "cbundy:13131067,tokenbot:777" ] || fail "dedupe"
[ "$(CALLUM_FLOW_TRUSTED_AUTHORS='' trusted_authors_effective)" = "TokenBot:777" ] || fail "identity alone"
[ "$(DEV_GH_TOKEN_FILE='' trusted_authors_effective)" = "cbundy:13131067" ] || fail "token mode off ignores the file"
CALLUM_FLOW_TRUSTED_AUTHORS=cbundy:13131067 trusted_authors_check >/dev/null || fail "check passes"
[ "$(trusted_authors_json)" = '[{"login":"cbundy","id":13131067},{"login":"tokenbot","id":777}]' ] || fail "json: $(trusted_authors_json)"

echo "an untrusted token account is a FAIL"
(
  # The account is in the file but the list cannot see it: simulate by a login that is not valid for the list.
  printf '%s\n' '{"login":"Token Bot","id":777,"name":"n","email":"e"}' > "$IDF"
  out=$(ACTIVE="Token Bot" doctor)
  expect "is not in the effective trusted authors" untrusted
  expect "fix:" untrusted
)

echo "an active login that is not the token's is a FAIL"
good_identity
out=$(ACTIVE=someoneelse doctor)
expect "FAIL gh's active github.com login (someoneelse) is not the token's account (TokenBot)" other-login
out=$(ACTIVE='' doctor)
expect "(none)" no-login

echo "a missing token file and a missing identity are a FAIL with a fix"
rm -f "$tmp/token"
out=$(ACTIVE=tokenbot doctor)
expect "FAIL DEV_GH_TOKEN_FILE ($tmp/token) is missing, empty or unreadable" no-token
echo x > "$tmp/token"
rm -f "$IDF"
out=$(ACTIVE=tokenbot doctor)
expect "FAIL the identity file $IDF is missing" no-identity
expect "fix: run: dev-init" no-identity

echo "overriding git identity variables are a FAIL naming each"
good_identity
out=$(ACTIVE=tokenbot GIT_AUTHOR_EMAIL=other@example.com GIT_COMMITTER_NAME=Someone doctor)
expect "FAIL GIT_AUTHOR_EMAIL (other@example.com) overrides" overrides
expect "FAIL GIT_COMMITTER_NAME (Someone) overrides" overrides
refuse GIT_AUTHOR_NAME overrides
out=$(ACTIVE=tokenbot GIT_AUTHOR_EMAIL=777+TokenBot@users.noreply.github.com GIT_AUTHOR_NAME="Token Bot" doctor)
refuse FAIL "matching overrides"

echo "outside token mode the doctor line keeps its wording"
grep -qF 'ok "CALLUM_FLOW_TRUSTED_AUTHORS is set ($(printf' "$BASE/dev-doctor" || fail "dev-doctor wording changed"
grep -qF 'trusted author(s))"' "$BASE/dev-doctor" || fail "dev-doctor wording changed"
grep -qF 'if gh_token_mode; then' "$BASE/dev-doctor" || fail "dev-doctor does not branch on token mode"

echo "gh-token-doctor tests passed"
