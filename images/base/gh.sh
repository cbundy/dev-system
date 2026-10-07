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
