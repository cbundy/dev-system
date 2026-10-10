# shellcheck shell=bash
# shellcheck disable=SC2016,SC2154
#
# Section 3 of the base image container tests. Sourced by test.sh after lib.sh, which
# provides IMAGE, RUN_ID, SECRET, check, in_image and the rest; never run directly.

echo "== 3. persistence contract"
check "env vars point at /persist/*" in_image '
  [ "$CLAUDE_CONFIG_DIR" = /persist/claude ] && [ "$CODEX_HOME" = /persist/codex ] &&
  [ "$GH_CONFIG_DIR" = /persist/gh ] && [ "$NM_HOME" = /persist/no-mistakes ] &&
  [ "$AGENTSVIEW_DATA_DIR" = /persist/agentsview ]'
check "every /persist dir exists, is owned 1000:1000 with mode 0700 and is writable by node" in_image '
  for d in /persist/claude /persist/codex /persist/gh /persist/no-mistakes /persist/agentsview /persist/events /persist/dev-restart-self; do
    [ "$(stat -c %u:%g:%a "$d")" = 1000:1000:700 ] || { echo "$d: $(stat -c %u:%g:%a "$d")"; exit 1; }
    touch "$d/.probe" && rm "$d/.probe" || exit 1
  done'
check "the image ships /persist empty (no build-time state baked in)" in_image '
  [ -z "$(find /persist -mindepth 2 | head -n 1)" ] || { find /persist -mindepth 2; exit 1; }' \
  --entrypoint ""
check "no tool binary lives under /persist" in_image '
  for b in claude codex gh git no-mistakes treehouse uv uvx agentsview node; do
    case "$(readlink -f "$(command -v $b)")" in /persist/*) echo "$b under /persist"; exit 1 ;; esac
  done'
check "the persistence list file, the label and PERSIST_NAMES agree on the seven dirs" bash -c "
  want=\$(for n in $PERSIST_NAMES; do printf '/persist/%s,' \"\$n\"; done); want=\${want%,}
  [ \"\$(docker image inspect -f '{{index .Config.Labels \"dev.cbundy.persist\"}}' '$IMAGE')\" = \"\$want\" ] &&
  [ \"\$(docker run --rm --entrypoint '' '$IMAGE' cat /usr/local/share/dev-system/persist-dirs | paste -sd,)\" = \"\$want\" ]"
check "the runtime secrets mount point is empty, node-owned, 0700, and named by DEV_SECRETS_DIR" in_image '
  [ "$DEV_SECRETS_DIR" = /run/secrets/dev-system ] &&
  [ "$(stat -c %u:%g:%a "$DEV_SECRETS_DIR")" = 1000:1000:700 ] &&
  [ -z "$(ls -A "$DEV_SECRETS_DIR")" ]' --entrypoint ""
check "image declares no VOLUME" bash -c "
  [ \"\$(docker image inspect -f '{{json .Config.Volumes}}' '$IMAGE')\" = null ]"
check "OCI labels carry source, revision, version, created and the mutability note" bash -c "
  labels=\$(docker image inspect -f '{{json .Config.Labels}}' '$IMAGE')
  for k in source revision version created; do
    echo \"\$labels\" | jq -e --arg k \"org.opencontainers.image.\$k\" '.[\$k] | length > 0' >/dev/null || { echo \"missing \$k\"; exit 1; }
  done
  echo \"\$labels\" | jq -e '.\"org.opencontainers.image.description\" | test(\"mutable\")' >/dev/null"
check "Claude login state (.claude.json) lands inside CLAUDE_CONFIG_DIR" in_image '
  timeout 60 claude -p hi >/dev/null 2>&1 || true
  test -f /persist/claude/.claude.json && ! test -e "$HOME/.claude.json"'
