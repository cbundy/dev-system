# dev-system base image

`ghcr.io/cbundy/dev-system/base` is a prebuilt agent dev environment: Node LTS, the agent
CLIs and Callum's flow tooling baked in, plus a fixed contract for where tool state
persists. The same image runs on the desktop (through a thin `devcontainer.json`) and on
the homelab (as a Kubernetes pod, a Coder workspace or a plain `docker run`), with no
devcontainer tooling needed at run time. A fixed mount point, `/shared`, takes an optional
NAS share for files exchanged with the PC.

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
4. The `/shared` mount point for NAS file sharing (below). The image defines it but
   mounts nothing there.
5. `dev-init`, the idempotent start-up setup for state that cannot be baked in.
6. `dev-doctor`, a health check that reports missing auth or broken state loudly.
7. `dev-login`, which starts the logins for you and brings the sign-in links to the
   container log, an optional login page and an optional push notification (see
   [First-run logins](#first-run-logins)).
8. Default devcontainer metadata (the `devcontainer.metadata` image label), so desktop use
   gets the shared gh volume and `dev-init` automatically.
9. An entrypoint that runs `dev-init` and, on headless runtimes, keeps Claude Code running
   with Remote Control (below).

The callum-tools watcher scripts (`pipeline-watch.sh`, `queue-watch.sh`) are staged at
`/usr/local/share/callum-tools/`, the same path the feature uses, so the `callum-flow`
orchestrator skill works unchanged.

## What the image does not own

These belong to the consumer image or the runtime:

- Repo-specific tools (Terraform, Python stacks, Docker CLI and so on). Add them in the
  consumer's Dockerfile.
- Secrets or credentials of any kind. The image is public.
- Where volumes come from (Docker named volume, k8s PVC, host bind, the NAS share). The
  image only defines the mount points.
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

### What is shared and what is per repo

Only `/persist/gh` is shared between repos. Every other directory is per repo (or per
workspace): one volume each for a repo's containers, never shared with another repo.
Sharing those breaks:

| Directory | What breaks when two repos share it |
|---|---|
| `/persist/no-mistakes` | It holds the daemon's lock, PID file, socket and SQLite database. One container's daemon would serve every repo, with only its own toolchain and in its own PID namespace, and die when that container stops. `config.yaml` changes would leak between repos. |
| `/persist/claude` | Session files are named by PID, and every container has its own PID namespace, so two Claudes can collide. Trust, onboarding and all history would be mixed across repos. |
| `/persist/codex` | Its SQLite state, `sessions/` and `history` would be mixed across repos. |
| `/persist/agentsview` | Its installation ID is the machine in the viewer, so it must follow the Claude and codex volumes (see [One machine per workspace](#one-machine-per-workspace)). |

The logins cannot be split out and shared on their own. Claude and codex keep them next to
the rest of their state (`.credentials.json`, `auth.json`), with no separate path setting.
A symlink to a shared file is replaced on the first token refresh, since Claude writes the
file atomically. Copies seeded from one login share a refresh token, so the first container
to refresh can invalidate the others. `CLAUDE_CODE_OAUTH_TOKEN` is shareable, but Remote
Control refuses it. Several logins on one account are fine: each is its own grant, like
logging in on several machines. So the cost of per-repo state is one Claude login and one
codex login per repo (or workspace), kept after that. gh is the exception: `hosts.yml`
holds a token that is rarely rewritten, and the whole directory is mounted, so sharing it
is safe.

### How runtimes should mount it

- **Docker (desktop)**: one named volume per directory. `dev-system-gh` is shared by every
  repo and comes from the image's devcontainer metadata; the other four are per repo and
  come from the consumer's `devcontainer.json`, named after its `${devcontainerId}` (see
  [Extending the image](#extending-the-image)). A new named volume copies the image
  directory's ownership on first use, which is why the directories exist in the image
  owned by 1000.
- **Docker (headless: `docker run`, compose)**: the same split by hand - per-project volumes
  for claude, codex, no-mistakes and agentsview, plus the shared `dev-system-gh`. See
  [First start, headless](#first-start-headless).
- **Kubernetes / Coder**: one PVC per workspace mounted at `/persist`, with
  `securityContext.fsGroup: 1000` so `node` can write to it. `dev-init` creates any missing
  subdirectory on first start. gh is per workspace too, unless the runtime supplies
  `GH_TOKEN` instead (Coder external auth).
- **Host bind mounts** work if the host directory is writable by UID 1000. Avoid binding a
  Windows-side directory (`${localEnv:USERPROFILE}`) under WSL: permissions and the
  no-mistakes daemon socket do not behave there (cbundy/dev-system#19). Use named volumes.

If a directory is not writable, `dev-init` prints a warning naming the fix and `dev-doctor`
fails that check. If it is writable but has no volume behind it (its state is lost with the
container), `dev-doctor` warns.

## Shared files (`/shared`)

`/shared` is the place for files that sit **beside** the code and should be reachable from
both the PC and the container: build artifacts, exported data, screenshots, handoff docs.
The image sets `DEV_SHARED_DIR=/shared` (also in the devcontainer metadata's
`containerEnv`), so scripts and agents use `$DEV_SHARED_DIR` instead of hard-coding the
path, and publishes it as the image label `dev.cbundy.shared=/shared` for runtimes and
templates. The directory exists in the image, owned `1000:1000` with mode `0755`, and
ships empty. As with `/persist`, there is no `VOLUME` instruction.

It is **not** for:

- **Repo checkouts.** git on SMB or NFS is slow, its locking is unreliable, and a repo
  reached over SMB and NFS at once can be corrupted. Keep the checkout on a local disk or
  volume.
- **Tool state.** That is `/persist`. no-mistakes keeps a SQLite database and a Unix
  socket there, and neither works reliably over NFS.

**Nothing is mounted by default.** The NAS address and export are site-specific, so the
consumer's config or the runtime supplies the mount. Unmounted, `/shared` is an empty
local directory, `dev-init` says nothing and `dev-doctor` reports
`/shared not mounted (optional)`. Mounted, `dev-doctor` reports
`/shared mounted and writable`; if `node` cannot write it, `dev-init` warns and
`dev-doctor` fails, both with the fix.

### NAS side

One dataset, exported over SMB for the PC and over NFS for containers. On the homelab
(cbundy/network#136) that is `ssd1/dev` on `nas2.buddycloud.net` (192.168.1.114):

- **SMB:** `\\nas2.buddycloud.net\dev`, mapped as a drive on the PC as the user `dev`.
- **NFS:** `/mnt/ssd1/dev`. Each repo has a plain directory, `/mnt/ssd1/dev/<repo-name>`,
  and its containers mount only that. Create the directory (from the mapped drive, say)
  before the first mount; an NFS mount of a missing path fails.

Ownership must work for UID 1000 in the container. nas2 squashes every NFS client to the
`dev` user and the `docker_users` group (TrueNAS: Mapall User / Mapall Group), so the
container's UID does not matter: every write lands as `dev:docker_users`, and the NAS does
the permission check. The alternative is a dataset owned by UID/GID 1000 (Linux exports:
`all_squash,anonuid=1000,anongid=1000`). Use the NAS's mixed permission mode for the
dataset (TrueNAS: NFSv4 ACLs and a Multi-protocol SMB share), so Windows ACLs and Unix
modes do not conflict and the PC does not cache a file a container is changing.

### Docker (desktop)

One NFS-backed named volume per repo:

```bash
docker volume create --driver local \
  --opt type=nfs --opt o=addr=192.168.1.114,rw,nfsvers=4 \
  --opt device=:/mnt/ssd1/dev/my-repo \
  nas-my-repo
```

Docker mounts the share when a container starts, not when the volume is created, so a
wrong address or path shows up only then. Mount it in the consumer's `devcontainer.json`:

```jsonc
{
  "image": "ghcr.io/cbundy/dev-system/base:2",
  "mounts": ["source=nas-my-repo,target=/shared,type=volume,volume-nocopy"]
}
```

or with `docker run --mount type=volume,source=nas-my-repo,target=/shared,volume-nocopy`.
Keep `volume-nocopy`, which needs the string form of a `devcontainer.json` mount. Without
it, the first time Docker mounts an empty volume it copies the image's `/shared` into it,
ownership included, and on an export squashed to another user that `chown` is refused,
so the container does not start.

Docker Desktop on WSL mounts the share from its own VM, not from Windows or your WSL
distro, so the NAS must be reachable from there.

### Kubernetes / Coder

An NFS PersistentVolume (or a claim from the NFS CSI driver) with `ReadWriteMany`, mounted
at `/shared` with `subPath: <repo-name>`:

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: nas-dev
spec:
  capacity: { storage: 200Gi }
  accessModes: [ReadWriteMany]
  persistentVolumeReclaimPolicy: Retain
  mountOptions: [nfsvers=4]
  nfs: { server: 192.168.1.114, path: /mnt/ssd1/dev }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: nas-dev
spec:
  accessModes: [ReadWriteMany]
  storageClassName: ""
  volumeName: nas-dev
  resources: { requests: { storage: 200Gi } }
```

and in the pod spec (see the shape under "Entrypoint" below):

```yaml
      volumeMounts:
        - { name: shared, mountPath: /shared, subPath: my-repo }
  volumes:
    - name: shared
      persistentVolumeClaim: { claimName: nas-dev }
```

`fsGroup` does not change ownership on NFS; the NAS's squashing is what makes it writable.

### Usage

- Treat it as an exchange area: one side writes a file, the other reads it. Don't edit the
  same file from the PC and a container at the same time.
- Copy build artifacts in under a per-build directory, so builds never overwrite each
  other:

  ```bash
  dest="$DEV_SHARED_DIR/artifacts/$(git branch --show-current | tr / -)-$(git rev-parse --short HEAD)"
  mkdir -p "$dest" && cp -r dist/. "$dest/"
  ```

- File watchers do not fire on NFS for changes made elsewhere (the PC, another container).
  Poll, or re-run by hand.

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
8. If `$DEV_SHARED_DIR` is mounted but not writable by `node`, warns with the fix. Not
   mounted is fine; it is optional.
9. If `DEV_LOGIN_PORT` is set, starts the login page in the background (see
   [First-run logins](#first-run-logins)).
10. Runs `dev-doctor --warn-only`.

## `dev-doctor`

`/usr/local/bin/dev-doctor` prints one line per check, `OK` or `FAIL`, with a `fix:` hint
on every failure:

- each `/persist` directory is writable, with a `WARN` (not a failure) when it is not on a
  volume, so its state is lost with the container;
- `/shared`: `mounted and writable`, `not mounted (optional)` (both OK), or a failure when
  it is mounted but not writable;
- Claude, codex and gh are logged in (`claude auth status`, `codex login status`,
  `gh auth status`), each with the hint `run: dev-login start` (or the login page, when
  `DEV_LOGIN_PORT` is set). A tool left out of `DEV_LOGIN_TOOLS` is not required to be;
  gh with `GH_TOKEN` set counts as logged in;
- no-mistakes is installed and, inside a repo with `.no-mistakes.yaml`, registered and
  working (any `no-mistakes status` error fails the check);
- git can read the workspace repo (not blocked by "dubious ownership");
- treehouse is on `PATH`;
- agentsview is on `PATH` and, when `AGENTSVIEW_PG_URL` is set, the central database is
  reachable and a push is running (in this container or another one sharing the volume).

It exits 1 if any check fails; `WARN` lines do not count. `dev-doctor --warn-only` prints
the same report and always exits 0.

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

1. **Starts the logins and waits for Claude's.** It runs `dev-login watch` in the
   background, which starts every missing login in `DEV_LOGIN_TOOLS` and logs its sign-in
   link (see [First-run logins](#first-run-logins)). Remote Control needs a claude.ai
   subscription login, so while `claude auth status` reports none, it logs
   `Claude is not logged in - open the sign-in link dev-login logs (or the login page), then paste the code: docker exec -it <container> dev-login <code>`
   (the `kubectl exec` form on Kubernetes) once, then every 10 checks (5 minutes),
   checking every 30s. It starts Claude as soon as the login appears; no restart needed.
   An API key or `CLAUDE_CODE_OAUTH_TOKEN` login gets its own message, since Remote
   Control rejects both, and `dev-login` leaves it alone.
2. **Pre-answers the start-up dialogs**: it marks the workspace as trusted
   (`projects[<dir>].hasTrustDialogAccepted` in `$CLAUDE_CONFIG_DIR/.claude.json`) and
   onboarding as done. An unattended interactive Claude otherwise sits at the folder trust
   dialog, which comes before anything else.
3. **Runs Claude with Remote Control** in the tmux session `claude`, in the workspace,
   in one of two modes (`DEV_REMOTE_CONTROL_MODE`):
   - `session` (default): `claude --remote-control <name>`, the interactive Claude. The
     session you attach to locally is the same one claude.ai shows.
   - `server`: `claude remote-control --name <name> --spawn worktree`. The container
     shows up as an environment in claude.ai / the Claude app; each session you start
     there runs its own Claude in its own git worktree of the workspace. Attaching to
     tmux shows only the server, not a conversation. Worktree mode needs the workspace
     to be a git repository; if it is not, the sessions share the workspace instead
     (`--spawn same-dir`, with a warning in the log). Claude pre-creates one session in
     the workspace itself; only the sessions started after it get a worktree.
4. **Restarts Claude when it exits** (a crash, `/exit`, a restart after an update) with a
   backoff of 5s, doubling to at most 5 minutes, reset once Claude has run for 10 minutes.
   Each start runs `claude` from `PATH`, so a version Claude's auto-updater installed is
   picked up on the next restart.
5. **Stops Claude on SIGTERM**, giving it a few seconds to end its session, then exits 0.

Headless, the supervisor logs to the container log (`docker logs`, `kubectl logs`).

| Variable | Default | Effect |
|---|---|---|
| `DEV_REMOTE_CONTROL` | `1` headless, `0` on the desktop | `0`: start nothing; the container stays up for `docker exec` / `kubectl exec`. On the desktop, `1` starts it. |
| `DEV_REMOTE_CONTROL_MODE` | `session` | `server` runs `claude remote-control` (many sessions, one worktree each) instead of one interactive session. See step 3 above. |
| `DEV_REMOTE_CONTROL_NAME` | the workspace's repo name | The session name in claude.ai (the environment name in `server` mode). By default the repo name from the workspace's `origin` URL (`dev-system` for `github.com/cbundy/dev-system`), else the name of its git top-level directory, else (no git repo) the hostname: the container ID under Docker unless you pass `--hostname`, the pod name on Kubernetes. Worked out at every Claude start. |
| `DEV_REMOTE_CONTROL_SKIP_PERMISSIONS` | `0` | `1` runs Claude with `--dangerously-skip-permissions` (and skips its one-time consent dialog); in `server` mode, with `--permission-mode bypassPermissions` for the sessions it spawns, and `bypassPermissionsModeAccepted` set in `.claude.json`, since `claude remote-control` takes no `--settings` to skip the dialog per run. Only for a container you are happy to let act unsupervised. |
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

#### First start, headless

Per-project volumes for everything but gh (see
[What is shared and what is per repo](#what-is-shared-and-what-is-per-repo)), here for a
project called `my-repo`:

```bash
docker run -d --name my-repo \
  -v my-repo-claude:/persist/claude -v my-repo-codex:/persist/codex \
  -v my-repo-no-mistakes:/persist/no-mistakes -v my-repo-agentsview:/persist/agentsview \
  -v dev-system-gh:/persist/gh \
  ghcr.io/cbundy/dev-system/base:2
docker logs my-repo                          # the sign-in links for Claude, codex and gh
docker exec my-repo dev-login <code>         # the code Claude's sign-in page shows
```

Claude starts within 30s of the login, no restart needed. Approving codex's and gh's
codes is enough for those. For the login page instead, add `-e DEV_LOGIN_PORT=8765` and
reach it through a reverse proxy (see [Several containers: one nginx route](#several-containers-one-nginx-route)).
For a single container on a LAN, `-p 8765:8765 -e DEV_LOGIN_PORT=8765` also works (LAN or
VPN only: see [Security](#security)); a second container then needs another host port
(`-p 8766:8765`), which the proxy avoids.

The same with docker compose. Compose prefixes volume names with the project name, which
keeps the four per-project volumes apart from other projects'; `name:` turns that off for
the shared gh volume, so every project uses the same `dev-system-gh`:

```yaml
services:
  dev:
    image: ghcr.io/cbundy/dev-system/base:2
    environment:
      DEV_WORKSPACE: /workspace/my-repo
    volumes:
      - claude:/persist/claude
      - codex:/persist/codex
      - no-mistakes:/persist/no-mistakes
      - agentsview:/persist/agentsview
      - gh:/persist/gh
      - workspace:/workspace
volumes:
  claude:
  codex:
  no-mistakes:
  agentsview:
  workspace:
  gh:
    name: dev-system-gh   # shared by every project on this Docker host
```

**Kubernetes pod spec shape.** Leave `command:` unset: it would replace the entrypoint,
and with it `dev-init`, tini and the default Claude session. Use `args:` for a one-off
command instead, which replaces only the `CMD`:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: dev-my-repo                # the Remote Control name is the repo name, my-repo
spec:
  securityContext:
    fsGroup: 1000                  # node can write the PVC
  containers:
    - name: dev
      image: ghcr.io/cbundy/dev-system/base:2
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

The sign-in links are in `kubectl logs dev-my-repo`; finish Claude's with
`kubectl exec dev-my-repo -- dev-login <code>`, or set `DEV_LOGIN_PORT` and reach the
page through a Service or `kubectl port-forward`.

**Desktop dev containers are unaffected by default.** The devcontainer CLI and VS Code
replace the image entrypoint with their own (`overrideCommand`, the default for image and
Dockerfile configs), so `dev-entrypoint` never runs there. The metadata's
`postStartCommand` is `dev-init && dev-remote-control --post-start`: `dev-init` runs
exactly as before, and `--post-start` does nothing unless `DEV_REMOTE_CONTROL` is `1`. The
metadata sets it to `0`, and a consumer's `containerEnv` overrides that:

```jsonc
{
  "image": "ghcr.io/cbundy/dev-system/base:2",
  "containerEnv": { "DEV_REMOTE_CONTROL": "1" }
}
```

With it, the supervisor starts in the background at every container start, in the
workspace folder, logging to `/tmp/dev-remote-control.log`. Only one supervisor runs per
container.

## First-run logins

Each repo on the desktop (each PVC on Kubernetes or Coder) needs one Claude login and one
codex login; gh needs one per Docker host, since its volume is shared. The logins land in
`/persist`, so they survive container rebuilds and image updates. `dev-login` does them
without a shell in the container:

1. The container starts and sees that Claude, codex or gh is not logged in.
2. It starts their logins and brings you the sign-in links: in the container log, on the
   login page (opt-in) and in a push notification (opt-in).
3. You approve on any device, a phone included. For Claude, paste the code its sign-in page
   shows into the login page (or `dev-login <code>`). For codex and gh, approving is
   enough.
4. The supervisor sees Claude's login and starts Remote Control.

| Tool | Login | What you do |
|---|---|---|
| Claude | `claude auth login --claudeai`: a sign-in link. There is no device-code flow for claude.ai logins. | Open the link, approve, paste the code shown back. A wrong code ends that attempt, and the next one has a new link. |
| codex | `codex login --device-auth`: a link and a one-time code, valid 15 minutes. | Open the link and enter the code. Device-code login may first need turning on in your ChatGPT account's security settings. |
| gh | `gh auth login --web`: a link and a one-time code; then `gh auth setup-git`. | Open the link and enter the code. On Coder, external auth (`GH_TOKEN`) replaces it. |

Each login runs in its own tmux session (`login-claude`, `login-codex`, `login-gh`), so
`tmux attach -t login-codex` shows it as it is. An attempt in progress is kept, so a link
you were given stays valid; one that ended (an expired code, a rejected paste) is
replaced, so there is always a fresh link. The supervisor (`dev-remote-control`) runs
`dev-login watch`, which does that every 15 seconds and logs each new link once, until
every login is done. On the desktop, where the supervisor is off by default, run
`dev-login start` in a terminal instead.

```text
dev-login status [--json]   each tool: in, out, other (Claude logged in, but not with
                            claude.ai), token (gh: GH_TOKEN) or off (not in DEV_LOGIN_TOOLS)
dev-login start [--json]    start the missing logins, print the links
dev-login <code>            finish Claude's login (also: dev-login claude <code>)
dev-login watch             what the supervisor runs: keep starting, log, notify
dev-login serve             the login page (dev-init starts it when DEV_LOGIN_PORT is set)
```

| Variable | Default | Effect |
|---|---|---|
| `DEV_LOGIN_TOOLS` | `claude,codex,gh` | The tools to log in. A workspace that never uses codex sets `claude,gh`. `dev-doctor` does not require a login for a tool left out. gh is skipped when `GH_TOKEN` or `GITHUB_TOKEN` is set. Empty: `dev-login watch` is not started. |
| `DEV_LOGIN_PORT` | unset: no page | The port the login page listens on, on all interfaces (`0.0.0.0`). Publish it only where [Security](#security) allows. |
| `DEV_LOGIN_PAGE_EXIT` | `1` | `1`: the page exits once every login is done (Docker, LAN). `0` keeps it up, showing each tool's state (behind Coder, so the app button always works). |
| `DEV_LOGIN_PAGE_URL` | unset | The page's address as you reach it (the Coder app URL, say), for the log and the notification. There is no reliable way to work it out from inside. |
| `DEV_NOTIFY_URL` | unset | Where to POST a notification when logins are needed: an [ntfy](https://ntfy.sh) topic URL, or anything that takes a POST body. |

**The login page** (`DEV_LOGIN_PORT`) has one card per tool: Claude's "Open sign-in page"
button and a box for the code; codex's and gh's link and code; a tick once a tool is
logged in. It refreshes itself when a login completes elsewhere, and `GET /healthz`
returns 200 while it is up, for a health check. Its log is `/tmp/dev-login-page.log`.
Every link, form and redirect on it is relative, so it works at `/` and under any path
prefix a proxy strips (a Coder path-based app, the nginx route below), as long as the
address ends in `/`.

**The notification** (`DEV_NOTIFY_URL`) is a plain POST, sent when logins are first
needed and then hourly while they still are. Its `Title` header is
`Log in to <tools> (<name>)`, where the name is the Remote Control name; the body is
`DEV_LOGIN_PAGE_URL` if set, else the links and codes. ntfy opens the `Click` header's
link (the page, or the first sign-in link) when you tap it. A failed POST only logs a
warning. The URL is never logged, so it may carry an access token.

By hand, the CLIs' own logins still work (`claude auth login`, `codex login --device-auth`,
`gh auth login`, then `dev-init` to wire git to gh straight away). Run `dev-doctor` to
confirm everything is green.

### Several containers: one nginx route

Publishing each page to the host (`-p`) clashes on the host port as soon as there are two
containers. Inside the containers there is no clash: each has its own network namespace,
so every one listens on 8765. Put the dev containers and one nginx on a shared Docker
network, publish nothing from the dev containers, and let one rule reach every container
by name, with no per-container config:

```nginx
server {
    listen 443 ssl;
    # ... certificate, and authentication: see below
    absolute_redirect off;

    # /login/<name> -> /login/<name>/, so the page's relative links resolve
    location ~ ^/login/(?<ws>[a-z0-9-]+)$ { return 308 $uri/; }

    location ~ ^/login/(?<ws>[a-z0-9-]+)/(?<rest>.*)$ {
        resolver 127.0.0.11 valid=10s;   # Docker's embedded DNS: container names
        proxy_pass http://$ws:8765/$rest$is_args$args;
    }
}
```

```bash
docker network create dev
docker run -d --name login-proxy --network dev -p 443:443 \
  -v "$PWD/login.conf:/etc/nginx/conf.d/default.conf:ro" nginx   # plus the certificate
docker run -d --name my-repo --network dev \
  -e DEV_LOGIN_PORT=8765 -e DEV_LOGIN_PAGE_URL=https://<host>/login/my-repo/ \
  -v my-repo-claude:/persist/claude -v my-repo-codex:/persist/codex \
  -v my-repo-no-mistakes:/persist/no-mistakes -v my-repo-agentsview:/persist/agentsview \
  -v dev-system-gh:/persist/gh \
  ghcr.io/cbundy/dev-system/base:2
```

Each container sets `DEV_LOGIN_PAGE_URL` to its own `https://<host>/login/<container-name>/`,
so its log line and notification link to its own page. Container names must match the
rule's `[a-z0-9-]+`.

The route needs its own access control, in line with [Security](#security): basic auth
(`auth_basic`) or LAN / VPN only (`allow` / `deny`), and nginx on the dev-container network
only, so the rule can reach nothing else by name. Without that, anyone who reaches nginx
reaches every container's page.

**Coder** path-based apps (`/@user/workspace.agent/apps/login/`) need nothing extra:
Coder strips the prefix and redirects the address without a trailing slash to the one
with it, so `subdomain = false` is fine.

### Security

- The page only feeds codes to logins this container started itself. Claude's uses PKCE,
  and the verifier never leaves the `claude` process, so someone who reaches the page
  **cannot** get your tokens.
- The worst case is someone who reaches the page logging the container into **their**
  account (or approving a codex or gh code with theirs). So the page is opt-in, and belongs
  on a LAN, a VPN, behind Coder's authenticated app proxy or behind a reverse proxy with
  its own authentication, never published to the internet.
- It accepts nothing but a form POST of the code, limited to 4 KiB, and `dev-login` only
  passes on a code of printable characters, so a code cannot press keys in the login's
  terminal. The page shows no credentials and no status beyond whether each tool is
  logged in.
- The notification carries the sign-in links (unless `DEV_LOGIN_PAGE_URL` is set), so the
  same applies to it: use a private ntfy topic, or one that needs an access token.

## Extending the image

Each consumer repo has its own Dockerfile that adds repo-specific tools:

```dockerfile
FROM ghcr.io/cbundy/dev-system/base:2

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3-venv \
  && rm -rf /var/lib/apt/lists/*
USER node
```

Switch back to `USER node` at the end, keep tool binaries out of `/persist`, and don't add a
`VOLUME` for it. Leave `ENTRYPOINT` alone (or keep `tini -- dev-entrypoint` in front of your
own) so `dev-init` and Remote Control keep working.

On the desktop, a thin `.devcontainer/devcontainer.json` with the per-repo state volumes is
enough:

```jsonc
{
  "name": "my-repo",
  "build": { "dockerfile": "Dockerfile" },
  // or, with no repo-specific tools: "image": "ghcr.io/cbundy/dev-system/base:2"
  "mounts": [
    // Per-repo tool state. Keep these four as they are: ${devcontainerId} is
    // stable for this workspace folder and unique to it.
    { "type": "volume", "source": "dev-system-${devcontainerId}-claude", "target": "/persist/claude" },
    { "type": "volume", "source": "dev-system-${devcontainerId}-codex", "target": "/persist/codex" },
    { "type": "volume", "source": "dev-system-${devcontainerId}-no-mistakes", "target": "/persist/no-mistakes" },
    { "type": "volume", "source": "dev-system-${devcontainerId}-agentsview", "target": "/persist/agentsview" }
  ]
}
```

The image's metadata label supplies `remoteUser: node`, `updateRemoteUserUID: false`,
`containerEnv` with the `/persist` variables, `DEV_SHARED_DIR` and `DEV_REMOTE_CONTROL: "0"`,
`postStartCommand: dev-init && dev-remote-control --post-start` and the shared gh volume,
which the devcontainer CLI and VS Code merge into your config:

| Named volume | Target | Scope |
|---|---|---|
| `dev-system-gh` | `/persist/gh` | every repo on the Docker host (image metadata) |
| `dev-system-<devcontainerId>-claude` | `/persist/claude` | this repo (your `devcontainer.json`) |
| `dev-system-<devcontainerId>-codex` | `/persist/codex` | this repo (your `devcontainer.json`) |
| `dev-system-<devcontainerId>-no-mistakes` | `/persist/no-mistakes` | this repo (your `devcontainer.json`) |
| `dev-system-<devcontainerId>-agentsview` | `/persist/agentsview` | this repo (your `devcontainer.json`) |

The per-repo mounts cannot come from the image: the devcontainer CLI expands no variables
in image metadata (`${devcontainerId}` comes out empty), so every repo would get the same
volumes. Leave them out and that state lives in the container itself, lost on every
rebuild; `dev-doctor` warns about it. `${devcontainerId}` is derived from the workspace
folder, so a second clone of the same repo gets its own volumes, and a moved or renamed
clone starts with new, empty ones (one more login).

To list a repo's volumes: `docker volume ls --filter name=dev-system-`. To delete a repo's
state, remove its four volumes once its container is gone.

`updateRemoteUserUID: false` keeps `node` at UID 1000 even on a Linux host whose user has
another UID. Otherwise the devcontainer CLI renumbers `node` to the host UID and it can no
longer write the 1000-owned volumes. On such a host, files `node` creates in a bind-mounted
workspace are owned by UID 1000 on the host.

To give a repo its own gh login too, list a mount with the target `/persist/gh` in its
`devcontainer.json`; the consumer's mount replaces the image default. If a consumer
Dockerfile sets its own `devcontainer.metadata` label, it replaces this one, so copy these
entries into it.

### Moving from 1.x

Image 1.x's metadata mounted the shared `dev-system-claude`, `-codex`, `-no-mistakes` and
`-agentsview` volumes into every repo. 2.0 drops them:

1. Add the four per-repo mounts above to each repo's `devcontainer.json` and move it to
   `base:2`.
2. Rebuild. The new volumes start empty, so log Claude and codex in once in each repo.
   gh keeps its login (`dev-system-gh` is unchanged).
3. The old volumes are left in place. Delete them by hand once you no longer need them:
   `docker volume rm dev-system-claude dev-system-codex dev-system-no-mistakes dev-system-agentsview`.

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

### One machine per workspace

A machine in the viewer is an agentsview installation, identified by the installation ID
in `/persist/agentsview`; that is why the directory persists. The agentsview volume
follows the Claude and codex volumes, so each repo on the desktop (each `devcontainerId`)
and each Kubernetes or Coder workspace is its own machine. Set `DEV_MACHINE_NAME` to tell
them apart in the viewer - the repo or workspace name, say. Containers that do share a
Claude volume (several containers of one compose project, for example) must share its
agentsview volume too: they are then one machine, agentsview's lock in the data directory
lets one container push at a time, and the push loop in the others takes over when that
container stops. Separate agentsview volumes there would each claim the same sessions as a
different machine, and the database keeps only the first claim.

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
