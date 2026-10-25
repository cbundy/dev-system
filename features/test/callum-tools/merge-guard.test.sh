#!/bin/sh
#
# Plain-shell tests for callum-flow-merge-guard (cbundy/dev-system#219), which has one mode, the factory
# loop's --patch (g in merge-guard-lib.sh adds it). The patch guard itself is pinned in
# merge-guard-patch.test.sh. The shared stubs
# and real local origin live in merge-guard-lib.sh; the callum-flow-merge cases are in
# merge.test.sh (split out by cbundy/dev-system#480 to keep each file under 30s).
# shellcheck disable=SC2015  # A && B || fail is the idiom here
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/merge-guard-lib.sh"

reset; g 7; expect_pass "all pass"
reset; echo '[]' > "$st/checks"; g 7; expect_fail "zero checks" checks; expect_class checks checks
reset; echo '[{"name":"ci","bucket":"pending"}]' > "$st/checks"; echo 8 > "$st/checks-rc"; g 7; expect_fail "pending" checks
printf '%s' "$out" | grep -q 'ci=pending' || fail "checks reason should name the check"
reset; echo '[{"name":"ci","bucket":"pass"},{"name":"lint","bucket":"skipping"}]' > "$st/checks"; g 7; expect_pass "skipping mixed"
# a workflow run with no job yet is in no check list: the guard reads the head's runs too
reset; echo '{"total_count":1,"workflow_runs":[{"id":5,"workflow_id":2,"event":"push","name":"Deploy","status":"in_progress","conclusion":null}]}' > "$st/runs"; g 7; expect_fail "run in progress" checks
printf '%s' "$out" | grep -q 'workflow Deploy=pending' || fail "runs reason should name the workflow: $out"
reset; echo '{"total_count":1,"workflow_runs":[{"id":5,"workflow_id":2,"event":"push","name":"Deploy","status":"completed","conclusion":"failure"}]}' > "$st/runs"; g 7; expect_fail "run failed" checks
reset; echo '{"total_count":2,"workflow_runs":[{"id":5,"workflow_id":2,"event":"push","name":"Deploy","status":"completed","conclusion":"cancelled"},{"id":6,"workflow_id":2,"event":"push","name":"Deploy","status":"completed","conclusion":"success"}]}' > "$st/runs"; g 7; expect_pass "superseded cancelled run"
reset; echo 'HTTP 502: Bad Gateway' > "$st/runs-err"; g 7; expect_fail "runs unread" checks
reset; echo 'MISMATCH #7 issue=#12 expect=closing' > "$st/linkage"; echo 1 > "$st/linkage-rc"; g 7; expect_fail "linkage" linkage; expect_class linkage linkage
printf '%s' "$out" | grep -q 'MISMATCH #7' || fail "linkage reason should carry the report"
reset; echo main-ish > "$st/base"; echo 'MATCH #7 issue=#12' > "$st/linkage"; g 7; expect_fail "base" base; expect_class base policy

# mergeable (cbundy/dev-system#246): the regression is #237, OPEN MERGEABLE BEHIND
reset; echo BEHIND > "$st/mss"; g 7; expect_fail "behind" mergeable
[ "$out" = "GUARD mergeable FAIL behind main class=behind" ] || fail "behind reason: $out"
reset; echo DIRTY > "$st/mss"; echo CONFLICTING > "$st/pmergeable"; g 7; expect_fail "dirty" mergeable
[ "$out" = "GUARD mergeable FAIL conflicts with main class=conflict" ] || fail "dirty reason: $out"
reset; echo UNKNOWN > "$st/mss"; echo CONFLICTING > "$st/pmergeable"; g 7; expect_fail "conflicting, state unknown" mergeable
printf '%s' "$out" | grep -q 'conflicts with main' || fail "conflicting reason: $out"
[ "$(cat "$st/view-count")" = 1 ] || fail "conflicting must not retry"
reset; echo BEHIND > "$st/mss"; echo CONFLICTING > "$st/pmergeable"; g 7; expect_fail "behind and conflicting" mergeable
printf '%s' "$out" | grep -q 'conflicts with main' || fail "conflict reason wins: $out"
reset; echo BLOCKED > "$st/mss"; g 7; expect_fail "blocked" mergeable
printf '%s' "$out" | grep -q 'branch rules not met' || fail "blocked reason: $out"
expect_class mergeable read
reset; echo DRAFT > "$st/mss"; g 7; expect_fail "draft" mergeable
printf '%s' "$out" | grep -q 'PR is a draft' || fail "draft reason: $out"
expect_class mergeable policy
reset; echo BLOCKED > "$st/mss"; echo true > "$st/isdraft"; g 7; expect_fail "draft reporting BLOCKED" mergeable
printf '%s' "$out" | grep -q 'PR is a draft' || fail "isDraft reason: $out"
for s in MERGED CLOSED; do
  reset; echo "$s" > "$st/pstate"; echo UNKNOWN > "$st/mss"; g 7; expect_fail "state $s" mergeable
  printf '%s' "$out" | grep -q "GUARD mergeable FAIL PR is $s class=read\$" || fail "$s reason: $out"
  [ "$(cat "$st/view-count")" = 1 ] || fail "$s must not retry"
