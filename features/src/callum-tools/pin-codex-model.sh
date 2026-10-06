#!/bin/sh
#
# Pin the models the no-mistakes pipeline runs on, as a managed block.
#
# Usage: pin-codex-model.sh <no-mistakes config.yaml> <codex model> [claude model]
#
# `agent_args_override` is honoured ONLY in the global no-mistakes config.yaml
# - a copy in a repo's .no-mistakes.yaml is silently ignored, leaving codex on
# its (top-end) default. The optional third argument also pins the model of
# claude, the fallback agent in the synced `agent: [codex, claude]`.
#
# The pin lives between two marker lines, and every call rewrites what is
# between them (in place, wherever the block sits), so a model change reaches
# an existing config on the next start:
#
#   # BEGIN dev-system managed (rewritten on every start - edit outside this block)
#   ...
#   # END dev-system managed
#
# Rules:
#   - Content outside the markers is never modified.
#   - The unmarked block older versions of this script appended (its comment
#     line, then the `agent_args_override:` mapping up to the next top-level
#     line) is replaced by the managed block where it stands.
#   - A pin set by hand - an `agent_args_override:` or `agent_config:` outside
#     the markers that is not that old block - wins: no managed block is
#     written (an existing one is removed, as it would duplicate the key), and
#     a one-line note goes to stderr.
#   - An empty codex model opts out: an existing managed block is removed and
#     nothing is written.
#   - The file is rewritten atomically (temp file + mv in the same directory,
#     keeping its mode) and only when its content changes, so a second identical
#     call leaves it byte-for-byte alone. A missing parent directory is created.
#   - Unbalanced markers (a BEGIN without its END, or the reverse) are an error:
#     the file is left alone rather than guess where the block ends.
#
# Output: prints `changed` on stdout when the file was rewritten, nothing when
# it was already up to date. Exit status 0 on success (changed or not),
# non-zero on failure. The no-mistakes daemon reads this file only at start-up,
# so a running daemon needs a restart to see a change.
#
# Shared by the callum-tools feature (setup.sh) and the dev-system base image
# (images/base/dev-init), so both write the same block with the same rules.
set -eu

[ "$#" -ge 2 ] || {
  echo "usage: pin-codex-model.sh <config.yaml> <codex model> [claude model]" >&2
  exit 2
}
NM_CONFIG="$1"
CODEX_MODEL="$2"
CLAUDE_MODEL="${3:-}"

PIN_BEGIN='# BEGIN dev-system managed (rewritten on every start - edit outside this block)'
PIN_END='# END dev-system managed'
PIN_LEGACY='# Codex model pin, written by the callum-tools devcontainer feature (global-only key).'
export PIN_BEGIN PIN_END PIN_LEGACY

note() {
  echo "pin-codex-model: $*" >&2
}

# render <want>: the config on stdin with every managed block and the legacy
# block replaced by PIN_BLOCK (the first one, in place; later ones dropped) when
# want is 1, or removed (with the blank lines before them) when it is 0. With
# want 1 and no block to replace, PIN_BLOCK is appended, after one blank line.
render() {
  awk -v want="$1" '
    BEGIN { B = ENVIRON["PIN_BEGIN"]; E = ENVIRON["PIN_END"]; L = ENVIRON["PIN_LEGACY"]; block = ENVIRON["PIN_BLOCK"] }
    # A managed or legacy block starts here: the first becomes the block when
    # wanted; otherwise it goes, with the blank lines buffered before it.
    function replace() {
      if (want && !done) { printf "%s", blanks; print block; done = 1; printed = 1 }
      blanks = ""
    }
    mode == "managed" { if ($0 == E) mode = ""; next }
    mode == "legacy" {
      if ($0 ~ /^[[:space:]]*$/) { lblanks = lblanks $0 "\n"; next }
      if ($0 ~ /^[[:space:]]/) { lblanks = ""; next }
      # The next top-level line ends the old block; the blank lines that
      # separated it from this line stay.
      mode = ""; blanks = lblanks; lblanks = ""
    }
    $0 == L {
      if ((getline nxt) <= 0) { printf "%s", blanks; blanks = ""; print; printed = 1; next }
      if (nxt == "agent_args_override:") { replace(); mode = "legacy"; next }
      printf "%s", blanks; blanks = ""; print; printed = 1
      $0 = nxt
    }
    $0 == B { replace(); mode = "managed"; next }
    /^[[:space:]]*$/ { blanks = blanks $0 "\n"; next }
    { printf "%s", blanks; blanks = ""; print; printed = 1 }
    END {
      if (want && !done) {
        if (blanks != "") printf "%s", blanks
        else if (printed) print ""
        print block
      } else {
        printf "%s", blanks
      }
    }'
}

if [ -f "$NM_CONFIG" ]; then
  begins=$(grep -cxF -- "$PIN_BEGIN" "$NM_CONFIG" || true)
  ends=$(grep -cxF -- "$PIN_END" "$NM_CONFIG" || true)
  if [ "$begins" != "$ends" ]; then
    note "ERROR: $NM_CONFIG has $begins '$PIN_BEGIN' and $ends '$PIN_END' lines - fix the managed block by hand (or delete it, markers included); left unchanged"
    exit 1
  fi
fi

want=0
if [ -n "$CODEX_MODEL" ]; then
  want=1
  # A pin set by hand outside the managed and legacy blocks wins.
  if [ -f "$NM_CONFIG" ] && PIN_BLOCK='' render 0 < "$NM_CONFIG" | grep -qE '^(agent_args_override|agent_config):'; then
    want=0
    note "left the hand-set agent_args_override / agent_config in $NM_CONFIG alone - no dev-system model pin written"
  fi
fi

# Nothing to write: leave the file alone unless it holds a block to remove.
if [ "$want" = 0 ]; then
  [ -f "$NM_CONFIG" ] || exit 0
  grep -qxF -e "$PIN_BEGIN" -e "$PIN_LEGACY" "$NM_CONFIG" || exit 0
fi

PIN_BLOCK=$(
  cat <<EOF
$PIN_BEGIN
# The no-mistakes model pin (a global-only key), written by dev-system. To pin models by
# hand, delete this whole block, markers included, and write your own agent_args_override.
agent_args_override:
  codex:
    - -m
    - ${CODEX_MODEL}
    - -c
    - service_tier="priority"
    - -c
    - model_reasoning_effort="medium"
EOF
  if [ -n "$CLAUDE_MODEL" ]; then
    cat <<EOF
  claude:
    - --model
    - ${CLAUDE_MODEL}
EOF
  fi
  echo "$PIN_END"
)
export PIN_BLOCK

mkdir -p "$(dirname "$NM_CONFIG")"
tmp=$(mktemp "$NM_CONFIG.XXXXXX")
trap 'rm -f "$tmp"' EXIT
if [ -f "$NM_CONFIG" ]; then
  # cp -p first, so the rewrite keeps the file's mode.
  cp -p "$NM_CONFIG" "$tmp"
  render "$want" < "$NM_CONFIG" > "$tmp"
  if cmp -s "$tmp" "$NM_CONFIG"; then
    exit 0
  fi
else
  render "$want" < /dev/null > "$tmp"
  chmod 0644 "$tmp"
fi
mv "$tmp" "$NM_CONFIG"
echo changed
