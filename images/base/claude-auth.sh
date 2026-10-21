# shellcheck shell=bash
# claude-auth.sh: Claude's API-key mode (cbundy/dev-system#1113), for dev-init,
# dev-login, dev-remote-control and dev-doctor. Sourced, never run:
#   . /usr/local/share/dev-system/claude-auth.sh
#
# DEV_CLAUDE_AUTH=api-key puts a workspace on its own Anthropic API key, which
# lives only in the file named by DEV_CLAUDE_API_KEY_FILE (the workspace's folder
# on the Docker host). Claude reads it through apiKeyHelper in its user settings
# (dev-claude-api-key prints it), so the key is never an environment variable, an
# argument, a Terraform value or a log line. Remote Control does not work with an
# API key, so dev-remote-control runs Claude headless in tmux in this mode.

# The helper script, as it appears (with the key file after it) in apiKeyHelper.
CLAUDE_API_KEY_HELPER=${CLAUDE_API_KEY_HELPER:-/usr/local/bin/dev-claude-api-key}

# claude_api_key_mode: true when DEV_CLAUDE_AUTH=api-key.
claude_api_key_mode() {
  [ "${DEV_CLAUDE_AUTH:-}" = api-key ]
}

# claude_api_key_ready: the key file is readable and has a non-blank line.
# Never prints the key.
claude_api_key_ready() {
  local f="${DEV_CLAUDE_API_KEY_FILE:-}"
  [ -n "$f" ] && [ -r "$f" ] && grep -q '[^[:space:]]' "$f" 2>/dev/null
}

# claude_api_key_settings: the user settings file Claude reads.
claude_api_key_settings() {
  echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
}

# claude_api_key_helper_value: what apiKeyHelper must be for this workspace.
claude_api_key_helper_value() {
  echo "$CLAUDE_API_KEY_HELPER ${DEV_CLAUDE_API_KEY_FILE:-}"
}

# setup_claude_api_key: in API-key mode, sets apiKeyHelper in the user settings,
# keeping every other key. Out of API-key mode, removes apiKeyHelper only when it
# is this image's helper, so a helper the owner set stays and switching back to
# private restores the claude.ai login. The caller defines log().
setup_claude_api_key() {
  local cfg tmp want
  cfg=$(claude_api_key_settings)
  if claude_api_key_mode; then
    if [ -z "${DEV_CLAUDE_API_KEY_FILE:-}" ]; then
      log "WARNING: DEV_CLAUDE_AUTH=api-key but DEV_CLAUDE_API_KEY_FILE is not set - Claude has no API key"
      return 0
    fi
    want=$(claude_api_key_helper_value)
    mkdir -p "$(dirname "$cfg")" 2>/dev/null || return 0
    [ -s "$cfg" ] || (umask 077 && echo '{}' > "$cfg") || return 0
    if jq -e --arg h "$want" '.apiKeyHelper == $h' "$cfg" >/dev/null 2>&1; then
      log "Claude API-key mode: apiKeyHelper already set in $cfg"
      return 0
    fi
    tmp=$(umask 077 && mktemp "$cfg.XXXXXX") || return 0
    if jq --arg h "$want" '.apiKeyHelper = $h' "$cfg" > "$tmp" 2>/dev/null; then
      chmod 600 "$tmp"
      mv -f "$tmp" "$cfg" && log "Claude API-key mode: set apiKeyHelper in $cfg (key file ${DEV_CLAUDE_API_KEY_FILE})"
    else
      rm -f "$tmp"
      log "WARNING: could not update $cfg (is it valid JSON?) - Claude has no API key"
    fi
    return 0
  fi
  [ -s "$cfg" ] || return 0
  if jq -e --arg p "$CLAUDE_API_KEY_HELPER " '(.apiKeyHelper // "") | type == "string" and startswith($p)' "$cfg" >/dev/null 2>&1; then
    tmp=$(umask 077 && mktemp "$cfg.XXXXXX") || return 0
    if jq 'del(.apiKeyHelper)' "$cfg" > "$tmp" 2>/dev/null; then
      chmod 600 "$tmp"
      mv -f "$tmp" "$cfg" && log "Claude is not in API-key mode: removed the image's apiKeyHelper from $cfg"
    else
      rm -f "$tmp"
    fi
  fi
}

# claude_api_key_doctor: dev-doctor's API-key checks. The caller defines ok, info
# and fail (fail <message> <fix>).
claude_api_key_doctor() {
  local f="${DEV_CLAUDE_API_KEY_FILE:-}" cfg
  cfg=$(claude_api_key_settings)
  info "Claude auth mode: api-key (Remote Control is off by design; Claude runs headless in tmux session claude)"
  if claude_api_key_ready; then
    ok "DEV_CLAUDE_API_KEY_FILE ($f) is readable"
  else
    fail "DEV_CLAUDE_API_KEY_FILE (${f:-unset}) is missing, empty or unreadable" \
      "provision anthropic-api-key in the workspace's folder on the Docker host (owned 1000:1000, mode 0600), then restart the workspace"
  fi
  if jq -e --arg h "$(claude_api_key_helper_value)" '.apiKeyHelper == $h' "$cfg" >/dev/null 2>&1; then
    ok "Claude is logged in by apiKeyHelper ($cfg)"
  else
    fail "apiKeyHelper in $cfg is not the image's dev-claude-api-key" "run: dev-init"
  fi
}
