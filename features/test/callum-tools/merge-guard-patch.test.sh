#!/bin/sh
#
# Plain-shell tests for fabriek-merge-guard --patch, the factory loop's mode and the guard's only
# one (docs/factory-loop/v2/SPEC.md 9.4), and fabriek-merge passing it through. The guard checks
# only facts the loop owns: a patch guard against the real fabriek-patch-id, and every
# FAIL line ends with its class. The shared stubs and real local origin live in merge-guard-lib.sh;
# the shared guards are in merge-guard.test.sh and merge.test.sh.
# shellcheck disable=SC2015  # A && B || fail is the idiom here
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/merge-guard-lib.sh"

PATCH_ID="$ROOT/images/base/fabriek-patch-id"
OTHER=0123456789abcdef0123456789abcdef01234567
CLASSES='behind|conflict|checks|patch|linkage|read|policy'

# this suite pins the real fabriek-patch-id, in the guard and behind fabriek-merge
PID_BIN=$PATCH_ID

# patch_setup: the PR's branch is one real change on main, pushed and clean; PH is its head and
# PID its patch id, as the loop approved it
patch_setup() {
  reset
  (
    cd "$work"
    git checkout -q main && git reset -q --hard "$BASE0" && git push -q -f origin main
    git checkout -q -B "$B" "$BASE0"
    echo feature > f.txt && git add f.txt && git commit -q -m feature
    git push -q -f origin "$B"
  )
  PH=$(git -C "$work" rev-parse HEAD)
  echo "$PH" > "$st/prhead"
  PID=$(PATH="$toolbin" "$SH" "$PATCH_ID" "$PH" main)
}

# gp <args...>: the guard, as g runs it, without the shared patch-id stub; every FAIL
# line it prints is kept in $tmpdir/all-fails. LINKAGE_BIN, when set, replaces the linkage stub.
gp() {
  rc=0
  out=$(PATH="$toolbin" STUB_DIR="$st" FABRIEK_GH_BIN="$tmpdir/gh" \
    FABRIEK_LINKAGE_BIN="${LINKAGE_BIN:-$tmpdir/linkage}" CHECK_PR_LINKAGE_GH_BIN="$tmpdir/gh-linkage" \
    FABRIEK_ROLLOUT_BIN="${ROLLOUT_BIN:-$ROLLOUT}" \
    FABRIEK_MERGEABLE_TRIES=3 FABRIEK_MERGEABLE_SLEEP=0 "$SH" "$GUARD" "$@" 2> "$tmpdir/err") || rc=$?
  printf '%s\n' "$out" | grep ' FAIL ' >> "$tmpdir/all-fails" || true
}
: > "$tmpdir/all-fails"

# expect_class <name> <guard> <class> [reason]: exit 1 and exactly one FAIL line, that guard's,
# ending with that class (and holding the reason, when given)
expect_class() {
  [ "$rc" = 1 ] || fail "$1: exit $rc, out=$out"
  [ "$(printf '%s\n' "$out" | grep -c ' FAIL ')" = 1 ] || fail "$1: one FAIL line expected: $out"
  printf '%s\n' "$out" | grep -q "^GUARD $2 FAIL .* class=$3\$" || fail "$1: want GUARD $2 FAIL ... class=$3: $out"
  [ -z "${4-}" ] || printf '%s\n' "$out" | grep -qF "$4" || fail "$1: reason should hold '$4': $out"
  passed=$((passed + 1))
}

