#!/bin/sh
#
# Plain-shell tests for callum-flow-implementer-route (cbundy/dev-system#506). A
# stub gh serves a label list and a recording stub stands in for the event
# script. Hermetic PATH, no network, no Docker.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT="$SCRIPT_DIR/../../.."
ROUTE="$ROOT/images/base/callum-flow-implementer-route"
SHARE="$ROOT/images/base"
READER="$SHARE/callum-flow-issue-read"
AGENT="$ROOT/plugins/factory-loop/agents/builder.md"

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
EVENT="$SHARE/callum-flow-event"
realpath=$PATH

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
# the event tool: the real callum-flow-event writing to a scratch events directory (the stub dir's ev),
# or failing when $STUB_DIR/event-fails exists
cat > "$tmpdir/event" <<STUB
#!/bin/sh
[ ! -f "\${STUB_DIR:?}/event-fails" ] || exit 1
CALLUM_EVENTS_DIR="\$STUB_DIR/ev" PATH="$realpath" exec "$SH" "$EVENT" "\$@"
STUB
chmod +x "$tmpdir/gh" "$tmpdir/event"

d="$tmpdir/state"
reset() {
  rm -rf "$d"
  mkdir -p "$d"
  : > "$d/labels"
}
# bucket <issue> [repo]: the expected implementer bucket
bucket() { printf 'implementer:%s#%s' "${2:-cbundy/dev-system}" "$1" | cksum | { read -r c _; echo $((c % 100)); }; }
# route <issue> [PCT]; sets out, rc; PCT "unset" leaves the variable unset; REPO
# "none" leaves CALLUM_FLOW_REPO unset so the script asks gh
route() {
  set +e
  (
    unset CALLUM_FLOW_IMPLEMENTER_OPUS_PCT CALLUM_FLOW_REPO
    [ "${2-unset}" = unset ] || export CALLUM_FLOW_IMPLEMENTER_OPUS_PCT="$2"
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
  # the new log holds exactly one implementer_routed event (the issue reader's untrusted_stripped ones do not count)
  routed=$(cat "$d"/ev/factory/*.jsonl 2> /dev/null | jq -c 'select(.type == "implementer_routed")') || routed=
  [ "$(printf '%s' "$routed" | grep -c .)" = 1 ] || fail "$5: want exactly one event: $routed"
  printf '%s' "$routed" | jq -e --argjson n "${ISSUE:-506}" --arg m "$1" --arg r "$2" --arg b "$3" --argjson p "$4" \
    '.issue == $n and .data == {model: $m, reason: $r, bucket: (if $b == "-" then null else ($b | tonumber) end), opus_pct: $p}' > /dev/null ||
    fail "$5: event '$routed', wanted model $1 reason $2 bucket $3 pct $4"
  [ -z "$(cat "$d"/ev/*.jsonl 2> /dev/null)" ] || fail "$5: the old log must stay empty"
}
usage_err() {
  [ "$rc" = 2 ] || fail "$1: exit $rc, wanted 2"
  [ -z "$out" ] || fail "$1: printed '$out' on a usage error"
  [ ! -e "$d/ev" ] || fail "$1: logged on a usage error"
}

# the control is the builder agent's frontmatter model
control=$(sed -n 's/^model: *//p' "$AGENT")
[ -n "$control" ] || fail "no model: line in $AGENT"
reset; route 506; expect "$control" default - 0 "pct unset prints the builder frontmatter model"

# label overrides: the owner's pick wins over the hash, in either direction
reset; echo model:opus > "$d/labels"; route 506 0; expect opus label - 0 "opus label, pct 0"
reset; echo model:sonnet > "$d/labels"; route 506 100; expect sonnet label - 100 "sonnet label, pct 100"
reset; echo model:claude-opus-5-5 > "$d/labels"; route 506 0; expect claude-opus-5-5 label - 0 "full model id label"
reset; printf 'model:sonnet\nbug\nmodel:opus\n' > "$d/labels"; route 506 0; expect opus label - 0 "several labels: first sorted"
grep -q 'several model: labels; using model:opus' "$tmpdir/err" || fail "several labels must warn"
reset; printf 'model:opus\nmodel:opus\n' > "$d/labels"; route 506 0; expect opus label - 0 "a repeated label is one pick"
[ ! -s "$tmpdir/err" ] || fail "a repeated label must not warn: $(cat "$tmpdir/err")"
reset
# model:$(id) is a literal label: it must be ignored, never run
# shellcheck disable=SC2016
printf 'models:opus\nxmodel:opus\nmodel:\nmodel:op us\nmodel:$(id)\n' > "$d/labels"; route 506 0
expect sonnet default - 0 "look-alike, empty and unsafe labels are ignored"

# percentage
reset; route 506 0; expect sonnet default - 0 "pct 0"
reset; route 506 ""; expect sonnet default - 0 "pct empty"
reset; route 506 007; expect sonnet hash 68 7 "leading zeros are decimal"
reset; route 506 08; expect sonnet hash 68 8 "08 is not octal"
reset; route 506 100; expect opus hash 68 100 "pct 100"
reset; ISSUE=7; route 7 100; expect opus hash "$(bucket 7)" 100 "pct 100 any issue"; ISSUE=506

# pinned golden: cbundy/dev-system#506 is bucket 68 on every machine
[ "$(bucket 506)" = 68 ] || fail "cksum disagrees with the pinned golden bucket"
reset; route 506 69; expect opus hash 68 69 "bucket 68 below 69"
reset; route 506 68; expect sonnet hash 68 68 "bucket 68 at 68"
reset; route 506 50; expect sonnet hash 68 50 "bucket 68 at pct 50"
# independent of the designer split: #288 had design bucket 82 (sub-agent at
# 50) but implementer bucket 15 (opus at 50)
reset; ISSUE=288; route 288 50; expect opus hash 15 50 "salted away from the design bucket"; ISSUE=506
# an issue whose bucket is below 50
low=''
i=1
while [ -z "$low" ]; do
  b=$(bucket "$i")
  [ "$b" -lt 50 ] && low="$i:$b"
  i=$((i + 1))
done
reset; ISSUE=${low%:*}; route "$ISSUE" 50; expect opus hash "${low#*:}" 50 "bucket below 50"; ISSUE=506
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
reset; route 506 69; first=$out; rm -rf "$d/ev"; route 506 69; [ "$out" = "$first" ] || fail "same issue routed differently"
reset; REPO=CBundy/Dev-System route 506 69; expect opus hash 68 69 "upper-case repo"; REPO=''
reset; REPO=none route 506 69; expect opus hash 68 69 "repo from gh when CALLUM_FLOW_REPO is unset"; REPO=''

# -h and --help print the usage line on stdout and exit 0, log nothing, and win
# over an invalid CALLUM_FLOW_IMPLEMENTER_OPUS_PCT
help_ok() {
  [ "$rc" = 0 ] || fail "$1: exit $rc, wanted 0"
  [ "$out" = "usage: callum-flow-implementer-route <issue>" ] || fail "$1: printed '$out'"
  [ ! -s "$tmpdir/err" ] || fail "$1: wrote to stderr: $(cat "$tmpdir/err")"
  [ ! -e "$d/ev" ] || fail "$1: logged on help"
}
reset; route --help 50; help_ok "--help"
reset; route -h 50; help_ok "-h"
reset; route --help abc; help_ok "--help with invalid pct"
reset; route -h; help_ok "-h with pct unset"
reset
set +e; PATH="$toolbin" STUB_DIR="$d" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_EVENT_BIN="$tmpdir/event" CALLUM_FLOW_REPO=o/r "$SH" "$ROUTE" --help 506 >"$tmpdir/out" 2>/dev/null; rc=$?; set -e
out=$(cat "$tmpdir/out"); usage_err "--help with a second argument"

# usage errors log nothing
reset; route 506 abc; usage_err "pct abc"
grep -q CALLUM_FLOW_IMPLEMENTER_OPUS_PCT "$tmpdir/err" || fail "usage message must name the variable"
reset; route 506 101; usage_err "pct 101"
reset; route 506 -5; usage_err "pct -5"
reset; route abc 50; usage_err "issue abc"
reset; route "" 50; usage_err "empty issue"
reset
set +e; PATH="$toolbin" STUB_DIR="$d" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_EVENT_BIN="$tmpdir/event" CALLUM_FLOW_REPO=o/r "$SH" "$ROUTE" >"$tmpdir/out" 2>/dev/null; rc=$?; set -e
out=$(cat "$tmpdir/out"); usage_err "no argument"

# fallbacks route to the control and warn
reset; touch "$d/gh-fails"; route 506 100; expect sonnet fallback - 100 "gh failure"
grep -q warning "$tmpdir/err" || fail "fallback must warn on stderr"
reset; touch "$d/no-repo"; REPO=none route 506 100; expect sonnet fallback - 100 "unknown repo"; REPO=''
grep -q CALLUM_FLOW_REPO "$tmpdir/err" || fail "unknown repo must say how to set it"

# the reader logs untrusted_stripped to the same event log; only the route events matter (expect filters)
# trust (cbundy/dev-system#310): labels of an untrusted issue are never read, so a
# stranger's model:opus label cannot steer the route; the route falls back
reset; echo model:opus > "$d/labels"; echo '{"login":"mallory","id":999}' > "$d/author"; route 506 0
expect sonnet fallback - 0 "untrusted issue's model label is ignored"
reset; echo model:opus > "$d/labels"; echo '{"login":"cbundy","id":42}' > "$d/author"; route 506 0
expect sonnet fallback - 0 "right login, wrong id"
reset; echo model:opus > "$d/labels"; TRUSTED='' route 506 0
expect sonnet fallback - 0 "no trusted list fails closed"
unset TRUSTED
reset; echo model:opus > "$d/labels"; READ_BIN="$tmpdir/missing-reader" route 506 0
expect sonnet fallback - 0 "missing reader fails closed"
unset READ_BIN

# a failing event script changes nothing
reset; touch "$d/event-fails"; route 506 69
[ "$rc" = 0 ] || fail "event failure changed the exit code ($rc)"
[ "$out" = opus ] || fail "event failure changed the output ('$out')"
grep -q 'could not log' "$tmpdir/err" || fail "event failure must warn"

echo "implementer-route tests passed"
