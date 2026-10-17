# shellcheck shell=bash
# gh.sh: what gh's GitHub login can do, for dev-login and dev-doctor.
# Sourced, never run:
#   . /usr/local/share/dev-system/gh.sh
#
# gh_workflow_scope: whether gh's token for github.com has the `workflow`
# scope, which pushing a change under .github/workflows/ needs
# (cbundy/dev-system#181). Prints one word:
#   yes      the token has it
#   no       the token's scopes were read and `workflow` is not one of them
#   unknown  the scopes could not be read: not logged in, offline, a gh too
#            old for `auth status --json`, or a token with no OAuth scopes
#            (a fine-grained token, a GitHub App's). Never a reason to prompt.
# Reads `gh auth status --json hosts`: the active account's scopes, from a
# check that succeeded, as one comma-separated string.
gh_workflow_scope() {
  local scopes
  scopes=$(gh auth status --json hosts --hostname github.com --active 2>/dev/null \
    | jq -r '[.hosts["github.com"][]? | select(.active == true and .state == "success")][0].scopes // empty | strings' 2>/dev/null) \
    || scopes=""
  if [ -z "${scopes//[ ,]/}" ]; then
    echo unknown
  elif printf '%s\n' "$scopes" | tr ',' '\n' | tr -d ' ' | grep -qx workflow; then
    echo yes
  else
    echo no
  fi
}

