#!/bin/bash
#
# check-pr-linkage.sh <pr-number> [--expect closing|refs] [--print-fix]
#
# Mechanical pre-merge gate: does this PR's issue linkage match what was
# intended? Green CI and "mergeable" say nothing about it, and a wrong keyword
# either leaves the issue open forever (dropped, or paraphrased like "closes
# issue #N", which GitHub does not parse) or closes the wrong one (a stray
# "Closes #M" inside description text still counts - GitHub ignores negation).
#
# The issue number is derived from the PR's head branch, which follows
# `<type>/issue-<N>-<slug>`. A branch with no `issue-<N>-` segment is skipped.
#
#   --expect closing (default)  exactly #N is closed by the PR
#   --expect refs               references #N and closes nothing (keep-open issue)
#   --print-fix                 print the repaired body to stdout (read-only)
#
# Base branch: GitHub only registers closing references for PRs targeting the
# repo's default branch. For any other base (epic branch) the check reads the
# closing keywords out of the body instead, and the issue will NOT close on
# merge: for closing mode, close it by hand with a comment naming the merged PR.
# Keep-open issues (--expect refs) must remain open.
#
# This script never writes to GitHub, so a worktree sub-agent may run it
# unprompted. The repair is a separate command, `callum-flow-fix-linkage`, that
# only the main checkout may run (cbundy/dev-system#233). `--fix` is refused.
#
# --print-fix writes the repaired body to stdout and nothing else: it appends
# `Closes #N` (or `Refs #N`), or turns unwanted closing keywords into `Refs #M`.
# The no-mistakes PR appendix (from the line opening `<!-- no-mistakes-pr-appendix:v1`
# through the line closing `<!-- /no-mistakes-pr-appendix:v1 -->`, or to the end of the
# body when never closed) is preserved byte for byte, and the keyword goes in the author
# text before it. Author text after the closing marker stays editable. Only when there is
# no appendix does the older anchor apply: everything from a `## Pipeline` heading on is
# preserved. A closing keyword stuck inside the appendix cannot be repaired; a reason is
# written to stderr. An already-matching PR prints its body unchanged. Status goes to stderr.
#
# Output: exactly one line on stdout, MATCH / MISMATCH / SKIP, each starting
# with the PR number; detail goes to stderr. Exit 0 except MISMATCH.
#
# Trust (cbundy/dev-system#310): a PR opened by an untrusted author is refused before
# its body is read or printed - one line on stderr, nothing on stdout, exit 1. The
# author comes from callum-flow-issue-read, which also fails closed when it cannot
# tell.
#
# Env (for tests): CHECK_PR_LINKAGE_GH_BIN (gh), CALLUM_FLOW_ISSUE_READ_BIN
# (callum-flow-issue-read).

set -euo pipefail

GH_BIN="${CHECK_PR_LINKAGE_GH_BIN:-gh}"
READ_BIN="${CALLUM_FLOW_ISSUE_READ_BIN:-callum-flow-issue-read}"

usage() {
  echo "Usage: $(basename "$0") <pr-number> [--expect closing|refs] [--print-fix]" >&2
}

die() {
  echo "Error: $*" >&2
  usage
  exit 1
}

EXPECT=closing
PRINT_FIX=0
PR=

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      [[ $# -ge 2 ]] || die "--expect requires a value"
      EXPECT="$2"
      shift 2
      ;;
    --fix)
      echo "Error: --fix was removed: this script is read-only. Repair the PR body with 'callum-flow-fix-linkage <pr> [--expect closing|refs]' from the main checkout." >&2
      exit 1
      ;;
    --print-fix)
      PRINT_FIX=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) die "unknown flag '$1'" ;;
    *)
      [[ -z "$PR" ]] || die "unexpected argument '$1'"
      PR="$1"
      shift
      ;;
  esac
done

[[ -n "$PR" ]] || die "missing <pr-number>"
[[ "$PR" =~ ^[0-9]+$ ]] || die "<pr-number> must be numeric, got '${PR}'"
[[ "$EXPECT" == closing || "$EXPECT" == refs ]] || die "--expect must be 'closing' or 'refs', got '${EXPECT}'"

