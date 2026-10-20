#!/bin/sh
# run.sh <out dir> [case ...]: the workspace probe (README.md). Each case is one headless session,
# all of them at once, with only the probe's plugins loaded (no user or project settings, so no
# other plugin and no settings hook), each in its own folder under <out dir>. Cases: control,
# envset-start, envset-timer and gate (the spawner and the helper), and companion (the stand-in
# loop and the real plugins/factory-loop-workspace). The default is all five. About eight minutes.
# gate-queue and gate-queue-bare are not in the default: each runs 540 s of waiting and a 300 s command
# inside one stop hook (the queued stop gate of v2 SPEC 10.6), so the session lives about 15 minutes and
# its bound is 1700 s. gate-queue is the stand-in loop with two writers and the companion (the second
# gate waits for the first); gate-queue-bare is the spawner and the helper, whose bare handler waits
# and runs the same. PROBE_COMPANION names another copy of the companion plugin (to probe an older one).
# Run them alone: run.sh <out dir> gate-queue
set -u
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: run.sh <out dir> [case ...]}
shift
[ $# -gt 0 ] || set -- control envset-start envset-timer gate companion
companion=${PROBE_COMPANION:-$(cd "$here/../../../../plugins/factory-loop-workspace" && pwd)}
for probe in "$@"; do
  run=$out/$probe
  rm -rf "$run"
  if [ "$probe" = companion ] || [ "$probe" = gate-queue ]; then
    mkdir -p "$run"
    first=$here/loop second=$companion
  else
    mkdir -p "$run/slot"
    first=$here/spawner second=$here/helper
  fi
  # shellcheck disable=SC2016 # the backquotes are for the model, not the shell
  limit=560 ask='Run exactly one Bash command: `sleep 420`, with the timeout parameter 600000. When it returns, reply: done.'
  if [ "$probe" = gate-queue ] || [ "$probe" = gate-queue-bare ]; then
    # shellcheck disable=SC2016 # the backquotes are for the model, not the shell
    # the session must outlive the second gate (about 540 s of waiting and 300 s of running): two commands
    # of 450 s each. A standalone `sleep` of the full time is refused by the session's Bash check, a command
    # that prints the time round it is not
    limit=1700 ask='Run exactly two Bash commands, one after the other, each with the timeout parameter 600000. First: `date -u +%T; sleep 450; date -u +%T`. Second: `date -u +%T; sleep 450; date -u +%T`. When both returned, reply: done.'
  fi
  (
    cd "$run" || exit 1
    env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_PID \
      -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_BRIDGE_SESSION_ID -u CLAUDE_CODE_SESSION_ATTENDED \
      -u CLAUDE_CODE_ENTRYPOINT -u AI_AGENT -u CLAUDE_EFFORT -u BASH_DEFAULT_TIMEOUT_MS -u BASH_MAX_TIMEOUT_MS \
      PROBE_RUN="$run" PROBE_CASE="$probe" \
      timeout "$limit" claude -p "$ask" \
        --plugin-dir "$first" --plugin-dir "$second" --setting-sources project --model haiku --dangerously-skip-permissions \
        --debug-file "$run/debug.log" --output-format stream-json --verbose >"$run/session.jsonl" 2>"$run/session.err"
    echo "exit $?" >"$run/exit.txt"
  ) &
done
wait
for probe in "$@"; do echo "$probe: $(cat "$out/$probe/exit.txt")"; done
