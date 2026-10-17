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
