# shellcheck shell=bash
#
# plugins.sh: the Claude plugins of a dev-system workspace - the image's
# default plugins (DEV_DEFAULT_PLUGINS, cbundy/dev-system#148) and the ones
# the workspace repo's committed .claude/settings.json enables (#112).
# dev-init installs them (install_plugins), dev-doctor checks them. Sourced,
# not run, after workspace.sh (it uses repo_settings). The caller defines
# log <message>, which install_plugins reports through.

# enabled_plugins <settings file>: each <plugin>@<marketplace> that its
# enabledPlugins sets to true, one per line. Fails on a file jq cannot parse.
enabled_plugins() {
  jq -r '.enabledPlugins | if type == "object" then to_entries[] | select(.value == true) | .key | select(test("^[^@]+@[^@]+$")) else empty end' "$1" 2>/dev/null
}

# repo_owned_plugins <settings file>: each plugin the repo's settings take
# over from the image, one per line - one its enabledPlugins turns off, or
# turns on and whose marketplace its extraKnownMarketplaces declares. Empty
# for a file jq cannot parse.
repo_owned_plugins() {
  jq -r '. as $settings | .enabledPlugins | if type == "object" then to_entries[] | select(.value == false or (.value == true and $settings.extraKnownMarketplaces[(.key | split("@") | last)] != null)) | .key else empty end' "$1" 2>/dev/null
}

# default_plugins: the image's default plugins, one "<plugin>@<marketplace>
# <marketplace source>" line per valid entry of DEV_DEFAULT_PLUGINS (a
# whitespace-separated list of <plugin>@<marketplace>=<source> entries, where
# <source> is what `claude plugin marketplace add` takes: a GitHub owner/repo,
# optionally #ref, or a git URL). Unset or empty: none.
default_plugins() {
  local entry
  for entry in ${DEV_DEFAULT_PLUGINS:-}; do
    valid_default_plugin "$entry" && printf '%s %s\n' "${entry%%=*}" "${entry#*=}"
  done
  return 0
}

# invalid_default_plugins: each entry of DEV_DEFAULT_PLUGINS that is not
# <plugin>@<marketplace>=<source>, one per line.
invalid_default_plugins() {
  local entry
  for entry in ${DEV_DEFAULT_PLUGINS:-}; do
    valid_default_plugin "$entry" || printf '%s\n' "$entry"
  done
  return 0
}

valid_default_plugin() {
  [[ "$1" =~ ^[^@=]+@[^@=]+=.+$ ]]
}

# wanted_default_plugins [settings file]: the default plugins (as
# default_plugins prints them) the repo's settings file leaves to the image:
# every one but those repo_owned_plugins names. A default the repo turns on
# without declaring its marketplace stays the image's, from the image's source.
wanted_default_plugins() {
  local named=""
  [ -z "${1:-}" ] || named=$(repo_owned_plugins "$1")
  default_plugins | while read -r id src; do
    grep -qxF -- "$id" <<<"$named" || printf '%s %s\n' "$id" "$src"
  done
}

# not_installed <lines> <installed ids>: each of the lines (a plugin id, then
# anything) whose id is not one of the installed ids, one per line. Fails
# when every one is installed.
not_installed() {
  awk 'NR == FNR { if ($0 != "") have[$0] = 1; next } $1 != "" && !($1 in have) { print; found = 1 } END { exit !found }' \
    <(printf '%s\n' "$2") <(printf '%s\n' "$1")
}

# default_plugin_fix <default_plugins lines>: the commands that install them
# by hand.
default_plugin_fix() {
  local id src cmds=""
  while read -r id src; do
    [ -n "$id" ] || continue
    cmds="${cmds:+$cmds; }claude plugin marketplace add $src; claude plugin install $id"
  done <<<"$1"
  printf '%s' "$cmds"
}

# claude_plugin_cli <args...>: runs `claude plugin <args>` limited to
# CLAUDE_PLUGIN_LIMIT seconds (default 60), with no stdin, and from / rather
# than a checkout: a plugin command run inside a repo can rewrite the repo's
# own .claude/settings.json (`marketplace remove` does).
claude_plugin_cli() {
  (cd / && timeout -k 5 "${CLAUDE_PLUGIN_LIMIT:-60}" claude plugin "$@" </dev/null)
}

