#!/bin/bash
# shellcheck disable=SC2016,SC2154 # the stub scripts are written with literal $ on purpose
#
# Plain-shell test for images/base/dev-remote-sessions (cbundy/dev-system#533): which Remote
# Control sessions come back after a restart, and how they are started.
#
# Builds fixture sessions/*.json records and transcripts in a scratch CLAUDE_CONFIG_DIR, real
# `sleep` processes for the live ones, and stubs `tmux` on PATH (every call is recorded). No
# Docker, claude or network needed.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
HELPER="$SCRIPT_DIR/../dev-remote-sessions"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -x "$HELPER" ] || fail "$HELPER is missing or not executable"

tmp=$(mktemp -d)
pids=""
trap 'for p in $pids; do kill "$p" 2>/dev/null || :; done; rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin" "$tmp/share" "$tmp/cfg/sessions" "$tmp/cfg/projects" "$tmp/state" "$tmp/mark" "$tmp/cwd-a" "$tmp/cwd-b" "$tmp/cwd-c"
cp "$SCRIPT_DIR/../claude-config.sh" "$tmp/share/"
: > "$tmp/share/telemetry.sh"

# Stub tmux: records argv one call per line; has-session succeeds once new-session ran.
cat > "$tmp/bin/tmux" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$TMUX_LOG"
case $1 in
  has-session) [ -e "$TMUX_LOG.session" ] ;;
  display-message) [ -z "${TMUX_PANE_PID:-}" ] || echo "$TMUX_PANE_PID" ;;
  new-session | new-window)
    [ -z "${TMUX_FAIL_CWD:-}" ] || case "$*" in *"-c $TMUX_FAIL_CWD "*) exit 1 ;; esac
    [ "$1" != new-session ] || : > "$TMUX_LOG.session"
    ;;
  *) ;;
esac
STUB
chmod +x "$tmp/bin/tmux"
export TMUX_LOG="$tmp/tmux.log"

export PATH="$tmp/bin:$PATH" HOME="$tmp/home" CLAUDE_CONFIG_DIR="$tmp/cfg" DEV_RESTART_SELF_DIR="$tmp/state" \
  DEV_REMOTE_SESSIONS_MARK_DIR="$tmp/mark" DEV_SYSTEM_SHARE="$tmp/share"
unset DEV_REMOTE_CONTROL_RESTORE_HOURS DEV_REMOTE_SESSIONS_SOCKET
mkdir -p "$HOME"

sleep 600 &
live_pid=$!
pids="$live_pid"
sleep 1
live_start=$(sed 's/.*) //' "/proc/$live_pid/stat" | cut -d' ' -f20)
dead_pid=$( (sh -c 'echo $$') )
now_ms=$(($(date +%s) * 1000))

# rec <file-pid> <sessionId> <cwd> <tmux> <bridge> <kind> <ageHours> <pid> <procStart> [name]
rec() {
  jq -n --argjson pid "$8" --arg sid "$2" --arg cwd "$3" --arg tmux "$4" --arg b "$5" --arg kind "$6" \
    --argjson upd "$((now_ms - $7 * 3600000))" --arg ps "$9" --arg name "${10:-name-$2}" \
    '{pid:$pid,sessionId:$sid,cwd:$cwd,kind:$kind,name:$name,tmux:$tmux,procStart:$ps,updatedAt:$upd,
      version:"2.1.299",extra:{unknown:"fields"}} + (if $b == "" then {} else {bridgeSessionId:$b} end)' > "$tmp/cfg/sessions/$1.json"
}
# transcript <sessionId> <cwd> <mode> <effort> <model>
transcript() {
  d="$tmp/cfg/projects/$(printf '%s' "$2" | sed 's/[^a-zA-Z0-9]/-/g')"
  mkdir -p "$d"
  {
    printf '{"type":"permission-mode","permissionMode":"default","sessionId":"%s"}\n' "$1"
    printf '{"type":"user","message":{"role":"user","content":"hi"}}\n'
    printf '{"type":"assistant","effort":"low","message":{"model":"claude-old-1"}}\n'
    printf '{"type":"permission-mode","permissionMode":"%s","sessionId":"%s"}\n' "$3" "$1"
    printf '{"type":"assistant","effort":"%s","message":{"model":"%s"}}\n' "$4" "$5"
    printf '{"type":"assistant","effort":null,"message":{"model":"<synthetic>"}}\n'
  } > "$d/$1.jsonl"
}