done
reset; echo UNKNOWN > "$st/mss"; g 7; expect_fail "unknown persists" mergeable
printf '%s' "$out" | grep -q 'GitHub has not computed mergeability, retry' || fail "unknown reason: $out"
[ "$(cat "$st/view-count")" = 3 ] || fail "unknown should read 3 times, read $(cat "$st/view-count")"
reset; printf 'UNKNOWN\nCLEAN\n' > "$st/mss-seq"; g 7; expect_pass "unknown then clean"
[ "$(cat "$st/view-count")" = 2 ] || fail "unknown then clean: reads $(cat "$st/view-count")"
for s in CLEAN UNSTABLE HAS_HOOKS; do reset; echo "$s" > "$st/mss"; g 7; expect_pass "mss $s"; done

# two guards at once: no short-circuit
reset; echo '[]' > "$st/checks"; echo BEHIND > "$st/mss"; g 7; expect_fail "two guards" checks mergeable
expect_class checks checks; expect_class mergeable behind

# unreachable origin: the test-weakening detector cannot fetch the base, which is only a WARN, never a pass on a stale ref
reset
mv "$origin" "$origin.gone"
g 7
mv "$origin.gone" "$origin"
[ "$rc" = 0 ] && [ "$out" = "GUARD test-weakening WARN detector error: cannot fetch origin/main" ] || fail "unreachable origin: rc=$rc out=$out"
passed=$((passed + 1))

# SKIP: the branch names no issue, so --issue N and the PR linkage decide
reset; skip; g 7; expect_fail "skip without --issue" linkage
reset; skip; g 7 --issue 12; expect_pass "skip default base, closes N"
reset; skip; echo '[13]' > "$st/closing"; g 7 --issue 12; expect_fail "skip default base, closes other" linkage
reset; skip; echo '[]' > "$st/closing"; g 7 --issue 12; expect_fail "skip default base, closes nothing" linkage
reset; skip; printf 'Closes #12\nFixes #13\n' > "$st/body"; g 7 --issue 12; expect_fail "skip closes extra" linkage
reset; skip; echo epic-x > "$st/base"; echo '[]' > "$st/closing"; g 7 --issue 12 --base epic-x; expect_pass "skip epic, body closes N"
reset; skip; echo epic-x > "$st/base"; echo '[]' > "$st/closing"; echo 'Refs #12' > "$st/body"; g 7 --issue 12 --base epic-x; expect_fail "skip epic, no closing keyword" linkage
reset; skip; echo epic-x > "$st/base"; g 7 --base epic-x; expect_fail "skip epic without --issue" linkage
reset; skip; refs_issue; echo 'Refs #12' > "$st/body"; echo '[]' > "$st/closing"; g 7 --issue 12 --expect refs; expect_pass "skip refs"
reset; skip; refs_issue; echo 'Part of #12' > "$st/body"; echo '[]' > "$st/closing"; g 7 --issue 12 --expect refs; expect_pass "skip part of"
reset; skip; refs_issue; echo 'nothing' > "$st/body"; echo '[]' > "$st/closing"; g 7 --issue 12 --expect refs; expect_fail "skip refs missing" linkage
reset; skip; refs_issue; echo 'Refs #12' > "$st/body"; g 7 --issue 12 --expect refs; expect_fail "skip refs but closes" linkage

