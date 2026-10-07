# shellcheck shell=bash
# shellcheck disable=SC2016,SC2154
#
# Section 12 of the base image container tests. Sourced by test.sh after lib.sh, which
# provides IMAGE, RUN_ID, SECRET, check, in_image and the rest; never run directly.

echo "== 12. workspace repo (DEV_REPO_URL)"

# The remote: a bare repo with main and feature, on a volume at /srv, owned by
# node like every checkout here. Served over file:// (and, for the login
# handoff, over HTTP by the server below), so no network is needed.
REPO_URL=file:///srv/my-repo.git
remote=$(docker volume create --label "$RUN_ID")
# Not left empty, or Docker copies the image's root-owned /srv into it again.
docker run --rm --user root --entrypoint "" -v "$remote:/srv" "$IMAGE" \
  bash -c 'mkdir /srv/my-repo.git && chown 1000:1000 /srv /srv/my-repo.git'
# remote_git <script>: runs a script as node with the remote at /srv and a git identity
remote_git() {
  docker run --rm --entrypoint "" -v "$remote:/srv" -e GIT_AUTHOR_NAME=t -e GIT_AUTHOR_EMAIL=t@example.com \
    -e GIT_COMMITTER_NAME=t -e GIT_COMMITTER_EMAIL=t@example.com "$IMAGE" bash -c "$1"
}
remote_git 'set -e
  git init -q --bare -b main /srv/my-repo.git
  git clone -q /srv/my-repo.git /tmp/w 2>/dev/null && cd /tmp/w
  echo one > README && git add README && git commit -qm one && git push -q origin main
  git checkout -q -b feature && echo f > feature && git add feature && git commit -qm feature && git push -q origin feature'

check "workspace.sh: DEV_WORKSPACE is /workspaces/<repo name> from DEV_REPO_URL, an explicit one wins, unset without a URL" in_image '
  ws() { bash -c ". /usr/local/share/dev-system/workspace.sh; echo \${DEV_WORKSPACE:-unset}"; }
  for u in https://github.com/me/my-repo.git https://github.com/me/my-repo/ git@github.com:me/my-repo.git; do
    [ "$(DEV_REPO_URL=$u ws)" = /workspaces/my-repo ] || { echo "$u: $(DEV_REPO_URL=$u ws)"; exit 1; }
  done
  [ "$(DEV_REPO_URL=https://github.com/me/my-repo.git DEV_WORKSPACE=/w ws)" = /w ] && [ "$(ws)" = unset ]' \
  --entrypoint ""

check "/workspaces exists, is owned 1000:1000 with mode 0755 and ships empty" in_image '
  [ "$(stat -c %u:%g:%a /workspaces)" = 1000:1000:755 ] && [ -z "$(ls -A /workspaces)" ]' \
  --entrypoint ""