# gh_login_state <json>: gh's login state from one `gh auth status --json hosts
# --hostname github.com --active` reply, a pure function so it needs no network
# (cbundy/dev-system#375). Prints one word:
#   in       the active account's check succeeded, and its token has the
#            `workflow` scope (or its scopes cannot be read, which counts as in)
#   scope    the check succeeded and the scopes lack `workflow`
#   out      the check failed with HTTP 401: the token is bad
#   unknown  anything else: another error (a rate-limit 403, a network failure),
#            or a reply that is not the expected JSON. Never a reason to prompt;
#            the caller keeps what it knew.
# The reply carries state `error` plus an `error` text and gh still exits 0, so
# the exit status says nothing; only the JSON is read.
gh_login_state() {
  printf '%s' "${1:-}" | jq -r '
    [.hosts["github.com"][]? | select(.active == true)][0] as $a
    | if $a == null then "unknown"
      elif $a.state == "success" then
        (($a.scopes // "") | tostring | gsub("[ ]"; "") | split(",") | map(select(. != ""))) as $s
        | if ($s | length) == 0 or ($s | index("workflow")) != null then "in" else "scope" end
      elif $a.state == "error" then
        (if (($a.error // "") | tostring | test("HTTP 401\\b|Bad credentials")) then "out" else "unknown" end)
      else "unknown" end' 2>/dev/null | grep -x -e in -e scope -e out -e unknown || echo unknown
}

# --- token mode (cbundy/dev-system#728) ---------------------------------------
# DEV_GH_TOKEN_FILE set and non-empty puts a workspace in token mode: dev-init logs
# gh in with that file's token (and nothing else), and records the token account in
# an identity file that dev-doctor, the git config and the trusted-author list read.

# gh_token_mode: true when DEV_GH_TOKEN_FILE is set and non-empty.
gh_token_mode() {
  [ -n "${DEV_GH_TOKEN_FILE:-}" ]
}

# gh_identity_file: where dev-init writes the token account, {login, id, name,
# email}, mode 0600, never a token. trusted-authors.sh derives the same path.
gh_identity_file() {
  echo "${GH_CONFIG_DIR:-/persist/gh}/dev-system-identity.json"
}

# gh_identity_field <field>: one field of the identity file; empty when the file
# or the field is missing or the file is not JSON.
gh_identity_field() {
  jq -r --arg f "$1" 'if type == "object" then (.[$f] // empty) | tostring else empty end' "$(gh_identity_file)" 2>/dev/null
}

# gh_noreply_email <id> <login>: GitHub's no-reply commit address for an account.
gh_noreply_email() {
  echo "$1+$2@users.noreply.github.com"
}

# gh_active_login: the login of gh's active github.com account; empty when none.
gh_active_login() {
  gh auth status --json hosts --hostname github.com --active 2>/dev/null \
    | jq -r '[.hosts["github.com"][]? | select(.active == true)][0].login // empty' 2>/dev/null
}

# gh_token_doctor: dev-doctor's token-mode checks. The caller defines ok, info and
# fail (fail <message> <fix>), and has sourced trusted-authors.sh.
gh_token_doctor() {
  local tf="$DEV_GH_TOKEN_FILE" idf login id active var want
  idf=$(gh_identity_file)
  if [ ! -r "$tf" ] || ! grep -q '[^[:space:]]' "$tf" 2>/dev/null; then
    fail "DEV_GH_TOKEN_FILE ($tf) is missing, empty or unreadable" \
      "provision the token file (Coder: the workspace's token secret), then run: dev-init"
  else
    ok "DEV_GH_TOKEN_FILE ($tf) is readable"
  fi
  if [ ! -r "$idf" ]; then
    fail "the identity file $idf is missing" "run: dev-init (it resolves the token's account; the token must be valid)"
    return 0
  fi
  login=$(gh_identity_field login)
  id=$(gh_identity_field id)
  active=$(gh_active_login)
  if [ "$(printf '%s' "$active" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$login" | tr '[:upper:]' '[:lower:]')" ] && [ -n "$login" ]; then
    ok "gh's active github.com login is the token's account ($login)"
  else
    fail "gh's active github.com login (${active:-none}) is not the token's account (${login:-unknown})" \
      "run: dev-init (it removes every other account and logs in with the token file)"
  fi
  want=$(printf '%s' "$login" | tr '[:upper:]' '[:lower:]')
  if ! trusted_authors_effective | tr ',' '\n' | tr '[:upper:]' '[:lower:]' | grep -qx "$want:$id"; then
    fail "the token's account ($login:$id) is not in the effective trusted authors" \
      "run: dev-init, and check the identity file $idf"
  fi
  for var in GIT_AUTHOR_NAME GIT_COMMITTER_NAME; do
    if [ -n "${!var:-}" ] && [ "${!var}" != "$(gh_identity_field name)" ]; then
      fail "$var (${!var}) overrides the token account's git name ($(gh_identity_field name))" "unset $var"
    fi
  done
  for var in GIT_AUTHOR_EMAIL GIT_COMMITTER_EMAIL; do
    if [ -n "${!var:-}" ] && [ "${!var}" != "$(gh_identity_field email)" ]; then
      fail "$var (${!var}) overrides the token account's git email ($(gh_identity_field email))" "unset $var"
    fi
  done
}

# --- token access check (cbundy/dev-system#729) -------------------------------
# Read-only probes of what the token can reach, so dev-doctor names a missing scope
# or permission before a loop run hits it. Nothing here writes, and the token is
# never printed.

# gh_repo_slug <url>: owner/repo from a github.com https or ssh URL (a trailing
# .git and / removed); empty for anything else.
gh_repo_slug() {
  local u="${1:-}" slug
  u="${u%/}"
  u="${u%.git}"
  u="${u%/}"
  case "$u" in
    https://github.com/* | http://github.com/*) slug="${u#*://github.com/}" ;;
    https://*@github.com/*) slug="${u#*@github.com/}" ;;
    git@github.com:*) slug="${u#git@github.com:}" ;;
    ssh://git@github.com/*) slug="${u#ssh://git@github.com/}" ;;
    *) return 0 ;;
  esac
  printf '%s' "$slug" | grep -qE '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' && printf '%s\n' "$slug"
  return 0
}

# gh_probe_class <exit status> <stderr text>: ok, denied, bad, limited or offline.
# A pure function of what gh_probe saw, so it can be tested.
gh_probe_class() {
  local status="${1:-1}" err="${2:-}"
  if [ "$status" = 0 ]; then
    echo ok
  elif printf '%s' "$err" | grep -qiE 'HTTP 401\b|Bad credentials'; then
    echo bad
  elif printf '%s' "$err" | grep -qiE 'rate limit|HTTP 429'; then
    echo limited
  elif printf '%s' "$err" | grep -qE 'HTTP (403|404)\b'; then
    echo denied
  else
    echo offline
  fi
}

# gh_probe [-i] <api path>: one bounded read-only gh api call. Prints the class on
# the first line, then (for ok) the response body, with the headers first for -i.
gh_probe() {
  local errf out status
  errf=$(mktemp)
  out=$(timeout "${GH_PROBE_TIMEOUT:-10}" gh api "$@" 2>"$errf") && status=0 || status=$?
  gh_probe_class "$status" "$(cat "$errf")"
  rm -f "$errf"
  [ "$status" != 0 ] || printf '%s\n' "$out"
}

# gh_token_access_doctor [repo url]: dev-doctor's token access check. The caller
# defines ok, info and fail (fail <message> <fix>).
gh_token_access_doctor() {
  local url="${1:-}" slug reply cls body scopes branch name path perm need missing
  local pat_url="github.com/settings/personal-access-tokens"
  reply=$(gh_probe -i /user)
  cls=$(printf '%s\n' "$reply" | head -n 1)
  body=$(printf '%s\n' "$reply" | tail -n +2)
  case "$cls" in
    bad)
      fail "the token is rejected by GitHub" "replace the token file with a valid token, then run: dev-init"
      return 0
      ;;
    offline)
      info "GitHub unreachable, token access unchecked"
      return 0
      ;;
    limited)
      info "GitHub rate limit reached, token access unchecked"
      return 0
      ;;
    denied) body="" ;; # some App tokens cannot read /user; the repo probes still tell
  esac
  if printf '%s\n' "$body" | tr -d '\r' | grep -qi '^x-oauth-scopes:'; then
    scopes=$(printf '%s\n' "$body" | tr -d '\r' | grep -i '^x-oauth-scopes:' | head -n 1 | cut -d: -f2- | tr -d ' ')
    missing=0
    for need in repo workflow; do
      if ! printf '%s' "$scopes" | tr ',' '\n' | grep -qx "$need"; then
        missing=1
        fail "the classic token lacks the $need scope" \
          "edit the token at github.com/settings/tokens and tick the $need scope (public_repo does not count as repo)"
      fi
    done
    [ "$missing" = 1 ] || ok "the classic token has the repo and workflow scopes (scopes: ${scopes:-none})"
    return 0
  fi

  slug=$(gh_repo_slug "$url")
  if [ -z "$slug" ]; then
    info "no github.com repo known (DEV_REPO_URL or the workspace origin), so the token's repo access is unchecked"
    return 0
  fi
  reply=$(gh_probe "repos/$slug")
  cls=$(printf '%s\n' "$reply" | head -n 1)
  case "$cls" in
    ok) ok "the token can read $slug (metadata)" ;;
    bad)
      fail "the token is rejected by GitHub" "replace the token file with a valid token, then run: dev-init"
      return 0
      ;;
    offline)
      info "GitHub unreachable, token access unchecked"
      return 0
      ;;
    limited)
      info "GitHub rate limit reached, token access unchecked"
      return 0
      ;;
    *)
      fail "the token has no access to $slug" "edit the token at $pat_url: add $slug to its repository access"
      return 0
      ;;
  esac
  branch=$(printf '%s\n' "$reply" | tail -n +2 | jq -r '.default_branch // empty' 2>/dev/null)
  branch=${branch:-main}

  for name in contents issues "pull requests" actions checks; do
    case "$name" in
      contents) path="repos/$slug/contents/?ref=$branch"; perm="Contents: read" ;;
      issues) path="repos/$slug/issues?per_page=1"; perm="Issues: read" ;;
      "pull requests") path="repos/$slug/pulls?per_page=1"; perm="Pull requests: read" ;;
      actions) path="repos/$slug/actions/runs?per_page=1"; perm="Actions: read" ;;
      checks) path="repos/$slug/commits/$branch/check-runs?per_page=1"; perm="Checks: read" ;;
    esac
    cls=$(gh_probe "$path" | head -n 1)
    case "$cls" in
      ok) ok "the token can read $name on $slug" ;;
      denied) fail "the token cannot read $name on $slug" "edit the token at $pat_url: give it $perm" ;;
      bad)
        fail "the token is rejected by GitHub" "replace the token file with a valid token, then run: dev-init"
        return 0
        ;;
      limited) info "GitHub rate limit reached, so $name access is unchecked" ;;
      *)
        info "GitHub unreachable, token access unchecked"
        return 0
        ;;
    esac
  done
  info "write access unchecked: give the token read and write on contents, issues, pull requests and workflows"
}
