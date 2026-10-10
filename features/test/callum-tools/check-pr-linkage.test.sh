#!/bin/sh
#
# Plain-shell tests for check-pr-linkage.sh. Runs the script from its source
# location against a stateful stub `gh` (no network, no Docker): the stub keeps
# a PR's branch, base and body in files, answers `pr view` with JSON, applies
# `pr edit --body-file`, and derives closingIssuesReferences from the body the
# way GitHub does - but only when the PR targets the default branch. The script
# is read-only (cbundy/dev-system#233): every case asserts it never edited; the
# repair itself is tested in fix-linkage.test.sh.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
SCRIPT="$SCRIPT_DIR/../../src/callum-tools/check-pr-linkage.sh"
SHARE="$SCRIPT_DIR/../../../images/base"
READER="$SHARE/callum-flow-issue-read"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
mkdir -p "$tmpdir/bin"
node_bin=$(command -v node) || fail "node not found"
for t in cmp bash grep cat mktemp rm sleep cp basename touch jq; do
  p=$(command -v "$t") || fail "$t not found"
  ln -s "$p" "$tmpdir/bin/$t"
done

cat > "$tmpdir/bin/node" <<'NODE_STUB'
#!/bin/sh
if [ "${STUB_FAIL_NODE:-}" = fix ] && [ "$4" = fix ]; then
  printf 'partial repaired body'
  exit 42
fi
if [ "${STUB_FAIL_NODE:-}" = empty ] && [ "$4" = fix ]; then
  exit 42
fi
if [ "${STUB_FAIL_NODE:-}" = body ] && [ "$4" = field ] && [ "$5" = body ]; then
  if [ -f "$STUB_DIR/body-read" ]; then
    printf 'partial extracted body'
    exit 42
  fi
  touch "$STUB_DIR/body-read"
fi
exec "$STUB_NODE_BIN" "$@"
NODE_STUB
chmod +x "$tmpdir/bin/node"

cat > "$tmpdir/bin/gh" <<'STUB'
#!/bin/sh
d=${STUB_DIR:?}
if [ "$1" = api ]; then
  # the PR as REST returns it, for callum-flow-issue-read; the author is a knob
  [ "$2" = repos/o/r/pulls/7 ] || { echo "no fixture for $2" >&2; exit 1; }
  echo "$2" >> "$d/api-calls"
  a='{"login":"cbundy","id":13131067}'
  [ ! -f "$d/author" ] || a=$(cat "$d/author")
  [ ! -f "$d/api-fail" ] || exit 1
  jq -n --argjson u "$a" '{number: 7, state: "open", title: "t", body: "b", user: $u}'
  exit
fi
case "$1 $2" in
  'repo view') echo '{"defaultBranchRef":{"name":"main"},"nameWithOwner":"local/repo"}' ;;
  "pr view")
    node -e '
      const fs = require("fs"), d = process.argv[1];
      const r = (f) => fs.readFileSync(d + "/" + f, "utf8").replace(/\n$/, "");
      const body = fs.readFileSync(d + "/body", "utf8");
      const apiBody = process.env.STUB_API_BODY || body;
      const matches = r("base") === "main" ? [...apiBody.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*(?:([\w.-]+)\/([\w.-]+))?#(\d+)\b/gi)] : [];
      const refs = matches.map((m) => ({number: Number(m[3]), repository: {owner: {login: m[1] || "local"}, name: m[2] || "repo"}}));
      refs.sort((a, b) => a.number - b.number);
      console.log(JSON.stringify({ headRefName: r("head"), baseRefName: r("base"),
        body: fs.readFileSync(d + "/body", "utf8"),
        closingIssuesReferences: refs }));
    ' "$d"
    ;;
  "pr edit")
    [ "$3" = 7 ] && [ "$4" = --body-file ] || exit 1
    touch "$d/edited"
    cp "$5" "$d/body"
    ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$tmpdir/bin/gh"