# --- the patch guard ------------------------------------------------------------------------
patch_setup; gp 7 --patch "$PID"; expect_pass "the approved patch, clean and green"
patch_setup; gp 7 --patch "$PID" --emit-verified
[ "$rc" = 0 ] && [ "$out" = "VERIFIED pr=7 branch=$B head=$PH run= issue=12 close_issue= gated_patch= rebased_from=" ] || fail "VERIFIED without a run: rc=$rc out=$out"
passed=$((passed + 1))
patch_setup; gp 7 --patch "$OTHER"; expect_class "another patch" patch patch "head $PH has patch $PID, not the approved $OTHER"
# a clean merge of main into the branch (gh pr update-branch) keeps the approved patch
patch_setup
(
  cd "$work"
  git checkout -q main && echo other > o.txt && git add o.txt && git commit -q -m "main moves on" && git push -q origin main
  git checkout -q "$B" && git merge -q --no-edit main && git push -q origin "$B"
)
git -C "$work" rev-parse HEAD > "$st/prhead"
gp 7 --patch "$PID"; expect_pass "a merge of main keeps the approved patch"
# a patch id that cannot be computed is a fact not read
patch_setup
printf '#!/bin/sh\necho "fabriek-patch-id: cannot fetch origin/main" >&2\nexit 1\n' > "$tmpdir/nopatch"; chmod +x "$tmpdir/nopatch"
FABRIEK_PATCH_ID_BIN="$tmpdir/nopatch" gp 7 --patch "$PID"; expect_class "patch id not computed" patch read "patch id of $PH not computed: fabriek-patch-id: cannot fetch origin/main"

# --- no head guard --------------------------------------------------------------------------
patch_setup; git -C "$work" commit -q --allow-empty -m "a slot ahead"; gp 7 --patch "$PID"; expect_pass "a worktree ahead of the head is not checked"
git -C "$work" reset -q --hard "$PH"

# --- every other guard, with its class -----------------------------------------------------
patch_setup; echo BEHIND > "$st/mss"; gp 7 --patch "$PID"; expect_class "behind" mergeable behind "behind main"
case "$out" in *update-behind* | *axi* | *re-gate*) fail "--patch names no pipeline recovery: $out" ;; esac
patch_setup; echo DIRTY > "$st/mss"; echo CONFLICTING > "$st/pmergeable"; gp 7 --patch "$PID"; expect_class "conflict" mergeable conflict "conflicts with main"
case "$out" in *re-gate*) fail "--patch names no pipeline recovery: $out" ;; esac
patch_setup; echo DRAFT > "$st/mss"; gp 7 --patch "$PID"; expect_class "draft" mergeable policy "PR is a draft"
patch_setup; echo BLOCKED > "$st/mss"; gp 7 --patch "$PID"; expect_class "blocked" mergeable read "branch rules not met"
patch_setup; echo UNKNOWN > "$st/mss"; gp 7 --patch "$PID"; expect_class "not computed" mergeable read "GitHub has not computed mergeability"
patch_setup; echo CLOSED > "$st/pstate"; echo UNKNOWN > "$st/mss"; gp 7 --patch "$PID"; expect_class "closed" mergeable read "PR is CLOSED"
patch_setup; echo '[{"name":"ci","bucket":"pending"}]' > "$st/checks"; echo 8 > "$st/checks-rc"; gp 7 --patch "$PID"; expect_class "pending" checks checks "ci=pending"
patch_setup; echo '[{"name":"ci","bucket":"fail"}]' > "$st/checks"; gp 7 --patch "$PID"; expect_class "red" checks checks "ci=fail"
patch_setup; echo '[]' > "$st/checks"; gp 7 --patch "$PID"; expect_class "no checks" checks checks "no checks reported"
patch_setup; echo 'garbage' > "$st/checks"; gp 7 --patch "$PID"; expect_class "checks unread" checks read "cannot parse checks"
# a workflow run with no job yet is in no check list: the guard reads the head's runs too
patch_setup; echo '{"total_count":1,"workflow_runs":[{"id":5,"workflow_id":2,"event":"push","name":"Deploy","status":"in_progress","conclusion":null}]}' > "$st/runs"; gp 7 --patch "$PID"; expect_class "run in progress" checks checks "workflow Deploy=pending"
patch_setup; echo '{"total_count":1,"workflow_runs":[{"id":5,"workflow_id":2,"event":"push","name":"Deploy","status":"completed","conclusion":"failure"}]}' > "$st/runs"; gp 7 --patch "$PID"; expect_class "run failed" checks checks "workflow Deploy=fail"
patch_setup; echo '{"total_count":2,"workflow_runs":[{"id":5,"workflow_id":2,"event":"push","name":"Deploy","status":"completed","conclusion":"cancelled"},{"id":6,"workflow_id":2,"event":"push","name":"Deploy","status":"completed","conclusion":"success"}]}' > "$st/runs"; gp 7 --patch "$PID"; [ "$rc" = 0 ] || fail "a superseded cancelled run blocks: $out"
patch_setup; echo '{"total_count":2,"workflow_runs":[{"id":5,"workflow_id":2,"event":"push","name":"Deploy","status":"completed","conclusion":"success"}]}' > "$st/runs"; gp 7 --patch "$PID"; expect_class "runs truncated" checks read "cannot read workflow runs whole"
patch_setup; echo 'HTTP 502: Bad Gateway' > "$st/runs-err"; gp 7 --patch "$PID"; expect_class "runs blip" checks read "cannot read workflow runs: HTTP 502"
patch_setup; echo garbage > "$st/runs"; gp 7 --patch "$PID"; expect_class "runs unparseable" checks read "cannot read workflow runs whole"
# a read that failed names gh's error, so the loop can tell a GitHub blip (v2 SPEC 5.1)
patch_setup; echo 'HTTP 502: Bad Gateway (https://api.github.com/graphql)' > "$st/checks-err"; gp 7 --patch "$PID"; expect_class "checks blip" checks read "cannot read checks: HTTP 502: Bad Gateway"
patch_setup; echo '{"login":"mallory","id":999}' > "$st/pauthor"; gp 7 --patch "$PID"; expect_class "untrusted" author policy "not opened by a trusted author"
patch_setup; FABRIEK_ISSUE_READ_BIN="$tmpdir/missing-reader" gp 7 --patch "$PID"; expect_class "author unverified" author read "cannot verify the author"
patch_setup; echo 'MISMATCH #7 issue=#12 expect=closing' > "$st/linkage"; echo 1 > "$st/linkage-rc"; gp 7 --patch "$PID"; expect_class "linkage" linkage linkage "MISMATCH #7"
patch_setup; : > "$st/linkage"; echo 1 > "$st/linkage-rc"; gp 7 --patch "$PID"; expect_class "linkage unread" linkage read "no output"
patch_setup; ROLLOUT_BIN=/bin/false; gp 7 --patch "$PID"; expect_class "rollout not derived" rollout read "cannot derive the Rollout"
patch_setup; echo epic-x > "$st/base"; gp 7 --patch "$PID"; expect_class "another base" base policy "PR targets epic-x"
# several at once: each line its own class
patch_setup; echo BEHIND > "$st/mss"; echo '[{"name":"ci","bucket":"pending"}]' > "$st/checks"; gp 7 --patch "$PID"
[ "$rc" = 1 ] && printf '%s\n' "$out" | grep -q ' class=behind$' && printf '%s\n' "$out" | grep -q ' class=checks$' || fail "two classes: $out"
passed=$((passed + 1))
# every FAIL line printed in --patch mode ends with one of the seven classes
[ -s "$tmpdir/all-fails" ] || fail "no FAIL line was seen"
! grep -Ev " class=($CLASSES)\$" "$tmpdir/all-fails" || fail "a FAIL line without its class"
passed=$((passed + 1))

