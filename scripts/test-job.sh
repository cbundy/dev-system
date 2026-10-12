#!/bin/sh
# One job of the parallel test run (scripts/test.sh, via scripts/test-pool.sh).
#
# Usage: test-job.sh <id>, where <id> is
#   node           the node test step (tests/*.test.js)
#   <path>.test.sh a plain-shell suite
#   <plugin dir>   a mod: `claude plugin validate` then `claude plugin test`
#
# A passing job is silent. A failing job prints its report (what the serial runner used to
# print) and exits with its failure count: node failures count per failing test, a node crash
# counts 1, a failing suite or mod counts 1. Counts are capped at 100 so the exit code stays
# well below 126, where the pool treats a code as a crash and counts 1.
#
# Node writes its test total to $TEST_RESULTS_DIR/node-total for the summary line.
set -u

cd "$(dirname "$0")/.." || exit 1

id=${1:?usage: test-job.sh <id>}
out=$(mktemp) || exit 1
trap 'rm -f "$out"' EXIT

cap() { [ "$1" -gt 100 ] && echo 100 || echo "$1"; }

case $id in
  node)
    # The reporter's last line is `node-tests: <total> total, <failed> failed`.
    node --test --test-reporter=./scripts/test-reporter.js tests/*.test.js > "$out" 2>&1
    node_status=$?
    summary=$(tail -n 1 "$out")
    node_total=$(printf '%s\n' "$summary" | sed -n 's/^node-tests: \([0-9][0-9]*\) total, \([0-9][0-9]*\) failed$/\1/p')
    node_failed=$(printf '%s\n' "$summary" | sed -n 's/^node-tests: \([0-9][0-9]*\) total, \([0-9][0-9]*\) failed$/\2/p')
    [ -n "${TEST_RESULTS_DIR:-}" ] && [ -n "$node_total" ] && printf '%s\n' "$node_total" > "$TEST_RESULTS_DIR/node-total"
    if [ "$node_status" -ne 0 ] || [ -z "$node_total" ]; then
      # A failure the reporter could not count (e.g. node itself failed) still counts as one.
      [ -n "$node_failed" ] && [ "$node_failed" -gt 0 ] || node_failed=1
      sed '$d' "$out"
      [ -n "$node_total" ] || printf '%s\n' "$summary"
      exit "$(cap "$node_failed")"
    fi
    ;;
  *.test.sh)
    if ! sh "$id" > "$out" 2>&1; then
      echo "FAIL $id"
      sed 's/^/    /' "$out"
      exit 1
    fi
    ;;
  *)
    if ! { claude plugin validate "$id" && claude plugin test "$id"; } > "$out" 2>&1; then
      echo "FAIL $id (claude plugin validate / test)"
      sed 's/^/    /' "$out"
      exit 1
    fi
    ;;
esac
exit 0
