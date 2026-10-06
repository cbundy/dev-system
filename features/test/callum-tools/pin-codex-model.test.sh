#!/bin/sh
#
# Plain-shell unit test for pin-codex-model.sh, the managed no-mistakes model
# pin shared by the callum-tools feature (setup.sh) and the dev-system base
# image (dev-init).
# Runs directly with no Docker: `sh features/test/callum-tools/pin-codex-model.test.sh`.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PIN_SH="$SCRIPT_DIR/../../src/callum-tools/pin-codex-model.sh"

BEGIN='# BEGIN dev-system managed (rewritten on every start - edit outside this block)'
END='# END dev-system managed'

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -x "$PIN_SH" ] || fail "$PIN_SH is missing or not executable"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# pin <config> <args...>: runs the script, keeping its stdout in $out and its
# stderr in $tmpdir/err.
pin() {
  out=$("$PIN_SH" "$@" 2> "$tmpdir/err") || fail "pin-codex-model.sh $* failed: $(cat "$tmpdir/err")"
}

count() {
  grep -c -x -F -- "$1" "$2" || true
}

# The managed block of a config, markers included.
managed() {
  sed -n "/^# BEGIN dev-system managed/,/^# END dev-system managed\$/p" "$1"
}

# The block as an older script appended it, byte for byte.
legacy_block() {
  cat <<'EOF'

# Codex model pin, written by the callum-tools devcontainer feature (global-only key).
agent_args_override:
  codex:
    - -m
    - gpt-5.6-sol
    - -c
    - service_tier="priority"
    - -c
    - model_reasoning_effort="medium"
EOF
}

# --- fresh write: missing config (and parent dir) -> created with the block, reported
cfg="$tmpdir/fresh/config.yaml"
pin "$cfg" test-model
[ "$out" = changed ] || fail "a fresh write should report 'changed', got '$out'"
[ "$(count "$BEGIN" "$cfg")" = 1 ] || fail "BEGIN marker missing: $(cat "$cfg")"
[ "$(count "$END" "$cfg")" = 1 ] || fail "END marker missing: $(cat "$cfg")"
head -n 1 "$cfg" | grep -qxF -- "$BEGIN" || fail "a fresh config should start with the block: $(cat "$cfg")"
grep -qx 'agent_args_override:' "$cfg" || fail "agent_args_override not written"
grep -qx '    - test-model' "$cfg" || fail "model not written - config was: $(cat "$cfg")"
grep -qx '    - service_tier="priority"' "$cfg" || fail "service_tier not written"
grep -qx '    - model_reasoning_effort="medium"' "$cfg" || fail "reasoning effort not written"
grep -q '  claude:' "$cfg" && fail "claude pin written without a claude model"
[ "$(stat -c %a "$cfg")" = 644 ] || fail "a new config should be 0644, is $(stat -c %a "$cfg")"

# --- idempotent: an identical call changes nothing, byte for byte, and reports nothing
cp "$cfg" "$tmpdir/before"
pin "$cfg" test-model
[ -z "$out" ] || fail "an unchanged rewrite should print nothing, got '$out'"
cmp -s "$cfg" "$tmpdir/before" || fail "an identical call changed the file"

# --- content before and after the block is kept; a model change rewrites the block in place
cfg="$tmpdir/around.yaml"
printf 'agent: codex\n' > "$cfg"
pin "$cfg" old-model
printf '\n# my settings\nauto_fix:\n  lint: 5\n' >> "$cfg"
chmod 600 "$cfg"
pin "$cfg" new-model claude-new
[ "$out" = changed ] || fail "a model change should report 'changed'"
grep -q old-model "$cfg" && fail "old model still in the block: $(cat "$cfg")"
grep -qx '    - new-model' "$cfg" || fail "new model not written"
grep -qx '  claude:' "$cfg" || fail "claude pin not written"
grep -qx '    - claude-new' "$cfg" || fail "claude model not written"
[ "$(count "$BEGIN" "$cfg")" = 1 ] || fail "block duplicated on a model change"
expected=$(
  printf 'agent: codex\n\n'
  managed "$cfg"
  printf '\n# my settings\nauto_fix:\n  lint: 5\n'
)
[ "$(cat "$cfg")" = "$expected" ] || fail "content around the block not preserved in place: $(cat "$cfg")"
[ "$(stat -c %a "$cfg")" = 600 ] || fail "the rewrite should keep the file's mode, now $(stat -c %a "$cfg")"
find "$tmpdir" -name 'around.yaml.*' | grep -q . && fail "temp file left behind"

# --- claude model dropped -> claude lines removed from the block
pin "$cfg" new-model
[ "$out" = changed ] || fail "dropping the claude model should report 'changed'"
grep -q '  claude:' "$cfg" && fail "claude pin kept after the claude model was dropped"
[ "$(tail -n 3 "$cfg" | head -n 1)" = '# my settings' ] || fail "trailing content lost: $(cat "$cfg")"

