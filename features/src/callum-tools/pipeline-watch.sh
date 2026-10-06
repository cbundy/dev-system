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
#                plus " worktree=<sha>" when the branch is checked out in a
#                worktree (see below);
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
# `no-mistakes axi status` (per-step truth) and checks the run's ci.log for
# the CI-green marker. Must be run from inside the gated repository, like
# the CLI itself.
#
# The watch set is derived from live runs on every poll, never from a list
# the caller maintains (cbundy/dev-system#134): `no-mistakes runs` lists the
# repository's runs (it is per-repo, scoped to the cwd), newest first, and
# the newest run per branch is watched. Without --branches every branch
# with a run is watched, so a run nobody remembered to add - including one
# that failed at launch - is still reported. --branches a,b restricts the
# set to those branches. `no-mistakes runs` (v1.84) prints one plain row per
# run and no run id:
#
#   "  <status>  <branch> <short-head>  <YYYY-MM-DD HH:MM>"
#
# so each branch's run id is resolved, and the row cross-checked against
# the run's own status and head, from (in order) `no-mistakes axi status` in
# the branch's worktree, the "runs[N]{id,branch,status,head,pr}" table that
# `no-mistakes axi status` prints from a checkout whose branch has no run,
# and the per-run log directories. A failed or cancelled run none of them
# can resolve (e.g. it failed before writing a log directory, on a branch
# with no worktree) is still reported, with run id "unknown".
#
# Before reporting merge-ready, the run's head_sha is compared against
# origin/<branch> (fetched fresh) and against the HEAD of the worktree the
# branch is checked out in (from `git worktree list`, or --worktree
# <branch>=<path>, which wins). The worktree check matters: an agent that
# commits on a stale base and re-attaches to a live run leaves
# origin/<branch> equal to the run head while its own commit was never
# pushed or gated. Only once the head matches is GitHub asked for the PR's
# real mergeability (see `conflict` above).
#
# --known <branch>=<state>:<sha>, repeatable, is a per-branch fingerprint
# baseline - the pipeline-watch analog of queue-watch.sh's --known. Each
# cycle's fingerprint for a branch is "<state>:<head-sha>"; a branch whose
# current fingerprint matches its baseline has already been reported and
# handled, so it is not fired again - polling just continues. A branch with
# no --known entry - including one whose first run appears while the
# watcher is running - fires the first time it becomes actionable. This
# makes restarting the watcher after handling an event safe by construction - pass back the state/head you just handled as
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
  echo "usage: pipeline-watch.sh [--branches branch[,branch...]]" \
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
auto_worktrees=

# lookup <lines> <key>: the value of the first "<key>=<value>" line.
lookup() {
  printf '%s' "$1" | awk -v b="$2" 'index($0, b "=") == 1 { print substr($0, length(b) + 2); exit }'
}

# worktree_for <branch>: the worktree the branch is checked out in - an
# explicit --worktree mapping, else the one `git worktree list` reports
# (refreshed every cycle). Empty if neither knows it.
worktree_for() {
  p=$(lookup "$worktrees" "$1")
  [ -n "$p" ] || p=$(lookup "$auto_worktrees" "$1")
  printf '%s' "$p"
}

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
  wt_path=$(worktree_for "$1")
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
  lookup "$known" "$1"
}

# set_known <branch> <fingerprint>: stream mode's record of the last line
# printed for a branch, or "none" once the branch is seen non-actionable.
set_known() {
  known="$(printf '%s' "$known" | awk -v b="$1" 'index($0, b "=") != 1')
$1=$2
"
}

# clean: strip ANSI colour codes from stdin.
clean() {
  awk '{gsub(/\033\[[0-9;]*m/, ""); print}'
}

# field <status-output> <name>: the first "<name>: <value>" in a
# `no-mistakes axi status` reply, unquoted.
field() {
  printf '%s\n' "$1" | sed -n "s/^[[:space:]]*$2:[[:space:]]*//p" | sed -n 1p | tr -d '"'
}

# run_rows: the newest run per branch, newest first, one
# "<branch> <status> <short-head>" line each ("-" for a head the row does
# not show). Fails if `no-mistakes runs` does: a transient failure skips the
# cycle. Real rows carry a date, which also skips the "no runs yet" hint.
run_rows() {
  all=$(no-mistakes runs --limit 200 2>/dev/null) || return 1
  printf '%s\n' "$all" | clean | awk '
    /[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]/ && NF >= 3 && !seen[$2]++ {
      print $2, $1, ($3 ~ /^[0-9a-f]+$/ ? $3 : "-")
    }'
}

# try_run <id> <branch>: probe one run; on success sets out (the cleaned
# status reply) and id, if the run belongs to the branch. A failed probe
# sets probe_err, so the branch is skipped this cycle, not misreported.
try_run() {
  o=$(no-mistakes axi status --run "$1" 2>/dev/null) || {
    probe_err=1
    return 1
  }
  o=$(printf '%s\n' "$o" | clean)
  [ "$(field "$o" branch)" = "$2" ] || return 1
  out=$o
  id=$1
}

