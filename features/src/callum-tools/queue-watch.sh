#!/bin/sh
#
# Wait until a repository's labelled-issue queue changes, print one line -
# "queue-changed known=<n1,n2|none> now=<n1,n2|none>" - and exit
# (single-shot, the default). With --stream it never exits on an event: see
# "Stream mode" below.
#
# The orchestrator starts this with the queue it already knows about, so a
# deliberately-untouched queue (blocked work, issues awaiting the owner)
# never fires - only a genuine delta against that baseline does. Polling is
# a token-free shell loop; the exit is the event delivery, mirroring
# pipeline-watch.sh. It carries no state of its own: the baseline is passed
# in, so a crashed-and-restarted watcher catches up on its first cycle.
# Transient gh failures skip the cycle rather than firing or dying.
#
# Debounce (both modes): a changed set fires only once two consecutive
# polls agree on it. The confirming poll comes after a short delay (15s, or
# the interval if that is shorter), not a full interval. This absorbs
# GitHub's label-list lag: right after an issue's label is swapped, `gh issue
# list --label` can still return it for a few seconds, and a watcher re-armed
# straight after a claim would otherwise fire on that stale read
# (cbundy/dev-system#123).
#
# Stream mode (--stream, cbundy/dev-system#54) is for a harness that turns
# each stdout line of a long-running command into an event (Claude Code's
# Monitor tool). It prints the same queue-changed line on each confirmed
# change and carries `now` forward as the next baseline, so handling an
# event can never leave the session unwatched. Output is only those lines
# and, on a fatal error, one final "watcher-error <reason>" line before a
# non-zero exit, so a crash is never silent. Fatal: `gh` missing from PATH,
# a usage error, or any unexpected exit. A signal (the harness stopping the
# monitor) is a normal end and prints nothing.
#
# --interval <seconds> sets the poll interval (default: the
# QUEUE_WATCH_INTERVAL environment variable, else 120).
#
# Arming: pass the numbers currently in the queue as --known, so deliberately
# parked issues (blocked, awaiting the owner) never fire. The order does not
# matter: the list is sorted numerically here before it is compared. Run it
# once per session; two copies deliver every event twice. Under a harness
# Monitor tool use --stream with the longest timeout the tool allows. When
# that timeout ends the watcher, re-arm it first thing, with the latest
# `now=` as --known. Without a Monitor tool, run it single-shot in the
# background: its exit is the wake, so re-arm with the line's `now=` before
# handling the event. Never bundle arming it with a call that may be refused
# (a merge, an edit, a push) - a refusal blocks the whole call.
# The queue is listed through callum-flow-issue-read (cbundy/dev-system#310), so
# an issue by an untrusted author never enters `known`/`now` and never logs a
# `ready` event. A reader failure is a failed poll, never an empty queue.
# Event log (cbundy/dev-system#344): each issue that joins the queue logs a
# `ready` event. An issue already queued at the first successful poll but
# missing from --known (a re-armed watcher with a stale baseline) is a first
# sight: it is printed in queue-changed as always but logged with
# callum-flow-event --if-changed, so it adds nothing when the log already ends
# with that event. An issue that joins after the first poll is always logged.
# A `watcher-error <reason>` line means it has exited: fix the cause and re-arm.
set -eu

stream=
case " $* " in *" --stream "*) stream=1 ;; esac
reported=
READ=${CALLUM_FLOW_ISSUE_READ_BIN:-callum-flow-issue-read}

# record_event <state> [callum-flow-event options]: appends the transition to
# the factory event log (cbundy/dev-system#218) when callum-flow-event is
# installed. Best effort: it never changes this script's output or status.
record_event() {
  command -v callum-flow-event >/dev/null 2>&1 || return 0
  callum-flow-event "$@" --actor watcher >/dev/null 2>&1 || :
}

# fatal <reason>: exit non-zero; in stream mode first print the one
# watcher-error line on stdout, the event channel.
fatal() {
  [ -z "$stream" ] || echo "watcher-error $*"
  record_event watcher_error --note "queue-watch: $*"
  echo "queue-watch.sh: $*" >&2
  reported=1
  exit 1
}