# Node does the JSON and body editing (it ships in the image), one start-up per
# document. Every mode but fix prints its values one per line and then the body
# raw, so the body stays byte-exact (callers append a sentinel before capturing):
#   head                    stdin: PR JSON; headRefName, baseRefName, then body
#   doc <N|""> <repo JSON>  stdin: PR JSON; the repo's nameWithOwner and default
#                           branch name, the API closing targets as a JSON array,
#                           the body closing targets as a JSON array (scan: the
#                           issue targets a real GitHub closing keyword targets in
#                           the entire body), whether the body has a Refs/Part of
#                           reference to #N ("" when N is empty), then body
#   fix <closing|refs> <N>  stdin: body; prints new body
NODE_PROG='
const fs = require("fs");
let [repo, mode, a, b] = process.argv.slice(1);
const input = fs.readFileSync(0, "utf8");
const KW = "(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)";
const REF = "((?:[\\w.-]+/[\\w.-]+)?#(\\d+))\\b";
const re = new RegExp("\\b" + KW + "\\s*:?\\s*" + REF, "gi");
const refsRe = new RegExp("\\b(?:Refs|Part of)\\s+" + REF, "gi");
const target = (ref, number) => {
  const owner = ref.slice(0, ref.lastIndexOf("#")).toLowerCase();
  return !owner || owner === repo.toLowerCase() ? Number(number) : owner + "#" + Number(number);
};
// Returns [editable-before, protected, editable-after, kind]. The appendix wins over the
// older Pipeline heading anchor; an unclosed opening marker protects to the end of the body.
const split = (s) => {
  const open = /^<!-- no-mistakes-pr-appendix:v1\b.*$/m.exec(s);
  if (open) {
    const rest = s.slice(open.index);
    const close = /^<!-- \/no-mistakes-pr-appendix:v1 -->.*\n?/m.exec(rest);
    const end = close ? open.index + close.index + close[0].length : s.length;
    return [s.slice(0, open.index), s.slice(open.index, end), s.slice(end), "appendix"];
  }
  const m = /^## Pipeline[ \t]*$/m.exec(s);
  return m ? [s.slice(0, m.index), s.slice(m.index), "", "pipeline"] : [s, "", "", "none"];
};
const closing = (pr) => JSON.stringify([...new Set((pr.closingIssuesReferences || []).map((r) => target(r.repository.owner.login + "/" + r.repository.name + "#" + r.number, r.number)))]);
const scan = (body) => JSON.stringify([...new Set([...body.matchAll(re)].map((m) => target(m[1], m[2])))]);
const hasRef = (body, n) => String([...body.matchAll(refsRe)].some((m) => target(m[1], m[2]) === Number(n)));
if (mode === "head") {
  const pr = JSON.parse(input);
  process.stdout.write(String(pr.headRefName ?? "") + "\n" + String(pr.baseRefName ?? "") + "\n" + String(pr.body ?? ""));
} else if (mode === "doc") {
  const pr = JSON.parse(input);
  const rv = JSON.parse(b);
  repo = String(rv.nameWithOwner ?? "");
  const body = String(pr.body ?? "");
  process.stdout.write([repo, rv.defaultBranchRef.name, closing(pr), scan(body), a ? hasRef(body, a) : ""].join("\n") + "\n" + body);
} else if (mode === "fix") {
  const n = Number(b);
  let [head, tail, after, kind] = split(input);
  const rewrite = (t) => t.replace(re, (m, ref, d) => (a === "refs" || target(ref, d) !== n ? "Refs " + ref : m));
  head = rewrite(head);
  after = rewrite(after);
  if (kind === "appendix" && [...tail.matchAll(re)].some((m) => a === "refs" || target(m[1], m[2]) !== n)) {
    process.stderr.write("A closing keyword for another issue sits inside the no-mistakes appendix and was left untouched. Remove the appendix block from the PR body, then start a fresh pipeline run.\n");
  }
  const expectedRe = a === "refs" ? refsRe : re;
  const presenceBody = a === "refs" && kind !== "appendix" ? head + tail : head + after;
  if (![...presenceBody.matchAll(expectedRe)].some((m) => target(m[1], m[2]) === n)) {
    const t = head.replace(/\s+$/, "");
    head = t + (t ? "\n\n" : "") + (a === "refs" ? "Refs #" : "Closes #") + n + "\n" + (tail ? "\n" : "");
  }
  process.stdout.write(head + tail + after);
}
'
# Set by split_out (printf -v); declared so the reads below are visibly assigned.
REPO='' DEFAULT_BRANCH='' API_TARGETS='' BODY_TARGETS='' HAS_REF='' BODY=''

nodeb() { node -e "$NODE_PROG" "${REPO:-}" "$@"; }

# split_out <name>...: DOC_OUT holds one value per line and then the raw body.
# Sets each <name> in turn and leaves the body in BODY. No subprocess, no loop
# over the body, so trailing newlines survive.
split_out() {
  local name
  for name in "$@"; do
    printf -v "$name" '%s' "${DOC_OUT%%$'\n'*}"
    DOC_OUT="${DOC_OUT#*$'\n'}"
  done
  BODY="$DOC_OUT"
}

# parse <mode> [arg]: run one node over PR_JSON. The trailing X survives command
# substitution, which would strip trailing newlines from the body.
parse() {
  DOC_OUT="$(printf '%s' "$PR_JSON" | nodeb "$@" && printf X)" || return 1
  DOC_OUT="${DOC_OUT%X}"
}