# --- legacy block migrated: alone, and between other content
cfg="$tmpdir/legacy.yaml"
legacy_block > "$cfg"
pin "$cfg" test-model claude-test
[ "$out" = changed ] || fail "the migration should report 'changed'"
grep -q 'written by the callum-tools devcontainer feature' "$cfg" && fail "legacy comment not removed: $(cat "$cfg")"
grep -q gpt-5.6-sol "$cfg" && fail "legacy model not removed"
[ "$(grep -c '^agent_args_override:' "$cfg")" = 1 ] || fail "agent_args_override duplicated by the migration: $(cat "$cfg")"
grep -qx '    - test-model' "$cfg" || fail "managed model not written by the migration"
pin "$cfg" test-model claude-test
[ -z "$out" ] || fail "a migrated config should be stable on the next call"

cfg="$tmpdir/legacy-middle.yaml"
{
  printf 'agent: codex\n'
  legacy_block
  printf '\nfoo: 1\n'
} > "$cfg"
pin "$cfg" test-model
expected=$(
  printf 'agent: codex\n\n'
  managed "$cfg"
  printf '\nfoo: 1\n'
)
[ "$(cat "$cfg")" = "$expected" ] || fail "legacy block not replaced in place: $(cat "$cfg")"

# the legacy comment without the mapping after it is not a dev-system block
cfg="$tmpdir/legacy-comment.yaml"
printf '# Codex model pin, written by the callum-tools devcontainer feature (global-only key).\nagent: codex\n' > "$cfg"
pin "$cfg" test-model
[ "$(sed -n 2p "$cfg")" = 'agent: codex' ] || fail "a lone legacy comment line should be kept: $(cat "$cfg")"
grep -q 'written by the callum-tools' "$cfg" || fail "a lone legacy comment line should be kept"

# --- a hand-set pin wins: agent_config and agent_args_override outside the markers
for key in agent_config agent_args_override; do
  cfg="$tmpdir/hand-$key.yaml"
  printf '%s:\n  codex:\n    - -m\n    - my-own\n' "$key" > "$cfg"
  cp "$cfg" "$tmpdir/before"
  pin "$cfg" test-model
  [ -z "$out" ] || fail "a hand-set $key should report nothing, got '$out'"
  cmp -s "$cfg" "$tmpdir/before" || fail "a hand-set $key was modified: $(cat "$cfg")"
  grep -q "hand-set" "$tmpdir/err" || fail "no stderr note for a hand-set $key"
  [ "$(wc -l < "$tmpdir/err")" = 1 ] || fail "the note should be one line: $(cat "$tmpdir/err")"
done

# ... and an existing managed block is removed then, as it would duplicate the key
cfg="$tmpdir/hand-after-managed.yaml"
printf 'agent: codex\n' > "$cfg"
pin "$cfg" test-model
printf '\nagent_config:\n  codex: {}\n' >> "$cfg"
pin "$cfg" test-model
[ "$out" = changed ] || fail "removing the managed block for a hand-set pin should report 'changed'"
grep -qF -- "$BEGIN" "$cfg" && fail "managed block kept next to a hand-set pin: $(cat "$cfg")"
[ "$(cat "$cfg")" = "$(printf 'agent: codex\n\nagent_config:\n  codex: {}')" ] || fail "hand-set content changed: $(cat "$cfg")"

# --- empty model opts out: no file created, an existing block removed
cfg="$tmpdir/empty/config.yaml"
pin "$cfg" ""
[ -z "$out" ] || fail "an empty model on no file should report nothing"
[ ! -e "$tmpdir/empty" ] || fail "an empty model should create neither the config nor its directory"

cfg="$tmpdir/optout.yaml"
printf 'agent: codex\n' > "$cfg"
pin "$cfg" test-model claude-test
pin "$cfg" "" claude-test
[ "$out" = changed ] || fail "removing the block should report 'changed'"
[ "$(cat "$cfg")" = "agent: codex" ] || fail "the block (and its separating blank line) should be gone: $(cat "$cfg")"
pin "$cfg" ""
[ -z "$out" ] || fail "an empty model with no block should report nothing"

# a config with no block is not rewritten for an empty model, even without a final newline
cfg="$tmpdir/no-newline.yaml"
printf 'agent: codex' > "$cfg"
pin "$cfg" ""
[ "$(cat "$cfg"; echo x)" = "agent: codexx" ] || fail "a config with no block was rewritten"

# --- unbalanced markers: an error, file left alone
cfg="$tmpdir/unbalanced.yaml"
printf '%s\nagent_args_override: {}\nfoo: 1\n' "$BEGIN" > "$cfg"
cp "$cfg" "$tmpdir/before"
if "$PIN_SH" "$cfg" test-model > /dev/null 2> "$tmpdir/err"; then
  fail "unbalanced markers should fail"
fi
cmp -s "$cfg" "$tmpdir/before" || fail "a config with unbalanced markers was modified"
grep -q 'fix the managed block by hand' "$tmpdir/err" || fail "no fix for unbalanced markers: $(cat "$tmpdir/err")"

echo "pin-codex-model.sh: all tests passed"