# the real reader behind the stub gh
export CALLUM_FLOW_GH_BIN="$tmpdir/bin/gh" CALLUM_FLOW_REPO=o/r CALLUM_FLOW_ISSUE_READ_BIN="$READER" \
  CALLUM_FLOW_SHARE_DIR="$SHARE" CALLUM_FLOW_TRUSTED_AUTHORS=cbundy:13131067 CALLUM_FLOW_EVENT_BIN="$tmpdir/noevent"

# stub_knobs: apply the author and api_fail knobs to the stub's state
stub_knobs() {
  [ -z "${pr_author-}" ] || printf '%s\n' "$pr_author" > "$STUB_DIR/author"
  [ -z "${api_fail-}" ] || touch "$STUB_DIR/api-fail"
}

passed=0
# run_case <name> <head> <base> <body> <expected stdout prefix> <expected body or ""> args...
run_case() {
  name=$1 head=$2 base=$3 body=$4 want=$5 wantbody=$6
  shift 6
  STUB_DIR="$tmpdir/state"
  rm -rf "$STUB_DIR"
  mkdir -p "$STUB_DIR"
  printf '%s\n' "$head" > "$STUB_DIR/head"
  printf '%s\n' "$base" > "$STUB_DIR/base"
  printf '%s' "$body" > "$STUB_DIR/body"
  stub_knobs
  out=$(PATH="$tmpdir/bin" STUB_DIR="$STUB_DIR" CHECK_PR_LINKAGE_GH_BIN="$tmpdir/bin/gh" \
    STUB_NODE_BIN="$node_bin" STUB_FAIL_NODE="${fail_node:-}" \
    STUB_API_BODY="${stale_api_body:-}" \
    CHECK_PR_LINKAGE_RETRY_SLEEP=0 bash "$SCRIPT" 7 "$@" 2>"$tmpdir/stderr") && rc=0 || rc=$?
  case "$out" in
    "$want"*) ;;
    *) fail "$name: expected '$want...', got '$out'" ;;
  esac
  case "$want" in
    "") [ "$rc" -ne 0 ] || fail "$name: expected failure"
      [ ! -f "$STUB_DIR/edited" ] || fail "$name: edited PR despite failure" ;;
    MISMATCH*) [ "$rc" -eq 1 ] || fail "$name: expected exit 1, got $rc" ;;
    *) [ "$rc" -eq 0 ] || fail "$name: expected exit 0, got $rc" ;;
  esac
  [ ! -f "$STUB_DIR/edited" ] || fail "$name: the read-only check edited the PR"
  if [ -n "$wantbody" ]; then
    printf "%s" "$wantbody" | cmp -s - "$STUB_DIR/body" || fail "$name: body is now:
$(cat "$STUB_DIR/body")"
  fi
  passed=$((passed + 1))
}

# fix_case: same arguments as run_case, last one --print-fix. The repaired body
# goes to stdout (compared byte for byte against the expected body), nothing is
# edited, and stdout carries nothing else. An empty expected stdout means failure.
fix_case() {
  name=$1 head=$2 base=$3 body=$4 want=$5 wantbody=$6
  shift 6
  STUB_DIR="$tmpdir/state"
  rm -rf "$STUB_DIR"
  mkdir -p "$STUB_DIR"
  printf '%s\n' "$head" > "$STUB_DIR/head"
  printf '%s\n' "$base" > "$STUB_DIR/base"
  printf '%s' "$body" > "$STUB_DIR/body"
  stub_knobs
  rc=0
  PATH="$tmpdir/bin" STUB_DIR="$STUB_DIR" CHECK_PR_LINKAGE_GH_BIN="$tmpdir/bin/gh" \
    STUB_NODE_BIN="$node_bin" STUB_FAIL_NODE="${fail_node:-}" \
    STUB_API_BODY="${stale_api_body:-}" bash "$SCRIPT" 7 "$@" >"$tmpdir/stdout" 2>"$tmpdir/stderr" || rc=$?
  [ ! -f "$STUB_DIR/edited" ] || fail "$name: --print-fix edited the PR"
  if [ -z "$want" ]; then
    [ "$rc" -ne 0 ] || fail "$name: expected failure"
    [ ! -s "$tmpdir/stdout" ] || fail "$name: wrote to stdout despite failure"
  else
    [ "$rc" -eq 0 ] || fail "$name: expected exit 0, got $rc"
    printf '%s' "$wantbody" | cmp -s - "$tmpdir/stdout" || fail "$name: stdout is:
$(cat "$tmpdir/stdout")"
  fi
  passed=$((passed + 1))
}

