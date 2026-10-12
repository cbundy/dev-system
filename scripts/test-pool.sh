#!/bin/sh
# Bounded job pool for `npm test` (scripts/test.sh).
#
# Usage: test-pool.sh <results-dir> <jobs-file> [<serial-file>]
#        test-pool.sh --check-jobs (validate TEST_JOBS without starting jobs)
#
# Each line of <jobs-file> is a shell command: one job. At most $TEST_JOBS run at once
# (default: the CPU count). Jobs in <serial-file> run one at a time, alone, after the pool has
# drained. Every job's combined stdout and stderr is buffered in <results-dir>/<n>.out and its
# exit status in <n>.status (n = line number, serial jobs numbered after the pool's). A job
# fails when it exits non-zero; it counts 1 unless it wrote its own failure count to the file
# named by $TEST_JOB_FAILED (scripts/test-job.sh does, for node).
#
# Quiet on success. Once every job has finished, each failing job's output is printed to
# stderr as one contiguous block, in job order (never completion order), the total failure
# count is written to <results-dir>/failed, and the exit status is 1 if anything failed.
# TEST_JOBS that is not a positive integer fails fast (exit 2).
#
# SIGTERM stops every running job and exits 143; so does SIGINT (exit 130), but only when the
# pool runs in the foreground: a pool started with `&` by a non-interactive shell ignores SIGINT,
# so a parent that backgrounds it (scripts/test.sh) forwards Ctrl-C as SIGTERM.
set -u

cpu_count() {
  getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1
}

if [ "${TEST_JOBS+set}" = set ]; then
  workers=$TEST_JOBS
else
  workers=$(cpu_count)
fi
case $workers in
  '' | *[!0-9]* | 0*)
    echo "test-pool: TEST_JOBS must be a positive integer, got '$workers'" >&2
    exit 2
    ;;
esac

# The entrypoint validates before discovery can emit unrelated diagnostics.
[ "${1:-}" = --check-jobs ] && exit 0

results=${1:?usage: test-pool.sh <results-dir> <jobs-file> [<serial-file>]}
jobs_file=${2:?usage: test-pool.sh <results-dir> <jobs-file> [<serial-file>]}
serial_file=${3:-}

# Materialise every job as <n>.cmd, parallel jobs first.
n=0
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  n=$((n + 1))
  printf '%s\n' "$line" > "$results/$n.cmd"
done < "$jobs_file"
pool_count=$n
if [ -n "$serial_file" ] && [ -f "$serial_file" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    n=$((n + 1))
    printf '%s\n' "$line" > "$results/$n.cmd"
  done < "$serial_file"
fi
total=$n

# Run job $2 of results dir $1; always exits 0 so xargs never short-circuits.
# shellcheck disable=SC2016 # expanded by the inner sh, not here
run_one='
  r=$1; i=$2
  TEST_JOB_FAILED=$r/$i.failed sh "$r/$i.cmd" > "$r/$i.out" 2>&1
  echo $? > "$r/$i.status"
'

# Every descendant of this script (xargs, the jobs, whatever they spawned), deepest last.
descendants() { # descendants <pid>
  for child in $(ps -A -o pid= -o ppid= | awk -v p="$1" '$2 == p { print $1 }'); do
    # Freeze each parent before inspecting its children: otherwise xargs can replace
    # a completed job with a queued one while the tree is being collected.
    kill -STOP "$child" 2>/dev/null
    echo "$child"
    descendants "$child"
  done
}
interrupt() {
  trap '' INT TERM
  # Stop xargs first so it starts nothing new, then everything beneath it.
  victims=""
  if [ -n "$active" ]; then
    kill -STOP "$active" 2>/dev/null
    victims="$active $(descendants "$active")"
  fi
  # shellcheck disable=SC2086
  [ -n "$victims" ] && kill -TERM $victims 2>/dev/null
  # Stopped processes must resume to handle the pending termination signal.
  # shellcheck disable=SC2086 # victims is a PID list; word splitting is intended
  [ -n "$victims" ] && kill -CONT $victims 2>/dev/null
  wait
  exit "$1"
}
active=""
trap 'interrupt 130' INT
trap 'interrupt 143' TERM

if [ "$pool_count" -gt 0 ]; then
  i=0
  while [ "$i" -lt "$pool_count" ]; do i=$((i + 1)); echo "$i"; done |
    xargs -n 1 -P "$workers" sh -c "$run_one" sh "$results" &
  active=$!
  wait "$active"
  active=""
fi

i=$pool_count
while [ "$i" -lt "$total" ]; do
  i=$((i + 1))
  sh -c "$run_one" sh "$results" "$i" &
  active=$!
  wait "$active"
  active=""
done

failed=0
i=0
while [ "$i" -lt "$total" ]; do
  i=$((i + 1))
  status=$(cat "$results/$i.status" 2>/dev/null || echo 1)
  [ "$status" -eq 0 ] && continue
  weight=$(cat "$results/$i.failed" 2>/dev/null)
  case $weight in
    '' | *[!0-9]* | 0*) weight=1 ;;
  esac
  failed=$((failed + weight))
  cat "$results/$i.out" >&2
done
echo "$failed" > "$results/failed"
[ "$failed" -eq 0 ]
