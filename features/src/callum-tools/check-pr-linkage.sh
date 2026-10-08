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
# Everything from a `## Pipeline` heading on is preserved byte for byte. An
# already-matching PR prints its body unchanged. Status goes to stderr.
#
# Output: exactly one line on stdout, MATCH / MISMATCH / SKIP, each starting
# with the PR number; detail goes to stderr. Exit 0 except MISMATCH.
#
# Env (for tests): CHECK_PR_LINKAGE_GH_BIN (gh).

set -euo pipefail

GH_BIN="${CHECK_PR_LINKAGE_GH_BIN:-gh}"

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

# Node does the JSON and body editing (it ships in the image). Modes:
#   field <name>            stdin: PR JSON; prints headRefName, baseRefName, body
#                           or the API closing targets as a JSON array
#   scan                    stdin: body; JSON array of issue targets a real
#                           GitHub closing keyword targets in the entire body
#   fix <closing|refs> <N>  stdin: body; prints new body
NODE_PROG='
const fs = require("fs");
const [repo, mode, a, b] = process.argv.slice(1);
const input = fs.readFileSync(0, "utf8");
const KW = "(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)";
const REF = "((?:[\\w.-]+/[\\w.-]+)?#(\\d+))\\b";
const re = new RegExp("\\b" + KW + "\\s*:?\\s*" + REF, "gi");
const refsRe = new RegExp("\\b(?:Refs|Part of)\\s+" + REF, "gi");
const target = (ref, number) => {
  const owner = ref.slice(0, ref.lastIndexOf("#")).toLowerCase();
  return !owner || owner === repo.toLowerCase() ? Number(number) : owner + "#" + Number(number);
};
const split = (s) => {
  const m = /^## Pipeline[ \t]*$/m.exec(s);
  return m ? [s.slice(0, m.index), s.slice(m.index)] : [s, ""];
};
if (mode === "field") {
  const pr = JSON.parse(input);
  if (a === "closing") process.stdout.write(JSON.stringify([...new Set((pr.closingIssuesReferences || []).map((r) => target(r.repository.owner.login + "/" + r.repository.name + "#" + r.number, r.number)))]));
  else if (a === "defaultBranch") process.stdout.write(pr.defaultBranchRef.name);
  else process.stdout.write(String(pr[a] ?? ""));
} else if (mode === "scan") {
  const targets = [...input.matchAll(re)].map((m) => target(m[1], m[2]));
  process.stdout.write(JSON.stringify([...new Set(targets)]));
} else if (mode === "refs") {
  process.stdout.write(String([...input.matchAll(refsRe)].some((m) => target(m[1], m[2]) === Number(a))));
} else if (mode === "fix") {
  const n = Number(b);
  let [head, tail] = split(input);
  head = head.replace(re, (m, ref, d) => (a === "refs" || target(ref, d) !== n ? "Refs " + ref : m));
  const expectedRe = a === "refs" ? refsRe : re;
  const presenceBody = a === "refs" ? head + tail : head;
  if (![...presenceBody.matchAll(expectedRe)].some((m) => target(m[1], m[2]) === n)) {
    const t = head.replace(/\s+$/, "");
    head = t + (t ? "\n\n" : "") + (a === "refs" ? "Refs #" : "Closes #") + n + "\n" + (tail ? "\n" : "");
  }
  process.stdout.write(head + tail);
}
'
nodeb() { node -e "$NODE_PROG" "${REPO:-}" "$@"; }

# The trailing X survives command substitution, which would strip trailing newlines.
print_body() {
  local body
  body="$(printf '%s' "$PR_JSON" | nodeb field body && printf X)" || return 1
  printf '%s' "${body%X}"
}

echo "Reading PR #${PR} via ${GH_BIN}..." >&2
PR_JSON="$("$GH_BIN" pr view "$PR" --json headRefName,baseRefName,body,closingIssuesReferences)"
HEAD_REF="$(printf '%s' "$PR_JSON" | nodeb field headRefName)"
BASE_REF="$(printf '%s' "$PR_JSON" | nodeb field baseRefName)"
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
REPO="$(printf '%s' "$REPO_JSON" | nodeb field nameWithOwner)"
DEFAULT_BRANCH="$(printf '%s' "$REPO_JSON" | nodeb field defaultBranch)"
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

# current_targets: the issues this PR closes (API) or will claim to close (body).
current_targets() {
  PR_JSON="$("$GH_BIN" pr view "$PR" --json body,closingIssuesReferences)"
  BODY_TARGETS="$(printf '%s' "$PR_JSON" | nodeb field body | nodeb scan)"
  if [[ "$EXPECT" == refs ]]; then
    HAS_REF="$(printf '%s' "$PR_JSON" | nodeb field body | nodeb refs "$ISSUE")"
  fi
  if [[ "$VIA" == api ]]; then
    CURRENT="$(printf '%s' "$PR_JSON" | nodeb field closing)"
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
  body="$(print_body && printf X)" || exit 1
  fixed="$(printf '%s' "${body%X}" | nodeb fix "$EXPECT" "$ISSUE" && printf X)"
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
