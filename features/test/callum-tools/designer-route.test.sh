#!/bin/sh
#
# Plain-shell tests for callum-flow-designer-route (cbundy/dev-system#1040). A
# stub gh serves a label list and a recording stub stands in for the event
# script. Hermetic PATH, no network, no Docker.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT="$SCRIPT_DIR/../../.."
ROUTE="$ROOT/images/base/callum-flow-designer-route"
SHARE="$ROOT/images/base"
READER="$SHARE/callum-flow-issue-read"
SCHEMA="$ROOT/docs/factory-events/schemas/designer_routed.v1.json"
AGENT="$ROOT/plugins/factory-loop/agents/designer-v2.md"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
toolbin="$tmpdir/tools"
mkdir -p "$toolbin"
for t in sed tr cat cksum jq grep sort; do
  p=$(command -v "$t") || fail "$t not found"
  ln -s "$p" "$toolbin/$t"
done
SH=$(command -v sh)

cat > "$tmpdir/gh" <<'STUB'
#!/bin/sh
# labels live in $STUB_DIR/labels (one per line); $STUB_DIR/gh-fails makes the
# issue read fail and $STUB_DIR/no-repo the repo lookup; $STUB_DIR/author holds
# the issue author's user JSON (default the owner). The issue comes back as REST
# returns it, for callum-flow-issue-read.
d=${STUB_DIR:?}
case "$1 $2" in
  'api repos/cbundy/dev-system/issues/'*)
    [ ! -f "$d/gh-fails" ] || exit 1
    a='{"login":"cbundy","id":13131067}'
    [ ! -f "$d/author" ] || a=$(cat "$d/author")
    jq -R -s --argjson u "$a" '{number: 1, state: "open", title: "t", body: "b", user: $u,
      labels: (split("\n") | map(select(. != "") | {name: .}))}' "$d/labels" ;;
  'issue view') echo "raw issue read: gh $*" >&2; exit 1 ;;
  'repo view') [ ! -f "$d/no-repo" ] || exit 1; echo cbundy/dev-system ;;
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
# bucket <issue> [repo]: the expected designer bucket
bucket() { printf 'designer:%s#%s' "${2:-cbundy/dev-system}" "$1" | cksum | { read -r c _; echo $((c % 100)); }; }
# route <issue> [PCT]; sets out, rc; PCT "unset" leaves the variable unset; REPO
# "none" leaves CALLUM_FLOW_REPO unset so the script asks gh
route() {
  set +e
  (
    unset CALLUM_FLOW_DESIGNER_SONNET_PCT CALLUM_FLOW_REPO
    [ "${2-unset}" = unset ] || export CALLUM_FLOW_DESIGNER_SONNET_PCT="$2"
    [ "${REPO:-}" = none ] || export CALLUM_FLOW_REPO="${REPO:-cbundy/dev-system}"
    PATH="$toolbin" STUB_DIR="$d" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_EVENT_BIN="$tmpdir/event" \
      CALLUM_FLOW_ISSUE_READ_BIN="${READ_BIN:-$READER}" CALLUM_FLOW_SHARE_DIR="$SHARE" \
      CALLUM_FLOW_TRUSTED_AUTHORS="${TRUSTED-cbundy:13131067}" "$SH" "$ROUTE" "$1"
  ) >"$tmpdir/out" 2>"$tmpdir/err"
  rc=$?
  set -e
  out=$(cat "$tmpdir/out")
}
# expect <model> <reason> <bucket> <pct> <what>: rc 0, one stdout line, one event
expect() {
  [ "$rc" = 0 ] || fail "$5: exit $rc (stderr: $(cat "$tmpdir/err"))"
  [ "$out" = "$1" ] || fail "$5: printed '$out', wanted '$1'"
  [ "$(grep -c . "$d/events")" = 1 ] || fail "$5: want exactly one event: $(cat "$d/events")"
  b=$3; [ "$b" != - ] || b=null
  want="--type designer_routed --issue ${ISSUE:-14} --data {\"model\":\"$1\",\"reason\":\"$2\",\"bucket\":$b,\"sonnet_pct\":$4}"
  printf '%s' "$(sed 's/^.*--data //' "$d/events")" | jq -e --slurpfile sc "$SCHEMA" '
    . as $e | $sc[0] as $s
    | ($e | keys | sort) == ($s.required | sort)
    and ($s.properties.reason.enum | index($e.reason)) != null
    and ($e.model | type == "string" and length > 0)
    and ($e.bucket == null or ($e.bucket | type == "number" and . >= 0 and . <= 99 and . == floor))
    and ($e.sonnet_pct == null or ($e.sonnet_pct | type == "number" and . >= 0 and . <= 100 and . == floor))' >/dev/null ||
    fail "$5: logged data does not validate against the schema: $(cat "$d/events")"
  [ "$(cat "$d/events")" = "$want" ] || fail "$5: event '$(cat "$d/events")', wanted '$want'"
}
usage_err() {
  [ "$rc" = 2 ] || fail "$1: exit $rc, wanted 2"
  [ -z "$out" ] || fail "$1: printed '$out' on a usage error"
  [ ! -s "$d/events" ] || fail "$1: logged on a usage error"
}

