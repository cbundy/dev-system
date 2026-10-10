#!/bin/sh
#
# Plain-shell tests for callum-flow-design-route (cbundy/dev-system#288). A stub
# gh serves a label list and a recording stub stands in for the event script.
# Hermetic PATH, no network, no Docker.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROUTE="$SCRIPT_DIR/../../../images/base/callum-flow-design-route"
SHARE="$SCRIPT_DIR/../../../images/base"
READER="$SHARE/callum-flow-issue-read"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
toolbin="$tmpdir/tools"
mkdir -p "$toolbin"
for t in sed tr cat cksum jq grep; do
  p=$(command -v "$t") || fail "$t not found"
  ln -s "$p" "$toolbin/$t"
done
SH=$(command -v sh)

cat > "$tmpdir/gh" <<'STUB'
#!/bin/sh
# labels live in $STUB_DIR/labels (one per line); $STUB_DIR/gh-fails makes the
# issue read fail; $STUB_DIR/author holds the issue author's user JSON (default the
# owner). The issue comes back as REST returns it, for callum-flow-issue-read.
d=${STUB_DIR:?}
case "$1 $2" in
  'api repos/cbundy/dev-system/issues/'*)
    [ ! -f "$d/gh-fails" ] || exit 1
    a='{"login":"cbundy","id":13131067}'
    [ ! -f "$d/author" ] || a=$(cat "$d/author")
    jq -R -s --argjson u "$a" '{number: 1, state: "open", title: "t", body: "b", user: $u,
      labels: (split("\n") | map(select(. != "") | {name: .}))}' "$d/labels" ;;
  'issue view') echo "raw issue read: gh $*" >&2; exit 1 ;;
  'repo view') echo cbundy/dev-system ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
STUB
cat > "$tmpdir/event" <<'STUB'
#!/bin/sh
echo "$*" >> "${STUB_DIR:?}/events"
[ ! -f "${STUB_DIR}/event-fails" ] || exit 1
STUB
chmod +x "$tmpdir/gh" "$tmpdir/event"

d="$tmpdir/state"
reset() {
  rm -rf "$d"
  mkdir -p "$d"
  : > "$d/labels"
  : > "$d/events"
}
# route <issue> [PCT]; sets out, rc, err; PCT "unset" leaves the variable unset
route() {
  set +e
  if [ "${2-unset}" = unset ]; then
    PATH="$toolbin" STUB_DIR="$d" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_EVENT_BIN="$tmpdir/event" \
      CALLUM_FLOW_ISSUE_READ_BIN="${READ_BIN:-$READER}" CALLUM_FLOW_SHARE_DIR="$SHARE" CALLUM_FLOW_TRUSTED_AUTHORS="${TRUSTED-cbundy:13131067}" \
      CALLUM_FLOW_REPO="${REPO:-cbundy/dev-system}" "$SH" "$ROUTE" "$1" >"$tmpdir/out" 2>"$tmpdir/err"
  else
    PATH="$toolbin" STUB_DIR="$d" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_EVENT_BIN="$tmpdir/event" \
      CALLUM_FLOW_ISSUE_READ_BIN="${READ_BIN:-$READER}" CALLUM_FLOW_SHARE_DIR="$SHARE" CALLUM_FLOW_TRUSTED_AUTHORS="${TRUSTED-cbundy:13131067}" \
      CALLUM_FLOW_REPO="${REPO:-cbundy/dev-system}" CALLUM_FLOW_DESIGN_SESSION_PCT="$2" "$SH" "$ROUTE" "$1" >"$tmpdir/out" 2>"$tmpdir/err"
  fi
  rc=$?
  set -e
  out=$(cat "$tmpdir/out")
}
# expect <route> <reason> <bucket> <pct> <what>: rc 0, one stdout line, one event
expect() {
  [ "$rc" = 0 ] || fail "$5: exit $rc (stderr: $(cat "$tmpdir/err"))"
  [ "$out" = "$1" ] || fail "$5: printed '$out', wanted '$1'"
  [ "$(grep -c . "$d/events")" = 1 ] || fail "$5: want exactly one event: $(cat "$d/events")"
  want="design_routed --issue ${ISSUE:-288} --note route=$1 reason=$2 bucket=$3 pct=$4"
  [ "$(cat "$d/events")" = "$want" ] || fail "$5: event '$(cat "$d/events")', wanted '$want'"
}
usage_err() {
  [ "$rc" = 2 ] || fail "$1: exit $rc, wanted 2"
  [ -z "$out" ] || fail "$1: printed '$out' on a usage error"
  [ ! -s "$d/events" ] || fail "$1: logged on a usage error"
}

