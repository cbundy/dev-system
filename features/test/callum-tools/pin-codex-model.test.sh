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

# --- the agent order (4th argument): written in order, with the pin, or alone
cfg="$tmpdir/agents.yaml"
pin "$cfg" test-model claude-test codex,claude
[ "$out" = changed ] || fail "a write with agents should report 'changed'"
[ "$(managed "$cfg" | grep -c '^agent:')" = 1 ] || fail "agent not written once in the block: $(cat "$cfg")"
managed "$cfg" | grep -qx 'agent: \[codex, claude\]' || fail "agent order not written as a list in order: $(cat "$cfg")"
managed "$cfg" | grep -qx '    - test-model' || fail "the pin should be written next to the agent order"
pin "$cfg" test-model claude-test codex,claude
[ -z "$out" ] || fail "an identical call with agents should report nothing, got '$out'"

# a list change rewrites the block in place, keeping content around it
printf 'auto_fix:\n  lint: 5\n' > "$cfg"
pin "$cfg" test-model "" codex,claude
printf '\nkeep: 1\n' >> "$cfg"
pin "$cfg" test-model "" claude,acp:my-agent,codex
[ "$out" = changed ] || fail "a list change should report 'changed'"
grep -qx 'agent: \[claude, acp:my-agent, codex\]' "$cfg" || fail "new agent order not written: $(cat "$cfg")"
[ "$(grep -c '^agent:' "$cfg")" = 1 ] || fail "agent duplicated on a list change: $(cat "$cfg")"
expected=$(
  printf 'auto_fix:\n  lint: 5\n\n'
  managed "$cfg"
  printf '\nkeep: 1\n'
)
[ "$(cat "$cfg")" = "$expected" ] || fail "content around the block not preserved on a list change: $(cat "$cfg")"

# an empty codex model removes only the pin part; empty agents remove only the agent part
pin "$cfg" "" "" claude
[ "$out" = changed ] || fail "dropping the pin should report 'changed'"
grep -qx 'agent: \[claude\]' "$cfg" || fail "agent part lost when the pin was dropped: $(cat "$cfg")"
grep -q 'agent_args_override' "$cfg" && fail "pin kept for an empty codex model: $(cat "$cfg")"
pin "$cfg" test-model "" ""
[ "$out" = changed ] || fail "dropping the agents should report 'changed'"
grep -q '^agent:' "$cfg" && fail "agent part kept for empty agents: $(cat "$cfg")"
grep -qx '    - test-model' "$cfg" || fail "pin not written when the agents were dropped"

# both parts empty removes the block, and the blank line before it
pin "$cfg" test-model "" codex
pin "$cfg" "" "" ""
[ "$out" = changed ] || fail "removing the block for two empty parts should report 'changed'"
[ "$(cat "$cfg")" = "$(printf 'auto_fix:\n  lint: 5\n\nkeep: 1')" ] || fail "block not removed cleanly: $(cat "$cfg")"

# an invalid agent list drops only the agent part, with a one-line note
# shellcheck disable=SC2016 # a literal $(id), to prove it is rejected
for bad in 'codex,,claude' ',codex' 'codex,' 'codex, claude' 'Codex' 'codex;rm' '$(id)' '-codex' 'co dex'; do
  cfg="$tmpdir/bad-agents.yaml"
  rm -f "$cfg"
  pin "$cfg" test-model "" "$bad"
  grep -q '^agent:' "$cfg" && fail "invalid agent list '$bad' written: $(cat "$cfg")"
  grep -qx '    - test-model' "$cfg" || fail "pin lost for an invalid agent list '$bad'"
  grep -q 'ignored the agent list' "$tmpdir/err" || fail "no note for the invalid agent list '$bad'"
  [ "$(wc -l < "$tmpdir/err")" = 1 ] || fail "the note should be one line: $(cat "$tmpdir/err")"
done

