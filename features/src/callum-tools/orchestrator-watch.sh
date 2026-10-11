#!/bin/sh
#
# One watcher for the whole orchestrator (cbundy/dev-system#393, #394): runs
# queue-watch.sh --stream and pipeline-watch.sh --stream as two children of one
# process, so the orchestrator arms one watcher with one expiry instead of two.
# Every line a child prints is passed through unchanged
# ("queue-changed known=... now=...", "<state> <branch> <run-id> ... head=<sha>"),
# so the skill's event handling does not change. The children's stderr is passed
# through too, and a quiet child (one sleeping in a rate-limit backoff, say) is
# never taken for a dead one: only a child exit or a watcher-error line counts.
#
# Arguments are those of both watchers:
#   --repo owner/name --label label      the queue to watch (both required)
#   --queue-known n1,n2|none             the queue the caller already knows
#   --pipeline-known branch=state:sha    repeatable, per-branch baseline
#   --worktree branch=path               repeatable, passed to pipeline-watch.sh
#   --interval s | --queue-interval s | --pipeline-interval s
#   --deadline seconds                   end with "timeout" after this long
#   --stream                             see below
# Run it from inside the gated repository, like pipeline-watch.sh.
#
# Modes (both take --deadline):
#   single-shot (default, for a background Bash): exits 0 after the first event.
#     Lines that arrive within a short window after it (ORCHESTRATOR_WATCH_WINDOW
#     seconds, default 5) are printed in the same exit.
#   --stream (for Monitor): prints every child line as it happens and never
#     exits on an event. At the deadline it prints "timeout" and exits 0, so it
#     ends itself cleanly before Monitor's own 30-minute kill.
# At the deadline, single-shot prints "timeout" too and exits 0.
#
# Rearm: every clean exit (and each timeout) ends with one line,
#   rearm <args>
# the original arguments with --queue-known and --pipeline-known replaced by the
# baselines carried forward from every line printed so far. Running the watcher
# again with exactly those args never re-delivers a printed event and catches up
# on anything that happened while nothing was armed: the baselines are the same
# ones the children use to decide what is news. (Paths with spaces are not
# quoted in the line; worktree paths are not expected to have any.)
#
# Never silent: when either child exits, or prints "watcher-error <reason>", this
# prints "watcher-error <child>: <reason>" (child is queue or pipeline), stops
# the other child and exits 1. A usage error prints "watcher-error usage: ..."
# and exits 2. A signal stops both children and prints nothing. No child is left
# behind: the whole process tree is stopped on every exit path.
#
# Never two copies: one lock per repository (ORCHESTRATOR_WATCH_LOCK_DIR, else
# $XDG_RUNTIME_DIR or $TMPDIR or /tmp). A second copy while the first is alive
# prints "watcher-error already-running pid=<p>" and exits 1. A lock left by a
# dead process is taken over.
#
# Test overrides: ORCHESTRATOR_WATCH_QUEUE_BIN, ORCHESTRATOR_WATCH_PIPELINE_BIN
# (default: the sibling scripts), ORCHESTRATOR_WATCH_WINDOW.
# shellcheck disable=SC2317 # cleanup and its helpers run from the EXIT trap
set -eu
set -f

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
QBIN=${ORCHESTRATOR_WATCH_QUEUE_BIN:-$here/queue-watch.sh}
PBIN=${ORCHESTRATOR_WATCH_PIPELINE_BIN:-$here/pipeline-watch.sh}
window=${ORCHESTRATOR_WATCH_WINDOW:-5}
SOH=$(printf '\001')
NL='
'

# Background sleep lets the shell handle watcher signals while waiting.
# Keep this helper's body aligned across the three watchers: scripts are
# installed individually, so the helper is copied rather than sourced.
# Sleep-interruption behavior is documented in images/base/README.md.
nap_pid=
nap() {
  nap_left=$(printf '%s' "$1" | sed 's/^0*//')
  nap_left=${nap_left:-0}
  nap_end=$(($(date +%s) + nap_left))
  while [ "$nap_left" -gt 0 ]; do
    sleep "$nap_left" &
    nap_pid=$!
    nap_rc=0
    wait "$nap_pid" 2>/dev/null || nap_rc=$?
    nap_pid=
    [ "$nap_rc" -gt 128 ] || return "$nap_rc"
    nap_left=$((nap_end - $(date +%s)))
    [ "$nap_left" -gt 0 ] || nap_left=0
    echo "orchestrator-watch.sh: sleep interrupted (status $nap_rc), sleeping the remaining ${nap_left}s" >&2
  done
}

