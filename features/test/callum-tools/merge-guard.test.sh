#!/bin/sh
#
# Plain-shell tests for callum-flow-merge-guard and callum-flow-merge
# (cbundy/dev-system#219). Stub gh / no-mistakes / linkage script, a real local
# bare repo as origin so the fetch and rev-parse are real. Hermetic PATH, no
# network, no Docker, so `npm test` runs it anywhere.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT="$SCRIPT_DIR/../../.."
GUARD="$ROOT/images/base/callum-flow-merge-guard"
MERGE="$ROOT/images/base/callum-flow-merge"
EVENT="$ROOT/images/base/callum-flow-event"
ROLLOUT="$ROOT/images/base/callum-flow-rollout"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
toolbin="$tmpdir/tools"
mkdir -p "$toolbin"
for t in jq sed tr cat mkdir mv dirname basename date find sort cut head tail wc git awk grep rm touch chmod hostname ls sleep; do
  p=$(command -v "$t") || fail "$t not found"
  ln -s "$p" "$toolbin/$t"
done
SH=$(command -v sh)

# --- real origin with a branch ------------------------------------------------
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
origin="$tmpdir/origin.git"
work="$tmpdir/work"
git init -q --bare "$origin"
git init -q "$work"
(
  cd "$work"
  git remote add origin "$origin"
  git commit -q --allow-empty -m base
  git push -q origin HEAD:refs/heads/main
  git checkout -q -b feat/issue-12-x
  git commit -q --allow-empty -m work
  git push -q origin feat/issue-12-x
)
B=feat/issue-12-x
cd "$work"
SHA=$(git -C "$work" rev-parse HEAD)

# --- stubs: state lives in $st, one file per knob ---------------------------
st="$tmpdir/state"
cat > "$tmpdir/gh" <<'STUB'
#!/bin/sh
d=${STUB_DIR:?}
r() { cat "$d/$1"; }
case "$1 $2" in
  'pr view')
    case "$*" in
      *closingIssuesReferences*) jq -n --rawfile b "$d/body" --argjson c "$(r closing)" '{body:$b, closingIssuesReferences:($c | map({number:.}))}' ;;
      *)
        # reads counted, so a test can see how often the guard re-queried
        n=$(( $(cat "$d/view-count" 2> /dev/null || echo 0) + 1 )); echo "$n" > "$d/view-count"
        mss=$(r mss)
        if [ -f "$d/mss-seq" ]; then mss=$(sed -n "${n}p" "$d/mss-seq"); [ -n "$mss" ] || mss=$(tail -n 1 "$d/mss-seq"); fi
        printf '{"headRefName":"%s","headRefOid":"%s","baseRefName":"%s","state":"%s","isDraft":%s,"mergeable":"%s","mergeStateStatus":"%s"}\n' \
          "$(r branch)" "$(r prhead)" "$(r base)" "$(r pstate)" "$(r isdraft)" "$(r pmergeable)" "$mss" ;;
    esac ;;
  'issue view') cat "$d/issue.json" ;;
  'pr checks') cat "$d/checks"; [ ! -f "$d/checks-rc" ] || exit "$(r checks-rc)" ;;
  'repo view') echo main ;;
  'pr merge')
    echo "$*" >> "$d/gh-calls"
    if [ -f "$d/merge-refuse" ]; then
      echo "GraphQL: refused" >&2
      # the world after the refusal: a moved head and/or a new merge state
      [ ! -f "$d/refuse-prhead" ] || cat "$d/refuse-prhead" > "$d/prhead"
      [ ! -f "$d/refuse-mss" ] || { cat "$d/refuse-mss" > "$d/mss"; rm -f "$d/mss-seq"; }
      exit 1
    fi ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
