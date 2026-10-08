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

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
toolbin="$tmpdir/tools"
mkdir -p "$toolbin"
for t in jq sed tr cat mkdir mv dirname basename date find sort cut head tail wc git awk grep rm touch chmod hostname; do
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
  'pr view') printf '{"headRefName":"%s","headRefOid":"%s","baseRefName":"%s"}\n' "$(r branch)" "$(r prhead)" "$(r base)" ;;
  'pr checks') cat "$d/checks"; [ ! -f "$d/checks-rc" ] || exit "$(r checks-rc)" ;;
  'repo view') echo main ;;
  'pr merge') echo "$*" >> "$d/gh-calls"; [ ! -f "$d/merge-refuse" ] || exit 1 ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
STUB
cat > "$tmpdir/nm" <<'STUB'
#!/bin/sh
d=${STUB_DIR:?}
case "$1 $2" in
  'runs --limit') printf '%s\n' 'STATUS ID HEAD' "completed RUN9 abc 2026-01-01 other" "running RUN1 abc 2026-01-02 mine" ;;
  'axi status')
    id=$4
    case "$id" in
      RUN9) printf 'id: "RUN9"\nbranch: other/b\nstatus: completed\nhead_sha: zzz\n' ;;
      RUN1) printf 'id: "RUN1"\nbranch: %s\nstatus: %s\nhead_sha: %s\nsteps[1]{step,status}:\n  %s\n' "$(cat "$d/branch")" "$(cat "$d/runstatus")" "$(cat "$d/runhead")" "$(cat "$d/step")" ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
STUB
cat > "$tmpdir/linkage" <<'STUB'
#!/bin/sh
cat "${STUB_DIR:?}/linkage"
exit "$(cat "$STUB_DIR/linkage-rc")"
STUB
chmod +x "$tmpdir/gh" "$tmpdir/nm" "$tmpdir/linkage"

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
}

# g <args...>: run the guard; sets out, rc
g() {
  rc=0
  out=$(PATH="$toolbin" STUB_DIR="$st" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_NM_BIN="$tmpdir/nm" \
    CALLUM_FLOW_LINKAGE_BIN="$tmpdir/linkage" "$SH" "$GUARD" "$@" 2> "$tmpdir/err") || rc=$?
}
m() {
  rc=0
  out=$(PATH="$toolbin" STUB_DIR="$st" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_NM_BIN="$tmpdir/nm" \
    CALLUM_FLOW_LINKAGE_BIN="$tmpdir/linkage" CALLUM_FLOW_GUARD_BIN="$GUARD" \
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

reset; echo 'ci,awaiting_approval' > "$st/step"; g 7; expect_fail "gates" gates
reset; echo failed > "$st/runstatus"; g 7; expect_fail "gates failed" gates
reset; echo '[]' > "$st/checks"; g 7; expect_fail "zero checks" checks
reset; echo '[{"name":"ci","bucket":"pending"}]' > "$st/checks"; echo 8 > "$st/checks-rc"; g 7; expect_fail "pending" checks
printf '%s' "$out" | grep -q 'ci=pending' || fail "checks reason should name the check"
reset; echo '[{"name":"ci","bucket":"pass"},{"name":"lint","bucket":"skipping"}]' > "$st/checks"; g 7; expect_pass "skipping mixed"
reset; echo 'MISMATCH #7 issue=#12 expect=closing' > "$st/linkage"; echo 1 > "$st/linkage-rc"; g 7; expect_fail "linkage" linkage
printf '%s' "$out" | grep -q 'MISMATCH #7' || fail "linkage reason should carry the report"
reset; echo bogus > "$st/prhead"; g 7; expect_fail "pr head differs" head
reset; echo main-ish > "$st/base"; echo 'MATCH #7 issue=#12' > "$st/linkage"; g 7; expect_fail "base" base

# two guards at once: no short-circuit
reset; echo '[]' > "$st/checks"; echo 'ci,awaiting_approval' > "$st/step"; g 7; expect_fail "two guards" checks gates

# phantom-gated run: origin moved after the run
reset
(cd "$work" && git commit -q --allow-empty -m later && git push -q origin "$B")
NEW=$(git -C "$work" rev-parse HEAD)
echo "$NEW" > "$st/prhead"
g 7; expect_fail "stale run head" head
case "$out" in *"run=$SHA"*"origin=$NEW"*) ;; *) fail "head reason should name both shas: $out" ;; esac
(cd "$work" && git reset -q --hard "$SHA" && git push -q -f origin "$B")

# fetch failure: unreachable origin must never pass on a stale ref
reset
git -C "$work" fetch -q origin "+refs/heads/$B:refs/remotes/origin/$B"
mv "$origin" "$origin.gone"
(PATH="$toolbin" STUB_DIR="$st" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_NM_BIN="$tmpdir/nm" \
  CALLUM_FLOW_LINKAGE_BIN="$tmpdir/linkage" "$SH" "$GUARD" 7 > "$tmpdir/o" 2>&1) && fail "unreachable origin passed"
grep -q 'GUARD head FAIL .*origin=unknown' "$tmpdir/o" || fail "fetch failure should say unknown: $(cat "$tmpdir/o")"
mv "$origin.gone" "$origin"
passed=$((passed + 1))


# epic base
reset; echo epic-x > "$st/base"; echo 'SKIP #7 feat' > "$st/linkage"; g 7; expect_fail "epic without --base" base linkage
reset; echo epic-x > "$st/base"; echo 'SKIP #7 feat' > "$st/linkage"; g 7 --base epic-x; expect_pass "epic with --base"

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

# merge: refused by GitHub (head moved) logs nothing
reset; touch "$st/merge-refuse"; m 7
if [ "$rc" != 1 ] || [ -e "$events" ]; then fail "refused merge: $rc"; fi
passed=$((passed + 1))

# the dry-run guard never merges or logs
reset; g 7 --emit-verified
if [ "$rc" != 0 ] || [ -f "$st/gh-calls" ] || [ -e "$events" ]; then fail "guard must be read-only"; fi
passed=$((passed + 1))

echo "merge-guard: $passed groups passed"
