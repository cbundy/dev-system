# shellcheck shell=bash
# shellcheck disable=SC2016,SC2154
#
# Section 11 of the base image container tests. Sourced by test.sh after lib.sh, which
# provides IMAGE, RUN_ID, SECRET, check, in_image and the rest; never run directly.

echo "== 11. first-run logins (dev-login)"

# in_c <container> <script>: runs a script in the container with the stubs
# first on PATH, as the supervisor sees them
in_c() {
  docker exec "$1" bash -c "PATH=/tmp/stub:\$PATH; $2"
}

# The supervisor with all three logins missing, against the stub CLIs.
c=$(run_bg -e STUB="$STUB" -e STUB_CODEX="$STUB_CODEX" -e STUB_GH="$STUB_GH" \
  -e DEV_REMOTE_CONTROL_POLL=1 -e DEV_REMOTE_CONTROL_NAME=login-test \
  "$IMAGE" bash -c "$WITH_STUB exec dev-remote-control")
check "the supervisor logs each tool's sign-in link and the paste hint" bash -c "
  for _ in \$(seq 30); do docker logs '$c' 2>&1 | grep -q 'dev-login: gh: open' && break; sleep 1; done
  docker logs '$c' 2>&1 | grep 'dev-'
  docker logs '$c' 2>&1 | grep -qF 'dev-login: claude: open https://claude.com/cai/oauth/authorize?code=true&state=attempt1 and approve, then paste the code it shows into the login page or run: docker exec -it ${c:0:12} dev-login <code>' &&
  docker logs '$c' 2>&1 | grep -qF 'dev-login: codex: open https://auth.openai.com/codex/device and enter the code CDX1-ABCDE' &&
  docker logs '$c' 2>&1 | grep -qF 'dev-login: gh: open https://github.com/login/device and enter the code GH12-3456' &&
  docker logs '$c' 2>&1 | grep -q 'Claude is not logged in - open the sign-in link dev-login logs'"
check "dev-login status lists each tool's state and the pending links" in_c "$c" '
  out=$(dev-login status 2>&1); rc=$?; echo "$out"
  [ $rc = 0 ] && ! echo "$out" | grep -q "dev-login: .*line" &&
  echo "$out" | grep -qx "claude: out" && echo "$out" | grep -qx "codex: out" && echo "$out" | grep -qx "gh: out" &&
  echo "$out" | grep -qF "codex: open https://auth.openai.com/codex/device and enter the code CDX1-ABCDE" &&
  dev-login status --json | jq -e ".codex == {state: \"out\", url: \"https://auth.openai.com/codex/device\", code: \"CDX1-ABCDE\"}"'
check "dev-login start is idempotent: the attempts in progress keep their links" in_c "$c" '
  dev-login start >/dev/null; dev-login start | grep -q "state=attempt1 " && [ "$(cat /tmp/claude-logins)" = 1 ] &&
  [ "$(cat /tmp/codex-logins)" = 1 ]'
check "a wrong code fails fast with a clear message and ends that attempt" in_c "$c" '
  start=$(date +%s); out=$(dev-login wrong-code 2>&1); rc=$?; echo "$out"
  [ $rc = 1 ] && [ $(( $(date +%s) - start )) -lt 10 ] &&
  echo "$out" | grep -q "Claude rejected the code" && ! tmux has-session -t login-claude'
check "a control character in a code is refused before it reaches the login" in_c "$c" '
  out=$(dev-login "$(printf "x\ny")" 2>&1); rc=$?; echo "$out"; [ $rc = 2 ] && echo "$out" | grep -q "not a sign-in code"'
check "the next start offers a fresh Claude link" in_c "$c" '
  dev-login start | grep -q "state=attempt2 "'
check "an expired codex code is replaced by a fresh one" in_c "$c" '
  touch /tmp/codex-expire
  for _ in $(seq 20); do tmux has-session -t login-codex 2>/dev/null || break; sleep 0.5; done
  dev-login start | grep -q "enter the code CDX2-ABCDE"'