H=feat/issue-12-thing
nl='
'

run_case "default branch closing matches" $H main "Closes #12" "MATCH #7 issue=#12 expect=closing via=api actual=[12]" ""
run_case "default branch refs matches" $H main "Refs #12" "MATCH #7 issue=#12 expect=refs via=api actual=[]" "" --expect refs
run_case "closing keyword dropped" $H main "Fix GitHub issue #12" "MISMATCH #7" "" 
run_case "refs PR with a closing keyword" $H main "Closes #12" "MISMATCH #7 issue=#12 expect=refs" "" --expect refs
run_case "stray Closes #M in description text" $H main "It must not Closes #99 here.${nl}Closes #12" "MISMATCH #7 issue=#12 expect=closing via=api actual=[12,99]" ""
fix_case "fix appends the keyword" $H main "Summary" "REPAIRED #7" "Summary${nl}${nl}Closes #12${nl}" --print-fix
fix_case "fix neutralizes a stray closing keyword" $H main "Do not Closes #99.${nl}Closes #12" "REPAIRED #7" "Do not Refs #99.${nl}Closes #12" --print-fix
fix_case "fix turns a closing keyword into Refs" $H main "Fixes #12" "REPAIRED #7" "Refs #12" --expect refs --print-fix
fix_case "fix keeps the Pipeline section verbatim" $H main "Hi${nl}${nl}## Pipeline${nl}a log  line${nl}" "REPAIRED #7" "Hi${nl}${nl}Closes #12${nl}${nl}## Pipeline${nl}a log  line${nl}" --print-fix
run_case "epic base closing keyword in body" $H epic/x "Closes #12" "MATCH #7 issue=#12 expect=closing via=body actual=[12]" ""
run_case "epic base refs matches" $H epic/x "Refs #12" "MATCH #7 issue=#12 expect=refs via=body actual=[]" "" --expect refs
run_case "epic base missing keyword" $H epic/x "nothing" "MISMATCH #7 issue=#12 expect=closing via=body" ""
fix_case "epic base fix" $H epic/x "nothing" "REPAIRED #7 issue=#12 expect=closing via=body" "nothing${nl}${nl}Closes #12${nl}" --print-fix
for base in main epic/x; do
  run_case "foreign issue with same number ($base)" $H "$base" "Closes other/repo#12" "MISMATCH #7" ""
  run_case "qualified local issue ($base)" $H "$base" "Closes LOCAL/REPO#12" "MATCH #7" ""
  run_case "qualified local and short issue deduplicate ($base)" $H "$base" "Closes #12; Fixes local/repo#12" "MATCH #7" ""
  run_case "foreign stray issue ($base)" $H "$base" "Closes #12; Fixes other/repo#99" "MISMATCH #7" ""
  fix_case "repair foreign same-number issue ($base)" $H "$base" "Closes other/repo#12" "REPAIRED #7" "Refs other/repo#12${nl}${nl}Closes #12${nl}" --print-fix
  fix_case "repair foreign stray issue ($base)" $H "$base" "Closes #12; Fixes other/repo#99" "REPAIRED #7" "Closes #12; Refs other/repo#99" --print-fix
  fix_case "refs neutralizes every repository ($base)" $H "$base" "Closes local/repo#12; Resolves other/repo#99" "REPAIRED #7" "Refs local/repo#12; Refs other/repo#99" --expect refs --print-fix
  pipeline="Closes #12${nl}## Pipeline${nl}Fixes other/repo#99${nl}"
  run_case "Pipeline stray keyword ($base)" $H "$base" "$pipeline" "MISMATCH #7" ""
  fix_case "Pipeline stray keyword cannot be repaired ($base)" $H "$base" "$pipeline" "MISMATCH #7" "$pipeline" --print-fix
  pipeline="Closes #12${nl}## Pipeline${nl}Closes #99${nl}"
  run_case "Pipeline local stray keyword ($base)" $H "$base" "$pipeline" "MISMATCH #7" ""
  fix_case "Pipeline local stray cannot be repaired ($base)" $H "$base" "$pipeline" "MISMATCH #7" "$pipeline" --print-fix
  pipeline="## Pipeline${nl}Closes #12${nl}"
  run_case "Pipeline closing keyword rejects refs ($base)" $H "$base" "$pipeline" "MISMATCH #7" "" --expect refs
  fix_case "Pipeline prevents refs repair ($base)" $H "$base" "$pipeline" "MISMATCH #7" "Refs #12${nl}${nl}$pipeline" --expect refs --print-fix
  run_case "Pipeline local closing keyword ($base)" $H "$base" "$pipeline" "MATCH #7" ""
  for ref in "Refs #12" "Part of #12" "Refs LOCAL/REPO#12" "Part of local/repo#12"; do
    run_case "keep-open reference matches ($base)" $H "$base" "$ref" "MATCH #7" "$ref" --expect refs
    fix_case "keep-open fix is unchanged ($base)" $H "$base" "$ref" "MATCH #7" "$ref" --expect refs --print-fix
  done
  for body in "Summary" "Refs #99" "Refs other/repo#12" "Part of other/repo#12" "Refs https://github.com/local/repo/issues/12"; do
    run_case "missing local keep-open reference ($base)" $H "$base" "$body" "MISMATCH #7" "$body" --expect refs
    fix_case "append missing keep-open reference ($base)" $H "$base" "$body" "REPAIRED #7" "$body${nl}${nl}Refs #12${nl}" --expect refs --print-fix
  done
  body="Summary${nl}## Pipeline${nl}Part of #12${nl}"
  run_case "keep-open reference in Pipeline ($base)" $H "$base" "$body" "MATCH #7" "$body" --expect refs
  body="Summary${nl}## Pipeline${nl}log  line${nl}"
  fix_case "append refs before preserved Pipeline ($base)" $H "$base" "$body" "REPAIRED #7" "Summary${nl}${nl}Refs #12${nl}${nl}## Pipeline${nl}log  line${nl}" --expect refs --print-fix
  author="Summary line"
  appendix="<!-- no-mistakes-pr-appendix:v1 sha256=abc -->${nl}## Risk Assessment${nl}low${nl}## Pipeline${nl}log  line${nl}<!-- /no-mistakes-pr-appendix:v1 -->${nl}"
  body="${author}${nl}${nl}${appendix}"
  fix_case "appendix: keyword lands before the marker ($base)" $H "$base" "$body" "REPAIRED #7" "${author}${nl}${nl}Closes #12${nl}${nl}${appendix}" --print-fix
  fix_case "appendix: refs keyword lands before the marker ($base)" $H "$base" "$body" "REPAIRED #7" "${author}${nl}${nl}Refs #12${nl}${nl}${appendix}" --expect refs --print-fix
  body="${appendix}"
  fix_case "appendix at the very start ($base)" $H "$base" "$body" "REPAIRED #7" "Closes #12${nl}${nl}${appendix}" --print-fix
  body="Fixes #99${nl}${nl}${appendix}"
  fix_case "appendix: stray keyword in author text is rewritten ($base)" $H "$base" "$body" "REPAIRED #7" "Refs #99${nl}${nl}Closes #12${nl}${nl}${appendix}" --print-fix
  appendix_stray="<!-- no-mistakes-pr-appendix:v1 sha256=abc -->${nl}Fixes #99${nl}<!-- /no-mistakes-pr-appendix:v1 -->${nl}"
  body="${author}${nl}${nl}${appendix_stray}"
  fix_case "appendix: stray keyword inside is untouched ($base)" $H "$base" "$body" "MISMATCH #7" "${author}${nl}${nl}Closes #12${nl}${nl}${appendix_stray}" --print-fix
  grep -q "inside the no-mistakes appendix" "$tmpdir/stderr" || fail "appendix stray: stderr does not name the appendix"
  grep -q "fresh pipeline run" "$tmpdir/stderr" || fail "appendix stray: stderr does not name the workaround"
  fix_case "appendix: clean body prints no appendix reason ($base)" $H "$base" "${author}${nl}${nl}${appendix}" "REPAIRED #7" "${author}${nl}${nl}Closes #12${nl}${nl}${appendix}" --print-fix
  if grep -q "inside the no-mistakes appendix" "$tmpdir/stderr"; then fail "clean appendix printed a reason"; fi
  appendix_quote="<!-- no-mistakes-pr-appendix:v1 sha256=abc -->${nl}intent: Closes #12${nl}<!-- /no-mistakes-pr-appendix:v1 -->${nl}"
  body="Fixes #99${nl}${nl}${appendix_quote}"
  fix_case "appendix: keyword only inside does not count as present ($base)" $H "$base" "$body" "REPAIRED #7" "Refs #99${nl}${nl}Closes #12${nl}${nl}${appendix_quote}" --print-fix
  body="${author}${nl}${nl}${appendix}${nl}After Fixes #99 text"
  fix_case "appendix: author text after the closing marker is editable ($base)" $H "$base" "$body" "REPAIRED #7" "${author}${nl}${nl}Closes #12${nl}${nl}${appendix}${nl}After Refs #99 text" --print-fix
  unclosed="<!-- no-mistakes-pr-appendix:v1 sha256=abc -->${nl}Fixes #99${nl}tail  text"
  body="${author}${nl}${nl}${unclosed}"
  fix_case "appendix: unclosed marker protects to the end ($base)" $H "$base" "$body" "MISMATCH #7" "${author}${nl}${nl}Closes #12${nl}${nl}${unclosed}" --print-fix
  body="Closes #99"
  fix_case "refs repair adds local reference after neutralizing stray ($base)" $H "$base" "$body" "REPAIRED #7" "Refs #99${nl}${nl}Refs #12${nl}" --expect refs --print-fix
  body="Closes #12; Closes https://tracker.example/local/repo/issues/99"
  run_case "tracker URL is ignored ($base)" $H "$base" "$body" "MATCH #7" "$body"
  body='Closes https://<host>/owner/repo/issues/99'
  fix_case "placeholder URL is preserved ($base)" $H "$base" "$body" "REPAIRED #7" "$body${nl}${nl}Closes #12${nl}" --print-fix
