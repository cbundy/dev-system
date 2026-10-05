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
telemetry. Pass the same variables on every push.

### Variables (set at push time)

| Variable | Default | Purpose |
|---|---|---|
| `docker_host` | `unix:///var/run/docker.sock` | Where workspace containers run: the local socket, or `ssh://user@host`. |
| `otlp_endpoint` | empty (off) | OTLP http/protobuf endpoint. Set, it becomes `OTEL_EXPORTER_OTLP_ENDPOINT`, with `OTEL_RESOURCE_ATTRIBUTES=host=<container>,env=coder`. |
| `secrets_dir` | `/etc/dev-system/secrets` | Directory on the Docker host mounted read-only at `/run/secrets/dev-system` in every workspace. Empty mounts nothing. See [Central session history](#central-session-history-agentsview). |
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
| `remote_control_mode` | `session` | yes | `session`: one interactive Claude. `server`: one Claude per session started in claude.ai, each in its own git worktree; that needs a repo (without one the sessions share the directory). |
| `cpus` | 2 | yes | CPU limit (1-8). |
| `memory_gb` | 4 | yes | Memory limit in GB (1-16). |

### Repo

From base image 2.1.0 (cbundy/dev-system#77; see "Workspace and repo" in the
[image README](../../images/base/README.md)), the image does the repo work itself:

- **With a repo URL** (`repo_url`, or the `DEV_REPO_URL` a per-repo image carries),
  `dev-init` clones it into `/workspaces/<repo name>` on the first start and only fetches
  after that. Claude runs there, and the Remote Control name (the session or environment
  name in claude.ai) is the repo name. The template sets neither.
  - A private repo needs a GitHub credential: Coder external auth (`GIT_ASKPASS`), or
    else the gh login on the Log in page, after which `dev-login watch` runs the clone.
- **Without one**, the startup script sets `DEV_WORKSPACE=/workspaces`, so Claude still
  runs on the volume, and names the session `coder-<workspace>`.

This is decided in the startup script rather than in the agent `env`, because only the
container knows whether the image has its own `DEV_REPO_URL`. On an image older than
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
version bump, run `terraform init -upgrade` here and commit the lock file. Check with
`terraform fmt -check` and `terraform validate` before pushing.
