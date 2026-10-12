#!/bin/sh
#
# Plain-shell tests for callum-flow-merge-guard (cbundy/dev-system#219). The shared stubs
# and real local origin live in merge-guard-lib.sh; the callum-flow-merge cases are in
# merge.test.sh (split out by cbundy/dev-system#480 to keep each file under 30s).
# shellcheck disable=SC2015  # A && B || fail is the idiom here
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/merge-guard-lib.sh"

reset; g 7; expect_pass "all pass"
reset; g 7 --run RUN1; expect_pass "explicit run"

reset
git -C "$work" commit -q --allow-empty -m unpushed
LOCAL=$(git -C "$work" rev-parse HEAD)
g 7; expect_fail "worktree ahead, automatic run" head
printf '%s' "$out" | grep -q "worktree=$LOCAL" || fail "worktree head missing: $out"
g 7 --run RUN1; expect_fail "worktree ahead, explicit run" head
git -C "$work" reset -q --hard "$SHA"
reset
git -C "$work" reset -q --hard HEAD^
g 7; expect_fail "worktree behind" head
case "$out" in *"git merge --ff-only origin/<branch>"*) ;; *) fail "worktree recovery missing: $out" ;; esac
git -C "$work" merge -q --ff-only "origin/$B"
g 7; expect_pass "fast-forwarded worktree"
git -C "$work" checkout -q main
g 7; expect_pass "unrelated checkout, no implementation worktree"
git -C "$work" worktree add -q "$tmpdir/implementation slot" "$B"
git -C "$tmpdir/implementation slot" commit -q --allow-empty -m unpushed
g 7; expect_fail "implementation worktree from main checkout" head
git -C "$tmpdir/implementation slot" reset -q --hard "$SHA"
g 7; expect_pass "aligned implementation worktree from main checkout"
git -C "$work" worktree remove "$tmpdir/implementation slot"
git -C "$work" checkout -q "$B"

# the run lookup (cbundy/dev-system#243): real-format stub, no --run
reset; g 7 --emit-verified
if [ "$rc" != 0 ] || ! printf '%s' "$out" | grep -q ' run=RUN1 '; then fail "worktree lookup: rc=$rc out=$out"; fi
passed=$((passed + 1))
reset; touch "$st/table"; g 7 --emit-verified
if [ "$rc" != 0 ] || ! printf '%s' "$out" | grep -q ' run=RUN1 '; then fail "run table lookup (quoted head): rc=$rc out=$out"; fi
passed=$((passed + 1))
reset; touch "$st/norun"; g 7 --emit-verified; expect_fail "branch with no run" head gates
printf '%s' "$out" | grep -q 'no pipeline run found' || fail "no run reason: $out"
reset; touch "$st/nm-fail"; g 7; expect_fail "lookup failure" head gates
printf '%s' "$out" | grep -q 'no pipeline run found' || fail "lookup failure reason: $out"

reset; echo 'ci,awaiting_approval,0' > "$st/step"; g 7; expect_fail "gates" gates
reset; echo failed > "$st/runstatus"; g 7; expect_fail "gates failed" gates
reset; echo '[]' > "$st/checks"; g 7; expect_fail "zero checks" checks
reset; echo '[{"name":"ci","bucket":"pending"}]' > "$st/checks"; echo 8 > "$st/checks-rc"; g 7; expect_fail "pending" checks
printf '%s' "$out" | grep -q 'ci=pending' || fail "checks reason should name the check"
reset; echo '[{"name":"ci","bucket":"pass"},{"name":"lint","bucket":"skipping"}]' > "$st/checks"; g 7; expect_pass "skipping mixed"
reset; echo 'MISMATCH #7 issue=#12 expect=closing' > "$st/linkage"; echo 1 > "$st/linkage-rc"; g 7; expect_fail "linkage" linkage
printf '%s' "$out" | grep -q 'MISMATCH #7' || fail "linkage reason should carry the report"
reset; echo bogus > "$st/prhead"; g 7; expect_fail "pr head differs" head
reset; echo main-ish > "$st/base"; echo 'MATCH #7 issue=#12' > "$st/linkage"; g 7; expect_fail "base" base