# --- a hand-set top-level agent suppresses only the agent part
cfg="$tmpdir/hand-agent.yaml"
printf 'agent: claude\n' > "$cfg"
pin "$cfg" test-model claude-test codex,claude
[ "$out" = changed ] || fail "the pin should still be written next to a hand-set agent"
[ "$(grep -c '^agent:' "$cfg")" = 1 ] || fail "agent duplicated next to a hand-set one: $(cat "$cfg")"
[ "$(head -n 1 "$cfg")" = 'agent: claude' ] || fail "hand-set agent changed: $(cat "$cfg")"
grep -qx '    - test-model' "$cfg" || fail "pin not written next to a hand-set agent"
grep -q 'left the hand-set agent in' "$tmpdir/err" || fail "no note for a hand-set agent: $(cat "$tmpdir/err")"
[ "$(wc -l < "$tmpdir/err")" = 1 ] || fail "the note should be one line: $(cat "$tmpdir/err")"
# ... and an existing managed agent part is removed when one is set by hand later
cfg="$tmpdir/hand-agent-later.yaml"
pin "$cfg" test-model "" codex,claude
printf '\nagent: [claude]\n' >> "$cfg"
pin "$cfg" test-model "" codex,claude
[ "$out" = changed ] || fail "removing the managed agent part should report 'changed'"
[ "$(grep -c '^agent:' "$cfg")" = 1 ] || fail "managed agent kept next to a hand-set one: $(cat "$cfg")"
[ "$(tail -n 1 "$cfg")" = 'agent: [claude]' ] || fail "hand-set agent changed: $(cat "$cfg")"
grep -qx '    - test-model' "$cfg" || fail "pin lost when the agent was set by hand"
# a hand-set agent and an empty codex model: nothing left to write
cfg="$tmpdir/hand-agent-only.yaml"
printf 'agent: claude\n' > "$cfg"
pin "$cfg" "" "" codex
[ -z "$out" ] || fail "nothing to write should report nothing, got '$out'"
[ "$(cat "$cfg")" = 'agent: claude' ] || fail "hand-set agent config was modified: $(cat "$cfg")"
# agent_args_override and agent_config are not a hand-set agent
cfg="$tmpdir/agent-lookalike.yaml"
printf 'agent_timeout: 5m\n' > "$cfg"
pin "$cfg" test-model "" codex
grep -qx 'agent: \[codex\]' "$cfg" || fail "a look-alike key suppressed the agent part: $(cat "$cfg")"

# --- a hand-set pin suppresses only the pin part
for key in agent_config agent_args_override; do
  cfg="$tmpdir/hand-pin-agents-$key.yaml"
  printf '%s:\n  codex:\n    - -m\n    - my-own\n' "$key" > "$cfg"
  pin "$cfg" test-model claude-test codex,claude
  [ "$out" = changed ] || fail "the agent part should still be written next to a hand-set $key"
  grep -qx 'agent: \[codex, claude\]' "$cfg" || fail "agent part not written next to a hand-set $key: $(cat "$cfg")"
  [ "$(grep -c "^$key:" "$cfg")" = 1 ] || fail "$key duplicated: $(cat "$cfg")"
  managed "$cfg" | grep -q 'agent_args_override\|test-model' && fail "pin written next to a hand-set $key: $(cat "$cfg")"
  [ "$(head -n 4 "$cfg")" = "$(printf '%s:\n  codex:\n    - -m\n    - my-own' "$key")" ] || fail "hand-set $key changed"
  grep -q "hand-set agent_args_override / agent_config" "$tmpdir/err" || fail "no note for a hand-set $key"
done

# --- claude's effort (5th argument): written as --effort after claude's model
cfg="$tmpdir/effort.yaml"
pin "$cfg" test-model claude-test codex,claude medium
[ "$out" = changed ] || fail "a write with a claude effort should report 'changed'"
expected=$(printf '  claude:\n    - --model\n    - claude-test\n    - --effort\n    - medium')
[ "$(managed "$cfg" | sed -n '/^  claude:$/,/^# END/p' | sed '$d')" = "$expected" ] \
  || fail "claude model and effort not written in order: $(cat "$cfg")"