# installed_plugins: the ids (<plugin>@<marketplace>) of the plugins Claude
# has installed, one per line. Fails when the CLI cannot list them. Limited
# to CLAUDE_PLUGIN_LIMIT seconds when the caller sets it, else 30.
installed_plugins() {
  local out
  out=$(CLAUDE_PLUGIN_LIMIT="${CLAUDE_PLUGIN_LIMIT:-30}" claude_plugin_cli list --json 2>/dev/null) || return 1
  printf '%s\n' "$out" | jq -r '.[].id'
}

# Why a `claude plugin` command failed, from its output: the text after its
# first ✘ (the CLI's own error line), else the last line; at most 300 chars.
plugin_reason() {
  local line
  line=$(printf '%s\n' "$1" | grep -m 1 '✘' | sed 's/^.*✘[[:space:]]*//')
  [ -n "$line" ] || line=$(printf '%s\n' "$1" | grep -v '^[[:space:]]*$' | tail -n 1)
  printf '%s' "${line:0:300}"
}

# plugin_limit <max>: the time limit for the next `claude plugin` call: <max>
# seconds, or what is left of the step's deadline (PLUGIN_DEADLINE, in bash's
# SECONDS) when that is less. Fails once the deadline has passed.
plugin_limit() {
  local left=$((PLUGIN_DEADLINE - SECONDS))
  [ "$left" -gt 0 ] || return 1
  echo $((left < $1 ? left : $1))
}

# claude_plugin <args...>: claude_plugin_cli limited to 60s or the rest of the
# step's deadline, with its output in $PLUGIN_OUT and the cause of a failure
# in $PLUGIN_REASON. Once the deadline has passed it runs nothing, sets
# PLUGIN_EXPIRED and fails.
claude_plugin() {
  local rc limit
  PLUGIN_OUT=""
  if ! limit=$(plugin_limit 60); then
    PLUGIN_EXPIRED=true
    PLUGIN_REASON="out of time"
    return 1
  fi
  PLUGIN_OUT=$(CLAUDE_PLUGIN_LIMIT="$limit" claude_plugin_cli "$@" 2>&1)
  rc=$?
  case "$rc" in
    0) PLUGIN_REASON="" ;;
    124 | 137) PLUGIN_REASON="it did not finish within ${limit}s" ;;
    *) PLUGIN_REASON=$(plugin_reason "$PLUGIN_OUT") ;;
  esac
  return "$rc"
}

# install_plugin <id> <marketplace> <added>: claude plugin install, retried
# once after a marketplace update unless the marketplace was only just added
# (<added> true): Claude's copy of an older one may predate the plugin. On a
# failure, $PLUGIN_REASON is the install's.
install_plugin() {
  local reason
  claude_plugin install "$1" && return 0
  [ "$3" = false ] || return 1
  reason="$PLUGIN_REASON"
  if ! claude_plugin marketplace update "$2"; then
    PLUGIN_REASON="$reason"
    return 1
  fi
  claude_plugin install "$1"
}

# add_and_install <id> <source> <fix>: one missing plugin - adds its
# marketplace from <source> first when Claude does not know it ($known, the
# marketplaces Claude knows, updated here), then installs it. <fix> is the
# retry command a WARNING names. A problem is logged and still returns 0; it
# fails only when the step's deadline stopped it.
add_and_install() {
  local id="$1" src="$2" fix="$3" mkt="${1##*@}" added=false
  if ! grep -qxF -- "$mkt" <<<"$known"; then
    if ! claude_plugin marketplace add "$src"; then
      [ "$PLUGIN_EXPIRED" = false ] || return 1
      log "WARNING: could not add Claude plugin marketplace $mkt from $src: $PLUGIN_REASON - Claude plugin $id not installed."
      log "  Fix: check that git here can read $src, then run: $fix"
      return 0
    fi
    known="$known"$'\n'"$mkt"
    added=true
  fi
  if ! install_plugin "$id" "$mkt" "$added"; then
    [ "$PLUGIN_EXPIRED" = false ] || return 1
    log "WARNING: could not install Claude plugin $id: $PLUGIN_REASON"
    log "  Fix: check that marketplace $mkt has a plugin named ${id%@*}, then run: $fix (or: claude plugin install $id)"
    return 0
  fi
  log "installed Claude plugin $id"
}

