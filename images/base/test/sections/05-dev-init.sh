# shellcheck shell=bash
# shellcheck disable=SC2016,SC2154
#
# Section 5 of the base image container tests. Sourced by test.sh after lib.sh, which
# provides IMAGE, RUN_ID, SECRET, check, in_image and the rest; never run directly.

echo "== 5. dev-init"
vol=$(docker volume create --label "$RUN_ID")
check "dev-init runs twice cleanly on an empty volume at /persist" in_image '
  set -e
  dev-init; dev-init
  grep -q "^sandbox_mode = \"danger-full-access\"" /persist/codex/config.toml
  [ "$(grep -c "^sandbox_mode" /persist/codex/config.toml)" = 1 ]' \
  -v "$vol:/persist" --entrypoint ""
check "dev-restart-self is on PATH and dev-init with no marker still exits 0 and makes no request" in_image '
  set -e
  command -v dev-restart-self
  dev-restart-self --resume
  dev-init >/dev/null 2>&1' \
  -v "$vol:/persist" --entrypoint ""
check "dev-init on an empty volume mounted at /persist leaves node-owned subdirs" in_image '
  for d in claude codex gh agentsview; do [ "$(stat -c %u "/persist/$d")" = 1000 ] || exit 1; done' \
  -v "$vol:/persist"
check "dev-init seeds installMethod into an existing .claude.json without touching other keys" in_image '
  set -e
  echo "{\"keep\":1}" > /persist/claude/.claude.json
  dev-init >/dev/null 2>&1; dev-init >/dev/null 2>&1
  # claude itself (via dev-doctor) adds keys too, so only these two are compared
  [ "$(jq -c "{keep, installMethod}" /persist/claude/.claude.json)" = "{\"keep\":1,\"installMethod\":\"native\"}" ]
  [ "$(stat -c %a /persist/claude/.claude.json)" = 600 ]'
# Claude's login directory (CLAUDE_SECURESTORAGE_CONFIG_DIR) shared by two
# containers, each with its own CLAUDE_CONFIG_DIR volume, as Coder's "shared"
# Claude login sets it up: the first to start moves its older login in; the
# second keeps its own, unused. Without the variable nothing moves.
authvol=$(docker volume create --label "$RUN_ID")
cfga=$(docker volume create --label "$RUN_ID")
cfgb=$(docker volume create --label "$RUN_ID")
CREDS='{"claudeAiOauth":{"accessToken":"sk-ant-oat01-first","refreshToken":"r","expiresAt":4102444800000,"scopes":["user:inference"],"subscriptionType":"max"}}'
check "dev-init moves an older Claude login into an empty shared login dir, which Claude then reads" in_image '
  set -e
  printf "%s\n" "$CREDS" > /persist/claude/.credentials.json
  dev-init >/dev/null 2>&1
  [ ! -e /persist/claude/.credentials.json ]
  [ "$(stat -c %u:%a /persist/claude-auth/.credentials.json)" = 1000:600 ]
  ! ls -A /persist/claude-auth | grep "^\.credentials\.json\."
  claude auth status --json | jq -e ".loggedIn == true and .authMethod == \"claude.ai\""' \
  -e CREDS="$CREDS" -e CLAUDE_SECURESTORAGE_CONFIG_DIR=/persist/claude-auth \
  -v "$cfga:/persist/claude" -v "$authvol:/persist/claude-auth" --entrypoint ""
check "dev-init in a second container leaves the shared login and its own older one as they are" in_image '
  set -e
  printf "{\"claudeAiOauth\":{\"accessToken\":\"sk-ant-oat01-second\"}}\n" > /persist/claude/.credentials.json
  dev-init >/dev/null 2>&1
  grep -q sk-ant-oat01-second /persist/claude/.credentials.json
  grep -q sk-ant-oat01-first /persist/claude-auth/.credentials.json' \
  -e CLAUDE_SECURESTORAGE_CONFIG_DIR=/persist/claude-auth \
  -v "$cfgb:/persist/claude" -v "$authvol:/persist/claude-auth" --entrypoint ""
check "without CLAUDE_SECURESTORAGE_CONFIG_DIR (a private login) dev-init leaves the Claude login where it is" in_image '
  set -e
  printf "%s\n" "$CREDS" > /persist/claude/.credentials.json
  dev-init >/dev/null 2>&1
  grep -q sk-ant-oat01-first /persist/claude/.credentials.json
  [ ! -e /persist/claude-auth/.credentials.json ]
  claude auth status --json | jq -e ".loggedIn == true"' \
  -e CREDS="$CREDS" --entrypoint ""
