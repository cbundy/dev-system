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
if [ "$1" = api ]; then
  shift
  [ "$1" != -i ] || shift
  echo "$1" >> "$FX/calls"
  key=$(printf '%s' "$1" | tr -c 'A-Za-z0-9\n' '_')
  [ ! -f "$FX/$key.sleep" ] || sleep "$(cat "$FX/$key.sleep")"
  if [ -f "$FX/$key.err" ]; then
    cat "$FX/$key.err" >&2
    exit "$(cat "$FX/$key.code" 2>/dev/null || echo 1)"
  fi
  [ ! -f "$FX/$key.out" ] || cat "$FX/$key.out"
  exit 0
fi
[ "$1 $2" = "auth status" ] || exit 1
[ -z "$ACTIVE" ] || printf '{"hosts":{"github.com":[{"login":"%s","active":true,"state":"success"}]}}\n' "$ACTIVE"
STUB
chmod +x "$tmp/bin/gh"
mkdir "$tmp/fx"
export PATH="$tmp/bin:$PATH" GH_CONFIG_DIR="$tmp/cfg" FX="$tmp/fx"

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

# --- token access check (cbundy/dev-system#729) ---------------------------------
access() {
  eval 'fail() { fail_ "$@"; }'
  gh_token_access_doctor "$@"
  eval 'fail() { echo "FAIL: $*" >&2; exit 1; }'
}
reset_fx() { rm -rf "${FX:?}"/*; }
# fx <key> <exit code> <stderr>: make a path fail like gh does
fx() { printf '%s\n' "$3" > "$FX/$1.err"; echo "$2" > "$FX/$1.code"; }
calls() { cat "$FX/calls" 2>/dev/null || true; }
classic() { printf 'HTTP/2.0 200 OK\r\nX-Oauth-Scopes: %s\r\n\r\n{"login":"x"}\n' "$1" > "$FX/_user.out"; }
fine() { printf 'HTTP/2.0 200 OK\r\nContent-Type: json\r\n\r\n{"login":"x"}\n' > "$FX/_user.out"; }
meta() { echo '{"default_branch":"trunk"}' > "$FX/repos_o_r.out"; }
REPO=https://github.com/o/r.git

echo "gh_repo_slug"
[ "$(gh_repo_slug https://github.com/o/r)" = o/r ] || fail "slug https"
[ "$(gh_repo_slug https://github.com/o/r.git)" = o/r ] || fail "slug https .git"
[ "$(gh_repo_slug https://github.com/o/r/)" = o/r ] || fail "slug trailing slash"
[ "$(gh_repo_slug git@github.com:o/r.git)" = o/r ] || fail "slug ssh"
[ -z "$(gh_repo_slug https://gitlab.com/o/r.git)" ] || fail "slug other host"
[ -z "$(gh_repo_slug '')" ] || fail "slug empty"

echo "gh_probe_class"
[ "$(gh_probe_class 0 '')" = ok ] || fail "class ok"
[ "$(gh_probe_class 1 'gh: Not Found (HTTP 404)')" = denied ] || fail "class 404"
[ "$(gh_probe_class 1 'gh: Resource not accessible (HTTP 403)')" = denied ] || fail "class 403"
[ "$(gh_probe_class 1 'gh: Bad credentials (HTTP 401)')" = bad ] || fail "class 401"
[ "$(gh_probe_class 1 'gh: API rate limit exceeded (HTTP 403)')" = limited ] || fail "class rate limit"
[ "$(gh_probe_class 1 'error connecting to api.github.com')" = offline ] || fail "class offline"
[ "$(gh_probe_class 124 '')" = offline ] || fail "class timeout"

echo "a classic token without workflow fails naming workflow only"
reset_fx; classic "repo, read:org"
out=$(access "$REPO")
expect "FAIL the classic token lacks the workflow scope" classic-no-workflow
refuse "lacks the repo scope" classic-no-workflow
refuse "OK" classic-no-workflow
[ "$(calls)" = /user ] || fail "classic token ran repo probes: $(calls)"

echo "a classic token with only public_repo and workflow fails naming repo"
reset_fx; classic "public_repo, workflow"
out=$(access "$REPO")
expect "FAIL the classic token lacks the repo scope" classic-public-repo
refuse "lacks the workflow scope" classic-public-repo

echo "an empty scopes header is still a classic token"
reset_fx; classic ""
out=$(access "$REPO")
expect "lacks the repo scope" classic-empty
expect "lacks the workflow scope" classic-empty

echo "a classic token with repo and workflow is OK"
reset_fx; classic "repo, workflow"
out=$(access "$REPO")
refuse FAIL classic-ok
expect "OK   the classic token has the repo and workflow scopes" classic-ok

echo "a fine-grained token with all probes passing: six OK lines, the write INFO, no write OK"
reset_fx; fine; meta
out=$(access "$REPO")
refuse FAIL fine-ok
[ "$(printf '%s\n' "$out" | grep -c '^OK')" = 6 ] || fail "expected six OK lines: $out"
expect "INFO write access unchecked: give the token read and write on contents, issues, pull requests and workflows" fine-ok
printf '%s\n' "$out" | grep '^OK' | grep -qi write && fail "an OK line mentions write: $out"
calls | grep -qx 'repos/o/r/contents/?ref=trunk' || fail "contents probe not on the default branch: $(calls)"
calls | grep -qx 'repos/o/r/commits/trunk/check-runs?per_page=1' || fail "checks probe missing: $(calls)"

echo "a fine-grained token whose issues probe is 403 fails naming issues"
reset_fx; fine; meta
fx "repos_o_r_issues_per_page_1" 1 "gh: Resource not accessible by personal access token (HTTP 403)"
out=$(access "$REPO")
expect "FAIL the token cannot read issues on o/r" fine-issues
expect "fix: edit the token at github.com/settings/personal-access-tokens: give it Issues: read" fine-issues
[ "$(printf '%s\n' "$out" | grep -c '^FAIL')" = 1 ] || fail "only issues should fail: $out"
[ "$(printf '%s\n' "$out" | grep -c '^OK')" = 5 ] || fail "five probes should pass: $out"

echo "a metadata 404 fails naming repo access and stops the probes"
reset_fx; fine
fx repos_o_r 1 "gh: Not Found (HTTP 404)"
out=$(access "$REPO")
expect "FAIL the token has no access to o/r" meta-404
expect "add o/r to its repository access" meta-404
[ "$(calls)" = "$(printf '/user\nrepos/o/r')" ] || fail "probes ran after metadata failed: $(calls)"

echo "no repo known: INFO and no FAIL"
reset_fx; fine
out=$(access "")
expect "INFO no github.com repo known" no-repo
refuse FAIL no-repo
rm -f "$FX/calls"
out=$(access "https://gitlab.com/o/r.git")
expect "INFO no github.com repo known" other-host
[ "$(calls)" = /user ] || fail "repo probes ran with no repo: $(calls)"

echo "offline: one INFO, the later probes do not run"
reset_fx; fine; meta
fx repos_o_r_issues_per_page_1 1 "error connecting to api.github.com"
out=$(access "$REPO")
[ "$(printf '%s\n' "$out" | grep -c 'GitHub unreachable, token access unchecked')" = 1 ] || fail "expected one unreachable INFO: $out"
refuse FAIL offline
calls | grep -q pulls && fail "probes ran after the offline one: $(calls)"
reset_fx; fine; meta
echo 5 > "$FX/repos_o_r_pulls_per_page_1.sleep"
out=$(GH_PROBE_TIMEOUT=1 access "$REPO")
expect "INFO GitHub unreachable, token access unchecked" timeout
refuse FAIL timeout
calls | grep -q actions && fail "probes ran after the timeout: $(calls)"

echo "401 is a rejected token, a rate-limit 403 is INFO"
reset_fx; fine
fx _user 1 "gh: Bad credentials (HTTP 401)"
out=$(access "$REPO")
expect "FAIL the token is rejected by GitHub" rejected
expect "fix: replace the token file" rejected
reset_fx; fine
fx _user 1 "gh: API rate limit exceeded for user (HTTP 403)"
out=$(access "$REPO")
expect "INFO GitHub rate limit reached, token access unchecked" user-rate-limit
refuse unreachable user-rate-limit
refuse FAIL user-rate-limit
[ "$(calls)" = /user ] || fail "repo probes ran after the rate-limited /user: $(calls)"
reset_fx; fine
fx _user 1 "error connecting to api.github.com"
out=$(access "$REPO")
expect "INFO GitHub unreachable, token access unchecked" user-offline
refuse FAIL user-offline
reset_fx; fine; meta
fx repos_o_r_actions_runs_per_page_1 1 "gh: API rate limit exceeded for user (HTTP 403)"
out=$(access "$REPO")
expect "INFO GitHub rate limit reached, so actions access is unchecked" rate-limit
refuse FAIL rate-limit

echo "dev-doctor skips its workflow-scope block in token mode and calls the access check"
grep -qF 'if command -v gh >/dev/null 2>&1 && ! gh_token_mode; then' "$BASE/dev-doctor" || fail "workflow-scope block is not guarded by gh_token_mode"
grep -qF 'case "$(gh_workflow_scope)" in' "$BASE/dev-doctor" || fail "workflow-scope block is gone"
grep -qF 'gh_token_access_doctor' "$BASE/dev-doctor" || fail "dev-doctor does not call gh_token_access_doctor"

echo "gh-token-doctor tests passed"
