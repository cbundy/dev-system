#!/bin/sh
#
# Plain-shell tests for check-pr-linkage.sh. Runs the script from its source
# location against a stateful stub `gh` (no network, no Docker): the stub keeps
# a PR's branch, base and body in files, answers `pr view` with JSON, applies
# `pr edit --body-file`, and derives closingIssuesReferences from the body the
# way GitHub does - but only when the PR targets the default branch.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
SCRIPT="$SCRIPT_DIR/../../src/callum-tools/check-pr-linkage.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
mkdir -p "$tmpdir/bin"
for t in cmp node bash grep cat mktemp rm sleep cp; do
  p=$(command -v "$t") || fail "$t not found"
  ln -s "$p" "$tmpdir/bin/$t"
done

cat > "$tmpdir/bin/gh" <<'STUB'
#!/bin/sh
d=${STUB_DIR:?}
case "$1 $2" in
  'repo view') echo '{"defaultBranchRef":{"name":"main"},"nameWithOwner":"local/repo","url":"https://github.com/local/repo"}' ;;
  "pr view")
    node -e '
      const fs = require("fs"), d = process.argv[1];
      const r = (f) => fs.readFileSync(d + "/" + f, "utf8").replace(/\n$/, "");
      const body = fs.readFileSync(d + "/body", "utf8");
      const matches = r("base") === "main" ? [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*(?:(?:([\w.-]+)\/([\w.-]+))?#|https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/)(\d+)\b/gi)] : [];
      const refs = matches.map((m) => ({number: Number(m[5]), repository: {owner: {login: m[1] || m[3] || "local"}, name: m[2] || m[4] || "repo"}}));
      refs.sort((a, b) => a.number - b.number);
      console.log(JSON.stringify({ headRefName: r("head"), baseRefName: r("base"),
        body: fs.readFileSync(d + "/body", "utf8"),
        closingIssuesReferences: refs }));
    ' "$d"
    ;;
  "pr edit")
    [ "$3" = 7 ] && [ "$4" = --body-file ] || exit 1
    cp "$5" "$d/body"
    ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$tmpdir/bin/gh"

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
  out=$(PATH="$tmpdir/bin" STUB_DIR="$STUB_DIR" CHECK_PR_LINKAGE_GH_BIN="$tmpdir/bin/gh" \
    CHECK_PR_LINKAGE_RETRY_SLEEP=0 bash "$SCRIPT" 7 "$@" 2>"$tmpdir/stderr") && rc=0 || rc=$?
  case "$out" in
    "$want"*) ;;
    *) fail "$name: expected '$want...', got '$out'" ;;
  esac
  case "$want" in
    MISMATCH*) [ "$rc" -eq 1 ] || fail "$name: expected exit 1, got $rc" ;;
    *) [ "$rc" -eq 0 ] || fail "$name: expected exit 0, got $rc" ;;
  esac
  if [ -n "$wantbody" ]; then
    printf "%s" "$wantbody" | cmp -s - "$STUB_DIR/body" || fail "$name: body is now:
