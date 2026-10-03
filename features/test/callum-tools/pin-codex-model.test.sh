#!/bin/sh
#
# Plain-shell unit test for pin-codex-model.sh, the codex model pin shared by
# the callum-tools feature (setup.sh) and the dev-system base image (dev-init).
# Runs directly with no Docker: `sh features/test/callum-tools/pin-codex-model.test.sh`.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PIN_SH="$SCRIPT_DIR/../../src/callum-tools/pin-codex-model.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -x "$PIN_SH" ] || fail "$PIN_SH is missing or not executable"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# missing config (and missing parent dir) -> created with the pin
cfg="$tmpdir/fresh/config.yaml"
"$PIN_SH" "$cfg" test-model
grep -qx 'agent_args_override:' "$cfg" || fail "pin block not written to a fresh config"
grep -qx '    - test-model' "$cfg" || fail "model not written - config was: $(cat "$cfg")"

# second run -> idempotent, still exactly one block
"$PIN_SH" "$cfg" other-model
[ "$(grep -c '^agent_args_override:' "$cfg")" = 1 ] || fail "pin block duplicated on re-run"
grep -q 'other-model' "$cfg" && fail "an existing pin was overwritten"

# existing agent_config (another way of pinning) -> left alone
cfg2="$tmpdir/agent-config.yaml"
printf 'agent_config:\n  codex: {}\n' > "$cfg2"
"$PIN_SH" "$cfg2" test-model
grep -q 'agent_args_override' "$cfg2" && fail "pinned over an existing agent_config"

# existing config without a pin -> appended, original content kept
cfg3="$tmpdir/existing.yaml"
printf 'agent: codex\n' > "$cfg3"
"$PIN_SH" "$cfg3" test-model
head -n 1 "$cfg3" | grep -qx 'agent: codex' || fail "existing config content not preserved"
grep -qx 'agent_args_override:' "$cfg3" || fail "pin not appended to existing config"

# empty model -> skipped, file not created
cfg4="$tmpdir/empty/config.yaml"
"$PIN_SH" "$cfg4" ""
[ ! -e "$cfg4" ] || fail "empty model should skip the pin"

echo "pin-codex-model.sh: all tests passed"
