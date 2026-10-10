#!/bin/sh
#
# Plain-shell tests for callum-flow-fix-linkage (cbundy/dev-system#233). Runs the
# command and the real check-pr-linkage.sh from source against a stateful stub `gh` (no network, no Docker): the stub keeps
# a PR's branch, base and body in files, answers `pr view` with JSON, applies
# `pr edit --body-file`, and derives closingIssuesReferences from the body the
# way GitHub does - but only when the PR targets the default branch.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
LINKAGE="$SCRIPT_DIR/../../src/callum-tools/check-pr-linkage.sh"
SCRIPT="$SCRIPT_DIR/../../../images/base/callum-flow-fix-linkage"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
mkdir -p "$tmpdir/bin"
node_bin=$(command -v node) || fail "node not found"
for t in cmp bash sh grep cat mktemp rm sleep cp basename touch jq sed printf; do
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

cat > "$tmpdir/bin/rollout" <<'ROLLOUT_STUB'
#!/bin/sh
printf '%s\n' "$ROLLOUT_LINE"
case "$ROLLOUT_LINE" in "ROLLOUT conflict"* | "ROLLOUT invalid"* | "") exit 1 ;; esac
ROLLOUT_STUB
chmod +x "$tmpdir/bin/rollout"

cat > "$tmpdir/bin/gh" <<'STUB'
#!/bin/sh
d=${STUB_DIR:?}
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
    if [ -n "${STUB_REWRITE_AFTER_EDIT:-}" ]; then
      printf '%s' "$STUB_REWRITE_AFTER_EDIT" > "$d/body"
    fi
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
  case "$*" in
    "--expect refs") default_rollout="ROLLOUT keep-open source=brief" ;;
    *) default_rollout="ROLLOUT merge source=brief" ;;
  esac
  STUB_DIR="$tmpdir/state"
  rm -rf "$STUB_DIR"
  mkdir -p "$STUB_DIR"
  printf '%s\n' "$head" > "$STUB_DIR/head"
  printf '%s\n' "$base" > "$STUB_DIR/base"
  printf '%s' "$body" > "$STUB_DIR/body"
  out=$(PATH="$tmpdir/bin" STUB_DIR="$STUB_DIR" CHECK_PR_LINKAGE_GH_BIN="$tmpdir/bin/gh" \
    CALLUM_FLOW_GH_BIN="$tmpdir/bin/gh" CALLUM_FLOW_LINKAGE_BIN="$LINKAGE" \
    CALLUM_FLOW_ROLLOUT_BIN="$tmpdir/bin/rollout" ROLLOUT_LINE="${rollout_line-$default_rollout}" \
    STUB_NODE_BIN="$node_bin" STUB_FAIL_NODE="${fail_node:-}" \
    STUB_API_BODY="${stale_api_body:-}" STUB_REWRITE_AFTER_EDIT="${rewrite_after_edit:-}" \
    CALLUM_FLOW_FIX_RETRY_SLEEP=0 sh "$SCRIPT" 7 "$@" 2>"$tmpdir/stderr") && rc=0 || rc=$?
  case "$out" in
    "$want"*) ;;
    *) fail "$name: expected '$want...', got '$out'" ;;
  esac
  case "$want" in
    "") [ "$rc" -ne 0 ] || fail "$name: expected failure"
      [ ! -f "$STUB_DIR/edited" ] || fail "$name: edited PR despite failure" ;;
    MATCH* | SKIP*) [ "$rc" -eq 0 ] || fail "$name: expected exit 0, got $rc"
      [ ! -f "$STUB_DIR/edited" ] || fail "$name: edited a PR that already matches" ;;
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
run_case "fix appends the keyword" $H main "Summary" "REPAIRED #7" "Summary${nl}${nl}Closes #12${nl}"
run_case "fix neutralizes a stray closing keyword" $H main "Do not Closes #99.${nl}Closes #12" "REPAIRED #7" "Do not Refs #99.${nl}Closes #12"
run_case "fix turns a closing keyword into Refs" $H main "Fixes #12" "REPAIRED #7" "Refs #12" --expect refs
run_case "fix keeps the Pipeline section verbatim" $H main "Hi${nl}${nl}## Pipeline${nl}a log  line${nl}" "REPAIRED #7" "Hi${nl}${nl}Closes #12${nl}${nl}## Pipeline${nl}a log  line${nl}"
run_case "epic base closing keyword in body" $H epic/x "Closes #12" "MATCH #7 issue=#12 expect=closing via=body actual=[12]" ""
run_case "epic base refs matches" $H epic/x "Refs #12" "MATCH #7 issue=#12 expect=refs via=body actual=[]" "" --expect refs
run_case "epic base fix" $H epic/x "nothing" "REPAIRED #7 issue=#12 expect=closing via=body" "nothing${nl}${nl}Closes #12${nl}"
for base in main epic/x; do
  run_case "qualified local issue ($base)" $H "$base" "Closes LOCAL/REPO#12" "MATCH #7" ""
  run_case "qualified local and short issue deduplicate ($base)" $H "$base" "Closes #12; Fixes local/repo#12" "MATCH #7" ""
  run_case "repair foreign same-number issue ($base)" $H "$base" "Closes other/repo#12" "REPAIRED #7" "Refs other/repo#12${nl}${nl}Closes #12${nl}"
  run_case "repair foreign stray issue ($base)" $H "$base" "Closes #12; Fixes other/repo#99" "REPAIRED #7" "Closes #12; Refs other/repo#99"
  run_case "refs neutralizes every repository ($base)" $H "$base" "Closes local/repo#12; Resolves other/repo#99" "REPAIRED #7" "Refs local/repo#12; Refs other/repo#99" --expect refs
  pipeline="Closes #12${nl}## Pipeline${nl}Fixes other/repo#99${nl}"
  run_case "Pipeline stray keyword cannot be repaired ($base)" $H "$base" "$pipeline" "MISMATCH #7" "$pipeline"
  pipeline="Closes #12${nl}## Pipeline${nl}Closes #99${nl}"
  run_case "Pipeline local stray cannot be repaired ($base)" $H "$base" "$pipeline" "MISMATCH #7" "$pipeline"
  pipeline="## Pipeline${nl}Closes #12${nl}"
  run_case "Pipeline prevents refs repair ($base)" $H "$base" "$pipeline" "MISMATCH #7" "Refs #12${nl}${nl}$pipeline" --expect refs
  run_case "Pipeline local closing keyword ($base)" $H "$base" "$pipeline" "MATCH #7" ""
  for ref in "Refs #12" "Part of #12" "Refs LOCAL/REPO#12" "Part of local/repo#12"; do
    run_case "keep-open reference matches ($base)" $H "$base" "$ref" "MATCH #7" "$ref" --expect refs
    run_case "keep-open fix is unchanged ($base)" $H "$base" "$ref" "MATCH #7" "$ref" --expect refs
  done
  for body in "Summary" "Refs #99" "Refs other/repo#12" "Part of other/repo#12" "Refs https://github.com/local/repo/issues/12"; do
    run_case "append missing keep-open reference ($base)" $H "$base" "$body" "REPAIRED #7" "$body${nl}${nl}Refs #12${nl}" --expect refs
  done
  body="Summary${nl}## Pipeline${nl}Part of #12${nl}"
  run_case "keep-open reference in Pipeline ($base)" $H "$base" "$body" "MATCH #7" "$body" --expect refs
  body="Summary${nl}${nl}<!-- no-mistakes-pr-appendix:v1 sha256=abc -->${nl}Fixes #99${nl}<!-- /no-mistakes-pr-appendix:v1 -->${nl}"
  run_case "appendix stray keyword keeps the appendix and surfaces the reason ($base)" $H "$base" "$body" "MISMATCH #7" "Summary${nl}${nl}Closes #12${nl}${nl}<!-- no-mistakes-pr-appendix:v1 sha256=abc -->${nl}Fixes #99${nl}<!-- /no-mistakes-pr-appendix:v1 -->${nl}"
  grep -q "inside the no-mistakes appendix" "$tmpdir/stderr" || fail "appendix stray reason did not reach stderr"
  body="Summary${nl}## Pipeline${nl}log  line${nl}"
  run_case "append refs before preserved Pipeline ($base)" $H "$base" "$body" "REPAIRED #7" "Summary${nl}${nl}Refs #12${nl}${nl}## Pipeline${nl}log  line${nl}" --expect refs
  body="Closes #99"
  run_case "refs repair adds local reference after neutralizing stray ($base)" $H "$base" "$body" "REPAIRED #7" "Refs #99${nl}${nl}Refs #12${nl}" --expect refs
  body="Closes #12; Closes https://tracker.example/local/repo/issues/99"
  run_case "tracker URL is ignored ($base)" $H "$base" "$body" "MATCH #7" "$body"
  body='Closes https://<host>/owner/repo/issues/99'
  run_case "placeholder URL is preserved ($base)" $H "$base" "$body" "REPAIRED #7" "$body${nl}${nl}Closes #12${nl}"