# --- the loop's branch issue-<N>, against the real linkage check ------------------------------
# The factory loop names an issue's branch issue-<N>, with no slug (v2 SPEC 3.5). Factory drill 1
# of run 2 parked two green, approved PRs: the linkage check skipped issue-<N> and the guard then
# wanted --issue. Here the real check-pr-linkage.sh reads the PR through a stub gh of its own.
LINKAGE_REAL="$ROOT/features/src/callum-tools/check-pr-linkage.sh"
for t in bash node; do
  p=$(command -v "$t") || fail "$t not found"
  [ -e "$toolbin/$t" ] || ln -s "$p" "$toolbin/$t"
done
# the stub gh's `pr view` program, shared with the linkage suites; GitHub's closing references
# come from the body, as it derives them on the default branch
export PR_VIEW_JQ="$SCRIPT_DIR/linkage-pr-view.jq"
cat > "$tmpdir/gh-linkage" <<'STUB'
#!/bin/sh
d=${STUB_DIR:?}
case "$1 $2" in
  'repo view') echo '{"defaultBranchRef":{"name":"main"},"nameWithOwner":"local/repo"}' ;;
  'pr view') jq -nc --rawfile head "$d/branch" --rawfile base "$d/base" --rawfile body "$d/body" --arg api '' -f "${PR_VIEW_JQ:?}" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$tmpdir/gh-linkage"
