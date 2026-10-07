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
# "Back up" means to the baked version or newer: a Claude release between the image
# build and this test makes `claude update` land past the baked one.
check "claude can replace its own install as node (downgrade, then update back up)" in_image '
  ver() { claude --version | cut -d" " -f1; }
  baked=$(ver); old=2.1.280
  echo "baked: $baked"
  claude install "$old" 2>&1 | tail -n 5
  echo "after install $old: $(ver)"
  [ "$(ver)" = "$old" ] || exit 1
  claude update 2>&1 | tail -n 5
  now=$(ver); echo "after update: $now"
  [ "$now" != "$old" ] && [ "$(printf "%s\n%s\n" "$baked" "$now" | sort -V | head -n1)" = "$baked" ]'
check "DISABLE_AUTOUPDATER is not set" in_image '[ -z "${DISABLE_AUTOUPDATER:-}" ]'
