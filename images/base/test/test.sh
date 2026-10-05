#!/bin/bash
# Container scripts are single-quoted on purpose: they expand inside the image.
# shellcheck disable=SC2016
#
# Container tests for the dev-system base image (cbundy/dev-system#59, #64 for
# the entrypoint and Remote Control, #65 for the /shared mount point, #73
# for per-repo /persist volumes, #74 for first-run logins and #77 for the
# workspace repo clone), #103 for the agentsview URL as a secret file.
#
# Usage: images/base/test/test.sh <image>
#
# Runs on a Docker host against an already-built image - locally and in
# publish-base-image.yml. Sections 1-7 match the tests in #59, section 8 the
# entrypoint tests in #64, section 9 the agentsview push in #69, section 10
# the /shared tests in #65 (Docker volumes stand in for the NAS), section 11
# the first-run logins in #74 (against stub CLIs), including the page behind
# an nginx path prefix (#79, a throwaway nginx container), section 12 the
# workspace repo clone in #77 (local bare repos over file:// and a git smart
# HTTP server in the container, so no network is needed), section 13 the
# workspace repo's Claude plugins in #112 (against a stub `claude plugin`).
# Test 7 needs
# the devcontainer CLI (`devcontainer` on PATH, or set
# DEVCONTAINER="npx -y @devcontainers/cli"); SKIP_DEVCONTAINER=1 skips it.
# Test 9 starts a throwaway postgres:17 container. No test needs real
# credentials: the logged-in path runs against a stub `claude`, and the
# agentsview URLs point at that throwaway database or at nowhere.
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

# put_secret <volume> <value>: writes the agentsview URL into a secrets volume
# the way images/base/README.md tells you to (value on stdin, never in an
# argument), so the test also proves the documented command.
put_secret() {
  printf '%s\n' "$2" | docker run --rm -i --user root --entrypoint "" \
    -v "$1:/run/secrets/dev-system" "$IMAGE" \
    sh -c 'umask 077 && cat > "$DEV_SECRETS_DIR/agentsview-pg-url" && chown 1000:1000 "$DEV_SECRETS_DIR/agentsview-pg-url"'
}

# A recognisable password for every test URL, to prove it never shows up in
# a log, a report, a process list or docker inspect.
SECRET="dsb-secret-$$-pw"

