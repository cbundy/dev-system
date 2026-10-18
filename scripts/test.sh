#!/bin/sh
# Canonical test entrypoint (`npm test`; CLAUDE.md "Canonical commands").
#
# Runs every node test (tests/*.test.js), every plain-shell suite
# (features/test/callum-tools/*.test.sh, coder/test/*.test.sh, images/base/test/*.test.sh) and every
# mod's validation and tests (plugins/*/ with a hooks module). All are discovered by glob, so a new
# test file needs no wiring here.
#
# Every node step, shell suite and mod is an independent job, run in a pool of at most
# $TEST_JOBS at once (default: the container-aware CPU count; scripts/test-pool.sh, scripts/test-job.sh).
#
# Quiet on success: one summary line. On failure, once every job has finished, it prints only
# the failing node tests (name, file:line, assertion - see scripts/test-reporter.js) and the
# output of each failing shell suite or mod, each as one contiguous block in a stable order,
# plus `FAIL test isolation: <file>` for each entry left in the sandboxed shared-state
# directories and `FAIL test isolation: database|role <name>` for each factory_test_* database or
# role left on the test PostgreSQL server (scripts/test-pg.sh), then `test: N failed`, and exits non-zero.
#
# Subset mode, for debugging: `npm test -- <id>...` runs only the named jobs, with the same sandbox,
# PostgreSQL, pool, failure output and isolation checks. An <id> is `node` (the whole node step), a
# `tests/<name>.test.js` file (all named files run together as one node job), a discovered
# `*.test.sh` suite path, or a discovered mod directory (`plugins/<p>`). An unknown id prints one
# error line and exits 2 before any setup. A subset run's success line says it is not the gate.
#
# Shard mode, for CI: TEST_SHARD=K/N (1 <= K <= N) runs only shard K of N. The full ordered job
# list is built as usual (slow-first jobs, discovery order, serial jobs), numbered from 0, and job i
# belongs to shard (i mod N) + 1. A shard runs its jobs through the same pool, with the same sandbox,
# PostgreSQL and isolation checks, and its success line says it is one part of the gate. An invalid
# TEST_SHARD, or TEST_SHARD together with ids, prints one error line and exits 2 before any setup.
#
# List mode: `npm test -- --list` prints the ids the run would schedule (after the subset or shard
# filter), one per line in scheduled order, and exits 0 before any setup.
set -u

cd "$(dirname "$0")/.." || exit 1
sh scripts/test-pool.sh --check-jobs || exit $?

list=0
if [ "${1:-}" = --list ]; then
  list=1
  shift
fi

shard=""
shard_k=""
shard_n=""
if [ -n "${TEST_SHARD:-}" ]; then
  if ! printf '%s\n' "$TEST_SHARD" | grep -Eq '^[1-9][0-9]{0,5}/[1-9][0-9]{0,5}$'; then
    echo "test: invalid TEST_SHARD '$TEST_SHARD'; use K/N with positive integers and 1 <= K <= N (for example 2/3)" >&2
    exit 2
  fi
  shard_k=${TEST_SHARD%/*}
  shard_n=${TEST_SHARD#*/}
  if [ "$shard_k" -gt "$shard_n" ]; then
    echo "test: invalid TEST_SHARD '$TEST_SHARD'; use K/N with positive integers and 1 <= K <= N (for example 2/3)" >&2
    exit 2
  fi
  if [ "$#" -gt 0 ]; then
    echo "test: TEST_SHARD cannot be combined with ids; use one or the other" >&2
    exit 2
  fi
  shard=$TEST_SHARD
  # Jobs must not inherit it: a node test that runs test.sh with ids would hit the ids check.
  unset TEST_SHARD
fi

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

# Under /tmp, never the inherited TMPDIR: the sandbox must sit outside /persist, and that TMPDIR may be a loop scratch folder under it.
results=$(mktemp -d /tmp/npm-test.XXXXXX) || exit 1
. ./scripts/test-sandbox.sh
. ./scripts/test-pg.sh
trap 'test_pg_clean; test_sandbox_clean; rm -rf "$results"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

