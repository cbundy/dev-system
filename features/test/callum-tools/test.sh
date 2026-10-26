#!/bin/bash
# Default-scenario test for the callum-tools feature: both tools
# installed. Runs inside a container built with the feature applied;
# postCreate lifecycle hooks have already run by the time this executes.
set -e

# shellcheck disable=SC1091 # provided by the devcontainer CLI's test harness at run time
source dev-container-features-test-lib

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
  # queue-watch lists through fabriek-issue-read (cbundy/dev-system#310);
  # a stub reader prints the issue numbers in queue.txt in its list shape
  cat > "$tmpdir/reader" <<'\''EOF'\''
#!/bin/sh
tr "," "\n" < "$(dirname "$0")/queue.txt" |
  jq -R -s -c "split(\"\n\") | map(select(. != \"\") | {number: tonumber}) | {issues: .}"
EOF
  chmod +x "$tmpdir/reader"
  export FABRIEK_ISSUE_READ_BIN="$tmpdir/reader"
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

reportResults