cleanup() {
  docker ps -aq --filter "label=$RUN_ID" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter "label=$RUN_ID" | xargs -r docker volume rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter "name=^$RUN_ID-" | xargs -r docker volume rm -f >/dev/null 2>&1 || true
  docker network ls -q --filter "label=$RUN_ID" | xargs -r docker network rm >/dev/null 2>&1 || true
  # An if, not `[ ... ] && rm`: a false test as the trap's last command would
  # become the script's exit status, failing a green run that skipped test 7.
  if [ -n "${WORKDIR:-}" ]; then rm -rf "$WORKDIR"; fi
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
# The start-up warning for /persist dirs with no volume behind them (#78):
# loud, naming each one, but never failing the start.
check "dev-init warns (exit 0) naming every /persist dir with no volume, only those" bash -c "
  out=\$(docker run --rm --entrypoint '' '$IMAGE' bash -c 'dev-init; echo rc=\$?' 2>&1)
  echo \"\$out\"
  echo \"\$out\" | grep -qx 'rc=0' &&
  echo \"\$out\" | grep -qF 'dev-init: WARNING: no volume behind /persist/claude /persist/codex /persist/gh /persist/no-mistakes /persist/agentsview - ' &&
  echo \"\$out\" | grep -qF 'npx callum-dev update --devcontainer base-image' &&
  out=\$(docker run --rm --entrypoint '' -v \"\$(docker volume create --label '$RUN_ID'):/persist/claude\" '$IMAGE' dev-init 2>&1) &&
  echo \"\$out\" | grep -qF 'dev-init: WARNING: no volume behind /persist/codex /persist/gh /persist/no-mistakes /persist/agentsview - '"
check "dev-init: no volume warning with one volume for all of /persist (the k8s / Coder shape)" in_image '
  out=$(dev-init 2>&1); echo "$out"
  ! echo "$out" | grep -q "no volume behind"' \
  -v "$vol:/persist" --entrypoint ""
check "dev-init: no volume warning with a volume per /persist dir (the devcontainer shape)" bash -c "
  args=()
  for t in claude codex gh no-mistakes agentsview; do
    args+=(-v \"\$(docker volume create --label '$RUN_ID'):/persist/\$t\")
  done
  out=\$(docker run --rm --entrypoint '' \"\${args[@]}\" '$IMAGE' dev-init 2>&1)
  echo \"\$out\"
  ! echo \"\$out\" | grep -q 'no volume behind'"

# The no-mistakes daemon (cbundy/dev-system#101): with no systemd in the
# container, systemctl must fail, so `daemon start` falls back to running the
# daemon itself at once instead of waiting 135s on a unit that never starts.
check "systemctl fails without systemd, and no build-time systemd unit ships" in_image '
  out=$(systemctl --user daemon-reload 2>&1); rc=$?; echo "$out"
  [ $rc -ne 0 ] && echo "$out" | grep -q "systemd is not running" && [ ! -e ~/.config/systemd ]' \
  --entrypoint ""
check "dev-init starts the no-mistakes daemon and registers a gated repo within 30s" in_image '
  git init -q --bare /tmp/origin.git && git init -q /tmp/r && git -C /tmp/r remote add origin /tmp/origin.git
  touch /tmp/r/.no-mistakes.yaml && cd /tmp/r
  start=$(date +%s); out=$(dev-init 2>&1); took=$(($(date +%s) - start))
  echo "$out"; echo "dev-init took ${took}s"
  [ "$took" -lt 30 ] && ! echo "$out" | grep -q "WARNING: no-mistakes" &&
  echo "$out" | grep -qF "dev-doctor: OK   no-mistakes: /tmp/r is registered" && no-mistakes daemon status </dev/null' \
  --entrypoint ""

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
  check "devcontainer metadata label declares only the shared gh and read-only secrets volumes, dev-init, Remote Control off, DEV_SHARED_DIR and DEV_SECRETS_DIR" bash -c "
    docker image inspect -f '{{index .Config.Labels \"devcontainer.metadata\"}}' '$IMAGE' | jq -e '
      .[-1] as \$m
      | \$m.remoteUser == \"node\"
      and \$m.postStartCommand == \"dev-init && dev-remote-control --post-start\"
      and \$m.containerEnv.DEV_REMOTE_CONTROL == \"0\"
      and \$m.containerEnv.DEV_DESKTOP == \"1\"
      and \$m.containerEnv.DEV_SHARED_DIR == \"/shared\"
      and \$m.containerEnv.DEV_SECRETS_DIR == \"/run/secrets/dev-system\"
      and (\$m.containerEnv | has(\"AGENTSVIEW_PG_URL\") | not)
      and \$m.updateRemoteUserUID == false
      and \$m.mounts == [{\"type\": \"volume\", \"source\": \"dev-system-gh\", \"target\": \"/persist/gh\"},
        \"type=volume,source=dev-system-secrets,target=/run/secrets/dev-system,readonly\"]'"

  # The four per-repo mounts exactly as the synced base-image template ships
  # them (#78), with $RUN_ID in place of the dev-system prefix.
  template="$(dirname "$0")/../../../templates/.devcontainer/devcontainer.base-image.json"
  template_mounts=$(grep -F '"target": "/persist/' "$template" | sed "s/\"dev-system-/\"$RUN_ID-/")
  check "the base-image template's four per-repo mounts are found" \
    [ "$(printf '%s\n' "$template_mounts" | grep -cF "\"$RUN_ID-\${devcontainerId}-")" = 4 ]

  # dc_up <name> [extra devcontainer.json lines] [extra mounts]: `devcontainer
  # up` on a minimal image config in its own workspace folder; sets $cid. The
  # shared gh and secrets volumes are overridden (same target) with per-run
  # ones, which also proves a consumer can override them and keeps the test
  # away from a developer's real dev-system-secrets. The secrets volume holds
  # a URL to a host that does not exist, so the push starts but reaches no
  # database.
  docker volume create --label "$RUN_ID" "$RUN_ID-secrets" >/dev/null
  put_secret "$RUN_ID-secrets" "postgres://av:$SECRET@no-such-host.invalid:5432/agentsview?sslmode=require"
  dc_up() {
    local ws="$WORKDIR/$1" up
    mkdir -p "$ws/.devcontainer"
    chmod 0755 "$WORKDIR" "$ws"
    cat > "$ws/.devcontainer/devcontainer.json" <<EOF
{
  "image": "$IMAGE",
  "mounts": [
$template_mounts,
    { "type": "volume", "source": "$RUN_ID-gh", "target": "/persist/gh" },
    "type=volume,source=$RUN_ID-secrets,target=/run/secrets/dev-system,readonly"${3:+,
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
    check "dev-init: no volume warning with the template's mounts" bash -c "
      out=\$(docker exec '$cid' dev-init 2>&1); echo \"\$out\"
      ! echo \"\$out\" | grep -q 'no volume behind'"
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
    check "the secrets volume is mounted read-only at DEV_SECRETS_DIR" bash -c "
      docker inspect -f '{{json .Mounts}}' '$cid' | jq -e '
        map(select(.Destination == \"/run/secrets/dev-system\" and .Name == \"$RUN_ID-secrets\" and .RW == false)) | length == 1' &&
      docker exec '$cid' bash -c '! touch \"\$DEV_SECRETS_DIR/probe\" 2>/dev/null'"
    check "with the secret file, post-start starts the push, labelled desktop-<folder>, the URL only in the push's environment" bash -c "
      docker exec '$cid' bash -c '
        cat /persist/agentsview/config.toml
        grep -qx \"local_machine_name = \\\"desktop-default\\\"\" /persist/agentsview/config.toml &&
        pgrep -x agentsview-push >/dev/null &&
        [ -z \"\${AGENTSVIEW_PG_URL:-}\" ]'"
    check "dev-doctor masks the URL in its report" bash -c "
      out=\$(docker exec '$cid' dev-doctor --warn-only); echo \"\$out\"
      echo \"\$out\" | grep -q 'FAIL agentsview cannot reach the central PostgreSQL (URL from /run/secrets/dev-system/agentsview-pg-url' &&
      echo \"\$out\" | grep -q 'OK   agentsview session push is running' &&
      ! echo \"\$out\" | grep -qF '$SECRET'"
    check "the URL is in no log, process argument list or docker inspect" bash -c "
      sleep 3
      ! docker inspect '$cid' | grep -qF '$SECRET' &&
      ! docker logs '$cid' 2>&1 | grep -qF '$SECRET' &&
      ! docker exec '$cid' bash -c 'ps -eo args; cat /tmp/*.log /persist/agentsview/*.log 2>/dev/null' | grep -qF '$SECRET'"
    default_volumes=$(persist_volumes)
    dc_down
  else
    fail "devcontainer up succeeds"
  fi

  # DEV_LOGIN_TOOLS=claude: no real codex or gh device code is requested.
  if dc_up remote-control '"containerEnv": { "DEV_REMOTE_CONTROL": "1", "DEV_LOGIN_TOOLS": "claude" },'; then
    pass "devcontainer up succeeds with DEV_REMOTE_CONTROL=1"
    # no login in a test volume, so the supervisor waits for one
    # The sign-in link comes from dev-login watch, after the supervisor's hint.
    check "with DEV_REMOTE_CONTROL=1 the post-start hook starts the supervisor in the workspace, waiting for a login" bash -c "
      for _ in \$(seq 60); do
        docker exec '$cid' grep -q 'dev-login: claude: open' /tmp/dev-remote-control.log 2>/dev/null && break
        sleep 1
      done
      docker exec '$cid' bash -c '
        cat /tmp/dev-remote-control.log
        grep -q \"Claude is not logged in - open the sign-in link dev-login logs\" /tmp/dev-remote-control.log &&
        grep -q \"dev-login: claude: open https://claude.com/cai/oauth/authorize\" /tmp/dev-remote-control.log &&
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
# exists; `auth login` behaves like the real one (a sign-in URL, then a
# prompt for the code; attempt N accepts good-code-N, anything else gets
# "Invalid code"); a session first asks for Remote Control consent, as the
# real CLI does, while remoteDialogSeen is not true in .claude.json (it records
# /tmp/claude-consent-prompt and waits for an answer, so it never starts
# unattended), then records its directory and arguments in /tmp/claude-starts
# and runs until /tmp/claude-exit exists and exits 3.
STUB='#!/bin/bash
if [ "$1 ${2:-}" = "auth login" ]; then
  n=$(( $(cat /tmp/claude-logins 2>/dev/null || echo 0) + 1 )); echo $n > /tmp/claude-logins
  echo "Opening browser to sign in..."
  echo "If the browser did not open, visit: https://claude.com/cai/oauth/authorize?code=true&state=attempt$n"
  while read -r -p "Paste code here if prompted > " code; do
    [ "$code" = "good-code-$n" ] && { touch /tmp/logged-in; echo "Login successful."; exit 0; }
    echo "Invalid code. Please make sure the full code was copied."
  done
  exit 1
fi
if [ "$1" = auth ]; then
  [ -e /tmp/logged-in ] && { echo "{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}"; exit 0; }
  echo "{\"loggedIn\":false,\"authMethod\":\"none\"}"
  exit 1
fi
if [ "$(jq -r .remoteDialogSeen "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.claude.json" 2>/dev/null)" != true ]; then
  touch /tmp/claude-consent-prompt
  read -r -p "Enable Remote Control? (y/n) " answer
  [ "$answer" = y ] || exit 0
fi
echo "$PWD $*" >> /tmp/claude-starts
until [ -e /tmp/claude-exit ]; do sleep 0.2; done
exit 3'
# Stub codex and gh device logins: a URL and a one-time code; approving is
# touching /tmp/<tool>-approve, which logs the tool in (gh then runs
# `auth setup-git`, recorded in /tmp/gh-setup-git, which also gives git a
# credential helper, as the real one does); /tmp/<tool>-expire ends
# the attempt without a login, as an expired code does.
STUB_CODEX='#!/bin/bash
case "$1 ${2:-}" in
  "login status") [ -e /tmp/codex-in ]; exit ;;
  "login --device-auth")
    n=$(( $(cat /tmp/codex-logins 2>/dev/null || echo 0) + 1 )); echo $n > /tmp/codex-logins
    printf "1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n"
    printf "2. Enter this one-time code (expires in 15 minutes)\n   CDX$n-ABCDE\n"
    until [ -e /tmp/codex-approve ]; do
      [ -e /tmp/codex-expire ] && { rm -f /tmp/codex-expire; echo "Device code expired"; exit 1; }
      sleep 0.2
    done
    touch /tmp/codex-in ;;
esac'
STUB_GH='#!/bin/bash
case "$1 ${2:-}" in
  "auth status") [ -e /tmp/gh-in ]; exit ;;
  "auth setup-git")
    touch /tmp/gh-setup-git
    git config --global credential.helper "!f() { echo username=stub; echo password=stub; }; f" ;;
  "auth login")
    echo "! First copy your one-time code: GH12-3456"
    echo "Open this URL to continue in your web browser: https://github.com/login/device"
    until [ -e /tmp/gh-approve ]; do sleep 0.2; done
    touch /tmp/gh-in ;;
esac'
# Installs $STUB, $STUB_CODEX and $STUB_GH first on PATH (an empty one is a
# CLI that is always logged in, so the codex and gh stubs only matter where
# a test passes them), then runs the rest of the command line.
WITH_STUB='mkdir -p /tmp/stub && printf "%s\n" "$STUB" > /tmp/stub/claude && printf "%s\n" "${STUB_CODEX:-}" > /tmp/stub/codex && printf "%s\n" "${STUB_GH:-}" > /tmp/stub/gh && chmod +x /tmp/stub/* && PATH=/tmp/stub:$PATH'

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
# Tests on the real CLIs log in only Claude (DEV_LOGIN_TOOLS=claude), whose
# login prints a link without contacting anyone; real codex and gh logins
# would request device codes.
c=$(run_bg -e DEV_REMOTE_CONTROL_POLL=1 -e DEV_LOGIN_TOOLS=claude "$IMAGE")
check "no login, no command: logs the real Claude sign-in link and the docker exec dev-login hint" bash -c "
  for _ in \$(seq 60); do docker logs '$c' 2>&1 | grep -q 'dev-login: claude: open' && break; sleep 1; done
  docker logs '$c' 2>&1 | grep 'dev-'
  docker logs '$c' 2>&1 | grep -q 'Claude is not logged in - open the sign-in link dev-login logs (or the login page), then paste the code: docker exec -it ${c:0:12} dev-login <code>' &&
  docker logs '$c' 2>&1 | grep -qE 'dev-login: claude: open https://claude.com/cai/oauth/authorize\\?\\S*code=true'"
check "no login: repeats the hint every 10 polls, not every poll" bash -c "
  for _ in \$(seq 40); do
    [ \"\$(docker logs '$c' 2>&1 | grep -c 'Claude is not logged in')\" -ge 2 ] && break
    sleep 1
  done
  docker logs '$c' 2>&1 | grep 'dev-remote-control'
  [ \"\$(docker logs '$c' 2>&1 | grep -c 'Claude is not logged in')\" = 2 ]"
check "no login: the container stays up without crash-looping or starting Claude" bash -c "
  [ \"\$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' '$c')\" = 'true 0' ] &&
  docker exec '$c' bash -c '! tmux has-session -t claude 2>/dev/null'"
check "no login: docker stop completes in under 10s with exit 0, with the login pending" stops_within "$c" 10

c=$(run_bg -e ANTHROPIC_API_KEY=sk-ant-test-not-a-real-key -e DEV_LOGIN_TOOLS=claude "$IMAGE")
check "an API-key-only login gets the claude.ai subscription message" \
  wait_until 30 logs_have "$c" "logged in with api_key, but Remote Control needs a claude.ai subscription login"
check "an API-key login: dev-login leaves it alone (no Claude login started)" bash -c "
  docker exec '$c' dev-login status
  docker exec '$c' dev-login status | grep -qx 'claude: other' && ! docker exec '$c' tmux has-session -t login-claude"
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

# Remote Control consent (#88): with a config that is logged in but has never
# answered the one-time "Enable Remote Control?" prompt, the supervisor
# pre-answers it in both modes, so the stub starts without prompting, and
# keeps the config's other values.
for mode in session server; do
  c=$(run_bg -w /tmp -e STUB="$STUB" -e DEV_REMOTE_CONTROL_MODE=$mode "$IMAGE" bash -c "
    echo '{\"userID\":\"keep-me\",\"hasCompletedOnboarding\":true}' > /persist/claude/.claude.json &&
    touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
  check "$mode mode: Remote Control consent is pre-answered, so Claude starts unattended" bash -c "
    for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
    docker exec '$c' cat /tmp/claude-starts
    docker exec '$c' test -s /tmp/claude-starts && ! docker exec '$c' test -e /tmp/claude-consent-prompt &&
    docker exec '$c' jq -e '.remoteDialogSeen == true and .userID == \"keep-me\"' /persist/claude/.claude.json"
  docker rm -f "$c" >/dev/null
done

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
check "with no URL (no secret file, no AGENTSVIEW_PG_URL), dev-init starts no push and dev-doctor warns how to turn it on" in_image '
  out=$(dev-init 2>&1; dev-doctor --warn-only); echo "$out"
  ! pgrep -x agentsview-push >/dev/null &&
  [ ! -e /persist/agentsview/config.toml ] &&
  echo "$out" | grep -q "WARN agentsview session push is off: no /run/secrets/dev-system/agentsview-pg-url and no AGENTSVIEW_PG_URL" &&
  echo "$out" | grep -q "fix: put the PostgreSQL URL in /run/secrets/dev-system/agentsview-pg-url once per Docker host or cluster" &&
  ! echo "$out" | grep -q "FAIL agentsview"'
unreadable=$(docker volume create --label "$RUN_ID")
put_secret "$unreadable" "postgres://av:$SECRET@nowhere.invalid/agentsview"
docker run --rm --user root --entrypoint "" -v "$unreadable:/run/secrets/dev-system" "$IMAGE" \
  chown 0:0 /run/secrets/dev-system/agentsview-pg-url
check "an unreadable secret file: dev-init warns, starts no push, and dev-doctor fails with the fix" bash -c "
  out=\$(docker run --rm --entrypoint '' -v '$unreadable:/run/secrets/dev-system:ro' '$IMAGE' bash -c 'dev-init; pgrep -x agentsview-push && echo PUSHING; dev-doctor --warn-only' 2>&1)
  echo \"\$out\"
  echo \"\$out\" | grep -q 'dev-init: WARNING: /run/secrets/dev-system/agentsview-pg-url is empty or not readable by node' &&
  echo \"\$out\" | grep -q 'FAIL agentsview session push is off: /run/secrets/dev-system/agentsview-pg-url is empty or not readable by node' &&
  ! echo \"\$out\" | grep -q PUSHING"

# A TLS PostgreSQL (agentsview refuses plaintext to a non-local host) on a
# private network, plus one shared data volume and one shared Claude volume:
# the shape of several containers on one Docker host.
net=$(docker network create --label "$RUN_ID" "$RUN_ID-net")
docker run -d --label "$RUN_ID" --name "$RUN_ID-pg" --network "$net" \
  -e POSTGRES_USER=av -e POSTGRES_PASSWORD="$SECRET" -e POSTGRES_DB=agentsview \
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
    -e "AGENTSVIEW_PG_URL=postgres://av:$SECRET@$RUN_ID-pg:5432/agentsview?sslmode=require" \
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
  out=\$(docker run --rm --entrypoint '' -e AGENTSVIEW_PG_URL='postgres://av:$SECRET@no-such-host.invalid:5432/agentsview?sslmode=require' '$IMAGE' dev-doctor 2>&1)
  echo \"\$out\"
  echo \"\$out\" | grep -q 'FAIL agentsview cannot reach the central PostgreSQL (URL from AGENTSVIEW_PG_URL' &&
  echo \"\$out\" | grep -q 'FAIL agentsview session push is not running' &&
  ! echo \"\$out\" | grep -qF '$SECRET'"
check "mask_secrets hides URL and keyword passwords" in_image '
  . /usr/local/share/dev-system/agentsview.sh
  [ "$(echo "dial postgres://av:p4ss@h:5432/db?sslmode=require failed" | mask_secrets)" = "dial postgres://***@h:5432/db?sslmode=require failed" ] &&
  [ "$(echo "host=h password=p4ss user=av" | mask_secrets)" = "host=h password=*** user=av" ]' --entrypoint ""

# The secret file, as every runtime delivers it (#103): a volume (Docker) or
# directory (Coder) mounted read-only at /run/secrets/dev-system, here a named
# volume written with the README's command. A container that starts before
# the secret is there is off; once it arrives, dev-init (or a restart) starts
# the push, with the URL in no env, log, argument list or docker inspect.
secrets=$(docker volume create --label "$RUN_ID")
fdata=$(docker volume create --label "$RUN_ID")
fclaude=$(docker volume create --label "$RUN_ID")
write_session "$fclaude" 33333333-3333-4333-8333-333333333333
docker run -d --label "$RUN_ID" --name "$RUN_ID-f" --network "$net" \
  -e DEV_MACHINE_NAME=file-host -e DEV_AGENTSVIEW_RETRY_SECONDS=2 \
  -v "$secrets:/run/secrets/dev-system:ro" -v "$fdata:/persist/agentsview" -v "$fclaude:/persist/claude" \
  "$IMAGE" sleep infinity >/dev/null
sleep 3
check "before the secret arrives: no push, and dev-doctor warns that it is off" docker exec "$RUN_ID-f" bash -c '
  out=$(dev-doctor --warn-only); echo "$out"
  ! pgrep -x agentsview-push >/dev/null &&
  echo "$out" | grep -q "WARN agentsview session push is off"'
put_secret "$secrets" "postgres://av:$SECRET@$RUN_ID-pg:5432/agentsview?sslmode=require"
docker exec "$RUN_ID-f" dev-init >/dev/null 2>&1
check "once the secret file arrives, dev-init starts the push and a session reaches PostgreSQL" wait_for_session 33333333-3333-4333-8333-333333333333
check "dev-doctor reports the database reachable (URL from the file) and the push running" docker exec "$RUN_ID-f" bash -c '
  out=$(dev-doctor --warn-only); echo "$out"
  echo "$out" | grep -q "OK   agentsview: central PostgreSQL is reachable (URL from /run/secrets/dev-system/agentsview-pg-url" &&
  echo "$out" | grep -q "OK   agentsview session push is running"'
check "the file's URL is not in the container's env, logs, process arguments, dev-doctor or docker inspect" bash -c "
  ! docker inspect '$RUN_ID-f' | grep -qF '$SECRET' &&
  ! docker logs '$RUN_ID-f' 2>&1 | grep -qF '$SECRET' &&
  ! docker exec '$RUN_ID-f' bash -c 'env; ps -eo args; dev-doctor --warn-only; cat /tmp/*.log /persist/agentsview/*.log 2>/dev/null' | grep -qF '$SECRET'"
check "AGENTSVIEW_PG_URL overrides the file" bash -c "
  out=\$(docker run --rm --entrypoint '' -e AGENTSVIEW_PG_URL='postgres://av:x@no-such-host.invalid/agentsview' -v '$secrets:/run/secrets/dev-system:ro' '$IMAGE' dev-doctor 2>&1)
  echo \"\$out\"
  echo \"\$out\" | grep -q 'cannot reach the central PostgreSQL (URL from AGENTSVIEW_PG_URL'"

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

echo "== 11. first-run logins (dev-login)"

# in_c <container> <script>: runs a script in the container with the stubs
# first on PATH, as the supervisor sees them
in_c() {
  docker exec "$1" bash -c "PATH=/tmp/stub:\$PATH; $2"
}

# The supervisor with all three logins missing, against the stub CLIs.
c=$(run_bg -e STUB="$STUB" -e STUB_CODEX="$STUB_CODEX" -e STUB_GH="$STUB_GH" \
  -e DEV_REMOTE_CONTROL_POLL=1 -e DEV_REMOTE_CONTROL_NAME=login-test \
  "$IMAGE" bash -c "$WITH_STUB exec dev-remote-control")
check "the supervisor logs each tool's sign-in link and the paste hint" bash -c "
  for _ in \$(seq 30); do docker logs '$c' 2>&1 | grep -q 'dev-login: gh: open' && break; sleep 1; done
  docker logs '$c' 2>&1 | grep 'dev-'
  docker logs '$c' 2>&1 | grep -qF 'dev-login: claude: open https://claude.com/cai/oauth/authorize?code=true&state=attempt1 and approve, then paste the code it shows into the login page or run: docker exec -it ${c:0:12} dev-login <code>' &&
  docker logs '$c' 2>&1 | grep -qF 'dev-login: codex: open https://auth.openai.com/codex/device and enter the code CDX1-ABCDE' &&
  docker logs '$c' 2>&1 | grep -qF 'dev-login: gh: open https://github.com/login/device and enter the code GH12-3456' &&
  docker logs '$c' 2>&1 | grep -q 'Claude is not logged in - open the sign-in link dev-login logs'"
check "dev-login status lists each tool's state and the pending links" in_c "$c" '
  out=$(dev-login status 2>&1); rc=$?; echo "$out"
  [ $rc = 0 ] && ! echo "$out" | grep -q "dev-login: .*line" &&
  echo "$out" | grep -qx "claude: out" && echo "$out" | grep -qx "codex: out" && echo "$out" | grep -qx "gh: out" &&
  echo "$out" | grep -qF "codex: open https://auth.openai.com/codex/device and enter the code CDX1-ABCDE" &&
  dev-login status --json | jq -e ".codex == {state: \"out\", url: \"https://auth.openai.com/codex/device\", code: \"CDX1-ABCDE\"}"'
check "dev-login start is idempotent: the attempts in progress keep their links" in_c "$c" '
  dev-login start >/dev/null; dev-login start | grep -q "state=attempt1 " && [ "$(cat /tmp/claude-logins)" = 1 ] &&
  [ "$(cat /tmp/codex-logins)" = 1 ]'
check "a wrong code fails fast with a clear message and ends that attempt" in_c "$c" '
  start=$(date +%s); out=$(dev-login wrong-code 2>&1); rc=$?; echo "$out"
  [ $rc = 1 ] && [ $(( $(date +%s) - start )) -lt 10 ] &&
  echo "$out" | grep -q "Claude rejected the code" && ! tmux has-session -t login-claude'
check "a control character in a code is refused before it reaches the login" in_c "$c" '
  out=$(dev-login "$(printf "x\ny")" 2>&1); rc=$?; echo "$out"; [ $rc = 2 ] && echo "$out" | grep -q "not a sign-in code"'
check "the next start offers a fresh Claude link" in_c "$c" '
  dev-login start | grep -q "state=attempt2 "'
check "an expired codex code is replaced by a fresh one" in_c "$c" '
  touch /tmp/codex-expire
  for _ in $(seq 20); do tmux has-session -t login-codex 2>/dev/null || break; sleep 0.5; done
  dev-login start | grep -q "enter the code CDX2-ABCDE"'
check "the right code logs Claude in and the supervisor starts Remote Control" bash -c "
  docker exec '$c' bash -c 'PATH=/tmp/stub:\$PATH dev-login good-code-2' || exit 1
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts && docker logs '$c' 2>&1 | grep -q 'Claude login found'"
docker exec "$c" touch /tmp/codex-approve /tmp/gh-approve
check "approving codex and gh completes them; gh wires git (setup-git)" in_c "$c" '
  for _ in $(seq 20); do dev-login status | grep -qx "gh: in" && dev-login status | grep -qx "codex: in" && break; sleep 0.5; done
  dev-login status; dev-login status | grep -qx "codex: in" && dev-login status | grep -qx "gh: in" && test -e /tmp/gh-setup-git'
check "the watcher reports all logins done and exits" bash -c "
  for _ in \$(seq 40); do docker logs '$c' 2>&1 | grep -q 'dev-login: all logins are done' && break; sleep 1; done
  docker logs '$c' 2>&1 | grep -q 'dev-login: all logins are done' && ! docker exec '$c' pgrep -f 'dev-login watch'"
docker rm -f "$c" >/dev/null

c=$(run_bg -e STUB="$STUB" -e STUB_CODEX="$STUB_CODEX" -e STUB_GH="$STUB_GH" -e DEV_LOGIN_TOOLS=claude -e GH_TOKEN=x \
  "$IMAGE" bash -c "$WITH_STUB exec dev-remote-control")
check "DEV_LOGIN_TOOLS=claude starts only Claude's login, and dev-doctor does not fail the others" bash -c "
  for _ in \$(seq 30); do docker logs '$c' 2>&1 | grep -q 'dev-login: claude: open' && break; sleep 1; done
  docker logs '$c' 2>&1 | grep -q 'dev-login: claude: open' && ! docker logs '$c' 2>&1 | grep -qE 'dev-login: (codex|gh):' &&
  docker exec '$c' bash -c '! tmux has-session -t login-codex 2>/dev/null && ! tmux has-session -t login-gh 2>/dev/null' &&
  out=\$(docker exec '$c' bash -c 'PATH=/tmp/stub:\$PATH dev-doctor --warn-only') && echo \"\$out\" &&
  echo \"\$out\" | grep -q 'OK   codex is not logged in (not needed: not in DEV_LOGIN_TOOLS)' &&
  echo \"\$out\" | grep -q 'FAIL claude is not logged in' && echo \"\$out\" | grep -q 'fix: run: dev-login start (or: claude auth login)'"
docker rm -f "$c" >/dev/null

c=$(run_bg -e STUB="$STUB" -e STUB_CODEX="$STUB_CODEX" -e STUB_GH="$STUB_GH" -e GH_TOKEN=gho_not_a_real_token \
  "$IMAGE" bash -c "touch /tmp/logged-in /tmp/codex-in && $WITH_STUB exec dev-remote-control")
check "with GH_TOKEN set, no gh login starts and gh counts as done" in_c "$c" '
  sleep 3; dev-login status | grep -qx "gh: token" && ! tmux has-session -t login-gh 2>/dev/null'
docker rm -f "$c" >/dev/null

# The page: dev-init starts it (DEV_LOGIN_PORT), so the stubs go first on PATH
# before dev-init runs; tini stays PID 1.
# page_bg <docker run args...>: the supervisor, with dev-init run after the stubs
page_bg() {
  run_bg -e STUB="$STUB" -e STUB_CODEX="$STUB_CODEX" -e STUB_GH="$STUB_GH" "$@" \
    --entrypoint /usr/bin/tini "$IMAGE" -- bash -c "$WITH_STUB && dev-init 2>/dev/null; exec dev-remote-control"
}
# curl_c <container> <curl args...>: curl against the page from inside
curl_c() {
  local c="$1"
  shift
  docker exec "$c" curl -sS -m 30 "$@"
}
c=$(page_bg -e DEV_LOGIN_PORT=8765 -e DEV_LOGIN_TOOLS=claude,codex)
check "with DEV_LOGIN_PORT the page serves /healthz" bash -c "
  for _ in \$(seq 30); do docker exec '$c' curl -fsS -m 2 localhost:8765/healthz >/dev/null 2>&1 && break; sleep 1; done
  [ \"\$(docker exec '$c' curl -fsS localhost:8765/healthz)\" = ok ]"
check "the page shows Claude's sign-in link and codex's code" bash -c "
  html=\$(docker exec '$c' curl -fsS -m 60 localhost:8765/)
  echo \"\$html\" | grep -qF 'href=\"https://claude.com/cai/oauth/authorize?code=true&amp;state=attempt1\"' &&
  echo \"\$html\" | grep -q 'Open sign-in page' && echo \"\$html\" | grep -qF 'CDX1-ABCDE' &&
  ! echo \"\$html\" | grep -q 'GitHub CLI'"
check "the page refuses anything but a form POST of a code, and an oversized body" bash -c "
  [ \"\$(docker exec '$c' curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' localhost:8765/)\" = 415 ] &&
  [ \"\$(docker exec '$c' curl -s -o /dev/null -w '%{http_code}' -X POST -d 'nocode=1' localhost:8765/)\" = 400 ] &&
  [ \"\$(docker exec '$c' curl -s -o /dev/null -w '%{http_code}' localhost:8765/nope)\" = 404 ] &&
  big=\$(head -c 10000 /dev/zero | tr '\\\\0' a) &&
  ! [ \"\$(docker exec '$c' curl -s -o /dev/null -w '%{http_code}' -X POST --data-raw \"code=\$big\" localhost:8765/)\" = 303 ]"
check "a wrong code through the page shows why and offers a new link" bash -c "
  html=\$(docker exec '$c' curl -fsS -m 60 -d code=wrong localhost:8765/)
  echo \"\$html\" | grep -q 'That did not work' && echo \"\$html\" | grep -q 'Claude rejected the code' &&
  docker exec '$c' curl -fsS -m 60 localhost:8765/ | grep -qF 'state=attempt2'"
check "the right code through the page logs Claude in (303 back to the page)" bash -c "
  [ \"\$(docker exec '$c' curl -s -m 60 -o /dev/null -w '%{http_code}' -d code=good-code-2 localhost:8765/)\" = 303 ] &&
  docker exec '$c' curl -fsS localhost:8765/status | jq -e '.claude == \"in\" and .codex == \"out\" and .gh == \"off\"'"
docker exec "$c" touch /tmp/codex-approve
check "DEV_LOGIN_PAGE_EXIT=1 (default): the page exits once every login is done" bash -c "
  for _ in \$(seq 40); do docker exec '$c' curl -fsS -m 2 localhost:8765/healthz >/dev/null 2>&1 || break; sleep 1; done
  ! docker exec '$c' curl -fsS -m 2 localhost:8765/healthz && docker exec '$c' grep -q 'closing the login page' /tmp/dev-login-page.log"
check "the page: docker stop completes in under 10s with exit 0" stops_within "$c" 10

c=$(page_bg -e DEV_LOGIN_PORT=8765 -e DEV_LOGIN_PAGE_EXIT=0 -e DEV_LOGIN_TOOLS=claude)
check "DEV_LOGIN_PAGE_EXIT=0: the page stays up after the logins, showing them done" bash -c "
  for _ in \$(seq 30); do docker exec '$c' curl -fsS -m 2 localhost:8765/healthz >/dev/null 2>&1 && break; sleep 1; done
  docker exec '$c' curl -fsS -m 60 localhost:8765/ >/dev/null
  docker exec '$c' bash -c 'PATH=/tmp/stub:\$PATH dev-login good-code-1' && sleep 12 &&
  docker exec '$c' curl -fsS -m 2 localhost:8765/healthz >/dev/null &&
  docker exec '$c' curl -fsS -m 60 localhost:8765/ | grep -q 'logged in'"
docker rm -f "$c" >/dev/null

c=$(page_bg -e DEV_LOGIN_TOOLS=claude)
check "without DEV_LOGIN_PORT no page runs and nothing listens" in_c "$c" '
  sleep 3
  ! pgrep -fx "node /usr/local/share/dev-system/dev-login-page.js" && ! (exec 3<>/dev/tcp/127.0.0.1/8765) 2>/dev/null'
check "a page started anyway is detected (the check above is not vacuous)" in_c "$c" '
  (DEV_LOGIN_PORT=8765 DEV_LOGIN_PAGE_EXIT=0 dev-login serve >/dev/null 2>&1 &)
  for _ in $(seq 20); do (exec 3<>/dev/tcp/127.0.0.1/8765) 2>/dev/null && break; sleep 0.5; done
  pgrep -fx "node /usr/local/share/dev-system/dev-login-page.js" >/dev/null && (exec 3<>/dev/tcp/127.0.0.1/8765) 2>/dev/null'
docker rm -f "$c" >/dev/null

# A no-mistakes whose `daemon start` never returns (cbundy/dev-system#101):
# dev-init stops it at its own limit, says why with the fix, skips the
# recovery (init would only wait the same way) and still starts the page.
STUB_NM='#!/bin/bash
echo "$*" >> /tmp/nm-calls
[ "$*" = "daemon start" ] && exec sleep 1000
[ "$1" = status ] && echo "repo not initialized (run no-mistakes init first)"
exit 0'
c=$(run_bg -e STUB="$STUB" -e STUB_NM="$STUB_NM" -e DEV_LOGIN_PORT=8765 -e DEV_LOGIN_PAGE_EXIT=0 -e DEV_LOGIN_TOOLS=claude \
  --entrypoint /usr/bin/tini "$IMAGE" -- bash -c "$WITH_STUB && printf '%s\n' \"\$STUB_NM\" > /tmp/stub/no-mistakes &&
    chmod +x /tmp/stub/no-mistakes && git init -q /tmp/r && touch /tmp/r/.no-mistakes.yaml && cd /tmp/r &&
    start=\$(date +%s) && dev-init 2> /tmp/dev-init.log; echo \$((\$(date +%s) - start)) > /tmp/dev-init-took
    exec sleep infinity")
check "a no-mistakes daemon start that hangs: dev-init stops it at 30s, names the fix and still starts the page" bash -c "
  for _ in \$(seq 90); do docker exec '$c' test -s /tmp/dev-init-took && break; sleep 1; done
  docker exec '$c' cat /tmp/dev-init.log /tmp/nm-calls; took=\$(docker exec '$c' cat /tmp/dev-init-took)
  echo \"dev-init took \${took}s\"
  [ \"\$took\" -ge 30 ] && [ \"\$took\" -lt 60 ] &&
  docker exec '$c' grep -qF 'dev-init: WARNING: no-mistakes daemon start did not finish within 30s' /tmp/dev-init.log &&
  docker exec '$c' grep -qF 'then run in /tmp/r: no-mistakes daemon start && no-mistakes init' /tmp/dev-init.log &&
  ! docker exec '$c' grep -qx init /tmp/nm-calls &&
  docker exec '$c' grep -qF 'dev-init: started the login page on port 8765' /tmp/dev-init.log &&
  [ \"\$(docker exec '$c' curl -fsS -m 5 localhost:8765/healthz)\" = ok ]"
docker rm -f "$c" >/dev/null

# The page behind a reverse proxy that serves it under a path prefix (#79):
# the README's nginx rule, on a network with two page containers that publish
# nothing. One rule reaches each container by name, and the page's links,
# form, refresh and redirect stay under /login/<name>/.
NGINX_CONF='server {
  listen 80;
  absolute_redirect off;
  location ~ ^/login/(?<ws>[a-z0-9-]+)$ { return 308 $uri/; }
  location ~ ^/login/(?<ws>[a-z0-9-]+)/(?<rest>.*)$ {
    resolver 127.0.0.11 valid=10s;
    proxy_pass http://$ws:8765/$rest$is_args$args;
  }
}'
login_net=$(docker network create --label "$RUN_ID" "$RUN_ID-login")
pa="$RUN_ID-pa"
pb="$RUN_ID-pb"
page_bg --name "$pa" --network "$login_net" -e DEV_LOGIN_PORT=8765 -e DEV_LOGIN_PAGE_EXIT=0 -e DEV_LOGIN_TOOLS=claude >/dev/null
page_bg --name "$pb" --network "$login_net" -e DEV_LOGIN_PORT=8765 -e DEV_LOGIN_TOOLS=claude,codex >/dev/null
run_bg --name "$RUN_ID-nginx" --network "$login_net" -e NGINX_CONF="$NGINX_CONF" nginx:alpine \
  sh -c 'printf "%s\n" "$NGINX_CONF" > /etc/nginx/conf.d/default.conf && exec nginx -g "daemon off;"' >/dev/null
# via <path> [curl args...]: curl through nginx, from inside $pa (on the network)
via() {
  local p="$1"
  shift
  docker exec "$pa" curl -sS -m 60 "$@" "http://$RUN_ID-nginx$p"
}
export -f via
export RUN_ID pa
check "behind nginx: /login/<name>/healthz reaches each container's page" bash -c "
  for c in '$pa' '$pb'; do
    for _ in \$(seq 30); do docker exec '$pa' curl -fsS -m 2 \"http://$RUN_ID-nginx/login/\$c/healthz\" >/dev/null 2>&1 && break; sleep 1; done
    [ \"\$(docker exec '$pa' curl -fsS -m 5 \"http://$RUN_ID-nginx/login/\$c/healthz\")\" = ok ] || exit 1
  done"
check "behind nginx: /login/<name>/status is that container's own" bash -c "
  via '/login/$pa/status' -f | jq -e '.codex == \"off\"' &&
  via '/login/$pb/status' -f | jq -e '.codex == \"out\"'"
check "behind nginx: the page shows the links, and its form, refresh and links are relative" bash -c "
  html=\$(via '/login/$pb/' -f)
  echo \"\$html\" | grep -qF 'state=attempt1' && echo \"\$html\" | grep -qF 'CDX1-ABCDE' &&
  echo \"\$html\" | grep -qF '<form method=\"post\" action=\".\">' &&
  echo \"\$html\" | grep -qF 'fetch(\"status\"' &&
  ! echo \"\$html\" | grep -qE '(href|action)=\"/|fetch\\(\"/'"
check "behind nginx: /login/<name> without the slash redirects to /login/<name>/" bash -c "
  [ \"\$(via '/login/$pb' -o /dev/null -w '%{http_code} %{redirect_url}')\" = '308 http://$RUN_ID-nginx/login/$pb/' ]"
check "behind nginx: a wrong code offers a new link under the prefix" bash -c "
  html=\$(via '/login/$pb/' -f -d code=wrong)
  echo \"\$html\" | grep -q 'That did not work' && echo \"\$html\" | grep -qF 'href=\".\">Get a new link' &&
  via '/login/$pb/' -f | grep -qF 'state=attempt2'"
check "behind nginx: the right code logs in and redirects back under the prefix" bash -c "
  [ \"\$(via '/login/$pb/' -d code=good-code-2 -o /dev/null -w '%{http_code} %{redirect_url}')\" = '303 http://$RUN_ID-nginx/login/$pb/' ] &&
  via '/login/$pb/status' -f | jq -e '.claude == \"in\" and .codex == \"out\"'"
docker rm -f "$pa" "$pb" "$RUN_ID-nginx" >/dev/null

# DEV_NOTIFY_URL against a stub listener in the same container, which records
# each request's title, click header and body.
LISTENER='require("http").createServer((q, r) => { let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => {
  require("fs").appendFileSync("/tmp/notify.log", JSON.stringify({ title: q.headers.title, click: q.headers.click, body: b }) + "\n"); r.end("ok"); }); }).listen(9999)'
c=$(run_bg -e STUB="$STUB" -e STUB_CODEX="$STUB_CODEX" -e STUB_GH="$STUB_GH" -e LISTENER="$LISTENER" \
  -e DEV_LOGIN_TOOLS=claude,codex -e DEV_REMOTE_CONTROL_NAME=notify-test -e DEV_NOTIFY_URL=http://127.0.0.1:9999/topic \
  "$IMAGE" bash -c "(node -e \"\$LISTENER\" &) && sleep 1 && $WITH_STUB exec dev-remote-control")
check "DEV_NOTIFY_URL gets one POST naming the logins, with the sign-in links" bash -c "
  for _ in \$(seq 30); do docker exec '$c' test -s /tmp/notify.log && break; sleep 1; done
  sleep 3; docker exec '$c' cat /tmp/notify.log
  [ \"\$(docker exec '$c' grep -c . /tmp/notify.log)\" = 1 ] &&
  docker exec '$c' jq -e '.title == \"Log in to claude, codex (notify-test)\" and (.click | startswith(\"https://claude.com/cai/oauth/authorize\"))
    and (.body | contains(\"enter the code CDX1-ABCDE\"))' /tmp/notify.log"
docker rm -f "$c" >/dev/null

echo "== 12. workspace repo (DEV_REPO_URL)"

# The remote: a bare repo with main and feature, on a volume at /srv, owned by
# node like every checkout here. Served over file:// (and, for the login
# handoff, over HTTP by the server below), so no network is needed.
REPO_URL=file:///srv/my-repo.git
remote=$(docker volume create --label "$RUN_ID")
# Not left empty, or Docker copies the image's root-owned /srv into it again.
docker run --rm --user root --entrypoint "" -v "$remote:/srv" "$IMAGE" \
  bash -c 'mkdir /srv/my-repo.git && chown 1000:1000 /srv /srv/my-repo.git'
# remote_git <script>: runs a script as node with the remote at /srv and a git identity
remote_git() {
  docker run --rm --entrypoint "" -v "$remote:/srv" -e GIT_AUTHOR_NAME=t -e GIT_AUTHOR_EMAIL=t@example.com \
    -e GIT_COMMITTER_NAME=t -e GIT_COMMITTER_EMAIL=t@example.com "$IMAGE" bash -c "$1"
}
remote_git 'set -e
  git init -q --bare -b main /srv/my-repo.git
  git clone -q /srv/my-repo.git /tmp/w 2>/dev/null && cd /tmp/w
  echo one > README && git add README && git commit -qm one && git push -q origin main
  git checkout -q -b feature && echo f > feature && git add feature && git commit -qm feature && git push -q origin feature'

check "workspace.sh: DEV_WORKSPACE is /workspaces/<repo name> from DEV_REPO_URL, an explicit one wins, unset without a URL" in_image '
  ws() { bash -c ". /usr/local/share/dev-system/workspace.sh; echo \${DEV_WORKSPACE:-unset}"; }
  for u in https://github.com/me/my-repo.git https://github.com/me/my-repo/ git@github.com:me/my-repo.git; do
    [ "$(DEV_REPO_URL=$u ws)" = /workspaces/my-repo ] || { echo "$u: $(DEV_REPO_URL=$u ws)"; exit 1; }
  done
  [ "$(DEV_REPO_URL=https://github.com/me/my-repo.git DEV_WORKSPACE=/w ws)" = /w ] && [ "$(ws)" = unset ]' \
  --entrypoint ""

check "/workspaces exists, is owned 1000:1000 with mode 0755 and ships empty" in_image '
  [ "$(stat -c %u:%g:%a /workspaces)" = 1000:1000:755 ] && [ -z "$(ls -A /workspaces)" ]' \
  --entrypoint ""

# A fresh named volume at /workspaces, as a runtime mounts it (it takes the
# image directory's node ownership): the first start clones into it, the
# second finds the clone there.
wsvol=$(docker volume create --label "$RUN_ID")
# repo_bg: the supervisor against the stub Claude (logged in), with the remote
# and the workspace volume, through the image entrypoint (dev-init first)
repo_bg() {
  run_bg -e STUB="$STUB" -e DEV_REPO_URL="$REPO_URL" -v "$remote:/srv" -v "$wsvol:/workspaces" \
    "$IMAGE" bash -c "touch /tmp/logged-in && $WITH_STUB exec dev-remote-control"
}
c=$(repo_bg)
check "first start: dev-init clones DEV_REPO_URL into the derived DEV_WORKSPACE (/workspaces/my-repo)" bash -c "
  for _ in \$(seq 30); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker logs '$c' 2>&1 | grep 'dev-init: '
  docker logs '$c' 2>&1 | grep -qxF 'dev-init: cloned $REPO_URL into /workspaces/my-repo' &&
  [ \"\$(docker exec '$c' git -C /workspaces/my-repo rev-parse --abbrev-ref HEAD)\" = main ]"
check "first start: the supervisor's Claude starts in the clone, named after the repo" bash -c "
  docker exec '$c' cat /tmp/claude-starts
  [ \"\$(docker exec '$c' cat /tmp/claude-starts)\" = '/workspaces/my-repo --remote-control my-repo' ]"
check "first start: dev-doctor finds the workspace cloned from DEV_REPO_URL" bash -c "
  docker exec '$c' dev-doctor --warn-only | grep -qF 'OK   workspace /workspaces/my-repo is a clone of $REPO_URL'"
# Work in progress: an uncommitted change and a local branch.
docker exec "$c" bash -c 'cd /workspaces/my-repo && echo wip >> README && git branch local-work'
old_main=$(docker exec "$c" git -C /workspaces/my-repo rev-parse main)
docker rm -f "$c" >/dev/null
new_main=$(remote_git 'set -e
  git clone -q /srv/my-repo.git /tmp/w && cd /tmp/w
  echo two >> README && git commit -qam two && git push -q origin main && git rev-parse HEAD')
c=$(repo_bg)
check "second start: no new clone; local changes and branches survive; fetch moves only the remote refs" bash -c "
  for _ in \$(seq 30); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker logs '$c' 2>&1 | grep 'dev-init: '
  ! docker logs '$c' 2>&1 | grep -q 'dev-init: cloned' &&
  docker exec -e OLD='$old_main' -e NEW='$new_main' '$c' bash -c '
    cd /workspaces/my-repo && git status --short --branch
    [ \"\$(git rev-parse origin/main)\" = \"\$NEW\" ] && [ \"\$(git rev-parse main)\" = \"\$OLD\" ] &&
    [ \"\$(git rev-parse --abbrev-ref HEAD)\" = main ] && [ \"\$(git status --porcelain)\" = \" M README\" ] &&
    git rev-parse --verify -q local-work >/dev/null' &&
  [ \"\$(docker exec '$c' cat /tmp/claude-starts)\" = '/workspaces/my-repo --remote-control my-repo' ]"
docker rm -f "$c" >/dev/null

check "a non-empty DEV_WORKSPACE that is no repo is left alone, with a warning" in_image '
  mkdir /workspaces/my-repo && echo keep > /workspaces/my-repo/notes
  out=$(dev-init 2>&1); rc=$?; echo "$out" | grep -A1 "dev-init: WARNING: /workspaces"
  [ $rc = 0 ] && echo "$out" | grep -qF "dev-init: WARNING: /workspaces/my-repo is not empty and not a git repository" &&
  [ "$(ls -A /workspaces/my-repo)" = notes ] && [ "$(cat /workspaces/my-repo/notes)" = keep ]' \
  -e DEV_REPO_URL="$REPO_URL" -v "$remote:/srv" --entrypoint ""
check "an explicit DEV_WORKSPACE wins over the derived one, and DEV_REPO_BRANCH is checked out" in_image '
  out=$(dev-init 2>&1); echo "$out" | grep "dev-init: [^W]"
  echo "$out" | grep -qxF "dev-init: cloned file:///srv/my-repo.git (branch feature) into /tmp/elsewhere" &&
  [ "$(git -C /tmp/elsewhere rev-parse --abbrev-ref HEAD)" = feature ] && test -f /tmp/elsewhere/feature &&
  ! test -e /workspaces/my-repo' \
  -e DEV_REPO_URL="$REPO_URL" -e DEV_WORKSPACE=/tmp/elsewhere -e DEV_REPO_BRANCH=feature -v "$remote:/srv" --entrypoint ""

c=$(run_bg -e STUB="$STUB" -e DEV_REPO_URL=https://no-such-host.invalid/me/my-repo.git \
  "$IMAGE" bash -c "touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
check "an unreachable DEV_REPO_URL: Claude still starts (in \$HOME), and the log names the cause and the fix" bash -c "
  for _ in \$(seq 30); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker logs '$c' 2>&1 | grep -A1 'dev-init: WARNING: could not clone'
  docker logs '$c' 2>&1 | grep -qF \"dev-init: WARNING: could not clone https://no-such-host.invalid/me/my-repo.git into /workspaces/my-repo: fatal: unable to access 'https://no-such-host.invalid/me/my-repo.git/': Could not resolve host: no-such-host.invalid\" &&
  docker logs '$c' 2>&1 | grep -qF 'dev-init:   Fix: check DEV_REPO_URL' &&
  [ \"\$(docker exec '$c' cat /tmp/claude-starts)\" = '/home/node --remote-control my-repo' ] &&
  docker exec '$c' dev-doctor --warn-only | grep -qF 'WARN workspace /workspaces/my-repo is not cloned from DEV_REPO_URL'"
docker rm -f "$c" >/dev/null
check "an SSH DEV_REPO_URL: dev-init warns that it needs SSH keys, tries anyway and names the cause" in_image '
  out=$(dev-init 2>&1); echo "$out" | grep "dev-init: WARNING: [^n]"
  echo "$out" | grep -qF "dev-init: WARNING: DEV_REPO_URL is an SSH URL (git@no-such-host.invalid:me/my-repo.git), which needs SSH keys" &&
  echo "$out" | grep -qF "dev-init: WARNING: could not clone git@no-such-host.invalid:me/my-repo.git into /workspaces/my-repo: ssh: Could not resolve hostname no-such-host.invalid"' \
  -e DEV_REPO_URL=git@no-such-host.invalid:me/my-repo.git --entrypoint ""

check "dev-doctor accepts an origin that differs only by .git and a trailing /, and warns on another one" in_image '
  git clone -q "$DEV_REPO_URL" /workspaces/my-repo || exit 1
  out=$(DEV_REPO_URL=file:///srv/my-repo/ dev-doctor --warn-only); echo "$out" | grep workspace
  echo "$out" | grep -qF "OK   workspace /workspaces/my-repo is a clone of file:///srv/my-repo/" || exit 1
  git -C /workspaces/my-repo remote set-url origin https://example.com/other/my-repo.git
  out=$(dev-doctor --warn-only); echo "$out" | grep -A1 workspace
  echo "$out" | grep -qF "WARN workspace /workspaces/my-repo has origin https://example.com/other/my-repo.git, not DEV_REPO_URL ($DEV_REPO_URL)" &&
  echo "$out" | grep -qF "remote set-url origin $DEV_REPO_URL"' \
  -e DEV_REPO_URL="$REPO_URL" -v "$remote:/srv" --entrypoint ""
check "dev-doctor warns when headless Claude would run outside a repo with no DEV_REPO_URL, but not on the desktop" in_image '
  out=$(dev-doctor --warn-only); echo "$out" | grep -A1 "Claude runs"
  echo "$out" | grep -qF "WARN Claude runs in /home/node, which is not a git repository, and DEV_REPO_URL is not set" &&
  ! DEV_DESKTOP=1 dev-doctor --warn-only | grep -q "Claude runs in"' \
  --entrypoint ""

# The login handoff: a private repo, served over git's smart HTTP by a server
# in the container that answers 401 to a request without credentials. With no
# gh login yet, dev-init's clone waits for one; once the stub gh login is
# approved (its setup-git gives git a credential), dev-login watch clones the
# repo, and Claude moves into it at its next start.
GIT_SERVER='const { spawn } = require("child_process");
require("http").createServer((q, r) => {
  if (!q.headers.authorization) { r.writeHead(401, { "WWW-Authenticate": "Basic realm=\"git\"" }); return r.end(); }
  const u = new URL(q.url, "http://x");
  const p = spawn("git", ["http-backend"], { env: { ...process.env, GIT_PROJECT_ROOT: "/srv", GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1), REQUEST_METHOD: q.method, REMOTE_USER: "stub",
    CONTENT_TYPE: q.headers["content-type"] || "", HTTP_CONTENT_ENCODING: q.headers["content-encoding"] || "",
    HTTP_GIT_PROTOCOL: q.headers["git-protocol"] || "" } });
  q.pipe(p.stdin);
  let head = Buffer.alloc(0), body = false;
  p.stdout.on("data", (d) => {
    if (body) return r.write(d);
    head = Buffer.concat([head, d]);
    const i = head.indexOf("\r\n\r\n");
    if (i < 0) return;
    let status = 200;
    for (const l of head.subarray(0, i).toString().split("\r\n")) {
      const k = l.slice(0, l.indexOf(":")), v = l.slice(l.indexOf(":") + 1).trim();
      if (k.toLowerCase() === "status") status = parseInt(v, 10); else r.setHeader(k, v);
    }
    r.writeHead(status);
    r.write(head.subarray(i + 4));
    body = true;
  });
  p.stdout.on("end", () => r.end());
}).listen(8418);'
HTTP_URL=http://127.0.0.1:8418/my-repo.git
c=$(run_bg -e STUB="$STUB" -e STUB_GH="$STUB_GH" -e GIT_SERVER="$GIT_SERVER" -e DEV_LOGIN_TOOLS=gh \
  -e DEV_REPO_URL="$HTTP_URL" -e DEV_REMOTE_CONTROL_POLL=1 -v "$remote:/srv" --entrypoint /usr/bin/tini "$IMAGE" -- \
  bash -c "(node -e \"\$GIT_SERVER\" &) && sleep 1 && touch /tmp/logged-in && $WITH_STUB && dev-init; exec dev-remote-control")
check "a private repo with no git credential: Claude still starts, and the clone waits for a GitHub login" bash -c "
  for _ in \$(seq 30); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker logs '$c' 2>&1 | grep -A1 'dev-init: WARNING: could not clone'
  docker logs '$c' 2>&1 | grep -qF \"dev-init: WARNING: could not clone $HTTP_URL into /workspaces/my-repo: fatal: could not read Username for 'http://127.0.0.1:8418': terminal prompts disabled\" &&
  docker logs '$c' 2>&1 | grep -qF 'dev-init:   Waiting for a GitHub login' &&
  [ \"\$(docker exec '$c' cat /tmp/claude-starts)\" = '/home/node --remote-control my-repo' ] &&
  ! docker exec '$c' test -e /workspaces/my-repo"
docker exec "$c" touch /tmp/gh-approve
check "once gh is logged in, dev-login watch clones the repo" bash -c "
  for _ in \$(seq 40); do docker logs '$c' 2>&1 | grep -q 'dev-init: cloned' && break; sleep 1; done
  docker logs '$c' 2>&1 | grep -E 'dev-login|dev-init: cloned'
  docker logs '$c' 2>&1 | grep -qF 'dev-login: gh is logged in - cloning the workspace repo (dev-init --repo)' &&
  docker logs '$c' 2>&1 | grep -qxF 'dev-init: cloned $HTTP_URL into /workspaces/my-repo' &&
  [ \"\$(docker exec '$c' git -C /workspaces/my-repo rev-parse HEAD)\" = '$new_main' ]"
docker exec "$c" touch /tmp/claude-exit
check "after the clone, Claude's next start is in the repo" bash -c "
  for _ in \$(seq 20); do docker logs '$c' 2>&1 | grep -q 'Claude exited' && break; sleep 1; done
  docker exec '$c' rm -f /tmp/claude-exit
  for _ in \$(seq 20); do [ \"\$(docker exec '$c' grep -c . /tmp/claude-starts)\" -ge 2 ] && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts
  [ \"\$(docker exec '$c' sed -n 2p /tmp/claude-starts)\" = '/workspaces/my-repo --remote-control my-repo' ]"
docker rm -f "$c" >/dev/null

echo "== 13. the workspace repo's Claude plugins"

# A stub claude for `claude plugin`: it records each call (its directory and
# arguments) in /tmp/plugin-calls and keeps its state as files in
# /tmp/plugin-state - mkt-<name> for a known marketplace, inst-<id> for an
# installed plugin. `marketplace add <source>` names the marketplace after the
# source's last path part (without #ref and .git) and fails for a source
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
    n="${3%%#*}"; n="${n%.git}"; n="${n##*/}"
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

echo
echo "$PASSES passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ]
