#!/bin/bash
# Container scripts are single-quoted on purpose: they expand inside the image.
# shellcheck disable=SC2016
#
# Container tests for the dev-system base image (cbundy/dev-system#59).
#
# Usage: images/base/test/test.sh <image>
#
# Runs on a Docker host against an already-built image - locally and in
# publish-base-image.yml. Sections 1-7 match the tests in that issue; section
# 8 covers opt-in telemetry (cbundy/dev-system#68).
# Test 7 needs the devcontainer CLI (`devcontainer` on PATH, or set
# DEVCONTAINER="npx -y @devcontainers/cli"); SKIP_DEVCONTAINER=1 skips it.
set -euo pipefail

IMAGE="${1:?usage: test.sh <image>}"
DEVCONTAINER="${DEVCONTAINER:-devcontainer}"
RUN_ID="dsb-test-$$"
PASSES=0
FAILURES=0

pass() {
  echo "PASS: $*"
  PASSES=$((PASSES + 1))
}

fail() {
  echo "FAIL: $*"
  FAILURES=$((FAILURES + 1))
}

# check <description> <command...>: runs the command on the host
check() {
  local desc="$1"
  shift
  local out
  if out=$("$@" 2>&1); then
    pass "$desc"
  else
    fail "$desc"
    printf '%s\n' "$out" | sed 's/^/    /'
  fi
}

# in_image <bash script> [docker run args...]: runs a script as the image's
# default user in a throwaway container
in_image() {
  local script="$1"
  shift
  docker run --rm "$@" "$IMAGE" bash -c "$script"
}

