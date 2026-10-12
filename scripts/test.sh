#!/bin/sh
# Canonical test entrypoint (`npm test`; CLAUDE.md "Canonical commands").
#
# Runs every node test (tests/*.test.js), every plain-shell suite
# (features/test/callum-tools/*.test.sh, coder/test/*.test.sh, images/base/test/*.test.sh) and every
# mod's validation and tests (plugins/*/ with a hooks module). All are discovered by glob, so a new
# test file needs no wiring here.
#
# Every node step, shell suite and mod is an independent job, run in a pool of at most
# $TEST_JOBS at once (default: the CPU count; scripts/test-pool.sh, scripts/test-job.sh).
#
# Quiet on success: one summary line. On failure, once every job has finished, it prints only
# the failing node tests (name, file:line, assertion - see scripts/test-reporter.js) and the
# output of each failing shell suite or mod, each as one contiguous block in a stable order,
# then `test: N failed`, and exits non-zero.
set -u

cd "$(dirname "$0")/.." || exit 1
sh scripts/test-pool.sh --check-jobs || exit $?

# Jobs that run first, in this order, so the longest ones start at once and set the wall time.
# An entry that no longer exists is ignored; a suite not listed still runs.
SLOW_FIRST="
node
features/test/callum-tools/watchers.test.sh
features/test/callum-tools/orchestrator-watch.test.sh
"

# Jobs that cannot run beside any other job; they run alone after the pool drains. Keep this
# empty: make a suite parallel-safe (own temp dir, no fixed port or name, deterministic waits)
# instead of listing it, and say in the PR why if one must be listed.
SERIAL=""

results=$(mktemp -d) || exit 1
trap 'rm -rf "$results"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Shared per-run environment: anything exported here reaches every job. This is the one place
# for it (e.g. a per-run sandbox for the jobs' event and state dirs). TMPDIR points inside the
# results dir, so temp files created there by jobs that honour TMPDIR (even ones an
# interrupted job never got to clean up) are removed with it.
mkdir "$results/tmp" || exit 1
TEST_RESULTS_DIR=$results
TMPDIR=$results/tmp
export TEST_RESULTS_DIR TMPDIR

failed=0

# Discover jobs by glob, so a new test file needs no wiring here: the node step, every shell
# suite, and every mod. A mod is a plugin with a hooks module (hooks/hooks.json naming
# "modules"), validated and tested by Claude Code itself (`claude plugin validate` / `claude
# plugin test`, no login needed). Without claude on PATH mods are skipped with a note - unless
# TEST_REQUIRE_CLAUDE=1 (CI), where a missing claude must fail rather than pass unchecked.
all="$results/all"
echo node > "$all"
suites=0
for suite in features/test/callum-tools/*.test.sh coder/test/*.test.sh images/base/test/*.test.sh; do
  [ -f "$suite" ] || continue
  suites=$((suites + 1))
  echo "$suite" >> "$all"
done
mods=0
mod_note=""
for hooks in plugins/*/hooks/hooks.json; do
  grep -q '"modules"' "$hooks" 2>/dev/null || continue
  mod=${hooks%/hooks/hooks.json}
  if ! command -v claude >/dev/null 2>&1; then
    if [ "${TEST_REQUIRE_CLAUDE:-0}" = 1 ]; then
      echo "FAIL $mod: claude not on PATH, and TEST_REQUIRE_CLAUDE=1" >&2
      failed=$((failed + 1))
    else
      mod_note=" (mods skipped: claude not on PATH; CI runs them)"
    fi
    continue
  fi
  mods=$((mods + 1))
  echo "$mod" >> "$all"
done

# Order: slow-first jobs, then the rest in discovery order; serial jobs go to their own list.
in_list() { # in_list <id> <list>
  for item in $2; do [ "$item" = "$1" ] && return 0; done
  return 1
}
: > "$results/jobs"
: > "$results/serial"
for id in $SLOW_FIRST; do
  grep -qxF "$id" "$all" && ! in_list "$id" "$SERIAL" && echo "sh scripts/test-job.sh $id" >> "$results/jobs"
done
while IFS= read -r id; do
  if in_list "$id" "$SERIAL"; then
    echo "sh scripts/test-job.sh $id" >> "$results/serial"
  elif ! in_list "$id" "$SLOW_FIRST"; then
    echo "sh scripts/test-job.sh $id" >> "$results/jobs"
  fi
done < "$all"

# Run the pool in the background so a signal reaches it while we wait. A backgrounded pool
# ignores SIGINT, so Ctrl-C is forwarded as SIGTERM.
sh scripts/test-pool.sh "$results" "$results/jobs" "$results/serial" &
pool=$!
trap 'kill -TERM "$pool" 2>/dev/null; wait "$pool"; exit 143' TERM
trap 'kill -TERM "$pool" 2>/dev/null; wait "$pool"; exit 130' INT
wait "$pool"
pool_status=$?
case $pool_status in
  0 | 1) ;;
  *) exit "$pool_status" ;; # fast failure (bad TEST_JOBS) or an interrupt
esac
[ -f "$results/failed" ] && failed=$((failed + $(cat "$results/failed")))

if [ "$failed" -gt 0 ]; then
  echo "test: $failed failed" >&2
  exit 1
fi
node_total=$(cat "$results/node-total" 2>/dev/null || echo 0)
echo "test: ${node_total} node tests, $suites shell suites, $mods mods ok$mod_note"