pin "$cfg" test-model claude-test codex,claude medium
[ -z "$out" ] || fail "an identical call with a claude effort should report nothing, got '$out'"
# a level change rewrites it in place, with no duplicate keys
pin "$cfg" test-model claude-test codex,claude high
[ "$out" = changed ] || fail "an effort change should report 'changed'"
[ "$(grep -c -- '--effort' "$cfg")" = 1 ] || fail "effort duplicated: $(cat "$cfg")"
[ "$(grep -c '^  claude:' "$cfg")" = 1 ] || fail "claude duplicated: $(cat "$cfg")"
grep -qx '    - high' "$cfg" || fail "new effort not written: $(cat "$cfg")"
grep -qx '    - medium' "$cfg" && fail "old effort kept: $(cat "$cfg")"
# no effort -> claude keeps only its model
pin "$cfg" test-model claude-test codex,claude
[ "$out" = changed ] || fail "dropping the effort should report 'changed'"
grep -q -- '--effort' "$cfg" && fail "effort kept after it was dropped: $(cat "$cfg")"
grep -qx '    - claude-test' "$cfg" || fail "claude model lost when the effort was dropped"
# an effort with no claude model still pins claude's effort
pin "$cfg" test-model "" codex,claude low
[ "$(managed "$cfg" | sed -n '/^  claude:$/,/^# END/p' | sed '$d')" = "$(printf '  claude:\n    - --effort\n    - low')" ] \
  || fail "effort alone not written for claude: $(cat "$cfg")"
# the effort is part of the pin: an empty codex model drops it with the rest
pin "$cfg" "" claude-test codex,claude medium
grep -q -- '--effort\|  claude:' "$cfg" && fail "claude pinned with no codex pin: $(cat "$cfg")"
grep -qx 'agent: \[codex, claude\]' "$cfg" || fail "agent order lost: $(cat "$cfg")"
# every level claude takes is accepted
for level in low medium high xhigh max; do
  cfg="$tmpdir/effort-$level.yaml"
  pin "$cfg" test-model claude-test "" "$level"
  grep -qx "    - $level" "$cfg" || fail "effort level '$level' not written: $(cat "$cfg")"
  [ ! -s "$tmpdir/err" ] || fail "a note for the valid level '$level': $(cat "$tmpdir/err")"
done
# an invalid effort is left out, with a one-line note; the claude model is kept
# shellcheck disable=SC2016 # a literal $(id), to prove it is rejected
for bad in 'Medium' 'minimal' 'med' 'medium high' '$(id)' 'medium;rm' '-x'; do
  cfg="$tmpdir/bad-effort.yaml"
  rm -f "$cfg"
  pin "$cfg" test-model claude-test codex,claude "$bad"
  grep -q -- '--effort' "$cfg" && fail "invalid effort '$bad' written: $(cat "$cfg")"
  grep -qx '    - claude-test' "$cfg" || fail "claude model lost for an invalid effort '$bad'"
  grep -q "ignored the claude effort" "$tmpdir/err" || fail "no note for the invalid effort '$bad'"
  [ "$(wc -l < "$tmpdir/err")" = 1 ] || fail "the note should be one line: $(cat "$tmpdir/err")"
done
# a hand-set agent_config (e.g. agent_config.claude written by hand) wins over the whole pin
cfg="$tmpdir/hand-agent-config.yaml"
printf 'agent_config:\n  claude:\n    model: claude-sonnet-5-5\n    effort: medium\n' > "$cfg"
pin "$cfg" test-model claude-test codex,claude medium
managed "$cfg" | grep -q -- 'agent_args_override\|--effort' && fail "pin written next to a hand-set agent_config: $(cat "$cfg")"
[ "$(grep -c '^agent_config:' "$cfg")" = 1 ] || fail "agent_config duplicated: $(cat "$cfg")"

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