check "the right code logs Claude in and the supervisor starts Remote Control" bash -c "
  docker exec '$c' bash -c 'PATH=/tmp/stub:\$PATH dev-login good-code-2' || exit 1
  for _ in \$(seq 15); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts && docker logs '$c' 2>&1 | grep -q 'Claude login found'"
docker exec "$c" touch /tmp/codex-approve /tmp/gh-approve
check "approving codex and gh completes them; gh wires git (setup-git)" in_c "$c" '
  for _ in $(seq 20); do dev-login status | grep -qx "gh: in" && dev-login status | grep -qx "codex: in" && break; sleep 0.5; done
  dev-login status; dev-login status | grep -qx "codex: in" && dev-login status | grep -qx "gh: in" && test -e /tmp/gh-setup-git'
check "gh's login asks for the workflow scope" in_c "$c" '
  cat /tmp/gh-login-args; grep -q -- "--scopes workflow" /tmp/gh-login-args && test -e /tmp/gh-workflow'
check "the watcher reports all logins done and exits" bash -c "
  for _ in \$(seq 40); do docker logs '$c' 2>&1 | grep -q 'dev-login: all logins are done' && break; sleep 1; done
  docker logs '$c' 2>&1 | grep -q 'dev-login: all logins are done' && ! docker exec '$c' pgrep -f 'dev-login watch'"
docker rm -f "$c" >/dev/null

c=$(run_bg -e STUB="$STUB" -e STUB_CODEX="$STUB_CODEX" -e STUB_GH="$STUB_GH" -e DEV_LOGIN_TOOLS=claude -e GH_TOKEN=x \
  "$IMAGE" bash -c "$WITH_STUB exec dev-remote-control")
check "DEV_LOGIN_TOOLS=claude starts only Claude's login, and dev-doctor does not fail the others" bash -c "
  for _ in \$(seq 30); do docker logs '$c' 2>&1 | grep -q 'dev-login: claude: open' && break; sleep 1; done
  docker logs '$c' 2>&1 | grep -q 'dev-login: claude: open' && ! docker logs '$c' 2>&1 | grep -qE 'dev-login: (codex|gh):' &&
  docker exec '$c' bash -c '! tmux has-session -t login-codex 2>/dev/null && ! tmux has-session -t login-gh 2>/dev/null' &&
  out=\$(docker exec '$c' bash -c 'PATH=/tmp/stub:\$PATH dev-doctor --warn-only') && echo \"\$out\" &&
  echo \"\$out\" | grep -q 'OK   codex is not logged in (not needed: not in DEV_LOGIN_TOOLS)' &&
  echo \"\$out\" | grep -q 'FAIL claude is not logged in' && echo \"\$out\" | grep -q 'fix: run: dev-login start (or: claude auth login)'"
docker rm -f "$c" >/dev/null

c=$(run_bg -e STUB="$STUB" -e STUB_CODEX="$STUB_CODEX" -e STUB_GH="$STUB_GH" -e GH_TOKEN=gho_not_a_real_token \
  "$IMAGE" bash -c "touch /tmp/logged-in /tmp/codex-in && $WITH_STUB exec dev-remote-control")
check "with GH_TOKEN set, no gh login starts and gh counts as done" in_c "$c" '
  sleep 3; dev-login status | grep -qx "gh: token" && ! tmux has-session -t login-gh 2>/dev/null'
docker rm -f "$c" >/dev/null

# gh logged in without the workflow scope (cbundy/dev-system#181): the
# watcher refreshes the token instead of leaving it as it is.
c=$(run_bg -e STUB="$STUB" -e STUB_CODEX="$STUB_CODEX" -e STUB_GH="$STUB_GH" \
  "$IMAGE" bash -c "touch /tmp/logged-in /tmp/codex-in /tmp/gh-in && $WITH_STUB exec dev-remote-control")
