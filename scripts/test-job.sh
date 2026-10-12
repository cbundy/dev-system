#!/bin/sh
# One job of the parallel test run (scripts/test.sh, via scripts/test-pool.sh).
#
# Usage: test-job.sh <id>, where <id> is
#   node           the node test step (tests/*.test.js)
#   <path>.test.sh a plain-shell suite
#   <plugin dir>   a mod: `claude plugin validate` then `claude plugin test`
#
# A passing job is silent. A failing job prints its report (what the serial runner used to
# print) and exits 1. Node failures count per failing test, written to $TEST_JOB_FAILED for the
# pool (scripts/test-pool.sh); a node crash, a failing suite or a failing mod counts 1.
#
# Node writes its test total to $TEST_RESULTS_DIR/node-total for the summary line.
set -u

cd "$(dirname "$0")/.." || exit 1

id=${1:?usage: test-job.sh <id>}
out=$(mktemp) || exit 1
trap 'rm -f "$out"' EXIT

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
      [ -n "${TEST_JOB_FAILED:-}" ] && printf '%s\n' "$node_failed" > "$TEST_JOB_FAILED"
      exit 1
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
