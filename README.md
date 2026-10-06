# dev-system

Shared, versioned setup for running coding agents (Claude Code, codex) on a repo. It covers
three things:

- the container the agents run in,
- the workflow they follow from issue to merged PR,
- the repo config that connects the two.

A repo adopts it once, pins a version and pulls updates. Fixes are made here once and reach
every repo, so no repo carries a fork of the setup.

## Features

| Feature | What it does for you |
|---|---|
| **Base image** (`ghcr.io/cbundy/dev-system/base:2`) | Node, Claude Code, codex, gh, no-mistakes, treehouse and agentsview, baked in at build time. The same image runs as a desktop dev container, under `docker run`, on Kubernetes and in Coder. |
| **Headless Claude with Remote Control** | A started container runs Claude in tmux with Remote Control on, so you drive it from claude.ai or the Claude app with no shell. `server` mode gives each session its own git worktree. Claude is restarted when it exits. |
| **Persistent state** (`/persist`) | Logins and tool state live on volumes, so they survive rebuilds and image updates. You log in once per repo, and once per Docker host for gh. |
| **Logins without a shell** (`dev-login`) | Missing logins start automatically. Sign-in links go to the container log, an optional login page and an optional push notification, so you can approve from a phone. |
| **Auto-clone** (`DEV_REPO_URL`) | A headless container clones its repo on the first start and fetches on every later start. It never pulls. |
| **Self-checks** (`dev-init`, `dev-doctor`) | Idempotent start-up setup and a health report. Every failure line comes with a `fix:` hint. |
| **Issue-delivery workflow** (`callum-flow` plugin) | `issue-orchestrator` works a `ready` issue queue. `implement-issue` takes one issue through a treehouse worktree and the no-mistakes pipeline. `/update-dev` upstreams a change to this repo as a PR. `/callum-flow:onboard` onboards a repo. A hook blocks `git stash`. |
| **Synced repo config** (`callum-dev`) | `init` scaffolds the config. `update` merges template changes 3-way, so a repo's own edits survive. `check` fails CI when a repo is behind the installed version. |
| **Coder templates** | `coder create <name> --template dev-system` gives you a workspace with Claude, a Log in app and a logins status row. The `orchestrator` template configures that workspace as one long-lived Claude session that resumes across restarts and rebuilds; see the [Coder template reference](coder/dev-system/README.md#orchestrator-workspace). |
| **Central session history** (agentsview) | Every container pushes its Claude and codex sessions to one PostgreSQL. You browse and search them in one viewer. Set the URL once per host. |
| **Telemetry** (OTLP) | Coder workspaces can export Claude Code and codex telemetry to an OTLP endpoint. |

## Start

New or existing repo: open an agent in the folder and tell it to follow
[`docs/onboarding.md`](docs/onboarding.md) ("make this a dev-system repo"), or, with the
`callum-flow` plugin installed, run `/callum-flow:onboard`.

By hand:

```bash
npm i -D github:cbundy/dev-system#semver:0.x
npx callum-dev init          # then fill every <REPLACE> and commit
```

## Docs

| Page | Read it for |
|---|---|
| [`docs/onboarding.md`](docs/onboarding.md) | Making a repo a dev-system repo (written for agents) |
| [`docs/architecture.md`](docs/architecture.md) | Layers, versioning, how updates reach repos, the runtime map for debugging |
| [`images/base/README.md`](images/base/README.md) | The base image: persistence, `dev-init`, `dev-doctor`, Remote Control, logins, agentsview |
| [`coder/dev-system/README.md`](coder/dev-system/README.md) | The Coder templates: pushing them, parameters, OTLP |
| [`templates/README.md`](templates/README.md) | Each template file: what is synced and what the repo owns |
| [`RELEASING.md`](RELEASING.md) | Cutting a release of each layer |