A=aaaaaaaa-1111-4111-8111-111111111111
B=bbbbbbbb-2222-4222-8222-222222222222
C=cccccccc-3333-4333-8333-333333333333
cwd_a="$tmp/cwd-a" cwd_b="$tmp/cwd-b" cwd_c="$tmp/cwd-c"

# Restore candidates (all stale: their process is gone):
rec 101 $A "$cwd_a" "dev:@1.%1" session_A interactive 2 "$dead_pid" 1111 "A name"
transcript $A "$cwd_a" bypassPermissions high claude-opus-x
rec 102 $B "$cwd_b" "dev:@2.%2" session_B interactive 3 "$dead_pid" 2222
transcript $B "$cwd_b" plan medium claude-sonnet-x
# Newer duplicate of A (same sessionId): resumed once, from the newest record.
rec 103 $A "$cwd_a" "dev:@3.%3" session_A interactive 1 "$dead_pid" 3333 "A name"
# Excluded:
rec 110 e1111111-0000-4000-8000-000000000001 "$cwd_c" "claude:@0.%0" session_S interactive 1 "$dead_pid" 1 # the supervisor's own session
mkdir -p "$tmp/state/remote-sessions/supervisor"
: > "$tmp/state/remote-sessions/supervisor/e1111111-0000-4000-8000-000000000001"
transcript e1111111-0000-4000-8000-000000000001 "$cwd_c" default high m
rec 111 e2222222-0000-4000-8000-000000000002 "$cwd_c" "dev:@4.%4" "" interactive 1 "$dead_pid" 1 # no bridgeSessionId
transcript e2222222-0000-4000-8000-000000000002 "$cwd_c" default high m
rec 112 e3333333-0000-4000-8000-000000000003 "$cwd_c" "" session_N sdk 1 "$dead_pid" 1 # not interactive
transcript e3333333-0000-4000-8000-000000000003 "$cwd_c" default high m
rec 113 e4444444-0000-4000-8000-000000000004 "$cwd_c" "dev:@5.%5" session_O interactive 30 "$dead_pid" 1 # older than the window
transcript e4444444-0000-4000-8000-000000000004 "$cwd_c" default high m
rec 114 e5555555-0000-4000-8000-000000000005 "$cwd_c" "dev:@6.%6" session_P interactive 1 "$live_pid" "$live_start" # live
transcript e5555555-0000-4000-8000-000000000005 "$cwd_c" default high m
rec 115 e6666666-0000-4000-8000-000000000006 "$cwd_c" "dev:@7.%7" session_Q interactive 1 "$live_pid" "$((live_start + 1))" # recycled pid: stale
transcript e6666666-0000-4000-8000-000000000006 "$cwd_c" acceptEdits "" ""
rec 116 e7777777-0000-4000-8000-000000000007 "$cwd_c" "dev:@8.%8" session_R interactive 1 "$dead_pid" 1 # no transcript
echo '{not json' > "$tmp/cfg/sessions/117.json"
echo '{"pid":"x"}' > "$tmp/cfg/sessions/118.json"

ids() { jq -r .sessionId | sort | tr '\n' ' '; }

# --- pending: stale records, deduplicated, minus the exclusions ------------------------------
out=$("$HELPER" pending 2>"$tmp/err") || fail "pending failed: $(cat "$tmp/err")"
got=$(printf '%s\n' "$out" | ids)
want="$A $B e6666666-0000-4000-8000-000000000006 "
[ "$got" = "$want" ] || fail "pending sessions: '$got', want '$want'"
printf '%s\n' "$out" | jq -e --arg a $A 'select(.sessionId == $a) | .procStart == "3333" and .permissionMode == "bypassPermissions" and .effort == "high" and .model == "claude-opus-x" and (.keys | length) == 2' > /dev/null ||
  fail "A: wrong merged record: $out"
printf '%s\n' "$out" | jq -e --arg b $B 'select(.sessionId == $b) | .permissionMode == "plan" and .effort == "medium" and .model == "claude-sonnet-x"' > /dev/null ||
  fail "B: wrong transcript fields"