failed=0
# Discover jobs by glob, so a new test file needs no wiring here: the node step, every shell
# suite, and every mod. A mod is a plugin with a hooks module (hooks/hooks.json naming
# "modules"), validated and tested by Claude Code itself (`claude plugin validate` / `claude
# plugin test`, no login needed). Without claude on PATH mods are skipped with a note - unless
# TEST_REQUIRE_CLAUDE=1 (CI), where a missing claude must fail rather than pass unchecked.
all="$results/all"
echo node > "$all"
nodefiles="$results/nodefiles"
: > "$nodefiles"
for f in tests/*.test.js; do
  [ -f "$f" ] && echo "$f" >> "$nodefiles"
done
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
      # A subset run only needs the mods it names, which then fail as unknown ids below.
      [ "$#" -eq 0 ] && {
        echo "FAIL $mod: claude not on PATH, and TEST_REQUIRE_CLAUDE=1" >&2
        failed=$((failed + 1))
      }
    else
      mod_note=" (mods skipped: claude not on PATH; CI runs them)"
    fi
    continue
  fi
  mods=$((mods + 1))
  echo "$mod" >> "$all"
done

# Subset mode: validate every id against the discovered set before any setup, then keep only the
# named jobs. Named node files collapse into one node job (TEST_NODE_FILES, read by test-job.sh).
subset=0
unset TEST_NODE_FILES
if [ "$#" -gt 0 ]; then
  subset=1
  : > "$results/want"
  want_node=0
  node_files=""
  for id in "$@"; do
    id=${id#./}
    [ "$id" = "${id%/}" ] || id=${id%/}
    if [ "$id" = node ]; then
      want_node=1
      node_files=all
    elif grep -qxF "$id" "$nodefiles"; then
      want_node=1
      [ "$node_files" = all ] || node_files="$node_files $id"
    elif grep -qxF "$id" "$all"; then
      echo "$id" >> "$results/want"
    else
      echo "test: unknown id '$id'; use node, tests/<name>.test.js, a discovered *.test.sh suite path or a mod directory (plugins/<p>)" >&2
      exit 2
    fi
  done
  [ "$want_node" -eq 1 ] && echo node >> "$results/want"
  # Keep discovery order, drop duplicates.
  grep -xFf "$results/want" "$all" > "$results/sel"
  mv "$results/sel" "$all"
  if [ "$node_files" != all ]; then
    TEST_NODE_FILES=${node_files# }
    export TEST_NODE_FILES
  fi
fi

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

# Shard mode: keep job i (one numbering across the pool jobs, then the serial ones) when
# (i mod N) + 1 is K. A serial job stays in the serial list of its shard.
if [ -n "$shard" ]; then
  for f in jobs serial; do
    : > "$results/$f.shard"
  done
  cat "$results/jobs" "$results/serial" | awk -v n="$shard_n" -v k="$shard_k" '(NR - 1) % n == k - 1 { print NR }' > "$results/keep"
  njobs_all=$(wc -l < "$results/jobs" | tr -d ' ')
  while IFS= read -r i; do
    if [ "$i" -le "$njobs_all" ]; then
      sed -n "${i}p" "$results/jobs" >> "$results/jobs.shard"
    else
      sed -n "$((i - njobs_all))p" "$results/serial" >> "$results/serial.shard"
    fi
  done < "$results/keep"
  mv "$results/jobs.shard" "$results/jobs"
  mv "$results/serial.shard" "$results/serial"
fi

if [ "$list" -eq 1 ]; then
  cat "$results/jobs" "$results/serial" | sed 's/^sh scripts\/test-job\.sh //'
  exit 0
fi

# Shared per-run environment: anything exported here reaches every job. This is the one place
# for it, including the per-run sandbox for the jobs' event and state dirs
# (scripts/test-sandbox.sh). TMPDIR points inside the results dir (made under /tmp, whatever TMPDIR was inherited), so temp files created there
# by jobs that honour TMPDIR (even ones an interrupted job never got to clean up) are removed
# with it.
mkdir "$results/tmp" || exit 1
TEST_RESULTS_DIR=$results
TMPDIR=$results/tmp
export TEST_RESULTS_DIR TMPDIR
test_sandbox_setup || exit 1
# A real PostgreSQL for the database tests: FACTORY_TEST_PG_ADMIN_URL when it is set (CI), else
# a private cluster (scripts/test-pg.sh). Each test makes and drops its own database.
TEST_REPO_ROOT=$(pwd)
export TEST_REPO_ROOT
test_pg_setup || exit 1

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

# Isolation: nothing may have written into the sandboxed shared-state directories.
test_sandbox_check || failed=$((failed + 1))
# ... and no test may have left a database or a role on the server.
test_pg_check || failed=$((failed + 1))

if [ "$failed" -gt 0 ]; then
  echo "test: $failed failed" >&2
  exit 1
fi
node_total=$(cat "$results/node-total" 2>/dev/null || echo 0)
if [ "$subset" -eq 1 ]; then
  njobs=$(wc -l < "$all" | tr -d ' ')
  node_part=""
  grep -qxF node "$all" && node_part=" (${node_total} node tests)"
  echo "test: subset of $njobs jobs ok${node_part} - not the gate; run npm test$TEST_PG_NOTE"
  exit 0
fi
if [ -n "$shard" ]; then
  ids=$(cat "$results/jobs" "$results/serial" | sed 's/^sh scripts\/test-job\.sh //')
  s_suites=$(printf '%s\n' "$ids" | grep -c '\.test\.sh$')
  s_mods=$(printf '%s\n' "$ids" | grep -c '^plugins/')
  echo "test: shard $shard ok: ${node_total} node tests, $s_suites shell suites, $s_mods mods - one shard of the gate; run npm test for the whole gate$mod_note$TEST_PG_NOTE"
  exit 0
fi
echo "test: ${node_total} node tests, $suites shell suites, $mods mods ok$mod_note$TEST_PG_NOTE"
