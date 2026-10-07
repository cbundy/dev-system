# shellcheck shell=bash
# shellcheck disable=SC2016,SC2154
#
# Section 4 of the base image container tests. Sourced by test.sh after lib.sh, which
# provides IMAGE, RUN_ID, SECRET, check, in_image and the rest; never run directly.

echo "== 4. Claude auto-update"
check "Claude install location is writable by node" in_image '
  launcher=$(command -v claude); target=$(readlink -f "$launcher")
  [ -w "$(dirname "$launcher")" ] && [ -w "$(dirname "$target")" ] && [ -w "$HOME/.local/share/claude" ]'
check "after dev-init, claude doctor reports a native install with auto-updates and no installation issues" in_image '
  dev-init >/dev/null 2>&1
  out=$(timeout 60 claude doctor </dev/null 2>&1); echo "$out"
  echo "$out" | grep -q "Running: native" &&
  echo "$out" | grep -q "Auto-updates: enabled" &&
  echo "$out" | grep -q "No installation issues found"'
check "claude can replace its own install as node (downgrade, then update back to latest)" in_image '
  set -e
  latest=$(claude --version)
  claude install 2.1.280 >/dev/null 2>&1
  [ "$(claude --version)" != "$latest" ]
  claude update
  [ "$(claude --version)" = "$latest" ]'
check "DISABLE_AUTOUPDATER is not set" in_image '[ -z "${DISABLE_AUTOUPDATER:-}" ]'