STUB
# no-mistakes, replaying the real v1.84 shapes: `runs` rows carry no run id
# (status, branch, short head, date, url, then a hint line), `axi status` from
# a checkout whose branch has a run prints its `run:` detail, from any other
# checkout the runs[N]{id,branch,status,head,pr} table, and `axi status --run
# ID` the same nested `run:` detail. The watcher calls `no-mistakes` from PATH
# (the guard's NM binary is only used for the status probe), so both resolve
# to this stub.
cat > "$tmpdir/nm" <<'STUB'
#!/bin/sh
d=${STUB_DIR:?}
[ ! -e "$d/nm-fail" ] || exit 1
b=$(cat "$d/branch")
h=$(cut -c1-8 "$d/runhead")
detail() {
  case "$1" in
    RUN9) printf 'run:\n  id: "RUN9"\n  branch: other/b\n  status: completed\n  head: abc12345\n  head_sha: zzz\n' ;;
    RUN1) printf 'run:\n  id: "RUN1"\n  branch: %s\n  status: %s\n  head: %s\n  head_sha: %s\n  steps[1]{step,status}:\n    %s\nbranch_sync:\n' "$b" "$(cat "$d/runstatus")" "$h" "$(cat "$d/runhead")" "$(cat "$d/step")" ;;
    *) return 1 ;;
  esac
}
case "$1 $2" in
  'runs --limit')
    printf '  %-12s %s %s  2026-01-01 10:00  https://example.test/pull/1\n' completed other/b abc12345
    [ -e "$d/norun" ] || printf '  %-12s %s %s  2026-01-02 10:00  https://example.test/pull/7\n' "$(cat "$d/runstatus")" "$b" "$h"
    printf '\n  (1 more runs, use --limit to see more)\n' ;;
  'axi status')
    if [ "$3" = --run ]; then detail "$4"; exit; fi
    if [ "$(git rev-parse --abbrev-ref HEAD)" = "$b" ] && [ ! -e "$d/table" ] && [ ! -e "$d/norun" ]; then detail RUN1; exit; fi
    printf 'current_branch: main\nruns_on_current_branch: 0\ncount: 2 of 2 total\nruns[2]{id,branch,status,head,pr}:\n'
    [ -e "$d/norun" ] || printf '  "RUN1",%s,%s,%s,"https://example.test/pull/7"\n' "$b" "$(cat "$d/runstatus")" "\"$h\""
    printf '  "RUN9",other/b,completed,"069be137","https://example.test/pull/1"\nhelp[1]: ...\n' ;;
  *) exit 1 ;;
esac
STUB
cat > "$tmpdir/linkage" <<'STUB'
#!/bin/sh
# linkage-actual: what the PR really does (closing|refs); the stub checks it against --expect
if [ -f "${STUB_DIR:?}/linkage-actual" ]; then
  if [ "$3" = "$(cat "$STUB_DIR/linkage-actual")" ]; then echo "MATCH #7 issue=#12 expect=$3"; exit 0; fi
  echo "MISMATCH #7 issue=#12 expect=$3"; exit 1
fi
cat "${STUB_DIR:?}/linkage"
exit "$(cat "$STUB_DIR/linkage-rc")"
STUB
chmod +x "$tmpdir/gh" "$tmpdir/nm" "$tmpdir/linkage"
ln -s "$tmpdir/nm" "$toolbin/no-mistakes"
WATCH="$ROOT/features/src/callum-tools/pipeline-watch.sh"

events="$tmpdir/events"
passed=0

reset() {
  rm -rf "$st" "$events"
  mkdir -p "$st"
  printf '%s\n' "$B" > "$st/branch"
  printf '%s\n' "$SHA" > "$st/prhead"
  printf '%s\n' main > "$st/base"
  printf '%s\n' "$SHA" > "$st/runhead"
  printf '%s\n' running > "$st/runstatus"
  printf '%s\n' 'ci,completed' > "$st/step"
  printf '%s\n' '[{"name":"ci","bucket":"pass"}]' > "$st/checks"
  printf '%s\n' 'MATCH #7 issue=#12 expect=closing via=api actual=[12]' > "$st/linkage"
  echo 0 > "$st/linkage-rc"
  printf '%s\n' 'Closes #12' > "$st/body"
  printf '%s\n' '[12]' > "$st/closing"
  printf '%s\n' OPEN > "$st/pstate"
  printf '%s\n' MERGEABLE > "$st/pmergeable"
  printf '%s\n' false > "$st/isdraft"
  printf '%s\n' CLEAN > "$st/mss"
  # the issue: no brief, no Run it heading, so Rollout is merge
  printf '%s\n' '{"body":"A plain bug.","comments":[]}' > "$st/issue.json"
  ROLLOUT_BIN=''
}
# issue_brief <rollout-line> [body]: the issue has a design brief with that Rollout
issue_brief() {
  jq -n --arg r "$1" --arg b "${2-A plain bug.}" '{body:$b, comments:[{body:("## Design brief\n\n## Rollout\n" + $r + "\n\n## Open decisions\nnone")}]}' > "$st/issue.json"
}

