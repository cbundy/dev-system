#!/bin/sh
# outside-push.sh LABEL: a person's unrelated commit on cbundy/dev-system-scratch main (one line appended to
# README.md), pushed directly with the admin bypass of branch protection. Prints the time and the new main.
# Works in a throwaway clone and commits as git's configured identity.
set -eu
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
git clone -q --depth 1 https://github.com/cbundy/dev-system-scratch.git "$dir"
cd "$dir"
printf '\n<!-- drill outside merge %s at %s -->\n' "$1" "$(date -u +%FT%TZ)" >> README.md
git commit -qam "docs: README note ($1)"
echo "push at $(date -u +%T.%N)"
git push -q origin HEAD:main 2>&1 | grep -v -E '^remote: *$' || true
echo "main now $(git rev-parse --short HEAD) at $(date -u +%T)"
