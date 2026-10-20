#!/bin/sh
#
# Plain-shell tests for callum-flow-regate (cbundy/dev-system#489). Real local bare repos
# serve as origin and as the no-mistakes gate remote; a stub no-mistakes (CALLUM_FLOW_NM_BIN)
# logs calls and replays the TOON the real CLI prints; a stub callum-flow-event records any call (the tool no longer logs).
# shellcheck disable=SC2015  # A && B || fail is the idiom here
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REGATE="$SCRIPT_DIR/../../../images/base/callum-flow-regate"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

# stub no-mistakes: state files in $NMS (status, code, command, abort_noop), calls in $NMS/calls
cat > "$tmpdir/nm" <<'STUB'
#!/bin/sh
echo "$*" >> "$NMS/calls"
case "$*" in
  'axi status')
    s=$(cat "$NMS/status" 2> /dev/null || echo none)
    [ "$s" != none ] || exit 1
    printf 'run:\n  id: "RUN1"\n  branch: b\n  status: %s\n  head: abc\n  head_sha: %s\n' "$s" "$(cat "$NMS/run_head" 2> /dev/null)"
    ;;
  'axi abort')
    [ ! -s "$NMS/on_abort" ] || sh "$NMS/on_abort"
    [ -e "$NMS/abort_noop" ] || echo aborted > "$NMS/status"
    ;;
  'axi sync --check')
    printf 'run:\n  id: "RUN1"\n  status: %s\nbranch_sync:\n  pipeline:\n    current_head: %s\n  next_action:\n    code: %s\n' "$(cat "$NMS/status" 2> /dev/null)" "$(cat "$NMS/run_head" 2> /dev/null)" "$(cat "$NMS/code")"
    [ ! -s "$NMS/command" ] || printf '    command: %s\n' "$(cat "$NMS/command")"
    ;;
  'axi sync --recover'*)
    git -C "$WORK" for-each-ref refs/heads/archive/ | sed 's/.*/archive_present/' | sed -n 1p >> "$NMS/calls"
    [ ! -s "$NMS/recover_reset" ] || git -C "$WORK" reset -q --hard "$(cat "$NMS/recover_reset")"
    echo run_pipeline > "$NMS/code"
    ;;
  'axi sync --adopt-published') echo run_pipeline > "$NMS/code" ;;
  *) exit 2 ;;
esac
STUB
cat > "$tmpdir/ev" <<'STUB'
#!/bin/sh
echo "$*" >> "$NMS/events"
STUB
chmod +x "$tmpdir/nm" "$tmpdir/ev"
export CALLUM_FLOW_NM_BIN="$tmpdir/nm" CALLUM_FLOW_EVENT_BIN="$tmpdir/ev" CALLUM_FLOW_REGATE_TRIES=2 CALLUM_FLOW_REGATE_SLEEP=0

# fixture: origin (main, branch), gate (branch + a pipeline commit), work rebased onto a new main.
# Sets B, WORK, ORIGIN, GATE, NMS, W1 (old branch commit), P (gate-only pipeline commit).
n=0
mk() {
  n=$((n + 1))
  d="$tmpdir/c$n"
  mkdir -p "$d"
  ORIGIN="$d/origin.git" GATE="$d/gate.git" WORK="$d/work" NMS="$d/nms"
  export WORK NMS
  mkdir -p "$NMS"
  git init -q --bare -b main "$ORIGIN"
  git init -q --bare -b main "$GATE"
  git init -q -b main "$WORK"
  cd "$WORK"
  git remote add origin "$ORIGIN"
  git remote add no-mistakes "$GATE"
  echo base > f
  git add f
  git commit -q -m base
  git push -q origin main
  B=feat/issue-12-x
  git checkout -q -b "$B"
  echo w > w
  git add w
  git commit -q -m work
  W1=$(git rev-parse HEAD)
  git push -q origin "$B"
  git push -q no-mistakes "$B"
  echo p > p
  git add p
  git commit -q -m 'no-mistakes(review): fix'
  P=$(git rev-parse HEAD)
  git push -q no-mistakes "$B"
  git reset -q --hard "$W1"
  # main moves on and the branch is rebased (the patch is the same, the sha differs)
  git checkout -q main
  echo m > m
  git add m
  git commit -q -m m2
  git push -q origin main
  git checkout -q "$B"
  git rebase -q main
  echo failed > "$NMS/status"
  echo "$P" > "$NMS/run_head"
  echo user_owned > "$NMS/code"
}
rg() { sh "$REGATE" --issue 12 "$@" 2>&1; }
tip() { git -C "$1" rev-parse -q --verify "refs/heads/$2" 2> /dev/null || echo none; }
expect() { case "$1" in *"$2"*) ;; *) fail "$3: expected '$2' in: $1" ;; esac; }

# --- usage ---------------------------------------------------------------------
sh "$REGATE" --help > /dev/null 2>&1 && fail "--help should exit 2" || [ $? = 2 ] || fail "--help exit code"
sh "$REGATE" > /dev/null 2>&1 && fail "missing --issue should fail" || [ $? = 2 ] || fail "missing --issue exit code"