# the control is the designer agent's frontmatter model
control=$(sed -n 's/^model: *//p' "$AGENT")
[ -n "$control" ] || fail "no model: line in $AGENT"
reset; route 14; expect "$control" default - 0 "pct unset prints the designer frontmatter model"

# label overrides: the owner's pick wins over the hash, in either direction
reset; echo model:sonnet > "$d/labels"; route 14 0; expect sonnet label - 0 "sonnet label, pct 0"
reset; echo model:opus > "$d/labels"; route 14 100; expect opus label - 100 "opus label, pct 100"
reset; echo model:claude-sonnet-5-5 > "$d/labels"; route 14 0; expect claude-sonnet-5-5 label - 0 "full model id label"
reset; printf 'model:opus\nbug\nmodel:sonnet\n' > "$d/labels"; route 14 0; expect opus label - 0 "several labels: first sorted"
grep -q 'several model: labels; using model:opus' "$tmpdir/err" || fail "several labels must warn"
reset; printf 'model:sonnet\nmodel:sonnet\n' > "$d/labels"; route 14 0; expect sonnet label - 0 "a repeated label is one pick"
[ ! -s "$tmpdir/err" ] || fail "a repeated label must not warn: $(cat "$tmpdir/err")"
reset
# model:$(id) is a literal label: it must be ignored, never run
# shellcheck disable=SC2016
printf 'models:sonnet\nxmodel:sonnet\nmodel:\nmodel:op us\nmodel:$(id)\n' > "$d/labels"; route 14 0
expect opus default - 0 "look-alike, empty and unsafe labels are ignored"

# percentage
reset; route 14 0; expect opus default - 0 "pct 0"
reset; route 14 ""; expect opus default - 0 "pct empty"
reset; route 14 007; expect opus hash 73 7 "leading zeros are decimal"
reset; route 14 08; expect opus hash 73 8 "08 is not octal"
reset; route 14 100; expect sonnet hash 73 100 "pct 100"
reset; ISSUE=7; route 7 100; expect sonnet hash "$(bucket 7)" 100 "pct 100 any issue"; ISSUE=14

# pinned golden: cbundy/dev-system#14 is bucket 73 on every machine
[ "$(bucket 14)" = 73 ] || fail "cksum disagrees with the pinned golden bucket"
reset; route 14 74; expect sonnet hash 73 74 "bucket 73 below 74"
reset; route 14 73; expect opus hash 73 73 "bucket 73 at 73"
reset; route 14 50; expect opus hash 73 50 "bucket 73 at pct 50"
# #288 once had design bucket 82 (not below 75) but designer bucket 72 (sonnet at 75)
reset; ISSUE=288; route 288 75; expect sonnet hash 72 75 "salted away from the design bucket"; ISSUE=14
# an issue whose bucket is below 50
low=''
i=1
while [ -z "$low" ]; do
  b=$(bucket "$i")
  [ "$b" -lt 50 ] && low="$i:$b"
  i=$((i + 1))
done
reset; ISSUE=${low%:*}; route "$ISSUE" 50; expect sonnet hash "${low#*:}" 50 "bucket below 50"; ISSUE=14
# about half of issues 1..200 land below 50: the hash really splits
below=0
i=1
while [ "$i" -le 200 ]; do
  [ "$(bucket "$i")" -ge 50 ] || below=$((below + 1))
  i=$((i + 1))
done
if [ "$below" -lt 80 ] || [ "$below" -gt 120 ]; then
  fail "$below of 200 issues below bucket 50: the hash does not split evenly"
