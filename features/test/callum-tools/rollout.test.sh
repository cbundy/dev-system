#!/bin/sh
#
# shellcheck disable=SC2016
# (backticks in test data are literal)
# Plain-shell tests for callum-flow-rollout (cbundy/dev-system#239, #310). A stub gh
# serves canned REST issue and comment JSON to the real callum-flow-issue-read, so
# the trusted-author filter is exercised end to end; hermetic PATH, no network.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROLLOUT="$SCRIPT_DIR/../../../images/base/callum-flow-rollout"
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
for t in jq sed tr cat awk grep; do
  p=$(command -v "$t") || fail "$t not found"
  ln -s "$p" "$toolbin/$t"
done
SH=$(command -v sh)

cat > "$tmpdir/gh" <<'STUB'
#!/bin/sh
[ ! -f "${STUB_DIR:?}/gh-fail" ] || exit 1
[ "$1" = api ] || { echo "unexpected gh $*" >&2; exit 1; }
shift
[ "$1" != --paginate ] || shift
case "$1" in
  repos/o/r/issues/5) cat "$STUB_DIR/issue.json" ;;
  repos/o/r/issues/5/comments) cat "$STUB_DIR/comments.json" ;;
  *) echo "no fixture for $1" >&2; exit 1 ;;
esac
STUB
chmod +x "$tmpdir/gh"
st="$tmpdir/st"
mkdir -p "$st"

passed=0
OWNER='{"login":"cbundy","id":13131067}'
STRANGER='{"login":"mallory","id":999}'
# issue <body> [comment-body...]: write the canned issue and its comments, all by the owner
issue() {
  body=$1
  shift
  comments='[]'
  for c in "$@"; do comments=$(printf '%s' "$comments" | jq --argjson u "$OWNER" --arg c "$c" '. + [{id: (length + 1), user: $u, body: $c}]'); done
  jq -n --arg b "$body" --argjson u "$OWNER" '{number: 5, state: "open", title: "t", body: $b, user: $u, labels: []}' > "$st/issue.json"
  printf '%s' "$comments" > "$st/comments.json"
}
# stranger_comment <body>: append a comment by an untrusted author
stranger_comment() {
  jq --argjson u "$STRANGER" --arg c "$1" '. + [{id: (length + 100), user: $u, body: $c}]' "$st/comments.json" > "$st/c.tmp" && mv "$st/c.tmp" "$st/comments.json"
}
# issue_by_stranger: make the canned issue's author untrusted
issue_by_stranger() {
  jq --argjson u "$STRANGER" '.user = $u' "$st/issue.json" > "$st/i.tmp" && mv "$st/i.tmp" "$st/issue.json"
}
brief() { printf '## Design brief\n\n## Sequencing\nnone\n\n## Rollout\n%s\n\n## Open decisions\nnone\n' "$1"; }
# r <args>: run the script; sets out, rc
r() {
  rc=0
  out=$(PATH="$toolbin" STUB_DIR="$st" CALLUM_FLOW_GH_BIN="$tmpdir/gh" CALLUM_FLOW_REPO=o/r \
    CALLUM_FLOW_ISSUE_READ_BIN="${READ_BIN:-$READER}" CALLUM_FLOW_SHARE_DIR="$SHARE" \
    CALLUM_FLOW_EVENT_BIN="$tmpdir/noevent" CALLUM_FLOW_TRUSTED_AUTHORS="${TRUSTED-cbundy:13131067}" \
    "$SH" "$ROLLOUT" "$@" 2> "$tmpdir/err") || rc=$?
}
# want <name> <exit> <line>
want() {
  [ "$rc" = "$2" ] || fail "$1: exit $rc, want $2, out=$out"
  case "$out" in "$3"*) ;; *) fail "$1: got '$out', want '$3'" ;; esac
  [ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 1 ] 2> /dev/null || [ "$rc" != 0 ] || fail "$1: more than one line: $out"
  passed=$((passed + 1))
}

for v in run-it merge keep-open; do
  issue 'body' "$(brief "$v - a reason")"; r 5; want "brief $v" 0 "ROLLOUT $v source=brief"
