# shellcheck shell=bash
# shellcheck disable=SC2016,SC2154
#
# Section 13 of the base image container tests. Sourced by test.sh after lib.sh, which
# provides IMAGE, RUN_ID, SECRET, check, in_image and the rest; never run directly.

echo "== 13. the Claude plugins (the default ones and the workspace repo's)"

# A stub claude for `claude plugin`: it records each call (its directory and
# arguments) in /tmp/plugin-calls and keeps its state as files in
# /tmp/plugin-state - mkt-<name> for a known marketplace, inst-<id> for an
# installed plugin. `marketplace add <source>` names the marketplace after the
# source's last path part (without #ref and .git; callum for
# cbundy/dev-system, as the real one) and fails for a source
# containing "fail"; `install` fails like the real CLI (a ✘ line) while
# /tmp/plugin-fail exists, or once for /tmp/plugin-fail-once, or when its
# marketplace is unknown. `auth status` is logged in.
STUB_PLUGIN='#!/bin/bash
[ "$1" = auth ] && { echo "{\"loggedIn\":true}"; exit 0; }
[ "$1" = plugin ] || exit 0
shift
echo "$PWD $*" >> /tmp/plugin-calls
s=/tmp/plugin-state
mkdir -p "$s"
ids() { for f in "$s/$1"-*; do [ -e "$f" ] && echo "${f#"$s/$1"-}"; done; }
case "$1 ${2:-}" in
  "list --json") ids inst | jq -R . | jq -s "map({id: .})" ;;
  "marketplace list") ids mkt | jq -R . | jq -s "map({name: .})" ;;
  "marketplace add")
    case "$3" in *fail*) echo "Adding marketplace…✘ Failed to add marketplace: no such repo"; exit 1 ;; esac
    n="${3%%#*}"; n="${n%.git}"; n="${n##*/}"; [ "${3%%#*}" = cbundy/dev-system ] && n=callum
    touch "$s/mkt-$n"; echo "✔ Successfully added marketplace: $n" ;;
  "marketplace update") touch "$s/updated-$3" ;;
  install\ *)
    if [ -e /tmp/plugin-fail ] || { [ -e /tmp/plugin-fail-once ] && rm /tmp/plugin-fail-once; }; then
      echo "Installing plugin \"$2\"...✘ Failed to install plugin \"$2\": boom"; exit 1
    fi
    [ -e "$s/mkt-${2##*@}" ] || { echo "✘ Failed to install plugin \"$2\": not found in marketplace \"${2##*@}\""; exit 1; }
    touch "$s/inst-$2"; echo "✔ Successfully installed plugin: $2 (scope: user)" ;;
esac'
# The workspace: a repo at /tmp/ws whose .claude/settings.json is $SETTINGS
# (none when it is empty), with the stub first on PATH.
WITH_PLUGIN_WS='mkdir -p /tmp/stub && printf "%s\n" "$STUB_PLUGIN" > /tmp/stub/claude && chmod +x /tmp/stub/claude &&
  export PATH=/tmp/stub:$PATH && git init -q /tmp/ws &&
  if [ -n "${SETTINGS:-}" ]; then mkdir /tmp/ws/.claude && printf "%s\n" "$SETTINGS" > /tmp/ws/.claude/settings.json; fi'
# Enables one@gh (a github marketplace with a ref), two@gitm (a git one) and
# three@odd (a directory one, which dev-init cannot add); off@gh is false.
PLUGIN_SETTINGS='{
  "extraKnownMarketplaces": {
    "gh": { "source": { "source": "github", "repo": "me/gh", "ref": "v1" } },
    "gitm": { "source": { "source": "git", "url": "https://example.com/gitm.git" } },
    "odd": { "source": { "source": "directory", "path": "./odd" } }
  },
  "enabledPlugins": { "one@gh": true, "two@gitm": true, "off@gh": false, "three@odd": true }
}'
# plugin_check <description> <script> [docker run args...]: the script runs in
# a throwaway container with the workspace and stub above and $SETTINGS
# (default PLUGIN_SETTINGS).
plugin_check() {
  local desc="$1" script="$2"
  shift 2
  check "$desc" in_image "$WITH_PLUGIN_WS && $script" -e STUB_PLUGIN="$STUB_PLUGIN" -e SETTINGS="$PLUGIN_SETTINGS" \
    -e DEV_WORKSPACE=/tmp/ws --entrypoint "" "$@"
}