# g <args...>: run the guard; sets out, rc
g() {
  rc=0
  out=$(PATH="$toolbin" STUB_DIR="$st" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_NM_BIN="$tmpdir/nm" \
    CALLUM_FLOW_LINKAGE_BIN="$tmpdir/linkage" CALLUM_FLOW_ROLLOUT_BIN="${ROLLOUT_BIN:-$ROLLOUT}" CALLUM_FLOW_WATCH_BIN="$WATCH" NO_MISTAKES_HOME="$tmpdir/nmhome" \
    CALLUM_FLOW_MERGEABLE_TRIES=3 CALLUM_FLOW_MERGEABLE_SLEEP=0 "$SH" "$GUARD" "$@" 2> "$tmpdir/err") || rc=$?
}
m() {
  rc=0
  out=$(PATH="$toolbin" STUB_DIR="$st" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_NM_BIN="$tmpdir/nm" \
    CALLUM_FLOW_LINKAGE_BIN="$tmpdir/linkage" CALLUM_FLOW_ROLLOUT_BIN="${ROLLOUT_BIN:-$ROLLOUT}" CALLUM_FLOW_WATCH_BIN="$WATCH" NO_MISTAKES_HOME="$tmpdir/nmhome" CALLUM_FLOW_GUARD_BIN="$GUARD" \
    CALLUM_FLOW_MERGEABLE_TRIES=3 CALLUM_FLOW_MERGEABLE_SLEEP=0 \
    CALLUM_FLOW_EVENT_BIN="$tmpdir/event" CALLUM_EVENTS_DIR="$events" CALLUM_FLOW_REPO=o/r \
    "$SH" "$MERGE" "$@" 2> "$tmpdir/err") || rc=$?
}
cat > "$tmpdir/event" <<STUB
#!/bin/sh
PATH="$toolbin" exec "$SH" "$EVENT" "\$@"
STUB
chmod +x "$tmpdir/event"

# expect_fail <name> <guard>...: exit 1 and exactly those GUARD lines
expect_fail() {
  name=$1
  shift
  [ "$rc" = 1 ] || fail "$name: exit $rc, out=$out"
  [ "$(printf '%s\n' "$out" | grep -c '^GUARD ')" = "$#" ] || fail "$name: wrong line count: $out"
  for want in "$@"; do
    printf '%s\n' "$out" | grep -q "^GUARD $want FAIL " || fail "$name: missing $want: $out"
  done
  passed=$((passed + 1))
}
expect_pass() {
  if [ "$rc" != 0 ] || [ -n "$out" ]; then fail "$1: exit $rc out=$out"; fi
  passed=$((passed + 1))
}

reset; g 7; expect_pass "all pass"
reset; g 7 --run RUN1; expect_pass "explicit run"

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
printf '%s' "$out" | grep -q 'GUARD mergeable FAIL behind main, rebase and re-gate' || fail "behind reason: $out"
for want in "git rebase origin/<base>" "axi abort" "fresh backgrounded 'axi run" "head equals the rebased HEAD"; do
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
for want in "git merge --ff-only origin/<branch>" "axi respond" "axi abort" "fresh backgrounded 'axi run" "'rerun' re-gates the OLD head"; do
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
skip() { echo 'SKIP #7 feat' > "$st/linkage"; }
refs_issue() { issue_brief 'keep-open - one part of several'; }
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
reset; echo closing > "$st/linkage-actual"; issue_brief 'run-it - x'; m 7
if [ "$rc" != 1 ] || [ -f "$st/gh-calls" ]; then fail "merge passes options through and refuses a closing PR on run-it: $rc $out"; fi
passed=$((passed + 1))

# epic base
reset; echo epic-x > "$st/base"; g 7; expect_fail "epic without --base" base
reset; echo epic-x > "$st/base"; g 7 --base epic-x; expect_pass "epic with --base"

# awaiting_ in free text is not a parked step
reset; echo 'note: use awaiting_approval to park' > "$st/step"; g 7; expect_pass "awaiting_ only in free text"

# usage errors
reset
for args in "7 --expect closes" "7 --bogus" "" "x"; do
  rc=0
  # shellcheck disable=SC2086
  PATH="$toolbin" "$SH" "$GUARD" $args > /dev/null 2>&1 || rc=$?
  [ "$rc" = 2 ] || fail "usage '$args' should exit 2, got $rc"
done
passed=$((passed + 1))

# merge: pass
reset; m 7
[ "$rc" = 0 ] || fail "merge pass: exit $rc out=$out"
[ "$(cat "$st/gh-calls")" = "pr merge 7 --squash --match-head-commit $SHA" ] || fail "merge call: $(cat "$st/gh-calls")"
[ "$(wc -l < "$events/o__r.jsonl" | tr -d ' ')" = 1 ] || fail "one merged event expected"
jq -e --arg sha "$SHA" '.state == "merged" and .pr == 7 and .branch == "feat/issue-12-x" and .head == $sha and .run_id == "RUN1" and .issue == 12' "$events/o__r.jsonl" > /dev/null || fail "event: $(cat "$events/o__r.jsonl")"
passed=$((passed + 1))

# merge: method override, flag and env
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

# the dry-run guard never merges or logs
reset; g 7 --emit-verified
if [ "$rc" != 0 ] || [ -f "$st/gh-calls" ] || [ -e "$events" ]; then fail "guard must be read-only"; fi
passed=$((passed + 1))

echo "merge-guard: $passed groups passed"
