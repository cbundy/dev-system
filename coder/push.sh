#!/bin/sh
# Push one of the Coder templates built from coder/dev-system:
#
#   coder/push.sh dev-system     Remote Control mode defaults to auto (server with a repo)
#   coder/push.sh orchestrator   one long-lived session: session mode, resumed on every
#                                start, starting the issue-orchestrator skill by itself
#   coder/push.sh orchestrator-loop
#                                the same session, run by the factory loop: the factory-loop
#                                plugin drives the repo and the session starts as its judge
#
# All three templates are the same Terraform. Each one's name, display name, icon, description
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
  echo "usage: $0 dev-system|orchestrator|orchestrator-loop" >&2
  exit 2
}

[ $# -eq 1 ] || usage
name=$1
# The plugin release a template that names its plugins pins them to: this checkout's
# package version, whose tag exists once its release has run (RELEASING.md).
plugin_ref=v$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$TEMPLATE_DIR/../../package.json")
[ "$plugin_ref" != v ] || {
  echo "push: cannot read the version in package.json" >&2
  exit 1
}
case "$name" in
  dev-system)
    role=dev
    display_name=dev-system
    icon=/icon/docker.svg
    description='A dev-system base image workspace with Claude Code Remote Control and a login page'
    mode=auto
    resume=false
    skip_permissions=false
    prompt=
    resume_prompt=
    name_format=
    plugins=
    ;;
  orchestrator)
    role=orchestrator
    display_name=Orchestrator
    icon=/emojis/1f504.png # U+1F504, the clockwise arrows emoji
    description='A dev-system workspace running one interactive Claude Code Remote Control session, e.g. for the issue orchestrator'
    mode=session
    resume=true
    # Off for now: whether the orchestrator acts without approvals is the owner's
    # decision (cbundy/dev-system#164), to be flipped separately.
    skip_permissions=false
    prompt=/callum-flow:issue-orchestrator
    resume_prompt='The workspace restarted and this conversation was resumed. Re-read .claude/orchestrator-memory.md, re-arm the watcher and continue the issue-orchestrator loop.'
    name_format='🔄 {name} orchestrator'
    plugins=
    ;;
  orchestrator-loop)
    role=orchestrator
    display_name='Orchestrator (loop)'
    icon=/emojis/1f3ed.png # U+1F3ED, the factory emoji
    description='A dev-system orchestrator run by the factory loop: a deterministic plugin claims, gates and merges issues, and wakes Claude only for judgment calls'
    mode=session
    resume=true
    # As for orchestrator, until the owner decides (cbundy/dev-system#164).
    skip_permissions=false
    prompt=/factory-loop:judge
    resume_prompt='The workspace restarted and this conversation was resumed. The factory loop resumes by itself; answer its wakes as its judge.'
    name_format='🏭 {name} loop'
    plugins="callum-flow@callum=cbundy/dev-system#$plugin_ref factory-loop@callum=cbundy/dev-system#$plugin_ref"
    ;;
  *) usage ;;
esac

# coder reads each --variable as a CSV record, so a value with a comma (the resume
# prompt) would be split: quote the whole name=value as one CSV field.
csv() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/"/""/g')"
}

set -- templates push "$name" --directory "$TEMPLATE_DIR" --yes \
  --variable "$(csv "role=$role")" \
  --variable "$(csv "remote_control_default_mode=$mode")" \
  --variable "$(csv "remote_control_default_resume=$resume")" \
  --variable "$(csv "remote_control_default_skip_permissions=$skip_permissions")" \
  --variable "$(csv "remote_control_prompt=$prompt")" \
  --variable "$(csv "remote_control_resume_prompt=$resume_prompt")" \
  --variable "$(csv "remote_control_name_format=$name_format")" \
  --variable "$(csv "default_plugins=$plugins")"
version_name_sh="$(dirname "$0")/version-name.sh"
version=$("$version_name_sh" "$TEMPLATE_DIR")
message=$("$version_name_sh" --message push.sh "$TEMPLATE_DIR")
set -- "$@" --name "$version"
[ -z "$message" ] || set -- "$@" --message "$message"
echo "push: pushing $TEMPLATE_DIR as $name (version $version)" >&2
"$CODER" "$@"
# Only the flags given change; every other template setting is kept.
"$CODER" templates edit "$name" --display-name "$display_name" --icon "$icon" \
  --description "$description" --yes