plugin_check "dev-init adds each enabled plugin's marketplace from its github or git source and installs it, outside the checkout" '
  out=$(dev-init 2>&1); rc=$?; echo "$out" | grep -A1 -i plugin; cat /tmp/plugin-calls
  [ $rc = 0 ] &&
  [ "$(grep -vE " list( |$)" /tmp/plugin-calls)" = "$(printf "%s\n" "/ marketplace add me/gh#v1" "/ install one@gh" \
    "/ marketplace add https://example.com/gitm.git" "/ install two@gitm")" ] &&
  ! grep -qv "^/ " /tmp/plugin-calls &&
  echo "$out" | grep -qxF "dev-init: installed Claude plugin one@gh" &&
  echo "$out" | grep -qxF "dev-init: installed Claude plugin two@gitm" &&
  echo "$out" | grep -qF "dev-init: WARNING: marketplace odd in /tmp/ws/.claude/settings.json has source type \"directory\", which dev-init cannot add" &&
  echo "$out" | grep -qF "dev-doctor: WARN Claude plugins enabled in /tmp/ws/.claude/settings.json are not installed: three@odd"'
plugin_check "dev-init installs nothing that is installed already, and dev-doctor finds them all" '
  mkdir -p /tmp/plugin-state && touch /tmp/plugin-state/mkt-gh /tmp/plugin-state/inst-one@gh
  out=$(dev-init 2>&1); rc=$?; cat /tmp/plugin-calls
  [ $rc = 0 ] && ! grep -qE " (install|marketplace add)" /tmp/plugin-calls &&
  ! echo "$out" | grep -q "installed Claude plugin" &&
  echo "$out" | grep -qxF "dev-doctor: OK   Claude plugins enabled in /tmp/ws/.claude/settings.json are installed"' \
  -e SETTINGS='{"extraKnownMarketplaces":{"gh":{"source":{"source":"github","repo":"me/gh"}}},"enabledPlugins":{"one@gh":true}}'
plugin_check "a plugin set to false runs no plugin command" '
  out=$(dev-init 2>&1); rc=$?; cat /tmp/plugin-calls 2>/dev/null
  [ $rc = 0 ] && ! test -e /tmp/plugin-calls && ! echo "$out" | grep -qi "plugin"' \
  -e SETTINGS='{"extraKnownMarketplaces":{"gh":{"source":{"source":"github","repo":"me/gh"}}},"enabledPlugins":{"one@gh":false}}'
plugin_check "no .claude/settings.json runs no plugin command" '
  out=$(dev-init 2>&1); rc=$?; cat /tmp/plugin-calls 2>/dev/null
  [ $rc = 0 ] && ! test -e /tmp/plugin-calls && ! echo "$out" | grep -qi "plugin"' \
  -e SETTINGS=
