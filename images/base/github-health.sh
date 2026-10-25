# shellcheck shell=bash
# shellcheck disable=SC2034 # the gh_* variables are read by the sourcing script
#
# github-health.sh: the GitHub API budget of this device's login (cbundy/dev-system#1305).
# Sourced, not run, by heartbeat-loop. One `gh api rate_limit` call (GitHub does not count it against
# the limit), kept to numbers by jq: the reply is never logged. Each value is empty when gh is
# missing, not logged in, offline, times out or answers anything but the expected JSON, never a guess.
# HEARTBEAT_GH (default gh) is the test hook for the binary.

# github_health_read: sets gh_core_remaining, gh_core_limit, gh_core_reset_at (ISO, from epoch seconds)
# and gh_graphql_remaining, gh_graphql_limit, gh_graphql_reset_at. Always returns 0.
github_health_read() {
  local out line
  gh_core_remaining='' gh_core_limit='' gh_core_reset_at=''
  gh_graphql_remaining='' gh_graphql_limit='' gh_graphql_reset_at=''
  out=$(timeout 10 "${HEARTBEAT_GH:-gh}" api rate_limit 2> /dev/null) || return 0
  # one tab-separated line per resource; a missing or non-numeric value is the empty string
  line=$(jq -r '
    def n: if type == "number" and . >= 0 and . == floor then tostring else "" end;
    def t: if type == "number" and . >= 0 and . == floor then todate else "" end;
    [.resources.core, .resources.graphql][]
    | if type == "object" then [(.remaining | n), (.limit | n), (.reset | t)] else ["", "", ""] end
    | join("|")' <<< "$out" 2> /dev/null) || return 0
  [ "$(printf '%s\n' "$line" | wc -l)" = 2 ] || return 0
  IFS='|' read -r gh_core_remaining gh_core_limit gh_core_reset_at <<< "$(printf '%s\n' "$line" | sed -n 1p)"
  IFS='|' read -r gh_graphql_remaining gh_graphql_limit gh_graphql_reset_at <<< "$(printf '%s\n' "$line" | sed -n 2p)"
  return 0
}
