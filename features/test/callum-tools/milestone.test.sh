#!/bin/sh
#
# Plain-shell tests for callum-flow-milestone (cbundy/dev-system#403). A fake gh
# serves milestones, items and PRs from state files and records every call.
# Hermetic PATH, no network, no Docker, so `npm test` runs it anywhere.
# shellcheck disable=SC2015  # A && B || fail is the idiom here
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
HELPER="$SCRIPT_DIR/../../../images/base/callum-flow-milestone"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
toolbin="$tmpdir/tools"
mkdir -p "$toolbin"
for t in jq sed tr cat; do
  p=$(command -v "$t") || fail "$t not found"
  ln -s "$p" "$toolbin/$t"
done
SH=$(command -v sh)
st="$tmpdir/state"

cat > "$tmpdir/gh" << 'STUB'
#!/bin/sh
d=${STUB_DIR:?}
echo "$*" >> "$d/calls"
[ ! -f "$d/gh-fail" ] || exit 1
if [ "$1" = repo ]; then echo "${DEFAULT_BRANCH:-main}"; exit; fi
if [ "$1 $2" = 'pr view' ]; then cat "$d/pr-$3.json"; exit; fi
[ "$1" = api ] || { echo "unexpected gh $*" >&2; exit 1; }
shift
[ "$1" != --paginate ] || shift
if [ "$1" = -X ]; then
  # PATCH: record the target and its payload
  { echo "PATCH $3 $4 $5"; [ "$4" != --input ] || cat; } >> "$d/patches"
  [ ! -f "$d/patch-fail" ] || exit 1
  exit
fi
case "$1" in
  repos/o/r/milestones\?*) cat "$d/milestones.json" ;;
  repos/o/r/issues\?milestone=*) n=${1#*milestone=}; n=${n%%&*}; cat "$d/items-$n.json" ;;
  repos/o/r/issues/*) cat "$d/item-${1##*/}.json" || exit 1 ;;
  *) echo "no fixture for $1" >&2; exit 1 ;;
esac
STUB
chmod +x "$tmpdir/gh"

DESC='Line one

Expected: minor - old reason
tail line'
reset() {
  rm -rf "$st"
  mkdir -p "$st"
  jq -n --arg d "$DESC" '[{number: 5, title: "Next release", description: $d}, {number: 6, title: "Later", description: ""}, {number: 7, title: "Next release (old)", description: ""}]' > "$st/milestones.json"
}
# item <n> <milestone title or empty>
item() {
  jq -n --arg t "$2" '{number: 0, milestone: (if $t == "" then null else {title: $t} end)}' > "$st/item-$1.json"
}
# pr <n> <base> <closing numbers...>
pr() {
  n=$1 base=$2
  shift 2
  jq -n --arg b "$base" '{baseRefName: $b, closingIssuesReferences: []}' > "$st/pr-$n.json"
  for c in "$@"; do
    jq --argjson c "$c" '.closingIssuesReferences += [{number: $c}]' "$st/pr-$n.json" > "$st/x" && mv "$st/x" "$st/pr-$n.json"
  done
}
h() {
  rc=0
  out=$(PATH="$toolbin" STUB_DIR="$st" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_REPO=o/r "$SH" "$HELPER" "$@" 2> "$tmpdir/err") || rc=$?
  err=$(cat "$tmpdir/err")
}
patches() { cat "$st/patches" 2> /dev/null || true; }
passed=0
ok() { passed=$((passed + 1)); }

# usage and help
reset
for args in "" "bogus" "plan" "plan x next" "plan 1 soon" "show now" "expect" "expect huge why" "expect minor" "expect minor ''" "tag" "tag x"; do
  rc=0
  # shellcheck disable=SC2086
  eval "h $args"
  [ "$rc" = 2 ] || fail "usage '$args' should exit 2, got $rc"
done
h expect minor "   "; [ "$rc" = 2 ] || fail "blank reason should exit 2"
h expect minor "two
lines"; [ "$rc" = 2 ] || fail "multi-line reason should exit 2"
[ ! -e "$st/calls" ] || fail "usage errors must not call gh"
h --help; [ "$rc" = 0 ] && printf '%s\n' "$out" | grep -q 'Usage:' && printf '%s\n' "$out" | grep -q 'Expected: <patch|minor|major> - <reason>' || fail "help: $rc $out"
ok