# loop_setup <branch>: the PR's head pushed as that branch, which the PR names
loop_setup() {
  patch_setup
  git -C "$work" push -q -f origin "$PH:refs/heads/$1"
  printf '%s\n' "$1" > "$st/branch"
}
# gl <args...>: gp with the real linkage check
gl() {
  LINKAGE_BIN=$LINKAGE_REAL
  gp "$@"
  LINKAGE_BIN=''
}
loop_setup issue-12; gl 7 --patch "$PID"; expect_pass "issue-<N> names its issue: the linkage is checked, no --issue needed"
loop_setup issue-12; gl 7 --patch "$PID" --issue 12; expect_pass "issue-<N> with the record's --issue (the loop's argv)"
loop_setup issue-12; gl 7 --patch "$PID" --emit-verified
[ "$rc" = 0 ] && [ "$out" = "VERIFIED pr=7 branch=issue-12 head=$PH run= issue=12 close_issue= gated_patch= rebased_from=" ] || fail "issue-<N> VERIFIED: rc=$rc out=$out"
passed=$((passed + 1))
loop_setup issue-12; printf '%s\n' 'Refs #12' > "$st/body"; gl 7 --patch "$PID" --issue 12
expect_class "issue-<N> that closes nothing" linkage linkage "MISMATCH #7 issue=#12 expect=closing"
loop_setup feat/issue-12-x; gl 7 --patch "$PID"; expect_pass "a v1 branch issue-<N>-<slug> is checked as before"

# --- --tested-tree: the merge train's tree guard -----------------------------------------------
# tree_of: the tree merging the PR head onto origin/main gives
tree_of() { git -C "$work" fetch -q origin && git -C "$work" merge-tree --write-tree origin/main "$PH" | sed -n 1p; }
# main_moves <file> <content>: main gains a commit touching that file
main_moves() {
  (
    cd "$work"
    git checkout -q main && echo "$2" > "$1" && git add "$1" && git commit -q -m "main moves on" && git push -q origin main
    git checkout -q "$B"
  )
}
patch_setup; T=$(tree_of); gp 7 --patch "$PID" --tested-tree "$T"; expect_pass "the merge gives the tested tree"
patch_setup; gp 7 --patch "$PID" --tested-tree "$OTHER"; expect_class "another tree" tree behind "gives tree $(tree_of), not the tested $OTHER"
patch_setup; main_moves f.txt "main wrote it first"; gp 7 --patch "$PID" --tested-tree "$OTHER"; expect_class "conflicting merge" tree behind "conflicts"
# a base that moved on without touching the PR: BEHIND is no FAIL with --tested-tree, and is one without it
patch_setup; main_moves o.txt other; T=$(tree_of); echo BEHIND > "$st/mss"
gp 7 --patch "$PID" --tested-tree "$T"; expect_pass "BEHIND, the tree is the tested one"
gp 7 --patch "$PID"; expect_class "BEHIND without --tested-tree" mergeable behind "behind main"
gp 7 --patch "$PID" --tested-tree "$OTHER"; expect_class "BEHIND, another tree" tree behind
# draft, conflicting and blocked are unchanged
patch_setup; T=$(tree_of); echo DRAFT > "$st/mss"; gp 7 --patch "$PID" --tested-tree "$T"; expect_class "draft with --tested-tree" mergeable policy "PR is a draft"
patch_setup; T=$(tree_of); echo DIRTY > "$st/mss"; echo CONFLICTING > "$st/pmergeable"; gp 7 --patch "$PID" --tested-tree "$T"; expect_class "DIRTY with --tested-tree" mergeable conflict "conflicts with main"
patch_setup; T=$(tree_of); echo BLOCKED > "$st/mss"; gp 7 --patch "$PID" --tested-tree "$T"; expect_class "BLOCKED with --tested-tree" mergeable read "branch rules not met"
# a fetch that fails is a fact not read (the patch id is stubbed: it fetches too)
printf '#!/bin/sh\necho "%s"\n' "$PID" > "$tmpdir/fixedpatch"; chmod +x "$tmpdir/fixedpatch"
patch_setup; T=$(tree_of); git -C "$work" remote set-url origin "$tmpdir/no-such-origin.git"
FABRIEK_PATCH_ID_BIN="$tmpdir/fixedpatch" gp 7 --patch "$PID" --tested-tree "$T"
git -C "$work" remote set-url origin "$origin"
expect_class "fetch fails" tree read "cannot fetch origin/main: "
# --emit-verified is unchanged by the option
patch_setup; T=$(tree_of); gp 7 --patch "$PID" --tested-tree "$T" --emit-verified
[ "$rc" = 0 ] && [ "$out" = "VERIFIED pr=7 branch=$B head=$PH run= issue=12 close_issue= gated_patch= rebased_from=" ] || fail "VERIFIED with --tested-tree: rc=$rc out=$out"
passed=$((passed + 1))
# usage: needs --patch, refused with --update-behind, 40 lowercase hex
patch_setup
for args in "7 --tested-tree $OTHER" "7 --update-behind --tested-tree $OTHER" "7 --patch $PID --tested-tree" "7 --patch $PID --tested-tree xyz" "7 --patch $PID --tested-tree 0123456789ABCDEF0123456789ABCDEF01234567" "7 --patch $PID --tested-tree 0123456789abcdef"; do
  rc=0
  # shellcheck disable=SC2086
  PATH="$toolbin" "$SH" "$GUARD" $args > /dev/null 2>&1 || rc=$?
  [ "$rc" = 2 ] || fail "usage '$args' should exit 2, got $rc"
