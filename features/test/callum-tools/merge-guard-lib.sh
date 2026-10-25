# shellcheck shell=sh
# Shared fixture for merge-guard.test.sh and merge.test.sh (cbundy/dev-system#480): the
# real local origin, the hermetic toolbin, the stub gh / patch-id / linkage /
# weakening / milestone binaries and the g / m / expect_* helpers. Sourced, never run
# by itself - its name does not match *.test.sh, so `npm test` does not pick it up.
# The stubs read state with shell builtins (`read -r`), not a `cat` process per field.
# The caller runs under `set -eu` and sets SCRIPT_DIR before sourcing. The helper initialises
# `passed`; each suite increments it and prints the total.
# shellcheck disable=SC2015  # A && B || fail is the idiom here
# shellcheck disable=SC2034  # variables and helpers are used by the sourcing suites
# shellcheck disable=SC2164  # the caller runs under set -e
ROOT="$SCRIPT_DIR/../../.."
GUARD="$ROOT/images/base/callum-flow-merge-guard"
MERGE="$ROOT/images/base/callum-flow-merge"
MILESTONE_REAL="$ROOT/images/base/callum-flow-milestone"
EVENT="$ROOT/images/base/callum-flow-event"
ROLLOUT="$ROOT/images/base/callum-flow-rollout"
READER="$ROOT/images/base/callum-flow-issue-read"
SHARE="$ROOT/images/base"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
toolbin="$tmpdir/tools"
mkdir -p "$toolbin"
for t in jq sed tr cat mkdir mv dirname basename date find sort cut head tail wc git awk grep rm touch chmod hostname ls sleep mktemp node; do
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
  git push -q origin HEAD:refs/heads/epic-x
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
# Scalar state values occupy one newline-terminated line, read with a shell builtin
# instead of a `cat` process per field. Multiline fixtures use slurp or jq below.
slurp() { while IFS= read -r l || [ -n "$l" ]; do printf '%s\n' "$l"; done < "$1"; }
OWNER='{"login":"cbundy","id":13131067}'
if [ "$1" = api ]; then
  shift
  [ "$1" != --paginate ] || shift
  case "$1" in
    repos/o/r/pulls/7)
      # the PR as REST returns it; pauthor overrides the owner
      u=$OWNER
      [ ! -f "$d/pauthor" ] || read -r u < "$d/pauthor"
      printf '{"number":7,"state":"open","title":"t","body":"b","user":%s}\n' "$u" ;;
    repos/o/r/issues/12)
      jq --argjson u "$OWNER" '{number: 12, state: "open", title: "t", body: .body, user: $u, labels: []}' "$d/issue.json" ;;
    repos/o/r/issues/12/comments)
      jq --argjson u "$OWNER" '.comments | to_entries | map({id: (.key + 1), user: (.value.user // $u), body: .value.body})' "$d/issue.json" ;;
    'repos/{owner}/{repo}/actions/runs?'*)
      # the head's workflow runs; default: one completed success run
      [ ! -f "$d/runs-err" ] || { cat "$d/runs-err" >&2; exit 1; }
      if [ -f "$d/runs" ]; then slurp "$d/runs"; else echo '{"total_count":1,"workflow_runs":[{"id":1,"workflow_id":1,"event":"pull_request","name":"CI","status":"completed","conclusion":"success"}]}'; fi
      if [ -f "$d/runs-rc" ]; then read -r rc < "$d/runs-rc"; exit "$rc"; fi ;;
    *) echo "no fixture for $1" >&2; exit 1 ;;
  esac
  exit