done
stale_api_body="Closes #12"
run_case "repair body despite stale matching API" $H main "Closes #99" "REPAIRED #7" "Refs #99${nl}${nl}Closes #12${nl}"
run_case "stale API prevents refs repair success" $H main "Closes #12" "MISMATCH #7" "Refs #12" --expect refs
stale_api_body="Refs #12"
run_case "repair refs despite stale matching API" $H main "Closes #12" "REPAIRED #7" "Refs #12" --expect refs
run_case "stale API prevents closing repair success" $H main "Summary" "MISMATCH #7" "Summary${nl}${nl}Closes #12${nl}"
stale_api_body="Closes #12"
rewrite_after_edit="Closes #99"
run_case "post-edit rewrite cannot pass stale API" $H main "Summary" "MISMATCH #7" "Closes #99"
stale_api_body="Refs #12"
rewrite_after_edit="Closes #12"
run_case "post-edit refs rewrite cannot pass stale API" $H main "Closes #99" "MISMATCH #7" "Closes #12" --expect refs
unset stale_api_body rewrite_after_edit
rollout_line="ROLLOUT run-it source=body"
run_case "run-it issue without --expect writes Refs" $H main "Closes #12" "REPAIRED #7" "Refs #12"
run_case "run-it issue without --expect keeps a Refs body" $H main "Refs #12" "MATCH #7 issue=#12 expect=refs" ""
run_case "run-it issue refuses --expect closing" $H main "Refs #12" "" "Refs #12" --expect closing
rollout_line="ROLLOUT keep-open source=brief"
run_case "keep-open issue without --expect writes Refs" $H main "Fixes #12" "REPAIRED #7" "Refs #12"
rollout_line="ROLLOUT merge source=brief"
run_case "merge issue refuses --expect refs" $H main "Closes #12" "" "Closes #12" --expect refs
rollout_line="ROLLOUT conflict brief says merge but body has Run it"
run_case "rollout conflict refuses without editing" $H main "Closes #12" "" "Closes #12"
run_case "rollout conflict refuses an explicit --expect" $H main "Summary" "" "Summary" --expect closing
rollout_line=""
run_case "failed rollout lookup refuses without editing" $H main "Summary" "" "Summary"
unset rollout_line
run_case "branch without issue segment is skipped" epic/big main "x" "SKIP #7 epic/big" ""

