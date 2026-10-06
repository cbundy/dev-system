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
  # fake gh: reports the PR mergeability from a controllable marker file, so
  # tests can flip a branch between mergeable and conflicting without a real
  # PR; a "gh-fail" marker simulates gh being unreachable/erroring
  cat > "$tmpdir/gh" <<'\''EOF'\''
#!/bin/sh
[ ! -e "$(dirname "$0")/gh-fail" ] || exit 1
[ "$1" = pr ] && [ "$2" = view ] || exit 1
cat "$(dirname "$0")/pr-status.txt" 2>/dev/null || echo "MERGEABLE CLEAN"
EOF
  chmod +x "$tmpdir/gh"
  echo "MERGEABLE CLEAN" > "$tmpdir/pr-status.txt"
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
  # the branch head, with GitHub reporting the PR mergeable, fires merge-ready
  watch | grep -qx "merge-ready feat/watched RUNMERGE head=$run_head"
  # same run, but GitHub now reports the PR conflicting: green local steps
  # and checks are not enough, this fires the distinct conflict event
  echo "CONFLICTING DIRTY" > "$tmpdir/pr-status.txt"
  watch | grep -qx "conflict feat/watched RUNMERGE head=$run_head"
  echo "MERGEABLE CLEAN" > "$tmpdir/pr-status.txt"
  # gh erroring (rate limit, offline, no PR yet) is treated as not-yet-known:
  # no crash, and merge-ready/conflict does not fire until gh answers again
  touch "$tmpdir/gh-fail"
  out=$( (cd "$tmpdir/repo" && PATH="$tmpdir:$PATH" NO_MISTAKES_HOME="$tmpdir/nm" timeout 3 \
    /usr/local/share/callum-tools/pipeline-watch.sh --branches feat/watched,feat/other) || true)
  [ -z "$out" ]
  rm -f "$tmpdir/gh-fail"
  # a worktree mapped to the branch with a local commit the run never gated
  # (the stale-base fixer shape): origin still matches, the worktree does not
  g clone -q "$tmpdir/origin.git" "$tmpdir/wt" 2>/dev/null
  g -C "$tmpdir/wt" checkout -q feat/watched
  watch --worktree "feat/watched=$tmpdir/wt" | grep -qx "merge-ready feat/watched RUNMERGE head=$run_head"
  g -C "$tmpdir/wt" commit -q --allow-empty -m fix
  wt_head=$(g -C "$tmpdir/wt" rev-parse HEAD)
  watch --worktree "feat/watched=$tmpdir/wt" |
    grep -qx "head-mismatch feat/watched RUNMERGE run=$run_head branch=$run_head worktree=$wt_head head=$run_head"
  # origin moved past the run head: fetched fresh, so reported even though
  # the local remote-tracking ref is stale
  g -C "$tmpdir/wt" push -q origin feat/watched
  watch | grep -qx "head-mismatch feat/watched RUNMERGE run=$run_head branch=$wt_head head=$run_head"
  # a newer parked rerun on the same branch outranks the older green run
  mkdir -p "$tmpdir/nm/logs/RUNPARK"
  touch -d "2026-01-01 00:02" "$tmpdir/nm/logs/RUNPARK"
  watch | grep -qx "parked feat/watched RUNPARK head=unknown"
  # --known baseline: a fingerprint matching what was already reported
  # suppresses the re-fire (safe to restart the watcher after handling it)
  out=$( (cd "$tmpdir/repo" && PATH="$tmpdir:$PATH" NO_MISTAKES_HOME="$tmpdir/nm" timeout 3 \
    /usr/local/share/callum-tools/pipeline-watch.sh --branches feat/watched,feat/other \
    --known "feat/watched=parked:unknown") || true)
  [ -z "$out" ]
  # a baseline for a different head, or a different state, still fires -
  # only an exact fingerprint match is suppressed
  watch --known "feat/watched=parked:deadbeef" | grep -qx "parked feat/watched RUNPARK head=unknown"
  watch --known "feat/watched=merge-ready:$run_head" | grep -qx "parked feat/watched RUNPARK head=unknown"
  # nothing actionable + --deadline elapses = deadman heartbeat
  PATH="$tmpdir:$PATH" NO_MISTAKES_HOME="$tmpdir/nm" PIPELINE_WATCH_INTERVAL=1 timeout 10 \
    /usr/local/share/callum-tools/pipeline-watch.sh --branches feat/quiet --deadline 1 |
    grep -qx "timeout"
'
# shellcheck disable=SC2016 # single-quoted on purpose: the script expands in the inner bash -lc
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
check "codex model pinned in global config" bash -lc "grep -A3 '^agent_args_override:' ~/.no-mistakes/config.yaml | grep -q gpt-6.1-sol"
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