print_body() {
  printf '%s' "$BODY"
}

# Trusted author first: nothing from the PR is read before this passes.
if "$READ_BIN" --json --pr "$PR" >/dev/null 2>&1; then
  :
else
  READ_RC=$?
  if [[ "$READ_RC" -eq 3 ]]; then
    echo "Refused: PR #${PR} was not opened by a trusted author." >&2
  else
    echo "Refused: cannot verify the author of PR #${PR} (reader exit ${READ_RC})." >&2
  fi
  exit 1
fi

echo "Reading PR #${PR} via ${GH_BIN}..." >&2
PR_JSON="$("$GH_BIN" pr view "$PR" --json headRefName,baseRefName,body,closingIssuesReferences)"
parse head
split_out HEAD_REF BASE_REF
[[ -n "$HEAD_REF" ]] || { echo "Error: could not read the branch of PR #${PR}" >&2; exit 1; }

if [[ "$HEAD_REF" =~ issue-([0-9]+)- ]]; then
  ISSUE="${BASH_REMATCH[1]}"
else
  echo "PR #${PR} branch '${HEAD_REF}' has no issue-<N>- segment - nothing to check." >&2
  if [[ "$PRINT_FIX" -eq 1 ]]; then
    print_body || exit 1
  else
    echo "SKIP #${PR} ${HEAD_REF}"
  fi
  exit 0
fi

REPO_JSON="$("$GH_BIN" repo view --json defaultBranchRef,nameWithOwner)"
# current_targets: the issues this PR closes (API) or will claim to close (body).
# One node reads the fresh PR document and REPO_JSON together; it also yields the
# repo name and default branch, which decide whether the API or the body is used.
current_targets() {
  PR_JSON="$("$GH_BIN" pr view "$PR" --json body,closingIssuesReferences)"
  local refs_for=
  [[ "$EXPECT" != refs ]] || refs_for="$ISSUE"
  parse doc "$refs_for" "$REPO_JSON"
  split_out REPO DEFAULT_BRANCH API_TARGETS BODY_TARGETS HAS_REF
  if [[ "$BASE_REF" == "$DEFAULT_BRANCH" ]]; then
    VIA=api
  else
    VIA=body
    echo "PR #${PR} targets '${BASE_REF}', not '${DEFAULT_BRANCH}': GitHub registers no closing references there, so the body is checked instead. The issue will NOT close on merge." >&2
    if [[ "$EXPECT" == closing ]]; then
      echo "Close #${ISSUE} by hand with a comment naming the merged PR." >&2
    else
      echo "Keep #${ISSUE} open after merge." >&2
    fi
  fi
  if [[ "$VIA" == api ]]; then
    CURRENT="$API_TARGETS"
  else
    CURRENT="$BODY_TARGETS"
  fi
}

verify() {
  if [[ "$EXPECT" == closing ]]; then
    [[ "$CURRENT" == "[${ISSUE}]" && "$BODY_TARGETS" == "[${ISSUE}]" ]]
  else
    [[ "$CURRENT" == "[]" && "$BODY_TARGETS" == "[]" && "$HAS_REF" == true ]]
  fi
}

current_targets
REPORT="issue=#${ISSUE} expect=${EXPECT} via=${VIA} actual=${CURRENT} body=${BODY_TARGETS}"

if verify; then
  if [[ "$PRINT_FIX" -eq 1 ]]; then
    echo "MATCH #${PR} ${REPORT}" >&2
    print_body || exit 1
  else
    echo "MATCH #${PR} ${REPORT}"
  fi
  exit 0
fi

if [[ "$PRINT_FIX" -eq 1 ]]; then
  echo "MISMATCH #${PR} ${REPORT}" >&2
  fixed="$(printf '%s' "$BODY" | nodeb fix "$EXPECT" "$ISSUE" && printf X)"
  printf '%s' "${fixed%X}"
  exit 0
fi

if [[ "$EXPECT" == closing ]]; then
  echo "PR #${PR} (${HEAD_REF}) must close exactly #${ISSUE}; it closes ${CURRENT}. Add 'Closes #${ISSUE}' and neutralize other closing keywords, or run 'callum-flow-fix-linkage ${PR}' from the main checkout." >&2
else
  echo "PR #${PR} (${HEAD_REF}) must reference #${ISSUE} with 'Refs #${ISSUE}' or 'Part of #${ISSUE}' and close nothing; it closes ${CURRENT}. Run 'callum-flow-fix-linkage ${PR} --expect refs' from the main checkout." >&2
fi
echo "MISMATCH #${PR} ${REPORT}"
exit 1