plugin_check "an invalid settings file: a WARNING from dev-init and dev-doctor, and no plugin command" '
  out=$(dev-init 2>&1); rc=$?; echo "$out" | grep -A1 "not valid JSON"
  [ $rc = 0 ] && ! test -e /tmp/plugin-calls &&
  echo "$out" | grep -qxF "dev-init: WARNING: /tmp/ws/.claude/settings.json is not valid JSON - the Claude plugins it enables are not installed." &&
  echo "$out" | grep -qF "dev-doctor: WARN /tmp/ws/.claude/settings.json is not valid JSON"' \
  -e SETTINGS='{"enabledPlugins":'
plugin_check "a failing install or marketplace add: dev-init exits 0 with a WARNING naming the cause, and a Fix line" '
  touch /tmp/plugin-fail
  out=$(dev-init 2>&1); rc=$?; echo "$out" | grep -A1 "WARNING: could not"; cat /tmp/plugin-calls
  [ $rc = 0 ] &&
  echo "$out" | grep -qxF "dev-init: WARNING: could not install Claude plugin one@gh: Failed to install plugin \"one@gh\": boom" &&
  echo "$out" | grep -A1 "could not install Claude plugin one@gh" | grep -qF "dev-init:   Fix: " &&
  echo "$out" | grep -qxF "dev-init: WARNING: could not add Claude plugin marketplace fail from me/fail: Failed to add marketplace: no such repo - Claude plugin x@fail not installed." &&
  ! grep -q "marketplace update" /tmp/plugin-calls && ! grep -q "install x@fail" /tmp/plugin-calls &&
  ! echo "$out" | grep -q "installed Claude plugin"' \
  -e SETTINGS='{"extraKnownMarketplaces":{"gh":{"source":{"source":"github","repo":"me/gh"}},"fail":{"source":{"source":"github","repo":"me/fail"}}},"enabledPlugins":{"one@gh":true,"x@fail":true}}'
plugin_check "an install that fails on a marketplace Claude already knew is retried once after updating it" '
  mkdir -p /tmp/plugin-state && touch /tmp/plugin-state/mkt-gh /tmp/plugin-fail-once
  out=$(dev-init 2>&1); rc=$?; cat /tmp/plugin-calls
  [ $rc = 0 ] &&
  [ "$(grep -vE " list( |$)" /tmp/plugin-calls)" = "$(printf "%s\n" "/ install one@gh" "/ marketplace update gh" "/ install one@gh")" ] &&
  echo "$out" | grep -qxF "dev-init: installed Claude plugin one@gh"' \
  -e SETTINGS='{"extraKnownMarketplaces":{"gh":{"source":{"source":"github","repo":"me/gh"}}},"enabledPlugins":{"one@gh":true}}'
plugin_check "dev-init --repo installs them too (a clone that arrives after the start)" '
  out=$(dev-init --repo 2>&1); rc=$?; echo "$out"
  [ $rc = 0 ] && echo "$out" | grep -qxF "dev-init: installed Claude plugin one@gh" &&
  echo "$out" | grep -qxF "dev-init: installed Claude plugin two@gitm"'

# A `claude plugin` that never answers (an unreachable network): the step's
# deadline stops it. Without the deadline this takes minutes (a 30s listing,
# then 60s per call).
plugin_check "a claude plugin that hangs: the step stops at DEV_PLUGIN_INSTALL_TIMEOUT with one WARNING naming the plugins not installed" '
  printf "%s\n" "#!/bin/bash" "[ \"\$1\" = plugin ] && exec sleep 600" "exit 0" > /tmp/stub/claude
  start=$SECONDS; out=$(dev-init --repo 2>&1); rc=$?; took=$((SECONDS - start)); echo "$out"; echo "took ${took}s"
  [ $rc = 0 ] && [ $took -lt 15 ] &&
  [ "$(echo "$out" | grep -c WARNING)" = 1 ] &&
  echo "$out" | grep -qxF "dev-init: WARNING: the Claude plugin install ran out of its 3s (DEV_PLUGIN_INSTALL_TIMEOUT) - not installed: one@gh two@gitm three@odd" &&
  echo "$out" | grep -A1 "ran out of its" | grep -qF "dev-init:   Fix: " &&
  echo "$out" | grep -A1 "ran out of its" | grep -qF "dev-init --plugins"' \
  -e DEV_PLUGIN_INSTALL_TIMEOUT=3
plugin_check "a full dev-init starts the login page before it installs the plugins" '
  out=$(dev-init 2>&1); rc=$?; echo "$out" | grep -nE "login page|installed Claude plugin"
  page=$(echo "$out" | grep -n "dev-init: started the login page on port 8765" | cut -d: -f1)
  plugin=$(echo "$out" | grep -n "dev-init: installed Claude plugin one@gh" | cut -d: -f1)
  [ $rc = 0 ] && [ -n "$page" ] && [ -n "$plugin" ] && [ "$page" -lt "$plugin" ]' \
  -e DEV_LOGIN_PORT=8765

# The image's default plugins (DEV_DEFAULT_PLUGINS, #148). The stub tests
# set the image's value inside the container (docker() empties it).
DEFAULT_PLUGINS='export DEV_DEFAULT_PLUGINS=callum-flow@callum=cbundy/dev-system;'
check "the image's default Claude plugins are callum-flow from cbundy/dev-system, and plugins.sh is baked in" bash -c "
  docker image inspect -f '{{json .Config.Env}}' '$IMAGE' | jq -e 'any(.[]; test(\"^DEV_DEFAULT_PLUGINS=callum-flow@callum=cbundy/dev-system(#v[0-9][^ ]*)?$\"))' &&
  docker run --rm --entrypoint '' '$IMAGE' test -f /usr/local/share/dev-system/plugins.sh"
plugin_check "no repo: dev-init installs the default plugin, and dev-doctor finds it" "$DEFAULT_PLUGINS"'
  rm -rf /tmp/ws; out=$(dev-init 2>&1); rc=$?; echo "$out" | grep -i plugin; cat /tmp/plugin-calls
  [ $rc = 0 ] &&
  [ "$(grep -vE " list( |$)" /tmp/plugin-calls)" = "$(printf "%s\n" "/ marketplace add cbundy/dev-system" "/ install callum-flow@callum")" ] &&
  echo "$out" | grep -qxF "dev-init: installed Claude plugin callum-flow@callum" &&
  echo "$out" | grep -qxF "dev-doctor: OK   default Claude plugins are installed: callum-flow@callum"' \
  -e SETTINGS=
plugin_check "a repo that is not onboarded gets the default plugin too, next to nothing of its own" "$DEFAULT_PLUGINS"'
  out=$(dev-init 2>&1); rc=$?; cat /tmp/plugin-calls
  [ $rc = 0 ] && echo "$out" | grep -qxF "dev-init: installed Claude plugin callum-flow@callum" &&
  [ "$(grep -c " install " /tmp/plugin-calls)" = 1 ]' \
  -e SETTINGS='{"permissions":{"allow":[]}}'
plugin_check "a repo that enables callum-flow itself: installed once, from the repo's marketplace" "$DEFAULT_PLUGINS"'
  out=$(dev-init 2>&1); rc=$?; cat /tmp/plugin-calls
  [ $rc = 0 ] &&
  [ "$(grep -vE " list( |$)" /tmp/plugin-calls)" = "$(printf "%s\n" "/ marketplace add cbundy/dev-system#v1" "/ install callum-flow@callum")" ] &&
  echo "$out" | grep -qxF "dev-doctor: OK   Claude plugins enabled in /tmp/ws/.claude/settings.json are installed" &&
  ! echo "$out" | grep -q "default Claude plugins"' \
  -e SETTINGS='{"extraKnownMarketplaces":{"callum":{"source":{"source":"github","repo":"cbundy/dev-system","ref":"v1"}}},"enabledPlugins":{"callum-flow@callum":true}}'
plugin_check "an enabled default without a repo marketplace installs once in every dev-init mode" "$DEFAULT_PLUGINS"'
  for mode in "" --repo --plugins; do
    rm -rf /tmp/plugin-state /tmp/plugin-calls
    out=$(dev-init "$mode" 2>&1); rc=$?; echo "$out"; cat /tmp/plugin-calls
    [ $rc = 0 ] &&
    [ "$(grep -vE " list( |$)" /tmp/plugin-calls)" = "$(printf "%s\n" "/ marketplace add cbundy/dev-system" "/ install callum-flow@callum")" ] &&
    ! echo "$out" | grep -q "WARNING:.*plugin" || exit 1
    dev-init "$mode" >/dev/null 2>&1 && [ "$(grep -c " install " /tmp/plugin-calls)" = 1 ] || exit 1
  done
  dev-doctor --warn-only | grep -qxF "dev-doctor: OK   default Claude plugins are installed: callum-flow@callum"' \
  -e SETTINGS='{"enabledPlugins":{"callum-flow@callum":true}}'
plugin_check "no network: dev-init warns and starts, and dev-doctor warns naming the fix" "$DEFAULT_PLUGINS"'
  printf "%s\n" "#!/bin/bash" "[ \"\$1 \$2 \$3\" = \"plugin marketplace add\" ] && { echo \"✘ Failed to add marketplace: could not resolve host\"; exit 1; }" "[ \"\$1 \$2\" = \"plugin list\" ] && { echo []; exit 0; }" "[ \"\$1\" = plugin ] && { echo []; exit 0; }" "exit 0" > /tmp/stub/claude
  out=$(dev-init 2>&1); rc=$?; echo "$out" | grep -A1 -iE "plugin"
  [ $rc = 0 ] &&
  echo "$out" | grep -qxF "dev-init: WARNING: could not add Claude plugin marketplace callum from cbundy/dev-system: Failed to add marketplace: could not resolve host - Claude plugin callum-flow@callum not installed." &&
  echo "$out" | grep -qxF "dev-doctor: WARN default Claude plugins (DEV_DEFAULT_PLUGINS) are not installed: callum-flow@callum" &&
  echo "$out" | grep -qxF "dev-doctor:        fix: run: dev-init --plugins (or by hand: claude plugin marketplace add cbundy/dev-system; claude plugin install callum-flow@callum), then start a new Claude session"' \
  -e SETTINGS='{"enabledPlugins":{"callum-flow@callum":true}}'
# The one real install (the network, GitHub and the real claude CLI, no
# login): a workspace with every setting at its default and no repo comes up
# with the callum-flow skills installed and enabled. command docker keeps the
# image's DEV_DEFAULT_PLUGINS.
check "a fresh workspace with no repo gets the real callum-flow plugin and its skills" command docker run --rm -e DEV_MODELS_URL= \
  --entrypoint "" "$IMAGE" bash -c '
  out=$(dev-init 2>&1); rc=$?; echo "$out" | grep -A1 -i plugin
  list=$(cd / && claude plugin list --json); echo "$list"
  [ $rc = 0 ] && echo "$out" | grep -qxF "dev-init: installed Claude plugin callum-flow@callum" &&
  echo "$list" | jq -e "any(.[]; .id == \"callum-flow@callum\" and .enabled == true)" >/dev/null &&
  skills=$(ls "$(echo "$list" | jq -r ".[] | select(.id == \"callum-flow@callum\") | .installPath")/skills") && echo "$skills" &&
  for s in issue-orchestrator implement-issue onboard update-dev; do echo "$skills" | grep -qxF "$s" || exit 1; done &&
  echo "$out" | grep -qxF "dev-doctor: OK   default Claude plugins are installed: callum-flow@callum"'
