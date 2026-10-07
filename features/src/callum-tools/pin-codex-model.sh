#!/bin/sh
#
# Write the no-mistakes pipeline's agent order and model pin, as a managed block.
#
# Usage: pin-codex-model.sh <no-mistakes config.yaml> <codex model> [claude model] [agents] [claude effort]
#
# The block has two independent parts, both for the global no-mistakes
# config.yaml:
#   - The agent order, from agents (comma-separated, in order, e.g.
#     codex,claude), written as `agent: [codex, claude]`. A repo's
#     .no-mistakes.yaml `agent` replaces it entirely for that repo.
#   - The model pin, `agent_args_override`: codex's model, then claude's model
#     (`--model`, the third argument) and reasoning effort (`--effort`, the
#     fifth: low, medium, high, xhigh or max), each when set. It is honoured
#     ONLY in the global config - a copy in a repo's .no-mistakes.yaml is
#     silently ignored, leaving codex on its (top-end) default.
#
# The block lives between two marker lines, and every call rewrites what is
# between them (in place, wherever the block sits), so a change reaches an
# existing config on the next start:
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
#   - A key set by hand outside the markers (and not that old block) wins over
#     its part, and only its part, with a one-line note on stderr (the part
#     would duplicate the key): a top-level `agent:` drops the agent order; an
#     `agent_args_override:` or `agent_config:` drops the model pin.
#   - An empty codex model drops the model pin; empty (or absent) agents drop
#     the agent order. Agents that are not a comma-separated list of names, each
#     [a-z0-9][a-z0-9:_-]* with no spaces, drop it too, with a note. A claude
#     effort that is not one of claude's levels is left out, with a note.
#   - The block is written when either part is left, and removed when neither is.
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
# Shared by the callum-tools feature (setup.sh, which passes no agents) and the
# dev-system base image (images/base/dev-init), so both write the same block
# with the same rules.
set -eu

[ "$#" -ge 2 ] || {
  echo "usage: pin-codex-model.sh <config.yaml> <codex model> [claude model] [agents] [claude effort]" >&2
  exit 2
}
NM_CONFIG="$1"
CODEX_MODEL="$2"
CLAUDE_MODEL="${3:-}"
AGENTS="${4:-}"
CLAUDE_EFFORT="${5:-}"

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

# agents_valid <list>: one or more comma-separated names, each
# [a-z0-9][a-z0-9:_-]*, with no empty entries and no spaces - the rule
# images/base/models.sh applies to AGENTS.
agents_valid() {
  case "$1" in
    "" | *[!a-z0-9:_,-]*) return 1 ;;
  esac
  rest="$1,"
  while [ -n "$rest" ]; do
    case "${rest%%,*}" in
      [a-z0-9]*) ;;
      *) return 1 ;;
    esac
    rest="${rest#*,}"
  done
}

if [ -f "$NM_CONFIG" ]; then
  begins=$(grep -cxF -- "$PIN_BEGIN" "$NM_CONFIG" || true)
  ends=$(grep -cxF -- "$PIN_END" "$NM_CONFIG" || true)
  if [ "$begins" != "$ends" ]; then
    note "ERROR: $NM_CONFIG has $begins '$PIN_BEGIN' and $ends '$PIN_END' lines - fix the managed block by hand (or delete it, markers included); left unchanged"
    exit 1
  fi
fi

if [ -n "$AGENTS" ] && ! agents_valid "$AGENTS"; then
  note "ignored the agent list '$AGENTS' - it must be comma-separated names, each [a-z0-9][a-z0-9:_-]*, with no spaces - no dev-system agent order written"
  AGENTS=""
fi

case "$CLAUDE_EFFORT" in
  "" | low | medium | high | xhigh | max) ;;
  *)
    note "ignored the claude effort '$CLAUDE_EFFORT' - it must be one of low, medium, high, xhigh, max - claude's effort left unpinned"
    CLAUDE_EFFORT=""
    ;;
esac

# What is set by hand: the config without its managed and legacy blocks.
hand=""
if [ -f "$NM_CONFIG" ]; then
  hand=$(PIN_BLOCK='' render 0 < "$NM_CONFIG")
fi

want_pin=0
if [ -n "$CODEX_MODEL" ]; then
  want_pin=1
  if printf '%s\n' "$hand" | grep -qE '^(agent_args_override|agent_config):'; then
    want_pin=0
    note "left the hand-set agent_args_override / agent_config in $NM_CONFIG alone - no dev-system model pin written"
  fi
fi

want_agents=0
if [ -n "$AGENTS" ]; then
  want_agents=1
  if printf '%s\n' "$hand" | grep -qE '^agent[[:space:]]*:'; then
    want_agents=0
    note "left the hand-set agent in $NM_CONFIG alone - no dev-system agent order written"
  fi
fi

want=1
[ "$want_pin" = 1 ] || [ "$want_agents" = 1 ] || want=0

# Nothing to write: leave the file alone unless it holds a block to remove.
if [ "$want" = 0 ]; then
  [ -f "$NM_CONFIG" ] || exit 0
  grep -qxF -e "$PIN_BEGIN" -e "$PIN_LEGACY" "$NM_CONFIG" || exit 0
fi

PIN_BLOCK=$(
  echo "$PIN_BEGIN"
  echo "# Written by dev-system (its images/base/models.env). To set one of these keys by hand,"
  echo "# delete this whole block, markers included, and write your own outside it."
  if [ "$want_agents" = 1 ]; then
    echo "# The pipeline's ordered agent list: no-mistakes moves to the next agent when one fails."
    echo "agent: [$(printf '%s' "$AGENTS" | sed 's/,/, /g')]"
  fi
  if [ "$want_pin" = 1 ]; then
    cat <<EOF
# The model pin (a global-only key).
agent_args_override:
  codex:
    - -m
    - ${CODEX_MODEL}
    - -c
    - service_tier="priority"
    - -c
    - model_reasoning_effort="medium"
EOF
    if [ -n "$CLAUDE_MODEL" ] || [ -n "$CLAUDE_EFFORT" ]; then
      echo "  claude:"
      [ -z "$CLAUDE_MODEL" ] || printf '    - --model\n    - %s\n' "$CLAUDE_MODEL"
      [ -z "$CLAUDE_EFFORT" ] || printf '    - --effort\n    - %s\n' "$CLAUDE_EFFORT"
    fi
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