# install_repo_plugin <id>: one missing plugin the repo enables, with its
# marketplace source from $settings (github or git) when Claude does not know
# the marketplace. Returns as add_and_install.
install_repo_plugin() {
  local id="$1" mkt="${1##*@}" kind src="" ref
  if ! grep -qxF -- "$mkt" <<<"$known"; then
    kind=$(jq -r --arg m "$mkt" '.extraKnownMarketplaces[$m].source.source? // empty' "$settings" 2>/dev/null)
    ref=$(jq -r --arg m "$mkt" '.extraKnownMarketplaces[$m].source.ref? // empty' "$settings" 2>/dev/null)
    case "$kind" in
      github) src=$(jq -r --arg m "$mkt" '.extraKnownMarketplaces[$m].source.repo // empty' "$settings") ;;
      git) src=$(jq -r --arg m "$mkt" '.extraKnownMarketplaces[$m].source.url // empty' "$settings") ;;
      "")
        log "WARNING: Claude plugin $id is enabled in $settings, but marketplace $mkt is neither known to Claude nor declared there - not installed."
        log "  Fix: declare it under extraKnownMarketplaces in $settings (or run: claude plugin marketplace add <source>), then run: dev-init --repo"
        return 0
        ;;
      *)
        log "WARNING: marketplace $mkt in $settings has source type \"$kind\", which dev-init cannot add (only github and git) - Claude plugin $id not installed."
        log "  Fix: run: claude plugin marketplace add <its source> && claude plugin install $id"
        return 0
        ;;
    esac
    if [ -z "$src" ]; then
      log "WARNING: marketplace $mkt in $settings has a $kind source with no $([ "$kind" = github ] && echo repo || echo url) - Claude plugin $id not installed."
      log "  Fix: correct extraKnownMarketplaces.$mkt in $settings, then run: dev-init --repo"
      return 0
    fi
    src="$src${ref:+#$ref}"
  fi
  add_and_install "$id" "$src" "dev-init --repo"
}

# declared_marketplace <marketplace>: "<location> <ref>" of the marketplace the
# repo's $settings declares (github repo or git url; ref empty when unpinned),
# else nothing.
declared_marketplace() {
  jq -r --arg m "$1" '.extraKnownMarketplaces[$m].source? | select(.source == "github" or .source == "git") | "\(.repo // .url // "") \(.ref // "")"' "$settings" 2>/dev/null
}

