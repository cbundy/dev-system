#!/bin/bash
#
# check-pr-linkage.sh <pr-number> [--expect closing|refs] [--fix]
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
#   --expect refs               the PR closes nothing (keep-open issue)
#   --fix                       repair the body, then re-verify
#
# Base branch: GitHub only registers closing references for PRs targeting the
# repo's default branch. For any other base (epic branch) the check reads the
# closing keywords out of the body instead, and the issue will NOT close on
# merge: close it by hand with a comment naming the merged PR.
#
# --fix appends `Closes #N`, or turns unwanted closing keywords into `Refs #M`.
# Everything from a `## Pipeline` heading on is preserved byte for byte.
#
# Output: exactly one line on stdout, MATCH / MISMATCH / REPAIRED / SKIP, each
# starting with the PR number; detail goes to stderr. Exit 0 except MISMATCH.
#
# Env (for tests): CHECK_PR_LINKAGE_GH_BIN (gh), CHECK_PR_LINKAGE_RETRY_ATTEMPTS
# (5), CHECK_PR_LINKAGE_RETRY_SLEEP (2 seconds).

set -euo pipefail

GH_BIN="${CHECK_PR_LINKAGE_GH_BIN:-gh}"
MAX_ATTEMPTS="${CHECK_PR_LINKAGE_RETRY_ATTEMPTS:-5}"
SLEEP_SECS="${CHECK_PR_LINKAGE_RETRY_SLEEP:-2}"

usage() {
  echo "Usage: $(basename "$0") <pr-number> [--expect closing|refs] [--fix]" >&2
}

die() {
  echo "Error: $*" >&2
  usage
  exit 1
}

EXPECT=closing
FIX=0
PR=

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      [[ $# -ge 2 ]] || die "--expect requires a value"
      EXPECT="$2"
      shift 2
      ;;
    --expect=*)
      EXPECT="${1#--expect=}"
      shift
      ;;
    --fix)
      FIX=1
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
#                           or the API closing numbers as a JSON array
#   scan                    stdin: body; JSON array of issue numbers a real
#                           GitHub closing keyword targets (before ## Pipeline)
#   fix <closing|refs> <N>  stdin: body, argv: current numbers; prints new body
NODE_PROG='
const fs = require("fs");
const [mode, a, b, c] = process.argv.slice(1);
const input = fs.readFileSync(0, "utf8");
const KW = "(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)";
const split = (s) => {
  const m = /^## Pipeline[ \t]*$/m.exec(s);
  return m ? [s.slice(0, m.index), s.slice(m.index)] : [s, ""];
};
if (mode === "field") {
  const pr = JSON.parse(input);
  if (a === "closing") process.stdout.write(JSON.stringify((pr.closingIssuesReferences || []).map((r) => r.number)));
  else process.stdout.write(String(pr[a] ?? ""));
} else if (mode === "scan") {
  const re = new RegExp("\\b" + KW + "\\s*:?\\s*#(\\d+)\\b", "gi");
  const nums = [...split(input)[0].matchAll(re)].map((m) => Number(m[1]));
  process.stdout.write(JSON.stringify([...new Set(nums)]));
} else if (mode === "fix") {
  const n = Number(b);
  const current = JSON.parse(c);
  const drop = new Set(a === "refs" ? current : current.filter((x) => x !== n));
  const re = new RegExp("\\b" + KW + "\\s*:?\\s*#(\\d+)\\b", "gi");
  let [head, tail] = split(input);
  head = head.replace(re, (m, d) => (drop.has(Number(d)) ? "Refs #" + d : m));
  if (a === "closing" && !new RegExp("\\b" + KW + "\\s*:?\\s*#" + n + "\\b", "i").test(head)) {
    const t = head.replace(/\s+$/, "");
    head = t + (t ? "\n\n" : "") + "Closes #" + n + "\n" + (tail ? "\n" : "");
  }
  process.stdout.write(head + tail);
}
'
nodeb() { node -e "$NODE_PROG" "$@"; }