done
passed=$((passed + 1))

# --- usage ------------------------------------------------------------------------------------
patch_setup
for args in "7 --patch" "7 --patch xyz" "7 --patch $PID --run RUN1" "7 --patch $PID --update-behind"; do
  rc=0
  # shellcheck disable=SC2086
  PATH="$toolbin" "$SH" "$GUARD" $args > /dev/null 2>&1 || rc=$?
  [ "$rc" = 2 ] || fail "usage '$args' should exit 2, got $rc"
done
passed=$((passed + 1))

# --- fabriek-merge passes --patch to its guard --------------------------------------------
patch_setup; m 7 --patch "$PID"
[ "$rc" = 0 ] || fail "merge with the approved patch: rc=$rc out=$out err=$(cat "$tmpdir/err")"
[ "$(cat "$st/gh-calls")" = "pr merge 7 --squash --match-head-commit $PH" ] || fail "merge call: $(cat "$st/gh-calls")"
jq -e --arg sha "$PH" '.type == "merged" and .data.pr == 7 and .data.head == $sha and .issue == 12' "$events/factory/o__r.jsonl" > /dev/null || fail "merged event: $(cat "$events/factory/o__r.jsonl")"
passed=$((passed + 1))
patch_setup; m 7 --patch "$OTHER"
[ "$rc" = 1 ] && [ ! -f "$st/gh-calls" ] && [ ! -e "$events" ] || fail "merge with another patch must not merge: rc=$rc out=$out"
printf '%s\n' "$out" | grep -q "^GUARD patch FAIL .* class=patch\$" || fail "the guard's FAIL line reaches the caller: $out"
passed=$((passed + 1))

# --- fabriek-merge: --tested-tree and --train-dropped, and the merged event's train fields ---
# a guard that records its arguments and then runs the real one
cat > "$tmpdir/guard-spy" <<STUB
#!/bin/sh
echo "\$*" >> "\${STUB_DIR:?}/guard-args"
exec "$SH" "$GUARD" "\$@"
STUB
chmod +x "$tmpdir/guard-spy"
# merge_commit <tree>: a commit with that tree on origin, as the merge commit the stub gh reports
merge_commit() {
  mc=$(git -C "$work" commit-tree "$1" -p "$BASE0" -m "merge sim")
  git -C "$work" push -q -f origin "$mc:refs/heads/merge-sim"
  echo "$mc" > "$st/mergecommit"
}
# the four train fields of the one merged event
train_fields() { jq -c '[.data.train, .data.train_reason, .data.tested_tree, .data.tree_matched]' "$events/factory/o__r.jsonl"; }