grep -q "skipping" "$tmp/err" || fail "malformed records were not logged"
grep -q "no transcript" "$tmp/err" || fail "a session without a transcript was not logged"

# RESTORE_HOURS=0 turns it off; 48 brings the 30h one back.
! DEV_REMOTE_CONTROL_RESTORE_HOURS=0 "$HELPER" cwds 2>/dev/null | grep -q pending || fail "RESTORE_HOURS=0 still lists pending sessions"
DEV_REMOTE_CONTROL_RESTORE_HOURS=48 "$HELPER" pending 2>/dev/null | grep -q e4444444 || fail "RESTORE_HOURS=48 did not include a 30h-old session"

# --- cwds: live and pending directories ---------------------------------------------------------
cw=$("$HELPER" cwds 2>/dev/null)
printf '%s\n' "$cw" | grep -qxF "$(printf 'live\t%s' "$cwd_c")" || fail "cwds: no live line: $cw"
printf '%s\n' "$cw" | grep -qxF "$(printf 'pending\t%s' "$cwd_a")" || fail "cwds: no pending line: $cw"
DEV_REMOTE_CONTROL_RESTORE_HOURS=1 "$HELPER" cwds 2>/dev/null | grep -qF "$cwd_b" && fail "cwds before plan: a session outside the window is pending"

# --- taken: before plan, only the live sessions -----------------------------------------------------
[ "$("$HELPER" taken 2>/dev/null)" = e5555555-0000-4000-8000-000000000005 ] || fail "taken: wrong sessionIds: $("$HELPER" taken 2>&1)"

# --- snapshot: a no-op until restore ran this boot ----------------------------------------------
"$HELPER" snapshot 2>/dev/null
[ ! -e "$tmp/state/remote-sessions/snapshot" ] || fail "snapshot wrote before plan"

# --- plan freezes the candidates, once per boot -------------------------------------------------
"$HELPER" plan 2>/dev/null || fail "plan failed"
[ "$(wc -l < "$tmp/state/remote-sessions/pending.json")" = 3 ] || fail "plan: expected 3 pending lines"
"$HELPER" plan 2>/dev/null && fail "a second plan in the same boot did not exit 3"
"$HELPER" snapshot 2>/dev/null
[ ! -e "$tmp/state/remote-sessions/snapshot" ] || fail "snapshot wrote before restore"
# A planned session keeps its directory even once it ages out of the window.
DEV_REMOTE_CONTROL_RESTORE_HOURS=1 "$HELPER" cwds 2>/dev/null | grep -qxF "$(printf 'pending\t%s' "$cwd_b")" ||
  fail "cwds after plan: a planned session's directory is not held"

# --- restore: argv, cwd, flags; no message; ledger; once per boot ---------------------------------
: > "$TMUX_LOG"
rm -f "$TMUX_LOG.session"
"$HELPER" restore 2>"$tmp/err" || fail "restore failed: $(cat "$tmp/err")"
[ "$(grep -c '^new-session' "$TMUX_LOG")" = 1 ] || fail "restore: expected one new-session: $(cat "$TMUX_LOG")"
[ "$(grep -c '^new-window' "$TMUX_LOG")" = 2 ] || fail "restore: expected two new-windows: $(cat "$TMUX_LOG")"
grep -q -- '-s rc-restored' "$TMUX_LOG" || fail "restore: not in the rc-restored session"
grep -v 'rc-restored' "$TMUX_LOG" | grep -qv '^has-session' && fail "restore touched another tmux session: $(cat "$TMUX_LOG")"
la=$(grep -- "--resume $A" "$TMUX_LOG") || fail "A was not resumed: $(cat "$TMUX_LOG")"
for w in "-c $cwd_a" "--remote-control A name" "--dangerously-skip-permissions --settings {\"skipDangerousModePermissionPrompt\":true}" "--effort high" "--model claude-opus-x"; do
  printf '%s\n' "$la" | grep -qF -- "$w" || fail "A launch lacks '$w': $la"
