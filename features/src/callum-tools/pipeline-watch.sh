#!/bin/sh
#
# Wait until a watched no-mistakes pipeline reaches an actionable state,
# print one line - "<state> <branch> <run-id>[ <detail>] head=<sha>" - and
# exit. States:
#
#   merge-ready  all local steps passed, the run's ci.log records a
#                GitHub CI pass, the run's head is the branch's real
#                head, and GitHub itself reports the PR as mergeable;
#                nothing remains but the merge guards
#   head-mismatch
#                the run would be merge-ready, but its head is not the
#                branch's head, so its green proves nothing about the
#                commit that would be merged (phantom gating). Printed as
#                "head-mismatch <branch> <run-id> run=<sha> branch=<sha>",
#                plus " worktree=<sha>" when --worktree maps the branch;
#                a SHA that could not be read prints as "unknown"
#   conflict     the run's local steps and CI are green and its head
#                matches the branch, but GitHub reports the PR itself is
#                not mergeable (mergeable=CONFLICTING or
#                mergeStateStatus=DIRTY) - e.g. an unrelated merge to the
#                base introduced a conflict after the run went green. A
#                mergeable=UNKNOWN reply (GitHub still computing it) or a
#                `gh` failure is treated as not-yet-known and fires
#                neither merge-ready nor conflict this cycle - the next
#                poll tries again
#   parked       a gate is awaiting an agent/approval and needs driving
#   failed       a step failed
#   cancelled    the run was cancelled
#   timeout      --deadline seconds elapsed with nothing actionable
#                (printed alone, no branch/run-id) - a deadman heartbeat
#                so the caller can verify run health and restart, instead
#                of needing a separate periodic tick
#
# Every fired line except `timeout` ends with " head=<sha>" (the run's
# head_sha, or "unknown" when it could not be read), so a caller can build
# the next cycle's --known baseline straight from the line it just handled.
#
# Run-level status alone cannot detect the first two: a cleanly passing
# run stays `running` through its CI-monitoring tail (up to 168h, until
# merged), and a parked gate also reports `running` at the top level. So
# each cycle probes the newest run per watched branch with
# `no-mistakes axi status --run <id>` (per-step truth) and checks the
# run's ci.log for the CI-green marker. Must be run from inside the
# gated repository, like the CLI itself.
#
# Before reporting merge-ready, the run's head_sha is compared against
# origin/<branch> (fetched fresh) and, for branches mapped with
# --worktree <branch>=<path>, against that worktree's HEAD. The worktree
# check matters: an agent that commits on a stale base and re-attaches to
# a live run leaves origin/<branch> equal to the run head while its own
# commit was never pushed or gated. Only once the head matches is GitHub
# asked for the PR's real mergeability (see `conflict` above).
#
# --known <branch>=<state>:<sha>, repeatable, is a per-branch fingerprint
# baseline - the pipeline-watch analog of queue-watch.sh's --known. Each
# cycle's fingerprint for a branch is "<state>:<head-sha>"; a branch whose
# current fingerprint matches its baseline has already been reported and
# handled, so it is not fired again - polling just continues. A branch with
# no --known entry behaves exactly as before: it fires the first time it
# becomes actionable. This makes restarting the watcher after handling an
# event safe by construction - pass back the state/head you just handled as
# the new baseline and nothing re-fires until something actually changes -
# so the watcher never needs to be disarmed to dodge a re-fire loop. That
# disarming is itself the failure mode: it silently drops coverage for
# every OTHER watched branch, not just the one that was already handled.
set -eu

usage() {
  echo "usage: pipeline-watch.sh --branches branch[,branch...] [--deadline seconds]" \
    "[--worktree branch=path]... [--known branch=state:sha]..." >&2
  exit 2
}

branches=
deadline=0
worktrees=
known=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --branches) branches=${2-}; shift 2 || usage ;;
    --deadline) deadline=${2-}; shift 2 || usage ;;
    --worktree)
      case "${2-}" in ?*=?*) ;; *) usage ;; esac
      worktrees="$worktrees$2
"
      shift 2
      ;;
    --known)
      case "${2-}" in ?*=?*) ;; *) usage ;; esac
      known="$known$2
"
      shift 2
      ;;
    *) usage ;;
  esac
done
[ -n "$branches" ] || usage

logs_dir="${NO_MISTAKES_HOME:-$HOME/.no-mistakes}/logs"