# mergeable (cbundy/dev-system#246): the regression is #237, OPEN MERGEABLE BEHIND
reset; echo BEHIND > "$st/mss"; g 7; expect_fail "behind" mergeable
printf '%s' "$out" | grep -q 'GUARD mergeable FAIL behind main, run .callum-flow-merge-guard <pr> --update-behind. first' || fail "behind reason: $out"
for want in "--update-behind" "only if it fails, re-gate" "git rebase origin/<base>" "axi abort" "fresh backgrounded 'axi run" "head equals the rebased HEAD"; do
  case "$out" in *"$want"*) ;; *) fail "behind FAIL should name the fix ($want): $out" ;; esac
done
reset; echo DIRTY > "$st/mss"; echo CONFLICTING > "$st/pmergeable"; g 7; expect_fail "dirty" mergeable
printf '%s' "$out" | grep -q 'conflicts with main, rebase and re-gate' || fail "dirty reason: $out"
reset; echo UNKNOWN > "$st/mss"; echo CONFLICTING > "$st/pmergeable"; g 7; expect_fail "conflicting, state unknown" mergeable
printf '%s' "$out" | grep -q 'conflicts with main' || fail "conflicting reason: $out"
[ "$(cat "$st/view-count")" = 1 ] || fail "conflicting must not retry"
reset; echo BEHIND > "$st/mss"; echo CONFLICTING > "$st/pmergeable"; g 7; expect_fail "behind and conflicting" mergeable
printf '%s' "$out" | grep -q 'conflicts with main' || fail "conflict reason wins: $out"
reset; echo BLOCKED > "$st/mss"; g 7; expect_fail "blocked" mergeable
printf '%s' "$out" | grep -q 'branch rules not met' || fail "blocked reason: $out"
reset; echo DRAFT > "$st/mss"; g 7; expect_fail "draft" mergeable
printf '%s' "$out" | grep -q 'PR is a draft' || fail "draft reason: $out"
reset; echo BLOCKED > "$st/mss"; echo true > "$st/isdraft"; g 7; expect_fail "draft reporting BLOCKED" mergeable
printf '%s' "$out" | grep -q 'PR is a draft' || fail "isDraft reason: $out"
for s in MERGED CLOSED; do
  reset; echo "$s" > "$st/pstate"; echo UNKNOWN > "$st/mss"; g 7; expect_fail "state $s" mergeable
  printf '%s' "$out" | grep -q "GUARD mergeable FAIL PR is $s\$" || fail "$s reason: $out"
  [ "$(cat "$st/view-count")" = 1 ] || fail "$s must not retry"
done
reset; echo UNKNOWN > "$st/mss"; g 7; expect_fail "unknown persists" mergeable
printf '%s' "$out" | grep -q 'GitHub has not computed mergeability, retry' || fail "unknown reason: $out"
[ "$(cat "$st/view-count")" = 3 ] || fail "unknown should read 3 times, read $(cat "$st/view-count")"
reset; printf 'UNKNOWN\nCLEAN\n' > "$st/mss-seq"; g 7; expect_pass "unknown then clean"
[ "$(cat "$st/view-count")" = 2 ] || fail "unknown then clean: reads $(cat "$st/view-count")"
for s in CLEAN UNSTABLE HAS_HOOKS; do reset; echo "$s" > "$st/mss"; g 7; expect_pass "mss $s"; done

# two guards at once: no short-circuit
reset; echo '[]' > "$st/checks"; echo 'ci,awaiting_approval,0' > "$st/step"; g 7; expect_fail "two guards" checks gates

# phantom-gated run: origin moved after the run
reset
(cd "$work" && git commit -q --allow-empty -m later && git push -q origin "$B")
NEW=$(git -C "$work" rev-parse HEAD)
echo "$NEW" > "$st/prhead"
g 7; expect_fail "stale run head" head
case "$out" in *"run=$SHA"*"origin=$NEW"*) ;; *) fail "head reason should name both shas: $out" ;; esac
# the FAIL line carries the fix procedures, not the skill
for want in "git merge --ff-only origin/<branch>" "no-mistakes axi respond --action fix" "pipeline stays the sole writer" "only for a commit made outside the pipeline" "axi abort" "fresh backgrounded 'axi run" "'rerun' re-gates the OLD head"; do
  case "$out" in *"$want"*) ;; *) fail "head FAIL should name the fix ($want): $out" ;; esac
done
(cd "$work" && git reset -q --hard "$SHA" && git push -q -f origin "$B")