check "dev-init keeps an existing top-level sandbox_mode and ignores one inside a table" in_image '
  set -e
  printf "sandbox_mode = \"workspace-write\"\n" > /persist/codex/config.toml
  dev-init >/dev/null 2>&1
  [ "$(cat /persist/codex/config.toml)" = "sandbox_mode = \"workspace-write\"" ]
  printf "[profiles.x]\nsandbox_mode = \"read-only\"\n" > /persist/codex/config.toml
  dev-init >/dev/null 2>&1
  head -n 2 /persist/codex/config.toml | grep -qx "sandbox_mode = \"danger-full-access\""
  grep -qx "\[profiles.x\]" /persist/codex/config.toml'
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
# A volume that predates a contract directory (cbundy/dev-system#269): /persist
# is root-owned 0755 and holds only the older tool dirs, so node cannot mkdir the
# newer ones. Docker copies the image's /persist into an EMPTY volume only, so
# the seed makes it non-empty first, then drops the two newest dirs and hands
# /persist to root - exactly what a Coder workspace from before #218 has.
oldvol=$(docker volume create --label "$RUN_ID")
docker run --rm --user root -v "$oldvol:/persist" "$IMAGE" bash -c '
  rm -rf /persist/events /persist/dev-restart-self
  for t in claude codex gh agentsview; do touch /persist/$t/.seed; done
  chown root:root /persist && chmod 0755 /persist'
check "dev-init creates the missing contract dirs as 1000:1000 0700 on a volume that predates them, and a second run is quiet" in_image '
  out=$( { dev-init; echo "rc=$?"; } 2>&1 ); echo "$out"
  echo "$out" | grep -qx "rc=0" || exit 1
  for d in events dev-restart-self; do
    [ "$(stat -c %u:%g:%a /persist/$d)" = 1000:1000:700 ] || { echo "/persist/$d: $(stat -c %u:%g:%a /persist/$d)"; exit 1; }
  done
  callum-flow-event ready --issue 1 --repo a/b 2>&1 | tee /tmp/ev.out
  ! grep -q "event not recorded" /tmp/ev.out && [ "$(cat /persist/events/factory/*.jsonl | wc -l)" = 1 ] || exit 1
  out2=$( { dev-init; echo "rc=$?"; } 2>&1 ); echo "$out2"
  echo "$out2" | grep -qx "rc=0" && ! echo "$out2" | grep -q "dev-init: WARNING: /persist"' \
  -v "$oldvol:/persist" --entrypoint ""
# Existing dirs are never chowned, but a node-owned looser one is tightened.
check "dev-init tightens a node-owned looser contract dir to 0700 and leaves the rest alone" in_image '
  chmod 0755 /persist/events
  dev-init >/dev/null 2>&1
  [ "$(stat -c %u:%g:%a /persist/events)" = 1000:1000:700 ]' \
  -v "$oldvol:/persist" --entrypoint ""
# No sudo (Kubernetes with no-new-privileges, say): one WARNING per dir naming
# the fix, and the start still succeeds.
nosudovol=$(docker volume create --label "$RUN_ID")
docker run --rm --user root -v "$nosudovol:/persist" "$IMAGE" bash -c '
  rm -rf /persist/events /persist/dev-restart-self
  for t in claude codex gh agentsview; do touch /persist/$t/.seed; done
  chown root:root /persist && chmod 0755 /persist'
check "dev-init warns with the exact fix per missing dir and exits 0 when sudo is unusable" bash -c "
  out=\$(docker run --rm --entrypoint '' --security-opt no-new-privileges -v '$nosudovol:/persist' '$IMAGE' bash -c 'dev-init; echo rc=\$?' 2>&1)
  echo \"\$out\"
  echo \"\$out\" | grep -qx 'rc=0' &&
  for d in events dev-restart-self; do
    echo \"\$out\" | grep -qF \"dev-init: WARNING: /persist/\$d is missing and cannot be created\" &&
    echo \"\$out\" | grep -qF \"sudo install -d -o 1000 -g 1000 -m 0700 /persist/\$d\" &&
    echo \"\$out\" | grep -q \"FAIL \$d state dir\" || exit 1
  done"