# on_exit (stream mode's EXIT trap): an unexpected non-zero exit still ends
# with a watcher-error line.
on_exit() {
  rc=$?
  [ "$rc" -eq 0 ] || [ -n "$reported" ] || {
    echo "watcher-error exited with status $rc"
    record_event watcher_error --note "queue-watch: exited with status $rc"
  }
}

usage() {
  [ -z "$stream" ] || {
    echo "watcher-error usage${1:+: $1}"
    record_event watcher_error --note "queue-watch: usage${1:+: $1}"
  }
  [ -z "${1-}" ] || echo "queue-watch.sh: $1" >&2
  echo "usage: queue-watch.sh --repo owner/name --label label [--known n1,n2,...]" \
    "[--stream] [--interval seconds]" >&2
  reported=1
  exit 2
}

repo=
label=
known=
interval=${QUEUE_WATCH_INTERVAL:-120}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) repo=${2-}; shift 2 || usage ;;
    --label) label=${2-}; shift 2 || usage ;;
    --known) known=${2-}; shift 2 || usage ;;
    --interval) interval=${2-}; shift 2 || usage ;;
    --stream) shift ;;
    *) usage ;;
  esac
done
if [ -z "$repo" ] || [ -z "$label" ]; then usage; fi
# The poll below yields a numerically sorted set; sort the baseline the same
# way so a caller's order never fires a spurious queue-changed.
known=$(printf '%s' "$known" | tr ',' '\n' | sed '/^$/d' | sort -nu | paste -sd, -)
case "$interval" in '' | *[!0-9]* | 0) usage "--interval must be a positive whole number of seconds" ;; esac
confirm=15
[ "$interval" -ge "$confirm" ] || confirm=$interval
if [ -n "$stream" ]; then
  trap 'reported=1; exit 143' HUP INT TERM
  trap on_exit EXIT
  command -v gh >/dev/null 2>&1 || fatal "gh not on PATH"
  command -v "$READ" >/dev/null 2>&1 || fatal "$READ not on PATH"
fi

# The changed set seen on the previous successful poll, waiting for a second
# poll to confirm it; empty when there is none. A failed poll is no poll, so
# it neither confirms nor clears a pending set.
pending=
# Issues present at the first successful poll and still queued: seen, not
# watched joining. Set by the first poll, then only ever shrinks.
initial=
polled=
while :; do
  delay=$interval
  if listed=$(CALLUM_FLOW_REPO=$repo "$READ" --json --list --label "$label" --state open 2>/dev/null) &&
    current=$(printf '%s' "$listed" | jq -re 'if (.issues | type) == "array" then [.issues[].number] | sort | join(",") else error("shape") end' 2>/dev/null); then
    if [ -z "$polled" ]; then
      polled=1
      initial=$current
    else
      kept=
      for n in $(printf '%s' "$initial" | tr ',' ' '); do
        case ",$current," in *",$n,"*) kept="$kept,$n" ;; esac
      done
      initial=${kept#,}
    fi
    if [ "$current" = "$known" ]; then
      pending=
    elif [ -n "$pending" ] && [ "${pending#=}" = "$current" ]; then
      printf 'queue-changed known=%s now=%s\n' "${known:-none}" "${current:-none}"
      # every issue that joined the queue is a "ready" transition
      for n in $(printf '%s' "$current" | tr ',' ' '); do
        case ",$known," in
          *",$n,"*) ;;
          *)
            case ",$initial," in
              *",$n,"*) record_event ready --issue "$n" --if-changed ;;
              *) record_event ready --issue "$n" ;;
            esac
            ;;
        esac
      done
      [ -n "$stream" ] || exit 0
      known=$current
      pending=
    else
      # "=" prefix: an empty queue is a valid pending set
      pending="=$current"
      delay=$confirm
    fi
  fi
  sleep "$delay"
done
