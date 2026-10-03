#!/bin/bash
# Container scripts are single-quoted on purpose: they expand inside the image.
# shellcheck disable=SC2016
#
# Container tests for the dev-system base image (cbundy/dev-system#59).
#
# Usage: images/base/test/test.sh <image>
#
# Runs on a Docker host against an already-built image - locally and in
# publish-base-image.yml. Each numbered section matches a test in the issue.
# Test 8 starts a postgres:17 container. Test 7 needs the devcontainer CLI (`devcontainer` on PATH, or set
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
  docker network ls -q --filter "label=$RUN_ID" | xargs -r docker network rm >/dev/null 2>&1 || true
  [ -n "${WORKDIR:-}" ] && rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "== 1. user"
check "default user is node with uid 1000 / gid 1000" in_image '
  [ "$(id -un)" = node ] && [ "$(id -u)" = 1000 ] && [ "$(id -g)" = 1000 ] &&
  [ "$(id -u node)" = 1000 ] && [ "$(id -g node)" = 1000 ]'

echo "== 2. toolchain"
for tool in node npm claude codex gh git no-mistakes treehouse agentsview; do
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
  [ "$GH_CONFIG_DIR" = /persist/gh ] && [ "$NM_HOME" = /persist/no-mistakes ] &&
  [ "$AGENTSVIEW_DATA_DIR" = /persist/agentsview ]'
check "every /persist dir exists, is owned 1000:1000 with mode 0700 and is writable by node" in_image '
  for d in /persist/claude /persist/codex /persist/gh /persist/no-mistakes /persist/agentsview; do
    [ "$(stat -c %u:%g:%a "$d")" = 1000:1000:700 ] || { echo "$d: $(stat -c %u:%g:%a "$d")"; exit 1; }
    touch "$d/.probe" && rm "$d/.probe" || exit 1
  done'
check "the image ships /persist empty (no build-time state baked in)" in_image '
  [ -z "$(find /persist -mindepth 2 | head -n 1)" ] || { find /persist -mindepth 2; exit 1; }'
