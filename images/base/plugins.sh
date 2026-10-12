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
  local named="" defaults marketplaces id src
  [ -z "${1:-}" ] || named=$(repo_owned_plugins "$1")
  defaults=$(default_plugins | while read -r id src; do
    grep -qxF -- "$id" <<<"$named" || printf '%s %s\n' "$id" "$src"
  done)
  marketplaces=$(wanted_marketplaces "${1:-}" "" "$defaults")
  while read -r id src; do
    [ -n "$id" ] || continue
    src=$(printf '%s\n' "$marketplaces" | awk -v m="${id##*@}" '$1 == m { print $2; exit }')
    printf '%s %s\n' "$id" "$src"
  done <<<"$defaults"
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
# own .claude/settings.json (`marketplace remove` does). CLAUDE_PLUGIN_CWD
# names another directory to run from (prune_orphan_installs sets it).
claude_plugin_cli() {
  (cd "${CLAUDE_PLUGIN_CWD:-/}" && timeout -k 5 "${CLAUDE_PLUGIN_LIMIT:-60}" claude plugin "$@" </dev/null)
}

# installed_plugins: the ids (<plugin>@<marketplace>) of the plugins Claude
# has installed, one per line (install_ids). Fails when the CLI cannot list
# them. Limited to CLAUDE_PLUGIN_LIMIT seconds when the caller sets it, else 30.
installed_plugins() {
  local out
  out=$(installed_plugins_json) || return 1
  install_ids "$out"
}