# fetch failure: unreachable origin must never pass on a stale ref
reset
git -C "$work" fetch -q origin "+refs/heads/$B:refs/remotes/origin/$B"
mv "$origin" "$origin.gone"
(PATH="$toolbin" STUB_DIR="$st" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_NM_BIN="$tmpdir/nm" \
  CALLUM_FLOW_LINKAGE_BIN="$tmpdir/linkage" CALLUM_FLOW_ROLLOUT_BIN="${ROLLOUT_BIN:-$ROLLOUT}" CALLUM_FLOW_WATCH_BIN="$WATCH" NO_MISTAKES_HOME="$tmpdir/nmhome" "$SH" "$GUARD" 7 > "$tmpdir/o" 2>&1) && fail "unreachable origin passed"
grep -q 'GUARD head FAIL .*origin=unknown' "$tmpdir/o" || fail "fetch failure should say unknown: $(cat "$tmpdir/o")"
mv "$origin.gone" "$origin"
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
reset; ROLLOUT_BIN=/bin/false; g 7; expect_fail "derivation failure" rollout
reset; echo 'not json' > "$st/issue.json"; g 7; expect_fail "unreadable issue" rollout
reset; echo bogus/branch > "$st/branch"; echo 'SKIP #7 feat' > "$st/linkage"; g 7; expect_fail "no issue to derive from" rollout head
reset; issue_brief 'run-it - x'; echo 'SKIP #7 feat' > "$st/linkage"; echo '[]' > "$st/closing"; echo 'Refs #12' > "$st/body"; g 7 --issue 12; expect_pass "--issue drives the derivation"

# epic base
reset; echo epic-x > "$st/base"; g 7; expect_fail "epic without --base" base
for want in "confirm that with the brief" "rerun with --base epic-x"; do
  case "$out" in *"$want"*) ;; *) fail "epic base recovery missing ($want): $out" ;; esac
done
reset; echo epic-x > "$st/base"; g 7 --base epic-x; expect_pass "epic with --base"
reset; echo epic-x > "$st/base"; g 7 --base wrong; expect_fail "epic with incorrect --base" base
case "$out" in *"rerun with --base epic-x"*) ;; *) fail "incorrect override recovery missing: $out" ;; esac
# awaiting_ in free text is not a parked step
reset; echo 'note: use awaiting_approval to park' > "$st/step"; g 7; expect_pass "awaiting_ only in free text"

# test-weakening (cbundy/dev-system#314): advisory, never fails the guard
reset; g 7; expect_pass "no weakening"
[ "$(cat "$st/weakening-args")" = "--base origin/main --head $SHA" ] || fail "detector arguments: $(cat "$st/weakening-args")"
reset; printf '%s\n' "$W1" > "$st/weakening"; g 7
[ "$rc" = 0 ] || fail "WARN must not fail the guard: $rc $out"
want="GUARD test-weakening WARN $(printf %.7s "$SHA") step=ci files=tests/a.test.js,tests/b.test.sh kinds=removed-assertion,warn-only - have the adjudicator judge it against the brief; restore via fixer unless the removal is justified"
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
for args in "7 --expect closes" "7 --bogus" "" "x"; do
  rc=0
  # shellcheck disable=SC2086
  PATH="$toolbin" "$SH" "$GUARD" $args > /dev/null 2>&1 || rc=$?
  [ "$rc" = 2 ] || fail "usage '$args' should exit 2, got $rc"
done
passed=$((passed + 1))

# the dry-run guard never merges or logs
reset; g 7 --emit-verified
if [ "$rc" != 0 ] || [ -f "$st/gh-calls" ] || [ -e "$events" ]; then fail "guard must be read-only"; fi
passed=$((passed + 1))

# trust (cbundy/dev-system#310): the author guard, and a stranger's text is never read
STRANGER='{"login":"mallory","id":999}'
reset; echo "$STRANGER" > "$st/pauthor"; g 7; expect_fail "stranger-authored PR" author
printf '%s' "$out" | grep -q 'not opened by a trusted author' || fail "author reason: $out"
reset; echo "$STRANGER" > "$st/pauthor"; : > "$st/view-count"; g 7 --expect closing; expect_fail "stranger PR with --expect" author
reset; echo '{"login":"cbundy","id":1}' > "$st/pauthor"; g 7; expect_fail "right login, wrong id" author
reset; CALLUM_FLOW_TRUSTED_AUTHORS='' g 7; expect_fail "trusted list unset fails closed" author
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

