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
  scopes=$(gh auth status --json hosts --hostname github.com 2>/dev/null \
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
# --hostname github.com` reply, a pure function so it needs no network
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
    ([.hosts["github.com"][]? | select(.active == true)][0] // (.hosts["github.com"][0]?)) as $a
    | if $a == null then "unknown"
      elif $a.state == "success" then
        (($a.scopes // "") | tostring | gsub("[ ]"; "") | split(",") | map(select(. != ""))) as $s
        | if ($s | length) == 0 or ($s | index("workflow")) != null then "in" else "scope" end
      elif $a.state == "error" then
        (if (($a.error // "") | tostring | test("401|Bad credentials")) then "out" else "unknown" end)
      else "unknown" end' 2>/dev/null | grep -x -e in -e scope -e out -e unknown || echo unknown
}