fi

# stable and case-insensitive on the repo
reset; route 14 74; first=$out; : > "$d/events"; route 14 74; [ "$out" = "$first" ] || fail "same issue routed differently"
reset; REPO=CBundy/Dev-System route 14 74; expect sonnet hash 73 74 "upper-case repo"; REPO=''
reset; REPO=none route 14 74; expect sonnet hash 73 74 "repo from gh when CALLUM_FLOW_REPO is unset"; REPO=''

# -h and --help print the usage line on stdout and exit 0, log nothing, and win
# over an invalid CALLUM_FLOW_DESIGNER_SONNET_PCT
help_ok() {
  [ "$rc" = 0 ] || fail "$1: exit $rc, wanted 0"
  [ "$out" = "usage: callum-flow-designer-route <issue>" ] || fail "$1: printed '$out'"
  [ ! -s "$tmpdir/err" ] || fail "$1: wrote to stderr: $(cat "$tmpdir/err")"
  [ ! -s "$d/events" ] || fail "$1: logged on help"
}
reset; route --help 50; help_ok "--help"
reset; route -h 50; help_ok "-h"
reset; route --help abc; help_ok "--help with invalid pct"
reset; route -h; help_ok "-h with pct unset"
reset
set +e; PATH="$toolbin" STUB_DIR="$d" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_EVENT_BIN="$tmpdir/event" CALLUM_FLOW_REPO=o/r "$SH" "$ROUTE" --help 14 >"$tmpdir/out" 2>/dev/null; rc=$?; set -e
out=$(cat "$tmpdir/out"); usage_err "--help with a second argument"

# usage errors log nothing
reset; route 14 abc; usage_err "pct abc"
grep -q CALLUM_FLOW_DESIGNER_SONNET_PCT "$tmpdir/err" || fail "usage message must name the variable"
reset; route 14 101; usage_err "pct 101"
reset; route 14 -5; usage_err "pct -5"
reset; route abc 50; usage_err "issue abc"
reset; route "" 50; usage_err "empty issue"
reset
set +e; PATH="$toolbin" STUB_DIR="$d" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_EVENT_BIN="$tmpdir/event" CALLUM_FLOW_REPO=o/r "$SH" "$ROUTE" >"$tmpdir/out" 2>/dev/null; rc=$?; set -e
out=$(cat "$tmpdir/out"); usage_err "no argument"

# fallbacks route to the control and warn
reset; touch "$d/gh-fails"; route 14 100; expect opus fallback - 100 "gh failure"
grep -q warning "$tmpdir/err" || fail "fallback must warn on stderr"
reset; touch "$d/no-repo"; REPO=none route 14 100; expect opus fallback - 100 "unknown repo"; REPO=''
grep -q CALLUM_FLOW_REPO "$tmpdir/err" || fail "unknown repo must say how to set it"

# the reader logs untrusted_stripped to the same event stub; only the route events matter
only_route_events() { grep '^--type designer_routed' "$d/events" > "$d/e2" || true; mv "$d/e2" "$d/events"; }
# trust (cbundy/dev-system#310): labels of an untrusted issue are never read, so a
# stranger's model:sonnet label cannot steer the route; the route falls back
reset; echo model:sonnet > "$d/labels"; echo '{"login":"mallory","id":999}' > "$d/author"; route 14 0
only_route_events; expect opus fallback - 0 "untrusted issue's model label is ignored"
reset; echo model:sonnet > "$d/labels"; echo '{"login":"cbundy","id":42}' > "$d/author"; route 14 0
only_route_events; expect opus fallback - 0 "right login, wrong id"
reset; echo model:sonnet > "$d/labels"; TRUSTED='' route 14 0
only_route_events; expect opus fallback - 0 "no trusted list fails closed"
unset TRUSTED
reset; echo model:sonnet > "$d/labels"; READ_BIN="$tmpdir/missing-reader" route 14 0
only_route_events; expect opus fallback - 0 "missing reader fails closed"
unset READ_BIN

# a failing event script changes nothing
reset; touch "$d/event-fails"; route 14 74
[ "$rc" = 0 ] || fail "event failure changed the exit code ($rc)"
[ "$out" = sonnet ] || fail "event failure changed the output ('$out')"
grep -q 'could not log' "$tmpdir/err" || fail "event failure must warn"

echo "designer-route tests passed"
