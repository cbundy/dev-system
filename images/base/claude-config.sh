# shellcheck shell=bash
#
# claude-config.sh: prepare_claude_config, shared by dev-remote-control and
# dev-remote-sessions (cbundy/dev-system#533). Sourced, not run. The caller
# defines log().
#
# Pre-answers the start-up dialogs nobody is there to answer: workspace trust,
# the one-time Remote Control consent (remoteDialogSeen: `claude
# remote-control` blocks on "Enable Remote Control? (y/n)" without it, and the
# interactive Claude has a matching dialog; enabling DEV_REMOTE_CONTROL is the
# consent, cbundy/dev-system#88), the one-time "Try the new fullscreen
# renderer?" prompt (fullscreenUpsellSeenCount, shown while it is below 3) and,
# if somehow still pending, onboarding.
# With a second argument of 1 it also accepts the bypass-permissions
# disclaimer, as answering it interactively would: server mode has no
# --settings flag to skip it per run, and a spawned session would otherwise
# fall back to the default permission mode. Only missing values are set.
# shellcheck disable=SC2016 # $ws and $bypass are jq variables
prepare_claude_config() {
  local ws="$1" bypass="${2:-0}" cfg="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.claude.json" tmp
  local want='.hasCompletedOnboarding == true and .projects[$ws].hasTrustDialogAccepted == true
    and .remoteDialogSeen == true and (.fullscreenUpsellSeenCount // 0) >= 3 and ($bypass != "1" or .bypassPermissionsModeAccepted == true)'
  local set='.hasCompletedOnboarding = true | .projects[$ws].hasTrustDialogAccepted = true
    | .remoteDialogSeen = true | .fullscreenUpsellSeenCount = ([.fullscreenUpsellSeenCount // 0, 3] | max)
    | if $bypass == "1" then .bypassPermissionsModeAccepted = true else . end'
  [ -s "$cfg" ] || (umask 077 && echo '{}' > "$cfg") || return 0
  jq -e --arg ws "$ws" --arg bypass "$bypass" "$want" "$cfg" >/dev/null 2>&1 && return 0
  tmp=$(mktemp "$cfg.XXXXXX") || return 0
  if jq --arg ws "$ws" --arg bypass "$bypass" "$set" "$cfg" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$cfg" && log "marked $ws as trusted and Remote Control as accepted in $cfg"
  else
    log "WARNING: $cfg is not valid JSON - Claude may wait on its trust or Remote Control dialog (attach to answer it)"
  fi
  rm -f "$tmp"
}
