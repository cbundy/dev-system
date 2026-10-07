#!/bin/sh
#
# Plain-shell test for images/base/dev-prune-worktrees (cbundy/dev-system#93).
#
# Builds a scratch repo with a bare origin and one stub bridge worktree per class (live lock,
# recycled-pid lock, dead lock, unlocked, dirty, unpushed, squash-merged, young, old) plus a
# worktree that is not a bridge one, and a fake `gh`. Checks the dry run changes nothing and
# prints every class, then that --delete removes exactly the orphaned + clean + pushed +
# idle >= 72h ones. No Docker or network needed.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PRUNE="$SCRIPT_DIR/../dev-prune-worktrees"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -x "$PRUNE" ] || fail "$PRUNE is missing or not executable"

tmp=$(mktemp -d)
live_pid=""
trap '[ -z "$live_pid" ] || kill "$live_pid" 2>/dev/null; rm -rf "$tmp"' EXIT

export GIT_CONFIG_GLOBAL="$tmp/gitconfig" GIT_CONFIG_SYSTEM=/dev/null
git config --global user.email t@example.com
git config --global user.name t
git config --global init.defaultBranch main

# Fake gh: `gh api repos/{owner}/{repo}/commits/<sha>/pulls ...` prints the sha when it is
# listed in $GH_MERGED (a merged PR whose head is that commit); anything else prints nothing.
mkdir "$tmp/bin"
cat > "$tmp/bin/gh" <<'GH'
#!/bin/sh
sha=$(printf '%s' "$2" | sed -n 's|.*/commits/\([0-9a-f]*\)/pulls|\1|p')
[ -n "$sha" ] && grep -qx "$sha" "${GH_MERGED:-/dev/null}" && echo "$sha"
exit 0
GH
chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH" GH_MERGED="$tmp/merged"
: > "$GH_MERGED"

git init -q --bare "$tmp/origin.git"
git init -q "$tmp/ws"
ws="$tmp/ws"
git -C "$ws" remote add origin "$tmp/origin.git"
git -C "$ws" commit -q --allow-empty -m base
git -C "$ws" push -q origin main
git -C "$ws" fetch -q origin
mkdir -p "$ws/.claude/worktrees"

add_wt() { # name: a bridge worktree on branch worktree-<name>
  git -C "$ws" worktree add -q -b "worktree-$1" "$ws/.claude/worktrees/$1" main
}
age() { # name hours: make everything in the worktree look that many hours idle
  gd=$(git -C "$ws/.claude/worktrees/$1" rev-parse --absolute-git-dir)
  find "$ws/.claude/worktrees/$1" "$gd" -exec touch -h -d "$2 hours ago" {} +
}

sleep 600 &
live_pid=$!
sleep 1
dead_pid=$( (sh -c 'echo $$') )

for n in bridge-live bridge-recycled bridge-dead bridge-unlocked bridge-dirty \
  bridge-unpushed bridge-merged bridge-young bridge-old bridge-nolockpid; do
  add_wt "$n"
done
git -C "$ws" worktree add -q -b feature "$ws/other" main

git -C "$ws" worktree lock --reason "claude remote-control (pid $live_pid)" "$ws/.claude/worktrees/bridge-live"
git -C "$ws" worktree lock --reason "claude remote-control (pid $live_pid)" "$ws/.claude/worktrees/bridge-recycled"
git -C "$ws" worktree lock --reason "claude remote-control (pid $dead_pid)" "$ws/.claude/worktrees/bridge-dead"
git -C "$ws" worktree lock --reason "something else" "$ws/.claude/worktrees/bridge-nolockpid"

echo x > "$ws/.claude/worktrees/bridge-dirty/wip.txt"
git -C "$ws/.claude/worktrees/bridge-unpushed" commit -q --allow-empty -m local-only
git -C "$ws/.claude/worktrees/bridge-merged" commit -q --allow-empty -m squash-merged-branch
git -C "$ws/.claude/worktrees/bridge-merged" rev-parse HEAD > "$GH_MERGED"

for n in bridge-live bridge-recycled bridge-dead bridge-unlocked bridge-dirty \
  bridge-unpushed bridge-merged bridge-old bridge-nolockpid; do
  age "$n" 100