# label overrides
reset; echo design:session > "$d/labels"; route 288 0; expect session label - 0 "session label, pct 0"
reset; echo design:subagent > "$d/labels"; route 288 100; expect subagent label - 100 "subagent label, pct 100"
reset; printf 'design:session\ndesign:subagent\n' > "$d/labels"; route 288 100; expect subagent label - 100 "both labels"
reset; printf 'x\ndesign:session-ish\n' > "$d/labels"; route 288 0; expect subagent default - 0 "similar label ignored"

# percentage
reset; route 288; expect subagent default - 0 "pct unset"
reset; route 288 0; expect subagent default - 0 "pct 0"
reset; route 288 ""; expect subagent default - 0 "pct empty"
reset; route 288 007; expect subagent hash 82 7 "leading zeros are decimal"
reset; route 288 08; expect subagent hash 82 8 "08 is not octal"
reset; route 288 100; expect session hash 82 100 "pct 100"
reset; ISSUE=7; route 7 100; expect session hash "$(printf 'cbundy/dev-system#7' | cksum | { read -r c _; echo $((c % 100)); })" 100 "pct 100 any issue"; ISSUE=288

# pinned golden: cbundy/dev-system#288 is bucket 82 on every machine
reset; route 288 83; expect session hash 82 83 "bucket 82 below 83"
reset; route 288 82; expect subagent hash 82 82 "bucket 82 at 82"
reset; route 288 50; expect subagent hash 82 50 "bucket 82 at pct 50"
# an issue whose bucket is below 50
low=''
i=1
while [ -z "$low" ]; do
  b=$(printf 'cbundy/dev-system#%s' "$i" | cksum | { read -r c _; echo $((c % 100)); })
  [ "$b" -lt 50 ] && low="$i:$b"
  i=$((i + 1))
done
reset; ISSUE=${low%:*}; route "$ISSUE" 50; expect session hash "${low#*:}" 50 "bucket below 50"; ISSUE=288

# stable and case-insensitive on the repo
reset; route 288 83; first=$out; : > "$d/events"; route 288 83; [ "$out" = "$first" ] || fail "same issue routed differently"
reset; REPO=CBundy/Dev-System route 288 83; expect session hash 82 83 "upper-case repo"; REPO=''

# usage errors log nothing
reset; route 288 abc; usage_err "pct abc"
reset; route 288 101; usage_err "pct 101"
reset; route 288 -5; usage_err "pct -5"
reset; route abc 50; usage_err "issue abc"
reset
set +e; PATH="$toolbin" STUB_DIR="$d" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_EVENT_BIN="$tmpdir/event" CALLUM_FLOW_REPO=o/r "$SH" "$ROUTE" >"$tmpdir/out" 2>/dev/null; rc=$?; set -e
out=$(cat "$tmpdir/out"); usage_err "no argument"
grep -q CALLUM_FLOW_DESIGN_SESSION_PCT "$tmpdir/err" 2>/dev/null || { reset; route 288 abc; grep -q CALLUM_FLOW_DESIGN_SESSION_PCT "$tmpdir/err" || fail "usage message must name the variable"; }

# gh failing on the label read falls back to subagent
reset; touch "$d/gh-fails"; route 288 100; expect subagent fallback - 100 "gh failure"
grep -q warning "$tmpdir/err" || fail "fallback must warn on stderr"

# the reader logs untrusted_stripped to the same event stub; only the route events matter
only_route_events() { grep '^design_routed' "$d/events" > "$d/e2" || true; mv "$d/e2" "$d/events"; }
# trust (cbundy/dev-system#310): labels of an untrusted issue are never read, so a
# stranger's design:session label cannot steer the route; the route falls back
reset; echo design:session > "$d/labels"; echo '{"login":"mallory","id":999}' > "$d/author"; route 288 0
only_route_events; expect subagent fallback - 0 "untrusted issue's session label is ignored"
reset; echo design:session > "$d/labels"; echo '{"login":"cbundy","id":42}' > "$d/author"; route 288 0
only_route_events; expect subagent fallback - 0 "right login, wrong id"
reset; echo design:session > "$d/labels"; TRUSTED='' route 288 0
only_route_events; expect subagent fallback - 0 "no trusted list fails closed"
unset TRUSTED
reset; echo design:session > "$d/labels"; READ_BIN="$tmpdir/missing-reader" route 288 0
only_route_events; expect subagent fallback - 0 "missing reader fails closed"
unset READ_BIN
reset; echo design:session > "$d/labels"; route 288 100
only_route_events; expect session label - 100 "trusted issue's label still honoured"

# a failing event script changes nothing
reset; touch "$d/event-fails"; route 288 83
[ "$rc" = 0 ] || fail "event failure changed the exit code ($rc)"
[ "$out" = session ] || fail "event failure changed the output ('$out')"

echo "design-route tests passed"