done
run_case "epic refs guidance" $H epic/x "Refs #12" "MATCH #7" "" --expect refs
grep -q "Keep #12 open after merge" "$tmpdir/stderr" || fail "missing keep-open guidance"
if grep -q "by hand" "$tmpdir/stderr"; then fail "refs guidance asks for manual closure"; fi
run_case "epic closing guidance" $H epic/x "Closes #12" "MATCH #7" ""
grep -q "Close #12 by hand" "$tmpdir/stderr" || fail "missing manual-closing guidance"
stale_api_body="Closes #12"
for body in "Closes #99" "Summary" "Closes other/repo#12" "Closes #12${nl}## Pipeline${nl}Closes #99"; do
  run_case "stale API cannot hide current closing targets" $H main "$body" "MISMATCH #7" "$body"
done
fix_case "repair body despite stale matching API" $H main "Closes #99" "REPAIRED #7" "Refs #99${nl}${nl}Closes #12${nl}" --print-fix
fix_case "stale API prevents refs repair success" $H main "Closes #12" "MISMATCH #7" "Refs #12" --expect refs --print-fix
stale_api_body="Refs #12"
for body in "Closes #12" "Fixes other/repo#99" "## Pipeline${nl}Closes #99"; do
  run_case "stale empty API cannot hide a closing keyword" $H main "$body" "MISMATCH #7" "$body" --expect refs