fail_node=body
run_case "body extraction failure preserves PR body" $H main "Summary${nl}" "" "Summary${nl}"
for fail_node in fix empty; do
  for base in main epic/x; do
    for expectation in closing refs; do
      run_case "internal $fail_node failure preserves PR ($base, $expectation)" $H "$base" "Summary${nl}" "" "Summary${nl}" --expect "$expectation"
    done
  done
done
unset fail_node
# A usage error exits 2 and edits nothing; --fix and the retired flags are not accepted.
for bad in "--bogus" "--expect" "--expect=refs" "--expect bogus" "extra"; do
  rc=0
  # shellcheck disable=SC2086
  (PATH="$tmpdir/bin" STUB_DIR="$tmpdir/state" CALLUM_FLOW_GH_BIN="$tmpdir/bin/gh" sh "$SCRIPT" 7 $bad >/dev/null 2>&1) || rc=$?
  [ "$rc" -eq 2 ] || fail "bad option '$bad' should exit 2, got $rc"
  passed=$((passed + 1))
done
rc=0
(PATH="$tmpdir/bin" sh "$SCRIPT" >/dev/null 2>&1) || rc=$?
[ "$rc" -eq 2 ] || fail "missing pr should exit 2, got $rc"
rc=0
(PATH="$tmpdir/bin" sh "$SCRIPT" abc >/dev/null 2>&1) || rc=$?
[ "$rc" -eq 2 ] || fail "non-numeric pr should exit 2, got $rc"

