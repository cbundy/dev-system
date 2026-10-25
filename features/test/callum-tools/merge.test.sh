#!/bin/sh
#
# Plain-shell tests for callum-flow-merge (cbundy/dev-system#219, #403). The shared stubs
# and real local origin live in merge-guard-lib.sh; the guard cases are in
# merge-guard.test.sh (split out by cbundy/dev-system#480 to keep each file under 30s).
# shellcheck disable=SC2015  # A && B || fail is the idiom here
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/merge-guard-lib.sh"

# the new store's log of the test repo (callum-flow-merge writes there only: --type ... --data)
nlog="$events/factory/o__r.jsonl"

# merge refuses when the PR head is not the approved patch, and merges nothing (moved here from merge-guard.test.sh)
reset
m 7 --patch 0000000000000000000000000000000000000001
if [ "$rc" != 1 ] || [ -f "$st/gh-calls" ] || [ -e "$events" ]; then fail "merge on another patch: $rc $out"; fi
printf '%s' "$out" | grep -q '^GUARD patch FAIL .* class=patch$' || fail "patch FAIL line: $out"
passed=$((passed + 1))

reset; echo closing > "$st/linkage-actual"; issue_brief 'run-it - x'; m 7
if [ "$rc" != 1 ] || [ -f "$st/gh-calls" ]; then fail "merge passes options through and refuses a closing PR on run-it: $rc $out"; fi
passed=$((passed + 1))

for mode in derived explicit skip; do
  reset; echo epic-x > "$st/base"; echo '[]' > "$st/closing"
  set -- --base epic-x
  case "$mode" in
    explicit) set -- "$@" --expect closing ;;
    skip) skip; set -- "$@" --issue 12 ;;
  esac
  m 7 "$@"
  [ "$rc" = 0 ] || fail "epic merge failed: $rc $out"
  case "$out" in *"Close issue #12 by hand with a comment naming merged PR #7"*) ;; *) fail "epic closure instruction missing: $out" ;; esac
  if ! { [ -f "$st/gh-calls" ] && [ -f "$nlog" ]; }; then
    fail "epic merge or event missing"
  fi
  [ ! -e "$events/o__r.jsonl" ] || fail "the old log must stay empty: $(cat "$events/o__r.jsonl")"
  passed=$((passed + 1))
done
for rollout in run-it keep-open; do
  reset; echo epic-x > "$st/base"; issue_brief "$rollout - x"; echo refs > "$st/linkage-actual"
  m 7 --base epic-x
  expect_pass "epic $rollout does not request closure"
done
reset; echo epic-x > "$st/base"; touch "$st/merge-refuse"; m 7 --base epic-x
if ! { [ "$rc" = 1 ] && [ -z "$out" ] && [ ! -e "$events" ]; }; then
  fail "refused epic merge requested closure: $rc $out"
fi
passed=$((passed + 1))

# merge with no known issue: the merge succeeds, a warning says so and no merged event is written
reset; echo 'MATCH #7 expect=closing via=api actual=[12]' > "$st/linkage"; m 7
[ "$rc" = 0 ] || fail "merge, no issue: exit $rc out=$out err=$(cat "$tmpdir/err")"
[ -f "$st/gh-calls" ] || fail "merge, no issue: not merged"
grep -q '^callum-flow-merge: warning: no issue known, merged event not recorded$' "$tmpdir/err" || fail "merge, no issue: no warning: $(cat "$tmpdir/err")"
[ ! -e "$nlog" ] && [ ! -e "$events/o__r.jsonl" ] || fail "merge, no issue: an event was written: $(cat "$nlog" 2> /dev/null)"
passed=$((passed + 1))

# merge: pass
reset; m 7
[ "$rc" = 0 ] || fail "merge pass: exit $rc out=$out"
[ -z "$out" ] || fail "default base should not request manual closure: $out"
[ "$(cat "$st/gh-calls")" = "pr merge 7 --squash --match-head-commit $SHA" ] || fail "merge call: $(cat "$st/gh-calls")"
[ "$(wc -l < "$nlog" | tr -d ' ')" = 1 ] || fail "one merged event expected"
jq -e --arg sha "$SHA" '.type == "merged" and .issue == 12 and .data == {pr: 7, branch: "feat/issue-12-x", head: $sha, by: "factory", recovered: false, files: ["a.js", "b/c.sh", "d.txt"], file_lines: [{path: "a.js", additions: 7, deletions: 1}, {path: "b/c.sh", additions: 3, deletions: 1}], additions: 10, deletions: 2, merged_at: "2026-10-02T09:00:00Z", title: null}' "$nlog" > /dev/null || fail "event: $(cat "$nlog")"
[ "$(cat "$st/size-calls")" = "pr view 7 --json files,additions,deletions,mergedAt" ] || fail "one size read expected: $(cat "$st/size-calls")"
! grep -q 'could not read the size' "$tmpdir/err" || fail "no size warning expected on success: $(cat "$tmpdir/err")"
[ ! -e "$events/o__r.jsonl" ] || fail "the old log must stay empty: $(cat "$events/o__r.jsonl")"
passed=$((passed + 1))

