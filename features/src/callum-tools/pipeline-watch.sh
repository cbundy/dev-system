#!/bin/sh
#
# Wait until a watched no-mistakes pipeline reaches an actionable state,
# print one line - "<state> <branch> <run-id>" - and exit. States:
#
#   merge-ready  all local steps passed and the run's ci.log records a
#                GitHub CI pass; nothing remains but the merge guards
#   parked       a gate is awaiting an agent/approval and needs driving
#   failed       a step failed
#   cancelled    the run was cancelled
#
# Run-level status alone cannot detect the first two: a cleanly passing
# run stays `running` through its CI-monitoring tail (up to 168h, until
# merged), and a parked gate also reports `running` at the top level. So
# each cycle probes the newest run per watched branch with
# `no-mistakes axi status --run <id>` (per-step truth) and checks the
# run's ci.log for the CI-green marker. Must be run from inside the
# gated repository, like the CLI itself.
set -eu

usage() {
  echo "usage: pipeline-watch.sh --branches branch[,branch...]" >&2
  exit 2
}

[ "$#" -eq 2 ] && [ "$1" = "--branches" ] || usage
branches=$2
[ -n "$branches" ] || usage

logs_dir="${NO_MISTAKES_HOME:-$HOME/.no-mistakes}/logs"
n_watched=$(printf '%s\n' "$branches" | awk -F, '{print NF}')

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
    if [ -n "$state" ]; then
      printf '%s %s %s\n' "$state" "$branch" "$id"
      exit 0
    fi
    [ "$n_seen" -eq "$n_watched" ] && break
  done
  sleep "${PIPELINE_WATCH_INTERVAL:-25}"
done