echo "Reading PR #${PR} via ${GH_BIN}..." >&2
PR_JSON="$("$GH_BIN" pr view "$PR" --json headRefName,baseRefName,body,closingIssuesReferences)"
HEAD_REF="$(printf '%s' "$PR_JSON" | nodeb field headRefName)"
BASE_REF="$(printf '%s' "$PR_JSON" | nodeb field baseRefName)"
[[ -n "$HEAD_REF" ]] || { echo "Error: could not read the branch of PR #${PR}" >&2; exit 1; }

if [[ "$HEAD_REF" =~ issue-([0-9]+)- ]]; then
  ISSUE="${BASH_REMATCH[1]}"
else
  echo "PR #${PR} branch '${HEAD_REF}' has no issue-<N>- segment - nothing to check." >&2
  echo "SKIP #${PR} ${HEAD_REF}"
  exit 0
fi

DEFAULT_BRANCH="$("$GH_BIN" repo view --json defaultBranchRef -q .defaultBranchRef.name)"
if [[ "$BASE_REF" == "$DEFAULT_BRANCH" ]]; then
  VIA=api
else
  VIA=body
  echo "PR #${PR} targets '${BASE_REF}', not '${DEFAULT_BRANCH}': GitHub registers no closing references there, so the body is checked instead. The issue will NOT close on merge - close #${ISSUE} by hand with a comment naming the merged PR." >&2
fi

# current_numbers: the issue numbers this PR closes (API) or will claim to close (body).
current_numbers() {
  local json
  json="$("$GH_BIN" pr view "$PR" --json body,closingIssuesReferences)"
  if [[ "$VIA" == api ]]; then
    printf '%s' "$json" | nodeb field closing
  else
    printf '%s' "$json" | nodeb field body | nodeb scan
  fi
}

verify() {
  if [[ "$EXPECT" == closing ]]; then
    [[ "$CURRENT" == "[${ISSUE}]" ]]
  else
    [[ "$CURRENT" == "[]" ]]
  fi
}

CURRENT="$(current_numbers)"
REPORT="issue=#${ISSUE} expect=${EXPECT} via=${VIA} actual=${CURRENT}"

if verify; then
  echo "MATCH #${PR} ${REPORT}"
  exit 0
fi

if [[ "$FIX" -ne 1 ]]; then
  if [[ "$EXPECT" == closing ]]; then
    echo "PR #${PR} (${HEAD_REF}) must close exactly #${ISSUE}; it closes ${CURRENT}. Add 'Closes #${ISSUE}' and neutralize other closing keywords, or rerun with --fix." >&2
  else
    echo "PR #${PR} (${HEAD_REF}) must not close anything; it closes ${CURRENT}. Use 'Refs #N' instead, or rerun with --fix." >&2
  fi
  echo "MISMATCH #${PR} ${REPORT}"
  exit 1
fi

echo "Repairing PR #${PR} body..." >&2
# The trailing X survives command substitution, which would strip trailing newlines.
BODY="$(printf '%s' "$PR_JSON" | nodeb field body; printf X)"
NEW_BODY="$(printf '%s' "${BODY%X}" | nodeb fix "$EXPECT" "$ISSUE" "$CURRENT"; printf X)"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
printf '%s' "${NEW_BODY%X}" >"$TMP"
"$GH_BIN" pr edit "$PR" --body-file "$TMP" >&2

# GitHub takes a moment to index a body edit and can briefly report the old linkage.
attempt=0
while true; do
  CURRENT="$(current_numbers)"
  verify && break
  attempt=$((attempt + 1))
  [[ "$attempt" -lt "$MAX_ATTEMPTS" ]] || break
  sleep "$SLEEP_SECS"
done

REPORT="issue=#${ISSUE} expect=${EXPECT} via=${VIA} actual=${CURRENT}"
if verify; then
  echo "REPAIRED #${PR} ${REPORT}"
  exit 0
fi
echo "MISMATCH #${PR} ${REPORT} after-fix"
exit 1