fi
case "$1 $2" in
  'pr view')
    case "$*" in
      *mergeCommit*)
        # the merge commit the merge train reads after a merge: mergecommit-fails fails it, mergecommit holds its oid
        [ ! -f "$d/mergecommit-fails" ] || exit 1
        read -r oid < "$d/mergecommit"
        printf '{"mergeCommit":{"oid":"%s"}}\n' "$oid" ;;
      *additions*)
        # the merged PR's size (callum-flow-merge reads it after the merge): size-fails fails it, size overrides it
        echo "$*" >> "$d/size-calls"
        [ ! -f "$d/size-fails" ] || exit 1
        if [ -f "$d/size" ]; then slurp "$d/size"; else echo '{"files":[{"path":"a.js","additions":7,"deletions":1},{"path":"b/c.sh","additions":3,"deletions":1},{"path":"","additions":1,"deletions":0},{"path":"d.txt","additions":"x","deletions":0}],"additions":10,"deletions":2,"mergedAt":"2026-10-02T09:00:00Z"}'; fi ;;
      *closingIssuesReferences*) read -r c < "$d/closing"; jq -n --rawfile b "$d/body" --argjson c "$c" '{body:$b, closingIssuesReferences:($c | map({number:.}))}' ;;
      *)
        # reads counted, so a test can see how often the guard re-queried
        n=0
        [ ! -f "$d/view-count" ] || read -r n < "$d/view-count" || n=0
        n=$((n + 1)); echo "$n" > "$d/view-count"
        read -r mss < "$d/mss"
        if [ -f "$d/mss-seq" ]; then
          i=0; mss=''
          while IFS= read -r l || [ -n "$l" ]; do i=$((i + 1)); [ "$i" -gt "$n" ] || mss=$l; [ "$i" -ge "$n" ] && break; done < "$d/mss-seq"
        fi
        read -r b < "$d/branch"; read -r h < "$d/prhead"; read -r ba < "$d/base"; read -r ps < "$d/pstate"; read -r dr < "$d/isdraft"; read -r pm < "$d/pmergeable"
        printf '{"headRefName":"%s","headRefOid":"%s","baseRefName":"%s","state":"%s","isDraft":%s,"mergeable":"%s","mergeStateStatus":"%s"}\n' \
          "$b" "$h" "$ba" "$ps" "$dr" "$pm" "$mss" ;;
    esac ;;
  'issue view') slurp "$d/issue.json" ;;
  'pr checks') [ ! -f "$d/checks-err" ] || { cat "$d/checks-err" >&2; exit 1; }; slurp "$d/checks"; if [ -f "$d/checks-rc" ]; then read -r rc < "$d/checks-rc"; exit "$rc"; fi ;;
  'repo view') echo main ;;
  'pr merge')
    echo "$*" >> "$d/gh-calls"
    if [ -f "$d/merge-refuse" ]; then
      echo "GraphQL: refused" >&2
      # the world after the refusal: a moved head and/or a new merge state
      [ ! -f "$d/refuse-prhead" ] || { read -r v < "$d/refuse-prhead"; echo "$v" > "$d/prhead"; }
      [ ! -f "$d/refuse-mss" ] || { read -r v < "$d/refuse-mss"; echo "$v" > "$d/mss"; rm -f "$d/mss-seq"; }
      exit 1
    fi ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
STUB
cat > "$tmpdir/linkage" <<'STUB'
#!/bin/sh
# linkage-actual: what the PR really does (closing|refs); the stub checks it against --expect
if [ -f "${STUB_DIR:?}/linkage-actual" ]; then
  read -r actual < "$STUB_DIR/linkage-actual"
  if [ "$3" = "$actual" ]; then echo "MATCH #7 issue=#12 expect=$3"; exit 0; fi
  echo "MISMATCH #7 issue=#12 expect=$3"; exit 1
fi
while IFS= read -r l || [ -n "$l" ]; do printf '%s\n' "$l"; done < "${STUB_DIR:?}/linkage"
read -r rc < "$STUB_DIR/linkage-rc"
exit "$rc"
STUB
# the test-weakening detector (cbundy/dev-system#314): its output and exit code are set per test
cat > "$tmpdir/weakening" <<'STUB'
#!/bin/sh
d=${STUB_DIR:?}
echo "$*" > "$d/weakening-args"
if [ -f "$d/weakening" ]; then while IFS= read -r l || [ -n "$l" ]; do printf '%s\n' "$l"; done < "$d/weakening"; fi
if [ -f "$d/weakening-rc" ]; then read -r rc < "$d/weakening-rc"; exit "$rc"; fi
exit 0
STUB
# callum-flow-milestone (cbundy/dev-system#403): records its calls; milestone-rc sets its exit code
cat > "$tmpdir/milestone" <<'STUB'
#!/bin/sh
d=${STUB_DIR:?}
echo "$*" >> "$d/milestone-calls"
if [ -f "$d/milestone-rc" ]; then read -r rc < "$d/milestone-rc"; exit "$rc"; fi
exit 0
STUB
# the patch id of the PR head (callum-flow-patch-id): the shared-guard cases do not test the patch
# guard, so by default the guard runs with --patch STUB_PID against a patch-id stub that prints it.
# merge-guard-patch.test.sh pins the real callum-flow-patch-id (it sets PID_BIN to it).
STUB_PID=0123456789abcdef0123456789abcdef0123abcd
cat > "$tmpdir/patchid" <<STUB
#!/bin/sh
echo $STUB_PID
STUB
chmod +x "$tmpdir/milestone" "$tmpdir/gh" "$tmpdir/linkage" "$tmpdir/weakening" "$tmpdir/patchid"
PID_BIN="$tmpdir/patchid"

