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
    "  head_sha: $(cat "$(dirname "$0")/run-head.txt")" \
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
  # the watcher runs inside the gated repo: a clone whose origin has the branch
  g() { git -c user.name=t -c user.email=t@t -c init.defaultBranch=main "$@"; }
  g init -q --bare "$tmpdir/origin.git"
  g clone -q "$tmpdir/origin.git" "$tmpdir/repo" 2>/dev/null
  g -C "$tmpdir/repo" checkout -q -b feat/watched
  g -C "$tmpdir/repo" commit -q --allow-empty -m gated
  g -C "$tmpdir/repo" push -q origin feat/watched
  g -C "$tmpdir/repo" rev-parse HEAD > "$tmpdir/run-head.txt"
  run_head=$(cat "$tmpdir/run-head.txt")
  watch() {
    (cd "$tmpdir/repo" && PATH="$tmpdir:$PATH" NO_MISTAKES_HOME="$tmpdir/nm" timeout 10 \
      /usr/local/share/callum-tools/pipeline-watch.sh --branches feat/watched,feat/other "$@")
  }
  # a run in its CI-monitoring tail (status still `running`) whose head is
  # the branch head fires merge-ready
  watch | grep -qx "merge-ready feat/watched RUNMERGE"
  # a worktree mapped to the branch with a local commit the run never gated
  # (the stale-base fixer shape): origin still matches, the worktree does not
  g clone -q "$tmpdir/origin.git" "$tmpdir/wt" 2>/dev/null
  g -C "$tmpdir/wt" checkout -q feat/watched
  watch --worktree "feat/watched=$tmpdir/wt" | grep -qx "merge-ready feat/watched RUNMERGE"
  g -C "$tmpdir/wt" commit -q --allow-empty -m fix
  wt_head=$(g -C "$tmpdir/wt" rev-parse HEAD)
  watch --worktree "feat/watched=$tmpdir/wt" |
    grep -qx "head-mismatch feat/watched RUNMERGE run=$run_head branch=$run_head worktree=$wt_head"
  # origin moved past the run head: fetched fresh, so reported even though
  # the local remote-tracking ref is stale
  g -C "$tmpdir/wt" push -q origin feat/watched
  watch | grep -qx "head-mismatch feat/watched RUNMERGE run=$run_head branch=$wt_head"
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
