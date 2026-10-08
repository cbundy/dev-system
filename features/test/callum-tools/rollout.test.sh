#!/bin/sh
#
# shellcheck disable=SC2016
# (backticks in test data are literal)
# Plain-shell tests for callum-flow-rollout (cbundy/dev-system#239). A stub gh
# serves a canned `issue view --json body,comments`; hermetic PATH, no network.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROLLOUT="$SCRIPT_DIR/../../../images/base/callum-flow-rollout"

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
cat "$STUB_DIR/issue.json"
STUB
chmod +x "$tmpdir/gh"
st="$tmpdir/st"
mkdir -p "$st"

passed=0
# issue <body> [comment-body...]: write the canned issue
issue() {
  body=$1
  shift
  comments='[]'
  for c in "$@"; do comments=$(printf '%s' "$comments" | jq --arg c "$c" '. + [{body:$c}]'); done
  jq -n --arg b "$body" --argjson c "$comments" '{body:$b, comments:$c}' > "$st/issue.json"
}
brief() { printf '## Design brief\n\n## Sequencing\nnone\n\n## Rollout\n%s\n\n## Open decisions\nnone\n' "$1"; }
# r <args>: run the script; sets out, rc
r() {
  rc=0
  out=$(PATH="$toolbin" STUB_DIR="$st" CALLUM_FLOW_GH_BIN="$tmpdir/gh" "$SH" "$ROLLOUT" "$@" 2> "$tmpdir/err") || rc=$?
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

# usage errors
for args in "" "x" "5 6" "--bogus" "-h"; do
  rc=0
  # shellcheck disable=SC2086
  PATH="$toolbin" "$SH" "$ROLLOUT" $args > /dev/null 2>&1 || rc=$?
  [ "$rc" = 2 ] || fail "usage '$args' should exit 2, got $rc"
done
passed=$((passed + 1))

echo "rollout: $passed groups passed"