# The start-up warning for /persist dirs with no volume behind them (#78):
# loud, naming each one, but never failing the start.
check "dev-init warns (exit 0) naming every /persist dir with no volume, only those" bash -c "
  out=\$(docker run --rm --entrypoint '' '$IMAGE' bash -c 'dev-init; echo rc=\$?' 2>&1)
  echo \"\$out\"
  echo \"\$out\" | grep -qx 'rc=0' &&
  echo \"\$out\" | grep -qF 'dev-init: WARNING: no volume behind /persist/claude /persist/codex /persist/gh /persist/agentsview /persist/events - ' &&
  ! echo \"\$out\" | grep -E 'no volume behind.*(dev-restart-self)' &&
  echo \"\$out\" | grep -qF 'npx callum-dev update --devcontainer base-image' &&
  out=\$(docker run --rm --entrypoint '' -v \"\$(docker volume create --label '$RUN_ID'):/persist/claude\" '$IMAGE' dev-init 2>&1) &&
  echo \"\$out\" | grep -qF 'dev-init: WARNING: no volume behind /persist/codex /persist/gh /persist/agentsview /persist/events - '"
check "dev-init: no volume warning with one volume for all of /persist (the k8s / Coder shape)" in_image '
  out=$(dev-init 2>&1); echo "$out"
  ! echo "$out" | grep -q "no volume behind"' \
  -v "$vol:/persist" --entrypoint ""
check "dev-init: no volume warning with a volume per /persist dir (the devcontainer shape)" bash -c "
  args=()
  for t in $PERSIST_NAMES; do
    args+=(-v \"\$(docker volume create --label '$RUN_ID'):/persist/\$t\")
  done
  out=\$(docker run --rm --entrypoint '' \"\${args[@]}\" '$IMAGE' dev-init 2>&1)
  echo \"\$out\"
  ! echo \"\$out\" | grep -q 'no volume behind'"

# cbundy/dev-system#101: with no systemd in the container, systemctl must fail,
# so a tool that installs a user service falls back to running its daemon
# itself at once instead of waiting on a unit that never starts.
check "systemctl fails without systemd, and no build-time systemd unit ships" in_image '
  out=$(systemctl --user daemon-reload 2>&1); rc=$?; echo "$out"
  [ $rc -ne 0 ] && echo "$out" | grep -q "systemd is not running" && [ ! -e ~/.config/systemd ]' \
  --entrypoint ""

# The worker heartbeat (#466): with a URL configured dev-init starts heartbeat-loop, which holds its lock and
# writes its pidfile even when the database is unreachable (the beat just fails and retries).
check "dev-init starts the heartbeat loop when a URL is configured: its lock is held and its pidfile is written" in_image '
  out=$(dev-init 2>&1); echo "$out"
  echo "$out" | grep -qF "dev-init: started worker heartbeat (log: /tmp/dev-heartbeat.log)" || exit 1
  for _ in $(seq 1 20); do [ -s /tmp/dev-heartbeat.pid ] && break; sleep 0.5; done
  ! flock -n /tmp/dev-heartbeat.lock true && [ -s /tmp/dev-heartbeat.pid ] && kill -0 "$(cat /tmp/dev-heartbeat.pid)"' \
  -e AGENTSVIEW_PG_URL=postgres://u:p@no-such-host.invalid/db --entrypoint ""
check "dev-init starts no heartbeat loop without a URL" in_image '
  dev-init >/dev/null 2>&1; flock -n /tmp/dev-heartbeat.lock true && [ ! -e /tmp/dev-heartbeat.pid ]' --entrypoint ""

# The old event-push-loop is gone from dev-init (#1143): callum-flow-event writes no old log lines.
check "dev-init starts no event-push-loop even with a database URL configured" in_image '
  out=$(dev-init 2>&1); echo "$out"
  ! echo "$out" | grep -qF "started factory event push (log:" && flock -n /tmp/dev-event-push.lock true &&
  [ ! -e /tmp/dev-event-push.log ]' \
  -e AGENTSVIEW_PG_URL=postgres://u:p@no-such-host.invalid/db --entrypoint ""

# The new factory event log push (#740): a writer URL (a closed port is enough) starts factory-event-push-loop.
check "dev-init starts the factory event push loop when FACTORY_DB_WRITER_URL is set: its lock is held" in_image '
  out=$(dev-init 2>&1); echo "$out"
  echo "$out" | grep -qF "dev-init: started factory event push (new log) (log: /tmp/dev-factory-event-push.log)" || exit 1
  ! flock -n /tmp/dev-factory-event-push.lock true' \
  -e FACTORY_DB_WRITER_URL=postgres://w:p@127.0.0.1:1/db --entrypoint ""
check "dev-init starts no factory event push loop without a writer URL" in_image '
  out=$(env -u FACTORY_DB_WRITER_URL dev-init 2>&1); echo "$out"
  ! echo "$out" | grep -q "factory event push (new log)" && flock -n /tmp/dev-factory-event-push.lock true' --entrypoint ""