done
issue 'body' "$(brief '`run-it` - fenced and dashed')"; r 5; want "decorated value" 0 "ROLLOUT run-it source=brief"
issue 'body' "$(brief 'run-it - old')" "chatter" "$(brief 'keep-open - new')"; r 5; want "latest brief wins" 0 "ROLLOUT keep-open source=brief"
issue 'body' "$(brief 'run-it - x')" "a later plain comment"; r 5; want "later non-brief comment ignored" 0 "ROLLOUT run-it source=brief"

issue 'Do it.

## Run it
release then run'; r 5; want "no brief, Run it heading" 0 "ROLLOUT run-it source=body"
issue 'Do it.'; r 5; want "no brief, no heading" 0 "ROLLOUT merge source=body"
issue 'Do it.

## Run it
x' "$(printf '## Design brief\n\n## Risk\nlow\n')"; r 5; want "pre-Rollout brief, Run it body" 0 "ROLLOUT run-it source=body"
issue 'Do it.

## Run it
x' "$(printf '## Design brief\n\n## Rollout\n\n## Open decisions\nnone\n')"; r 5; want "empty Rollout, Run it body" 0 "ROLLOUT run-it source=body"
issue 'Do it.

## Run it
x' "$(brief 'merge - plain')"; r 5; want "merge brief over Run it body" 1 "ROLLOUT conflict"
issue 'Do it.

## Run it
x' "$(brief 'keep-open - part 1 of 2')"; r 5; want "keep-open brief over Run it body" 0 "ROLLOUT keep-open source=brief"
issue 'x' "$(brief 'sometimes - x')"; r 5; want "invalid value" 1 "ROLLOUT invalid"

# not a heading: fenced code and prose
issue 'Shape:

```
## Run it
```
done'; r 5; want "heading inside a fence" 0 "ROLLOUT merge source=body"
issue 'Then Run it on Coder and report.
Run it: later'; r 5; want "prose mentioning Run it" 0 "ROLLOUT merge source=body"
issue 'x' "$(printf '## Design brief\n\n```\n## Rollout\nrun-it - in a fence\n```\n\n## Rollout\nmerge - real\n')"; r 5; want "Rollout inside a fence ignored" 0 "ROLLOUT merge source=brief"

# unreadable issue fails, never resolves
touch "$st/gh-fail"; r 5; want "gh failure" 1 "ROLLOUT unreadable"
rm "$st/gh-fail"

# trust: a stranger's fake brief, an untrusted issue, an unusable trusted list
issue 'x' "$(brief 'keep-open - real')"
stranger_comment "$(brief 'merge - fake')"
r 5; want "stranger's later brief is ignored" 0 "ROLLOUT keep-open source=brief"
issue 'x'
stranger_comment "$(brief 'merge - fake')"
r 5; want "stranger's brief alone is not a brief" 0 "ROLLOUT merge source=body"
issue 'Do it.

## Run it
x'
stranger_comment "$(brief 'merge - fake')"
r 5; want "stranger's merge brief cannot hide a Run it body" 0 "ROLLOUT run-it source=body"
issue 'x' "$(brief 'keep-open - real')"; issue_by_stranger
r 5; want "untrusted issue" 1 "ROLLOUT unreadable"
[ "$(printf '%s' "$out" | grep -c 'keep-open')" = 0 ] || fail "untrusted issue leaked a value: $out"
issue 'x' "$(brief 'keep-open - real')"
TRUSTED='' r 5; want "unset trusted list fails closed" 1 "ROLLOUT unreadable"
TRUSTED='cbundy:1' r 5; want "right login, wrong id fails closed" 1 "ROLLOUT unreadable"
TRUSTED=cbundy:13131067
READ_BIN="$tmpdir/missing-reader" r 5; want "missing reader fails closed" 1 "ROLLOUT unreadable"
unset READ_BIN
r 5; want "restored" 0 "ROLLOUT keep-open source=brief"

# usage errors
for args in "" "x" "5 6" "--bogus" "-h"; do
  rc=0
  # shellcheck disable=SC2086
  PATH="$toolbin" "$SH" "$ROLLOUT" $args > /dev/null 2>&1 || rc=$?
  [ "$rc" = 2 ] || fail "usage '$args' should exit 2, got $rc"
done
passed=$((passed + 1))

echo "rollout: $passed groups passed"