check "a gh login without the workflow scope: dev-login status says scope, dev-doctor warns" in_c "$c" '
  for _ in $(seq 40); do dev-login status --json | jq -e .gh.code >/dev/null && break; sleep 0.5; done
  out=$(dev-login status; dev-doctor --warn-only); echo "$out"
  echo "$out" | grep -qx "gh: scope" &&
  echo "$out" | grep -q "WARN gh.s token lacks the workflow scope" &&
  echo "$out" | grep -qF "gh auth refresh -h github.com -s workflow" &&
  dev-login status --json | jq -e ".gh == {state: \"scope\", url: \"https://github.com/login/device\", code: \"GH56-7890\"}"'
check "the watcher starts gh's refresh with the workflow scope, and logs its link" bash -c "
  for _ in \$(seq 30); do docker logs '$c' 2>&1 | grep -q 'dev-login: gh (workflow scope): open' && break; sleep 1; done
  docker logs '$c' 2>&1 | grep 'dev-login'
  docker logs '$c' 2>&1 | grep -qF 'dev-login: gh (workflow scope): open https://github.com/login/device and enter the code GH56-7890' &&
  docker exec '$c' grep -q -- '--hostname github.com --scopes workflow' /tmp/gh-refresh-args &&
  docker exec '$c' test ! -e /tmp/gh-login-args"
docker exec "$c" touch /tmp/gh-approve
check "approving the refresh makes the watcher finish" bash -c "
  for _ in \$(seq 40); do docker logs '$c' 2>&1 | grep -q 'dev-login: all logins are done' && break; sleep 1; done
  docker logs '$c' 2>&1 | grep -q 'dev-login: all logins are done'"
check "after the refresh, gh is in and dev-doctor reports the workflow scope" in_c "$c" '
  out=$(dev-login status; dev-doctor --warn-only); echo "$out"
  echo "$out" | grep -qx "gh: in" && echo "$out" | grep -q "OK   gh.s token has the workflow scope"'
docker rm -f "$c" >/dev/null

