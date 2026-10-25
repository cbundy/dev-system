#!/bin/sh
# shellcheck disable=SC2016 # the bash -c scripts are single-quoted on purpose
# Plain-shell tests for images/base/github-health.sh (cbundy/dev-system#1305): the GitHub budget
# probe the heartbeat runs. A stub gh stands in for the binary (HEARTBEAT_GH).
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
LIB="$SCRIPT_DIR/../github-health.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
[ -f "$LIB" ] || fail "$LIB is missing"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# stub BODY: a gh that records its argv and runs BODY
stub() {
  printf '#!/bin/sh\nprintf "%%s\\n" "$*" > "%s/argv"\n%s\n' "$tmp" "$1" > "$tmp/gh"
  chmod +x "$tmp/gh"
}
reading() { # prints the six values, labelled
  HEARTBEAT_GH="$tmp/gh" bash -c '. "$1"; github_health_read; printf "%s|%s|%s|%s|%s|%s" "$gh_core_remaining" "$gh_core_limit" "$gh_core_reset_at" "$gh_graphql_remaining" "$gh_graphql_limit" "$gh_graphql_reset_at"' _ "$LIB"
}
expect() { # EXPECTED LABEL GOT
  [ "$3" = "$1" ] || fail "$2: expected '$1', got '$3'"
}

stub "echo '{\"resources\":{\"core\":{\"limit\":5000,\"used\":10,\"remaining\":4990,\"reset\":1700000000},\"graphql\":{\"limit\":5000,\"used\":4988,\"remaining\":12,\"reset\":1700000100},\"search\":{\"limit\":30,\"remaining\":30,\"reset\":1700000000}},\"rate\":{\"limit\":5000,\"remaining\":4990,\"reset\":1700000000}}'"
expect '4990|5000|2023-11-14T22:13:20Z|12|5000|2023-11-14T22:15:00Z' "a real reply" "$(reading)"
expect 'api rate_limit' "argv" "$(cat "$tmp/argv")"

stub 'echo "gh: not logged in" >&2; exit 4'
expect '|||||' "a non-zero exit" "$(reading)"

stub 'sleep 30'
start=$(date +%s)
got=$(HEARTBEAT_GH="$tmp/gh" bash -c '. "$1"; github_health_read; printf "%s" "$gh_core_remaining"' _ "$LIB")
elapsed=$(($(date +%s) - start))
expect '' "a timeout" "$got"
[ "$elapsed" -lt 20 ] || fail "the probe must give up after 10 s, took ${elapsed}s"

stub 'echo "<html>rate limited</html>"'
expect '|||||' "non-JSON" "$(reading)"

stub "echo '{\"resources\":{\"core\":{\"limit\":5000,\"remaining\":4990,\"reset\":1700000000}}}'"
expect '4990|5000|2023-11-14T22:13:20Z|||' "JSON without graphql" "$(reading)"

stub "echo '{\"resources\":{\"core\":{\"limit\":\"x\",\"remaining\":-1,\"reset\":1.5},\"graphql\":{\"limit\":5000,\"remaining\":7}}}'"
expect '|||7|5000|' "values that are not whole non-negative numbers" "$(reading)"

stub "echo '[1,2]'"
expect '|||||' "JSON that is not an object" "$(reading)"

expect '|||||' "a missing gh" "$(HEARTBEAT_GH="$tmp/none" bash -c '. "$1"; github_health_read; printf "%s|%s|%s|%s|%s|%s" "$gh_core_remaining" "$gh_core_limit" "$gh_core_reset_at" "$gh_graphql_remaining" "$gh_graphql_limit" "$gh_graphql_reset_at"' _ "$LIB")"

echo "github-health: ok"