done
lb=$(grep -- "--resume $B" "$TMUX_LOG") || fail "B was not resumed"
printf '%s\n' "$lb" | grep -qF -- "--permission-mode plan" || fail "B launch lacks --permission-mode plan: $lb"
printf '%s\n' "$lb" | grep -qF -- "--dangerously-skip-permissions" && fail "B (not bypass) got the bypass flags"
lq=$(grep -- "--resume e6666666" "$TMUX_LOG") || fail "the recycled-pid session was not resumed"
printf '%s\n' "$lq" | grep -qF -- "--effort" && fail "empty effort was passed: $lq"
grep -q 'send-keys' "$TMUX_LOG" && fail "restore sent keys (a message) to a session"
grep -cF -- "--resume $A" "$TMUX_LOG" | grep -qx 1 || fail "A was resumed more than once"
jq -e '.projects["'"$cwd_a"'"].hasTrustDialogAccepted == true' "$tmp/cfg/.claude.json" > /dev/null || fail "the resumed cwd was not marked trusted"
for k in 101-1111 102-2222 103-3333; do
  [ -e "$tmp/state/remote-sessions/ledger/$dead_pid-${k#*-}" ] || fail "ledger lacks $k"
done
[ ! -e "$tmp/state/remote-sessions/pending.json" ] || fail "pending.json was not consumed"
"$HELPER" restore 2>/dev/null && fail "a second restore in the same boot did not exit 3"

# --- snapshot, once restore ran: a graceful exit is remembered ------------------------------------
"$HELPER" snapshot 2>/dev/null
[ -e "$tmp/state/remote-sessions/snapshot/${live_pid}-${live_start}.json" ] || fail "snapshot did not record the live session"
[ "$(find "$tmp/state/remote-sessions/snapshot" -type f | wc -l)" = 1 ] || fail "snapshot holds more than the live session"

