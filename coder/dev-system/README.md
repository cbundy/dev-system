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

## Create a workspace

```bash
coder create my-ws --template dev-system   # Enter accepts each default
```

### Parameters

| Parameter | Default | Changeable later | Purpose |
|---|---|---|---|
| `image` | `ghcr.io/cbundy/dev-system/base:2` | yes | The base image or a per-repo image built `FROM` it. The tag is resolved on every start, so a new `:2` release is pulled on the next start. |
| `repo_url` | empty | no | HTTPS clone URL, passed as `DEV_REPO_URL`. Empty leaves the image's own `DEV_REPO_URL` (per-repo images) in force. The clone into `/workspace` is done by `dev-init` once cbundy/dev-system#77 is in the image. |
| `remote_control_mode` | `session` | yes | `session`: one interactive Claude. `server`: one Claude per session started in claude.ai, each in its own git worktree; that needs a git repo in `/workspace` (without one the sessions share the directory). |
| `cpus` | 2 | yes | CPU limit (1-8). |
| `memory_gb` | 4 | yes | Memory limit in GB (1-16). |

The Remote Control name (the session or environment name in claude.ai) is the repo name
when there is a repo URL (the parameter or the image's), else `coder-<workspace>`.

## What the template does

- **Storage.** Two Docker volumes per workspace, named after the workspace ID so a rename
  does not orphan them, and deleted with the workspace:
  - `/persist`: tool state and logins, as the image's persistence contract asks for on
    Coder (one volume at `/persist`). Docker copies the image's node-owned directories into
    it on first use.
  - `/workspace`: the checkout (`DEV_WORKSPACE`), so work in progress and server mode's
    worktrees survive a stop. The startup script makes its root writable by `node`.

  There is deliberately **no home volume**. The image's tools (Claude Code, codex,
  no-mistakes, treehouse) live under `/home/node`, and a volume there would keep the
  first start's copies forever, hiding every newer image. Anything else in the home
  directory is reset on each start, like any other container layer.
- **Start-up.** The Coder agent replaces the image's entrypoint, so the agent's
  `startup_script` does its job, the way the image's devcontainer `postStartCommand` does:
  `dev-init` (limited to 120s, best effort), then `dev-remote-control --post-start`, which
  starts the supervisor in the background (`DEV_REMOTE_CONTROL=1`). Its log is
  `/tmp/dev-remote-control.log`; attach to Claude with `tmux attach -t claude`. The
  startup script's own log is `/tmp/coder-startup-script.log`. Docker's init is PID 1
  (the image's tini is bypassed with the entrypoint) and reaps orphaned processes.
- **Log in app.** `dev-init` serves dev-login's page on port 8765 (`DEV_LOGIN_PORT`),
  kept up as a status page (`DEV_LOGIN_PAGE_EXIT=0`). The app proxies it through Coder's
  path-based app URL, owner only, with a health check on `/healthz`; nothing is published
  on the Docker host. `DEV_LOGIN_PAGE_URL` is set to that URL for dev-login's log lines and
  notifications.
- **Logins metadata.** A row on the workspace page from `dev-login status`, e.g.
  `claude: in, codex: out, gh: out`, refreshed every 30s.

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
