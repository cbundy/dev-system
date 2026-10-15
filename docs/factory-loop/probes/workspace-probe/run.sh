#!/bin/sh
# run.sh <out dir> [case ...]: the workspace probe (README.md). Each case is one headless session,
# all of them at once, with only the probe's plugins loaded (no user or project settings, so no
# other plugin and no settings hook), each in its own folder under <out dir>. Cases: control,
# envset-start, envset-timer and gate (the spawner and the helper), and companion (the stand-in
# loop and the real plugins/factory-loop-workspace). The default is all five. About eight minutes.
set -u
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: run.sh <out dir> [case ...]}
shift
[ $# -gt 0 ] || set -- control envset-start envset-timer gate companion
companion=$(cd "$here/../../../../plugins/factory-loop-workspace" && pwd)
for probe in "$@"; do
  run=$out/$probe
  rm -rf "$run"
  if [ "$probe" = companion ]; then
    mkdir -p "$run"
    first=$here/loop second=$companion
  else
    mkdir -p "$run/slot"
    first=$here/spawner second=$here/helper
  fi
  (
    cd "$run" || exit 1
    # shellcheck disable=SC2016 # the backquotes are for the model, not the shell
    env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_PID \
      -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_BRIDGE_SESSION_ID -u CLAUDE_CODE_SESSION_ATTENDED \
      -u CLAUDE_CODE_ENTRYPOINT -u AI_AGENT -u CLAUDE_EFFORT -u BASH_DEFAULT_TIMEOUT_MS -u BASH_MAX_TIMEOUT_MS \
      PROBE_RUN="$run" PROBE_CASE="$probe" \
      timeout 560 claude -p 'Run exactly one Bash command: `sleep 420`, with the timeout parameter 600000. When it returns, reply: done.' \
        --plugin-dir "$first" --plugin-dir "$second" --setting-sources project --model haiku --dangerously-skip-permissions \
        --debug-file "$run/debug.log" --output-format stream-json --verbose >"$run/session.jsonl" 2>"$run/session.err"
    echo "exit $?" >"$run/exit.txt"
  ) &
done
wait
for probe in "$@"; do echo "$probe: $(cat "$out/$probe/exit.txt")"; done