# --- user_owned, dropped gate pipeline commit: blocks, then proceeds with the exact sha ----
mk
out=$(rg) && fail "an unaccepted pipeline commit must block" || :
expect "$out" "REGATE FAIL" "block"
expect "$out" "fix:" "block fix text"
[ "$(tip "$GATE" "$B")" = "$P" ] || fail "gate ref must be untouched after a block"
[ "$(tip "$ORIGIN" "$B")" = "$W1" ] || fail "origin must be untouched after a block"
grep -q 'sync --recover\|abort' "$NMS/calls" && fail "no custody action before the check passes" || :
out=$(rg --accept-dropped "$P") || fail "accepted: $out"
expect "$out" "REGATE ready branch=$B head=$(git rev-parse HEAD) archived=" "ready"
case "$out" in *archived=none*) fail "archive expected" ;; esac
[ "$(tip "$WORK" "archive/$B-mirror-$(printf %.8s "$P")")" = "$P" ] || fail "mirror archive must hold the pipeline commit"
[ "$(tip "$GATE" "$B")" = none ] || fail "gate ref must be deleted"
[ "$(tip "$ORIGIN" "$B")" = "$(git rev-parse HEAD)" ] || fail "origin must be lease-pushed to HEAD"
[ ! -e "$NMS/events" ] || fail "same-branch re-gate logs no event any more: $(cat "$NMS/events")"

# --- an abbreviated sha is accepted too; a different sha is not ------------------------
mk
out=$(rg --accept-dropped "$W1") && fail "naming a different commit must not unblock" || :
out=$(rg --accept-dropped "$(printf %.9s "$P")") || fail "abbreviated sha: $out"

# --- gate ref is an ancestor of HEAD: untouched, archived=none -----------------------
mk
git push -q -f no-mistakes "main:refs/heads/$B"
git push -q -f origin "HEAD:refs/heads/$B"
git rev-parse HEAD > "$NMS/run_head"
out=$(rg) || fail "ancestor: $out"
expect "$out" "archived=none" "ancestor"
[ "$(tip "$GATE" "$B")" = "$(git rev-parse main)" ] || fail "an ancestor gate ref must be left alone"

# --- a patch-equivalent gate commit is not dropped -----------------------------------
mk
git push -q -f no-mistakes "$W1:refs/heads/$B"
echo "$W1" > "$NMS/run_head"
out=$(rg) || fail "patch-equivalent: $out"
[ "$(tip "$GATE" "$B")" = none ] || fail "gate ref deleted"
[ "$(tip "$WORK" "archive/$B-mirror-$(printf %.8s "$W1")")" = "$W1" ] || fail "equivalent commit still archived"

# --- live run: abort first, and wait for a terminal status ---------------------------
mk
echo running > "$NMS/status"
out=$(rg --accept-dropped "$P") || fail "live: $out"
grep -q '^axi abort$' "$NMS/calls" || fail "a live run must be aborted"
mk
echo running > "$NMS/status"
: > "$NMS/abort_noop"
out=$(rg --accept-dropped "$P") && fail "a run that does not stop must refuse" || :
expect "$out" "did not stop" "stuck run"
[ "$(tip "$GATE" "$B")" = "$P" ] || fail "nothing deleted while the run lives"

# --- a live run that commits before it stops: nothing it added is deleted or overwritten --
for remote in no-mistakes origin; do
  mk
  echo running > "$NMS/status"
  late=$(git commit-tree -p "$P" -m 'no-mistakes(review): late fix' "$(git rev-parse "$P^{tree}")")
  echo "git -C '$WORK' push -q -f $remote $late:refs/heads/$B" > "$NMS/on_abort"
  out=$(rg --accept-dropped "$P") && fail "$remote moved after the check must refuse" || :
  expect "$out" "rerun callum-flow-regate" "$remote moved"
  case $remote in no-mistakes) r=$GATE ;; *) r=$ORIGIN ;; esac
  [ "$(tip "$r" "$B")" = "$late" ] || fail "the late $remote commit must survive"
done

# --- inspect_and_reconcile_manually: archive first, then exactly sync --recover --keep-local
mk
echo inspect_and_reconcile_manually > "$NMS/code"
out=$(rg --accept-dropped "$P") || fail "inspect: $out"
grep -qx 'axi sync --recover --keep-local' "$NMS/calls" || fail "keep-local recovery expected"
grep -qx archive_present "$NMS/calls" || fail "the archive must exist before the recovery"
[ "$(grep -c 'sync --recover' "$NMS/calls")" = 1 ] || fail "exactly one recovery"

