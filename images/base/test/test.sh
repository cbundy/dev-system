#!/bin/bash
# Container scripts are single-quoted on purpose: they expand inside the image.
# shellcheck disable=SC2016
#
# Container tests for the dev-system base image (cbundy/dev-system#59, #64 for
# the entrypoint and Remote Control, #65 for the /shared mount point and #73
# for per-repo /persist volumes).
#
# Usage: images/base/test/test.sh <image>
#
# Runs on a Docker host against an already-built image - locally and in
# publish-base-image.yml. Sections 1-7 match the tests in #59, section 8 the
# entrypoint tests in #64, section 9 the agentsview push in #69, section 10
# the /shared tests in #65 (Docker volumes stand in for the NAS). Test 7 needs
# the devcontainer CLI (`devcontainer` on PATH, or set
# DEVCONTAINER="npx -y @devcontainers/cli"); SKIP_DEVCONTAINER=1 skips it.
# Test 9 starts a throwaway postgres:17 container. No test needs real
# credentials: the logged-in path runs against a stub `claude`.
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
# default user in a throwaway container. Like any `docker run IMAGE bash`, it
# goes through the image ENTRYPOINT, so dev-init runs first (its report on
# stderr); tests that need the image's untouched state pass --entrypoint "".
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
  [ -z "$(find /persist -mindepth 2 | head -n 1)" ] || { find /persist -mindepth 2; exit 1; }' \
  --entrypoint ""
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
  -v "$vol:/persist" --entrypoint ""
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
  ! grep -q agent_args_override /persist/no-mistakes/config.yaml 2>/dev/null' \
  --entrypoint ""
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
  warns=\$(echo \"\$out\" | grep -c 'WARN ' || true)
  hints=\$(echo \"\$out\" | grep -c 'fix: ' || true)
  [ \"\$fails\" -ge 3 ] && [ \"\$((fails + warns))\" = \"\$hints\" ] &&
  echo \"\$out\" | grep -q 'claude auth login' &&
  echo \"\$out\" | grep -q 'codex login' &&
  echo \"\$out\" | grep -q 'gh auth login'"
check "dev-doctor warns, without failing, for each /persist dir with no volume behind it" bash -c "
  vol=\$(docker volume create --label '$RUN_ID')
  out=\$(docker run --rm --entrypoint '' -v \"\$vol:/persist/claude\" '$IMAGE' dev-doctor 2>&1)
  echo \"\$out\"
  for t in codex gh no-mistakes agentsview; do
    echo \"\$out\" | grep -q \"WARN \$t state dir /persist/\$t is writable but not on a volume\" || { echo \"no WARN for \$t\"; exit 1; }
  done
  echo \"\$out\" | grep -q 'OK   claude state dir /persist/claude is writable' &&
  [ \"\$(echo \"\$out\" | grep -c 'FAIL ')\" = \"\$(echo \"\$out\" | sed -n 's/^dev-doctor: \\([0-9]*\\) check(s) failed\$/\\1/p')\" ]"
check "dev-doctor: no persistence WARN with one volume for all of /persist (the k8s / Coder shape)" in_image '
  out=$(dev-doctor --warn-only); echo "$out"
  ! echo "$out" | grep -q "WARN .*state dir"' \
  -v "$vol:/persist"
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
  # Fresh volume names per run so the test never touches a developer's real
  # dev-system-* login volumes; the metadata's default (only the shared gh
  # volume) is checked separately against the label below.
  check "devcontainer metadata label declares only the shared gh volume, dev-init, Remote Control off and DEV_SHARED_DIR" bash -c "
    docker image inspect -f '{{index .Config.Labels \"devcontainer.metadata\"}}' '$IMAGE' | jq -e '
      .[-1] as \$m
      | \$m.remoteUser == \"node\"
      and \$m.postStartCommand == \"dev-init && dev-remote-control --post-start\"
      and \$m.containerEnv.DEV_REMOTE_CONTROL == \"0\"
      and \$m.containerEnv.DEV_SHARED_DIR == \"/shared\"
      and \$m.updateRemoteUserUID == false
      and ([\$m.mounts[] | \"\(.source)=\(.target)\"]) == [\"dev-system-gh=/persist/gh\"]'"

  # dc_up <name> [extra devcontainer.json lines] [extra mounts]: `devcontainer
  # up` on a minimal image config in its own workspace folder; sets $cid. The
  # four per-repo mounts are the README's, with $RUN_ID in place of the
  # dev-system prefix. The shared gh volume is overridden (same target) with
  # a per-run one, which also proves a consumer can override it.
  dc_up() {
    local ws="$WORKDIR/$1" up
    mkdir -p "$ws/.devcontainer"
    chmod 0755 "$WORKDIR" "$ws"
    cat > "$ws/.devcontainer/devcontainer.json" <<EOF
{
  "image": "$IMAGE",
  "mounts": [
    { "type": "volume", "source": "$RUN_ID-\${devcontainerId}-claude", "target": "/persist/claude" },
    { "type": "volume", "source": "$RUN_ID-\${devcontainerId}-codex", "target": "/persist/codex" },
    { "type": "volume", "source": "$RUN_ID-\${devcontainerId}-no-mistakes", "target": "/persist/no-mistakes" },
    { "type": "volume", "source": "$RUN_ID-\${devcontainerId}-agentsview", "target": "/persist/agentsview" },
    { "type": "volume", "source": "$RUN_ID-gh", "target": "/persist/gh" }${3:+,
    $3}
  ],
  ${2:-}
  "runArgs": ["--label", "$RUN_ID"]
}
EOF
    cid=""
    # DEVCONTAINER may be a multi-word command (npx ...), so it is split on purpose.
    # shellcheck disable=SC2086
    if up=$($DEVCONTAINER up --workspace-folder "$ws" 2>&1); then
      cid=$(echo "$up" | tail -n 1 | jq -r .containerId)
    else
      printf '%s\n' "$up" | tail -n 30 | sed 's/^/    /'
      return 1
    fi
  }

  # persist_volumes: the volume behind each /persist dir of $cid, one
  # "<target>=<volume>" line each, sorted
  persist_volumes() {
    docker inspect -f '{{json .Mounts}}' "$cid" \
      | jq -r '.[] | select(.Destination | startswith("/persist/")) | "\(.Destination)=\(.Name)"' | sort
  }

  # dc_down: removes the container, and the vsc-* image the devcontainer CLI
  # may derive per workspace
  dc_down() {
    local derived
    derived=$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || true)
    docker rm -f "$cid" >/dev/null 2>&1 || true
    case "$derived" in vsc-*) docker rmi -f "$derived" >/dev/null 2>&1 || true ;; esac
  }

  if dc_up default; then
    pass "devcontainer up succeeds"
    check "volumes are mounted at every /persist dir (consumer overrides win over image defaults)" bash -c "
      mounts=\$(docker inspect -f '{{json .Mounts}}' '$cid')
      for t in claude codex gh no-mistakes agentsview; do
        echo \"\$mounts\" | jq -e --arg t \"/persist/\$t\" 'map(select(.Destination == \$t and .Type == \"volume\" and (.Name | startswith(\"$RUN_ID-\")))) | length == 1' >/dev/null || { echo \"no volume at /persist/\$t: \$mounts\"; exit 1; }
      done"
    # node must stay UID 1000 even when the host user is not (CI runners are
    # 1001), or the 1000-owned /persist volumes are not writable
    # shellcheck disable=SC2086
    check "dev-init ran as node (UID 1000) at post-start (codex sandbox default seeded)" \
      $DEVCONTAINER exec --workspace-folder "$WORKDIR/default" bash -c '
        [ "$(id -un)" = node ] && [ "$(id -u)" = 1000 ] && grep -q "^sandbox_mode" /persist/codex/config.toml'
    # the image ENTRYPOINT is replaced (overrideCommand), and the metadata's
    # DEV_REMOTE_CONTROL=0 keeps the post-start hook from starting anything
    check "by default no Remote Control supervisor, tmux session or Claude runs" bash -c "
      docker exec '$cid' bash -c '
        [ \"\$DEV_REMOTE_CONTROL\" = 0 ] || { echo \"DEV_REMOTE_CONTROL=\$DEV_REMOTE_CONTROL\"; exit 1; }
        ! pgrep -af \"^/bin/bash /usr/local/bin/dev-(entrypoint|remote-control)\" &&
        ! pgrep -ax claude && ! tmux has-session -t claude 2>/dev/null &&
        ! test -e /tmp/dev-remote-control.log'"
    check "DEV_SHARED_DIR is set and nothing is mounted at /shared by default" bash -c "
      docker exec '$cid' bash -c '[ \"\$DEV_SHARED_DIR\" = /shared ] && ! mountpoint -q /shared'"
    default_volumes=$(persist_volumes)
    dc_down
  else
    fail "devcontainer up succeeds"
  fi

  if dc_up remote-control '"containerEnv": { "DEV_REMOTE_CONTROL": "1" },'; then
    pass "devcontainer up succeeds with DEV_REMOTE_CONTROL=1"
    # no login in a test volume, so the supervisor waits for one
    check "with DEV_REMOTE_CONTROL=1 the post-start hook starts the supervisor in the workspace, waiting for a login" bash -c "
      for _ in \$(seq 30); do
        docker exec '$cid' grep -q 'Claude is not logged in' /tmp/dev-remote-control.log 2>/dev/null && break
        sleep 1
      done
      docker exec '$cid' bash -c '
        cat /tmp/dev-remote-control.log
        grep -q \"Claude is not logged in - run: docker exec -it\" /tmp/dev-remote-control.log &&
        pid=\$(pgrep -f \"^/bin/bash /usr/local/bin/dev-remote-control\$\") &&
        [ \"\$(readlink /proc/\$pid/cwd)\" = /workspaces/remote-control ]'"
    rc_volumes=$(persist_volumes)
    dc_down
    # Two workspace folders stand for two repos on one Docker host.
    check "two workspaces get their own claude, codex, no-mistakes and agentsview volumes, and share gh" bash -c '
      echo "workspace 1:"; echo "$1"; echo "workspace 2:"; echo "$2"
      for t in claude codex no-mistakes agentsview; do
        a=$(echo "$1" | sed -n "s|^/persist/$t=||p"); b=$(echo "$2" | sed -n "s|^/persist/$t=||p")
        [[ "$a" =~ ^$3-[a-z0-9]+-$t$ ]] && [[ "$b" =~ ^$3-[a-z0-9]+-$t$ ]] && [ "$a" != "$b" ] ||
          { echo "$t: \"$a\" vs \"$b\""; exit 1; }
      done
      [ "$(echo "$1" | grep "^/persist/gh=")" = "/persist/gh=$3-gh" ] &&
      [ "$(echo "$2" | grep "^/persist/gh=")" = "/persist/gh=$3-gh" ]' \
      _ "${default_volumes:-}" "$rc_volumes" "$RUN_ID"
  else
    fail "devcontainer up succeeds with DEV_REMOTE_CONTROL=1"
  fi

  # The README's consumer mount for /shared, with a local volume standing in
  # for the NFS-backed one. volume-nocopy leaves the volume's own ownership
  # alone, so it is made node-writable first, as the NAS export would be.
  docker volume create --label "$RUN_ID" "$RUN_ID-shared" >/dev/null
  docker run --rm --user root --entrypoint "" --mount "type=volume,source=$RUN_ID-shared,target=/shared,volume-nocopy" \
    "$IMAGE" chown 1000:1000 /shared
  if dc_up shared "" "\"source=$RUN_ID-shared,target=/shared,type=volume,volume-nocopy\""; then
    pass "devcontainer up succeeds with a volume at /shared"
    # shellcheck disable=SC2086
    check "a consumer's /shared volume is mounted, writable by node and reported OK by dev-doctor" \
      $DEVCONTAINER exec --workspace-folder "$WORKDIR/shared" bash -c '
        mountpoint -q "$DEV_SHARED_DIR" && touch "$DEV_SHARED_DIR/.probe" && rm "$DEV_SHARED_DIR/.probe" &&
        dev-doctor --warn-only | grep -q "OK   /shared mounted and writable"'
    dc_down
  else
    fail "devcontainer up succeeds with a volume at /shared"
  fi
fi

echo "== 8. entrypoint and Remote Control"

# run_bg <docker run args...>: starts a detached container, removed on exit
run_bg() {
  docker run -d --label "$RUN_ID" "$@"
}

# wait_until <seconds> <command...>: polls once a second until the command
# succeeds; a last failing run shows its output
wait_until() {
  local n="$1"
  shift
  while [ "$n" -gt 0 ]; do
    "$@" >/dev/null 2>&1 && return 0
    sleep 1
    n=$((n - 1))
  done
  "$@"
}

logs_have() {
  docker logs "$1" 2>&1 | grep -qF -- "$2"
}

# stops_within <container> <seconds>: docker stop (with a long timeout, so an
# ignored SIGTERM shows up as slow rather than as a kill) must finish in time
# and the container must exit 0
stops_within() {
  local start ms rc
  start=$(date +%s%N)
  docker stop -t 30 "$1" >/dev/null
  ms=$((($(date +%s%N) - start) / 1000000))
  rc=$(docker inspect -f '{{.State.ExitCode}}' "$1")
  echo "docker stop took ${ms}ms, exit code $rc"
  [ "$ms" -lt $(($2 * 1000)) ] && [ "$rc" = 0 ]
}

# A stub claude: `auth status` reports a claude.ai login once /tmp/logged-in
# exists; a session records its directory and arguments in /tmp/claude-starts,
# then runs until /tmp/claude-exit exists and exits 3.
STUB='#!/bin/bash
if [ "$1" = auth ]; then
  [ -e /tmp/logged-in ] && { echo "{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}"; exit 0; }
  echo "{\"loggedIn\":false,\"authMethod\":\"none\"}"
  exit 1
fi
echo "$PWD $*" >> /tmp/claude-starts
until [ -e /tmp/claude-exit ]; do sleep 0.2; done
exit 3'
# Installs $STUB first on PATH, then runs the rest of the command line.
WITH_STUB='mkdir -p /tmp/stub && printf "%s\n" "$STUB" > /tmp/stub/claude && chmod +x /tmp/stub/claude && PATH=/tmp/stub:$PATH'

check "ENTRYPOINT is tini + dev-entrypoint and CMD is dev-remote-control" bash -c "
  [ \"\$(docker image inspect -f '{{json .Config.Entrypoint}} {{json .Config.Cmd}}' '$IMAGE')\" = \
    '[\"/usr/bin/tini\",\"--\",\"/usr/local/bin/dev-entrypoint\"] [\"dev-remote-control\"]' ]"

check "a command runs after dev-init, in its own directory, with its exit status and clean stdout" bash -c "
  out=\$(docker run --rm -w /tmp '$IMAGE' bash -c 'test -f /persist/codex/config.toml && pwd && exit 7' 2>/dev/null)
  rc=\$?
  echo \"rc=\$rc stdout=\$out\"
  [ \$rc = 7 ] && [ \"\$out\" = /tmp ]"

check "as root the entrypoint skips dev-init, leaving nothing root-owned in /persist" bash -c "
  out=\$(docker run --rm --user root '$IMAGE' find /persist -mindepth 1 -user root 2>&1)
  echo \"\$out\"
  echo \"\$out\" | grep -q 'dev-init skipped' && ! echo \"\$out\" | grep -q '^/persist'"

# No login, no command: waits for a login without starting Claude. A 1s poll
# shows the reminder rate limit (one hint per 10 polls) in a few seconds.
c=$(run_bg -e DEV_REMOTE_CONTROL_POLL=1 "$IMAGE")
check "no login, no command: logs the docker exec login hint" \
  wait_until 30 logs_have "$c" "Claude is not logged in - run: docker exec -it ${c:0:12} claude auth login"
check "no login: repeats the hint every 10 polls, not every poll" bash -c "
  for _ in \$(seq 40); do
    [ \"\$(docker logs '$c' 2>&1 | grep -c 'Claude is not logged in')\" -ge 2 ] && break
    sleep 1
  done
  docker logs '$c' 2>&1 | grep 'dev-remote-control'
  [ \"\$(docker logs '$c' 2>&1 | grep -c 'Claude is not logged in')\" = 2 ]"
check "no login: the container stays up without crash-looping or starting Claude" bash -c "
  [ \"\$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' '$c')\" = 'true 0' ] &&
  docker exec '$c' bash -c '! pgrep -ax claude && ! tmux has-session -t claude 2>/dev/null'"
check "no login: docker stop completes in under 10s with exit 0" stops_within "$c" 10

c=$(run_bg -e ANTHROPIC_API_KEY=sk-ant-test-not-a-real-key "$IMAGE")
check "an API-key-only login gets the claude.ai subscription message" \
  wait_until 30 logs_have "$c" "logged in with api_key, but Remote Control needs a claude.ai subscription login"
docker rm -f "$c" >/dev/null

c=$(run_bg -e DEV_REMOTE_CONTROL=0 "$IMAGE")
check "DEV_REMOTE_CONTROL=0: logs that Claude is not started" \
  wait_until 30 logs_have "$c" "DEV_REMOTE_CONTROL=0: not starting Claude"
check "DEV_REMOTE_CONTROL=0: the container stays up for exec, without Claude or tmux" bash -c "
  sleep 2
  [ \"\$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' '$c')\" = 'true 0' ] &&
  docker exec '$c' bash -c '! pgrep -ax claude && ! tmux has-session -t claude 2>/dev/null'"
check "DEV_REMOTE_CONTROL=0: docker stop completes in under 10s with exit 0" stops_within "$c" 10

# The supervisor against the stub: wait for login, start, restart with backoff.
c=$(run_bg -w /tmp -e STUB="$STUB" -e DEV_REMOTE_CONTROL_POLL=1 -e DEV_REMOTE_CONTROL_NAME=rc-test \
  "$IMAGE" bash -c "$WITH_STUB exec dev-remote-control")
check "stub: waits for a login without starting Claude" bash -c "
  for _ in \$(seq 30); do docker logs '$c' 2>&1 | grep -q 'Claude is not logged in' && break; sleep 1; done
  sleep 2
  docker logs '$c' 2>&1 | grep -q 'Claude is not logged in' && ! docker exec '$c' test -e /tmp/claude-starts"
docker exec "$c" touch /tmp/logged-in
check "stub: starts Claude as soon as a login appears, in the workspace, with --remote-control <name>" bash -c "
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts
  [ \"\$(docker exec '$c' cat /tmp/claude-starts)\" = '/tmp --remote-control rc-test' ] &&
  docker logs '$c' 2>&1 | grep -q 'Claude login found' &&
  [ \"\$(docker inspect -f '{{.RestartCount}}' '$c')\" = 0 ]"
check "stub: Claude runs in the tmux session 'claude'" docker exec "$c" tmux has-session -t claude
check "stub: the workspace is marked trusted in .claude.json" docker exec "$c" \
  jq -e '.projects["/tmp"].hasTrustDialogAccepted == true and .hasCompletedOnboarding == true' /persist/claude/.claude.json
docker exec "$c" touch /tmp/claude-exit
check "stub: restarts Claude after it exits, with a growing backoff" bash -c "
  for _ in \$(seq 30); do docker logs '$c' 2>&1 | grep -q 'restarting in 10s' && break; sleep 1; done
  docker logs '$c' 2>&1 | grep 'dev-remote-control'
  docker logs '$c' 2>&1 | grep -q 'Claude exited (status 3) after .* - restarting in 5s' &&
  docker logs '$c' 2>&1 | grep -q 'restarting in 10s' &&
  [ \"\$(docker exec '$c' grep -c . /tmp/claude-starts)\" = 2 ]"
check "stub: docker stop completes in under 10s with exit 0" stops_within "$c" 10

c=$(run_bg -e STUB="$STUB" -e DEV_REMOTE_CONTROL_SKIP_PERMISSIONS=1 \
  "$IMAGE" bash -c "touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
check "DEV_REMOTE_CONTROL_SKIP_PERMISSIONS=1 adds --dangerously-skip-permissions without the consent dialog" bash -c "
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts
  docker exec '$c' grep -qF -- '--remote-control ${c:0:12} --dangerously-skip-permissions --settings {\"skipDangerousModePermissionPrompt\":true}' /tmp/claude-starts"
docker rm -f "$c" >/dev/null

# The default name is the workspace's repo name: from the origin URL (the
# checkout directory is named differently on purpose), else the git top-level
# directory. The SKIP_PERMISSIONS check above covers the hostname fallback.
c=$(run_bg -e STUB="$STUB" -e DEV_WORKSPACE=/tmp/ws/checkout "$IMAGE" bash -c "
  git init -q /tmp/ws/checkout && git -C /tmp/ws/checkout remote add origin git@github.com:example/my-repo.git &&
  touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
check "the session name defaults to the repo name from the workspace's origin URL" bash -c "
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts
  [ \"\$(docker exec '$c' cat /tmp/claude-starts)\" = '/tmp/ws/checkout --remote-control my-repo' ]"
docker rm -f "$c" >/dev/null

c=$(run_bg -e STUB="$STUB" -e DEV_WORKSPACE=/tmp/ws/no-origin "$IMAGE" bash -c "
  git init -q /tmp/ws/no-origin && touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
check "without an origin, the session name is the git top-level directory name" bash -c "
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts
  [ \"\$(docker exec '$c' cat /tmp/claude-starts)\" = '/tmp/ws/no-origin --remote-control no-origin' ]"
docker rm -f "$c" >/dev/null

c=$(run_bg -e STUB="$STUB" -e DEV_REMOTE_CONTROL_MODE=server -e DEV_REMOTE_CONTROL_SKIP_PERMISSIONS=1 \
  -e DEV_WORKSPACE=/tmp/ws/checkout "$IMAGE" bash -c "
  git init -q /tmp/ws/checkout && git -C /tmp/ws/checkout remote add origin https://github.com/example/my-repo.git &&
  touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
check "DEV_REMOTE_CONTROL_MODE=server runs claude remote-control, a worktree per session, in a git workspace" bash -c "
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts
  docker exec '$c' grep -qxF -- '/tmp/ws/checkout remote-control --name my-repo --spawn worktree --permission-mode bypassPermissions' /tmp/claude-starts &&
  docker logs '$c' 2>&1 | grep -q '(server mode) as \"my-repo\"'"
check "server mode with SKIP_PERMISSIONS=1 accepts the bypass disclaimer and trusts the workspace" docker exec "$c" \
  jq -e '.bypassPermissionsModeAccepted == true and .projects["/tmp/ws/checkout"].hasTrustDialogAccepted == true' /persist/claude/.claude.json
check "server mode: docker stop completes in under 10s with exit 0" stops_within "$c" 10

c=$(run_bg -w /tmp -e STUB="$STUB" -e DEV_REMOTE_CONTROL_MODE=server -e DEV_REMOTE_CONTROL_NAME=rc-server \
  "$IMAGE" bash -c "touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
check "server mode outside a git repo falls back to --spawn same-dir with a warning" bash -c "
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts
  [ \"\$(docker exec '$c' cat /tmp/claude-starts)\" = '/tmp remote-control --name rc-server --spawn same-dir' ] &&
  docker logs '$c' 2>&1 | grep -q 'not a git repository - sessions share it'"
check "server mode without SKIP_PERMISSIONS leaves the bypass disclaimer alone" docker exec "$c" \
  jq -e '.bypassPermissionsModeAccepted == null' /persist/claude/.claude.json
docker rm -f "$c" >/dev/null

c=$(run_bg -e DEV_REMOTE_CONTROL_MODE=bogus "$IMAGE")
check "an unknown DEV_REMOTE_CONTROL_MODE is rejected: logged, exit status 2" bash -c "
  for _ in \$(seq 30); do [ \"\$(docker inspect -f '{{.State.Running}}' '$c')\" = false ] && break; sleep 1; done
  docker logs '$c' 2>&1 | grep 'dev-remote-control'
  docker logs '$c' 2>&1 | grep -q 'DEV_REMOTE_CONTROL_MODE must be session or server, not \"bogus\"' &&
  [ \"\$(docker inspect -f '{{.State.ExitCode}}' '$c')\" = 2 ]"
docker rm -f "$c" >/dev/null

# The real Claude, with only `auth status` faked: it must reach its prompt in
# the tmux session without stopping at the trust or onboarding dialogs, and
# stop promptly. Remote Control itself needs a real claude.ai login, so it
# does not connect here.
REAL='#!/bin/bash
[ "$1" = auth ] && { echo "{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}"; exit 0; }
exec /home/node/.local/bin/claude "$@"'
c=$(run_bg -w /tmp -e STUB="$REAL" -e CLAUDE_CODE_OAUTH_TOKEN=not-a-real-token \
  "$IMAGE" bash -c "$WITH_STUB exec dev-remote-control")
check "real Claude starts in tmux past the trust and onboarding dialogs" bash -c "
  for _ in \$(seq 60); do
    docker exec '$c' tmux capture-pane -p -t claude 2>/dev/null | grep -q 'for shortcuts' && break
    sleep 1
  done
  pane=\$(docker exec '$c' tmux capture-pane -p -t claude 2>&1)
  echo \"\$pane\"
  echo \"\$pane\" | grep -q 'for shortcuts' && ! echo \"\$pane\" | grep -qiE 'trust this folder|text style'"
check "real Claude: docker stop completes in under 10s with exit 0" stops_within "$c" 10

echo "== 9. agentsview session push"
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
  docker run --rm -v "$1:/persist/claude" -e SID="$2" --entrypoint "" "$IMAGE" bash -c '
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
# pusher <name>: a headless container (image ENTRYPOINT, so dev-init runs at
# start) with the push configured
pusher() {
  docker run -d --label "$RUN_ID" --name "$RUN_ID-$1" --network "$net" \
    -e "AGENTSVIEW_PG_URL=postgres://av:pw@$RUN_ID-pg:5432/agentsview?sslmode=require" \
    -e DEV_MACHINE_NAME='test "host"' -e DEV_AGENTSVIEW_RETRY_SECONDS=2 \
    -v "$avdata:/persist/agentsview" -v "$avclaude:/persist/claude" \
    "$IMAGE" sleep infinity >/dev/null
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
  out=\$(docker run --rm --entrypoint '' -e AGENTSVIEW_PG_URL='postgres://av:pw@no-such-host.invalid:5432/agentsview?sslmode=require' '$IMAGE' dev-doctor 2>&1)
  echo \"\$out\"
  echo \"\$out\" | grep -q 'FAIL agentsview cannot reach the central PostgreSQL' &&
  echo \"\$out\" | grep -q 'FAIL agentsview session push is not running'"

echo "== 10. shared files (/shared)"
check "/shared exists, is owned 1000:1000 with mode 0755 and ships empty" in_image '
  [ "$(stat -c %u:%g:%a /shared)" = 1000:1000:755 ] || { stat -c %u:%g:%a /shared; exit 1; }
  [ -z "$(find /shared -mindepth 1 | head -n 1)" ] || { find /shared -mindepth 1; exit 1; }' \
  --entrypoint ""
check "DEV_SHARED_DIR is /shared" in_image '[ "$DEV_SHARED_DIR" = /shared ]'
check "shared label is /shared" bash -c "
  [ \"\$(docker image inspect -f '{{index .Config.Labels \"dev.cbundy.shared\"}}' '$IMAGE')\" = /shared ]"
check "not mounted: dev-init stays quiet and dev-doctor reports it as optional, not failed" in_image '
  out=$( { dev-init; dev-doctor; } 2>&1 ); echo "$out"
  echo "$out" | grep -q "^dev-doctor: OK   /shared not mounted (optional)$" &&
  ! echo "$out" | grep -E "WARNING|FAIL" | grep -q /shared' \
  --entrypoint ""
vol=$(docker volume create --label "$RUN_ID")
check "a writable volume at /shared: node can write and dev-doctor reports OK" in_image '
  out=$( { touch /shared/.probe && rm /shared/.probe && echo wrote; dev-init; dev-doctor; } 2>&1 ); echo "$out"
  echo "$out" | grep -qx wrote &&
  echo "$out" | grep -q "^dev-doctor: OK   /shared mounted and writable$" &&
  ! echo "$out" | grep -E "WARNING|FAIL" | grep -q /shared' \
  -v "$vol:/shared" --entrypoint ""
rootvol=$(docker volume create --label "$RUN_ID")
# Not empty, or Docker copies the image's node-owned /shared into it again.
docker run --rm --user root -v "$rootvol:/shared" "$IMAGE" \
  bash -c 'touch /shared/.root-owned && chown -R root:root /shared'
check "a root-owned volume at /shared: dev-init warns with the fix but exits 0" in_image '
  out=$(dev-init 2>&1); rc=$?; echo "$out"
  [ $rc = 0 ] &&
  echo "$out" | grep -q "dev-init: WARNING: /shared is mounted but not writable by node (1000:1000)" &&
  echo "$out" | grep -q "all_squash,anonuid=1000,anongid=1000"' \
  -v "$rootvol:/shared" --entrypoint ""
check "a root-owned volume at /shared: dev-doctor fails that check with the fix" in_image '
  out=$(dev-doctor 2>&1); rc=$?; echo "$out"
  [ $rc = 1 ] &&
  echo "$out" | grep -A1 "^dev-doctor: FAIL /shared mounted but not writable by node (1000:1000)$" | grep -q "fix: .*all_squash,anonuid=1000,anongid=1000"' \
  -v "$rootvol:/shared" --entrypoint ""

echo
echo "$PASSES passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ]
