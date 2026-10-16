#!/usr/bin/env bash
# Reset cbundy/dev-system-scratch to its drill base between fault drills.
#
# Run it only while no loop acts on the repo (the testbed loop's mode off, or its kill switch
# on): a reset under a running loop is itself a fault. The loop's own state on the testbed
# workspace (store, slots, factory.events) is not touched here.
#
# What it does, in order:
#   1. closes every open PR (comment "drill reset");
#   2. strips `ready` and every factory:* label from every issue (open or closed) and closes the
#      open ones as not planned;
#   3. deletes every remote branch except main;
#   4. force-moves main to the tag drill-base (protection briefly allows force pushes, then is
#      put back exactly);
#   5. re-ensures the nine labels (ready, the seven states, factory:rejected) and checks the end state.
#
# Usage: scratch-reset.sh [--dry-run]
set -euo pipefail

R=cbundy/dev-system-scratch
HERE="$(cd "$(dirname "$0")" && pwd)"
PROTECTION="$HERE/scratch-protection.json"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

run() { if [ "$DRY" = 1 ]; then echo "would: $*" >&2; else "$@"; fi; }

FACTORY_LABELS=(factory:queued factory:designing factory:building factory:reviewing factory:fixing factory:merge-queue factory:parked factory:rejected)

ensure_labels() {
while IFS='|' read -r name color desc; do
  run gh label create "$name" --repo "$R" --color "$color" --description "$desc" --force >/dev/null
done <<'EOF'
ready|0E8A16|Ready for the factory to claim
factory:queued|c5def5|Factory loop: claimed, waiting for a slot
factory:designing|bfd4f2|Factory loop: the designer is at work
factory:building|0e8a16|Factory loop: the implementer is at work
factory:reviewing|fbca04|Factory loop: review and CI on the PR
factory:fixing|d93f0b|Factory loop: a fixer is at work
factory:merge-queue|5319e7|Factory loop: approved and green, waiting to merge
factory:parked|b60205|Factory loop: waits on the owner; remove this label to resume
factory:rejected|6a737d|Factory loop: its last life ended without a merge; remove this label and add ready to try again
EOF
}

echo "== 0. ensure the loop labels (gh issue edit --remove-label fails on a missing label)"
ensure_labels

echo "== 1. close open PRs"
for pr in $(gh pr list --repo "$R" --state open --limit 1000 --json number --jq '.[].number'); do
  run gh pr close "$pr" --repo "$R" --comment "drill reset" >/dev/null && echo "closed PR $pr"
done

echo "== 2. strip loop labels, close open issues"
strip=$(IFS=,; echo "ready,${FACTORY_LABELS[*]}")
for n in $(gh issue list --repo "$R" --state all --limit 1000 --json number,labels \
    --jq '.[] | select([.labels[].name | ascii_downcase] | any(. == "ready" or startswith("factory:"))) | .number'); do
  run gh issue edit "$n" --repo "$R" --remove-label "$strip" >/dev/null && echo "stripped labels from $n"
done
for n in $(gh issue list --repo "$R" --state open --limit 1000 --json number --jq '.[].number'); do
  run gh issue close "$n" --repo "$R" --reason "not planned" --comment "drill reset" >/dev/null && echo "closed issue $n"
done

echo "== 3. delete branches other than main"
for b in $(gh api --paginate "repos/$R/branches" --jq '.[].name' | grep -vx main || true); do
  run gh api -X DELETE "repos/$R/git/refs/heads/$b" >/dev/null && echo "deleted branch $b"
done

echo "== 4. main back to drill-base"
base=$(gh api "repos/$R/git/ref/tags/drill-base" --jq .object.sha)
main=$(gh api "repos/$R/git/ref/heads/main" --jq .object.sha)
if [ "$base" = "$main" ]; then
  echo "main already at drill-base $base"
else
  allow=$(mktemp)
  jq '.allow_force_pushes = true' "$PROTECTION" >"$allow"
  run gh api -X PUT "repos/$R/branches/main/protection" --input "$allow" >/dev/null
  # Put protection back whatever happens to the ref update.
  restore() { run gh api -X PUT "repos/$R/branches/main/protection" --input "$PROTECTION" >/dev/null; rm -f "$allow"; }
  trap restore EXIT
  run gh api -X PATCH "repos/$R/git/refs/heads/main" -f sha="$base" -F force=true >/dev/null
  restore
  trap - EXIT
  [ "$DRY" = 1 ] || echo "main moved from $main to $base"
fi

echo "== 5. labels and end state"
ensure_labels

[ "$DRY" = 1 ] && exit 0
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got '$2', want '$3'"; fail=1; fi; }
check "open PRs" "$(gh pr list --repo "$R" --state open --limit 1000 --json number --jq length)" 0
check "open issues" "$(gh issue list --repo "$R" --state open --limit 1000 --json number --jq length)" 0
check "branches" "$(gh api --paginate "repos/$R/branches" --jq '.[].name' | tr '\n' ' ')" "main "
check "main at drill-base" "$(gh api "repos/$R/git/ref/heads/main" --jq .object.sha)" "$base"
check "protection" "$(gh api "repos/$R/branches/main/protection" --jq '[.required_status_checks.strict, (.required_status_checks.checks | map(.context) | join(",")), .enforce_admins.enabled, (.required_pull_request_reviews == null), .allow_force_pushes.enabled] | map(tostring) | join(" ")')" "true ci false true false"
check "auto-merge" "$(gh api "repos/$R" --jq .allow_auto_merge)" false
check "issues with loop labels" "$(gh issue list --repo "$R" --state all --limit 1000 --json number,labels --jq '[.[] | select([.labels[].name | ascii_downcase] | any(. == "ready" or startswith("factory:")))] | length')" 0
check "loop labels" "$(gh label list --repo "$R" --limit 200 --json name --jq '[.[].name | select(. == "ready" or startswith("factory:"))] | length')" 9
exit "$fail"