# A fresh named volume at /workspaces, as a runtime mounts it (it takes the
# image directory's node ownership): the first start clones into it, the
# second finds the clone there.
wsvol=$(docker volume create --label "$RUN_ID")
# repo_bg: the supervisor against the stub Claude (logged in), with the remote
# and the workspace volume, through the image entrypoint (dev-init first)
repo_bg() {
  run_bg -e STUB="$STUB" -e DEV_REPO_URL="$REPO_URL" -v "$remote:/srv" -v "$wsvol:/workspaces" \
    "$IMAGE" bash -c "touch /tmp/logged-in && $WITH_STUB exec dev-remote-control"
}
c=$(repo_bg)
check "first start: dev-init clones DEV_REPO_URL into the derived DEV_WORKSPACE (/workspaces/my-repo)" bash -c "
  for _ in \$(seq 30); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker logs '$c' 2>&1 | grep 'dev-init: '
  docker logs '$c' 2>&1 | grep -qxF 'dev-init: cloned $REPO_URL into /workspaces/my-repo' &&
  [ \"\$(docker exec '$c' git -C /workspaces/my-repo rev-parse --abbrev-ref HEAD)\" = main ]"
check "first start: the supervisor's Claude starts in the clone, named after the repo" bash -c "
  docker exec '$c' cat /tmp/claude-starts
  [ \"\$(docker exec '$c' cat /tmp/claude-starts)\" = '/workspaces/my-repo --remote-control my-repo' ]"
check "first start: dev-doctor finds the workspace cloned from DEV_REPO_URL" bash -c "
  docker exec '$c' dev-doctor --warn-only | grep -qF 'OK   workspace /workspaces/my-repo is a clone of $REPO_URL'"
# Work in progress: an uncommitted change and a local branch.
docker exec "$c" bash -c 'cd /workspaces/my-repo && echo wip >> README && git branch local-work'
old_main=$(docker exec "$c" git -C /workspaces/my-repo rev-parse main)
docker rm -f "$c" >/dev/null
new_main=$(remote_git 'set -e
  git clone -q /srv/my-repo.git /tmp/w && cd /tmp/w
  echo two >> README && git commit -qam two && git push -q origin main && git rev-parse HEAD')
c=$(repo_bg)
check "second start: no new clone; local changes and branches survive; fetch moves only the remote refs" bash -c "
  for _ in \$(seq 30); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker logs '$c' 2>&1 | grep 'dev-init: '
  ! docker logs '$c' 2>&1 | grep -q 'dev-init: cloned' &&
  docker exec -e OLD='$old_main' -e NEW='$new_main' '$c' bash -c '
    cd /workspaces/my-repo && git status --short --branch
    [ \"\$(git rev-parse origin/main)\" = \"\$NEW\" ] && [ \"\$(git rev-parse main)\" = \"\$OLD\" ] &&
    [ \"\$(git rev-parse --abbrev-ref HEAD)\" = main ] && [ \"\$(git status --porcelain)\" = \" M README\" ] &&
    git rev-parse --verify -q local-work >/dev/null' &&
  [ \"\$(docker exec '$c' cat /tmp/claude-starts)\" = '/workspaces/my-repo --remote-control my-repo' ]"
docker rm -f "$c" >/dev/null

check "a non-empty DEV_WORKSPACE that is no repo is left alone, with a warning" in_image '
  mkdir /workspaces/my-repo && echo keep > /workspaces/my-repo/notes
  out=$(dev-init 2>&1); rc=$?; echo "$out" | grep -A1 "dev-init: WARNING: /workspaces"
  [ $rc = 0 ] && echo "$out" | grep -qF "dev-init: WARNING: /workspaces/my-repo is not empty and not a git repository" &&
  [ "$(ls -A /workspaces/my-repo)" = notes ] && [ "$(cat /workspaces/my-repo/notes)" = keep ]' \
  -e DEV_REPO_URL="$REPO_URL" -v "$remote:/srv" --entrypoint ""
check "an explicit DEV_WORKSPACE wins over the derived one, and DEV_REPO_BRANCH is checked out" in_image '
  out=$(dev-init 2>&1); echo "$out" | grep "dev-init: [^W]"
  echo "$out" | grep -qxF "dev-init: cloned file:///srv/my-repo.git (branch feature) into /tmp/elsewhere" &&
  [ "$(git -C /tmp/elsewhere rev-parse --abbrev-ref HEAD)" = feature ] && test -f /tmp/elsewhere/feature &&
  ! test -e /workspaces/my-repo' \
  -e DEV_REPO_URL="$REPO_URL" -e DEV_WORKSPACE=/tmp/elsewhere -e DEV_REPO_BRANCH=feature -v "$remote:/srv" --entrypoint ""

c=$(run_bg -e STUB="$STUB" -e DEV_REPO_URL=https://no-such-host.invalid/me/my-repo.git \
  "$IMAGE" bash -c "touch /tmp/logged-in && $WITH_STUB exec dev-remote-control")
check "an unreachable DEV_REPO_URL: Claude still starts (in \$HOME), and the log names the cause and the fix" bash -c "
  for _ in \$(seq 30); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker logs '$c' 2>&1 | grep -A1 'dev-init: WARNING: could not clone'
  docker logs '$c' 2>&1 | grep -qF \"dev-init: WARNING: could not clone https://no-such-host.invalid/me/my-repo.git into /workspaces/my-repo: fatal: unable to access 'https://no-such-host.invalid/me/my-repo.git/': Could not resolve host: no-such-host.invalid\" &&
  docker logs '$c' 2>&1 | grep -qF 'dev-init:   Fix: check DEV_REPO_URL' &&
  [ \"\$(docker exec '$c' cat /tmp/claude-starts)\" = '/home/node --remote-control my-repo' ] &&
  docker exec '$c' dev-doctor --warn-only | grep -qF 'WARN workspace /workspaces/my-repo is not cloned from DEV_REPO_URL'"
docker rm -f "$c" >/dev/null
check "an SSH DEV_REPO_URL: dev-init warns that it needs SSH keys, tries anyway and names the cause" in_image '
  out=$(dev-init 2>&1); echo "$out" | grep "dev-init: WARNING: [^n]"
  echo "$out" | grep -qF "dev-init: WARNING: DEV_REPO_URL is an SSH URL (git@no-such-host.invalid:me/my-repo.git), which needs SSH keys" &&
  echo "$out" | grep -qF "dev-init: WARNING: could not clone git@no-such-host.invalid:me/my-repo.git into /workspaces/my-repo: ssh: Could not resolve hostname no-such-host.invalid"' \
  -e DEV_REPO_URL=git@no-such-host.invalid:me/my-repo.git --entrypoint ""

check "dev-doctor accepts an origin that differs only by .git and a trailing /, and warns on another one" in_image '
  git clone -q "$DEV_REPO_URL" /workspaces/my-repo || exit 1
  out=$(DEV_REPO_URL=file:///srv/my-repo/ dev-doctor --warn-only); echo "$out" | grep workspace
  echo "$out" | grep -qF "OK   workspace /workspaces/my-repo is a clone of file:///srv/my-repo/" || exit 1
  git -C /workspaces/my-repo remote set-url origin https://example.com/other/my-repo.git
  out=$(dev-doctor --warn-only); echo "$out" | grep -A1 workspace
  echo "$out" | grep -qF "WARN workspace /workspaces/my-repo has origin https://example.com/other/my-repo.git, not DEV_REPO_URL ($DEV_REPO_URL)" &&
  echo "$out" | grep -qF "remote set-url origin $DEV_REPO_URL"' \
  -e DEV_REPO_URL="$REPO_URL" -v "$remote:/srv" --entrypoint ""
check "dev-doctor warns when headless Claude would run outside a repo with no DEV_REPO_URL, but not on the desktop" in_image '
  out=$(dev-doctor --warn-only); echo "$out" | grep -A1 "Claude runs"
  echo "$out" | grep -qF "WARN Claude runs in /home/node, which is not a git repository, and DEV_REPO_URL is not set" &&
  ! DEV_DESKTOP=1 dev-doctor --warn-only | grep -q "Claude runs in"' \
  --entrypoint ""

# The login handoff: a private repo, served over git's smart HTTP by a server
# in the container that answers 401 to a request without credentials. With no
# gh login yet, dev-init's clone waits for one; once the stub gh login is
# approved (its setup-git gives git a credential), dev-login watch clones the
# repo, and Claude moves into it at its next start.
GIT_SERVER='const { spawn } = require("child_process");
require("http").createServer((q, r) => {
  if (!q.headers.authorization) { r.writeHead(401, { "WWW-Authenticate": "Basic realm=\"git\"" }); return r.end(); }
  const u = new URL(q.url, "http://x");
  const p = spawn("git", ["http-backend"], { env: { ...process.env, GIT_PROJECT_ROOT: "/srv", GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1), REQUEST_METHOD: q.method, REMOTE_USER: "stub",
    CONTENT_TYPE: q.headers["content-type"] || "", HTTP_CONTENT_ENCODING: q.headers["content-encoding"] || "",
    HTTP_GIT_PROTOCOL: q.headers["git-protocol"] || "" } });
  q.pipe(p.stdin);
  let head = Buffer.alloc(0), body = false;
  p.stdout.on("data", (d) => {
    if (body) return r.write(d);
    head = Buffer.concat([head, d]);
    const i = head.indexOf("\r\n\r\n");
    if (i < 0) return;
    let status = 200;
    for (const l of head.subarray(0, i).toString().split("\r\n")) {
      const k = l.slice(0, l.indexOf(":")), v = l.slice(l.indexOf(":") + 1).trim();
      if (k.toLowerCase() === "status") status = parseInt(v, 10); else r.setHeader(k, v);
    }
    r.writeHead(status);
    r.write(head.subarray(i + 4));
    body = true;
  });
  p.stdout.on("end", () => r.end());
}).listen(8418);'
HTTP_URL=http://127.0.0.1:8418/my-repo.git
c=$(run_bg -e STUB="$STUB" -e STUB_GH="$STUB_GH" -e GIT_SERVER="$GIT_SERVER" -e DEV_LOGIN_TOOLS=gh \
  -e DEV_REPO_URL="$HTTP_URL" -e DEV_REMOTE_CONTROL_POLL=1 -v "$remote:/srv" --entrypoint /usr/bin/tini "$IMAGE" -- \
  bash -c "(node -e \"\$GIT_SERVER\" &) && sleep 1 && touch /tmp/logged-in && $WITH_STUB && dev-init; exec dev-remote-control")
check "a private repo with no git credential: Claude still starts, and the clone waits for a GitHub login" bash -c "
  for _ in \$(seq 30); do docker exec '$c' test -s /tmp/claude-starts && break; sleep 1; done
  docker logs '$c' 2>&1 | grep -A1 'dev-init: WARNING: could not clone'
  docker logs '$c' 2>&1 | grep -qF \"dev-init: WARNING: could not clone $HTTP_URL into /workspaces/my-repo: fatal: could not read Username for 'http://127.0.0.1:8418': terminal prompts disabled\" &&
  docker logs '$c' 2>&1 | grep -qF 'dev-init:   Waiting for a GitHub login' &&
  [ \"\$(docker exec '$c' cat /tmp/claude-starts)\" = '/home/node --remote-control my-repo' ] &&
  ! docker exec '$c' test -e /workspaces/my-repo"
docker exec "$c" touch /tmp/gh-approve
check "once gh is logged in, dev-login watch clones the repo" bash -c "
  for _ in \$(seq 40); do docker logs '$c' 2>&1 | grep -q 'dev-init: cloned' && break; sleep 1; done
  docker logs '$c' 2>&1 | grep -E 'dev-login|dev-init: cloned'
  docker logs '$c' 2>&1 | grep -qF 'dev-login: gh is logged in - cloning the workspace repo (dev-init --repo)' &&
  docker logs '$c' 2>&1 | grep -qxF 'dev-init: cloned $HTTP_URL into /workspaces/my-repo' &&
  [ \"\$(docker exec '$c' git -C /workspaces/my-repo rev-parse HEAD)\" = '$new_main' ]"
docker exec "$c" touch /tmp/claude-exit
check "after the clone, Claude's next start is in the repo" bash -c "
  for _ in \$(seq 20); do docker logs '$c' 2>&1 | grep -q 'Claude exited' && break; sleep 1; done
  docker exec '$c' rm -f /tmp/claude-exit
  for _ in \$(seq 20); do [ \"\$(docker exec '$c' grep -c . /tmp/claude-starts)\" -ge 2 ] && break; sleep 1; done
  docker exec '$c' cat /tmp/claude-starts
  [ \"\$(docker exec '$c' sed -n 2p /tmp/claude-starts)\" = '/workspaces/my-repo --remote-control my-repo' ]"
docker rm -f "$c" >/dev/null
