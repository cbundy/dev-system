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
check "pipeline watcher detects actionable runs" bash -lc '
  set -e
  test -x /usr/local/share/callum-tools/pipeline-watch.sh
  tmpdir=$(mktemp -d)
  trap "rm -rf \"$tmpdir\"" EXIT
  mkdir -p "$tmpdir/nm/logs/RUNMERGE" "$tmpdir/nm/logs/RUNOTHER"
  echo "all CI checks passed - still monitoring until merged or closed" > "$tmpdir/nm/logs/RUNMERGE/ci.log"
  touch -d "2026-01-01 00:00" "$tmpdir/nm/logs/RUNMERGE"
  touch -d "2026-01-01 00:01" "$tmpdir/nm/logs/RUNOTHER"
  cat > "$tmpdir/no-mistakes" <<'\''EOF'\''
#!/bin/sh
[ "$1" = "axi" ] && [ "$2" = "status" ] && [ "$3" = "--run" ] || exit 1
case "$4" in
RUNOTHER)
  printf "%s\n" "current_branch: master" "other_branch_run:" \
    "  id: \"RUNOTHER\"" "  branch: feat/unrelated" "  status: running"
  ;;
RUNMERGE)
  printf "%s\n" "current_branch: master" "other_branch_run:" \
    "  id: \"RUNMERGE\"" "  branch: feat/watched" "  status: running" \
    "  steps[9]{step,status,findings,duration_ms}:" \
    "    push,completed,0,1" "    ci,running,0,1"
  ;;
RUNPARK)
  printf "%s\n" "current_branch: master" "other_branch_run:" \
    "  id: \"RUNPARK\"" "  branch: feat/watched" "  status: running" \
    "  steps[9]{step,status,findings,duration_ms}:" \
    "    test,awaiting_approval,1,1" "    document,pending,0,0"
  ;;
*) exit 1 ;;
esac
EOF
  chmod +x "$tmpdir/no-mistakes"
  watch() {
    PATH="$tmpdir:$PATH" NO_MISTAKES_HOME="$tmpdir/nm" timeout 10 \
      /usr/local/share/callum-tools/pipeline-watch.sh --branches feat/watched,feat/other
  }
  # a run in its CI-monitoring tail (status still `running`) fires merge-ready
  watch | grep -qx "merge-ready feat/watched RUNMERGE"
  # a newer parked rerun on the same branch outranks the older green run
  mkdir -p "$tmpdir/nm/logs/RUNPARK"
  touch -d "2026-01-01 00:02" "$tmpdir/nm/logs/RUNPARK"
  watch | grep -qx "parked feat/watched RUNPARK"
  # nothing actionable + --deadline elapses = deadman heartbeat
  PATH="$tmpdir:$PATH" NO_MISTAKES_HOME="$tmpdir/nm" PIPELINE_WATCH_INTERVAL=1 timeout 10 \
    /usr/local/share/callum-tools/pipeline-watch.sh --branches feat/quiet --deadline 1 |
    grep -qx "timeout"
'
check "queue watcher fires only on a ready-set delta" bash -lc '
  set -e
  test -x /usr/local/share/callum-tools/queue-watch.sh
  tmpdir=$(mktemp -d)
  trap "rm -rf \"$tmpdir\"" EXIT
  cat > "$tmpdir/gh" <<'\''EOF'\''
#!/bin/sh
cat "$(dirname "$0")/queue.txt"
EOF
  chmod +x "$tmpdir/gh"
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
check "codex model pinned in global config" bash -lc "grep -A3 '^agent_args_override:' ~/.no-mistakes/config.yaml | grep -q gpt-5.6-sol"

reportResults