# The page: dev-init starts it (DEV_LOGIN_PORT), so the stubs go first on PATH
# before dev-init runs; tini stays PID 1.
# page_bg <docker run args...>: the supervisor, with dev-init run after the stubs
page_bg() {
  run_bg -e STUB="$STUB" -e STUB_CODEX="$STUB_CODEX" -e STUB_GH="$STUB_GH" "$@" \
    --entrypoint /usr/bin/tini "$IMAGE" -- bash -c "$WITH_STUB && dev-init 2>/dev/null; exec dev-remote-control"
}
# curl_c <container> <curl args...>: curl against the page from inside
curl_c() {
  local c="$1"
  shift
  docker exec "$c" curl -sS -m 30 "$@"
}
c=$(page_bg -e DEV_LOGIN_PORT=8765 -e DEV_LOGIN_TOOLS=claude,codex)
check "with DEV_LOGIN_PORT the page serves /healthz" bash -c "
  for _ in \$(seq 30); do docker exec '$c' curl -fsS -m 2 localhost:8765/healthz >/dev/null 2>&1 && break; sleep 1; done
  [ \"\$(docker exec '$c' curl -fsS localhost:8765/healthz)\" = ok ]"
check "the page shows Claude's sign-in link and codex's code" bash -c "
  html=\$(docker exec '$c' curl -fsS -m 60 localhost:8765/)
  echo \"\$html\" | grep -qF 'href=\"https://claude.com/cai/oauth/authorize?code=true&amp;state=attempt1\"' &&
  echo \"\$html\" | grep -q 'Open sign-in page' && echo \"\$html\" | grep -qF 'CDX1-ABCDE' &&
  ! echo \"\$html\" | grep -q 'GitHub CLI'"
check "the page refuses anything but a form POST of a code, and an oversized body" bash -c "
  [ \"\$(docker exec '$c' curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' localhost:8765/)\" = 415 ] &&
  [ \"\$(docker exec '$c' curl -s -o /dev/null -w '%{http_code}' -X POST -d 'nocode=1' localhost:8765/)\" = 400 ] &&
  [ \"\$(docker exec '$c' curl -s -o /dev/null -w '%{http_code}' localhost:8765/nope)\" = 404 ] &&
  big=\$(head -c 10000 /dev/zero | tr '\\\\0' a) &&
  ! [ \"\$(docker exec '$c' curl -s -o /dev/null -w '%{http_code}' -X POST --data-raw \"code=\$big\" localhost:8765/)\" = 303 ]"
check "a wrong code through the page shows why and offers a new link" bash -c "
  html=\$(docker exec '$c' curl -fsS -m 60 -d code=wrong localhost:8765/)
  echo \"\$html\" | grep -q 'That did not work' && echo \"\$html\" | grep -q 'Claude rejected the code' &&
  docker exec '$c' curl -fsS -m 60 localhost:8765/ | grep -qF 'state=attempt2'"
check "the right code through the page logs Claude in (303 back to the page)" bash -c "
  [ \"\$(docker exec '$c' curl -s -m 60 -o /dev/null -w '%{http_code}' -d code=good-code-2 localhost:8765/)\" = 303 ] &&
  docker exec '$c' curl -fsS localhost:8765/status | jq -e '.claude == \"in\" and .codex == \"out\" and .gh == \"off\"'"
docker exec "$c" touch /tmp/codex-approve
check "DEV_LOGIN_PAGE_EXIT=1 (default): the page exits once every login is done" bash -c "
  for _ in \$(seq 40); do docker exec '$c' curl -fsS -m 2 localhost:8765/healthz >/dev/null 2>&1 || break; sleep 1; done
  ! docker exec '$c' curl -fsS -m 2 localhost:8765/healthz && docker exec '$c' grep -q 'closing the login page' /tmp/dev-login-page.log"
check "the page: docker stop completes in under 10s with exit 0" stops_within "$c" 10

c=$(page_bg -e DEV_LOGIN_PORT=8765 -e DEV_LOGIN_PAGE_EXIT=0 -e DEV_LOGIN_TOOLS=claude)
check "DEV_LOGIN_PAGE_EXIT=0: the page stays up after the logins, showing them done" bash -c "
  for _ in \$(seq 30); do docker exec '$c' curl -fsS -m 2 localhost:8765/healthz >/dev/null 2>&1 && break; sleep 1; done
  docker exec '$c' curl -fsS -m 60 localhost:8765/ >/dev/null
  docker exec '$c' bash -c 'PATH=/tmp/stub:\$PATH dev-login good-code-1' && sleep 12 &&
  docker exec '$c' curl -fsS -m 2 localhost:8765/healthz >/dev/null &&
  docker exec '$c' curl -fsS -m 60 localhost:8765/ | grep -q 'logged in'"
docker rm -f "$c" >/dev/null

c=$(page_bg -e DEV_LOGIN_TOOLS=claude)
check "without DEV_LOGIN_PORT no page runs and nothing listens" in_c "$c" '
  sleep 3
  ! pgrep -fx "node /usr/local/share/dev-system/dev-login-page.js" && ! (exec 3<>/dev/tcp/127.0.0.1/8765) 2>/dev/null'
check "a page started anyway is detected (the check above is not vacuous)" in_c "$c" '
  (DEV_LOGIN_PORT=8765 DEV_LOGIN_PAGE_EXIT=0 dev-login serve >/dev/null 2>&1 &)
  for _ in $(seq 20); do (exec 3<>/dev/tcp/127.0.0.1/8765) 2>/dev/null && break; sleep 0.5; done
  pgrep -fx "node /usr/local/share/dev-system/dev-login-page.js" >/dev/null && (exec 3<>/dev/tcp/127.0.0.1/8765) 2>/dev/null'
docker rm -f "$c" >/dev/null

# A no-mistakes whose `daemon start` never returns (cbundy/dev-system#101):
# dev-init stops it at its own limit, says why with the fix, skips the
# recovery (init would only wait the same way) and still starts the page.
STUB_NM='#!/bin/bash
echo "$*" >> /tmp/nm-calls
[ "$*" = "daemon start" ] && exec sleep 1000
[ "$1" = status ] && echo "repo not initialized (run no-mistakes init first)"
exit 0'
c=$(run_bg -e STUB="$STUB" -e STUB_NM="$STUB_NM" -e DEV_LOGIN_PORT=8765 -e DEV_LOGIN_PAGE_EXIT=0 -e DEV_LOGIN_TOOLS=claude \
  --entrypoint /usr/bin/tini "$IMAGE" -- bash -c "$WITH_STUB && printf '%s\n' \"\$STUB_NM\" > /tmp/stub/no-mistakes &&
    chmod +x /tmp/stub/no-mistakes && git init -q /tmp/r && touch /tmp/r/.no-mistakes.yaml && cd /tmp/r &&
    start=\$(date +%s) && dev-init 2> /tmp/dev-init.log; echo \$((\$(date +%s) - start)) > /tmp/dev-init-took
    exec sleep infinity")
check "a no-mistakes daemon start that hangs: dev-init stops it at 30s, names the fix and still starts the page" bash -c "
  for _ in \$(seq 90); do docker exec '$c' test -s /tmp/dev-init-took && break; sleep 1; done
  docker exec '$c' cat /tmp/dev-init.log /tmp/nm-calls; took=\$(docker exec '$c' cat /tmp/dev-init-took)
  echo \"dev-init took \${took}s\"
  [ \"\$took\" -ge 30 ] && [ \"\$took\" -lt 60 ] &&
  docker exec '$c' grep -qF 'dev-init: WARNING: no-mistakes daemon start did not finish within 30s' /tmp/dev-init.log &&
  docker exec '$c' grep -qF 'then run in /tmp/r: no-mistakes daemon start && no-mistakes init' /tmp/dev-init.log &&
  ! docker exec '$c' grep -qx init /tmp/nm-calls &&
  docker exec '$c' grep -qF 'dev-init: started the login page on port 8765' /tmp/dev-init.log &&
  [ \"\$(docker exec '$c' curl -fsS -m 5 localhost:8765/healthz)\" = ok ]"
docker rm -f "$c" >/dev/null

# The page behind a reverse proxy that serves it under a path prefix (#79):
# the README's nginx rule, on a network with two page containers that publish
# nothing. One rule reaches each container by name, and the page's links,
# form, refresh and redirect stay under /login/<name>/.
NGINX_CONF='server {
  listen 80;
  absolute_redirect off;
  location ~ ^/login/(?<ws>[a-z0-9-]+)$ { return 308 $uri/; }
  location ~ ^/login/(?<ws>[a-z0-9-]+)/(?<rest>.*)$ {
    resolver 127.0.0.11 valid=10s;
    proxy_pass http://$ws:8765/$rest$is_args$args;
  }
}'
login_net=$(docker network create --label "$RUN_ID" "$RUN_ID-login")
pa="$RUN_ID-pa"
pb="$RUN_ID-pb"
page_bg --name "$pa" --network "$login_net" -e DEV_LOGIN_PORT=8765 -e DEV_LOGIN_PAGE_EXIT=0 -e DEV_LOGIN_TOOLS=claude >/dev/null
page_bg --name "$pb" --network "$login_net" -e DEV_LOGIN_PORT=8765 -e DEV_LOGIN_TOOLS=claude,codex >/dev/null
run_bg --name "$RUN_ID-nginx" --network "$login_net" -e NGINX_CONF="$NGINX_CONF" public.ecr.aws/docker/library/nginx:alpine \
  sh -c 'printf "%s\n" "$NGINX_CONF" > /etc/nginx/conf.d/default.conf && exec nginx -g "daemon off;"' >/dev/null
# via <path> [curl args...]: curl through nginx, from inside $pa (on the network)
via() {
  local p="$1"
  shift
  docker exec "$pa" curl -sS -m 60 "$@" "http://$RUN_ID-nginx$p"
}
export -f via
export RUN_ID pa
check "behind nginx: /login/<name>/healthz reaches each container's page" bash -c "
  for c in '$pa' '$pb'; do
    for _ in \$(seq 30); do docker exec '$pa' curl -fsS -m 2 \"http://$RUN_ID-nginx/login/\$c/healthz\" >/dev/null 2>&1 && break; sleep 1; done
    [ \"\$(docker exec '$pa' curl -fsS -m 5 \"http://$RUN_ID-nginx/login/\$c/healthz\")\" = ok ] || exit 1
  done"
check "behind nginx: /login/<name>/status is that container's own" bash -c "
  via '/login/$pa/status' -f | jq -e '.codex == \"off\"' &&
  via '/login/$pb/status' -f | jq -e '.codex == \"out\"'"
check "behind nginx: the page shows the links, and its form, refresh and links are relative" bash -c "
  html=\$(via '/login/$pb/' -f)
  echo \"\$html\" | grep -qF 'state=attempt1' && echo \"\$html\" | grep -qF 'CDX1-ABCDE' &&
  echo \"\$html\" | grep -qF '<form method=\"post\" action=\".\">' &&
  echo \"\$html\" | grep -qF 'fetch(\"status\"' &&
  ! echo \"\$html\" | grep -qE '(href|action)=\"/|fetch\\(\"/'"
check "behind nginx: /login/<name> without the slash redirects to /login/<name>/" bash -c "
  [ \"\$(via '/login/$pb' -o /dev/null -w '%{http_code} %{redirect_url}')\" = '308 http://$RUN_ID-nginx/login/$pb/' ]"
check "behind nginx: a wrong code offers a new link under the prefix" bash -c "
  html=\$(via '/login/$pb/' -f -d code=wrong)
  echo \"\$html\" | grep -q 'That did not work' && echo \"\$html\" | grep -qF 'href=\".\">Get a new link' &&
  via '/login/$pb/' -f | grep -qF 'state=attempt2'"
check "behind nginx: the right code logs in and redirects back under the prefix" bash -c "
  [ \"\$(via '/login/$pb/' -d code=good-code-2 -o /dev/null -w '%{http_code} %{redirect_url}')\" = '303 http://$RUN_ID-nginx/login/$pb/' ] &&
  via '/login/$pb/status' -f | jq -e '.claude == \"in\" and .codex == \"out\"'"
docker rm -f "$pa" "$pb" "$RUN_ID-nginx" >/dev/null

# DEV_NOTIFY_URL against a stub listener in the same container, which records
# each request's title, click header and body.
LISTENER='require("http").createServer((q, r) => { let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => {
  require("fs").appendFileSync("/tmp/notify.log", JSON.stringify({ title: q.headers.title, click: q.headers.click, body: b }) + "\n"); r.end("ok"); }); }).listen(9999)'
c=$(run_bg -e STUB="$STUB" -e STUB_CODEX="$STUB_CODEX" -e STUB_GH="$STUB_GH" -e LISTENER="$LISTENER" \
  -e DEV_LOGIN_TOOLS=claude,codex -e DEV_REMOTE_CONTROL_NAME=notify-test -e DEV_NOTIFY_URL=http://127.0.0.1:9999/topic \
  "$IMAGE" bash -c "(node -e \"\$LISTENER\" &) && sleep 1 && $WITH_STUB exec dev-remote-control")
check "DEV_NOTIFY_URL gets one POST naming the logins, with the sign-in links" bash -c "
  for _ in \$(seq 30); do docker exec '$c' test -s /tmp/notify.log && break; sleep 1; done
  sleep 3; docker exec '$c' cat /tmp/notify.log
  [ \"\$(docker exec '$c' grep -c . /tmp/notify.log)\" = 1 ] &&
  docker exec '$c' jq -e '.title == \"Log in to claude, codex (notify-test)\" and (.click | startswith(\"https://claude.com/cai/oauth/authorize\"))
    and (.body | contains(\"enter the code CDX1-ABCDE\"))' /tmp/notify.log"
docker rm -f "$c" >/dev/null
