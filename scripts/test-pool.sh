#!/bin/sh
# Bounded job pool for `npm test` (scripts/test.sh).
#
# Usage: test-pool.sh <results-dir> <jobs-file> [<serial-file>]
#
# Each line of <jobs-file> is a shell command: one job. At most $TEST_JOBS run at once
# (default: the CPU count). Jobs in <serial-file> run one at a time, alone, after the pool has
# drained. Every job's combined stdout and stderr is buffered in <results-dir>/<n>.out and its
# exit status in <n>.status (n = line number, serial jobs numbered after the pool's). A job's
# exit status is its failure count (scripts/test-job.sh); a status of 126 or more means it
# crashed and counts 1.
#
# Quiet on success. Once every job has finished, each failing job's output is printed to
# stderr as one contiguous block, in job order (never completion order), the total failure
# count is written to <results-dir>/failed, and the exit status is 1 if anything failed.
# TEST_JOBS that is not a positive integer fails fast (exit 2).
#
# Ctrl-C or SIGTERM stops every running job and exits 130 / 143.
set -u

results=${1:?usage: test-pool.sh <results-dir> <jobs-file> [<serial-file>]}
jobs_file=${2:?usage: test-pool.sh <results-dir> <jobs-file> [<serial-file>]}
serial_file=${3:-}

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
  sh "$r/$i.cmd" > "$r/$i.out" 2>&1
  echo $? > "$r/$i.status"
'

# Every descendant of this script (xargs, the jobs, whatever they spawned), deepest last.
descendants() { # descendants <pid>
  for child in $(ps -A -o pid= -o ppid= | awk -v p="$1" '$2 == p { print $1 }'); do
    echo "$child"
    descendants "$child"
  done
}
interrupt() {
  trap '' INT TERM
  # Stop xargs first so it starts nothing new, then everything beneath it.
  victims=$(descendants "$$")
  # shellcheck disable=SC2086
  [ -n "$victims" ] && kill -TERM $victims 2>/dev/null
  wait
  exit "$1"
}
trap 'interrupt 130' INT
trap 'interrupt 143' TERM

if [ "$pool_count" -gt 0 ]; then
  i=0
  while [ "$i" -lt "$pool_count" ]; do i=$((i + 1)); echo "$i"; done |
    xargs -n 1 -P "$workers" sh -c "$run_one" sh "$results" &
  wait $!
fi

i=$pool_count
while [ "$i" -lt "$total" ]; do
  i=$((i + 1))
  sh -c "$run_one" sh "$results" "$i" &
  wait $!
done

failed=0
i=0
while [ "$i" -lt "$total" ]; do
  i=$((i + 1))
  status=$(cat "$results/$i.status" 2>/dev/null || echo 1)
  [ "$status" -eq 0 ] && continue
  [ "$status" -ge 126 ] && weight=1 || weight=$status
  failed=$((failed + weight))
  cat "$results/$i.out" >&2
done
echo "$failed" > "$results/failed"
[ "$failed" -eq 0 ]
