# shellcheck shell=bash
# shellcheck disable=SC2016,SC2154
#
# Section 8 of the base image container tests. Sourced by test.sh after lib.sh, which
# provides IMAGE, RUN_ID, SECRET, check, in_image and the rest; never run directly.

echo "== 8. entrypoint and Remote Control"

# (run_bg, wait_until, logs_have, stops_within and the STUB* claude, codex and gh stubs live in lib.sh: later sections use them too.)

check "ENTRYPOINT is tini + dev-entrypoint and CMD is dev-remote-control" bash -c "
  [ \"\$(docker image inspect -f '{{json .Config.Entrypoint}} {{json .Config.Cmd}}' '$IMAGE')\" = \
    '[\"/usr/bin/tini\",\"--\",\"/usr/local/bin/dev-entrypoint\"] [\"dev-remote-control\"]' ]"

check "a command runs after dev-init, in its own directory, with its exit status and clean stdout" bash -c "
  out=\$(docker run --rm -w /tmp '$IMAGE' bash -c 'test -f /persist/codex/config.toml && pwd && exit 7' 2>/dev/null)
  rc=\$?
  echo \"rc=\$rc stdout=\$out\"
  [ \$rc = 7 ] && [ \"\$out\" = /tmp ]"

check "as root the entrypoint skips dev-init, leaving nothing root-owned in /persist" bash -c "
  out=\$(docker run --rm --user root '$IMAGE' find /persist -mindepth 1 -user root 2>&1)
  echo \"\$out\"
  echo \"\$out\" | grep -q 'dev-init skipped' && ! echo \"\$out\" | grep -q '^/persist'"

# No login, no command: waits for a login without starting Claude. A 1s poll
# shows the reminder rate limit (one hint per 10 polls) in a few seconds.
# Tests on the real CLIs log in only Claude (DEV_LOGIN_TOOLS=claude), whose
# login prints a link without contacting anyone; real codex and gh logins
# would request device codes.
c=$(run_bg -e DEV_REMOTE_CONTROL_POLL=1 -e DEV_LOGIN_TOOLS=claude "$IMAGE")
check "no login, no command: logs the real Claude sign-in link and the docker exec dev-login hint" bash -c "
  for _ in \$(seq 60); do docker logs '$c' 2>&1 | grep -q 'dev-login: claude: open' && break; sleep 1; done
  docker logs '$c' 2>&1 | grep 'dev-'
  docker logs '$c' 2>&1 | grep -q 'Claude is not logged in - open the sign-in link dev-login logs (or the login page), then paste the code: docker exec -it ${c:0:12} dev-login <code>' &&
  docker logs '$c' 2>&1 | grep -qE 'dev-login: claude: open https://claude.com/cai/oauth/authorize\\?\\S*code=true'"
check "no login: repeats the hint every 10 polls, not every poll" bash -c "
  for _ in \$(seq 40); do
    [ \"\$(docker logs '$c' 2>&1 | grep -c 'Claude is not logged in')\" -ge 2 ] && break
    sleep 1
  done
  docker logs '$c' 2>&1 | grep 'dev-remote-control'
  [ \"\$(docker logs '$c' 2>&1 | grep -c 'Claude is not logged in')\" = 2 ]"
check "no login: the container stays up without crash-looping or starting Claude" bash -c "
  [ \"\$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' '$c')\" = 'true 0' ] &&
  docker exec '$c' bash -c '! tmux has-session -t claude 2>/dev/null'"
check "no login: docker stop completes in under 10s with exit 0, with the login pending" stops_within "$c" 10

c=$(run_bg -e ANTHROPIC_API_KEY=sk-ant-test-not-a-real-key -e DEV_LOGIN_TOOLS=claude "$IMAGE")
check "an API-key-only login gets the claude.ai subscription message" \
  wait_until 30 logs_have "$c" "logged in with api_key, but Remote Control needs a claude.ai subscription login"
check "an API-key login: dev-login leaves it alone (no Claude login started)" bash -c "
  docker exec '$c' dev-login status
  docker exec '$c' dev-login status | grep -qx 'claude: other' && ! docker exec '$c' tmux has-session -t login-claude"
docker rm -f "$c" >/dev/null

c=$(run_bg -e DEV_REMOTE_CONTROL=0 "$IMAGE")
check "DEV_REMOTE_CONTROL=0: logs that Claude is not started" \
  wait_until 30 logs_have "$c" "DEV_REMOTE_CONTROL=0: not starting Claude"
check "DEV_REMOTE_CONTROL=0: the container stays up for exec, without Claude or tmux" bash -c "
  sleep 2
  [ \"\$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' '$c')\" = 'true 0' ] &&
  docker exec '$c' bash -c '! pgrep -ax claude && ! tmux has-session -t claude 2>/dev/null'"
check "DEV_REMOTE_CONTROL=0: docker stop completes in under 10s with exit 0" stops_within "$c" 10

# The supervisor against the stub: wait for login, start, restart with backoff.
c=$(run_bg -w /tmp -e STUB="$STUB" -e DEV_REMOTE_CONTROL_POLL=1 -e DEV_REMOTE_CONTROL_NAME=rc-test \
  "$IMAGE" bash -c "$WITH_STUB exec dev-remote-control")
check "stub: waits for a login without starting Claude" bash -c "
  for _ in \$(seq 30); do docker logs '$c' 2>&1 | grep -q 'Claude is not logged in' && break; sleep 1; done
  sleep 2
  docker logs '$c' 2>&1 | grep -q 'Claude is not logged in' && ! docker exec '$c' test -e /tmp/claude-starts"
docker exec "$c" touch /tmp/logged-in
check "stub: starts Claude as soon as a login appears, in the workspace, with --remote-control <name>" bash -c "
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts
  [ \"\$(docker exec '$c' cat /tmp/claude-starts)\" = '/tmp --remote-control rc-test' ] &&
  docker logs '$c' 2>&1 | grep -q 'Claude login found' &&
  [ \"\$(docker inspect -f '{{.RestartCount}}' '$c')\" = 0 ]"
check "stub: Claude runs in the tmux session 'claude'" docker exec "$c" tmux has-session -t claude
check "stub: the workspace is marked trusted in .claude.json" docker exec "$c" \
  jq -e '.projects["/tmp"].hasTrustDialogAccepted == true and .hasCompletedOnboarding == true' /persist/claude/.claude.json
docker exec "$c" touch /tmp/claude-exit
check "stub: restarts Claude after it exits, with a growing backoff" bash -c "
  for _ in \$(seq 30); do docker logs '$c' 2>&1 | grep -q 'restarting in 10s' && break; sleep 1; done
  docker logs '$c' 2>&1 | grep 'dev-remote-control'
  docker logs '$c' 2>&1 | grep -q 'Claude exited (status 3) after .* - restarting in 5s' &&
  docker logs '$c' 2>&1 | grep -q 'restarting in 10s' &&
  [ \"\$(docker exec '$c' grep -c . /tmp/claude-starts)\" = 2 ]"
check "stub: docker stop completes in under 10s with exit 0" stops_within "$c" 10

c=$(run_bg -e STUB="$STUB" -e DEV_REMOTE_CONTROL_SKIP_PERMISSIONS=1 \
  "$IMAGE" bash -c "touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
check "DEV_REMOTE_CONTROL_SKIP_PERMISSIONS=1 adds --dangerously-skip-permissions without the consent dialog" bash -c "
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts
  docker exec '$c' grep -qF -- '--remote-control ${c:0:12} --dangerously-skip-permissions --settings {\"skipDangerousModePermissionPrompt\":true}' /tmp/claude-starts"
docker rm -f "$c" >/dev/null

# Resume (#164): the stub's workspace is /tmp, so Claude's project directory
# is /persist/claude/projects/-tmp. A real conversation's transcript holds a
# user message; a start nobody wrote to holds only Remote Control bookkeeping.
STUB_LINES='{"type":"mode","mode":"normal","sessionId":"SID"}
{"type":"permission-mode","permissionMode":"default","sessionId":"SID"}
{"type":"bridge-session","sessionId":"SID","bridgeSessionId":"cse_test","lastSequenceNum":0}
{"parentUuid":null,"type":"system","subtype":"bridge_status","content":"/remote-control is active","sessionId":"SID"}'
REAL_LINE='{"parentUuid":null,"type":"user","message":{"role":"user","content":"hello"},"sessionId":"SID"}'
# transcript <id> <stub|real> [touch -d date]: a script that writes one
transcript() {
  local lines="${STUB_LINES//SID/$1}"
  [ "$2" = stub ] || lines="$lines
${REAL_LINE//SID/$1}"
  printf "mkdir -p /persist/claude/projects/-tmp && printf '%%s\\\\n' '%s' > /persist/claude/projects/-tmp/%s.jsonl%s" \
    "$lines" "$1" "${3:+ && touch -d '$3' /persist/claude/projects/-tmp/$1.jsonl}"
}
RESUME_ENV=(-e DEV_REMOTE_CONTROL_RESUME=1 -e DEV_REMOTE_CONTROL_NAME=rc-test
  -e "DEV_REMOTE_CONTROL_PROMPT=/callum-flow:issue-orchestrator"
  -e "DEV_REMOTE_CONTROL_RESUME_PROMPT=The workspace restarted: carry on.")

c=$(run_bg -w /tmp -e STUB="$STUB" "${RESUME_ENV[@]}" \
  "$IMAGE" bash -c "touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
check "resume, nothing to resume: a fresh start with the startup prompt and no --resume" bash -c "
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-argv-1
  [ \"\$(docker exec '$c' cat /tmp/claude-argv-1)\" = \"\$(printf '%s\n' --remote-control rc-test /callum-flow:issue-orchestrator)\" ] &&
  docker logs '$c' 2>&1 | grep -q 'dev-remote-control: starting a fresh conversation'"
# The first conversation gets a user message, then Claude exits: the restart
# resumes it with the resume prompt instead of re-sending the startup prompt.
docker exec "$c" bash -c "$(transcript 11111111-aaaa-4aaa-8aaa-111111111111 real)"
docker exec "$c" touch /tmp/claude-exit
check "resume: after Claude exits, the restart resumes that conversation with the resume prompt" bash -c "
  for _ in \$(seq 20); do docker exec '$c' test -s /tmp/claude-argv-2 && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts
  [ \"\$(docker exec '$c' sed -n 2p /tmp/claude-starts)\" = '/tmp --remote-control rc-test --resume 11111111-aaaa-4aaa-8aaa-111111111111 The workspace restarted: carry on.' ] &&
  [ \"\$(docker exec '$c' cat /tmp/claude-argv-2)\" = \"\$(printf '%s\n' --remote-control rc-test --resume 11111111-aaaa-4aaa-8aaa-111111111111 'The workspace restarted: carry on.')\" ] &&
  docker logs '$c' 2>&1 | grep -q 'dev-remote-control: resuming the last conversation (11111111-aaaa-4aaa-8aaa-111111111111) in /persist/claude/projects/-tmp'"
docker rm -f "$c" >/dev/null

# A real conversation with a newer empty start beside it (which --continue
# would pick): the real one is resumed on the very first start.
c=$(run_bg -w /tmp -e STUB="$STUB" "${RESUME_ENV[@]}" "$IMAGE" bash -c "
  $(transcript 22222222-bbbb-4bbb-8bbb-222222222222 real '1 hour ago') &&
  $(transcript 33333333-cccc-4ccc-8ccc-333333333333 stub) &&
  touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
check "resume: an existing conversation is resumed with the resume prompt, skipping a newer empty start" bash -c "
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-argv-1
  [ \"\$(docker exec '$c' cat /tmp/claude-argv-1)\" = \"\$(printf '%s\n' --remote-control rc-test --resume 22222222-bbbb-4bbb-8bbb-222222222222 'The workspace restarted: carry on.')\" ]"
docker rm -f "$c" >/dev/null

# dev-restart-self --fresh leaves a one-shot marker (cbundy/dev-system#268): an
# existing conversation is not resumed on that start, the marker is deleted, and
# the next start resumes as usual.
c=$(run_bg -w /tmp -e STUB="$STUB" "${RESUME_ENV[@]}" "$IMAGE" bash -c "
  $(transcript 66666666-ffff-4fff-8fff-666666666666 real) &&
  mkdir -p /persist/dev-restart-self && touch /persist/dev-restart-self/fresh-conversation &&
  touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
check "fresh marker: the first start skips the resume and sends the startup prompt, then deletes the marker" bash -c "
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-argv-1
  [ \"\$(docker exec '$c' cat /tmp/claude-argv-1)\" = \"\$(printf '%s\n' --remote-control rc-test /callum-flow:issue-orchestrator)\" ] &&
  ! docker exec '$c' test -e /persist/dev-restart-self/fresh-conversation &&
  docker logs '$c' 2>&1 | grep -q 'dev-remote-control: fresh conversation requested by dev-restart-self --fresh'"
docker exec "$c" touch /tmp/claude-exit
check "fresh marker: the next start resumes the conversation again" bash -c "
  for _ in \$(seq 20); do docker exec '$c' test -s /tmp/claude-argv-2 && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts
  [ \"\$(docker exec '$c' cat /tmp/claude-argv-2)\" = \"\$(printf '%s\n' --remote-control rc-test --resume 66666666-ffff-4fff-8fff-666666666666 'The workspace restarted: carry on.')\" ]"
docker rm -f "$c" >/dev/null

c=$(run_bg -w /tmp -e STUB="$STUB" "${RESUME_ENV[@]}" "$IMAGE" bash -c "
  $(transcript 44444444-dddd-4ddd-8ddd-444444444444 stub) &&
  touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
check "resume: a transcript without a user message still counts as fresh" bash -c "
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts
  [ \"\$(docker exec '$c' cat /tmp/claude-starts)\" = '/tmp --remote-control rc-test /callum-flow:issue-orchestrator' ]"
docker rm -f "$c" >/dev/null

c=$(run_bg -w /tmp -e STUB="$STUB" -e "DEV_REMOTE_CONTROL_NAME_FORMAT=🔄 {name} & orchestrator" \
  "$IMAGE" bash -c "touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
check "DEV_REMOTE_CONTROL_NAME_FORMAT: an emoji name with spaces and & reaches Claude as one argument" bash -c "
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-argv-1
  [ \"\$(docker exec '$c' cat /tmp/claude-argv-1)\" = \"\$(printf '%s\n' --remote-control '🔄 ${c:0:12} & orchestrator')\" ] &&
  docker logs '$c' 2>&1 | grep -qF 'as \"🔄 ${c:0:12} & orchestrator\"'"
docker rm -f "$c" >/dev/null

c=$(run_bg -w /tmp -e STUB="$STUB" -e DEV_REMOTE_CONTROL_MODE=server "${RESUME_ENV[@]}" \
  -e "DEV_REMOTE_CONTROL_NAME_FORMAT=🔄 {name}" "$IMAGE" bash -c "
  $(transcript 55555555-eeee-4eee-8eee-555555555555 real) &&
  touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
check "server mode ignores resume, both prompts and the name format, logging each" bash -c "
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts
  docker logs '$c' 2>&1 | grep 'ignored in server mode'
  [ \"\$(docker exec '$c' cat /tmp/claude-starts)\" = '/tmp remote-control --name rc-test --spawn same-dir' ] &&
  for v in RESUME PROMPT RESUME_PROMPT NAME_FORMAT; do
    docker logs '$c' 2>&1 | grep -qx \"dev-remote-control: DEV_REMOTE_CONTROL_\$v is ignored in server mode (session mode only)\" || exit 1
  done"
docker rm -f "$c" >/dev/null

# The default name is the workspace's repo name: from the origin URL (the
# checkout directory is named differently on purpose), else the git top-level
# directory. The SKIP_PERMISSIONS check above covers the hostname fallback.
c=$(run_bg -e STUB="$STUB" -e DEV_WORKSPACE=/tmp/ws/checkout "$IMAGE" bash -c "
  git init -q /tmp/ws/checkout && git -C /tmp/ws/checkout remote add origin git@github.com:example/my-repo.git &&
  touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
check "the session name defaults to the repo name from the workspace's origin URL" bash -c "
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts
  [ \"\$(docker exec '$c' cat /tmp/claude-starts)\" = '/tmp/ws/checkout --remote-control my-repo' ]"
docker rm -f "$c" >/dev/null

c=$(run_bg -e STUB="$STUB" -e DEV_WORKSPACE=/tmp/ws/no-origin "$IMAGE" bash -c "
  git init -q /tmp/ws/no-origin && touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
check "without an origin, the session name is the git top-level directory name" bash -c "
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts
  [ \"\$(docker exec '$c' cat /tmp/claude-starts)\" = '/tmp/ws/no-origin --remote-control no-origin' ]"
docker rm -f "$c" >/dev/null

c=$(run_bg -e STUB="$STUB" -e DEV_REMOTE_CONTROL_MODE=server -e DEV_REMOTE_CONTROL_SKIP_PERMISSIONS=1 \
  -e DEV_WORKSPACE=/tmp/ws/checkout "$IMAGE" bash -c "
  git init -q /tmp/ws/checkout && git -C /tmp/ws/checkout remote add origin https://github.com/example/my-repo.git &&
  touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
check "DEV_REMOTE_CONTROL_MODE=server runs claude remote-control, a worktree per session, in a git workspace" bash -c "
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts
  docker exec '$c' grep -qxF -- '/tmp/ws/checkout remote-control --name my-repo --spawn worktree --permission-mode bypassPermissions' /tmp/claude-starts &&
  docker logs '$c' 2>&1 | grep -q '(server mode) as \"my-repo\"'"
check "server mode with SKIP_PERMISSIONS=1 accepts the bypass disclaimer and trusts the workspace" docker exec "$c" \
  jq -e '.bypassPermissionsModeAccepted == true and .projects["/tmp/ws/checkout"].hasTrustDialogAccepted == true' /persist/claude/.claude.json
check "server mode: docker stop completes in under 10s with exit 0" stops_within "$c" 10

c=$(run_bg -w /tmp -e STUB="$STUB" -e DEV_REMOTE_CONTROL_MODE=server -e DEV_REMOTE_CONTROL_NAME=rc-server \
  "$IMAGE" bash -c "touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
check "server mode outside a git repo falls back to --spawn same-dir with a warning" bash -c "
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts
  [ \"\$(docker exec '$c' cat /tmp/claude-starts)\" = '/tmp remote-control --name rc-server --spawn same-dir' ] &&
  docker logs '$c' 2>&1 | grep -q 'not a git repository - sessions share it'"
check "server mode without SKIP_PERMISSIONS leaves the bypass disclaimer alone" docker exec "$c" \
  jq -e '.bypassPermissionsModeAccepted == null' /persist/claude/.claude.json
docker rm -f "$c" >/dev/null

c=$(run_bg -e DEV_REMOTE_CONTROL_MODE=bogus "$IMAGE")
check "an unknown DEV_REMOTE_CONTROL_MODE is rejected: logged, exit status 2" bash -c "
  for _ in \$(seq 30); do [ \"\$(docker inspect -f '{{.State.Running}}' '$c')\" = false ] && break; sleep 1; done
  docker logs '$c' 2>&1 | grep 'dev-remote-control'
  docker logs '$c' 2>&1 | grep -q 'DEV_REMOTE_CONTROL_MODE must be session or server, not \"bogus\"' &&
  [ \"\$(docker inspect -f '{{.State.ExitCode}}' '$c')\" = 2 ]"
docker rm -f "$c" >/dev/null

# Remote Control consent (#88): with a config that is logged in but has never
# answered the one-time "Enable Remote Control?" prompt, the supervisor
# pre-answers it in both modes, so the stub starts without prompting, and
# keeps the config's other values.
for mode in session server; do
  seen=; [ "$mode" = server ] && seen=',"fullscreenUpsellSeenCount":7'
  want=3; [ "$mode" = server ] && want=7
  c=$(run_bg -w /tmp -e STUB="$STUB" -e DEV_REMOTE_CONTROL_MODE=$mode "$IMAGE" bash -c "
    echo '{\"userID\":\"keep-me\",\"hasCompletedOnboarding\":true$seen}' > /persist/claude/.claude.json &&
    touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
  check "$mode mode: Remote Control consent is pre-answered, so Claude starts unattended" bash -c "
    for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
    docker exec '$c' cat /tmp/claude-starts
    docker exec '$c' test -s /tmp/claude-starts && ! docker exec '$c' test -e /tmp/claude-consent-prompt &&
    docker exec '$c' jq -e '.remoteDialogSeen == true and .userID == \"keep-me\" and .fullscreenUpsellSeenCount == $want' /persist/claude/.claude.json"
  docker rm -f "$c" >/dev/null
done

# The real Claude, with only `auth status` faked: it must reach its prompt in
# the tmux session without stopping at the trust or onboarding dialogs, and
# stop promptly. Remote Control itself needs a real claude.ai login, so it
# does not connect here.
REAL='#!/bin/bash
[ "$1" = auth ] && { echo "{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}"; exit 0; }
exec /home/node/.local/bin/claude "$@"'
c=$(run_bg -w /tmp -e STUB="$REAL" -e CLAUDE_CODE_OAUTH_TOKEN=not-a-real-token \
  "$IMAGE" bash -c "$WITH_STUB exec dev-remote-control")
check "real Claude starts in tmux past the trust and onboarding dialogs" bash -c "
  for _ in \$(seq 60); do
    docker exec '$c' tmux capture-pane -p -t claude 2>/dev/null | grep -q 'for shortcuts' && break
    sleep 1
  done
  pane=\$(docker exec '$c' tmux capture-pane -p -t claude 2>&1)
  echo \"\$pane\"
  echo \"\$pane\" | grep -q 'for shortcuts' && ! echo \"\$pane\" | grep -qiE 'trust this folder|text style'"
check "real Claude: docker stop completes in under 10s with exit 0" stops_within "$c" 10