# --- update-behind and the patch proof (cbundy/dev-system#476): fixtures are in merge-guard-lib.sh
# Real commits with content (an empty commit has no patch to prove). BASE0 is main
# before any of this; behind_setup builds a gated branch tip, then moves main on.
# behind-only, identical patch: pushed, proof printed, guard passes on the new head
behind_setup
g 7 --update-behind
[ "$rc" = 0 ] || fail "update-behind: rc=$rc out=$out"
NEWH=$(origin_b)
[ "$NEWH" != "$GATED" ] || fail "update-behind did not push"
[ "$(git -C "$origin" rev-parse "refs/heads/main")" = "$(git -C "$origin" rev-parse "$NEWH^")" ] || fail "branch not rebased onto main"
case "$out" in "UPDATED pr=7 branch=$B from=$GATED to=$NEWH run=RUN1 gated_patch="*" rebased_from=$GATED") ;; *) fail "update-behind output: $out" ;; esac
PROOF=$(printf '%s' "$out" | sed 's/.*gated_patch=\([^ ]*\) .*/\1/')
[ -n "$PROOF" ] || fail "empty proof"
[ "$(git -C "$work" worktree list | wc -l)" = 1 ] || fail "scratch worktree left behind: $(git -C "$work" worktree list)"
passed=$((passed + 1))
echo "$NEWH" > "$st/prhead"; echo CLEAN > "$st/mss"
g 7 --emit-verified
[ "$rc" = 0 ] || fail "guard after rebase: rc=$rc out=$out"
printf '%s\n' "$out" | grep -qx "GUARD head PASS gated_patch=$PROOF rebased_from=$GATED" || fail "PASS line missing: $out"
printf '%s\n' "$out" | grep -q "^VERIFIED .* head=$NEWH .* gated_patch=$PROOF rebased_from=$GATED\$" || fail "VERIFIED proof missing: $out"
passed=$((passed + 1))
# without the proof the same difference is today's head failure
git -C "$work" rev-parse "$BASE0" > "$st/runhead"
g 7; expect_fail "run head unrelated to the PR" head
case "$out" in *"git merge --ff-only origin/<branch>"*) ;; *) fail "HEAD_FIX text missing: $out" ;; esac

# fail closed: patch mismatch (the gated run had a different patch)
behind_setup
ALT=$(cd "$work" && git checkout -q --detach "$BASE0" && echo different > f.txt && git add f.txt && git commit -q -m alt && git rev-parse HEAD && git checkout -q "$B")
echo "$ALT" > "$st/runhead"
g 7 --update-behind
[ "$rc" = 1 ] && [ "$(origin_b)" = "$GATED" ] || fail "patch mismatch must fail without a push: rc=$rc out=$out"
case "$out" in "UPDATE-BEHIND FAIL patch changed by the rebase; fall back to a full re-gate: "*) ;; *) fail "mismatch text: $out" ;; esac
passed=$((passed + 1))

# fail closed: rebase conflict, no push, lease untouched
behind_setup f.txt conflicting
g 7 --update-behind
[ "$rc" = 1 ] && [ "$(origin_b)" = "$GATED" ] || fail "conflict must fail without a push: rc=$rc out=$out"
case "$out" in *"needs manual resolution"*) ;; *) fail "conflict text: $out" ;; esac
[ "$(git -C "$work" worktree list | wc -l)" = 1 ] || fail "scratch worktree left after conflict"
passed=$((passed + 1))

# fail closed: unfinished or failed gated run, missing run head object
behind_setup; printf 'review,running\nci,pending\n' > "$st/steps"
g 7 --update-behind
[ "$rc" = 1 ] && [ "$(origin_b)" = "$GATED" ] || fail "unfinished run must fail: rc=$rc out=$out"
case "$out" in *"did not finish cleanly"*) ;; *) fail "unfinished text: $out" ;; esac
behind_setup; echo failed > "$st/runstatus"
g 7 --update-behind
[ "$rc" = 1 ] && [ "$(origin_b)" = "$GATED" ] || fail "failed run must fail: rc=$rc out=$out"
behind_setup; echo 0123456789abcdef0123456789abcdef01234567 > "$st/runhead"
g 7 --update-behind
[ "$rc" = 1 ] && [ "$(origin_b)" = "$GATED" ] || fail "missing run head must fail: rc=$rc out=$out"
case "$out" in *"not available locally"*) ;; *) fail "missing head text: $out" ;; esac
passed=$((passed + 1))