cleanup() {
  docker ps -aq --filter "label=$RUN_ID" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter "label=$RUN_ID" | xargs -r docker volume rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter "name=^$RUN_ID-" | xargs -r docker volume rm -f >/dev/null 2>&1 || true
  [ -n "${WORKDIR:-}" ] && rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "== 1. user"
check "default user is node with uid 1000 / gid 1000" in_image '
  [ "$(id -un)" = node ] && [ "$(id -u)" = 1000 ] && [ "$(id -g)" = 1000 ] &&
  [ "$(id -u node)" = 1000 ] && [ "$(id -g node)" = 1000 ]'

echo "== 2. toolchain"
for tool in node npm claude codex gh git no-mistakes treehouse; do
  check "$tool runs --version as node" in_image "[ \"\$(id -un)\" = node ] && $tool --version"
done
check "codex helper binaries are installed (codex-code-mode-host)" in_image '
  find "$(npm prefix -g)/lib/node_modules/@openai/codex" -name codex-code-mode-host -type f -perm -u+x | grep -q .'
check "callum-tools scripts staged where the callum-flow skills call them" in_image '
  for s in pipeline-watch.sh queue-watch.sh recover-no-mistakes.sh pin-codex-model.sh; do
    test -x /usr/local/share/callum-tools/$s || { echo "missing $s"; exit 1; }
  done'

echo "== 3. persistence contract"
check "env vars point at /persist/*" in_image '
  [ "$CLAUDE_CONFIG_DIR" = /persist/claude ] && [ "$CODEX_HOME" = /persist/codex ] &&
  [ "$GH_CONFIG_DIR" = /persist/gh ] && [ "$NM_HOME" = /persist/no-mistakes ]'
check "every /persist dir exists, is owned 1000:1000 with mode 0700 and is writable by node" in_image '
  for d in /persist/claude /persist/codex /persist/gh /persist/no-mistakes; do
    [ "$(stat -c %u:%g:%a "$d")" = 1000:1000:700 ] || { echo "$d: $(stat -c %u:%g:%a "$d")"; exit 1; }
    touch "$d/.probe" && rm "$d/.probe" || exit 1
  done'
check "the image ships /persist empty (no build-time state baked in)" in_image '
  [ -z "$(find /persist -mindepth 2 | head -n 1)" ] || { find /persist -mindepth 2; exit 1; }'
check "no tool binary lives under /persist" in_image '
  for b in claude codex gh git no-mistakes treehouse node; do
    case "$(readlink -f "$(command -v $b)")" in /persist/*) echo "$b under /persist"; exit 1 ;; esac
  done'
check "persistence contract label lists the four dirs" bash -c "
  [ \"\$(docker image inspect -f '{{index .Config.Labels \"dev.cbundy.persist\"}}' '$IMAGE')\" = \
    /persist/claude,/persist/codex,/persist/gh,/persist/no-mistakes ]"
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

echo "== 4. Claude auto-update"
check "Claude install location is writable by node" in_image '
  launcher=$(command -v claude); target=$(readlink -f "$launcher")
  [ -w "$(dirname "$launcher")" ] && [ -w "$(dirname "$target")" ] && [ -w "$HOME/.local/share/claude" ]'
check "after dev-init, claude doctor reports a native install with auto-updates and no installation issues" in_image '
  dev-init >/dev/null 2>&1
  out=$(timeout 60 claude doctor </dev/null 2>&1); echo "$out"
  echo "$out" | grep -q "Running: native" &&
  echo "$out" | grep -q "Auto-updates: enabled" &&
  echo "$out" | grep -q "No installation issues found"'
check "claude can replace its own install as node (downgrade, then update back to latest)" in_image '
  set -e
  latest=$(claude --version)
  claude install 2.1.280 >/dev/null 2>&1
  [ "$(claude --version)" != "$latest" ]
  claude update
  [ "$(claude --version)" = "$latest" ]'
check "DISABLE_AUTOUPDATER is not set" in_image '[ -z "${DISABLE_AUTOUPDATER:-}" ]'

echo "== 5. dev-init"
vol=$(docker volume create --label "$RUN_ID")
check "dev-init runs twice cleanly on an empty volume at /persist" in_image '
  set -e
  dev-init; dev-init
  grep -q "^sandbox_mode = \"danger-full-access\"" /persist/codex/config.toml
  [ "$(grep -c "^sandbox_mode" /persist/codex/config.toml)" = 1 ]
  grep -qx "agent_args_override:" /persist/no-mistakes/config.yaml
  [ "$(grep -c "^agent_args_override:" /persist/no-mistakes/config.yaml)" = 1 ]
  grep -qF -- "- $(cat /usr/local/share/dev-system/codex-model.default)" /persist/no-mistakes/config.yaml' \
  -v "$vol:/persist"
check "dev-init on an empty volume mounted at /persist leaves node-owned subdirs" in_image '
  for d in claude codex gh no-mistakes; do [ "$(stat -c %u "/persist/$d")" = 1000 ] || exit 1; done' \
  -v "$vol:/persist"
check "dev-init seeds installMethod into an existing .claude.json without touching other keys" in_image '
  set -e
  echo "{\"keep\":1}" > /persist/claude/.claude.json
  dev-init >/dev/null 2>&1; dev-init >/dev/null 2>&1
  # claude itself (via dev-doctor) adds keys too, so only these two are compared
  [ "$(jq -c "{keep, installMethod}" /persist/claude/.claude.json)" = "{\"keep\":1,\"installMethod\":\"native\"}" ]
  [ "$(stat -c %a /persist/claude/.claude.json)" = 600 ]'
check "dev-init keeps an existing top-level sandbox_mode and ignores one inside a table" in_image '
  set -e
  printf "sandbox_mode = \"workspace-write\"\n" > /persist/codex/config.toml
  dev-init >/dev/null 2>&1
  [ "$(cat /persist/codex/config.toml)" = "sandbox_mode = \"workspace-write\"" ]
  printf "[profiles.x]\nsandbox_mode = \"read-only\"\n" > /persist/codex/config.toml
  dev-init >/dev/null 2>&1
  head -n 2 /persist/codex/config.toml | grep -qx "sandbox_mode = \"danger-full-access\""
  grep -qx "\[profiles.x\]" /persist/codex/config.toml'
check "DEV_CODEX_MODEL overrides the pin, and empty skips it" in_image '
  set -e
  DEV_CODEX_MODEL=my-model dev-init >/dev/null 2>&1
  grep -qF -- "- my-model" /persist/no-mistakes/config.yaml
  rm /persist/no-mistakes/config.yaml
  DEV_CODEX_MODEL= dev-init >/dev/null 2>&1
  ! grep -q agent_args_override /persist/no-mistakes/config.yaml 2>/dev/null'
rootvol=$(docker volume create --label "$RUN_ID")
# The volume must not be empty, or Docker copies the image's node-owned
# directory into it again on the next mount.
docker run --rm --user root -v "$rootvol:/persist/claude" "$IMAGE" \
  bash -c 'touch /persist/claude/.root-owned && chown -R root:root /persist/claude'
check "dev-init warns but exits 0 (twice) with a root-owned /persist/claude" in_image '
  out=$( { dev-init; echo "rc=$?"; dev-init; echo "rc=$?"; } 2>&1 )
  echo "$out"
  [ "$(echo "$out" | grep -c "^rc=0$")" = 2 ] &&
  echo "$out" | grep -q "WARNING: /persist/claude is not writable" &&
  echo "$out" | grep -q "chown 1000:1000" &&
  echo "$out" | grep -q "FAIL claude state dir"' \
  -v "$rootvol:/persist/claude"

echo "== 6. dev-doctor"
check "dev-doctor exits non-zero with no auth and prints a hint per failure" bash -c "
  out=\$(docker run --rm '$IMAGE' dev-doctor 2>&1); rc=\$?
  echo \"\$out\"
  [ \$rc -ne 0 ] || exit 1
  fails=\$(echo \"\$out\" | grep -c 'FAIL ' || true)
  hints=\$(echo \"\$out\" | grep -c 'fix: ' || true)
  [ \"\$fails\" -ge 3 ] && [ \"\$fails\" = \"\$hints\" ] &&
  echo \"\$out\" | grep -q 'claude auth login' &&
  echo \"\$out\" | grep -q 'codex login' &&
  echo \"\$out\" | grep -q 'gh auth login'"
check "dev-doctor --warn-only exits 0 with the same failures" in_image '
  out=$(dev-doctor --warn-only); rc=$?
  echo "$out"; [ $rc -eq 0 ] && echo "$out" | grep -q "FAIL "'

check "dev-doctor fails (not 'registered') when no-mistakes is broken in a gated repo" bash -c "
  vol=\$(docker volume create --label '$RUN_ID')
  docker run --rm --user root -v \"\$vol:/persist/no-mistakes\" '$IMAGE' \
    bash -c 'touch /persist/no-mistakes/.root-owned && chown -R root:root /persist/no-mistakes'
  out=\$(docker run --rm -v \"\$vol:/persist/no-mistakes\" '$IMAGE' bash -c '
    git init -q /tmp/r && touch /tmp/r/.no-mistakes.yaml && cd /tmp/r && dev-doctor' 2>&1); rc=\$?
  echo \"\$out\"
  [ \$rc -ne 0 ] && echo \"\$out\" | grep -q 'FAIL no-mistakes: /tmp/r is not registered or no-mistakes is broken' &&
  ! echo \"\$out\" | grep -q 'is registered'"
check "dev-init and dev-doctor flag a repo git refuses (dubious ownership)" bash -c "
  out=\$(docker run --rm --user root '$IMAGE' bash -c '
    git init -q /ws && touch /ws/.no-mistakes.yaml
    su node -c \"cd /ws && dev-init; dev-doctor\"' 2>&1)
  echo \"\$out\"
  echo \"\$out\" | grep -q 'dev-init: WARNING: git cannot read the repo at /ws' &&
  echo \"\$out\" | grep -q 'FAIL git cannot read the repo at /ws' &&
  echo \"\$out\" | grep -q 'safe.directory /ws'"

echo "== 7. devcontainer CLI smoke test"
if [ "${SKIP_DEVCONTAINER:-}" = 1 ]; then
  echo "SKIP: devcontainer smoke test (SKIP_DEVCONTAINER=1)"
else
  WORKDIR=$(mktemp -d)
  mkdir -p "$WORKDIR/.devcontainer"
  printf '{ "image": "%s" }\n' "$IMAGE" > "$WORKDIR/.devcontainer/devcontainer.json"
  # Fresh volume names per run so the test never touches a developer's real
  # dev-system-* login volumes; the metadata's default names are checked
  # separately against the label below.
  check "devcontainer metadata label declares the default named volumes and dev-init" bash -c "
    docker image inspect -f '{{index .Config.Labels \"devcontainer.metadata\"}}' '$IMAGE' | jq -e '
      .[-1] as \$m
      | \$m.remoteUser == \"node\" and \$m.postStartCommand == \"dev-init\"
      and \$m.updateRemoteUserUID == false
      and ([\$m.mounts[] | \"\(.source)=\(.target)\"] | sort) == [
        \"dev-system-claude=/persist/claude\", \"dev-system-codex=/persist/codex\",
        \"dev-system-gh=/persist/gh\", \"dev-system-no-mistakes=/persist/no-mistakes\"]'"
  # Override the default volume names in the consumer config (same targets),
  # which also proves a consumer can override them.
  cat > "$WORKDIR/.devcontainer/devcontainer.json" <<EOF
{
  "image": "$IMAGE",
  "mounts": [
    { "type": "volume", "source": "$RUN_ID-claude", "target": "/persist/claude" },
    { "type": "volume", "source": "$RUN_ID-codex", "target": "/persist/codex" },
    { "type": "volume", "source": "$RUN_ID-gh", "target": "/persist/gh" },
    { "type": "volume", "source": "$RUN_ID-nm", "target": "/persist/no-mistakes" }
  ],
  "runArgs": ["--label", "$RUN_ID"]
}
EOF
  # shellcheck disable=SC2086
  if up=$($DEVCONTAINER up --workspace-folder "$WORKDIR" 2>&1); then
    pass "devcontainer up succeeds"
    cid=$(echo "$up" | tail -n 1 | jq -r .containerId)
    check "volumes are mounted at every /persist dir (consumer overrides win over image defaults)" bash -c "
      mounts=\$(docker inspect -f '{{json .Mounts}}' '$cid')
      for t in claude codex gh no-mistakes; do
        echo \"\$mounts\" | jq -e --arg t \"/persist/\$t\" 'map(select(.Destination == \$t and .Type == \"volume\" and (.Name | startswith(\"$RUN_ID-\")))) | length == 1' >/dev/null || { echo \"no volume at /persist/\$t: \$mounts\"; exit 1; }
      done"
    # DEVCONTAINER may be a multi-word command (npx ...), so it is split on purpose.
    # shellcheck disable=SC2086
    # node must stay UID 1000 even when the host user is not (CI runners are
    # 1001), or the 1000-owned /persist volumes are not writable
    check "dev-init ran as node (UID 1000) at post-start (codex sandbox default seeded)" \
      $DEVCONTAINER exec --workspace-folder "$WORKDIR" bash -c '
        [ "$(id -un)" = node ] && [ "$(id -u)" = 1000 ] && grep -q "^sandbox_mode" /persist/codex/config.toml'
    # the devcontainer CLI derives a vsc-*-uid image per workspace; drop it too
    derived=$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || true)
    docker rm -f "$cid" >/dev/null 2>&1 || true
    case "$derived" in vsc-*) docker rmi -f "$derived" >/dev/null 2>&1 || true ;; esac
  else
    fail "devcontainer up succeeds"
    printf '%s\n' "$up" | tail -n 30 | sed 's/^/    /'
  fi
fi

echo "== 8. opt-in telemetry (cbundy/dev-system#68)"
# The endpoint never needs to exist: these tests check what is switched on,
# not that anything is received. collector.invalid can never resolve.
OTEL_EP=http://collector.invalid:4318
TELEMETRY_VARS='^(CLAUDE_CODE_ENABLE_TELEMETRY|OTEL_METRICS_EXPORTER|OTEL_LOGS_EXPORTER|OTEL_EXPORTER_OTLP_PROTOCOL|OTEL_LOG_USER_PROMPTS)='
check "without OTEL_EXPORTER_OTLP_ENDPOINT no telemetry var is set in any shell, tmux or after dev-init" in_image '
  dev-init >/dev/null 2>&1
  tmux new-session -d -s t "env > /tmp/tmux.env"
  for _ in $(seq 50); do [ -s /tmp/tmux.env ] && break; sleep 0.1; done
  { env; bash -c env; bash -lc env; bash -ic env 2>/dev/null; sh -lc env; cat /tmp/tmux.env; } > /tmp/all.env
  if grep -E "'"$TELEMETRY_VARS"'" /tmp/all.env; then exit 1; fi
  [ -s /tmp/tmux.env ] && ! test -e /etc/codex/config.toml'
# Each probe starts from a clean environment (env -i) holding only the
# endpoint, so it proves that one hook - profile.d, bash.bashrc, BASH_ENV,
# zshenv or a tmux window's login shell - sets the variables by itself.
check "with the endpoint set, each shell hook (login, interactive, non-interactive bash, sh -l, zsh, tmux) turns Claude Code export on" in_image '
  clean() { env -i HOME="$HOME" PATH="$PATH" TERM=xterm OTEL_EXPORTER_OTLP_ENDPOINT="$OTEL_EXPORTER_OTLP_ENDPOINT" "$@"; }
  clean tmux new-session -d -s t
  clean tmux send-keys -t t "env > /tmp/tmux.env" Enter
  for _ in $(seq 50); do [ -s /tmp/tmux.env ] && break; sleep 0.1; done
  probes="bash-login bash-interactive bash-env sh-login tmux"
  command -v zsh >/dev/null && probes="$probes zsh"
  for probe in $probes; do
    case $probe in
      bash-login) out=$(clean bash -lc env) ;;
      bash-interactive) out=$(clean bash -ic env 2>/dev/null) ;;
      bash-env) out=$(clean BASH_ENV="$BASH_ENV" bash -c env) ;;
      sh-login) out=$(clean sh -lc env) ;;
      zsh) out=$(clean zsh -c env) ;;
      tmux) out=$(cat /tmp/tmux.env) ;;
    esac
    { echo "$out" | grep -qx CLAUDE_CODE_ENABLE_TELEMETRY=1 &&
      echo "$out" | grep -qx OTEL_METRICS_EXPORTER=otlp &&
      echo "$out" | grep -qx OTEL_LOGS_EXPORTER=otlp &&
      echo "$out" | grep -qx OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf &&
      ! echo "$out" | grep -q "^OTEL_LOG_USER_PROMPTS="; } || { echo "$probe:"; echo "$out" | grep -E "^(CLAUDE|OTEL)"; exit 1; }
  done' \
  -e OTEL_EXPORTER_OTLP_ENDPOINT="$OTEL_EP"
check "runtime-set values win over the image defaults" in_image '
  [ "$(bash -lc "echo \$OTEL_EXPORTER_OTLP_PROTOCOL \$CLAUDE_CODE_ENABLE_TELEMETRY")" = "grpc 0" ]' \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.invalid:4317 -e OTEL_EXPORTER_OTLP_PROTOCOL=grpc \
  -e CLAUDE_CODE_ENABLE_TELEMETRY=0
check "codex reads the system config layer at /etc/codex/config.toml (negative control)" in_image '
  echo "this is not toml [" > /etc/codex/config.toml
  codex login status 2>&1 | grep -q "Error loading configuration"'
check "dev-init writes a codex [otel] config that codex parses, with env= from the resource attributes and prompts off" in_image '
  set -e
  dev-init >/dev/null 2>&1; dev-init >/dev/null 2>&1
  cat /etc/codex/config.toml
  grep -qx "\[otel\]" /etc/codex/config.toml
  grep -qx "environment = \"test\"" /etc/codex/config.toml
  grep -qx "log_user_prompt = false" /etc/codex/config.toml
  grep -qF "exporter = { otlp-http = { endpoint = \"http://collector.invalid:4318/v1/logs\", protocol = \"binary\" } }" /etc/codex/config.toml
  grep -qF "metrics_exporter = { otlp-http = { endpoint = \"http://collector.invalid:4318/v1/metrics\", protocol = \"binary\" } }" /etc/codex/config.toml
  ! grep -q otel "$CODEX_HOME/config.toml"
  codex login status 2>&1 | grep -qx "Not logged in"' \
  -e OTEL_EXPORTER_OTLP_ENDPOINT="$OTEL_EP" -e OTEL_RESOURCE_ATTRIBUTES=host=ci,repo=dev-system,env=test
check "dev-init writes an otlp-grpc codex config for OTEL_EXPORTER_OTLP_PROTOCOL=grpc" in_image '
  dev-init >/dev/null 2>&1
  grep -qF "exporter = { otlp-grpc = { endpoint = \"http://collector.invalid:4317\" } }" /etc/codex/config.toml &&
  codex login status 2>&1 | grep -qx "Not logged in"' \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.invalid:4317 -e OTEL_EXPORTER_OTLP_PROTOCOL=grpc
check "dev-init removes its codex config once the endpoint is gone, and never touches a foreign one" in_image '
  set -e
  dev-init >/dev/null 2>&1
  test -f /etc/codex/config.toml
  env -u OTEL_EXPORTER_OTLP_ENDPOINT dev-init >/dev/null 2>&1
  ! test -e /etc/codex/config.toml
  printf "model = \"x\"\n" > /etc/codex/config.toml
  dev-init >/dev/null 2>&1; env -u OTEL_EXPORTER_OTLP_ENDPOINT dev-init >/dev/null 2>&1
  [ "$(cat /etc/codex/config.toml)" = "model = \"x\"" ]' \
  -e OTEL_EXPORTER_OTLP_ENDPOINT="$OTEL_EP"
check "dev-init steps aside (and removes its file) when the user's own config.toml has an [otel] table" in_image '
  set -e
  dev-init >/dev/null 2>&1
  test -f /etc/codex/config.toml
  printf "[otel]\nexporter = { otlp-grpc = { endpoint = \"http://mine:4317\" } }\n" >> "$CODEX_HOME/config.toml"
  dev-init 2>&1 | grep -q "configures \[otel\] itself"
  ! test -e /etc/codex/config.toml
  grep -q "http://mine:4317" "$CODEX_HOME/config.toml"
  codex login status 2>&1 | grep -qx "Not logged in"' \
  -e OTEL_EXPORTER_OTLP_ENDPOINT="$OTEL_EP"
check "dev-doctor reports telemetry as INFO only: off without an endpoint, unreachable collector never FAILs" bash -c "
  off=\$(docker run --rm '$IMAGE' dev-doctor --warn-only 2>&1)
  on=\$(docker run --rm -e OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9 '$IMAGE' bash -c 'dev-init >/dev/null 2>&1; dev-doctor --warn-only' 2>&1)
  echo \"\$off\"; echo \"\$on\"
  echo \"\$off\" | grep -q 'INFO telemetry: off' &&
  echo \"\$on\" | grep -q 'INFO telemetry: on - endpoint http://127.0.0.1:9' &&
  echo \"\$on\" | grep -q 'INFO telemetry: claude exports metrics (otlp) and events (otlp); prompt text logging off' &&
  echo \"\$on\" | grep -q 'INFO telemetry: codex exports via /etc/codex/config.toml' &&
  echo \"\$on\" | grep -q 'INFO telemetry: collector 127.0.0.1:9 is NOT reachable' &&
  ! echo \"\$off\$on\" | grep -q 'FAIL.*telemetry'"

echo
echo "$PASSES passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ]