# orphan_path <projectPath>: succeeds for an absolute project path that no
# longer exists (a deleted worktree): an install there runs nowhere.
orphan_path() {
  [[ "$1" == /* ]] && [ ! -e "$1" ]
}

# install_ids <installs listing>: the ids in a `list --json` listing, one per
# install, leaving out the project-scope ones at an orphan_path. Fails when it
# is not valid JSON.
install_ids() {
  local rows id scope dir
  rows=$(printf '%s\n' "$1" | jq -r '.[] | [.id, (.scope // "user"), (.projectPath // "")] | @tsv' 2>/dev/null) || return 1
  while IFS=$'\t' read -r id scope dir; do
    [ -n "$id" ] || continue
    [ "$scope" = project ] && orphan_path "$dir" && continue
    printf '%s\n' "$id"
  done <<<"$rows"
}

# installed_plugins_json: `claude plugin list --json` (every install, with its
# scope and projectPath), limited like installed_plugins.
installed_plugins_json() {
  CLAUDE_PLUGIN_LIMIT="${CLAUDE_PLUGIN_LIMIT:-30}" claude_plugin_cli list --json 2>/dev/null
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
    log "  Fix: check that marketplace $mkt has a plugin named ${id%@*}, then run: $fix$([[ "$fix" == *"claude plugin install $id"* ]] || echo " (or: claude plugin install $id)")"
    return 0
  fi
  log "installed Claude plugin $id"
}

install_wanted_plugin() {
  local id="$1" src="$2" fix="$3" mkt="${1##*@}" kind
  if [ -z "$src" ] && ! grep -qxF -- "$mkt" <<<"$known"; then
    kind=$(jq -r --arg m "$mkt" '.extraKnownMarketplaces[$m].source.source? // empty' "$settings" 2>/dev/null)
    case "$kind" in
      github | git)
        log "WARNING: marketplace $mkt in $settings has a $kind source with no $([ "$kind" = github ] && echo repo || echo url) - Claude plugin $id not installed."
        log "  Fix: correct extraKnownMarketplaces.$mkt in $settings, then run: dev-init --repo"
        ;;
      "")
        log "WARNING: Claude plugin $id is enabled in $settings, but marketplace $mkt is neither known to Claude nor declared there - not installed."
        log "  Fix: declare it under extraKnownMarketplaces in $settings (or run: claude plugin marketplace add <source>), then run: dev-init --repo"
        ;;
      *)
        log "WARNING: marketplace $mkt in $settings has source type \"$kind\", which dev-init cannot add (only github and git) - Claude plugin $id not installed."
        log "  Fix: run: claude plugin marketplace add <its source> && claude plugin install $id"
        ;;
    esac
    return 0
  fi
  add_and_install "$id" "$src" "$fix"
}

# candidate_plugin_ref: the ref DEV_CANDIDATE_PLUGIN_REF asks for (a release
# candidate), printed; fails when it is unset or not a valid ref.
candidate_plugin_ref() {
  [[ "${DEV_CANDIDATE_PLUGIN_REF:-}" =~ ^[A-Za-z0-9._/-]+$ ]] || return 1
  printf '%s\n' "$DEV_CANDIDATE_PLUGIN_REF"
}

# dev_system_location <location>: succeeds when the marketplace location is
# this project's repo (a github repo, or its https git URL).
dev_system_location() {
  case "$1" in
    cbundy/dev-system | https://github.com/cbundy/dev-system | https://github.com/cbundy/dev-system.git) return 0 ;;
  esac
  return 1
}

# wanted_marketplaces: "<marketplace> <source>" per marketplace. A repo's
# declaration with no ref, at the same location as the image default's source,
# takes the default's ref: the image's pin, not main's HEAD. A declared ref
# wins, and so does a declaration at another location. With
# DEV_CANDIDATE_PLUGIN_REF set and valid, a cbundy/dev-system marketplace is
# wanted at that ref, over both the repo's declaration and the image default.
wanted_marketplaces() {
  local settings="$1" plugins="$2" defaults="$3" mkt src declared inherit candidate=""
  candidate=$(candidate_plugin_ref) || candidate=""
  while read -r mkt src; do
    if [ -n "$settings" ]; then
      # The ref a no-ref declaration inherits is the image default's, even for a
      # plugin the repo took over from the image (so $defaults lacks it).
      inherit=$(default_plugins | awk -v m="$mkt" '{ n = $1; sub(/^.*@/, "", n); if (n == m) { print $2; exit } }')
      declared=$(jq -r --arg m "$mkt" --arg fallback "$src" --arg inherit "$inherit" '
        ($inherit | split("#")[0]) as $fallbackLocation |
        ($inherit | if contains("#") then sub("^[^#]*#"; "") else "" end) as $fallbackRef |
        .extraKnownMarketplaces[$m] as $declaration |
        if $declaration == null then $fallback
        else $declaration.source |
          (if .source == "github" then .repo elif .source == "git" then .url else "" end) as $location |
          (if (.ref // "") != "" then .ref
           elif ($location // "") == $fallbackLocation then $fallbackRef
           else "" end) as $ref |
          if ($location // "") == "" then ""
          else $location + (if $ref == "" then "" else "#" + $ref end) end
        end' "$settings" 2>/dev/null) && src="$declared"
    fi
    if [ -n "$candidate" ] && dev_system_location "${src%%#*}"; then
      src="${src%%#*}#$candidate"
    fi
    printf '%s %s\n' "$mkt" "$src"
  done < <({ printf '%s\n' "$plugins"; printf '%s\n' "$defaults"; } |
    awk '$1 != "" { sub(/^.*@/, "", $1); if (!seen[$1]++) names[++n] = $1; if (source[$1] == "") source[$1] = $2 }
      END { for (i = 1; i <= n; i++) print names[i], source[names[i]] }')
}

# ref_resolves <location> <ref>: succeeds when <ref> is a tag or branch on the
# remote of <location> (a github owner/repo, or a git URL). Never prompts, and
# is limited to what is left of the step's deadline. A full commit SHA cannot
# be listed, so it counts as resolvable.
ref_resolves() {
  local url="$1" limit
  [[ "$2" =~ ^[0-9a-f]{40}$ ]] && return 0
  [[ "$url" != */* || "$url" == *:* ]] || url="https://github.com/$url.git"
  limit=$(plugin_limit 30) || return 1
  GIT_TERMINAL_PROMPT=0 timeout -k 5 "$limit" git ls-remote --exit-code "$url" "refs/tags/$2" "refs/heads/$2" </dev/null >/dev/null 2>&1
}

