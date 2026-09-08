#!/bin/sh
#
# Wait until a watched no-mistakes pipeline reaches an actionable state.
set -eu

usage() {
  echo "usage: pipeline-watch.sh --branches branch[,branch...]" >&2
  exit 2
}

[ "$#" -eq 2 ] && [ "$1" = "--branches" ] || usage
branches=$2
[ -n "$branches" ] || usage

while :; do
  if output=$(no-mistakes runs --limit 0 2>&1); then
    if match=$(printf '%s\n' "$output" | awk -v branches="$branches" '
      BEGIN {
        count = split(branches, items, ",")
        for (i = 1; i <= count; i++) watched[items[i]] = 1
      }
      {
        gsub(/\033\[[0-9;]*m/, "")
        if (watched[$2] && ($1 == "awaiting_agent" || $1 == "checks-passed" || $1 == "failed" || $1 == "cancelled")) {
          print
          found = 1
          exit 0
        }
      }
      END { exit !found }
    '); then
      printf '%s\n' "$match"
      exit 0
    fi
  else
    printf '%s\n' "$output" >&2
  fi
  sleep "${PIPELINE_WATCH_INTERVAL:-25}"
done
