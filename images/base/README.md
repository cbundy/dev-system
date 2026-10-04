# dev-system base image

`ghcr.io/cbundy/dev-system/base` is a prebuilt agent dev environment: Node LTS, the agent
CLIs and Callum's flow tooling baked in, plus a fixed contract for where tool state
persists. The same image runs on the desktop (through a thin `devcontainer.json`) and on
the homelab (as a Kubernetes pod, a Coder workspace or a plain `docker run`), with no
devcontainer tooling needed at run time.

It complements the `callum-tools` Dev Container Feature rather than replacing it. Repos
that use features keep using it, and the image reuses the feature's scripts
(`features/src/callum-tools/`) rather than forking them.

## What the image owns

1. A non-root user, `node` (UID/GID 1000), with passwordless sudo, home `/home/node` and
   `~/.local/bin` first on `PATH`.
2. The agent toolchain, installed at build time with nothing downloaded at container start:

   | Tool | Installed via | Updates |
   |---|---|---|
   | Node LTS + npm | base image (`mcr.microsoft.com/devcontainers/javascript-node:24-trixie`) | image rebuild |
   | Claude Code | Anthropic's native installer, as `node` | **auto-updates in the running container** |
   | codex | `npm i -g @openai/codex`, as `node` (npm prefix is node-owned) | `npm i -g` as `node`, or image rebuild |
   | no-mistakes | its install script, as `node` | `no-mistakes update`, or image rebuild |
   | treehouse | its install script, as `node` | image rebuild |
   | gh | official GitHub CLI apt repo | image rebuild |
   | agentsview | pinned release tarball, checksum-verified | bump `AGENTSVIEW_VERSION` in the Dockerfile |
   | git | base image | image rebuild |

   Also `jq`, `ripgrep`, `tmux` (Claude's Remote Control session runs in it), `tini`
   (PID 1), `less` and `openssh-client`. Every tool binary lives outside `/persist`, so a new image always
   brings fresh binaries.
3. The persistence contract (below).
4. `dev-init`, the idempotent start-up setup for state that cannot be baked in.
5. `dev-doctor`, a health check that reports missing auth or broken state loudly.
6. Default devcontainer metadata (the `devcontainer.metadata` image label), so desktop use
   gets the persistence volumes and `dev-init` automatically.
7. An entrypoint that runs `dev-init` and, on headless runtimes, keeps Claude Code running
   with Remote Control (below).

The callum-tools watcher scripts (`pipeline-watch.sh`, `queue-watch.sh`) are staged at
`/usr/local/share/callum-tools/`, the same path the feature uses, so the `callum-flow`
orchestrator skill works unchanged.

## What the image does not own

These belong to the consumer image or the runtime:

- Repo-specific tools (Terraform, Python stacks, Docker CLI and so on). Add them in the
  consumer's Dockerfile.
- Secrets or credentials of any kind. The image is public.
- Where volumes come from (Docker named volume, k8s PVC, host bind). The image only defines
  the mount points.
- The workspace checkout location and the git clone.
- Repo config (`.no-mistakes.yaml`, `treehouse.toml`, `CLAUDE.md` and so on). It is
  committed in each repo by `callum-dev`.
- Docker-in-container, egress firewalling and IDE extensions.

## Persistence contract

All persistent tool state lives under `/persist`. Each directory exists in the image, owned
`1000:1000` with mode `0700`, and ships empty. Each tool is pointed at its directory by an
environment variable set in the image.

| Directory | Tool | How the tool finds it | What persists |
|---|---|---|---|
| `/persist/claude` | Claude Code | `CLAUDE_CONFIG_DIR` | login (`.claude.json`), settings, plugins, sessions |
| `/persist/codex` | codex | `CODEX_HOME` | login, `config.toml` |
| `/persist/gh` | GitHub CLI | `GH_CONFIG_DIR` | login (`hosts.yml`), config |
| `/persist/no-mistakes` | no-mistakes | `NM_HOME` (also `NO_MISTAKES_HOME`, read by the callum-tools pipeline watcher) | global `config.yaml`, repo registrations, gates, run logs |
| `/persist/agentsview` | agentsview | `AGENTSVIEW_DATA_DIR` | installation ID (this machine's identity in the shared database), local session archive, `config.toml` |

no-mistakes keeps its binary in `~/.no-mistakes/bin`, outside `/persist`, and
`no-mistakes update` replaces it there. `~/.no-mistakes/logs` is a link to
`/persist/no-mistakes/logs`, because the callum-flow skills read run logs at that path.

The same list is published as the image label
`dev.cbundy.persist=/persist/claude,/persist/codex,/persist/gh,/persist/no-mistakes,/persist/agentsview`, so
runtimes and templates can read it.

There is deliberately **no `VOLUME` instruction**: it would silently discard a child
image's changes under `/persist` and leave anonymous volumes behind. Mount points are
declared by this contract and the devcontainer metadata instead.

### How runtimes should mount it

- **Kubernetes / Coder**: one PVC mounted at `/persist`, with
  `securityContext.fsGroup: 1000` so `node` can write to it. `dev-init` creates any missing
  subdirectory on first start.
- **Docker (desktop)**: one named volume per subdirectory, shared across repos, so you log
  in once per machine. A new named volume copies the image directory's ownership on first
  use, which is why the directories exist in the image owned by 1000. The devcontainer
  metadata does this for you (see below).
- **Host bind mounts** work if the host directory is writable by UID 1000. Avoid binding a
  Windows-side directory (`${localEnv:USERPROFILE}`) under WSL: permissions and the
  no-mistakes daemon socket do not behave there (cbundy/dev-system#19). Use named volumes.

If a directory is not writable, `dev-init` prints a warning naming the fix and `dev-doctor`
fails that check.

## `dev-init`

`/usr/local/bin/dev-init` runs as `node` on every container start. On the desktop the
image metadata runs it as `postStartCommand`; everywhere else the image entrypoint runs it
(see below). If the workspace is cloned only after the container starts, run it again
once the clone is there (for example at the end of a Coder `startup_script`), so the
no-mistakes recovery sees the repo. It is idempotent and best-effort: it logs problems but
always exits 0, so a container never fails to start because of it.

1. Checks that each `/persist` directory exists and is writable, creating missing ones and
   printing the fix (`fsGroup: 1000` / `chown 1000:1000`) for unwritable ones.
2. Records Claude's `installMethod: native` in `.claude.json` if missing (`claude doctor`
   warns without it, because the config directory starts empty).
3. Seeds `$CODEX_HOME/config.toml` with a top-level `sandbox_mode = "danger-full-access"`
   only if no top-level `sandbox_mode` is set. codex's bwrap sandbox cannot run inside
   these containers (cbundy/dev-system#19).
4. Pins the codex model no-mistakes uses in `$NM_HOME/config.yaml`, only if no pin exists,
   with the same rules as the callum-tools `codexModel` option. `DEV_CODEX_MODEL` overrides
   the default (the feature's `codexModel` default); `DEV_CODEX_MODEL=""` skips the pin.
5. If gh is logged in, runs `gh auth setup-git`. `~/.gitconfig` is not persisted, so this is
   redone on each start.
6. If `$DEV_WORKSPACE` (default: the current directory) is in a git repo with
   `.no-mistakes.yaml`, starts the no-mistakes daemon (a process, so gone after every
   restart) and runs the callum-tools `recover-no-mistakes.sh` to re-register the repo if
   needed. If git refuses the checkout because another user owns it ("dubious
   ownership"), it warns with the fix instead of skipping silently.
7. If `AGENTSVIEW_PG_URL` is set, starts the agentsview session push (see
   [Central session history](#central-session-history-agentsview)).
8. Runs `dev-doctor --warn-only`.

## `dev-doctor`

`/usr/local/bin/dev-doctor` prints one line per check, `OK` or `FAIL`, with a `fix:` hint
on every failure:

- each `/persist` directory is writable;
- Claude is logged in (`claude auth status`);
- codex is logged in (`codex login status`);
- gh is logged in (`gh auth status`);
- no-mistakes is installed and, inside a repo with `.no-mistakes.yaml`, registered and
  working (any `no-mistakes status` error fails the check);
- git can read the workspace repo (not blocked by "dubious ownership");
- treehouse is on `PATH`;
- agentsview is on `PATH` and, when `AGENTSVIEW_PG_URL` is set, the central database is
  reachable and a push is running (in this container or another one sharing the volume).

It exits 1 if any check fails. `dev-doctor --warn-only` prints the same report and always
exits 0.

## Entrypoint: Claude Code with Remote Control

The image `ENTRYPOINT` is `tini -- dev-entrypoint`, and the default `CMD` is
`dev-remote-control`. A container started without a command comes up with Claude Code
running and Remote Control enabled, so you can drive it from claude.ai or the Claude app
without exec-ing in.

What starts where:

| Runtime | Default | Opt in / out |
|---|---|---|
| `docker run IMAGE`, a Kubernetes pod, a Coder workspace | Claude with Remote Control | `DEV_REMOTE_CONTROL=0` to keep the container up without it |
| Desktop dev container (VS Code, devcontainer CLI) | nothing | `"containerEnv": { "DEV_REMOTE_CONTROL": "1" }` |
| `docker run IMAGE <command>`, a pod with `args:` | `dev-init`, then the command | - |

**`dev-entrypoint`** runs `dev-init` (best-effort, limited to 120s, report on stderr) in
the workspace, then `exec`s the command. With a command, that command runs instead of
Claude, in its own working directory, with its stdout untouched and its exit status
passed through, so `docker run --rm IMAGE dev-doctor` and CI steps work as before. Run as
root (`--user root`), it skips `dev-init`, so nothing root-owned lands in `/persist`.
`tini` as PID 1 forwards `docker stop` / pod deletion to the command at once and reaps
orphaned processes, so containers stop in well under a second instead of hitting the
10s kill timeout.

**`dev-remote-control`** is the supervisor:

1. **Waits for a login.** Remote Control needs a claude.ai subscription login, so while
   `claude auth status` reports none, it logs
   `Claude is not logged in - run: docker exec -it <container> claude auth login` (the
   `kubectl exec` form on Kubernetes) once, then every 10 checks (5 minutes), checking
   every 30s. It starts Claude as soon as the login appears; no restart needed. An API
   key or `CLAUDE_CODE_OAUTH_TOKEN` login gets its own message, since Remote Control
   rejects both.
2. **Pre-answers the start-up dialogs**: it marks the workspace as trusted
   (`projects[<dir>].hasTrustDialogAccepted` in `$CLAUDE_CONFIG_DIR/.claude.json`) and
   onboarding as done. An unattended interactive Claude otherwise sits at the folder trust
   dialog, which comes before anything else.
3. **Runs `claude --remote-control <name>`** in the tmux session `claude`, in the
   workspace. This is the interactive Claude with Remote Control, not the server mode
   (`claude remote-control`): the session you attach to locally is the same one claude.ai
   shows.
4. **Restarts Claude when it exits** (a crash, `/exit`, a restart after an update) with a
   backoff of 5s, doubling to at most 5 minutes, reset once Claude has run for 10 minutes.
   Each start runs `claude` from `PATH`, so a version Claude's auto-updater installed is
   picked up on the next restart.
5. **Stops Claude on SIGTERM**, giving it a few seconds to end its session, then exits 0.

Headless, the supervisor logs to the container log (`docker logs`, `kubectl logs`).

| Variable | Default | Effect |
|---|---|---|
| `DEV_REMOTE_CONTROL` | `1` headless, `0` on the desktop | `0`: start nothing; the container stays up for `docker exec` / `kubectl exec`. On the desktop, `1` starts it. |
| `DEV_REMOTE_CONTROL_NAME` | the hostname | The session name in claude.ai. Docker's hostname is the container ID unless you pass `--hostname`; on Kubernetes it is the pod name. |
| `DEV_REMOTE_CONTROL_SKIP_PERMISSIONS` | `0` | `1` runs Claude with `--dangerously-skip-permissions` (and skips its one-time consent dialog). Only for a container you are happy to let act unsupervised. |
| `DEV_REMOTE_CONTROL_POLL` | `30` | Seconds between login checks. |
| `DEV_WORKSPACE` | the start directory, or `$HOME` if that is `/` | Where `dev-init` and Claude run. Re-read at every Claude start, so a workspace cloned after start-up is used from the next restart. |

**Permissions.** Claude runs in its normal permission mode, so an unattended session
**waits for you to approve** each tool use that needs approval; approve from claude.ai or
the Claude app (or attach locally). Set `DEV_REMOTE_CONTROL_SKIP_PERMISSIONS=1` only if
you accept Claude acting without approvals in that container.

**Attaching locally.** The same session runs in tmux:

```bash
docker exec -it <container> tmux attach -t claude    # detach again with Ctrl-b d
kubectl exec -it <pod> -- tmux attach -t claude
```

Exec as the default user (`node`), not root, or tmux will not find the session. `/exit`
inside the session ends that Claude, and the supervisor starts a new one after the backoff.

**First start, headless:**

```bash
docker run -d --name dev --hostname dev \
  -v dev-system-claude:/persist/claude -v dev-system-codex:/persist/codex \
  -v dev-system-gh:/persist/gh -v dev-system-no-mistakes:/persist/no-mistakes \
  ghcr.io/cbundy/dev-system/base:1
docker logs dev                        # shows the login hint until you log in
docker exec -it dev claude auth login  # Claude starts within 30s, no restart needed
```

**Kubernetes pod spec shape.** Leave `command:` unset: it would replace the entrypoint,
and with it `dev-init`, tini and the default Claude session. Use `args:` for a one-off
command instead, which replaces only the `CMD`:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: dev-my-repo                # also the Remote Control session name
spec:
  securityContext:
    fsGroup: 1000                  # node can write the PVC
  containers:
    - name: dev
      image: ghcr.io/cbundy/dev-system/base:1
      # no command: - the entrypoint runs dev-init and Claude with Remote Control
      # args: ["dev-doctor"]       # a one-off run instead of Claude
      env:
        - name: DEV_WORKSPACE
          value: /workspace/my-repo
      volumeMounts:
        - { name: persist, mountPath: /persist }
        - { name: workspace, mountPath: /workspace }
  volumes:
    - name: persist
      persistentVolumeClaim: { claimName: dev-persist }
    - name: workspace
      persistentVolumeClaim: { claimName: dev-workspace }
```

Log in once with `kubectl exec -it dev-my-repo -- claude auth login`.

**Desktop dev containers are unaffected by default.** The devcontainer CLI and VS Code
replace the image entrypoint with their own (`overrideCommand`, the default for image and
Dockerfile configs), so `dev-entrypoint` never runs there. The metadata's
`postStartCommand` is `dev-init && dev-remote-control --post-start`: `dev-init` runs
exactly as before, and `--post-start` does nothing unless `DEV_REMOTE_CONTROL` is `1`. The
metadata sets it to `0`, and a consumer's `containerEnv` overrides that:

```jsonc
{
  "image": "ghcr.io/cbundy/dev-system/base:1",
  "containerEnv": { "DEV_REMOTE_CONTROL": "1" }
}
```

With it, the supervisor starts in the background at every container start, in the
workspace folder, logging to `/tmp/dev-remote-control.log`. Only one supervisor runs per
container.

## First login

Run these once per machine (or per PVC). The logins land in `/persist`, so they survive
container rebuilds and image updates. On a headless container, run them through
`docker exec -it <container> ...` or `kubectl exec -it <pod> -- ...`.

```bash
claude auth login
codex login --device-auth
gh auth login
dev-init
```

`dev-init` afterwards wires git to gh's credentials straight away instead of on the next
start. Run `dev-doctor` to confirm everything is green.

## Extending the image

Each consumer repo has its own Dockerfile that adds repo-specific tools:

```dockerfile
FROM ghcr.io/cbundy/dev-system/base:1

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3-venv \
  && rm -rf /var/lib/apt/lists/*
USER node
```

Switch back to `USER node` at the end, keep tool binaries out of `/persist`, and don't add a
`VOLUME` for it. Leave `ENTRYPOINT` alone (or keep `tini -- dev-entrypoint` in front of your
own) so `dev-init` and Remote Control keep working.

On the desktop, a thin `.devcontainer/devcontainer.json` is enough:

```jsonc
{
  "name": "my-repo",
  "build": { "dockerfile": "Dockerfile" }
  // or, with no repo-specific tools: "image": "ghcr.io/cbundy/dev-system/base:1"
}
```

The image's metadata label supplies `remoteUser: node`, `updateRemoteUserUID: false`,
`containerEnv` with the `/persist` variables and `DEV_REMOTE_CONTROL: "0"`,
`postStartCommand: dev-init && dev-remote-control --post-start` and these mounts, which the
devcontainer CLI and VS Code merge into your config:

| Named volume | Target |
|---|---|
| `dev-system-claude` | `/persist/claude` |
| `dev-system-codex` | `/persist/codex` |
| `dev-system-gh` | `/persist/gh` |
| `dev-system-no-mistakes` | `/persist/no-mistakes` |
| `dev-system-agentsview` | `/persist/agentsview` |

`updateRemoteUserUID: false` keeps `node` at UID 1000 even on a Linux host whose user has
another UID. Otherwise the devcontainer CLI renumbers `node` to the host UID and it can no
longer write the 1000-owned volumes. On such a host, files `node` creates in a bind-mounted
workspace are owned by UID 1000 on the host.

The volumes are shared by every repo on the same Docker host, so you log in once per
machine. To isolate a repo, list a mount with the same `target` in its `devcontainer.json`;
the consumer's mount replaces the image default. If a consumer Dockerfile sets its own
`devcontainer.metadata` label, it replaces this one, so copy these entries into it.

## Central session history (agentsview)

The image ships [agentsview](https://github.com/kenn-io/agentsview), so every container
can push its Claude and codex sessions to one central place you browse and search. The
transport is agentsview's PostgreSQL sync: each container runs
`agentsview pg push --watch`, which indexes the session files into a local SQLite archive
under `/persist/agentsview` and pushes changes to a shared PostgreSQL; one central
`agentsview pg serve` reads that database. Agents always write to local disk, so a
central outage never blocks them - the push catches up when the database is back.

It is off until you set `AGENTSVIEW_PG_URL`. The image's anonymous telemetry ping and
update check are disabled (`AGENTSVIEW_TELEMETRY_ENABLED=0`,
`AGENTSVIEW_DISABLE_UPDATE_CHECK=1`).

### Central server (once)

Run PostgreSQL with TLS on (`ssl=on` - agentsview refuses a plaintext connection to a
non-local host) and the official viewer image in read-only mode next to it:

```yaml
services:
  agentsview:
    image: ghcr.io/kenn-io/agentsview:0.44.0   # keep in step with AGENTSVIEW_VERSION
    environment:
      PG_SERVE: "1"
      AGENTSVIEW_PG_URL: postgres://agentsview:${PG_PASSWORD}@postgres:5432/agentsview?sslmode=require
    command: ["--host", "0.0.0.0"]
    volumes:
      - agentsview-data:/data   # config.toml with require_auth = true
```

Set `require_auth = true` in the viewer's `config.toml` before exposing it beyond
loopback, and put it behind your reverse proxy or VPN: transcripts carry prompts, tool
output and source excerpts. `pg serve` applies schema migrations itself on start-up.

### Each container

| Variable | Required | Purpose |
|---|---|---|
| `AGENTSVIEW_PG_URL` | yes | `postgres://user:pass@host:5432/agentsview?sslmode=require`. A secret: inject it at run time (k8s Secret, Coder parameter, or `"remoteEnv": { "AGENTSVIEW_PG_URL": "${localEnv:AGENTSVIEW_PG_URL}" }` on the desktop), never in an image. |
| `DEV_MACHINE_NAME` | recommended | Display label for this machine in the viewer, e.g. `desktop` or the workspace name. Without it the label is the container's hostname, which on Docker is a random container ID. |
| `AGENTSVIEW_PG_SCHEMA` | no | Schema name (default `agentsview`). |

`dev-init` then starts the push in the background (log: `/tmp/dev-agentsview-push.log`,
plus agentsview's own `/persist/agentsview/pg-watch.log`), and `dev-doctor` reports
whether the database is reachable and the push is running. `dev-init` also pins the
local agentsview daemon to port 47180 (it falls through to the next free port), so it
never takes 8080 from a repo's own dev server. Edit `/persist/agentsview/config.toml`
for anything else, e.g. `[pg] allow_insecure = true` for a trusted LAN without TLS.

### One machine per volume

A machine in the viewer is an agentsview installation, identified by the installation ID
in `/persist/agentsview`; that is why the directory persists. On a Docker host every
container shares the `dev-system-claude` and `dev-system-agentsview` volumes, so the
host's sessions are one set of files and the host is one machine: agentsview's lock in
the data directory lets one container push at a time, and the push loop in the others
takes over when that container stops. On Kubernetes or Coder, each workspace's PVC is
its own machine. Do not give containers that share a Claude volume separate agentsview
volumes - each would claim the same sessions as a different machine, and the database
keeps only the first claim.

### Upgrading agentsview

The pushers and the server share a database schema, so agentsview is pinned
(`AGENTSVIEW_VERSION` and its checksums in the Dockerfile) rather than refreshed by the
weekly rebuild. To upgrade, bump the version and checksums (from the release's
`SHA256SUMS`), update the central server's image tag to match, and release the image.
Sessions deleted with `agentsview prune` are not removed from PostgreSQL, and
`pg serve` has no live auto-refresh: reload to see new activity.

## Tags and versioning

The image version lives in `images/base/VERSION` (semver). It is independent of the
dev-system release version, in line with independent pinning per layer.

Each publish pushes `1`, `1.0`, `1.0.0`, a dated `1.0.0-YYYYMMDD` and `sha-<short commit>`.

**Tags are mutable.** A weekly scheduled rebuild re-pushes the current version's tags with
fresh OS packages and the latest tools, so `base:1` today is not byte-identical to `base:1`
last week. The dated tag names the day an image was built, and `sha-` names the commit it
was built from; both help find a rollback point, but a rebuild on the same day (dated) or
from the same commit (`sha-`) overwrites them too. **Pin by digest**
(`base@sha256:...`) if you need reproducibility; the publish run's summary lists the
digest it pushed. The same note is in the image's `org.opencontainers.image.description`
label.

`linux/amd64` only for now; arm64 is tracked in cbundy/dev-system#61.

## Building, testing and publishing

Build from the repo root, since the image reuses the callum-tools scripts:

```bash
docker build -f images/base/Dockerfile -t dev-system-base:local .
```

Run the container test suite against it. Test 7 needs the devcontainer CLI; set
`DEVCONTAINER="npx -y @devcontainers/cli"` if it is not installed, or `SKIP_DEVCONTAINER=1`
to skip it. Test 8 starts a throwaway `postgres:17` container to exercise the agentsview
push end to end:

```bash
images/base/test/test.sh dev-system-base:local
```

`.github/workflows/publish-base-image.yml`:

- **Pull requests** touching `images/base/`, `features/src/callum-tools/` or the workflow
  build and test the image. Nothing is pushed.
- **Manual dispatch** on `main` (Actions tab, or `gh workflow run publish-base-image.yml`)
  is the deliberate release: build, test, push the tags for the current `VERSION`. A
  dispatch from any other branch fails, since it would overwrite the mutable tags.
- **Weekly schedule** rebuilds and re-pushes the current `VERSION`'s tags, but only once
  that version has been released by hand, so merging a `VERSION` bump never publishes it
  by itself. A failed check fails the run rather than skipping the week.
- The image is built once and tested; the push sends that same tested image.

**Visibility:** the package is public, so consumers pull it with no login. It took the
visibility of this public repo when the first dispatch created it (1.0.0, 2026-10-03), so
there is no manual step; see "Visibility decision" in the root README.