# no open Next release: every subcommand is a no-op
reset; jq '[.[] | select(.title != "Next release")]' "$st/milestones.json" > "$st/x" && mv "$st/x" "$st/milestones.json"
for args in "plan 12 next" "plan 12 later" "show" "show next" "expect minor why" "tag 9"; do
  rm -f "$st/calls"
  eval "h $args"
  [ "$rc" = 0 ] || fail "no-op '$args': exit $rc $err"
  [ -z "$out" ] || fail "no-op '$args' wrote to stdout: $out"
  [ "$err" = 'callum-flow-milestone: no open "Next release" milestone in o/r - nothing to do' ] || fail "no-op message '$args': $err"
  [ ! -e "$st/patches" ] || fail "no-op '$args' wrote"
  grep -q 'pr view' "$st/calls" && fail "no-op '$args' read the PR" || true
done
# only an exact title among open milestones counts
reset; jq '[.[] | select(.title != "Next release")]' "$st/milestones.json" > "$st/x" && mv "$st/x" "$st/milestones.json"
h plan 12 next; [ "$rc" = 0 ] && [ ! -e "$st/patches" ] || fail "Next release (old) must not match: $rc"
ok

# plan
reset; item 12 ""; h plan 12 next
[ "$rc" = 0 ] && [ "$out" = '#12 moved from (no milestone) to "Next release"' ] && [ "$(patches)" = 'PATCH repos/o/r/issues/12 -F milestone=5' ] || fail "plan next: $rc $out $(patches)"
reset; item 12 "Next release"; h plan 12 later
[ "$rc" = 0 ] && [ "$out" = '#12 moved from "Next release" to "Later"' ] && [ "$(patches)" = 'PATCH repos/o/r/issues/12 -F milestone=6' ] || fail "plan later: $rc $out $(patches)"
reset; item 12 "Later"; h plan 12 later
[ "$rc" = 0 ] && [ -z "$(patches)" ] && printf '%s' "$out" | grep -q 'already in "Later"' || fail "plan already there: $rc $out"
reset; jq '[.[] | select(.title != "Later")]' "$st/milestones.json" > "$st/x" && mv "$st/x" "$st/milestones.json"; item 12 ""; h plan 12 later
[ "$rc" = 1 ] && [ -z "$(patches)" ] && printf '%s' "$err" | grep -q 'no open "Later" milestone' || fail "plan later without Later: $rc $err"
reset; item 12 ""; touch "$st/patch-fail"; h plan 12 next; [ "$rc" = 1 ] || fail "plan PATCH failure: $rc"
ok

