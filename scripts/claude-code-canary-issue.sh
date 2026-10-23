#!/bin/sh
# Raise at most one bug issue per Claude Code version when the mods fail on it
# (.github/workflows/claude-code-canary.yml, cbundy/dev-system#1227).
# Usage: claude-code-canary-issue.sh <newest> <pin> <run-url> <test-output-file>
# Prints "found #N" (an issue for this version exists, in any state) or "raised #N".
set -eu

[ "$#" -eq 4 ] || { echo "usage: $0 <newest> <pin> <run-url> <test-output-file>" >&2; exit 2; }
newest=$1
pin=$2
run_url=$3
out=$4
max_lines=60
marker="<!-- claude-code-canary:$newest -->"

# Search is fuzzy: list every issue and match the marker exactly.
issues=$(gh issue list --state all --search "Claude Code canary in:title" --json number,body,state --limit 200) || {
  echo "claude-code-canary-issue: gh issue list failed" >&2
  exit 1
}
found=$(printf '%s' "$issues" | jq -r --arg m "$marker" '[.[] | select((.body // "") | contains($m))] | first | .number // empty') || exit 1
if [ -n "$found" ]; then
  echo "found #$found"
  exit 0
fi

# The FAIL lines and the lines indented under them, clipped to a fixed bound.
fails=$(awk '/^FAIL /{p=1; print; next} /^    /{if(p) print; next} {p=0}' "$out")
total=$(printf '%s\n' "$fails" | wc -l | tr -d ' ')
excerpt=$(printf '%s\n' "$fails" | head -n "$max_lines")
if [ "$total" -gt "$max_lines" ]; then
  excerpt="$excerpt
... clipped: showing $max_lines of $total lines, see the run for the rest."
fi

body="$marker

The mods fail on Claude Code $newest (CI is pinned to $pin).

- Newest version: $newest
- Pinned version: $pin
- Run: $run_url

\`\`\`
$excerpt
\`\`\`

To act:

1. Make the mods pass on Claude Code $newest.
2. Once the canary workflow is green on $newest, bump \`.github/claude-code-version\` in its own PR, to the newest version minus 2."

created=$(gh issue create --label bug --title "Claude Code canary: mods fail on $newest" --body "$body") || exit 1
number=${created##*/}
echo "raised #$number"