# merge: milestone tagging (cbundy/dev-system#403) runs once after the merge and never fails it
[ "$(cat "$st/milestone-calls")" = "tag 7" ] || fail "tag call: $(cat "$st/milestone-calls" 2> /dev/null)"
! grep -q 'milestone tagging failed' "$tmpdir/err" || fail "no warning expected on success: $(cat "$tmpdir/err")"
passed=$((passed + 1))
reset; echo 1 > "$st/milestone-rc"; m 7
[ "$rc" = 0 ] || fail "a failing tag must not fail the merge: $rc $out"
grep -q '^callum-flow-merge: warning: milestone tagging failed - the release reconcile step will catch it$' "$tmpdir/err" || fail "tag failure warning: $(cat "$tmpdir/err")"
[ "$(wc -l < "$nlog" | tr -d ' ')" = 1 ] || fail "merged event must still be recorded"
passed=$((passed + 1))
reset; MILESTONE_BIN="$tmpdir/does-not-exist" m 7
MILESTONE_BIN=''
[ "$rc" = 0 ] && grep -q 'milestone tagging failed' "$tmpdir/err" || fail "a missing helper only warns: $rc $(cat "$tmpdir/err")"
passed=$((passed + 1))
# the real helper against a gh that fails every milestone call after the merge
reset; MILESTONE_BIN="$MILESTONE_REAL" m 7
MILESTONE_BIN=''
[ "$rc" = 0 ] && grep -q 'milestone tagging failed' "$tmpdir/err" && [ -f "$st/gh-calls" ] || fail "a gh failure in tagging only warns: $rc $(cat "$tmpdir/err")"
passed=$((passed + 1))
# guard failure and a refused merge never tag
reset; echo '[]' > "$st/checks"; m 7
[ "$rc" = 1 ] && [ ! -e "$st/milestone-calls" ] || fail "a guard failure must not tag: $rc"
reset; touch "$st/merge-refuse"; m 7
[ "$rc" = 1 ] && [ ! -e "$st/milestone-calls" ] || fail "a refused merge must not tag: $rc"
passed=$((passed + 1))

# merge: a failing or unparseable size read warns, writes the three fields as null and still writes the event
for bad in fails junk partial nosize; do
  reset
  case "$bad" in
    fails) touch "$st/size-fails" ;;
    junk) echo 'not json' > "$st/size" ;;
    partial) echo '{"files":[{"path":"a.js"}]}' > "$st/size" ;;
    nosize) echo '{"mergedAt":"2026-10-02T09:00:00Z"}' > "$st/size" ;;
  esac
  m 7
  [ "$rc" = 0 ] || fail "size read $bad: exit $rc out=$out"
  grep -qx 'callum-flow-merge: warning: could not read the size of PR #7 - merged event written without it' "$tmpdir/err" || fail "size read $bad: no warning: $(cat "$tmpdir/err")"
  [ "$(wc -l < "$nlog" | tr -d ' ')" = 1 ] || fail "size read $bad: the event must still be written"
  # a bad size still gives merged_at when the read has one; a failed read or a missing mergedAt gives null
  case "$bad" in nosize) want_at='"2026-10-02T09:00:00Z"' ;; *) want_at=null ;; esac
  jq -e --arg sha "$SHA" --argjson at "$want_at" '.type == "merged" and .data == {pr: 7, branch: "feat/issue-12-x", head: $sha, by: "factory", recovered: false, files: null, file_lines: null, additions: null, deletions: null, merged_at: $at, title: null}' "$nlog" > /dev/null || fail "size read $bad: event: $(cat "$nlog")"
done
# the size is read after the merge only: a refused merge or a guard failure reads nothing
reset; touch "$st/merge-refuse"; m 7
[ ! -e "$st/size-calls" ] || fail "a refused merge read the size"
reset; echo '[]' > "$st/checks"; m 7
[ ! -e "$st/size-calls" ] || fail "a guard failure read the size"
passed=$((passed + 1))

