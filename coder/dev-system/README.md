---
display_name: dev-system
description: A dev-system base image workspace with Claude Code Remote Control and a login page
icon: /icon/docker.svg
tags: [docker, dev-system, claude]
---

# Coder template: dev-system

One Docker container per workspace from the dev-system base image
(`ghcr.io/cbundy/dev-system/base:2`, see [`images/base/README.md`](../../images/base/README.md)).
A workspace created with every parameter at its default comes up with `dev-init` run, the
login page behind a **Log in** app, and Claude Code waiting for its login to start Remote
Control. After one login per workspace it shows up in claude.ai and the Claude app.

## Push

From the repo root, with the `coder` CLI logged in as a template admin:

```bash
coder templates push dev-system --directory coder/dev-system \
  --variable docker_host=ssh://coder@<docker-host>
```

On the homelab (cbundy/network#141, the workspace LXC; the Coder server's ssh config
supplies the key):

```bash
coder templates push dev-system --directory coder/dev-system \
  --variable docker_host=ssh://coder@192.168.1.245
```

Add `--variable otlp_endpoint=http://<gateway>:4318` to export Claude Code and codex
telemetry (what is collected and the privacy defaults are in
[the image's Telemetry section](../../images/base/README.md#telemetry-opentelemetry-export)).
Pass the same variables on every push.

### Variables (set at push time)

| Variable | Default | Purpose |
|---|---|---|
| `docker_host` | `unix:///var/run/docker.sock` | Where workspace containers run: the local socket, or `ssh://user@host`. |
| `otlp_endpoint` | empty (off) | OTLP http/protobuf endpoint. Set, it becomes `OTEL_EXPORTER_OTLP_ENDPOINT`, with `OTEL_RESOURCE_ATTRIBUTES=host=<container>,env=coder`. |
| `secrets_dir` | `/etc/dev-system/secrets` | Directory on the Docker host mounted read-only at `/run/secrets/dev-system` in every workspace. Empty mounts nothing. See [Central session history](#central-session-history-agentsview). |
| `template_tester_secrets_dir` | empty (off) | Directory on the Docker host holding the Template Admin token and push variables for `push-next.sh`, mounted read-only at `/run/secrets/dev-system-template-tester` only into workspaces with `template_testing` on. See [Testing template changes from a workspace](#testing-template-changes-from-a-workspace). |
| `registry_auth_config` | empty (off) | Path, on the Coder server / provisioner, to a Docker `config.json` with registry credentials, used to resolve and pull private images. See [Private images](#private-images). |
| `registry_auth_address` | `ghcr.io` | Registry the credentials are for. Only used with `registry_auth_config`. |

## Private images

A per-repo image built `FROM` the base image is often private. The template resolves the
image's digest and pulls it from the Coder server (the provisioner), anonymously by default,
so a private image fails with 401 or 403. To give it credentials without putting a secret in
Terraform state, template variables or workspace parameters:

1. Create a GitHub classic personal access token with only the `read:packages` scope.
2. On the machine where `coder server` runs (or inside its container), log in with a
   separate config directory, so only that registry's credential is in the file:

   ```bash
   DOCKER_CONFIG=/etc/coder/registry docker login ghcr.io -u <github user>
   ```

   Paste the token as the password. This writes `/etc/coder/registry/config.json`. It must
   be readable by the provisioner process, which may run as the `coder` user or inside
   Coder's container: make it owned by that user, mode 0600, and mount it into the
   container if needed.
3. Push with the path of that file:

   ```bash
   coder templates push dev-system --directory coder/dev-system \
     --variable docker_host=ssh://coder@<docker-host> \
     --variable registry_auth_config=/etc/coder/registry/config.json
   ```

   Pass every variable again on every push, or the others fall back to their defaults.

Only the path is stored in the template; the file is read on each build. It covers the
digest lookup and the image pull. The Docker host itself needs no login. For a registry
other than ghcr.io, also set `registry_auth_address`.

## Create a workspace

```bash
coder create my-ws --template dev-system   # Enter accepts each default
```

### Parameters

| Parameter | Default | Changeable later | Purpose |
|---|---|---|---|
| `image` | `ghcr.io/cbundy/dev-system/base:2` | yes | The base image or a per-repo image built `FROM` it. The tag is resolved on every start, so a new `:2` release is pulled on the next start. |
| `repo_url` | empty | no | HTTPS clone URL, passed as `DEV_REPO_URL`. Empty leaves the image's own `DEV_REPO_URL` (per-repo images) in force. See [Repo](#repo). |
| `remote_control_mode` | `auto` | yes | `auto`: `server` when the workspace has a repo, else `session` (see [Repo](#repo)). `session`: one interactive Claude, shown in claude.ai as one session. `server`: one Claude per session started in claude.ai, each in its own git worktree, shown as an environment; that needs a repo (without one the sessions share the directory). |
| `remote_control_skip_permissions` | `false` | yes | Lets Claude act without asking for approval (bypass permissions), in both modes. Only for a workspace you are happy to let act unsupervised. See below. |
| `cpus` | 2 | yes | CPU limit (1-8). |
| `memory_gb` | 4 | yes | Memory limit in GB (1-16). |
| `template_testing` | `false` | yes | Mounts the Template Admin token from `template_tester_secrets_dir`, so agents here can push `dev-system-next`. That token can change any template: only for a workspace developing dev-system. See [Testing template changes from a workspace](#testing-template-changes-from-a-workspace). |

`remote_control_skip_permissions` sets `DEV_REMOTE_CONTROL_SKIP_PERMISSIONS` to `1` (else
`0`), documented in the [image README](../../images/base/README.md). In `session` mode the
image starts Claude with `--dangerously-skip-permissions`, its one-time consent dialog
skipped. In `server` mode it adds `--permission-mode bypassPermissions` to
`claude remote-control`, so the sessions started from claude.ai run in (or can be switched
to) bypass permissions, and it accepts the bypass disclaimer in `.claude.json`. The
supervisor reads the variable when it starts, so a change takes effect on the next workspace
restart.

For a workspace that works on dev-system itself, set `image` to
`ghcr.io/cbundy/dev-system/dev:latest`: this repo's own per-repo image (the base image plus
terraform, from `.devcontainer/Dockerfile`), which also carries this repo's
`DEV_REPO_URL`, so `repo_url` can stay empty. It is public, so it needs no registry
credentials.

A workspace keeps the parameter values it was created with, so one created before `auto`
became the default (cbundy/dev-system#108) stays on `session` until you change it.

To change a parameter, use the dashboard (Settings, Parameters) or a `coder` CLI that
matches the server's version: `coder update/start/restart --parameter
remote_control_mode=server` silently did not apply with CLI v2.37.1 against server
v2.36.6.

### Repo

From base image 2.1.0 (cbundy/dev-system#77; see "Workspace and repo" in the
[image README](../../images/base/README.md)), the image does the repo work itself:

- **With a repo URL** (`repo_url`, or the `DEV_REPO_URL` a per-repo image carries),
  `dev-init` clones it into `/workspaces/<repo name>` on the first start and only fetches
  after that. Claude runs there, and the Remote Control name (the session or environment
  name in claude.ai) is the repo name. The template sets neither. Remote Control mode
  `auto` becomes `server`, so the workspace shows up in claude.ai as an environment
  where each new session gets its own worktree.
  - A private repo needs a GitHub credential: Coder external auth (`GIT_ASKPASS`), or
    else the gh login on the Log in page, after which `dev-login watch` runs the clone.
- **Without one**, the startup script sets `DEV_WORKSPACE=/workspaces`, so Claude still
  runs on the volume, and names the session `coder-<workspace>`. Mode `auto` becomes
  `session`: one interactive Claude, as `server` mode would put every session in the
  same directory.

This is decided in the startup script rather than in the agent `env`, because only the
container knows whether the image has its own `DEV_REPO_URL`. The script exports the
resolved mode for `dev-init` and `dev-remote-control --post-start`; the agent `env`, and
so a `coder ssh` shell, still holds `DEV_REMOTE_CONTROL_MODE=auto`, which the image
rejects, so set the mode explicitly to run `dev-remote-control` by hand there. On an image older than
2.1.0, nothing is cloned and Claude runs in `/workspaces`.

## What the template does

- **Storage.** Two Docker volumes per workspace, named after the workspace ID so a rename
  does not orphan them, and deleted with the workspace:
  - `/persist`: tool state and logins, as the image's persistence contract asks for on
    Coder (one volume at `/persist`). Docker copies the image's node-owned directories into
    it on first use.
  - `/workspaces`: the checkout, so work in progress and server mode's worktrees survive
    a stop. From 2.1.0 the image's `/workspaces` is node-owned and Docker gives the new
    volume that ownership. An older image has no such directory, so the volume comes up
    root-owned, and the startup script `chown`s it (with `sudo -n`) only in that case.

  There is deliberately **no home volume**. The image's tools (Claude Code, codex,
  no-mistakes, treehouse) live under `/home/node`, and a volume there would keep the
  first start's copies forever, hiding every newer image. Anything else in the home
  directory is reset on each start, like any other container layer.
- **Start-up.** The Coder agent replaces the image's entrypoint, so the agent's
  `startup_script` does its job, the way the image's devcontainer `postStartCommand` does:
  `dev-init` (limited to 300s like the image's own entrypoint, best effort), then `dev-remote-control --post-start`, which
  starts the supervisor in the background (`DEV_REMOTE_CONTROL=1`). Its log is
  `/tmp/dev-remote-control.log`; attach to Claude with `tmux attach -t claude`. The
  startup script's own log is `/tmp/coder-startup-script.log`. Docker's init is PID 1
  (the image's tini is bypassed with the entrypoint) and reaps orphaned processes.
  `DEV_DESKTOP` stays unset: the workspace is headless, so `dev-doctor` runs its headless
  checks.
- **Log in app.** `dev-init` serves dev-login's page on port 8765 (`DEV_LOGIN_PORT`),
  kept up as a status page (`DEV_LOGIN_PAGE_EXIT=0`). The app proxies it through Coder's
  path-based app URL, owner only, with a health check on `/healthz`; nothing is published
  on the Docker host. `DEV_LOGIN_PAGE_URL` is set to that URL for dev-login's log lines and
  notifications.
- **Runtime secrets.** The Docker host's `secrets_dir` is bind-mounted read-only at the
  image's `/run/secrets/dev-system`. No secret passes through Terraform state, template
  variables or workspace parameters. `DEV_MACHINE_NAME` is `coder-<workspace>`.
- **Template-tester token, opt-in.** Only with `template_tester_secrets_dir` set and the
  workspace's `template_testing` parameter on, that directory is bind-mounted read-only at
  `/run/secrets/dev-system-template-tester` for `push-next.sh`. Every other workspace
  never sees it.
- **Logins metadata.** A row on the workspace page from `dev-login status`, e.g.
  `claude: in, codex: out, gh: out`, refreshed every 30s.

## Central session history (agentsview)

Every workspace pushes its Claude and codex sessions to the central agentsview once the
Docker host has the database URL in `<secrets_dir>/agentsview-pg-url`. Put it there once,
as root on the workspace Docker host (or with an Ansible task):

```bash
install -d -m 0700 -o 1000 -g 1000 /etc/dev-system/secrets
(umask 077 && read -rsp 'agentsview URL: ' url && printf '%s\n' "$url" > /etc/dev-system/secrets/agentsview-pg-url)
chown 1000:1000 /etc/dev-system/secrets/agentsview-pg-url
```

Running workspaces pick it up at their next start (or `coder ssh <ws> -- dev-init`).
Without the file, Docker creates the directory empty and the push stays off; `dev-doctor`
in the workspace then says so with the fix. Needs base image 2.2.0 or later; an older
image ignores the mount. See "Central session history" in the
[image README](../../images/base/README.md).

## First-run logins

Each new workspace needs its own logins; they land in its `/persist` volume and survive
stops, starts and image updates.

1. Open the workspace in the dashboard and click **Log in**.
2. Claude: "Open sign-in page", approve, paste the code shown back into the page.
3. codex and gh: open the link and enter the code. Leave out a tool you never use by
   setting `DEV_LOGIN_TOOLS` in a per-repo image.
4. Within 30s of Claude's login the supervisor starts Remote Control, and the workspace
   appears in claude.ai and the Claude app.

Without the dashboard: `coder ssh <ws> -- dev-login status` lists the links and codes,
and `coder ssh <ws> -- dev-login <code>` finishes Claude's login.

### GitHub through Coder external auth

The template declares no `coder_external_auth`, so it works whether or not the Coder server
has a GitHub provider. With one configured and linked, the agent's `GIT_ASKPASS` answers
git's HTTPS prompts for github.com in every workspace; gh still needs its own login on the
page. To skip that too, a deployment with a non-expiring token (an OAuth app, not Coder's
built-in GitHub App) can add `data "coder_external_auth" "github" { id = "github" }` and set
`GH_TOKEN` from its `access_token` in the agent `env`, which also makes the link required
before a workspace builds.

## Changing the template

Keep it generic: no site-specific hosts or addresses in `main.tf`, only in push commands.
Provider versions are pinned, with `.terraform.lock.hcl` beside the template; after a
version bump, run `terraform init -upgrade` here and commit the lock file. `npm run lint`
from the repo root runs `terraform fmt -check`, `init -lockfile=readonly` and `validate`
on this directory whenever terraform is on PATH (it is in the `dev` image above), and CI's
`ci.yml` runs the same on every PR.

To try a change from inside a workspace before it reaches `dev-system`, push it as
`dev-system-next` with `coder/dev-system/push-next.sh smoke`; see
[Testing template changes from a workspace](#testing-template-changes-from-a-workspace).

## Testing template changes from a workspace

`push-next.sh` beside this README pushes the checked-out template as a second template,
`dev-system-next`, and can smoke-test it, so a change is tried without touching the
`dev-system` template every other workspace uses. Run it from a workspace with the
`template_testing` parameter on (or any machine with the token file):

```bash
coder/dev-system/push-next.sh          # push as dev-system-next
coder/dev-system/push-next.sh smoke    # push, create next-smoke-<random> with default
                                       # parameters, wait (max 10 min) until its agent is
                                       # ready, print its status and startup log, delete it
coder/dev-system/push-next.sh cleanup  # delete next-smoke-* workspaces left behind
```

The template name is fixed in the script and cannot be passed in. It only creates or
deletes workspaces named `next-smoke-*` from `dev-system-next`, and deletes the smoke
workspace on failure or Ctrl-C too. Promoting a change to `dev-system` stays the owner's
step, with the push commands at the top of this README.

It reads two files from the template-tester mount
(`/run/secrets/dev-system-template-tester`, or `DEV_TEMPLATE_TESTER_DIR`), never from the
shared secrets mount that every workspace has:

- `coder-session-token`: a session token for a Template Admin user. Passed to the CLI in
  its environment only, never printed or put on a command line.
- `coder-template-vars`: the push variables, one `name=value` per line (`#` comments and
  blank lines are skipped), each passed as `--variable`, so no site-specific value lives
  in the repo. Without it the template's defaults apply.

The deployment URL is `CODER_URL`, else the agent's `CODER_AGENT_URL`. The CLI is the
workspace agent's own binary, which the agent downloads from the server, so its version
always matches the server's (a mismatched CLI silently ignored `--parameter` in
cbundy/dev-system#108). Set `CODER_BIN` to use another.

### What the token can do

On Coder OSS a token cannot be limited to one template. Template Admin is a site-wide role,
and per-template permissions (groups and template ACLs) need a Premium license, so **this
token can push, change or delete any template, including `dev-system`**, and can create
workspaces. Only the script, and the rule in the repo's `CLAUDE.md`, keep it to
`dev-system-next`. **Any agent in a workspace with `template_testing` on can change any
template**, as can anyone with a shell there or root on the Docker host. That is why the
token lives in its own directory, mounted only into workspaces that opt in, and not in
`secrets_dir`, which every workspace for every repo gets. Turn `template_testing` on only
for the workspace developing dev-system. Use a dedicated user, so
the token is not an owner's and is easy to revoke, and keep its lifetime short. Token
scopes and allow lists (`coder tokens create --scope ... --allow template:<id>`) might
narrow it further, but which scopes a push and a smoke run need is untested.

### One-time setup

1. As a Coder Owner (on the PC or the Coder server), create the user, give it the Template
   Admin role, and mint a token for it. The user has no password (`none` is deprecated in
   favour of Premium service accounts but still works on OSS):

   ```bash
   coder users create --username template-tester --email template-tester@localhost \
     --login-type none
   coder users edit-roles template-tester --roles template-admin --yes
   coder tokens create --user template-tester --name dev-system-next --lifetime 2160h
   ```

   The last command prints the token once.
2. As root on the workspace Docker host, write the token and the push variables into a
   directory of their own, not `secrets_dir` (the variables are the values you pass when
   pushing `dev-system`):

   ```bash
   install -d -m 0700 -o 1000 -g 1000 /etc/dev-system/template-tester
   (umask 077 && read -rsp 'Coder token: ' t && printf '%s\n' "$t" > /etc/dev-system/template-tester/coder-session-token)
   (umask 077 && printf '%s\n' 'docker_host=ssh://coder@<docker-host>' > /etc/dev-system/template-tester/coder-template-vars)
   chown 1000:1000 /etc/dev-system/template-tester/coder-session-token /etc/dev-system/template-tester/coder-template-vars
   ```

   Add a line for each other variable (`otlp_endpoint=...`, `registry_auth_config=...`).
   Leave `template_tester_secrets_dir` out, so `dev-system-next` workspaces never get the
   token.
3. Push `dev-system` with the variable added to the usual ones:

   ```bash
   coder templates push dev-system --directory coder/dev-system \
     --variable docker_host=ssh://coder@<docker-host> \
     --variable template_tester_secrets_dir=/etc/dev-system/template-tester
   ```

   Pass it again on every push of `dev-system`, or it falls back to empty (off).

4. Turn on `template_testing` (Settings, Parameters) on the workspace developing
   dev-system only, and restart it. The mount is live, so a replaced token file is seen at
   once.

Smoke workspaces belong to `template-tester`, so they do not show in your own workspace
list; `coder list --all` shows them.

### Rotation and revocation

The token above expires after 90 days. Mint a new one with the same `tokens create`
command (a new `--name`, e.g. `dev-system-next-2`), replace the file, then expire the old
one:

```bash
coder tokens list --all                 # find the old token's id
coder tokens remove <id>                # expire it
```

To revoke access entirely, delete the token file from `/etc/dev-system/template-tester`
and run
`coder users suspend template-tester`.
