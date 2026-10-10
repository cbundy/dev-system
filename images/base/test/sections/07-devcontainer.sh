# shellcheck shell=bash
# shellcheck disable=SC2016,SC2154
#
# Section 7 of the base image container tests. Sourced by test.sh after lib.sh, which
# provides IMAGE, RUN_ID, SECRET, check, in_image and the rest; never run directly.

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

  # The five per-repo mounts exactly as the synced base-image template ships
  # them (#78), with $RUN_ID in place of the dev-system prefix.
  template="$(dirname "$0")/../../../templates/.devcontainer/devcontainer.base-image.json"
  template_mounts=$(grep -F '"target": "/persist/' "$template" | sed "s/\"dev-system-/\"$RUN_ID-/")
  check "the base-image template's five per-repo mounts are found" \
    [ "$(printf '%s\n' "$template_mounts" | grep -cF "\"$RUN_ID-\${devcontainerId}-")" = 5 ]

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