done
# bridge-recycled: the pid is alive, but the lock predates the process, so it was recycled.
touch -d '1 day ago' "$(git -C "$ws/.claude/worktrees/bridge-recycled" rev-parse --absolute-git-dir)/locked"
age bridge-young 5 # older than nothing, younger than 72h
# The live server's lock was taken after it started, whatever the worktree's age.
touch "$(git -C "$ws/.claude/worktrees/bridge-live" rev-parse --absolute-git-dir)/locked"

before=$(git -C "$ws" worktree list --porcelain)

# Dry run: changes nothing, and the table names every class.
out=$("$PRUNE" --workspace "$ws") || fail "dry run failed: $out"
[ "$(git -C "$ws" worktree list --porcelain)" = "$before" ] || fail "dry run changed the worktrees"
row() { printf '%s\n' "$out" | grep "^$1 " || fail "no table row for $1 in: $out"; }
row bridge-live | grep -q 'in use' || fail "live lock is not 'in use'"
row bridge-live | grep -q 'keep' || fail "live lock is not kept"
row bridge-nolockpid | grep -q 'in use' || fail "a lock with no pid is not 'in use'"
row bridge-recycled | grep -q 'recycled' || fail "recycled pid not detected"
row bridge-dead | grep -q 'not running' || fail "dead lock not detected"
row bridge-unlocked | grep -q 'orphaned' || fail "unlocked is not orphaned"
row bridge-dirty | grep -q 'unsafe' || fail "dirty is not unsafe"
row bridge-unpushed | grep -q 'unsafe' || fail "unpushed is not unsafe"
row bridge-merged | grep -q 'merged pull request' || fail "squash-merged is not safe"
row bridge-young | grep -q 'idle under' || fail "young is not kept for its age"
row bridge-old | grep -q 'remove' || fail "old is not marked for removal"
printf '%s\n' "$out" | grep -q 'would remove 5' || fail "dry run should list 5 removals: $out"
[ "$("$PRUNE" --workspace "$ws" --count)" = 5 ] || fail "--count is not 5"

# --delete: only orphaned + clean + pushed (or merged) + idle >= 72h.
"$PRUNE" --workspace "$ws" --delete > "$tmp/delete.out" 2>&1 || fail "--delete failed: $(cat "$tmp/delete.out")"
for n in bridge-recycled bridge-dead bridge-unlocked bridge-merged bridge-old; do
  [ ! -e "$ws/.claude/worktrees/$n" ] || fail "$n was not removed"
  git -C "$ws" rev-parse --verify -q "worktree-$n" >/dev/null && fail "branch worktree-$n was not deleted"
done
for n in bridge-live bridge-nolockpid bridge-dirty bridge-unpushed bridge-young; do
  [ -d "$ws/.claude/worktrees/$n" ] || fail "$n was removed but must be kept"
  git -C "$ws" rev-parse --verify -q "worktree-$n" >/dev/null || fail "branch worktree-$n was deleted"
done
[ -d "$ws/other" ] || fail "the non-bridge worktree was removed"
git -C "$ws" rev-parse --verify -q feature >/dev/null || fail "the non-bridge worktree branch was deleted"
[ "$("$PRUNE" --workspace "$ws" --count)" = 0 ] || fail "--count is not 0 after --delete"

# --older-than overrides the threshold, but never touches in use, dirty or unpushed.
"$PRUNE" --workspace "$ws" --delete --older-than 1h > "$tmp/delete2.out" 2>&1 || fail "--older-than failed: $(cat "$tmp/delete2.out")"
[ ! -e "$ws/.claude/worktrees/bridge-young" ] || fail "--older-than 1h did not remove the 5h-idle worktree"
for n in bridge-live bridge-nolockpid bridge-dirty bridge-unpushed; do
  [ -d "$ws/.claude/worktrees/$n" ] || fail "--older-than removed $n"
done
"$PRUNE" --workspace "$ws" --older-than nope > /dev/null 2>&1 && fail "an invalid --older-than was accepted"

# A repo with no bridge worktrees, and a directory that is no repo, are fine.
mkdir "$tmp/empty"
git init -q "$tmp/empty/r"
"$PRUNE" --workspace "$tmp/empty/r" > /dev/null || fail "empty repo failed"
"$PRUNE" --workspace "$tmp/empty" > /dev/null || fail "non-repo failed"

echo "dev-prune-worktrees: ok"
