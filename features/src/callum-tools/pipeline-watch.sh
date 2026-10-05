#!/bin/sh
#
# Wait until a watched no-mistakes pipeline reaches an actionable state,
# print one line - "<state> <branch> <run-id>[ <detail>] head=<sha>" - and
# exit (single-shot, the default). With --stream it never exits on an event:
# see "Stream mode" below. States:
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
#
# Stream mode (--stream, cbundy/dev-system#54) is for a harness that turns
# each stdout line of a long-running command into an event (Claude Code's
# Monitor tool). It never exits on an event, so handling one can never leave
# the session unwatched. Each poll evaluates EVERY watched branch and prints
# one line per branch whose actionable state changed since the last line
# printed for it - same line format and states as above, so the handling
# rules carry over. The per-branch "<state>:<sha>" fingerprint is tracked in
# the script, seeded from --known. A branch seen in a plainly non-actionable
# state (running with nothing to report, merged or closed) clears its
# fingerprint, so if it later returns to the same state on the same head -
# parked again at a later gate, say - that is reported as the new event it
# is. A not-yet-known mergeability (UNKNOWN, or a `gh` failure) clears
# nothing. Output is only event lines and, on a fatal error, one final
# "watcher-error <reason>" line before a non-zero exit, so a crash is never
# silent. Transient `no-mistakes` and `gh` failures skip that probe for the
# cycle. Fatal: `no-mistakes` missing from PATH (checked every cycle), `gh`
# missing or not inside a git repository (checked at start), a usage error,
# or any unexpected exit. A signal (the harness stopping the monitor) is a
# normal end and prints nothing. --deadline is rejected in stream mode: the
# harness's own monitor timeout is the heartbeat there.
#
# --interval <seconds> sets the poll interval (default: the
# PIPELINE_WATCH_INTERVAL environment variable, else 25).
set -eu

stream=
case " $* " in *" --stream "*) stream=1 ;; esac
reported=

# fatal <reason>: exit non-zero; in stream mode first print the one
# watcher-error line on stdout, the event channel.
fatal() {
  [ -z "$stream" ] || echo "watcher-error $*"
  echo "pipeline-watch.sh: $*" >&2
  reported=1
  exit 1
}

# on_exit (stream mode's EXIT trap): an unexpected non-zero exit still ends
# with a watcher-error line.
on_exit() {
  rc=$?
  [ "$rc" -eq 0 ] || [ -n "$reported" ] || echo "watcher-error exited with status $rc"
}

usage() {
  [ -z "$stream" ] || echo "watcher-error usage${1:+: $1}"
  [ -z "${1-}" ] || echo "pipeline-watch.sh: $1" >&2
  echo "usage: pipeline-watch.sh --branches branch[,branch...]" \
    "[--stream | --deadline seconds] [--interval seconds]" \
    "[--worktree branch=path]... [--known branch=state:sha]..." >&2
  reported=1
  exit 2
}

branches=
deadline=0
interval=${PIPELINE_WATCH_INTERVAL:-25}
worktrees=
known=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --branches) branches=${2-}; shift 2 || usage ;;
    --deadline) deadline=${2-}; shift 2 || usage ;;
    --interval) interval=${2-}; shift 2 || usage ;;
    --stream) shift ;;
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
case "$interval" in '' | *[!0-9]* | 0) usage "--interval must be a positive whole number of seconds" ;; esac
if [ -n "$stream" ]; then
  [ "$deadline" = 0 ] ||
    usage "--deadline is single-shot only; under --stream the monitor's own timeout is the heartbeat"
  trap 'reported=1; exit 143' HUP INT TERM
  trap on_exit EXIT
  command -v gh >/dev/null 2>&1 || fatal "gh not on PATH"
  git rev-parse --git-dir >/dev/null 2>&1 || fatal "not inside a git repository"
fi

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

# set_known <branch> <fingerprint>: stream mode's record of the last line
# printed for a branch, or "none" once the branch is seen non-actionable.
set_known() {
  known="$(printf '%s' "$known" | awk -v b="$1" 'index($0, b "=") != 1')
$1=$2
"
}

n_watched=$(printf '%s\n' "$branches" | awk -F, '{print NF}')
started=$(date +%s)

while :; do
  if [ -n "$stream" ]; then
    hash -r # forget cached command paths, so a removed binary is noticed
    command -v no-mistakes >/dev/null 2>&1 || fatal "no-mistakes not on PATH"
  fi
  seen=","
  n_seen=0
  # Newest run dirs first: only the most recent run per branch counts -
  # an older failed/cancelled run superseded by a rerun must not fire.
  # shellcheck disable=SC2012 # ls -t is the portable mtime sort; run ids hold no whitespace
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
    quiet= # set when the run is plainly not actionable, as opposed to not yet known
    case "$status" in
      failed | cancelled) state=$status ;;
      completed) quiet=1 ;; # merged or closed - nothing left for the orchestrator
      *)
        if printf '%s\n' "$out" | grep -q 'awaiting_agent\|,awaiting_approval,'; then
          state=parked
        elif grep -q 'all CI checks passed' "$logs_dir/$id/ci.log" 2>/dev/null; then
          state=merge-ready
        else
          quiet=1
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
      [ -n "$stream" ] || exit 0
      set_known "$branch" "$fingerprint"
    elif [ -n "$stream" ] && [ -n "$quiet" ]; then
      set_known "$branch" none
    fi
    [ "$n_seen" -eq "$n_watched" ] && break
  done
  if [ "$deadline" -gt 0 ] && [ $(($(date +%s) - started)) -ge "$deadline" ]; then
    echo timeout
    exit 0
  fi
  sleep "$interval"
done