# --- recover_custody: runs the printed command only when it is a sync --recover ---------
mk
echo recover_custody > "$NMS/code"
echo 'no-mistakes axi sync --recover' > "$NMS/command"
rg --accept-dropped "$P" > /dev/null || fail "recover_custody"
grep -qx 'axi sync --recover' "$NMS/calls" || fail "printed recover command expected"
mk
echo recover_custody > "$NMS/code"
echo 'no-mistakes axi sync --recover' > "$NMS/command"
rebased=$(git rev-parse HEAD)
git commit -q --amend -m 'work reworded'
reworded=$(git rev-parse HEAD)
echo "$rebased" > "$NMS/recover_reset"
out=$(rg --accept-dropped "$P") || fail "recover moved HEAD: $out"
expect "$out" "REGATE new-branch branch=$B-v2" "a recovery that moves HEAD falls back"
[ "$(git rev-parse HEAD)" = "$reworded" ] || fail "the new branch must start from the deliberate rebase"
mk
echo recover_custody > "$NMS/code"
echo 'no-mistakes eject' > "$NMS/command"
out=$(rg --accept-dropped "$P") || fail "odd command: $out"
expect "$out" "REGATE new-branch branch=$B-v2" "an unsafe printed command falls back"
grep -q eject "$NMS/calls" && fail "an unknown printed command must never run" || :

# --- adopt_published only when origin equals HEAD ------------------------------------
mk
git push -q -f origin "HEAD:refs/heads/$B"
echo adopt_published > "$NMS/code"
rg --accept-dropped "$P" > /dev/null || fail "adopt"
grep -qx 'axi sync --adopt-published' "$NMS/calls" || fail "adopt expected"
mk
echo adopt_published > "$NMS/code"
out=$(rg --accept-dropped "$P") || fail "adopt mismatch: $out"
expect "$out" "REGATE new-branch" "adopt without a matching origin falls back"
grep -q adopt "$NMS/calls" && fail "must not adopt a head origin does not have" || :

# --- origin refuses the lease push -----------------------------------------------------
mk
printf '#!/bin/sh\nexit 1\n' > "$ORIGIN/hooks/pre-receive"
chmod +x "$ORIGIN/hooks/pre-receive"
out=$(rg --accept-dropped "$P") && fail "a refused lease push must fail" || :
expect "$out" "REGATE FAIL" "lease"

# --- unknown code, refused deletion and --new-branch: <b>-v2, -v3 when -v2 exists ------
mk
echo mystery > "$NMS/code"
out=$(rg --accept-dropped "$P") || fail "unknown: $out"
expect "$out" "REGATE new-branch branch=$B-v2 old_branch=$B old_run=RUN1" "unknown code"
expect "$out" "next:" "next line"
[ "$(git symbolic-ref --short HEAD)" = "$B-v2" ] || fail "worktree must switch to the new branch"
[ ! -e "$NMS/events" ] || fail "new-branch re-gate logs no event any more: $(cat "$NMS/events")"
mk
git branch "$B-v2"
out=$(rg --new-branch --accept-dropped "$P") || fail "new-branch: $out"
expect "$out" "branch=$B-v3" "-v3"
mk
echo running > "$NMS/status"
out=$(rg --new-branch --accept-dropped "$P") || fail "new-branch live: $out"
expect "$out" "REGATE new-branch branch=$B-v2" "new-branch on a live run"
grep -q '^axi abort$' "$NMS/calls" || fail "--new-branch must abort a live run"
mk
echo 0123456789012345678901234567890123456789 > "$NMS/run_head"
out=$(rg --accept-dropped "$P") && fail "an unreadable run head must refuse" || :
expect "$out" "use --new-branch" "unreadable fix text"
out=$(rg --new-branch --accept-dropped "$P") || fail "unreadable with --new-branch: $out"
expect "$out" "REGATE new-branch branch=$B-v2" "--new-branch skips an unreadable source"
mk
git config -f "$GATE/config" receive.denyDeletes true
out=$(rg --accept-dropped "$P") || fail "denied delete: $out"
expect "$out" "REGATE new-branch branch=$B-v2" "refused deletion falls back"
[ "$(tip "$GATE" "$B")" = "$P" ] || fail "refused deletion leaves the gate ref"

# --- preflight refusals change nothing --------------------------------------------------
mk
echo dirt > w
out=$(rg --accept-dropped "$P") && fail "dirty tree must fail" || :
expect "$out" "dirty" "dirty"
mk
git checkout -q --detach
out=$(rg) && fail "detached must fail" || :
expect "$out" "detached" "detached"
mk
git checkout -q main
out=$(rg) && fail "base branch must fail" || :
expect "$out" "base branch" "base"
mk
git reset -q --hard "$W1"
out=$(rg) && fail "missing origin/main must fail" || :
expect "$out" "does not contain origin/main" "behind"
[ "$(tip "$GATE" "$B")" = "$P" ] && [ "$(tip "$ORIGIN" "$B")" = "$W1" ] || fail "refusals must not write"
[ ! -e "$NMS/calls" ] || ! grep -q 'abort\|recover' "$NMS/calls" || fail "refusals must not touch the run"

echo "regate.test.sh: all passed"
