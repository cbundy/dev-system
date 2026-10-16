#!/usr/bin/env bash
# Read-only look at a workspace's real gh state. Prints file names, keys and
# shapes only: every token value is replaced by its type prefix and length.
# Changes nothing and mints nothing (`gh auth status` only checks the token).
#
#   bash inspect-workspace-gh.sh > workspace-persist-gh.txt 2>&1
set -u
dir=${GH_CONFIG_DIR:-$HOME/.config/gh}

run() { printf '\n$ %s\n' "$*"; }

run gh --version
gh --version | head -n 1
run "echo \$GH_CONFIG_DIR"
echo "$dir"
run findmnt -T "$dir" -o TARGET,SOURCE
findmnt -T "$dir" -o TARGET,SOURCE | sed -E '/^\//s|^([^ ]+ +)[^[]*|\1<host disk>|'
run find "$dir" -printf '%m %u:%g %s %TY-%Tm-%Td %p'
find "$dir" -printf '%m %u:%g %s %TY-%Tm-%Td %p\n'
run "hosts.yml, each token shown as <prefix>... (<length>)"
awk '$1 == "oauth_token:" { t = $2; sub(/oauth_token: .*/, "oauth_token: " substr(t, 1, 4) "... (" length(t) " chars)") } { print }' "$dir/hosts.yml"
run "config.yml, non-comment lines"
grep -v '^\s*#' "$dir/config.yml" | grep -v '^\s*$'
run "find ~/.local/state/gh   (gh's state dir: outside GH_CONFIG_DIR, in the container's home)"
find ~/.local/state/gh -printf '%m %u:%g %s %p\n' 2>&1
run "ls ~/.local/share/gh ~/.config/gh"
ls ~/.local/share/gh ~/.config/gh 2>&1
run "gh auth status --json hosts --hostname github.com   (token itself not printed)"
gh auth status --json hosts --hostname github.com \
  | jq -c '.hosts["github.com"][] | {state, active, login, tokenSource, scopes}'
run "is a keyring service available?"
echo "DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unset}"
command -v gnome-keyring-daemon secret-tool dbus-daemon || echo "no keyring daemon binaries on PATH"