# merge: WARN relayed to stderr, one test_weakened event per WEAKENED line (restored ones too)
reset; printf '%s\n%s\n' "$W1" "$W2" > "$st/weakening"; m 7
[ "$rc" = 0 ] || fail "merge with weakening: $rc $out"
grep -q '^GUARD test-weakening WARN ' "$tmpdir/err" || fail "WARN not relayed to stderr: $(cat "$tmpdir/err")"
[ -f "$st/gh-calls" ] || fail "a WARN must not stop the merge"
[ "$(jq -s '[.[] | select(.type == "test_weakened")] | length' "$nlog")" = 2 ] || fail "two test_weakened events expected: $(cat "$nlog")"
jq -e -s --arg sha "$SHA" '.[] | select(.type == "test_weakened") | select(.issue == 12 and .data == {branch: "feat/issue-12-x", pr: 7, head: $sha, commit: $sha[0:7], restored: false, kinds: ["removed-assertion", "warn-only"], files: ["tests/a.test.js", "tests/b.test.sh"]})' "$nlog" > /dev/null || fail "first test_weakened event: $(cat "$nlog")"
jq -e -s --arg sha "$SHA" '.[] | select(.type == "test_weakened") | select(.data == {branch: "feat/issue-12-x", pr: 7, head: $sha, commit: "1234567", restored: true, kinds: ["skip"], files: ["tests/c.test.js"]})' "$nlog" > /dev/null || fail "restored test_weakened event: $(cat "$nlog")"
[ ! -e "$events/o__r.jsonl" ] || fail "the old log must stay empty: $(cat "$events/o__r.jsonl")"
passed=$((passed + 1))
reset; printf '%s\n' "$W1" > "$st/weakening"; touch "$st/merge-refuse"; m 7
if [ "$rc" != 1 ] || [ -e "$events" ]; then fail "a refused merge must log no test_weakened event: $rc $(cat "$nlog" 2> /dev/null)"; fi
reset; m 7
[ "$(jq -s '[.[] | select(.type == "test_weakened")] | length' "$nlog")" = 0 ] || fail "nothing flagged, no event"
passed=$((passed + 1))

# merge: method override, flag and env
reset; m 7 --base main --expect closing; expect_pass "explicit default base does not request closure"
reset; m 7 --method rebase; grep -q -- '--rebase' "$st/gh-calls" || fail "--method rebase"
reset; CALLUM_FLOW_MERGE_METHOD=merge m 7; grep -q -- ' --merge ' "$st/gh-calls" || fail "env method"
reset; m 7 --method bogus; [ "$rc" = 2 ] || fail "bad method exits 2"
passed=$((passed + 1))

# merge: guard failure merges nothing and logs nothing
reset; echo '[]' > "$st/checks"; m 7
if [ "$rc" != 1 ]; then fail "merge on fail: $rc $out"; fi
printf '%s' "$out" | grep -q '^GUARD checks FAIL' || fail "merge on fail: $out"
if [ -f "$st/gh-calls" ] || [ -e "$events" ]; then fail "merge on fail must not merge or log"; fi
passed=$((passed + 1))

# merge: refused by GitHub, head moved
reset; touch "$st/merge-refuse"; printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' > "$st/refuse-prhead"; m 7
if [ "$rc" != 1 ] || [ -e "$events" ]; then fail "refused merge (head moved): $rc"; fi
grep -q "head moved since the check (verified $(printf %.7s "$SHA"), now bbbbbbb) - re-gate" "$tmpdir/err" || fail "head moved message: $(cat "$tmpdir/err")"
grep -q 'GraphQL: refused' "$tmpdir/err" || fail "gh stderr should still show: $(cat "$tmpdir/err")"
passed=$((passed + 1))

# merge: refused by GitHub, head unchanged but the branch fell behind
reset; touch "$st/merge-refuse"; echo BEHIND > "$st/refuse-mss"; m 7
if [ "$rc" != 1 ] || [ -e "$events" ]; then fail "refused merge (behind): $rc"; fi
grep -q "GitHub refused: merge state BEHIND (branch rule) - see the guard's mergeable action" "$tmpdir/err" || fail "behind message: $(cat "$tmpdir/err")"
grep -q 'head moved' "$tmpdir/err" && fail "unmoved head must not say head moved"
passed=$((passed + 1))

# merge: a guard failing on mergeable never calls gh pr merge
reset; echo BEHIND > "$st/mss"; m 7
if [ "$rc" != 1 ] || [ -f "$st/gh-calls" ] || [ -e "$events" ]; then fail "merge on behind: $rc $out"; fi
printf '%s' "$out" | grep -q '^GUARD mergeable FAIL behind' || fail "merge on behind: $out"
passed=$((passed + 1))

echo "merge: $passed groups passed"