# rollout (cbundy/dev-system#239): the linkage expectation follows the issue
# the #219 regression: PR #236 said Closes #219, whose body has a Run it heading
reset; printf '%s\n' '{"body":"Do it.\n\n## Run it\nrelease then run","comments":[{"body":"## Design brief\n\n## Risk\nlow"}]}' > "$st/issue.json"
echo closing > "$st/linkage-actual"
g 7; expect_fail "closing PR on a Run it issue, no --expect" linkage
printf '%s' "$out" | grep -q 'MISMATCH #7 issue=#12 expect=refs' || fail "linkage should be checked as refs: $out"
reset; echo closing > "$st/linkage-actual"; issue_brief 'run-it - the issue'"'"'s own Run it'; g 7; expect_fail "run-it brief, closing PR" linkage
reset; issue_brief 'run-it - x'; echo refs > "$st/linkage-actual"; g 7; expect_pass "run-it brief, refs PR"
reset; echo closing > "$st/linkage-actual"; issue_brief 'merge - plain'; g 7; expect_pass "merge brief, closing PR"
reset; issue_brief 'keep-open - research'; echo refs > "$st/linkage-actual"; g 7; expect_pass "keep-open brief, refs PR"
reset; echo closing > "$st/linkage-actual"; issue_brief 'run-it - x'; g 7 --expect closing; expect_fail "explicit closing on run-it" rollout
printf '%s' "$out" | grep -q 'contradicts #12' || fail "contradiction reason: $out"
reset; echo closing > "$st/linkage-actual"; issue_brief 'merge - x'; g 7 --expect refs; expect_fail "explicit refs on merge" rollout linkage
reset; issue_brief 'run-it - x'; echo refs > "$st/linkage-actual"; g 7 --expect refs; expect_pass "explicit agreeing --expect"
reset; echo closing > "$st/linkage-actual"; issue_brief 'merge - x' 'Do it.

## Run it
go'; g 7; expect_fail "rollout conflict fails closed" rollout
printf '%s' "$out" | grep -q 'ROLLOUT conflict' || fail "conflict reason: $out"
reset; ROLLOUT_BIN=/bin/false; g 7; expect_fail "derivation failure" rollout; expect_class rollout read
reset; echo 'not json' > "$st/issue.json"; g 7; expect_fail "unreadable issue" rollout
reset; echo bogus/branch > "$st/branch"; echo 'SKIP #7 feat' > "$st/linkage"; g 7; expect_fail "no issue to derive from" rollout; expect_class rollout policy
reset; issue_brief 'run-it - x'; echo 'SKIP #7 feat' > "$st/linkage"; echo '[]' > "$st/closing"; echo 'Refs #12' > "$st/body"; g 7 --issue 12; expect_pass "--issue drives the derivation"

# epic base
reset; echo epic-x > "$st/base"; g 7; expect_fail "epic without --base" base
for want in "confirm that with the brief" "rerun with --base epic-x"; do
  case "$out" in *"$want"*) ;; *) fail "epic base recovery missing ($want): $out" ;; esac
done
reset; echo epic-x > "$st/base"; g 7 --base epic-x; expect_pass "epic with --base"
reset; echo epic-x > "$st/base"; g 7 --base wrong; expect_fail "epic with incorrect --base" base
case "$out" in *"rerun with --base epic-x"*) ;; *) fail "incorrect override recovery missing: $out" ;; esac

# test-weakening (cbundy/dev-system#314): advisory, never fails the guard
reset; g 7; expect_pass "no weakening"
[ "$(cat "$st/weakening-args")" = "--base origin/main --head $SHA" ] || fail "detector arguments: $(cat "$st/weakening-args")"
reset; printf '%s\n' "$W1" > "$st/weakening"; g 7
[ "$rc" = 0 ] || fail "WARN must not fail the guard: $rc $out"
want="GUARD test-weakening WARN $(printf %.7s "$SHA") files=tests/a.test.js,tests/b.test.sh kinds=removed-assertion,warn-only - have the adjudicator judge it against the brief; restore via fixer unless the removal is justified"
[ "$out" = "$want" ] || fail "WARN line: [$out]"
passed=$((passed + 1))
reset; printf '%s\n' "$W2" > "$st/weakening"; g 7; expect_pass "restored weakening prints nothing"
reset; printf '%s\n%s\n' "$W1" "$W2" > "$st/weakening"; echo '[]' > "$st/checks"; g 7
[ "$rc" = 1 ] && [ "$(printf '%s\n' "$out" | grep -c '^GUARD test-weakening WARN ')" = 1 ] && printf '%s\n' "$out" | grep -q '^GUARD checks FAIL ' || fail "WARN beside a FAIL: $rc $out"
passed=$((passed + 1))
reset; echo 'fatal: bad object' > "$st/weakening"; echo 1 > "$st/weakening-rc"; g 7
[ "$rc" = 0 ] && [ "$out" = "GUARD test-weakening WARN detector error: fatal: bad object" ] || fail "detector error: $rc [$out]"
passed=$((passed + 1))
reset; printf '%s\n' "$W1" > "$st/weakening"; g 7 --emit-verified
[ "$rc" = 0 ] && printf '%s\n' "$out" | grep -q '^VERIFIED ' && printf '%s\n' "$out" | grep -q "^WEAKENED commit=$SHA " || fail "emit-verified carries the WEAKENED lines: $out"
passed=$((passed + 1))