check "no tool binary lives under /persist" in_image '
  for b in claude codex gh git no-mistakes treehouse agentsview node; do
    case "$(readlink -f "$(command -v $b)")" in /persist/*) echo "$b under /persist"; exit 1 ;; esac
  done'
check "persistence contract label lists the five dirs" bash -c "
  [ \"\$(docker image inspect -f '{{index .Config.Labels \"dev.cbundy.persist\"}}' '$IMAGE')\" = \
    /persist/claude,/persist/codex,/persist/gh,/persist/no-mistakes,/persist/agentsview ]"
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
  for d in claude codex gh no-mistakes agentsview; do [ "$(stat -c %u "/persist/$d")" = 1000 ] || exit 1; done' \
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
        \"dev-system-agentsview=/persist/agentsview\",
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
    { "type": "volume", "source": "$RUN_ID-nm", "target": "/persist/no-mistakes" },
    { "type": "volume", "source": "$RUN_ID-av", "target": "/persist/agentsview" }
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
      for t in claude codex gh no-mistakes agentsview; do
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

echo "== 8. agentsview session push"
check "agentsview telemetry and update check are off" in_image '
  [ "$AGENTSVIEW_TELEMETRY_ENABLED" = 0 ] && [ "$AGENTSVIEW_DISABLE_UPDATE_CHECK" = 1 ]'
check "without AGENTSVIEW_PG_URL, dev-init starts no push and dev-doctor reports it off" in_image '
  out=$(dev-init 2>&1; dev-doctor --warn-only); echo "$out"
  ! pgrep -x agentsview-push >/dev/null &&
  [ ! -e /persist/agentsview/config.toml ] &&
  echo "$out" | grep -q "OK   agentsview is installed (session push off"'

# A TLS PostgreSQL (agentsview refuses plaintext to a non-local host) on a
# private network, plus one shared data volume and one shared Claude volume:
# the shape of several containers on one Docker host.
net=$(docker network create --label "$RUN_ID" "$RUN_ID-net")
docker run -d --label "$RUN_ID" --name "$RUN_ID-pg" --network "$net" \
  -e POSTGRES_USER=av -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=agentsview \
  --entrypoint bash postgres:17 -c '
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=pg \
      -keyout /tmp/k.pem -out /tmp/c.pem 2>/dev/null
    chown postgres /tmp/k.pem /tmp/c.pem && chmod 600 /tmp/k.pem
    exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/c.pem -c ssl_key_file=/tmp/k.pem' >/dev/null
psql_av() {
  docker exec "$RUN_ID-pg" psql -U av -d agentsview -tAc "$1" 2>/dev/null
}
for _ in $(seq 1 60); do
  docker exec "$RUN_ID-pg" pg_isready -U av -d agentsview -h 127.0.0.1 >/dev/null 2>&1 && break
  sleep 1
done
avdata=$(docker volume create --label "$RUN_ID")
avclaude=$(docker volume create --label "$RUN_ID")
# write_session <volume> <session id>: a minimal Claude Code transcript
write_session() {
  docker run --rm -v "$1:/persist/claude" -e SID="$2" "$IMAGE" bash -c '
    mkdir -p /persist/claude/projects/-ws && f=/persist/claude/projects/-ws/$SID.jsonl
    printf "%s\n" \
      "{\"type\":\"user\",\"sessionId\":\"$SID\",\"uuid\":\"$SID-u\",\"parentUuid\":null,\"timestamp\":\"2026-01-01T00:00:00Z\",\"cwd\":\"/ws\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}" \
      "{\"type\":\"assistant\",\"sessionId\":\"$SID\",\"uuid\":\"$SID-a\",\"parentUuid\":\"$SID-u\",\"timestamp\":\"2026-01-01T00:00:01Z\",\"cwd\":\"/ws\",\"message\":{\"role\":\"assistant\",\"model\":\"claude-test\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}" \
      > "$f.tmp" && mv "$f.tmp" "$f"'
}
# wait_for_session <session id>: up to 90s for it to reach PostgreSQL
wait_for_session() {
  for _ in $(seq 1 90); do
    [ "$(psql_av "select count(*) from agentsview.sessions where id like '%$1%'")" -ge 1 ] 2>/dev/null && return 0
    sleep 1
  done
  return 1
}
write_session "$avclaude" 11111111-1111-4111-8111-111111111111
pusher() {
  docker run -d --label "$RUN_ID" --name "$RUN_ID-$1" --network "$net" \
    -e "AGENTSVIEW_PG_URL=postgres://av:pw@$RUN_ID-pg:5432/agentsview?sslmode=require" \
    -e DEV_MACHINE_NAME='test "host"' -e DEV_AGENTSVIEW_RETRY_SECONDS=2 \
    -v "$avdata:/persist/agentsview" -v "$avclaude:/persist/claude" \
    "$IMAGE" bash -c 'dev-init; exec sleep infinity' >/dev/null
}
pusher a
check "dev-init starts the push and a session reaches PostgreSQL" wait_for_session 11111111-1111-4111-8111-111111111111
check "the machine label comes from DEV_MACHINE_NAME (quotes escaped)" bash -c "
  [ \"\$(docker exec '$RUN_ID-pg' psql -U av -d agentsview -tAc \"select value from agentsview.sync_metadata where key like 'machine_label:%'\")\" = 'test \"host\"' ]"
check "dev-init seeds a non-8080 daemon port and keeps config.toml at 0600" docker exec "$RUN_ID-a" bash -c '
  grep -qx "port = 47180" /persist/agentsview/config.toml &&
  [ "$(stat -c %a /persist/agentsview/config.toml)" = 600 ] &&
  ! grep -q "127.0.0.1:8080" /persist/agentsview/daemon.*.json'
check "dev-doctor reports the database reachable and the push running" docker exec "$RUN_ID-a" bash -c '
  out=$(dev-doctor --warn-only); echo "$out"
  echo "$out" | grep -q "OK   agentsview: central PostgreSQL is reachable" &&
  echo "$out" | grep -q "OK   agentsview session push is running"'
check "a second dev-init in the same container starts no second push loop" docker exec "$RUN_ID-a" bash -c '
  dev-init >/dev/null 2>&1; [ "$(pgrep -xc agentsview-push)" = 1 ]'
pusher b
sleep 6
check "a second container on the same data volume waits on the lock and reports the push running" docker exec "$RUN_ID-b" bash -c '
  out=$(dev-doctor --warn-only); echo "$out"; cat /tmp/dev-agentsview-push.log
  grep -q "already locked" /tmp/dev-agentsview-push.log &&
  echo "$out" | grep -q "OK   agentsview session push is running"'
docker stop -t 10 "$RUN_ID-a" >/dev/null
write_session "$avclaude" 22222222-2222-4222-8222-222222222222
check "the second container takes over when the first stops" wait_for_session 22222222-2222-4222-8222-222222222222
check "both containers pushed as one machine" bash -c "
  [ \"\$(docker exec '$RUN_ID-pg' psql -U av -d agentsview -tAc 'select count(distinct machine) from agentsview.sessions')\" = 1 ]"
check "dev-doctor fails with a hint when the database is unreachable" bash -c "
  out=\$(docker run --rm -e AGENTSVIEW_PG_URL='postgres://av:pw@no-such-host.invalid:5432/agentsview?sslmode=require' '$IMAGE' dev-doctor 2>&1)
  echo \"\$out\"
  echo \"\$out\" | grep -q 'FAIL agentsview cannot reach the central PostgreSQL' &&
  echo \"\$out\" | grep -q 'FAIL agentsview session push is not running'"

echo
echo "$PASSES passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ]
