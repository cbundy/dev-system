#!/bin/sh
#
# Plain-shell tests for pipeline-watch.sh single-shot mode and run lookup: --deadline, --branches, no --branches (#134), the run id sources, worktree mapping and --resolve (#243).
# Shared setup, stubs and wait helpers: watchers-lib.sh (read its header for the
# waiting rules: no fixed sleep as a wait, negative windows bounded by watcher
# progress). Split from the old watchers.test.sh (cbundy/dev-system#478).
set -eu

# shellcheck source=./watchers-lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/watchers-lib.sh"

# Seed feat/b as green with CI passed, independently of the stream suite.
run_state RUNB feat/b running "$b_head"
echo "all CI checks passed" > "$nm_home/logs/RUNB/ci.log"

# 4. Single-shot is unchanged: prints the first actionable line and exits 0;
# --deadline still gives the timeout heartbeat.
run_state RUNA feat/a parked aaa
single=$(in_dir "$repo" timeout 10 env PIPELINE_WATCH_INTERVAL=1 "$PIPELINE_WATCH" \
  --branches feat/a,feat/b) || fail "single-shot did not exit 0"
[ "$single" = "merge-ready feat/b RUNB head=$b_head" ] || fail "single-shot: $single"
single=$(in_dir "$repo" timeout 10 "$PIPELINE_WATCH" --interval 1 --deadline 1 --branches feat/quiet) ||
  fail "deadline: did not exit 0"
[ "$single" = timeout ] || fail "deadline: $single"
ok # single-shot unchanged

# Seed two failed launches for lookup coverage: one on a branch with a
# worktree, one with none.
g -C "$repo" worktree add -q -b feat/c "$tmpdir/wt-c"
run_state RUNC feat/c failed ccc
run_state RUND feat/d failed ddd
runs_order RUND RUNC RUNB RUNA

# 6. --branches still restricts the set: the newer failed runs on other
# branches do not fire.
single=$(in_dir "$repo" timeout 10 "$PIPELINE_WATCH" --interval 1 --branches feat/b) ||
  fail "--branches: did not exit 0"
[ "$single" = "merge-ready feat/b RUNB head=$b_head" ] || fail "--branches: $single"
ok # --branches filters

# 7. From a checkout whose branch has no run, the run id comes from the
# `axi status` run table, so the run with no log directory and no worktree
# is reported with its id.
g -C "$repo" worktree add -q -b idle "$tmpdir/wt-idle"
single=$(in_dir "$tmpdir/wt-idle" timeout 10 "$PIPELINE_WATCH" --interval 1 --branches feat/d) ||
  fail "run table: did not exit 0"
[ "$single" = "failed feat/d RUND head=ddd" ] || fail "run table: $single"
ok # run id resolved from the run table

# 8. The worktree a branch is checked out in is found automatically: a
# local commit the green run never gated is a head-mismatch with no
# --worktree mapping.
g -C "$repo" worktree add -q -b feat/e "$tmpdir/wt-e"
g -C "$tmpdir/wt-e" push -q origin feat/e
run_state RUNE feat/e running "$b_head"
mkdir -p "$nm_home/logs/RUNE"
echo "all CI checks passed" > "$nm_home/logs/RUNE/ci.log"
runs_order RUNE RUND RUNC RUNB RUNA
single=$(in_dir "$repo" timeout 10 "$PIPELINE_WATCH" --interval 1 --branches feat/e) ||
  fail "auto worktree: did not exit 0"
[ "$single" = "merge-ready feat/e RUNE head=$b_head" ] || fail "auto worktree, in sync: $single"
g -C "$tmpdir/wt-e" commit -q --allow-empty -m "ungated"
e_head=$(g -C "$tmpdir/wt-e" rev-parse HEAD)
single=$(in_dir "$repo" timeout 10 "$PIPELINE_WATCH" --interval 1 --branches feat/e) ||
  fail "auto worktree: did not exit 0"
[ "$single" = "head-mismatch feat/e RUNE run=$b_head branch=$b_head worktree=$e_head head=$b_head" ] ||
  fail "auto worktree, ungated commit: $single"
ok # worktree mapped automatically

# 8b. --resolve <branch> (cbundy/dev-system#243): a one-shot lookup that
# prints the branch's newest run id alone, never polls and never records an
# event. A stub callum-flow-event records any call it gets.
cat > "$fakebin/callum-flow-event" <<'EOF'
#!/bin/sh
echo "$*" >> "$(dirname "$0")/event-calls"
EOF
chmod +x "$fakebin/callum-flow-event"
resolve() { in_dir "$1" timeout 10 "$PIPELINE_WATCH" --resolve "$2"; }

# from the branch's own worktree (its `axi status` run detail)
res=$(resolve "$tmpdir/wt-e" feat/e) || fail "--resolve worktree: did not exit 0"
[ "$res" = RUNE ] || fail "--resolve worktree: $res"
# from the run table, when the cwd branch has no run
res=$(resolve "$tmpdir/wt-idle" feat/d) || fail "--resolve table: did not exit 0"
[ "$res" = RUND ] || fail "--resolve table: $res"
# the newest of two runs on one branch
run_state RUNOLD feat/d failed old
runs_order RUNE RUND RUNC RUNB RUNA RUNOLD
res=$(resolve "$tmpdir/wt-idle" feat/d) || fail "--resolve newest: did not exit 0"
[ "$res" = RUND ] || fail "--resolve newest run: $res"
# from the log directories, when the table has nothing
touch "$fakebin/no-table"
mkdir -p "$nm_home/logs/RUND"
res=$(resolve "$tmpdir/wt-idle" feat/d) || fail "--resolve log directory: did not exit 0"
[ "$res" = RUND ] || fail "--resolve log directory: $res"
rm "$fakebin/no-table"
# no run: exit 1, nothing on stdout
st=0
res=$(resolve "$tmpdir/wt-idle" feat/none) || st=$?
if [ "$st" -ne 1 ] || [ -n "$res" ]; then fail "--resolve no run: exit $st, out '$res'"; fi
# a failing lookup: exit 1, nothing on stdout
touch "$fakebin/nm-fail"
st=0
res=$(resolve "$tmpdir/wt-idle" feat/d) || st=$?
rm "$fakebin/nm-fail"
if [ "$st" -ne 1 ] || [ -n "$res" ]; then fail "--resolve lookup failure: exit $st, out '$res'"; fi
# no other option
st=0
res=$(in_dir "$tmpdir/wt-idle" "$PIPELINE_WATCH" --resolve feat/d --branches feat/d 2>/dev/null) || st=$?
if [ "$st" -ne 2 ] || [ -n "$res" ]; then fail "--resolve with --branches: exit $st, out '$res'"; fi
[ ! -e "$fakebin/event-calls" ] || fail "--resolve recorded an event: $(cat "$fakebin/event-calls")"
rm "$fakebin/callum-flow-event"
runs_order RUNE RUND RUNC RUNB RUNA
ok # --resolve: id from each source, newest run, no run, failure, no events

echo "ok - $passed pipeline-watch scenarios passed"
