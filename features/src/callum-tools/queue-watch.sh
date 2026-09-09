#!/bin/sh
#
# Wait until a repository's labelled-issue queue changes, print one line -
# "queue-changed known=<n1,n2|none> now=<n1,n2|none>" - and exit.
#
# The orchestrator starts this with the queue it already knows about, so a
# deliberately-untouched queue (blocked work, issues awaiting the owner)
# never fires - only a genuine delta against that baseline does. Polling is
# a token-free shell loop; the exit is the event delivery, mirroring
# pipeline-watch.sh. It carries no state of its own: the baseline is passed
# in, so a crashed-and-restarted watcher catches up on its first cycle.
# Transient gh failures skip the cycle rather than firing or dying.
set -eu

usage() {
  echo "usage: queue-watch.sh --repo owner/name --label label [--known n1,n2,...]" >&2
  exit 2
}

repo=
label=
known=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) repo=${2-}; shift 2 || usage ;;
    --label) label=${2-}; shift 2 || usage ;;
    --known) known=${2-}; shift 2 || usage ;;
    *) usage ;;
  esac
done
[ -n "$repo" ] && [ -n "$label" ] || usage

while :; do
  if current=$(gh issue list --repo "$repo" --label "$label" --state open \
    --json number --jq '[.[].number] | sort | join(",")' 2>/dev/null); then
    if [ "$current" != "$known" ]; then
      printf 'queue-changed known=%s now=%s\n' "${known:-none}" "${current:-none}"
      exit 0
    fi
  fi
  sleep "${QUEUE_WATCH_INTERVAL:-120}"
done