usage() {
  echo "watcher-error usage${1:+: $1}"
  [ -z "${1-}" ] || echo "orchestrator-watch.sh: $1" >&2
  echo "usage: orchestrator-watch.sh --repo owner/name --label label" \
    "[--queue-known n1,n2|none] [--pipeline-known branch=state:sha]..." \
    "[--worktree branch=path]... [--stream] [--deadline seconds]" \
    "[--interval s] [--queue-interval s] [--pipeline-interval s]" >&2
  exit 2
}

repo=
label=
qknown=
pknown=
worktrees=
stream=
deadline=
qint=
pint=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) repo=${2-}; shift 2 || usage ;;
    --label) label=${2-}; shift 2 || usage ;;
    --queue-known) qknown=${2-}; shift 2 || usage ;;
    --pipeline-known)
      case "${2-}" in *=*:*) ;; *) usage "--pipeline-known wants branch=state:sha" ;; esac
      pknown="$pknown$2$NL"
      shift 2
      ;;
    --worktree)
      case "${2-}" in *=*) ;; *) usage "--worktree wants branch=path" ;; esac
      worktrees="$worktrees$2$NL"
      shift 2
      ;;
    --interval) qint=${2-}; pint=${2-}; shift 2 || usage ;;
    --queue-interval) qint=${2-}; shift 2 || usage ;;
    --pipeline-interval) pint=${2-}; shift 2 || usage ;;
    --deadline) deadline=${2-}; shift 2 || usage ;;
    --stream) stream=1; shift ;;
    *) usage "unknown argument $1" ;;
  esac
done
if [ -z "$repo" ] || [ -z "$label" ]; then usage "--repo and --label are required"; fi
positive() { case "$1" in '' | *[!0-9]* | 0) return 1 ;; esac; }
for v in "$qint" "$pint" "$deadline"; do
  [ -z "$v" ] || positive "$v" || usage "intervals and --deadline must be positive whole numbers of seconds"
done
positive "$window" || usage "ORCHESTRATOR_WATCH_WINDOW must be a positive whole number of seconds"
[ "$qknown" != none ] || qknown=
qknown=$(printf '%s' "$qknown" | tr ',' '\n' | sed '/^$/d' | sort -nu | paste -sd, -)

# ---- cleanup -------------------------------------------------------------

lock=
owned=
tmp=

# descendants <pid>: every descendant of pid, deepest first, one per line.
# Level by level, not recursive: sh has no local variables, and a subshell per
# level would itself become a descendant to find.
descendants() {
  frontier=$1
  found=
  while [ -n "$frontier" ]; do
    level=
    for p in $frontier; do
      level="$level $(pgrep -P "$p" 2>/dev/null || :)"
    done
    case $level in
      *[0-9]*) found="$level $found" ;;
      *) level= ;;
    esac
    frontier=$level
  done
  # shellcheck disable=SC2086 # a list of pids
  [ -z "$found" ] || printf '%s\n' $found
}

# stop_children: stop everything below this process. Each round freezes what it
# finds (so nothing can fork more) and looks again, then everything is killed.
stop_children() {
  all=
  round=0
  while [ "$round" -lt 5 ]; do
    round=$((round + 1))
    found=$(descendants $$)
    new=
    for p in $found; do
      case " $all " in *" $p "*) ;; *) new="$new $p" ;; esac
    done
    [ -n "$new" ] || break
    # shellcheck disable=SC2086 # a list of pids
    kill -STOP $new 2>/dev/null || :
    all="$all$new"
  done
  [ -z "$all" ] || {
    # shellcheck disable=SC2086
    kill -KILL $all 2>/dev/null || :
  }
}