events="$tmpdir/events"
passed=0

reset() {
  rm -rf "$st" "$events"
  mkdir -p "$st"
  printf '%s\n' "$B" > "$st/branch"
  printf '%s\n' "$SHA" > "$st/prhead"
  printf '%s\n' main > "$st/base"
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

# the real reader behind the stub gh
export CALLUM_FLOW_ISSUE_READ_BIN="$READER" CALLUM_FLOW_SHARE_DIR="$SHARE" CALLUM_FLOW_REPO=o/r CALLUM_FLOW_TRUSTED_AUTHORS=cbundy:13131067 CALLUM_FLOW_EVENT_BIN="$tmpdir/noevent" CALLUM_FLOW_WEAKENING_BIN="$tmpdir/weakening"

# with_patch <args...>: the arguments, plus --patch STUB_PID unless they carry one
with_patch() {
  case " $* " in *" --patch "*) patch_args='' ;; *) patch_args="--patch $STUB_PID" ;; esac
}
# g <args...>: run the guard in the loop's mode; sets out, rc. Every FAIL line must end with a class.
g() {
  with_patch "$@"
  rc=0
  # shellcheck disable=SC2086 # patch_args is empty or two words
  out=$(PATH="$toolbin" STUB_DIR="$st" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_PATCH_ID_BIN="$PID_BIN" \
    CALLUM_FLOW_LINKAGE_BIN="$tmpdir/linkage" CALLUM_FLOW_ROLLOUT_BIN="${ROLLOUT_BIN:-$ROLLOUT}" \
    CALLUM_FLOW_MERGEABLE_TRIES=3 CALLUM_FLOW_MERGEABLE_SLEEP=0 "$SH" "$GUARD" "$@" $patch_args 2> "$tmpdir/err") || rc=$?
  ! printf '%s\n' "$out" | grep ' FAIL ' | grep -Ev ' class=(behind|conflict|checks|patch|linkage|read|policy)$' || fail "a FAIL line without its class: $out"
}
m() {
  with_patch "$@"
  rc=0
  # shellcheck disable=SC2086 # patch_args is empty or two words
  out=$(PATH="$toolbin" STUB_DIR="$st" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_PATCH_ID_BIN="$PID_BIN" \
    CALLUM_FLOW_LINKAGE_BIN="$tmpdir/linkage" CALLUM_FLOW_ROLLOUT_BIN="${ROLLOUT_BIN:-$ROLLOUT}" CALLUM_FLOW_GUARD_BIN="${GUARD_BIN:-$GUARD}" CALLUM_FLOW_MILESTONE_BIN="${MILESTONE_BIN:-$tmpdir/milestone}" \
    CALLUM_FLOW_MERGEABLE_TRIES=3 CALLUM_FLOW_MERGEABLE_SLEEP=0 \
    CALLUM_FLOW_EVENT_BIN="$tmpdir/event" CALLUM_EVENTS_DIR="$events" CALLUM_FLOW_REPO=o/r \
    "$SH" "$MERGE" "$@" $patch_args 2> "$tmpdir/err") || rc=$?
}
cat > "$tmpdir/event" <<STUB
#!/bin/sh
PATH="$toolbin" exec "$SH" "$EVENT" "\$@"
STUB
chmod +x "$tmpdir/event"

# expect_fail <name> <guard>...: exit 1 and exactly those GUARD lines
# expect_class <guard> <class>: the guard's FAIL line ends with that class
expect_class() {
  printf '%s\n' "$out" | grep -q "^GUARD $1 FAIL .* class=$2\$" || fail "want GUARD $1 FAIL ... class=$2: $out"
}
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


# test-weakening fixtures (cbundy/dev-system#314), used by both suites
W1="WEAKENED commit=${SHA} step=ci restored=no files=tests/a.test.js,tests/b.test.sh kinds=removed-assertion,warn-only"
W2="WEAKENED commit=1234567890abcdef1234567890abcdef12345678 step=review restored=yes files=tests/c.test.js kinds=skip"

# SKIP: the branch names no issue, so --issue N and the PR linkage decide
skip() { echo 'SKIP #7 feat' > "$st/linkage"; }
refs_issue() { issue_brief 'keep-open - one part of several'; }

# the base the branch is cut from, for the patch suite
BASE0=$(git -C "$work" rev-parse origin/main)
