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

This directory is pushed as two templates, which differ only in their variables: the
Remote Control mode default and the long-lived session's settings:

| Template | Display | Remote Control mode default | For |
|---|---|---|---|
| `dev-system` | dev-system (Docker icon) | `auto`: `server` with a repo, else `session` | Working on a repo, one worktree per claude.ai session |
| `orchestrator` | Orchestrator (🔄) | `session`, resumed on every start | One long-running interactive Claude running the issue orchestrator. See [Orchestrator workspace](#orchestrator-workspace). |
| `orchestrator-loop` | Orchestrator (loop) (🏭) | `session`, resumed on every start | A repo run by the factory loop, with one long-running Claude as its judge. See [Loop orchestrator workspace](#loop-orchestrator-workspace). |

From the repo root, with the `coder` CLI logged in as a template admin:

```bash
coder/push.sh dev-system
coder/push.sh orchestrator
coder/push.sh orchestrator-loop
```

[`coder/push.sh`](../push.sh) holds each template's name, display name, icon,
description and `remote_control_*` variables, and pushes the first time too. The coder
CLI reads each `--variable` as a CSV record, so `push.sh` quotes every `name=value` as
one field, which keeps commas, emoji and spaces in a value intact. The site's
values for the variables below are committed in [`terraform.tfvars`](terraform.tfvars),
which `coder templates push` reads from this directory on every push, so no push can drop
one. To change a value, edit that file and push every template again. A `--variable` flag
on a hand-run `coder templates push` still overrides the file for that push.
Every push is named `<git describe>-<UTC timestamp>` (for example
`v0.34.0-2-gb3ae3f3-20261012-200455`) by [`coder/version-name.sh`](../version-name.sh), so a
version in the Coder UI maps back to a release or commit; the message says which script
pushed it and from which branch.

Telemetry goes to the `otlp_endpoint` in `terraform.tfvars` (what is collected and the
privacy defaults are in
[the image's Telemetry section](../../images/base/README.md#telemetry-opentelemetry-export)).

### Template variables

| Variable | Default | Purpose |
|---|---|---|
| `docker_hosts` | one entry, the local socket: `[{"value":"local","name":"Local Docker","url":"unix:///var/run/docker.sock"}]` | Where workspace containers can run: a JSON list of `{"value", "name", "url"}` objects (`url` is the local socket or `ssh://user@host`; `value` is the stable key, `name` the label in the form). The first entry is the default. A string holding JSON, not an HCL list, because `coder templates push` reads `terraform.tfvars` with a parser that accepts only strings, numbers and lists of strings. See [Docker hosts](#docker-hosts). |
| `otlp_endpoint` | empty (off) | OTLP http/protobuf endpoint. Set, it becomes `OTEL_EXPORTER_OTLP_ENDPOINT`, with `OTEL_RESOURCE_ATTRIBUTES=host=<container>,env=coder`. |
| `trusted_authors` | empty (unset) | Comma-separated `login:numeric_id` entries (`cbundy:13131067`), set as `CALLUM_FLOW_TRUSTED_AUTHORS` in every workspace of every template. The image bakes no list, so `callum-flow-issue-read` fails closed and `dev-doctor` FAILs while it is unset or malformed (cbundy/dev-system#307). |
| `remote_control_default_mode` | `auto` | Default of the `remote_control_mode` parameter. Set per template by `push.sh` (`session` for `orchestrator`), not in `terraform.tfvars`. |
| `remote_control_default_resume` | `false` | Default of the `remote_control_resume` parameter. Set per template by `push.sh` (`true` for `orchestrator`). |
| `remote_control_default_skip_permissions` | `false` | Default of the `remote_control_skip_permissions` parameter. Set per template by `push.sh` (`false` for both, for now). |
| `remote_control_prompt` | empty | `session` mode: the first message of a fresh conversation (`DEV_REMOTE_CONTROL_PROMPT`). Set per template by `push.sh` (`/callum-flow:issue-orchestrator` for `orchestrator`). |
| `remote_control_resume_prompt` | empty | `session` mode: the message sent when the conversation is resumed (`DEV_REMOTE_CONTROL_RESUME_PROMPT`). Set per template by `push.sh` (for `orchestrator`, a nudge to re-read its memory file and re-arm its loop). |
| `remote_control_name_format` | empty | `session` mode: the Remote Control session name, `{name}` being the default name (`DEV_REMOTE_CONTROL_NAME_FORMAT`). Set per template by `push.sh` (`🔄 {name} orchestrator` for `orchestrator`). |
| `default_plugins` | empty | The Claude plugins every workspace gets (`DEV_DEFAULT_PLUGINS`, the image's `<plugin>@<marketplace>=<source>#<ref>` list). Empty keeps the image's default (callum-flow at the image's release). Set per template by `push.sh`: empty for `dev-system` and `orchestrator`; for `orchestrator-loop`, callum-flow, factory-loop and factory-loop-workspace pinned to the pushing checkout's package version. |
| `default_plugin_refs_win` | `false` | Whether the `default_plugins` refs beat a ref the workspace repo's committed `.claude/settings.json` declares (`DEV_DEFAULT_PLUGIN_REFS_WIN=1`, sent only when true), so the template owns the plugin version, and `dev-doctor` fails (not warns) on a missing default plugin or a marketplace at another ref. Set per template by `push.sh`: `true` for `orchestrator-loop`, `false` for `dev-system` and `orchestrator`. |
| `wind_down_minutes` | `0` (off) | A whole number of minutes a workspace stop waits for the [factory loop](../../plugins/factory-loop/README.md) to finish its running steps. Above 0 the template adds a stop script (`wind-down.sh`, a `coder_script` with `run_on_stop`) and gives the container that long plus 60 s of Docker stop grace; 0 adds neither, so the plan is as before. Set per template by `push.sh`: `10` for `orchestrator-loop`, `0` for `dev-system` and `orchestrator`. See [Loop orchestrator workspace](#loop-orchestrator-workspace). |
| `secrets_dir` | `/etc/dev-system/secrets` | Directory on the Docker host mounted read-only at `/run/secrets/dev-system` in every workspace. Empty mounts nothing. See [Central session history](#central-session-history-agentsview). |
| `gh_volume_name` | empty (off) | Named Docker volume behind the per-workspace **GitHub login** choice: workspaces that keep the default, *shared*, mount it at `/persist/gh` and share one gh login. Empty hides the choice, and every workspace keeps its own gh login on its own `/persist` volume. See [Sharing one gh login](#sharing-one-gh-login). |
| `workspace_secrets_dir` | empty (off) | Directory on the Docker host with one folder per workspace, `<dir>/<lower(owner)>/<lower(workspace name)>/gh-token` (owner and workspace name lower-cased, as in the container name; the file owned 1000:1000, mode 0600). When set, every workspace mounts only its own folder, read-only, at `/run/secrets/dev-system-workspace`, whatever its GitHub login; the folder can also carry `factory-db-writer-url` and `factory-db-reader-url` to put that workspace on another factory database (see [docs/factory-db.md](../../docs/factory-db.md)). A workspace that picks **GitHub login** *This workspace's own token* also gets `DEV_GH_TOKEN_FILE`. Must not be `secrets_dir` or under it, since that one is mounted into every workspace (a validation rejects it). Docker creates a missing folder as an empty root-owned one, and `dev-init` then warns that the token is missing. Empty turns the choice off. Only the path passes through Terraform, never a token. See [Sharing one gh login](#sharing-one-gh-login). |
| `claude_auth_volume_name` | empty (off) | Named Docker volume behind the per-workspace **Claude login** choice: workspaces that pick *shared* mount it at `/persist/claude-auth` and share one Claude login, keeping their own history and settings. Empty hides the choice, and every workspace keeps its own login. See [Sharing one Claude login](#sharing-one-claude-login). |
| `template_tester_secrets_dir` | empty (off) | Directory on the Docker host holding the Template Admin token and push variables for `push-next.sh`, mounted read-only at `/run/secrets/dev-system-template-tester` only into workspaces with `template_testing` on. See [Testing template changes from a workspace](#testing-template-changes-from-a-workspace). |
| `coder_login_secrets_dir` | empty (off) | Directory on the Docker host holding `coder-session-token` for the opt-in Coder CLI login, mounted read-only at `/run/secrets/dev-system-coder-login` only into workspaces with `coder_login` on. Must not be `secrets_dir` or `workspace_secrets_dir`, or under either (a validation rejects it). `push-next.sh` always pushes it empty. See [Coder CLI login (opt-in)](#coder-cli-login-opt-in). |
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

   ```hcl
   registry_auth_config = "/etc/coder/registry/config.json"
   ```

   Set it in `terraform.tfvars` and push every template again. This Coder server keeps the
   file at `/run/secrets/ghcr-config.json`, which `terraform.tfvars` names.

Only the path is stored in the template; the file is read on each build. It covers the
digest lookup and the image pull. The Docker host itself needs no login. For a registry
other than ghcr.io, also set `registry_auth_address`.

## Create a workspace

```bash
coder create my-ws --template dev-system   # Enter accepts each default
```

The base image's `dev-init` installs `callum-flow` by default on every start, including
workspaces without a repo. See [Claude plugins](../../images/base/README.md#workspace-and-repo)
for repo plugins, opt-outs and recovery when an install fails.

### Parameters

| Parameter | Default | Changeable later | Purpose |
|---|---|---|---|
| `docker_host` | the first `docker_hosts` entry | no | The Docker host the workspace runs on. Shown only with more than one host in `docker_hosts`. See [Docker hosts](#docker-hosts). |
| `image` | `ghcr.io/cbundy/dev-system/base:2` | yes | The base image or a per-repo image built `FROM` it. The tag is resolved on every start, so a new `:2` release is pulled on the next start. |
| `repo_url` | empty | no | HTTPS clone URL, passed as `DEV_REPO_URL`. Empty leaves the image's own `DEV_REPO_URL` (per-repo images) in force. See [Repo](#repo). |
| `remote_control_mode` | `auto` (`session` in `orchestrator`) | yes | `auto`: `server` when the workspace has a repo, else `session` (see [Repo](#repo)). `session`: one interactive Claude, shown in claude.ai as one session. `server`: one Claude per session started in claude.ai, each in its own git worktree, shown as an environment; that needs a repo (without one the sessions share the directory). |
| `remote_control_skip_permissions` | `false` (from `remote_control_default_skip_permissions`) | yes | Lets Claude act without asking for approval (bypass permissions), in both modes. Only for a workspace you are happy to let act unsupervised. See below. |
| `remote_control_resume` | `false` (`true` in `orchestrator`) | yes | `session` mode: every start resumes the workspace's last Claude conversation, so it comes back as the same claude.ai session after a stop, restart, template update or crash. Sets `DEV_REMOTE_CONTROL_RESUME=1`. Ignored in `server` mode. See [Orchestrator workspace](#orchestrator-workspace). |
| `extra_trusted_authors` | empty | yes | Only with `workspace_secrets_dir` set. Comma-separated `login:id` entries appended to the template's `trusted_authors` in `CALLUM_FLOW_TRUSTED_AUTHORS`. Takes effect on the next start. |
| `git_email` | empty | yes | Only with `workspace_secrets_dir` set. Passed as `DEV_GIT_EMAIL` when non-empty. Takes effect on the next start. |
| `cpus` | 2 | yes | CPU limit (1-16). |
| `memory_gb` | 8 | yes | Memory limit in GB (1-16). 8 leaves room for an agent, a no-mistakes pipeline and a Playwright e2e run at once; 4 got the browser and test runners OOM-killed (cbundy/job-search#222). |
| `template_testing` | `false` | yes | Mounts the Template Admin token from `template_tester_secrets_dir`, so agents here can push `dev-system-next`. That token can change any template: only for a workspace developing dev-system. See [Testing template changes from a workspace](#testing-template-changes-from-a-workspace). |
| `coder_login` | `false` | yes | Logs the `coder` CLI in inside this workspace from the token in `coder_login_secrets_dir`, so agents here can drive other workspaces (e.g. the factory loop's shadow and testbed runs). That token can reach every workspace its user can reach: only for a workspace that drives others. Takes effect on the next start. See [Coder CLI login (opt-in)](#coder-cli-login-opt-in). |

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
terraform, a PostgreSQL 17 server and TypeScript, from `.devcontainer/Dockerfile`), which also carries this repo's
`DEV_REPO_URL`, so `repo_url` can stay empty. It is public, so it needs no registry
credentials.

A workspace keeps the parameter values it was created with, so one created before `auto`
became the default (cbundy/dev-system#108) stays on `session` until you change it.

### Changing a parameter on an existing workspace

`coder start`, `coder restart` and `coder update` with `--parameter` (or
`--rich-parameter-file`) do **not** change an existing workspace's parameters on server
v2.36.6: the build succeeds and keeps the old value, or `coder update` reports "Workspace is
up-to-date" and builds nothing (cbundy/dev-system#268). A CLI whose version matches the server
does not help, and neither does `use_classic_parameter_flow`. Do not rely on them. These work:

- **The dashboard**: the workspace's Settings, Parameters.
- **From inside the workspace**: `dev-restart-self --parameter name=value` (repeatable), for
  example `dev-restart-self --parameter remote_control_resume=false` or
  `dev-restart-self --parameter image=ghcr.io/cbundy/dev-system/dev:latest`. It reads the
  build's parameters back and exits non-zero if a value did not take. See
  [`dev-restart-self`](../../images/base/README.md#dev-restart-self). For one fresh Claude
  conversation without touching `remote_control_resume`, use `dev-restart-self --fresh`.
- **From outside**: a start build with `rich_parameter_values`. The token is read from a
  file and goes to `curl` through a config on stdin, never on its command line:

  ```sh
  CODER_URL=https://coder.example.com WS_ID=<workspace id> TOKEN_FILE=<file holding a session token>
  api() { printf 'header = "Coder-Session-Token: %s"\n' "$(cat "$TOKEN_FILE")" | curl -sS -K - "$@"; }
  v=$(api "$CODER_URL/api/v2/workspaces/$WS_ID" | jq -r .template_active_version_id)
  build=$(api -X POST -H 'Content-Type: application/json' "$CODER_URL/api/v2/workspaces/$WS_ID/builds" \
    -d "$(jq -cn --arg v "$v" '{transition:"start",template_version_id:$v,rich_parameter_values:[{name:"remote_control_resume",value:"false"}]}')" | jq -r .id)
  ```

To confirm a change, read the build's parameters back (`build` is the id from the response
above; the workspace's `latest_build.id` works too):

```sh
api "$CODER_URL/api/v2/workspacebuilds/$build/parameters" | jq -c '.[] | {name, value}'
```

A stop build that carries `rich_parameter_values` is also kept by the start that follows it
(the scheduled autostart of `dev-restart-self --restart`), which is how `--restart
--parameter` works.

### Repo

From base image 2.1.0 (cbundy/dev-system#77; see "Workspace and repo" in the
[image README](../../images/base/README.md)), the image does the repo work itself:

- **With a repo URL** (`repo_url`, or the `DEV_REPO_URL` a per-repo image carries),
  `dev-init` clones it into `/workspaces/<repo name>` on the first start and only fetches
  after that. Claude runs there. In `dev-system`, the Remote Control name (the session or
  environment name in claude.ai) is the repo name; `orchestrator` formats it as
  `🔄 <repo name> orchestrator`. Remote Control mode `auto` becomes `server`, so the
  `dev-system` workspace shows up in claude.ai as an environment where each new session
  gets its own worktree.
  - A private repo needs a GitHub credential: Coder external auth (`GIT_ASKPASS`), or
    else the gh login on the Log in page, after which `dev-login watch` runs the clone.
- **Without one**, the startup script sets `DEV_WORKSPACE=/workspaces`, so Claude still
  runs on the volume, and names the session `coder-<workspace>` (with a
  `remote_control_name_format`, the image fills in the hostname, which is the workspace
  name, instead). Mode `auto` becomes
  `session`: one interactive Claude, as `server` mode would put every session in the
  same directory.

This is decided in the startup script rather than in the agent `env`, because only the
container knows whether the image has its own `DEV_REPO_URL`. The script exports the
resolved mode for `dev-init` and `dev-remote-control --post-start`; the agent `env`, and
so a `coder ssh` shell, still holds `DEV_REMOTE_CONTROL_MODE=auto`, which the image
rejects, so set the mode explicitly to run `dev-remote-control` by hand there. On an image older than
2.1.0, nothing is cloned and Claude runs in `/workspaces`.

## Orchestrator workspace

The `orchestrator` template runs one long-lived interactive Claude, for the
`issue-orchestrator` skill, that comes back as the same conversation after any stop,
restart, rebuild, template update or crash (cbundy/dev-system#164; needs base image 2.5.0 or
later). The intended unattended settings:

- **`session` mode** (the template's default): one conversation, not one per claude.ai
  session.
- **Resume on** (`remote_control_resume`, on by default here): each start resumes the
  workspace's last conversation and reattaches to the same claude.ai Remote Control
  session, with its history. How the image picks the conversation is in
  "Resuming the conversation" in the [image README](../../images/base/README.md).
- **Auto-start**: a fresh conversation starts with `/callum-flow:issue-orchestrator`, so
  nobody has to type the first message. A resumed one gets a nudge instead, to re-read
  `.claude/orchestrator-memory.md` and re-arm its watcher and loop, since those
  do not survive a process restart. Conversation selection and exclusions follow
  [Resuming the conversation](../../images/base/README.md#resuming-the-conversation).
- **Name**: `🔄 <repo> orchestrator` (`remote_control_name_format`), told apart from the
  per-project sessions at a glance and stable across restarts.
- **Auto-compact left on auto**, so the one Claude process can run indefinitely.
- **A repo set** (`repo_url` or a per-repo image), so the memory file sits in the
  workspace's checkout and Claude's transcripts in its `/persist`, both on that
  workspace's volumes.
- **Skip permissions** (`remote_control_skip_permissions`): off by default for now.
  Whether the orchestrator acts without anyone approving tool calls is the owner's call;
  until then, approve from claude.ai or the Claude app.

**Durability.** The conversation history lives on the workspace's `/persist` volume, so
it survives a stop, a restart, a rebuild and a template update. It does **not** survive deleting the
workspace (both volumes are deleted with it, the memory file's checkout included), and a
compaction can lose detail. Keep the orchestrator's durable state in its memory file and
on GitHub, so a lossy compaction or a lost transcript costs little.

## Loop orchestrator workspace

The `orchestrator-loop` template runs one repo's factory: the factory loop, a plugin that every
minute reads the repo's issues, PRs and checks, claims issues labelled `ready`, starts agents
that design, build, review and fix each one in its own worktree, and merges each PR through its
merge queue once CI passes. It runs in code, and wakes Claude only for judgment calls and to speak
to the owner. The design is the [v2 SPEC](../../docs/factory-loop/v2/SPEC.md); putting a repo on it
is [onboarding step 7](../../docs/onboarding.md#7-put-the-repo-on-the-factory-loop-if-the-user-said-yes).

```bash
coder create <repo>-loop --template orchestrator-loop \
  --parameter repo_url=<https clone url> \
  --parameter remote_control_skip_permissions=true --parameter cpus=8
```

The loop's agents run unattended, so a tool call that would ask for approval is refused instead
(SPEC 10.10); every loop workspace in use runs with `remote_control_skip_permissions` on. The
stop gate runs one full gate per 8 CPUs at once, beside the agents. Logins are as for any
workspace ([First-run logins](#first-run-logins)).

- **On boot**: one long-lived interactive Claude in `session` mode, named `🏭 <repo> loop` in
  claude.ai. A fresh conversation starts with `/factory-loop:judge`, so the session is the loop's
  judge: it answers the loop's wakes and is where the owner talks to the factory. The loop
  starts with the session and runs its first pass within a minute. There is nothing to arm.
- **On resume**: `remote_control_resume` is on, so a stop, restart, rebuild, template update or
  crash brings back the same conversation, told that the loop resumes by itself. The loop picks up
  where it stopped from what it keeps on the workspace's `/persist` volume: its records and its
  ledger of started work in the plugin store (`/persist/claude/plugins/store/`), and its decision
  log, control file and agents' answers in `/persist/claude/factory-loop/<owner>__<repo>/`.
- **Plugins**: `push.sh` pins `callum-flow`, `factory-loop` and `factory-loop-workspace` to the
  package version of the checkout it pushes from, so push it from main after a release. The
  template's refs win over a ref the repo's `.claude/settings.json` declares
  (`default_plugin_refs_win`), and `dev-doctor` fails on a missing one. `factory-loop-workspace`
  is the loop's companion: it starts each agent in its worktree, guards what it may write and runs
  the stop gate ([its README](../../plugins/factory-loop-workspace/README.md)). Without it the loop
  holds every agent step and sends a `workspace` notice.
- **Settings**: the repo's `.claude/factory-loop.json`, read from its default branch on GitHub,
  then the workspace file `/persist/claude/factory-loop/config.json`, which may set any key and
  wins. `/factory config` shows each setting and its source.
- **Observe and act**: the loop starts in observe mode: it reads the repo its checkout's `origin`
  names, plans and logs, and executes nothing. `/factory mode act` switches it on from the next
  pass. It acts only while its safety rails pass: the role is `orchestrator` (this template sets
  it), no other orchestrator workspace on the repo has sent a heartbeat in the last 2 minutes, and
  no other session in the workspace holds the act lock. While one fails it keeps observing, and the
  decision log's `rails` field says why. Never run two loop workspaces, or a loop and an
  `orchestrator` workspace, on one repo.
- **Stop the loop**: `/factory new off` lets work in flight finish and starts nothing new.
  `/factory mode off` stops it from the next pass. The kill switch, which needs no session, is
  the `OFF` file: create `/persist/claude/factory-loop/OFF` in the workspace and the loop stops
  within a minute, whatever its mode, until the file is deleted.
- **Stopping the workspace** (`wind_down_minutes`, 10 here): the stop path is Coder stop, then the
  `Wind down` stop script (`wind-down.sh`), then the loop's wind-down mode
  ([SPEC 10.11](../../docs/factory-loop/v2/SPEC.md)). For each loop on the workspace
  (`/persist/claude/factory-loop/<owner>__<repo>`) the script writes `wind-down.request`, so the
  loop starts nothing new, and waits until no step runs, `/factory stop-now` is used, or the cap
  passes (the smaller of the loop's own cap and the template's, counted from the request). It
  records one `wind_down` event per loop (outcome `idle`, `cap`, `now` or `off`), removes the
  request, status and stop-now files, and gives the heartbeat its `--final` beat. Docker's stop
  grace is the cap plus 60 s (660 s), and the script's own timeout the cap plus 45 s, so a stuck
  script never holds a stop past them; the script always exits 0.
  - **Stop now**: `/factory stop-now`, or by hand `touch
    /persist/claude/factory-loop/<owner>__<repo>/wind-down.stop-now`; the script ends within a
    poll (2 s) with outcome `now`, and the running steps are cut.
  - **Off**: a loop whose `windDownMinutes` is 0 (repo `.claude/factory-loop.json`, then the
    user `config.json`, else 10), or with the `OFF` file present, is not waited for: outcome
    `off`, no request written.
  - **No status**: if the loop writes no matching `wind-down.status.json` within 3 minutes it is
    not passing and has no steps to wait for: outcome `idle` with 0 running.

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

  For optional shared login storage, see [Sharing one gh login](#sharing-one-gh-login) and
  [Sharing one Claude login](#sharing-one-claude-login).

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
- **Identity env vars.** The agent passes `DEV_ROLE` (`dev` or `orchestrator`, from the
  template's `role` variable, which `coder/push.sh` sets per template), `DEV_RING` (the
  `ring` workspace parameter: `testbed`, `dev-system` or `consumer`, default `consumer`, so
  existing workspaces get a value without a parameter change), `DEV_CODER_WORKSPACE` (the
  workspace name) and `DEV_CODER_TEMPLATE_VERSION` (the template version the workspace
  runs). Desktop containers get none of them: a missing `DEV_CODER_WORKSPACE` means runtime
  `desktop`, a missing `DEV_ROLE` means `dev`.
- **Template-tester token, opt-in.** Only with `template_tester_secrets_dir` set and the
  workspace's `template_testing` parameter on, that directory is bind-mounted read-only at
  `/run/secrets/dev-system-template-tester` for `push-next.sh`. Every other workspace
  never sees it.
- **Coder CLI login token, opt-in.** Only with `coder_login_secrets_dir` set and the
  workspace's `coder_login` parameter on, that directory is bind-mounted read-only at
  `/run/secrets/dev-system-coder-login` and `DEV_CODER_TOKEN_FILE` points at its
  `coder-session-token`, which `dev-init` turns into the CLI's login on every start. Every
  other workspace never sees it.
- **Logins metadata.** A row on the workspace page, e.g.
  `claude: in, codex: out (optional), gh: out`, refreshed every 300 seconds using
  `dev-login status --json --cached`. Older images that reject `--cached` fall back to
  `dev-login status --json`. See the [GitHub API budget](../../images/base/README.md#first-run-logins).

## Central session history (agentsview)

Every workspace pushes its Claude and codex sessions to the central agentsview once the
Docker host has the database URL in `<secrets_dir>/agentsview-pg-url`. Put it there once,
as root on the workspace Docker host (or with an Ansible task):

```bash
install -d -m 0700 -o 1000 -g 1000 /etc/dev-system/secrets
(umask 077 && read -rsp 'agentsview URL: ' url && printf '%s\n' "$url" > /etc/dev-system/secrets/agentsview-pg-url)
chown 1000:1000 /etc/dev-system/secrets/agentsview-pg-url
```

Running workspaces pick it up at their next start (or `coder ssh <ws> -- dev-init`). From inside the workspace, restart it with `dev-restart-self`, never `coder restart`.
Without the file, Docker creates the directory empty and the push stays off; `dev-doctor`
in the workspace then says so with the fix. Needs base image 2.2.0 or later; an older
image ignores the mount. See "Central session history" in the
[image README](../../images/base/README.md).

## First-run logins

Each new workspace needs its own logins; they land in its `/persist` volume and survive
stops, starts and image updates, unless the workspace shares a login: gh is shared by
default ([Sharing one gh login](#sharing-one-gh-login)), and Claude is shared between the
workspaces that choose it ([Sharing one Claude login](#sharing-one-claude-login)).

1. Open the workspace in the dashboard and click **Log in**.
2. Claude: "Open sign-in page", approve, paste the code shown back into the page.
3. codex and gh: open the link and enter the code. Leave out a tool you never use by
   setting `DEV_LOGIN_TOOLS` in a per-repo image.
4. Within 30s of Claude's login the supervisor starts Remote Control, and the workspace
   appears in claude.ai and the Claude app.

Without the dashboard: `coder ssh <ws> -- dev-login status` lists the links and codes,
and `coder ssh <ws> -- dev-login <code>` finishes Claude's login.

### Sharing one gh login

Each workspace chooses its **GitHub login** when it is created, and can change it later:

- **Shared with other workspaces** (the default): the one gh login used by every workspace
  on the same Docker host that picks shared (the volume is per host, see
  [Docker hosts](#docker-hosts)), so a new workspace needs no GitHub sign-in once any of them is signed
  in.
- **Private to this workspace**: its own gh login. Each private login is its own token, and
  GitHub keeps at most 10 per user for the GitHub CLI app, revoking the least recently used
  one past that, so a private workspace left stopped is the first to lose its login. The
  reasoning is in the [gh login spike](../../docs/spikes/gh-auth/).
- **This workspace's own token** (only with `workspace_secrets_dir` set): the workspace logs
  in with the token file at `<workspace_secrets_dir>/<lower(owner)>/<lower(workspace name)>/gh-token`,
  mounted read-only with nothing else from the directory (the folder is mounted in every workspace when `workspace_secrets_dir` is set, not only in token mode). It mounts no shared gh volume, and
  leaves out the owner's `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, so commits use the token's account
  (set `git_email` if needed). The choice also appears when only `workspace_secrets_dir` is
  set, with private as the default. Changes take effect on the next start. The walkthrough is
  [Working a repo as another GitHub account](#working-a-repo-as-another-github-account).

The choice exists when `gh_volume_name` is set in `terraform.tfvars` (the homelab's is
`dev-system-gh`). Shared is what every workspace got before the choice existed, and a
workspace that predates it gets the default on its next update, so nothing changes for it.
A shared workspace mounts that Docker volume at `/persist/gh`. Leaving `gh_volume_name`
empty adds no mount and offers no choice: each workspace keeps its own gh login. Sharing is
limited to workspaces using the same volume name on the same Docker host.

To switch an existing workspace, change **GitHub login** in the dashboard (the workspace's
Settings, Parameters) or run `dev-restart-self --parameter gh_login=private` inside it;
`coder restart --parameter` does not work (see
[Changing a parameter on an existing workspace](#changing-a-parameter-on-an-existing-workspace)).

The name must have at least two characters: a letter or digit first, followed by letters,
digits, `_`, `.` or `-`. Docker creates the volume on first use, copying in the image's
`node:node`-owned, mode `0700` `/persist/gh`, so there is nothing to set up on the host.
The template does not manage the volume, so deleting a workspace never deletes the
shared login; remove it by hand on
the Docker host (`docker volume rm <name>`) if you ever want to.

- **One token for every shared workspace.** Whoever can open any of them can read the
  shared gh token and act as that GitHub account. Only share it between workspaces you
  would trust with the same token.
- **Concurrent writes.** gh rewrites `hosts.yml` only on a sign-in, sign-out, account switch
  or `gh auth refresh` (its tokens never expire or refresh by themselves), so two workspaces
  writing at once is rare but possible; if a login looks lost, log in again from one
  workspace.
- **Switching to private, or back.** A workspace's own gh login stays on its persist volume,
  hidden under the shared mount while it is shared. Switching to private shows it again: a
  login from before the workspace shared, which GitHub may have revoked since, or none. Sign
  in once if `dev-login status` says so. Switching back to shared hides it again.
- **Seed it with a current login.** A gh login made before dev-system v0.9.0
  (cbundy/dev-system#182) has no `workflow` scope, so it cannot push workflow changes.
  Log in fresh on the shared volume, or run `gh auth refresh --scopes workflow` once in
  any workspace.

### Working a repo as another GitHub account

Use this to run a loop workspace (`orchestrator-loop`, or `dev-system`) acting only as
another person's GitHub account, with none of the owner's GitHub credentials. The template
needs `workspace_secrets_dir` set (see [Template variables](#template-variables)).

1. **Create the token** on the other account. Fine-grained, scoped to the repo: Contents,
   Issues, Pull requests and Workflows read and write; Actions, Checks and Metadata read.
   Or classic: `repo` and `workflow`.
2. **Place it on the Docker host** at
   `<workspace_secrets_dir>/<lower(owner)>/<lower(workspace name)>/gh-token`, owned
   1000:1000, mode 0600. The token never goes into Terraform, a parameter or the template.
   This writes it without the token landing in shell history or argv:

   ```bash
   dir=<workspace_secrets_dir>/<lower(owner)>/<lower(workspace name)>
   sudo install -d -o 1000 -g 1000 -m 0700 "$dir"
   read -rs -p 'Token: ' t; echo
   printf '%s\n' "$t" | sudo install -m 0600 -o 1000 -g 1000 /dev/stdin "$dir/gh-token"
   unset t
   ```

3. **Create the workspace** with `gh_login=token`, `repo_url` set to the other account's
   repo, and `extra_trusted_authors` holding the repo owner and collaborators as `login:id`
   (look an id up with `gh api users/<login> --jq .id`; the token's own account is trusted
   automatically). `git_email` is optional: by default the commit email is
   `<id>+<login>@users.noreply.github.com`. For an existing workspace, change the
   parameters in the dashboard or run `dev-restart-self --parameter gh_login=token`
   (repeatable), never `coder restart --parameter`. All of these take effect on the next
   start.
4. **Check it**: `coder ssh <workspace> -- dev-doctor` shows the effective trusted list and
   the token access check, and `gh auth status` lists only the token's account.
5. **Rotate** by replacing the file in place (same owner and mode), then restarting the
   workspace: dev-init logs gh in from the file on every start.
6. **Remove** by switching `gh_login` back to private or shared and deleting the file (until
   then dev-init warns that the token is missing and gh has no account), then revoke the
   token on GitHub.

Every GitHub call from the workspace, the loop included, counts against that account's own
API rate limit, not the owner's. The details are in the image README: the
[token mode](../../images/base/README.md#factory-event-log) paragraph (the "Token mode" paragraph under "Factory event log") and the
[dev-doctor access check](../../images/base/README.md#dev-doctor).

### Sharing one Claude login

Each workspace chooses its **Claude login** when it is created, and can change it later in
its settings:

- **Private to this workspace** (the default): its own Claude login, exactly as before.
- **Shared with other workspaces**: the one Claude login used by every workspace on the same
  Docker host (the volume is per host, see [Docker hosts](#docker-hosts)) that picks
  shared, so it starts Remote Control with no sign-in once any of them is signed in.

The choice exists when `claude_auth_volume_name` is set in `terraform.tfvars` (the
homelab's is `dev-system-claude-auth`). A workspace that predates it gets the default on
its next update, so it stays private. A shared workspace mounts that Docker volume at
`/persist/claude-auth` and points Claude's login, and only its login, there
(`CLAUDE_SECURESTORAGE_CONFIG_DIR`): its history, settings, plugins and Remote Control
machine stay in its own `/persist/claude`. The volume name follows the same rule as
`gh_volume_name`, Docker creates it on first use, and deleting a workspace never deletes it.

- **Switching an existing workspace.** Update it to a template version with the choice,
  then change **Claude login** in the dashboard (the workspace's Settings, Parameters) or
  run `dev-restart-self --parameter claude_login=shared` inside it; either restarts it with
  the new value. `coder restart --parameter` does not work (see
  [Changing a parameter on an existing workspace](#changing-a-parameter-on-an-existing-workspace)).
- **Switching a workspace to shared.** While the shared volume holds no login, `dev-init`
  moves the workspace's own login into it, so the first one seeds it. Once it holds one, a
  workspace switching to shared uses it, and its own login stays on its persist volume,
  unused. Moving a login needs a base image with this change; on an older one, the first
  shared workspace signs in once.
- **Switching back to private.** The workspace uses its own login again; if its login was
  the one that seeded the shared volume, it signs in once.
- **Token refreshes are coordinated.** Every Claude sharing the volume takes the same lock
  around a token refresh and re-reads the login when another one changed it, as several
  sessions on one machine do, so one workspace's refresh never logs the others out.
- **One login for every shared workspace.** Whoever can open one can read the shared Claude
  token and act as that claude.ai account, and `claude auth logout` in one logs them all
  out. Only pick shared for workspaces you would trust with the same account.

### GitHub through Coder external auth

The template declares no `coder_external_auth`, so it works whether or not the Coder server
has a GitHub provider. With one configured and linked, the agent's `GIT_ASKPASS` answers
git's HTTPS prompts for github.com in every workspace; gh still needs a login on the
page (see [Sharing one gh login](#sharing-one-gh-login)). To skip that too, a deployment
with a non-expiring token (an OAuth app, not Coder's built-in GitHub App) can add
`data "coder_external_auth" "github" { id = "github" }` and set
`GH_TOKEN` from its `access_token` in the agent `env`, which also makes the link required
before a workspace builds.

## Docker hosts

`docker_hosts` lists the hosts workspaces can run on. With one entry there is no choice and
that host is used. With more, the **Docker host** parameter appears (first in the form,
default the first entry) and the provider connects to the url of the chosen entry. The
choice cannot change later: the workspace's container and volumes live on that host, and
moving a workspace between hosts is not supported.

To add a host, append an entry to `docker_hosts` in `terraform.tfvars` and push the
templates. Only append: the first entry is the host of every workspace created before the
choice existed (Coder gives an existing workspace a new parameter's default on its next
update, cbundy/dev-system#268), so never reorder the list, rename a `value`, or remove an
entry a workspace uses. Changing a host's `url` is a `terraform.tfvars` edit and touches no
workspace's parameter.

What the owner prepares on a new host before a workspace is created there:

- The Coder server can `ssh` to the url's user and host without a prompt (key in its ssh
  config, host key in its `known_hosts`).
- The host directories the template mounts exist with the right owner and mode:
  `secrets_dir`, `workspace_secrets_dir` and `template_tester_secrets_dir`.
- The host can pull the images, including from ghcr (see [Private images](#private-images)).

Nothing is synced between hosts. The three host directories above are per host, and so are
the `gh_volume_name` and `claude_auth_volume_name` volumes: the first workspace on a new
host that picks a shared login signs in once for that host, and shares it from then on with
the workspaces there.

## Changing the template

Keep it generic: no site-specific hosts or addresses in `main.tf`, only in
`terraform.tfvars`. A change reaches every template, so push them all.
Provider versions are pinned, with `.terraform.lock.hcl` beside the template; after a
version bump, run `terraform init -upgrade` here and commit the lock file. `npm run lint`
from the repo root runs `terraform fmt -check`, `init -lockfile=readonly` and `validate`
on this directory whenever terraform is on PATH (it is in the `dev` image above), and CI's
`ci.yml` runs the same on every PR.

To try a change from inside a workspace before it reaches `dev-system`, push it as
`dev-system-next` with `coder/dev-system/push-next.sh smoke`; see
[Testing template changes from a workspace](#testing-template-changes-from-a-workspace).

To develop dev-system itself from a workspace (setup, logins, and what only CI can verify), see
[Developing dev-system on Coder](../../docs/developing-on-coder.md).

## Testing template changes from a workspace

`push-next.sh` beside this README pushes the checked-out template as a second template,
`dev-system-next`, and can smoke-test it, so a change is tried without touching the
`dev-system` template every other workspace uses. Each version it pushes is named like the
production ones (`<git describe>-<UTC timestamp>`), so
`coder templates versions list dev-system-next` shows which commit each came from. Run it
from a workspace with the `template_testing` parameter on (or any machine with the token file):

```bash
coder/dev-system/push-next.sh          # push as dev-system-next
coder/dev-system/push-next.sh smoke    # push, create next-smoke-<random> with default
                                       # parameters, wait (max 10 min) until its agent is
                                       # ready, print its status and startup log, delete it
coder/dev-system/push-next.sh smoke host-2   # the same on one docker_hosts entry, by its
                                       # value (the docker_host parameter); try each host
coder/dev-system/push-next.sh cleanup  # delete next-smoke-* workspaces left behind
```

The template name is fixed in the script and cannot be passed in. It only creates or
deletes workspaces named `next-smoke-*` from `dev-system-next`, and deletes the smoke
workspace on failure or Ctrl-C too. Promoting a change to `dev-system` stays the owner's
step, with the push commands at the top of this README.

It reads `coder-session-token`, a session token for a Template Admin user, from the
template-tester mount (`/run/secrets/dev-system-template-tester`, or
`DEV_TEMPLATE_TESTER_DIR`), never from the shared secrets mount that every workspace has.
The token is passed to the CLI in its environment only, never printed or put on a command
line. The variables come from `terraform.tfvars`, as for `dev-system`, except that
`template_tester_secrets_dir` is always pushed empty, so `dev-system-next` workspaces never
get the token.

The deployment URL is `CODER_URL`, else the agent's `CODER_AGENT_URL`. The CLI is the
workspace agent's own binary, which the agent downloads from the server, so its version
always matches the server's. Set `CODER_BIN` to use another.

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
2. As root on the workspace Docker host, write the token into a directory of its own, not
   `secrets_dir`:

   ```bash
   install -d -m 0700 -o 1000 -g 1000 /etc/dev-system/template-tester
   (umask 077 && read -rsp 'Coder token: ' t && printf '%s\n' "$t" > /etc/dev-system/template-tester/coder-session-token)
   chown 1000:1000 /etc/dev-system/template-tester/coder-session-token
   ```

3. `terraform.tfvars` already sets `template_tester_secrets_dir` to that directory, so the
   next `coder/push.sh dev-system` turns the feature on.

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

## Coder CLI login (opt-in)

A workspace that drives other workspaces (the factory loop's shadow and testbed runs use
`coder ssh`) needs a logged-in `coder` CLI. By default no workspace has one. With the
`coder_login` parameter on, and `coder_login_secrets_dir` set, the template mounts a host
directory read-only at `/run/secrets/dev-system-coder-login` and sets `DEV_CODER_TOKEN_FILE`
to its `coder-session-token`. On every start `dev-init` writes that token to the CLI's
`session` file (`~/.config/coderv2`, directory 0700, file 0600) and the server URL
(`CODER_URL`, else `CODER_AGENT_URL`) to `url`, then logs the user `coder whoami` returns,
or one `WARNING` naming the cause. This runs before `dev-restart-self --resume`, so a
resumed restart can use the login. The CLI's config is not on a volume, so a workspace
that stops opting in has no login after its next start. Only the path passes through
Terraform, never the token. `push-next.sh` always pushes `coder_login_secrets_dir` empty, so
no `dev-system-next` workspace gets it.

### What the token can do

The token is a session for one Coder user and **reaches every workspace that user can
reach**, with that user's rights. Any agent or shell in an opted-in workspace can use it, as
can root on the Docker host. Use a dedicated user, keep its lifetime short, and turn
`coder_login` on only for workspaces that need it.

### One-time setup

1. As a Coder Owner, mint a token for the user (`coder tokens create --user <user> --name
   dev-system-coder-login --lifetime 2160h`); it is printed once.
2. As root on the workspace Docker host, write it into a directory of its own, not
   `secrets_dir` or `workspace_secrets_dir`:

   ```bash
   install -d -m 0700 -o 1000 -g 1000 /etc/dev-system/coder-login
   (umask 077 && read -rsp 'Coder token: ' t && printf '%s\n' "$t" > /etc/dev-system/coder-login/coder-session-token)
   chown 1000:1000 /etc/dev-system/coder-login/coder-session-token
   ```

3. `terraform.tfvars` already sets `coder_login_secrets_dir` to that directory, so the next
   `coder/push.sh dev-system` turns the feature on (inert until the directory exists).
4. Turn on `coder_login` (Settings, Parameters) on each workspace that needs it, and restart
   it. Check with `coder whoami`.

### Rotation and revocation

Mint a new token, replace the file, then restart each opted-in workspace (the login is
rebuilt at start). Expire the old one with `coder tokens list --all` and
`coder tokens remove <id>`. To revoke entirely, delete the token file and expire the token.
