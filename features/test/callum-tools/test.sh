#!/bin/bash
# Default-scenario test for the callum-tools feature: all three tools
# installed. Runs inside a container built with the feature applied;
# postCreate lifecycle hooks have already run by the time this executes.
set -e

# shellcheck disable=SC1091 # provided by the devcontainer CLI's test harness at run time
source dev-container-features-test-lib

check "no-mistakes on PATH" bash -lc "command -v no-mistakes"
check "treehouse on PATH" bash -lc "command -v treehouse"
check "claude CLI on PATH" bash -lc "command -v claude"
check "setup script staged" test -x /usr/local/share/callum-tools/setup.sh
# cbundy/dev-system#21: `claude update` replaces the @anthropic-ai package
# tree and the bin/claude symlink in place, as the remote user with no sudo.
# If the npm global prefix (or any directory on the way down to those
# entries) is not writable by the remote user, install.sh's defensive chown
# did not do its job - assert every path an update touches is writable.
# shellcheck disable=SC2016 # single-quoted on purpose: the script expands in the inner bash -lc
check "npm global prefix is writable by the remote user (claude update path)" bash -lc '
  set -e
  prefix=$(npm prefix -g)
  test -w "$prefix"
  test -w "$prefix/lib/node_modules"
  test -w "$prefix/lib/node_modules/@anthropic-ai"
  test -w "$prefix/lib/node_modules/@anthropic-ai/claude-code"
  test -w "$prefix/bin"
  # the symlink entry itself, not its target, must be replaceable
  test -L "$prefix/bin/claude"
  rm -f "$prefix/bin/.callum-tools-write-probe" 2>/dev/null || true
  : > "$prefix/bin/.callum-tools-write-probe"
  rm -f "$prefix/bin/.callum-tools-write-probe"
'
# shellcheck disable=SC2016 # single-quoted on purpose: the script expands in the inner bash -lc
check "queue watcher fires only on a ready-set delta" bash -lc '
  set -e
  test -x /usr/local/share/callum-tools/queue-watch.sh
  tmpdir=$(mktemp -d)
  trap "rm -rf \"$tmpdir\"" EXIT
  # queue-watch lists through callum-flow-issue-read (cbundy/dev-system#310);
  # a stub reader prints the issue numbers in queue.txt in its list shape
  cat > "$tmpdir/reader" <<'\''EOF'\''
#!/bin/sh
tr "," "\n" < "$(dirname "$0")/queue.txt" |
  jq -R -s -c "split(\"\n\") | map(select(. != \"\") | {number: tonumber}) | {issues: .}"
EOF
  chmod +x "$tmpdir/reader"
  export CALLUM_FLOW_ISSUE_READ_BIN="$tmpdir/reader"
  # queue matches the baseline: no fire (killed by timeout, no output)
  printf "305" > "$tmpdir/queue.txt"
  out=$(PATH="$tmpdir:$PATH" QUEUE_WATCH_INTERVAL=1 timeout 3 \
    /usr/local/share/callum-tools/queue-watch.sh --repo o/r --label ready --known 305 || true)
  [ -z "$out" ]
  # a new issue enters the set: fires with the delta
  printf "305,307" > "$tmpdir/queue.txt"
  PATH="$tmpdir:$PATH" QUEUE_WATCH_INTERVAL=1 timeout 10 \
    /usr/local/share/callum-tools/queue-watch.sh --repo o/r --label ready --known 305 |
    grep -qx "queue-changed known=305 now=305,307"
'
check "codex model pinned in global config" bash -lc "grep -A3 '^agent_config:' ~/.no-mistakes/config.yaml | grep -q gpt-6.1-sol"
# shellcheck disable=SC2016 # single-quoted on purpose: the script expands in the inner bash -lc
check "no-mistakes auto-recovery runs daemon start + init when unregistered" bash -lc '
  set -e
  test -x /usr/local/share/callum-tools/recover-no-mistakes.sh
  tmpdir=$(mktemp -d)
  trap "rm -rf \"$tmpdir\"" EXIT
  fakebin="$tmpdir/fakebin"
  mkdir -p "$fakebin"
  cat > "$fakebin/no-mistakes" <<'\''EOF'\''
#!/bin/sh
echo "$*" >> "$FAKE_NM_LOG"
if [ "${1:-}" = "status" ]; then
  if [ "${FAKE_NM_REGISTERED:-false}" = "true" ]; then
    echo "    repo:  /fake/repo"
  else
    echo "repo not initialized (run '\''no-mistakes init'\'' first)"
  fi
fi
exit 0
EOF
  chmod +x "$fakebin/no-mistakes"
  g() { git -c user.name=t -c user.email=t@t "$@"; }
  # unregistered + .no-mistakes.yaml present -> recovers
  g init -q "$tmpdir/unreg"
  echo "commands: {}" > "$tmpdir/unreg/.no-mistakes.yaml"
  ( cd "$tmpdir/unreg" && PATH="$fakebin:$PATH" FAKE_NM_LOG="$tmpdir/log1" FAKE_NM_REGISTERED=false \
    /usr/local/share/callum-tools/recover-no-mistakes.sh )
  grep -qx "daemon start" "$tmpdir/log1"
  grep -qx "init" "$tmpdir/log1"
  # already registered -> no-op, idempotent
  g init -q "$tmpdir/reg"
  echo "commands: {}" > "$tmpdir/reg/.no-mistakes.yaml"
  ( cd "$tmpdir/reg" && PATH="$fakebin:$PATH" FAKE_NM_LOG="$tmpdir/log2" FAKE_NM_REGISTERED=true \
    /usr/local/share/callum-tools/recover-no-mistakes.sh )
  ! grep -qx "daemon start" "$tmpdir/log2"
  ! grep -qx "init" "$tmpdir/log2"
  # no .no-mistakes.yaml -> no-op, no-mistakes never invoked
  g init -q "$tmpdir/noyaml"
  : > "$tmpdir/log3"
  ( cd "$tmpdir/noyaml" && PATH="$fakebin:$PATH" FAKE_NM_LOG="$tmpdir/log3" FAKE_NM_REGISTERED=false \
    /usr/local/share/callum-tools/recover-no-mistakes.sh )
  [ ! -s "$tmpdir/log3" ]
'

reportResults