# drop_moved_marketplaces: removes each known marketplace
# whose ref is no longer the one wanted (the repo's settings, else the image's
# DEV_DEFAULT_PLUGINS source), so the normal path re-adds it at the new ref and
# reinstalls its plugins. Needed because Claude cannot move a marketplace's ref
# in place (verified with the real CLI): `marketplace add` at a new ref is
# refused while the old entry exists, and `marketplace update` and
# `plugin install` keep the old ref and an already installed plugin version.
# `marketplace remove` uninstalls the marketplace's plugins (and their saved
# options), so this only acts on a real ref change, and only on a marketplace
# at the same location. Sets MOVED to the removed names (empty: none). Needs
# $settings, $plugins and $defaults.
drop_moved_marketplaces() {
  MOVED=""
  local json id mkt want loc ref have_loc have_ref src
  claude_plugin marketplace list --json || return 0
  json="$PLUGIN_OUT"
  while read -r id src; do
    [ -n "$id" ] || continue
    mkt="${id##*@}"
    if [ -n "$src" ]; then
      loc="${src%%#*}"
      ref=""
      [[ "$src" != *#* ]] || ref="${src#*#}"
    else
      [ -n "$settings" ] || continue
      want=$(declared_marketplace "$mkt")
      [ -n "$want" ] || continue
      loc="${want%% *}"
      ref="${want#* }"
    fi
    have_loc=$(printf '%s\n' "$json" | jq -r --arg m "$mkt" '.[] | select(.name == $m) | .repo // .url // empty' 2>/dev/null)
    [ "$have_loc" = "$loc" ] || continue
    have_ref=$(printf '%s\n' "$json" | jq -r --arg m "$mkt" '.[] | select(.name == $m) | .ref // empty' 2>/dev/null)
    [ "$have_ref" != "$ref" ] || continue
    if claude_plugin marketplace remove "$mkt"; then
      log "Claude plugin marketplace $mkt moved from ${have_ref:-no ref} to ${ref:-no ref}; reinstalling its plugins"
      MOVED="$MOVED $mkt"
    else
      [ "$PLUGIN_EXPIRED" = false ] || return 0
      log "WARNING: could not remove Claude plugin marketplace $mkt to move it to ${ref:-no ref}: $PLUGIN_REASON"
      log "  Fix: run: claude plugin marketplace remove $mkt; dev-init --plugins"
    fi
  done < <({ printf '%s\n' "$plugins" | sed '/^$/d; s/$/ /'; printf '%s\n' "$defaults" | sed '/^$/d'; })
  return 0
}

# install_plugins: installs each wanted plugin Claude has not installed -
# first the ones the workspace repo's committed .claude/settings.json enables
# (their marketplaces added from the sources it declares), then the image's
# default plugins (DEV_DEFAULT_PLUGINS). The repo goes
# first, so a marketplace it declares under the same name as a default one is
# added from the repo's source. User scope, in CLAUDE_CONFIG_DIR. The whole
# step has a deadline (DEV_PLUGIN_INSTALL_TIMEOUT, default 120s), each CLI
# call is limited to 60s or what is left of it, and once it has passed the
# plugins not yet installed get one WARNING. Always returns 0.
install_plugins() {
  local settings="" plugins="" defaults installed MOVED known id src i limit bad budget="${DEV_PLUGIN_INSTALL_TIMEOUT:-120}"
  local -a missing=() sources=()
  case "$budget" in '' | *[!0-9]*) budget=120 ;; esac
  PLUGIN_DEADLINE=$((SECONDS + budget))
  PLUGIN_EXPIRED=false
  command -v claude >/dev/null 2>&1 || return 0
  while IFS= read -r bad; do
    [ -z "$bad" ] || log "WARNING: DEV_DEFAULT_PLUGINS entry \"$bad\" is not <plugin>@<marketplace>=<marketplace source> - skipped."
  done < <(invalid_default_plugins)
  # shellcheck disable=SC2119 # the argument is optional; none means the default
  if settings=$(repo_settings); then
    if ! plugins=$(enabled_plugins "$settings"); then
      log "WARNING: $settings is not valid JSON - the Claude plugins it enables are not installed."
      log "  Fix: correct it, then run: dev-init --repo"
      plugins=""
    fi
  else
    settings=""
  fi
  defaults=$(wanted_default_plugins "$settings")
  plugins=$(not_installed "$plugins" "$(printf '%s\n' "$defaults" | cut -d' ' -f1)") || plugins=""
  [ -n "$plugins$defaults" ] || return 0
  # Unknown (the listing failed) means try them all: an install of a plugin
  # that is already there is a no-op.
  installed=""
  if limit=$(plugin_limit 30); then
    installed=$(CLAUDE_PLUGIN_LIMIT="$limit" installed_plugins) || installed=""
  fi
  # A marketplace pinned to another ref than it is wanted at is removed, so
  # its plugins count as missing below and come back at the wanted ref.
  drop_moved_marketplaces
  if [ -n "$MOVED" ]; then
    installed=""
    if limit=$(plugin_limit 30); then
      installed=$(CLAUDE_PLUGIN_LIMIT="$limit" installed_plugins) || installed=""
    fi
  fi
  # A repo plugin's source is empty: install_repo_plugin reads it from $settings.
  while IFS= read -r id; do
    missing+=("$id") && sources+=("")
  done < <(not_installed "$plugins" "$installed")
  while read -r id src; do
    missing+=("$id") && sources+=("$src")
  done < <(not_installed "$defaults" "$installed")
  [ "${#missing[@]}" -gt 0 ] || return 0
  known=""
  if claude_plugin marketplace list --json; then
    known=$(printf '%s\n' "$PLUGIN_OUT" | jq -r '.[].name' 2>/dev/null)
  fi

  for i in "${!missing[@]}"; do
    if [ "$PLUGIN_EXPIRED" = false ]; then
      if [ -z "${sources[i]}" ]; then
        install_repo_plugin "${missing[i]}" && continue
      else
        add_and_install "${missing[i]}" "${sources[i]}" "dev-init --plugins" && continue
      fi
    fi
    log "WARNING: the Claude plugin install ran out of its ${budget}s (DEV_PLUGIN_INSTALL_TIMEOUT) - not installed: ${missing[*]:i}"
    log "  Fix: check this container's network access to the plugin marketplaces, then run: dev-init --plugins"
    break
  done
  return 0
}