cleanup() {
  trap '' HUP INT TERM
  { stop_children; wait; } 2>/dev/null || :
  [ -z "$owned" ] || rm -rf "$lock"
  [ -z "$tmp" ] || rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 143' HUP INT TERM

# ---- lock ----------------------------------------------------------------

alive_watcher() {
  kill -0 "$1" 2>/dev/null || return 1
  # a reused pid belongs to another program: check the name where /proc exists
  [ ! -r "/proc/$1/cmdline" ] || tr '\0' ' ' < "/proc/$1/cmdline" | grep -q orchestrator-watch
}

lockdir=${ORCHESTRATOR_WATCH_LOCK_DIR:-${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}}
lock="$lockdir/orchestrator-watch-$(printf '%s' "$repo" | tr -c 'A-Za-z0-9._-' '_').lock"
mkdir -p "$lockdir"
tries=0
while :; do
  if mkdir "$lock" 2>/dev/null; then
    owned=1
    echo $$ > "$lock/pid"
    break
  fi
  p=$(cat "$lock/pid" 2>/dev/null || :)
  if [ -n "$p" ] && alive_watcher "$p"; then
    echo "watcher-error already-running pid=$p"
    exit 1
  fi
  tries=$((tries + 1))
  if [ -z "$p" ] && [ "$tries" -le 5 ]; then
    sleep 0.2 || : # the owner is between mkdir and writing its pid
    continue
  fi
  [ "$tries" -le 10 ] || { echo "watcher-error cannot take lock $lock"; exit 1; }
  # stale: move it aside first, so two takers cannot both remove a fresh lock
  if mv "$lock" "$lock.stale.$$" 2>/dev/null; then rm -rf "$lock.stale.$$"; fi
done

# ---- children ------------------------------------------------------------

tmp=$(mktemp -d)
fifo="$tmp/events"
mkfifo "$fifo"
exec 3<>"$fifo"

run_queue() {
  set -- --repo "$repo" --label "$label" --known "$qknown" --stream
  [ -z "$qint" ] || set -- "$@" --interval "$qint"
  "$QBIN" "$@"
}

run_pipeline() {
  set -- --stream
  [ -z "$pint" ] || set -- "$@" --interval "$pint"
  oldifs=$IFS
  IFS=$NL
  for w in $worktrees; do set -- "$@" --worktree "$w"; done
  for k in $pknown; do set -- "$@" --known "$k"; done
  IFS=$oldifs
  "$PBIN" "$@"
}

# Each child runs in a subshell that reports its exit as a sentinel line on the
# shared stream; a timer is another writer of the same kind.
( rc=0; run_queue || rc=$?; printf '%sexit queue %s\n' "$SOH" "$rc" ) >&3 &
( rc=0; run_pipeline || rc=$?; printf '%sexit pipeline %s\n' "$SOH" "$rc" ) >&3 &
timer() { ( nap "$1"; printf '%s%s\n' "$SOH" "$2" ) >&3 & }
[ -z "$deadline" ] || timer "$deadline" deadline

# ---- carried baselines ---------------------------------------------------

# carry <line>: fold a printed line into the baselines.
carry() {
  case "$1" in
    "queue-changed "*)
      now=${1##*now=}
      [ "$now" != none ] || now=
      qknown=$now
      ;;
    *" head="*)
      sha=${1##*head=}
      # shellcheck disable=SC2086 # split the line into fields
      set -- $1
      b=$2
      fp="$1:$sha"
      pknown=$(printf '%s' "$pknown" | awk -v b="$b" 'index($0, b "=") != 1')
      pknown="$pknown${pknown:+$NL}$b=$fp$NL"
      ;;
  esac
}

rearm() {
  r="rearm --repo $repo --label $label"
  [ -z "$stream" ] || r="$r --stream"
  [ -z "$deadline" ] || r="$r --deadline $deadline"
  [ -z "$qint" ] || r="$r --queue-interval $qint"
  [ -z "$pint" ] || r="$r --pipeline-interval $pint"
  r="$r --queue-known ${qknown:-none}"
  for k in $pknown; do r="$r --pipeline-known $k"; done
  for w in $worktrees; do r="$r --worktree $w"; done
  echo "$r"
}

# ---- event loop ----------------------------------------------------------

# The loop runs in a subshell and this shell sits in `wait`, the one builtin a
# signal interrupts at once (a trap does not run while `read` is blocked).
(
pending= # the reason of a watcher-error line, until the child's exit names it
fired=
while IFS= read -r line <&3; do
  case "$line" in
    "${SOH}deadline")
      [ -n "$fired" ] || echo timeout
      rearm
      exit 0
      ;;
    "${SOH}window")
      rearm
      exit 0
      ;;
    "${SOH}exit "*)
      # shellcheck disable=SC2086
      set -- $line
      echo "watcher-error $2: ${pending:-exited with status $3}"
      exit 1
      ;;
    "watcher-error"*) pending=${line#watcher-error} ; pending=${pending# } ;;
    *)
      echo "$line"
      carry "$line"
      if [ -z "$stream" ] && [ -z "$fired" ]; then
        fired=1
        timer "$window" window
      fi
      ;;
  esac
done
) &
reader=$!
rc=0
wait "$reader" || rc=$?
exit "$rc"
