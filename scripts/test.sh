#!/bin/sh
# Canonical test entrypoint (`npm test`; CLAUDE.md "Canonical commands").
#
# Runs every node test (tests/*.test.js) and every plain-shell suite
# (features/test/callum-tools/*.test.sh, coder/test/*.test.sh). Both are discovered by
# glob, so a new test file needs no wiring here.
#
# Quiet on success: one summary line. On failure it prints only the failing node tests
# (name, file:line, assertion - see scripts/test-reporter.js) and the output of each
# failing shell suite, then `test: N failed`, and exits non-zero.
set -u

cd "$(dirname "$0")/.." || exit 1

failed=0
out=$(mktemp) || exit 1
trap 'rm -f "$out"' EXIT

# Node tests. The reporter's last line is `node-tests: <total> total, <failed> failed`.
node --test --test-reporter=./scripts/test-reporter.js tests/*.test.js > "$out" 2>&1
node_status=$?
summary=$(tail -n 1 "$out")
node_total=$(printf '%s\n' "$summary" | sed -n 's/^node-tests: \([0-9][0-9]*\) total, \([0-9][0-9]*\) failed$/\1/p')
node_failed=$(printf '%s\n' "$summary" | sed -n 's/^node-tests: \([0-9][0-9]*\) total, \([0-9][0-9]*\) failed$/\2/p')
if [ "$node_status" -ne 0 ] || [ -z "$node_total" ]; then
  # A failure the reporter could not count (e.g. node itself failed) still counts as one.
  [ -n "$node_failed" ] && [ "$node_failed" -gt 0 ] || node_failed=1
  sed '$d' "$out" >&2
  [ -n "$node_total" ] || printf '%s\n' "$summary" >&2
  failed=$((failed + node_failed))
fi

# Shell suites: output is shown only for a suite that fails.
suites=0
for suite in features/test/callum-tools/*.test.sh coder/test/*.test.sh; do
  [ -f "$suite" ] || continue
  suites=$((suites + 1))
  if ! sh "$suite" > "$out" 2>&1; then
    echo "FAIL $suite" >&2
    sed 's/^/    /' "$out" >&2
    failed=$((failed + 1))
  fi
done

if [ "$failed" -gt 0 ]; then
  echo "test: $failed failed" >&2
  exit 1
fi
echo "test: ${node_total} node tests, $suites shell suites ok"
