#!/bin/sh
#
# Plain-shell tests for queue-watch.sh --once (docs/factory-loop/SPEC.md 3.4, DECISIONS D-20):
# one read, no debounce, the same trust filtering, one line and exit 0; ready events for new
# members as a first sight; a failed read exits 1, never an empty queue.
# Shared setup, stubs and wait helpers: watchers-lib.sh (read its header for the
# waiting rules). Every --once call here is a single bounded process, so no wait is needed.
set -eu

# shellcheck source=./watchers-lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/watchers-lib.sh"

qo="$QUEUE_WATCH --repo o/r --label ready --once"
# once [options]: one --once call, in a subshell (in_dir replaces its process).
once() {
  # shellcheck disable=SC2086 # $qo is the command and its fixed options
  (in_dir "$tmpdir" timeout 10 $qo "$@")
}
# once_status [VAR=value]... [option]...: one --once call with those variables and options;
# stdout to $out, stderr to $out.err, the exit status in $st.
once_status() {
  vars=
  while [ "$#" -gt 0 ]; do
    case "$1" in *=*) vars="$vars $1" ;; *) break ;; esac
    shift
  done
  st=0
  # shellcheck disable=SC2086 # $vars are assignments without spaces; $qo is the command and its fixed options
  (in_dir "$tmpdir" timeout 10 env $vars $qo "$@") > "$out" 2> "$out.err" || st=$?
}
# A stub callum-flow-event that records each call.
cat > "$fakebin/callum-flow-event" <<'EOF'
#!/bin/sh
echo "$*" >> "$(dirname "$0")/event-calls"
EOF
chmod +x "$fakebin/callum-flow-event"
calls="$fakebin/event-calls"

# 1. A changed queue: one listing call (no confirming read), the line, and a ready event for each
# new member as a first sight (--if-changed); untrusted issues never enter now=.
queue_seq 305,307,x400,310
: > "$fakebin/gh-calls"
: > "$calls"
res=$(once --known 305) || fail "changed queue: did not exit 0"
[ "$res" = "queue known=305 now=305,307,310" ] || fail "changed queue: $res"
[ "$(line_count "$fakebin/gh-calls")" = 1 ] || fail "changed queue: want one read, got $(line_count "$fakebin/gh-calls")"
# (the reader logs its own untrusted_stripped event for #400)
grep '^ready ' "$calls" > "$calls.ready" || :
expect_lines "$calls.ready" "ready --issue 307 --if-changed --actor watcher
ready --issue 310 --if-changed --actor watcher"
ok # one read, the line, ready events for new members only

# 2. An unchanged queue still prints its line and logs nothing; --known in any order is the same set.
queue_seq 114,153,219
: > "$calls"
res=$(once --known 219,114,153) || fail "unchanged queue: did not exit 0"
[ "$res" = "queue known=114,153,219 now=114,153,219" ] || fail "unchanged queue: $res"
[ ! -s "$calls" ] || fail "unchanged queue logged: $(cat "$calls")"
ok # an unchanged queue prints and logs nothing

# 3. The empty set: --known left out, empty or "none" (the line's own spelling) is none.
queue_seq ""
for k in "" "--known none" "--known ,"; do
  # shellcheck disable=SC2086 # $k is an option and its value
  res=$(once $k) || fail "empty ($k): did not exit 0"
  [ "$res" = "queue known=none now=none" ] || fail "empty ($k): $res"
done
queue_seq 9
: > "$calls"
res=$(once --known none) || fail "none baseline: did not exit 0"
[ "$res" = "queue known=none now=9" ] || fail "none baseline: $res"
expect_lines "$calls" "ready --issue 9 --if-changed --actor watcher"
ok # none, empty and absent baselines are the empty set

# 4. A failed read exits 1 with the reason and no line: a failed source, never an empty queue.
# So does an unusable trusted list, a missing reader and a missing gh; none of them logs.
: > "$calls"
queue_seq FAIL
once_status --known 305
if [ "$st" -ne 1 ] || [ -s "$out" ]; then fail "reader failure: exit $st, out $(cat "$out")"; fi
grep -qx "queue-watch.sh: cannot read the queue" "$out.err" || fail "reader failure: $(cat "$out.err")"
queue_seq 307
once_status CALLUM_FLOW_TRUSTED_AUTHORS= --known 305
if [ "$st" -ne 1 ] || [ -s "$out" ]; then fail "no trusted list: exit $st, out $(cat "$out")"; fi
once_status CALLUM_FLOW_ISSUE_READ_BIN="$tmpdir/missing-reader"
if [ "$st" -ne 1 ] || [ -s "$out" ]; then fail "missing reader: exit $st, out $(cat "$out")"; fi
grep -qx "queue-watch.sh: $tmpdir/missing-reader not on PATH" "$out.err" || fail "missing reader: $(cat "$out.err")"
mv "$fakebin/gh" "$fakebin/gh.off"
once_status
mv "$fakebin/gh.off" "$fakebin/gh"
if [ "$st" -ne 1 ] || [ -s "$out" ]; then fail "no gh: exit $st, out $(cat "$out")"; fi
grep -qx "queue-watch.sh: gh not on PATH" "$out.err" || fail "no gh: $(cat "$out.err")"
[ ! -s "$calls" ] || fail "a failed --once logged: $(cat "$calls")"
ok # failures exit 1 with the reason, never an empty queue

# 5. The real event log: repeated reads log each new member once.
real_event_log
queue_seq 5,6
for i in 1 2 3; do
  res=$(once --known 5) || fail "replay: did not exit 0"
  [ "$res" = "queue known=5 now=5,6" ] || fail "replay: $res"
done
[ "$(ev_count '"state":"ready"')" = 1 ] || fail "replay: want one ready line: $(cat "$evlog")"
ok # repeated --once reads do not replay ready events

# 6. --once takes no option except --repo, --label and --known. (With --stream named, the usage
# error is also reported as stream mode reports one: a watcher-error line on stdout.)
for opt in --stream "--interval 1"; do
  # shellcheck disable=SC2086 # $opt is an option and its value
  once_status $opt
  [ "$st" -eq 2 ] || fail "--once $opt: exit $st"
  grep -q "^queue-watch.sh: --once takes no option except --repo, --label and --known" "$out.err" ||
    fail "--once $opt: $(cat "$out.err")"
done
rm "$fakebin/callum-flow-event"
ok # conflicting options are usage errors

echo "ok - $passed queue-watch --once scenarios passed"
