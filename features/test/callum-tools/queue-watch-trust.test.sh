#!/bin/sh
#
# Plain-shell tests for queue-watch.sh trust (cbundy/dev-system#310): an issue by an untrusted author never enters the queue.
# Shared setup, stubs and wait helpers: watchers-lib.sh (read its header for the
# waiting rules: no fixed sleep as a wait, negative windows bounded by watcher
# progress). Split from the old watchers.test.sh (cbundy/dev-system#478).
set -eu

# shellcheck source=./watchers-lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/watchers-lib.sh"

# 14. Trust (cbundy/dev-system#310): an issue by an untrusted author never enters
# the queue, so it never fires queue-changed and no ready event is logged for it.
cat > "$fakebin/fabriek-event" <<'EOF'
#!/bin/sh
echo "$*" >> "$(dirname "$0")/event-calls"
EOF
chmod +x "$fakebin/fabriek-event"
rm -f "$fakebin/event-calls"
# only an untrusted issue joins: nothing fires
queue_seq 305,x400
quiet_run "untrusted ready issue" "$fakebin/gh-calls" 305
if grep -q 'ready' "$fakebin/event-calls" 2>/dev/null; then fail "ready event for an untrusted issue: $(cat "$fakebin/event-calls")"; fi
# a trusted issue beside it still fires, and only it is in now= and logged
queue_seq 305,307,x400
rm -f "$fakebin/event-calls"
# shellcheck disable=SC2086 # $qw is the command and its fixed options
mixed=$(in_dir "$tmpdir" timeout 10 $qw --known 305) || fail "mixed queue: did not exit 0"
[ "$mixed" = "queue-changed known=305 now=305,307" ] || fail "mixed queue: $mixed"
grep -q 'ready --issue 307' "$fakebin/event-calls" || fail "no ready event for the trusted issue"
grep -qF 'ready --issue 307 --if-changed --data {"title":"title 307","labels":["ready","bug"],"parent":1307} --actor watcher' "$fakebin/event-calls" ||
  fail "the stream ready event lacks the issue facts: $(cat "$fakebin/event-calls")"
if grep -q 'ready --issue 400' "$fakebin/event-calls"; then fail "ready event for the untrusted issue"; fi
# a reader failure is a failed poll: never an empty queue
queue_seq FAIL
quiet_run "reader failure" "$fakebin/gh-calls" 305
# an unusable trusted list is a failed poll too. The reader fails before it
# asks gh, so no gh call marks progress: a logging sleep counts the poll cycles.
queue_seq 307
cat > "$fakebin/sleep" <<EOF
#!/bin/sh
echo x >> "$fakebin/sleep-calls"
exec "$toolbin/sleep" "\$@"
EOF
chmod +x "$fakebin/sleep"
quiet_run "no trusted list" "$fakebin/sleep-calls" 305 FABRIEK_TRUSTED_AUTHORS=
rm "$fakebin/sleep"
# a missing reader is fatal in stream mode
st=0
# shellcheck disable=SC2086 # $qw is the command and its fixed options
(in_dir "$tmpdir" env FABRIEK_ISSUE_READ_BIN="$tmpdir/missing-reader" $qw --stream) > "$out" 2>/dev/null || st=$?
[ "$st" -ne 0 ] || fail "queue stream without the reader: exited 0"
expect_lines "$out" "watcher-error $tmpdir/missing-reader not on PATH"
rm "$fakebin/fabriek-event"
ok # untrusted issues never enter the queue

echo "ok - $passed queue-watch trust scenarios passed"
