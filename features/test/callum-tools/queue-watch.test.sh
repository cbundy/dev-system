#!/bin/sh
#
# Plain-shell tests for queue-watch.sh: the debounce, single-shot, --known order, and fatal errors (cbundy/dev-system#54, #123).
# Shared setup, stubs and wait helpers: watchers-lib.sh (read its header for the
# waiting rules: no fixed sleep as a wait, negative windows bounded by watcher
# progress). Split from the old watchers.test.sh (cbundy/dev-system#478).
set -eu

# shellcheck source=./watchers-lib.sh
. "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/watchers-lib.sh"

# 9. Debounce: a one-poll blip (label-list lag) does not fire.
queue_seq 305,307 305
quiet_run "one-poll blip" "$fakebin/gh-calls" 305
ok # debounce ignores a one-poll blip

# 10. Single-shot: a change seen on two polls fires and exits 0; a failed
# poll between them neither fires nor clears the pending change.
queue_seq 305,307 FAIL 305,307
# shellcheck disable=SC2086 # $qw is the command and its fixed options
single=$(in_dir "$tmpdir" timeout 10 $qw --known 305) || fail "single-shot queue: did not exit 0"
[ "$single" = "queue-changed known=305 now=305,307" ] || fail "single-shot queue: $single"
ok # single-shot queue fires on a confirmed change

# 11b. --known in any order is the same set: the watcher sorts the baseline
# numerically, so an unsorted list never fires a spurious queue-changed.
queue_seq 114,153,219
quiet_run "unsorted --known" "$fakebin/gh-calls" 219,114,153
queue_seq 9,10,100
quiet_run "numeric (not text) order" "$fakebin/gh-calls" 100,9,10
ok # an unsorted --known does not fire queue-changed

# 12. Stream: gh missing is fatal and reported.
mv "$fakebin/gh" "$fakebin/gh.off"
st=0
# shellcheck disable=SC2086 # $qw is the command and its fixed options
(in_dir "$tmpdir" $qw --stream) > "$out" 2>/dev/null || st=$?
mv "$fakebin/gh.off" "$fakebin/gh"
[ "$st" -ne 0 ] || fail "queue stream without gh: exited 0"
expect_lines "$out" "watcher-error gh not on PATH"
ok # queue stream fatal error reported

# 13. Stream: an unexpected failure (here `sleep` itself failing) still ends
# with a watcher-error line, never a silent exit.
printf '#!/bin/sh\nexit 3\n' > "$fakebin/sleep"
chmod +x "$fakebin/sleep"
queue_seq 305
st=0
# shellcheck disable=SC2086 # $qw is the command and its fixed options
(in_dir "$tmpdir" timeout 10 $qw --stream --known 305) > "$out" 2>/dev/null || st=$?
rm "$fakebin/sleep"
[ "$st" -eq 3 ] || fail "unexpected failure: exit $st, want 3"
expect_lines "$out" "watcher-error exited with status 3"
ok # unexpected exit reported

echo "ok - $passed queue-watch scenarios passed"