# load_table: once per cycle, "<branch>=<id>" lines (newest first) from the
# "runs[N]{id,branch,status,head,pr}" table `no-mistakes axi status` prints
# from a checkout whose own branch has no run (the usual case for the
# caller's checkout of the base branch). Empty otherwise.
load_table() {
  [ -z "$table_loaded" ] || return 0
  table_loaded=1
  table=$(no-mistakes axi status 2>/dev/null | clean | awk '
    /^runs\[[0-9]+\]\{id,branch,/ { t = 1; next }
    t && /^  / { sub(/^ +/, ""); split($0, f, ","); gsub(/"/, "", f[1]); print f[2] "=" f[1]; next }
    { t = 0 }') || table=
}

# scan_dirs: once per cycle, list the newest run log directories; a run's
# branch never changes, so each directory is probed only once per watcher.
scan_dirs() {
  [ -z "$dirs_scanned" ] || return 0
  dirs_scanned=1
  # shellcheck disable=SC2012 # ls -t is the portable mtime sort; run ids hold no whitespace
  dir_order=$(ls -t "$logs_dir" 2>/dev/null | head -50)
  for d in $dir_order; do
    [ -d "$logs_dir/$d" ] || continue
    [ -z "$(lookup "$dir_cache" "$d")" ] || continue
    o=$(no-mistakes axi status --run "$d" 2>/dev/null) || continue
    b=$(field "$(printf '%s\n' "$o" | clean)" branch)
    [ -z "$b" ] || dir_cache="$dir_cache$d=$b
"
  done
}

# resolve <branch> <row-status> <row-head>: find the id of the branch's
# newest run and probe it (sets id and out). Fails if no source has it.
resolve() {
  id=
  out=
  probe_err=
  # 1. the branch's worktree: `axi status` there reports its newest run
  wt=$(worktree_for "$1")
  if [ -n "$wt" ] && [ -d "$wt" ]; then
    if o=$(cd "$wt" && no-mistakes axi status 2>/dev/null); then
      rid=$(field "$(printf '%s\n' "$o" | clean)" id)
      [ -z "$rid" ] || ! try_run "$rid" "$1" || return 0
    else
      probe_err=1
    fi
  fi
  # 2. the run table, when the caller's checkout prints one
  load_table
  rid=$(lookup "$table" "$1")
  [ -z "$rid" ] || ! try_run "$rid" "$1" || return 0
  # 3. the newest log directory for the branch - but a failed or cancelled
  # row is only that directory's run if status and head agree: the newest
  # run may have failed before writing a directory, and an older run's
  # directory must not stand in for it
  scan_dirs
  for d in $dir_order; do
    [ "$(lookup "$dir_cache" "$d")" = "$1" ] || continue
    try_run "$d" "$1" || return 1
    case "$2" in
      failed | cancelled)
        [ "$(field "$out" status)" = "$2" ] || break
        case "$3" in -) ;; *) case "$(field "$out" head_sha)" in "$3"*) ;; *) break ;; esac ;; esac
        ;;
    esac
    return 0
  done
  id=
  out=
  return 1
}

started=$(date +%s)
dir_cache=

# poll: one cycle over every watched branch's newest run.
poll() {
  rows=$(run_rows) || return 0
  auto_worktrees=$(git worktree list --porcelain 2>/dev/null | awk '
    /^worktree / { p = substr($0, 10) }
    /^branch refs\/heads\// { print substr($0, 19) "=" p }') || auto_worktrees=
  table_loaded=
  dirs_scanned=
  old_ifs=$IFS
  IFS='
'
  for row in $rows; do
    IFS=$old_ifs
    branch=${row%% *}
    rest=${row#* }
    rstatus=${rest%% *}
    rhead=${rest#* }
    if [ -n "$branches" ]; then
      case ",$branches," in *",$branch,"*) ;; *) continue ;; esac
    fi
    state=
    quiet= # set when the run is plainly not actionable, as opposed to not yet known
    detail=
    if [ "$rstatus" = completed ]; then
      quiet=1 # merged or closed - nothing left for the orchestrator
    elif resolve "$branch" "$rstatus" "$rhead"; then
      run_sha=$(field "$out" head_sha)
      status=$(field "$out" status)
      case "$status" in
        failed | cancelled) state=$status ;;
        completed) quiet=1 ;;
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
    elif [ -z "$probe_err" ]; then
      # No source knows the run's id - e.g. it failed at launch, before
      # writing a log directory, on a branch with no worktree. A failed or
      # cancelled run is still reported; anything else is not yet known.
      case "$rstatus" in
        failed | cancelled)
          state=$rstatus
          id=unknown
          run_sha=
          [ "$rhead" = - ] || run_sha=$(git rev-parse --verify --quiet "$rhead^{commit}" 2>/dev/null) || run_sha=$rhead
          ;;
      esac
    fi
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
  done
  IFS=$old_ifs
}

while :; do
  if [ -n "$stream" ]; then
    hash -r # forget cached command paths, so a removed binary is noticed
    command -v no-mistakes >/dev/null 2>&1 || fatal "no-mistakes not on PATH"
  fi
  poll
  if [ "$deadline" -gt 0 ] && [ $(($(date +%s) - started)) -ge "$deadline" ]; then
    echo timeout
    exit 0
  fi
  sleep "$interval"
done
