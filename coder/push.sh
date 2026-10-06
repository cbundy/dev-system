#!/bin/sh
# Push one of the Coder templates built from coder/dev-system:
#
#   coder/push.sh dev-system     Remote Control mode defaults to auto (server with a repo)
#   coder/push.sh orchestrator   one long-lived session: session mode, resumed on every
#                                start, starting the issue-orchestrator skill by itself
#
# Both templates are the same Terraform. Each one's name, display name, icon, description
# and variables live here, so a push never depends on remembering flags. The site's values
# (docker_host, otlp_endpoint, ...) are in coder/dev-system/terraform.tfvars, which coder
# reads on every push. Needs the coder CLI logged in as a template admin; CODER_BIN picks
# another binary.
#
# Pushing these templates is the owner's step. To try a template change, agents use
# coder/dev-system/push-next.sh, which only ever pushes dev-system-next.
set -eu

TEMPLATE_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/dev-system
CODER=${CODER_BIN:-coder}

usage() {
  echo "usage: $0 dev-system|orchestrator" >&2
  exit 2
}

[ $# -eq 1 ] || usage
name=$1
case "$name" in
  dev-system)
    display_name=dev-system
    icon=/icon/docker.svg
    description='A dev-system base image workspace with Claude Code Remote Control and a login page'
    mode=auto
    resume=false
    skip_permissions=false
    prompt=
    resume_prompt=
    name_format=
    ;;
  orchestrator)
    display_name=Orchestrator
    icon=/emojis/1f504.png # U+1F504, the clockwise arrows emoji
    description='A dev-system workspace running one interactive Claude Code Remote Control session, e.g. for the issue orchestrator'
    mode=session
    resume=true
    # Off for now: whether the orchestrator acts without approvals is the owner's
    # decision (cbundy/dev-system#164), to be flipped separately.
    skip_permissions=false
    prompt=/callum-flow:issue-orchestrator
    resume_prompt='The workspace restarted and this conversation was resumed. Re-read .claude/orchestrator-memory.md, re-arm the watchers and the audit, and continue the issue-orchestrator loop.'
    name_format='🔄 {name} orchestrator'
    ;;
  *) usage ;;
esac

# coder reads each --variable as a CSV record, so a value with a comma (the resume
# prompt) would be split: quote the whole name=value as one CSV field.
csv() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/"/""/g')"
}

set -- templates push "$name" --directory "$TEMPLATE_DIR" --yes \
  --variable "$(csv "remote_control_default_mode=$mode")" \
  --variable "$(csv "remote_control_default_resume=$resume")" \
  --variable "$(csv "remote_control_default_skip_permissions=$skip_permissions")" \
  --variable "$(csv "remote_control_prompt=$prompt")" \
  --variable "$(csv "remote_control_resume_prompt=$resume_prompt")" \
  --variable "$(csv "remote_control_name_format=$name_format")"
sha=$(git -C "$TEMPLATE_DIR" rev-parse --short HEAD 2>/dev/null || true)
[ -z "$sha" ] || set -- "$@" --message "push.sh from $sha"
echo "push: pushing $TEMPLATE_DIR as $name" >&2
"$CODER" "$@"
# Only the flags given change; every other template setting is kept.
"$CODER" templates edit "$name" --display-name "$display_name" --icon "$icon" \
  --description "$description" --yes