# --- next boot: the ledger stops a second restore of the same records ---------------------------
rm -f "$tmp/mark"/*
: > "$TMUX_LOG"
"$HELPER" plan 2>/dev/null
"$HELPER" restore 2>/dev/null
grep -q -- "--resume $A" "$TMUX_LOG" && fail "the ledger did not stop a second restore of A"
grep -q -- "--resume $B" "$TMUX_LOG" && fail "the ledger did not stop a second restore of B"

# --- one failing launch does not stop the others; a missing cwd is skipped -----------------------
rm -rf "$tmp/state/remote-sessions" "$tmp/mark"/*
rm -f "$tmp/cfg/sessions/"1[01][0-9].json
rec 201 $A "$cwd_a" "dev:@1.%1" session_A interactive 1 "$dead_pid" 5001
transcript $A "$cwd_a" default high m
rec 202 $B "$cwd_b" "dev:@2.%2" session_B interactive 1 "$dead_pid" 5002
transcript $B "$cwd_b" default high m
rec 203 $C "$tmp/gone" "dev:@3.%3" session_C interactive 1 "$dead_pid" 5003
transcript $C "$tmp/gone" default high m
: > "$TMUX_LOG"
rm -f "$TMUX_LOG.session"
export TMUX_FAIL_CWD="$cwd_a"
"$HELPER" plan 2>/dev/null
"$HELPER" restore 2>"$tmp/err" || fail "restore failed with a failing launch"
unset TMUX_FAIL_CWD
grep -q "$B\|-c $cwd_b" "$TMUX_LOG" || fail "B was not started after A failed to start: $(cat "$TMUX_LOG")"
grep -q "no longer exists" "$tmp/err" || fail "a missing cwd was not logged"
grep -q "could not start" "$tmp/err" || fail "a failing launch was not logged"
[ -e "$tmp/state/remote-sessions/ledger/$dead_pid-5001" ] || fail "a failed launch was not ledgered"

# --- taken covers planned and restored sessions; restore never starts a running one -----------------
# C came back to life after plan.
rm -rf "$tmp/state/remote-sessions" "$tmp/mark"/*
rm -f "$tmp/cfg/sessions/"2[0-9][0-9].json
rec 301 $A "$cwd_a" "dev:@1.%1" session_A interactive 1 "$dead_pid" 6001
rec 302 $B "$cwd_b" "dev:@2.%2" session_B interactive 1 "$dead_pid" 6002
rec 303 $C "$cwd_c" "dev:@3.%3" session_C interactive 1 "$dead_pid" 6003
transcript $C "$cwd_c" default high m
"$HELPER" plan 2>/dev/null
[ "$(wc -l < "$tmp/state/remote-sessions/pending.json")" = 3 ] || fail "taken: expected 3 pending lines"
got=$("$HELPER" taken 2>/dev/null | sort -u | tr '\n' ' ')
[ "$got" = "$A $B $C " ] || fail "taken after plan: '$got', want the planned sessions"
rec 304 $C "$cwd_c" "dev:@4.%4" session_C interactive 0 "$live_pid" "$live_start"
: > "$TMUX_LOG"
"$HELPER" restore 2>"$tmp/err" || fail "restore failed: $(cat "$tmp/err")"
grep -q -- "--resume $C" "$TMUX_LOG" && fail "restore started a session that is live"
grep -q -- "--resume $A" "$TMUX_LOG" || fail "restore did not start A next to a live session: $(cat "$TMUX_LOG")"
grep -q -- "--resume $B" "$TMUX_LOG" || fail "restore did not start B next to a live session: $(cat "$TMUX_LOG")"
grep -q "already running" "$tmp/err" || fail "a running session skipped by restore was not logged: $(cat "$tmp/err")"
[ -e "$tmp/state/remote-sessions/ledger/$dead_pid-6003" ] || fail "a skipped session was not ledgered"
rm -f "$tmp/cfg/sessions/304.json"
got=$("$HELPER" taken 2>/dev/null | sort -u | tr '\n' ' ')
[ "$got" = "$A $B $C " ] || fail "taken after restore: '$got', want the restored sessions"

# --- the supervisor's own session is told apart by its process, not by its tmux session ------------
# The supervisor's pane runs a shell whose child is Claude. X was spawned by the server and inherited
# the supervisor's pane; Y ran in another window of tmux session claude. Both come back; S never does.
# An earlier snapshot already identified a supervisor session (E), so no record is adopted by tmux name.
rm -rf "$tmp/state/remote-sessions" "$tmp/mark"/*
rm -f "$tmp/cfg/sessions/"*.json
E=f0000000-0000-4000-8000-000000000000
mkdir -p "$tmp/state/remote-sessions/supervisor"
: > "$tmp/state/remote-sessions/supervisor/$E"
bash -c 'sleep 600; :' 2>/dev/null &
pane_pid=$!
pids="$pids $pane_pid"
sup_pid=""
for _ in $(seq 25); do sup_pid=$(pgrep -P "$pane_pid") && break; sleep 0.2; done
[ -n "$sup_pid" ] || fail "the supervisor stand-in did not start"
pids="$pids $sup_pid"
sup_start=$(sed 's/.*) //' "/proc/$sup_pid/stat" | cut -d' ' -f20)
S=f1111111-4444-4444-8444-444444444444 X=f2222222-5555-4555-8555-555555555555 Y=f3333333-6666-4666-8666-666666666666
rec 401 $S "$cwd_a" "claude:@0.%0" session_S interactive 0 "$sup_pid" "$sup_start"
rec 402 $X "$cwd_b" "claude:@0.%0" session_X interactive 1 "$dead_pid" 7002
rec 403 $Y "$cwd_c" "claude:@3.%3" session_Y interactive 1 "$dead_pid" 7003
transcript $S "$cwd_a" default high m
transcript $X "$cwd_b" default high m
transcript $Y "$cwd_c" default high m
"$HELPER" plan 2>/dev/null
: > "$TMUX_LOG"
"$HELPER" restore 2>"$tmp/err" || fail "restore failed: $(cat "$tmp/err")"
grep -q -- "--resume $X" "$TMUX_LOG" || fail "a server-spawned session in the supervisor's pane was not restored: $(cat "$TMUX_LOG")"
grep -q -- "--resume $Y" "$TMUX_LOG" || fail "a session in another window of tmux session claude was not restored: $(cat "$TMUX_LOG")"
TMUX_PANE_PID=$pane_pid "$HELPER" snapshot 2>/dev/null
[ "$(cd "$tmp/state/remote-sessions/supervisor" && printf '%s ' *)" = "$E $S " ] || fail "snapshot: supervisor sessions are '$(ls "$tmp/state/remote-sessions/supervisor")', want $E and $S"
kill "$sup_pid"
wait "$pane_pid" 2>/dev/null || :
rm -f "$tmp/mark"/*
[ -z "$("$HELPER" pending 2>/dev/null)" ] || fail "the supervisor's own session is a restore candidate: $("$HELPER" pending 2>/dev/null)"
rm -f "$tmp/state/remote-sessions/supervisor/$S"
"$HELPER" pending 2>/dev/null | grep -q "$S" || fail "S is not a candidate once it is not the supervisor's: the exclusion above proves nothing"

# --- first start of the image: no supervisor session known yet -------------------------------------
# Session mode adopts the stale records in tmux session claude as the supervisor's (the last
# boot's main session); server mode restores them (its spawned sessions).
rm -rf "$tmp/state/remote-sessions" "$tmp/mark"/*
rm -f "$tmp/cfg/sessions/"*.json
M=f4444444-7777-4777-8777-777777777777
rec 501 $M "$cwd_a" "claude:@0.%0" session_M interactive 1 "$dead_pid" 8001
rec 502 $B "$cwd_b" "dev:@2.%2" session_B interactive 1 "$dead_pid" 8002
transcript $M "$cwd_a" default high m
"$HELPER" plan 2>/dev/null
got=$(ids < "$tmp/state/remote-sessions/pending.json")
[ "$got" = "$B " ] || fail "first start, session mode: pending '$got', want only $B"
[ "$(ls "$tmp/state/remote-sessions/supervisor")" = "$M" ] || fail "first start: the main session was not adopted as the supervisor's"
rm -rf "$tmp/state/remote-sessions" "$tmp/mark"/*
DEV_REMOTE_CONTROL_MODE=server "$HELPER" plan 2>/dev/null
got=$(ids < "$tmp/state/remote-sessions/pending.json")
[ "$got" = "$B $M " ] || fail "first start, server mode: pending '$got', want $B and $M"

# --- the supervisor's tmux session is matched exactly, never by name prefix --------------------------
# Real tmux on a private socket: a session whose name starts with "claude" is not the supervisor's.
sock="dev-remote-sessions-test-$$"
real_path=${PATH#"$tmp/bin:"}
trap 'PATH=$real_path tmux -L "$sock" kill-server 2>/dev/null || :; for p in $pids; do kill "$p" 2>/dev/null || :; done; rm -rf "$tmp"' EXIT
rm -rf "$tmp/state/remote-sessions" "$tmp/mark"/*
rm -f "$tmp/cfg/sessions/"*.json
# start_pane <session> <sid> <file>: a pane whose child is a live "Claude" with a session record
start_pane() {
  local pane child
  PATH=$real_path tmux -L "$sock" new-session -d -s "$1" "bash -c 'sleep 600; :'"
  pane=$(PATH=$real_path tmux -L "$sock" display-message -p -t "=$1:^" '#{pane_pid}')
  child=""
  for _ in $(seq 25); do child=$(pgrep -P "$pane") && break; sleep 0.2; done
  [ -n "$child" ] || fail "no process in tmux session $1"
  rec "$3" "$2" "$cwd_a" "$1:@0.%0" "session_$3" interactive 0 "$child" "$(sed 's/.*) //' "/proc/$child/stat" | cut -d' ' -f20)"
}
P=f5555555-8888-4888-8888-888888888888 Q=f6666666-9999-4999-8999-999999999999
start_pane claude-other $P 601
PATH=$real_path DEV_REMOTE_SESSIONS_SOCKET=$sock "$HELPER" plan 2>/dev/null
PATH=$real_path DEV_REMOTE_SESSIONS_SOCKET=$sock "$HELPER" restore 2>/dev/null
PATH=$real_path DEV_REMOTE_SESSIONS_SOCKET=$sock "$HELPER" snapshot 2>/dev/null
[ ! -e "$tmp/state/remote-sessions/supervisor/$P" ] || fail "a session in tmux session claude-other was taken for the supervisor's"
start_pane claude $Q 602
PATH=$real_path DEV_REMOTE_SESSIONS_SOCKET=$sock "$HELPER" snapshot 2>/dev/null
[ "$(ls "$tmp/state/remote-sessions/supervisor")" = "$Q" ] || fail "the supervisor's session in tmux session claude was not recorded: $(ls "$tmp/state/remote-sessions/supervisor")"

echo "dev-remote-sessions: ok"