# head_check <branch> <run-sha>: empty if the run's head is the branch's
# real head, else the " run=<sha> branch=<sha>[ worktree=<sha>]" suffix for
# a head-mismatch line. Runs only once a run is otherwise merge-ready, so a
# fresh fetch is cheap and a stale remote-tracking ref can never vouch for
# a run.
head_check() {
  run_sha=$2
  branch_sha=unknown
  if git fetch --quiet origin "+refs/heads/$1:refs/remotes/origin/$1" 2>/dev/null; then
    branch_sha=$(git rev-parse --verify --quiet "refs/remotes/origin/$1^{commit}" 2>/dev/null) || branch_sha=unknown
  fi
  suffix=" run=${run_sha:-unknown} branch=$branch_sha"
  ok=
  [ -n "$run_sha" ] && [ "$run_sha" = "$branch_sha" ] && ok=1
  wt_path=$(printf '%s' "$worktrees" | awk -v b="$1" 'index($0, b "=") == 1 { print substr($0, length(b) + 2); exit }')
  if [ -n "$wt_path" ]; then
    wt_sha=$(git -C "$wt_path" rev-parse --verify --quiet 'HEAD^{commit}' 2>/dev/null) || wt_sha=unknown
    suffix="$suffix worktree=$wt_sha"
    [ "$run_sha" = "$wt_sha" ] || ok=
  fi
  [ -n "$ok" ] || printf '%s' "$suffix"
}

# pr_mergeability <branch>: prints "<mergeable> <mergeStateStatus>" from
# `gh pr view`, e.g. "MERGEABLE CLEAN" or "CONFLICTING DIRTY". Prints
# nothing on any failure (no gh on PATH, no PR yet, API error, offline) -
# callers treat missing output the same as an explicit UNKNOWN: not yet
# actionable, never a crash.
pr_mergeability() {
  gh pr view "$1" --json mergeable,mergeStateStatus \
    --jq '(.mergeable // "UNKNOWN") + " " + (.mergeStateStatus // "UNKNOWN")' 2>/dev/null || true
}

# known_fingerprint <branch>: the baseline "state:sha" passed via --known
# for this branch, or empty if none was given.
known_fingerprint() {
  printf '%s' "$known" | awk -v b="$1" 'index($0, b "=") == 1 { print substr($0, length(b) + 2); exit }'
}

n_watched=$(printf '%s\n' "$branches" | awk -F, '{print NF}')
started=$(date +%s)

while :; do
  seen=","
  n_seen=0
  # Newest run dirs first: only the most recent run per branch counts -
  # an older failed/cancelled run superseded by a rerun must not fire.
  for id in $(ls -t "$logs_dir" 2>/dev/null | head -20); do
    [ -d "$logs_dir/$id" ] || continue
    out=$(no-mistakes axi status --run "$id" 2>/dev/null) || continue
    out=$(printf '%s\n' "$out" | awk '{gsub(/\033\[[0-9;]*m/, ""); print}')
    branch=$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*branch:[[:space:]]*//p' | sed -n 1p)
    case ",$branches," in *",$branch,"*) ;; *) continue ;; esac
    case "$seen" in *",$branch,"*) continue ;; esac
    seen="$seen$branch,"
    n_seen=$((n_seen + 1))
    run_sha=$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*head_sha:[[:space:]]*//p' | sed -n 1p | tr -d '"')
    status=$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*status:[[:space:]]*//p' | sed -n 1p)
    state=
    case "$status" in
      failed | cancelled) state=$status ;;
      completed) ;; # merged or closed - nothing left for the orchestrator
      *)
        if printf '%s\n' "$out" | grep -q 'awaiting_agent\|,awaiting_approval,'; then
          state=parked
        elif grep -q 'all CI checks passed' "$logs_dir/$id/ci.log" 2>/dev/null; then
          state=merge-ready
        fi
        ;;
    esac
    detail=
    if [ "$state" = merge-ready ]; then
      detail=$(head_check "$branch" "$run_sha")
      if [ -n "$detail" ]; then
        state=head-mismatch
      else
        mstatus=$(pr_mergeability "$branch")
        mergeable_field=${mstatus%% *}
        mss_field=${mstatus#* }
        case "$mergeable_field" in
          CONFLICTING) state=conflict ;;
          MERGEABLE)
            case "$mss_field" in
              DIRTY) state=conflict ;;
            esac
            ;;
          *) state= ;; # UNKNOWN, or gh failed/missing - not yet actionable
        esac
      fi
    fi
    if [ -n "$state" ]; then
      fingerprint="$state:${run_sha:-unknown}"
      [ "$(known_fingerprint "$branch")" = "$fingerprint" ] && state=
    fi
    if [ -n "$state" ]; then
      printf '%s %s %s%s head=%s\n' "$state" "$branch" "$id" "$detail" "${run_sha:-unknown}"
      exit 0
    fi
    [ "$n_seen" -eq "$n_watched" ] && break
  done
  if [ "$deadline" -gt 0 ] && [ $(($(date +%s) - started)) -ge "$deadline" ]; then
    echo timeout
    exit 0
  fi
  sleep "${PIPELINE_WATCH_INTERVAL:-25}"
done