# drop_moved_marketplaces: removes each known marketplace
# whose ref is no longer the one wanted (the repo's settings, else the image's
# DEV_DEFAULT_PLUGINS source), so the normal path re-adds it at the new ref and
# reinstalls its plugins. Needed because Claude cannot move a marketplace's ref
# in place (verified with the real CLI): `marketplace add` at a new ref is
# refused while the old entry exists, and `marketplace update` and
# `plugin install` keep the old ref and an already installed plugin version.
# `marketplace remove` uninstalls the marketplace's plugins in every scope (and
# their saved options), so this only acts on a real ref change, and only on a marketplace
# at the same location. A move to a ref that does not exist on the remote (a
# release pinned before its tag is cut) or cannot be checked (network, auth,
# the step's deadline) is skipped with one WARNING, so the installed plugins
# stay. Sets MOVED to the removed names (empty: none) and RESTORE to the ids
# (<plugin>@<marketplace>) of the user-scope plugins that were installed from
# them, wanted or installed by hand, which install_plugins installs again
# after the move. Needs $marketplaces and $INSTALLED_JSON (the installs listing).
drop_moved_marketplaces() {
  MOVED=""
  RESTORE=""
  local json hand mkt loc ref have_loc have_ref src
  claude_plugin marketplace list --json || return 0
  json="$PLUGIN_OUT"
  while read -r mkt src; do
    [ -n "$src" ] || continue
    loc="${src%%#*}"
    ref=""
    [[ "$src" != *#* ]] || ref="${src#*#}"
    have_loc=$(printf '%s\n' "$json" | jq -r --arg m "$mkt" '.[] | select(.name == $m) | .repo // .url // empty' 2>/dev/null)
    [ "$have_loc" = "$loc" ] || continue
    have_ref=$(printf '%s\n' "$json" | jq -r --arg m "$mkt" '.[] | select(.name == $m) | .ref // empty' 2>/dev/null)
    [ "$have_ref" != "$ref" ] || continue
    if [ -n "$ref" ] && ! ref_resolves "$loc" "$ref"; then
      [ "$PLUGIN_DEADLINE" -gt "$SECONDS" ] || return 0
      log "WARNING: Claude plugin marketplace $mkt is wanted at ref $ref, but that ref was not found on $loc (or could not be checked) - keeping it at ${have_ref:-no ref}."
      log "  Fix: if a release is in progress nothing is needed, the next start or dev-init --plugins moves it once the tag exists; otherwise correct the ref in ${settings:-DEV_DEFAULT_PLUGINS or DEV_CANDIDATE_PLUGIN_REF}"
      continue
    fi
    hand=$(printf '%s\n' "${INSTALLED_JSON:-[]}" | jq -r --arg m "$mkt" '.[] | select((.scope // "user") == "user" and (.id | endswith("@" + $m))) | .id' 2>/dev/null) || hand=""
    if claude_plugin marketplace remove "$mkt"; then
      RESTORE="${RESTORE:+$RESTORE$'\n'}$hand"
      log "Claude plugin marketplace $mkt moved from ${have_ref:-no ref} to ${ref:-no ref}; reinstalling its plugins"
      MOVED="$MOVED $mkt"
    else
      [ "$PLUGIN_EXPIRED" = false ] || return 0
      log "WARNING: could not remove Claude plugin marketplace $mkt to move it to ${ref:-no ref}: $PLUGIN_REASON"
      log "  Fix: run: claude plugin marketplace remove $mkt; dev-init --plugins"
    fi
  done <<<"$marketplaces"
  return 0
}

# prune_orphan_installs: uninstalls each project-scope plugin install whose
# projectPath no longer exists (a deleted worktree). Claude only uninstalls a
# project-scope plugin from inside its project, so the missing directory is
# created, the uninstall run there, and only the directories created removed.
# Only an orphan_path is acted on: an existing path is never touched, and a
# relative one is skipped. Stays within the step's deadline. Takes the
# installs listing (`list --json`). Logs one line with the count pruned, if any.
prune_orphan_installs() {
  local json="$1" id dir parent pruned=0
  local -a made
  while IFS=$'\t' read -r id dir; do
    [ -n "$id" ] || continue
    orphan_path "$dir" || continue
    [ "$PLUGIN_DEADLINE" -gt "$SECONDS" ] || break
    # What gets created, and removed again: the missing path and its missing ancestors.
    made=("$dir")
    parent=$(dirname "$dir")
    while [ ! -e "$parent" ] && [ "$parent" != "$(dirname "$parent")" ]; do
      made+=("$parent")
      parent=$(dirname "$parent")
    done
    mkdir -p -- "$dir" 2>/dev/null || continue
    if CLAUDE_PLUGIN_CWD="$dir" claude_plugin uninstall "$id" --scope project; then
      pruned=$((pruned + 1))
    fi
    # Deepest first; a directory that gained files stays (rmdir refuses it).
    rmdir -- "${made[@]}" 2>/dev/null || true
  done < <(printf '%s\n' "$json" | jq -r '.[] | select(.scope == "project" and (.projectPath // "") != "") | [.id, .projectPath] | @tsv' 2>/dev/null)
  [ "$pruned" -eq 0 ] || log "pruned $pruned Claude plugin install(s) for project paths that no longer exist"
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
# plugins not yet installed get one WARNING. Project-scope installs whose
# project directory is gone are pruned last, on what is left of the deadline
# (prune_orphan_installs), and also when no plugin is wanted; they never count
# as installed. A marketplace is only moved to a
# ref that exists on its remote (see drop_moved_marketplaces), and
# DEV_CANDIDATE_PLUGIN_REF repoints the cbundy/dev-system marketplace at a
# release candidate. A move keeps the user-scope plugins installed from the
# marketplace, hand-installed ones included: they are installed again at the
# new ref; a WARNING for one of those names the install by hand. Always returns 0.
install_plugins() {
  local settings="" plugins="" defaults wanted marketplaces installed MOVED RESTORE INSTALLED_JSON="" known id src fix by_hand i limit bad budget="${DEV_PLUGIN_INSTALL_TIMEOUT:-120}"
  local -a missing=()
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
  if limit=$(plugin_limit 30); then
    INSTALLED_JSON=$(CLAUDE_PLUGIN_LIMIT="$limit" installed_plugins_json) || INSTALLED_JSON=""
  fi
  if [ -z "$plugins$defaults" ]; then
    prune_orphan_installs "$INSTALLED_JSON"
    return 0
  fi
  if [ -n "${DEV_CANDIDATE_PLUGIN_REF:-}" ] && ! candidate_plugin_ref >/dev/null; then
    log "WARNING: DEV_CANDIDATE_PLUGIN_REF \"$DEV_CANDIDATE_PLUGIN_REF\" is not a valid ref ([A-Za-z0-9._/-]+) - ignored."
  fi
  marketplaces=$(wanted_marketplaces "$settings" "$plugins" "$defaults")
  # A marketplace pinned to another ref than it is wanted at is removed, so
  # its plugins count as missing below and come back at the wanted ref.
  drop_moved_marketplaces
  if [ -n "$MOVED" ]; then
    INSTALLED_JSON=""
    if limit=$(plugin_limit 30); then
      INSTALLED_JSON=$(CLAUDE_PLUGIN_LIMIT="$limit" installed_plugins_json) || INSTALLED_JSON=""
    fi
  fi
  # Unknown (the listing failed) means try them all: an install of a plugin
  # that is already there is a no-op.
  installed=$(install_ids "$INSTALLED_JSON") || installed=""
  wanted=$(printf '%s\n%s\n' "$plugins" "$defaults" | cut -d' ' -f1)
  while IFS= read -r id; do
    missing+=("$id")
  done < <(not_installed "$(printf '%s\n%s\n' "$wanted" "$RESTORE" | awk 'NF && !seen[$0]++')" "$installed")
  known=""
  if [ "${#missing[@]}" -gt 0 ] && claude_plugin marketplace list --json; then
    known=$(printf '%s\n' "$PLUGIN_OUT" | jq -r '.[].name' 2>/dev/null)
  fi

  for i in "${!missing[@]}"; do
    if [ "$PLUGIN_EXPIRED" = false ]; then
      id="${missing[i]}"
      src=$(printf '%s\n' "$marketplaces" | awk -v m="${id##*@}" '$1 == m { print $2; exit }')
      fix="dev-init --plugins"
      grep -qxF -- "$id" <<<"$plugins" && fix="dev-init --repo"
      grep -qxF -- "$id" <<<"$wanted" || fix="dev-init --plugins; claude plugin install $id"
      install_wanted_plugin "$id" "$src" "$fix" && continue
    fi
    by_hand=""
    for id in "${missing[@]:i}"; do
      grep -qxF -- "$id" <<<"$wanted" || by_hand="$by_hand; claude plugin install $id"
    done
    log "WARNING: the Claude plugin install ran out of its ${budget}s (DEV_PLUGIN_INSTALL_TIMEOUT) - not installed: ${missing[*]:i}"
    log "  Fix: check this container's network access to the plugin marketplaces, then run: dev-init --plugins$by_hand"
    break
  done
  prune_orphan_installs "$INSTALLED_JSON"
  return 0
}
