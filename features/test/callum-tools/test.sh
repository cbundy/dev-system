#!/bin/bash
# Default-scenario test for the callum-tools feature: all three tools
# installed. Runs inside a container built with the feature applied;
# postCreate lifecycle hooks have already run by the time this executes.
set -e

source dev-container-features-test-lib

check "no-mistakes on PATH" bash -lc "command -v no-mistakes"
check "treehouse on PATH" bash -lc "command -v treehouse"
check "claude CLI on PATH" bash -lc "command -v claude"
check "setup script staged" test -x /usr/local/share/callum-tools/setup.sh
check "pipeline watcher detects watched terminal runs" bash -lc '
  set -e
  test -x /usr/local/share/callum-tools/pipeline-watch.sh
  tmpdir=$(mktemp -d)
  trap "rm -rf \"$tmpdir\"" EXIT
  cat > "$tmpdir/no-mistakes" <<'\''EOF'\''
#!/bin/sh
printf "%s\n" \
  "  running        feat/unrelated       deadbeef  2026-09-08 15:00" \
  "  running        feat/watched         deadbeef  2026-09-08 15:00" \
  "  checks-passed  feat/other           deadbeef  2026-09-08 15:00" \
  "  failed         feat/watched         deadbeef  2026-09-08 15:00"
EOF
  chmod +x "$tmpdir/no-mistakes"
  PATH="$tmpdir:$PATH" /usr/local/share/callum-tools/pipeline-watch.sh --branches feat/watched,feat/other |
    grep -qx "  failed         feat/watched         deadbeef  2026-09-08 15:00"
'
check "codex model pinned in global config" bash -lc "grep -A3 '^agent_args_override:' ~/.no-mistakes/config.yaml | grep -q gpt-5.6-sol"

reportResults