# only a BEHIND, non-conflicting PR is touched
for s in CLEAN DIRTY BLOCKED; do
  behind_setup; echo "$s" > "$st/mss"
  g 7 --update-behind
  [ "$rc" = 1 ] && [ "$(origin_b)" = "$GATED" ] || fail "mss $s must fail: rc=$rc out=$out"
done
behind_setup; echo CONFLICTING > "$st/pmergeable"
g 7 --update-behind
[ "$rc" = 1 ] && [ "$(origin_b)" = "$GATED" ] || fail "CONFLICTING must fail: rc=$rc out=$out"
# only a conflict falls back to a re-gate; a PR that is not behind needs none
behind_setup; echo DIRTY > "$st/mss"; g 7 --update-behind
case "$out" in "UPDATE-BEHIND FAIL PR conflicts with main; fall back to a full re-gate: "*) ;; *) fail "dirty update-behind text: $out" ;; esac
behind_setup; echo CLEAN > "$st/mss"; g 7 --update-behind
case "$out" in "UPDATE-BEHIND SKIP PR is not behind its base (state=OPEN mergeStateStatus=CLEAN mergeable=MERGEABLE), nothing to rebase; re-run the guard") ;; *) fail "clean update-behind text: $out" ;; esac
# UNKNOWN is re-read like the mergeable guard: still computing, then behind, rebases
behind_setup; printf 'UNKNOWN\nBEHIND\n' > "$st/mss-seq"; g 7 --update-behind
[ "$rc" = 0 ] && [ "$(origin_b)" != "$GATED" ] || fail "UNKNOWN then BEHIND should rebase: rc=$rc out=$out"
[ "$(cat "$st/view-count")" = 2 ] || fail "UNKNOWN should be re-read once: $(cat "$st/view-count")"
behind_setup; echo UNKNOWN > "$st/mss"; g 7 --update-behind
[ "$rc" = 1 ] && [ "$(origin_b)" = "$GATED" ] || fail "UNKNOWN must not push: rc=$rc out=$out"
[ "$out" = "UPDATE-BEHIND SKIP GitHub has not computed mergeability, retry" ] || fail "unknown update-behind text: $out"
[ "$(cat "$st/view-count")" = 3 ] || fail "UNKNOWN should be read CALLUM_FLOW_MERGEABLE_TRIES times: $(cat "$st/view-count")"
# a branch that already moved before the PR was read pushes nothing
behind_setup; echo bogus > "$st/prhead"
g 7 --update-behind
[ "$rc" = 1 ] && [ "$(origin_b)" = "$GATED" ] || fail "moved branch must fail: rc=$rc out=$out"
# a lost lease: the branch moves after the checks, while the rebase runs, so the push is refused
behind_setup; MOVED=$(git -C "$origin" rev-parse refs/heads/main)
cat > "$work/.git/hooks/post-rewrite" <<HOOK
#!/bin/sh
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
git -C "$origin" update-ref "refs/heads/$B" "$MOVED"
HOOK
chmod +x "$work/.git/hooks/post-rewrite"
g 7 --update-behind
rm -f "$work/.git/hooks/post-rewrite"
[ "$rc" = 1 ] && [ "$(origin_b)" = "$MOVED" ] || fail "lost lease must fail without a push: rc=$rc out=$out"
case "$out" in *"lost its lease"*) ;; *) fail "lease text: $out" ;; esac
[ "$(git -C "$work" worktree list | wc -l)" = 1 ] || fail "scratch worktree left after a lost lease"
passed=$((passed + 1))
# DIRTY keeps today's REBASE_FIX path on a normal guard run
behind_setup; echo DIRTY > "$st/mss"; echo CONFLICTING > "$st/pmergeable"; g 7; expect_fail "dirty keeps REBASE_FIX" mergeable
printf '%s' "$out" | grep -q 'conflicts with main, rebase and re-gate' || fail "dirty reason changed: $out"
# --update-behind takes no linkage options
g 7 --update-behind --expect closing; [ "$rc" = 2 ] || fail "--update-behind --expect should be a usage error, rc=$rc"
passed=$((passed + 1))

echo "merge-guard: $passed groups passed"