# show
reset
jq -n '[{number: 1, state: "open", title: "An issue"}, {number: 2, state: "closed", title: "Done issue"}, {number: 3, state: "closed", title: "A PR", pull_request: {}}]' > "$st/items-5.json"
echo '[{"number": 4, "state": "open", "title": "Later one"}]' > "$st/items-6.json"
h show
want='== Next release
Expected: minor - old reason
#1 open issue An issue
#2 closed issue Done issue
#3 closed pr A PR
== Later
#4 open issue Later one'
[ "$rc" = 0 ] && [ "$out" = "$want" ] || fail "show both: $rc [$out]"
h show later; [ "$out" = '== Later
#4 open issue Later one' ] || fail "show later: [$out]"
DESC='no expected line here'
reset; echo '[]' > "$st/items-5.json"; h show next
[ "$out" = '== Next release
Expected: (not set)' ] || fail "show not set: [$out]"
DESC='Line one

Expected: minor - old reason
tail line'
ok

# expect
payload() { sed -n '2,$p' "$st/patches" | jq -j .description; }
reset; h expect patch "docs only"
[ "$rc" = 0 ] && [ "$out" = 'Expected: patch - docs only' ] || fail "expect output: $rc $out"
head -1 "$st/patches" | grep -q '^PATCH repos/o/r/milestones/5 --input' || fail "expect target: $(patches)"
[ "$(payload)" = 'Line one

Expected: patch - docs only
tail line' ] || fail "expect replace: [$(payload)]"
# appending when there is none, and a trailing newline survives
DESC='Intro text
'
reset; h expect major "breaking"
[ "$(payload)" = 'Intro text
Expected: major - breaking' ] || fail "expect append: [$(payload)]"
DESC=''
reset; h expect minor "first"; [ "$(payload)" = 'Expected: minor - first' ] || fail "expect on empty description: [$(payload)]"
# every other byte is untouched, CRLF and trailing newline included
reset; printf 'a\r\nExpected: minor - x\r\nb\n\n' > "$st/desc"
jq --rawfile d "$st/desc" '.[0].description = $d' "$st/milestones.json" > "$st/x" && mv "$st/x" "$st/milestones.json"
h expect patch "y"
[ "$(sed -n '2,$p' "$st/patches" | jq -j .description | od -An -c | tr -d ' \n')" = "$(printf 'a\r\nExpected: patch - y\r\nb\n\n' | od -An -c | tr -d ' \n')" ] || fail "expect byte-for-byte"
DESC='Line one

Expected: minor - old reason
tail line'
reset; touch "$st/patch-fail"; h expect patch x; [ "$rc" = 1 ] || fail "expect PATCH failure: $rc"
ok

# tag
# PR and closing issues with no milestone are all moved
reset; pr 9 main 12 13; item 9 ""; item 12 ""; item 13 ""; h tag 9
[ "$rc" = 0 ] && [ "$(patches)" = 'PATCH repos/o/r/issues/9 -F milestone=5
PATCH repos/o/r/issues/12 -F milestone=5
PATCH repos/o/r/issues/13 -F milestone=5' ] || fail "tag all: $rc $(patches)"
# an item in Later moves
reset; pr 9 main 12; item 9 ""; item 12 "Later"; h tag 9
[ "$rc" = 0 ] && [ "$(patches)" = 'PATCH repos/o/r/issues/9 -F milestone=5
PATCH repos/o/r/issues/12 -F milestone=5' ] && printf '%s' "$out" | grep -q '#12 moved from "Later"' || fail "tag later: $rc $(patches)"
# an item in another milestone is left alone with a warning
reset; pr 9 main 12; item 9 ""; item 12 "v2 planning"; h tag 9
[ "$rc" = 0 ] && [ "$(patches)" = 'PATCH repos/o/r/issues/9 -F milestone=5' ] && [ "$err" = 'callum-flow-milestone: warning: #12 is in milestone "v2 planning", not moved' ] || fail "tag other milestone: $rc [$err] $(patches)"
# an item already in Next release gets no PATCH, silently
reset; pr 9 main 12; item 9 "Next release"; item 12 "Next release"; h tag 9
[ "$rc" = 0 ] && [ -z "$(patches)" ] && [ -z "$out" ] && [ -z "$err" ] || fail "tag already tagged: $rc $out $err $(patches)"
# keep-open linkage: no closing references, so only the PR moves
reset; pr 9 main; item 9 ""; item 12 ""; h tag 9
[ "$rc" = 0 ] && [ "$(patches)" = 'PATCH repos/o/r/issues/9 -F milestone=5' ] || fail "tag keep-open: $rc $(patches)"
# a non-default base changes nothing
reset; pr 9 epic-x 12; item 9 ""; item 12 ""; h tag 9
[ "$rc" = 0 ] && [ -z "$(patches)" ] && printf '%s' "$out" | grep -q 'targets epic-x, not main' || fail "tag non-default base: $rc $out $(patches)"
# a failing move is reported, the other items are still tried
reset; pr 9 main 12; item 9 ""; item 12 ""; touch "$st/patch-fail"; h tag 9
[ "$rc" = 1 ] && [ "$(patches | grep -c '^PATCH')" = 2 ] || fail "tag PATCH failure: $rc $(patches)"
# gh failing outright is exit 1 and writes nothing
reset; pr 9 main 12; item 9 ""; item 12 ""; touch "$st/gh-fail"; h tag 9
[ "$rc" = 1 ] && [ ! -e "$st/patches" ] || fail "tag gh failure: $rc"
reset; pr 9 main; touch "$st/gh-fail"; for args in "show" "plan 9 next" "expect minor x"; do eval "h $args"; [ "$rc" = 1 ] || fail "gh failure '$args': $rc"; done
# an unreadable item is an error, not a silent skip
reset; pr 9 main 12; item 9 ""; h tag 9
[ "$rc" = 1 ] && printf '%s' "$err" | grep -q 'cannot read #12' || fail "tag unreadable item: $rc $err"
ok

echo "milestone: $passed groups passed"