done
fix_case "repair refs despite stale matching API" $H main "Closes #12" "REPAIRED #7" "Refs #12" --expect refs --print-fix
fix_case "stale API prevents closing repair success" $H main "Summary" "MISMATCH #7" "Summary${nl}${nl}Closes #12${nl}" --print-fix
stale_api_body="Closes #12"
stale_api_body="Refs #12"
unset stale_api_body
run_case "branch without issue segment is skipped" epic/big main "x" "SKIP #7 epic/big" ""

fail_node=body
fix_case "body extraction failure preserves PR body" $H main "Summary${nl}" "" "Summary${nl}" --print-fix
for fail_node in fix empty; do
  for base in main epic/x; do
    for expectation in closing refs; do
      fix_case "internal $fail_node failure preserves PR ($base, $expectation)" $H "$base" "Summary${nl}" "" "Summary${nl}" --expect "$expectation" --print-fix
    done
  done
done
unset fail_node
run_case "reject refs argument alias" $H main "Refs #12" "" "Refs #12" --expect=refs
run_case "reject closing argument alias" $H main "Closes #12" "" "Closes #12" --expect=closing

# --fix is gone: it must refuse, name the replacement, and edit nothing.
for fixargs in "--fix" "--expect refs --fix"; do
  # shellcheck disable=SC2086
  run_case "--fix is refused ($fixargs)" $H main "Summary" "" "Summary" $fixargs
  grep -q "callum-flow-fix-linkage" "$tmpdir/stderr" || fail "--fix refusal does not name callum-flow-fix-linkage"
  if grep -qi "unknown flag" "$tmpdir/stderr"; then fail "--fix refused as a generic unknown flag"; fi
