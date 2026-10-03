#!/bin/sh
#
# Pin the codex model the no-mistakes pipeline runs on.
#
# Usage: pin-codex-model.sh <no-mistakes config.yaml> <model>
#
# `agent_args_override` is honoured ONLY in the global no-mistakes config.yaml
# - a copy in a repo's .no-mistakes.yaml is silently ignored, leaving codex on
# its (top-end) default. Append the block once; an existing pin, however it
# got there, is left alone. An empty model skips the pin. The daemon reads
# this file at start-up, so a running daemon needs a restart to see it.
#
# Shared by the callum-tools feature (setup.sh) and the dev-system base image
# (images/base/dev-init), so both write the same block with the same rules.
set -eu

NM_CONFIG="$1"
CODEX_MODEL="$2"

[ -n "$CODEX_MODEL" ] || exit 0
if grep -qE '^(agent_args_override|agent_config):' "$NM_CONFIG" 2>/dev/null; then
  exit 0
fi

mkdir -p "$(dirname "$NM_CONFIG")"
cat >> "$NM_CONFIG" <<EOF

# Codex model pin, written by the callum-tools devcontainer feature (global-only key).
agent_args_override:
  codex:
    - -m
    - ${CODEX_MODEL}
    - -c
    - service_tier="priority"
    - -c
    - model_reasoning_effort="medium"
EOF