# Delayed indexing: the API keeps reporting the old linkage for the first reads
# after the edit. The repair passes when the lag is within the retry limit and
# fails (after-fix) beyond it.
mkdir -p "$tmpdir/lag"
cat > "$tmpdir/lag/gh" <<'LAGSTUB'
#!/bin/sh
# Wraps the stateful stub: after an edit, `pr view` reports the pre-edit body
# for the next $LAG_READS reads.
d=${STUB_DIR:?}
if [ "$1 $2" = "pr edit" ]; then
  cp "$d/body" "$d/old-body"
  echo "${LAG_READS:?}" > "$d/lag-left"
elif [ "$1 $2" = "pr view" ] && [ -f "$d/lag-left" ] && [ "$(cat "$d/lag-left")" -gt 0 ]; then
  echo $(($(cat "$d/lag-left") - 1)) > "$d/lag-left"
  cp "$d/body" "$d/new-body"
  cp "$d/old-body" "$d/body"
  "$REAL_GH" "$@"
  rc=$?
  cp "$d/new-body" "$d/body"
  exit $rc
fi
exec "$REAL_GH" "$@"
LAGSTUB
chmod +x "$tmpdir/lag/gh"
lag_case() {
  name=$1 lag=$2 attempts=$3 want=$4 wantrc=$5
  STUB_DIR="$tmpdir/state"
  rm -rf "$STUB_DIR"
  mkdir -p "$STUB_DIR"
  printf '%s\n' "$H" > "$STUB_DIR/head"
  printf 'main\n' > "$STUB_DIR/base"
  printf 'Summary' > "$STUB_DIR/body"
  rc=0
  out=$(PATH="$tmpdir/bin" STUB_DIR="$STUB_DIR" REAL_GH="$tmpdir/bin/gh" LAG_READS="$lag" \
    CHECK_PR_LINKAGE_GH_BIN="$tmpdir/lag/gh" CALLUM_FLOW_GH_BIN="$tmpdir/lag/gh" \
    CALLUM_FLOW_LINKAGE_BIN="$LINKAGE" STUB_NODE_BIN="$node_bin" \
    CALLUM_FLOW_ROLLOUT_BIN="$tmpdir/bin/rollout" ROLLOUT_LINE="ROLLOUT merge source=brief" \
    CALLUM_FLOW_FIX_RETRY_ATTEMPTS="$attempts" CALLUM_FLOW_FIX_RETRY_SLEEP=0 sh "$SCRIPT" 7 2>/dev/null) || rc=$?
  case "$out" in "$want"*) ;; *) fail "$name: expected '$want...', got '$out'" ;; esac
  [ "$rc" -eq "$wantrc" ] || fail "$name: expected exit $wantrc, got $rc"
  passed=$((passed + 1))
}
lag_case "delayed index within the retry limit" 3 5 "REPAIRED #7" 0
lag_case "delayed index beyond the retry limit" 9 3 "MISMATCH #7" 1
run_case "reject refs argument alias" $H main "Refs #12" "" "Refs #12" --expect=refs
run_case "reject closing argument alias" $H main "Closes #12" "" "Closes #12" --expect=closing
echo "fix-linkage: $passed passed"