done
# The MISMATCH hints point at the replacement, and no case ever edited a PR.
run_case "mismatch hint names the fix command" $H main "Summary" "MISMATCH #7" "Summary"
grep -q "callum-flow-fix-linkage" "$tmpdir/stderr" || fail "closing hint does not name callum-flow-fix-linkage"
run_case "refs mismatch hint names the fix command" $H main "Summary" "MISMATCH #7" "Summary" --expect refs
grep -q "callum-flow-fix-linkage" "$tmpdir/stderr" || fail "refs hint does not name callum-flow-fix-linkage"
if grep -q -- "--fix" "$tmpdir/stderr"; then fail "hint still mentions --fix"; fi
# trust (cbundy/dev-system#310): an untrusted PR is refused before its body is read or
# printed, in every mode, and a reader failure fails closed
stranger='{"login":"mallory","id":999}'
pr_author=$stranger
run_case "untrusted author is refused" $H main "Closes #12" "" "Closes #12"
grep -q "not opened by a trusted author" "$tmpdir/stderr" || fail "untrusted refusal reason: $(cat "$tmpdir/stderr")"
[ -z "$out" ] || fail "untrusted author printed: $out"
run_case "untrusted author, refs" $H main "Refs #12" "" "Refs #12" --expect refs
run_case "untrusted author, print-fix prints no body" $H main "Hostile body" "" "Hostile body" --print-fix
[ -z "$out" ] || fail "untrusted print-fix leaked the body: $out"
run_case "untrusted author, branch without issue" epic/big main "Hostile" "" "Hostile"
pr_author='{"login":"cbundy","id":42}'
run_case "right login, wrong id is refused" $H main "Closes #12" "" "Closes #12"
unset pr_author
api_fail=1 run_case "reader failure fails closed" $H main "Closes #12" "" "Closes #12"
grep -q "cannot verify the author" "$tmpdir/stderr" || fail "reader failure reason: $(cat "$tmpdir/stderr")"
CALLUM_FLOW_ISSUE_READ_BIN="$tmpdir/missing-reader" run_case "missing reader fails closed" $H main "Closes #12" "" "Closes #12"
unset api_fail
export CALLUM_FLOW_ISSUE_READ_BIN="$READER"
run_case "trusted author still passes" $H main "Closes #12" "MATCH #7" "Closes #12"
echo "check-pr-linkage: $passed passed"