# usage errors
reset
for args in "7 --expect closes" "7 --bogus" "" "x" "7" "7 --emit-verified" "7 --patch" "7 --patch xyz" "7 --run RUN1" "7 --update-behind" "7 --patch $STUB_PID --run RUN1" "7 --patch $STUB_PID --update-behind" "7 --update-behind --expect closing"; do
  rc=0
  # shellcheck disable=SC2086
  PATH="$toolbin" "$SH" "$GUARD" $args > /dev/null 2>&1 || rc=$?
  [ "$rc" = 2 ] || fail "usage '$args' should exit 2, got $rc"
done
passed=$((passed + 1))
# the modes that were removed are refused with one usage line naming only the --patch form, before
# any gh call
cat > "$tmpdir/gh-never" <<'STUB'
#!/bin/sh
echo "$*" >> "${STUB_DIR:?}/gh-never-calls"
exit 1
STUB
chmod +x "$tmpdir/gh-never"
for args in "7" "7 --run RUN1" "7 --update-behind" "7 --patch $STUB_PID --run RUN1" "7 --patch $STUB_PID --update-behind"; do
  rc=0
  # shellcheck disable=SC2086
  PATH="$toolbin" STUB_DIR="$st" CALLUM_FLOW_GH_BIN="$tmpdir/gh-never" "$SH" "$GUARD" $args > "$tmpdir/o" 2> "$tmpdir/e" || rc=$?
  [ "$rc" = 2 ] && [ ! -s "$tmpdir/o" ] || fail "'$args': rc=$rc out=$(cat "$tmpdir/o")"
  [ "$(grep -c '^usage:' "$tmpdir/e")" = 1 ] || fail "'$args': want one usage line: $(cat "$tmpdir/e")"
  grep -q '^usage: callum-flow-merge-guard <pr> --patch ID ' "$tmpdir/e" || fail "'$args': usage names the --patch form: $(cat "$tmpdir/e")"
  ! grep '^usage:' "$tmpdir/e" | grep -q -e '--run' -e '--update-behind' || fail "'$args': usage names a removed mode: $(cat "$tmpdir/e")"
  [ ! -e "$st/gh-never-calls" ] || fail "'$args' called gh: $(cat "$st/gh-never-calls")"
done
passed=$((passed + 1))

# the dry-run guard never merges or logs
reset; g 7 --emit-verified
if [ "$rc" != 0 ] || [ -f "$st/gh-calls" ] || [ -e "$events" ]; then fail "guard must be read-only"; fi
passed=$((passed + 1))

# trust (cbundy/dev-system#310): the author guard, and a stranger's text is never read
STRANGER='{"login":"mallory","id":999}'
reset; echo "$STRANGER" > "$st/pauthor"; g 7; expect_fail "stranger-authored PR" author; expect_class author policy
printf '%s' "$out" | grep -q 'not opened by a trusted author' || fail "author reason: $out"
reset; echo "$STRANGER" > "$st/pauthor"; : > "$st/view-count"; g 7 --expect closing; expect_fail "stranger PR with --expect" author
reset; echo '{"login":"cbundy","id":1}' > "$st/pauthor"; g 7; expect_fail "right login, wrong id" author
reset; CALLUM_FLOW_TRUSTED_AUTHORS='' g 7; expect_fail "trusted list unset fails closed" author; expect_class author read
printf '%s' "$out" | grep -q 'cannot verify the author' || fail "unverifiable reason: $out"
reset; CALLUM_FLOW_ISSUE_READ_BIN="$tmpdir/missing-reader" g 7; expect_fail "missing reader fails closed" author
# a stranger's merge brief cannot flip a keep-open issue to closing
reset; issue_brief 'keep-open - part 1 of 2'
jq --argjson u "$STRANGER" '.comments += [{user: $u, body: "## Design brief\n\n## Rollout\nmerge - fake\n\n## Open decisions\nnone"}]' "$st/issue.json" > "$st/i.tmp" && mv "$st/i.tmp" "$st/issue.json"
echo closing > "$st/linkage-actual"; g 7; expect_fail "stranger's brief cannot flip linkage" linkage
printf '%s' "$out" | grep -q 'expect=refs' || fail "linkage should still expect refs: $out"
echo refs > "$st/linkage-actual"; g 7; expect_pass "trusted keep-open brief still wins"
# a stranger's brief alone does not make a Run it issue closing
reset; printf '%s\n' '{"body":"Do it.\n\n## Run it\nrelease","comments":[]}' > "$st/issue.json"
jq --argjson u "$STRANGER" '.comments += [{user: $u, body: "## Design brief\n\n## Rollout\nmerge - fake\n\n## Open decisions\nnone"}]' "$st/issue.json" > "$st/i.tmp" && mv "$st/i.tmp" "$st/issue.json"
echo closing > "$st/linkage-actual"; g 7; expect_fail "stranger's merge brief vs Run it body" linkage

echo "merge-guard: $passed groups passed"