$(cat "$STUB_DIR/body")"
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
run_case "fix appends the keyword" $H main "Summary" "REPAIRED #7" "Summary${nl}${nl}Closes #12${nl}" --fix
run_case "fix neutralizes a stray closing keyword" $H main "Do not Closes #99.${nl}Closes #12" "REPAIRED #7" "Do not Refs #99.${nl}Closes #12" --fix
run_case "fix turns a closing keyword into Refs" $H main "Fixes #12" "REPAIRED #7" "Refs #12" --expect refs --fix
run_case "fix keeps the Pipeline section verbatim" $H main "Hi${nl}${nl}## Pipeline${nl}a log  line${nl}" "REPAIRED #7" "Hi${nl}${nl}Closes #12${nl}${nl}## Pipeline${nl}a log  line${nl}" --fix
run_case "epic base closing keyword in body" $H epic/x "Closes #12" "MATCH #7 issue=#12 expect=closing via=body actual=[12]" ""
run_case "epic base refs matches" $H epic/x "Refs #12" "MATCH #7 issue=#12 expect=refs via=body actual=[]" "" --expect refs
run_case "epic base missing keyword" $H epic/x "nothing" "MISMATCH #7 issue=#12 expect=closing via=body" ""
run_case "epic base fix" $H epic/x "nothing" "REPAIRED #7 issue=#12 expect=closing via=body" "nothing${nl}${nl}Closes #12${nl}" --fix
for base in main epic/x; do
  run_case "foreign issue with same number ($base)" $H "$base" "Closes other/repo#12" "MISMATCH #7" ""
  run_case "qualified local issue ($base)" $H "$base" "Closes LOCAL/REPO#12" "MATCH #7" ""
  run_case "qualified local and short issue deduplicate ($base)" $H "$base" "Closes #12; Fixes local/repo#12" "MATCH #7" ""
  run_case "foreign stray issue ($base)" $H "$base" "Closes #12; Fixes other/repo#99" "MISMATCH #7" ""
  run_case "repair foreign same-number issue ($base)" $H "$base" "Closes other/repo#12" "REPAIRED #7" "Refs other/repo#12${nl}${nl}Closes #12${nl}" --fix
  run_case "repair foreign stray issue ($base)" $H "$base" "Closes #12; Fixes other/repo#99" "REPAIRED #7" "Closes #12; Refs other/repo#99" --fix
  run_case "refs neutralizes every repository ($base)" $H "$base" "Closes local/repo#12; Resolves other/repo#99" "REPAIRED #7" "Refs local/repo#12; Refs other/repo#99" --expect refs --fix
  run_case "local URL issue ($base)" $H "$base" "Closes https://github.com/local/repo/issues/12" "MATCH #7" ""
  run_case "foreign URL issue ($base)" $H "$base" "Closes https://github.com/other/repo/issues/12" "MISMATCH #7" ""
  run_case "repair foreign URL issue ($base)" $H "$base" "Closes https://github.com/other/repo/issues/12" "REPAIRED #7" "Refs https://github.com/other/repo/issues/12${nl}${nl}Closes #12${nl}" --fix
  run_case "refs neutralizes URL ($base)" $H "$base" "Closes https://github.com/local/repo/issues/12" "REPAIRED #7" "Refs https://github.com/local/repo/issues/12" --expect refs --fix
  pipeline="Closes #12${nl}## Pipeline${nl}Fixes other/repo#99${nl}"
  run_case "Pipeline stray keyword ($base)" $H "$base" "$pipeline" "MISMATCH #7" ""
  run_case "Pipeline stray keyword cannot be repaired ($base)" $H "$base" "$pipeline" "MISMATCH #7" "$pipeline" --fix
  pipeline="Closes #12${nl}## Pipeline${nl}Closes #99${nl}"
  run_case "Pipeline local stray keyword ($base)" $H "$base" "$pipeline" "MISMATCH #7" ""
  run_case "Pipeline local stray cannot be repaired ($base)" $H "$base" "$pipeline" "MISMATCH #7" "$pipeline" --fix
  pipeline="## Pipeline${nl}Closes #12${nl}"
  run_case "Pipeline closing keyword rejects refs ($base)" $H "$base" "$pipeline" "MISMATCH #7" "" --expect refs
  run_case "Pipeline prevents refs repair ($base)" $H "$base" "$pipeline" "MISMATCH #7" "$pipeline" --expect refs --fix
  run_case "Pipeline local closing keyword ($base)" $H "$base" "$pipeline" "MATCH #7" ""
done
run_case "epic refs guidance" $H epic/x "Refs #12" "MATCH #7" "" --expect refs
grep -q "Keep #12 open after merge" "$tmpdir/stderr" || fail "missing keep-open guidance"
if grep -q "by hand" "$tmpdir/stderr"; then fail "refs guidance asks for manual closure"; fi
run_case "epic closing guidance" $H epic/x "Closes #12" "MATCH #7" ""
grep -q "Close #12 by hand" "$tmpdir/stderr" || fail "missing manual-closing guidance"
run_case "branch without issue segment is skipped" epic/big main "x" "SKIP #7 epic/big" ""

echo "check-pr-linkage: $passed passed"