patch_setup; T=$(tree_of); merge_commit "$T"; GUARD_BIN="$tmpdir/guard-spy" m 7 --patch "$PID" --tested-tree "$T"
[ "$rc" = 0 ] || fail "train merge: rc=$rc out=$out err=$(cat "$tmpdir/err")"
grep -q -- "--tested-tree $T" "$st/guard-args" || fail "--tested-tree must reach the guard: $(cat "$st/guard-args")"
[ "$(train_fields)" = "[\"rode\",null,\"$T\",true]" ] || fail "a train merge on the tested tree: $(train_fields)"
passed=$((passed + 1))
# the merge commit has another tree: tree_matched false
patch_setup; T=$(tree_of); merge_commit "$(git -C "$work" rev-parse "$BASE0^{tree}")"; m 7 --patch "$PID" --tested-tree "$T"
[ "$rc" = 0 ] && [ "$(train_fields)" = "[\"rode\",null,\"$T\",false]" ] || fail "a train merge on another tree: rc=$rc $(train_fields)"
passed=$((passed + 1))
# the tree read fails: a warning, null, and the merge and event stand
for bad in fails nooid; do
  patch_setup; T=$(tree_of); merge_commit "$T"
  case "$bad" in fails) touch "$st/mergecommit-fails" ;; nooid) echo 0000000000000000000000000000000000000001 > "$st/mergecommit" ;; esac
  m 7 --patch "$PID" --tested-tree "$T"
  [ "$rc" = 0 ] && [ -f "$st/gh-calls" ] || fail "tree read $bad must not fail the merge: rc=$rc"
  [ "$(train_fields)" = "[\"rode\",null,\"$T\",null]" ] || fail "tree read $bad: $(train_fields)"
  grep -q "warning: could not read the tree of PR #7's merge commit" "$tmpdir/err" || fail "tree read $bad: no warning: $(cat "$tmpdir/err")"
done
passed=$((passed + 1))
# --train-dropped is recorded and never reaches the guard
patch_setup; GUARD_BIN="$tmpdir/guard-spy" m 7 --patch "$PID" --train-dropped train-red
[ "$rc" = 0 ] || fail "dropped train merge: rc=$rc out=$out err=$(cat "$tmpdir/err")"
! grep -q -- "train" "$st/guard-args" || fail "--train-dropped must not reach the guard: $(cat "$st/guard-args")"
[ "$(train_fields)" = '["dropped","train-red",null,null]' ] || fail "a dropped train: $(train_fields)"
[ ! -e "$st/mergecommit" ] || fail "no tree read without a train"
passed=$((passed + 1))
for reason in head-moved outside-merge conflict train-red left-queue tree-mismatch refused; do
  patch_setup; m 7 --patch "$PID" --train-dropped "$reason"
  [ "$rc" = 0 ] && [ "$(train_fields)" = "[\"dropped\",\"$reason\",null,null]" ] || fail "drop reason $reason: rc=$rc $(train_fields)"
done
passed=$((passed + 1))
# no train: all four null
patch_setup; m 7 --patch "$PID"
[ "$rc" = 0 ] && [ "$(train_fields)" = '[null,null,null,null]' ] || fail "no train: rc=$rc $(train_fields)"
passed=$((passed + 1))
# usage errors merge nothing
patch_setup; T=$(tree_of)
for args in "--patch $PID --train-dropped bogus" "--patch $PID --train-dropped" "--patch $PID --tested-tree $T --train-dropped train-red" "--patch $PID --tested-tree xyz"; do
  # shellcheck disable=SC2086
  m 7 $args
  [ "$rc" = 2 ] || fail "merge '$args' should exit 2, got $rc: $out"
  [ ! -f "$st/gh-calls" ] || fail "merge '$args' merged"
done
passed=$((passed + 1))
# a tree that is not the tested one stops the merge, with the tree guard's line
patch_setup; m 7 --patch "$PID" --tested-tree "$OTHER"
[ "$rc" = 1 ] && [ ! -f "$st/gh-calls" ] && printf '%s\n' "$out" | grep -q '^GUARD tree FAIL .* class=behind$' || fail "another tree must not merge: rc=$rc out=$out"
passed=$((passed + 1))

echo "merge-guard-patch: $passed groups passed"
