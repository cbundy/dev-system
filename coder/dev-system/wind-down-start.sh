#!/bin/sh
#
# The start-time cleanup of the loop template: removes the wind-down request, status and stop-now
# files from every factory loop dir on this workspace, before the loop starts. The stop script
# (wind-down.sh) leaves the request in place so the loop starts nothing while the container still
# runs; a request from before this start is stale by definition. Spec: docs/factory-loop/v2/SPEC.md
# 10.11.
#
# main.tf inlines this file into coder_agent.main.startup_script inside a subshell, so it must
# stay free of Terraform template sequences (a dollar sign or percent sign followed by an opening
# brace; use plain $VAR forms), and it never ends the shell, never uses `-e`, and never fails the start.
# Input: CLAUDE_CONFIG_DIR, default /persist/claude. No loop dir is a no-op.
set -u
CLAUDE_CONFIG_DIR=$(printenv CLAUDE_CONFIG_DIR 2>/dev/null || :)
WDS_BASE=/persist/claude
[ -z "$CLAUDE_CONFIG_DIR" ] || WDS_BASE=$CLAUDE_CONFIG_DIR
WDS_BASE=$WDS_BASE/factory-loop
for wds_d in "$WDS_BASE"/*__*; do
  [ -d "$wds_d" ] || continue
  wds_n=$(basename "$wds_d")
  case "$wds_n" in
    *[!A-Za-z0-9._-]* | [!A-Za-z0-9]* | __* | *__) continue ;;
  esac
  if [ -f "$wds_d/wind-down.request" ]; then
    wds_at=$(sed -n 's/.*"requested_at"[^"]*"\([^"]*\)".*/\1/p' "$wds_d/wind-down.request" 2>/dev/null | head -n 1)
    wds_tr=$(sed -n 's/.*"trigger"[^"]*"\([^"]*\)".*/\1/p' "$wds_d/wind-down.request" 2>/dev/null | head -n 1)
    echo "wind-down: cleared a request from before this start in $wds_d (requested_at $wds_at, trigger $wds_tr)"
  fi
  rm -f "$wds_d/wind-down.request" "$wds_d/wind-down.status.json" "$wds_d/wind-down.stop-now" 2>/dev/null || :
done
