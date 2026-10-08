# dev-system base image

`ghcr.io/cbundy/dev-system/base` is a prebuilt agent dev environment: Node LTS, the agent
CLIs, Callum's flow tooling and uv (the Python bootstrapper) baked in, plus a fixed contract for where tool state
persists. The same image runs on the desktop (through a thin `devcontainer.json`) and on
the homelab (as a Kubernetes pod, a Coder workspace or a plain `docker run`), with no
devcontainer tooling needed at run time. A fixed mount point, `/shared`, takes an optional
NAS share for files exchanged with the PC.

It replaces the `callum-tools` Dev Container Feature, which is deprecated
(cbundy/dev-system#89): new environment work goes here, not into the feature. The image
still builds from the feature's scripts (`features/src/callum-tools/`) rather than forking
them, so those scripts stay maintained.

## What the image owns

1. A non-root user, `node` (UID/GID 1000), with passwordless sudo, home `/home/node` and
   `~/.local/bin` first on `PATH`.
2. The agent toolchain, installed at build time with nothing downloaded at container start:

   | Tool | Installed via | Updates |
   |---|---|---|
   | Node LTS + npm | base image (`mcr.microsoft.com/devcontainers/javascript-node:24-trixie`) | image rebuild |
   | Claude Code | Anthropic's native installer, as `node` | **auto-updates in the running container** |
   | codex | `npm i -g @openai/codex`, as `node` (npm prefix is node-owned) | `npm i -g` as `node`, or image rebuild |
   | no-mistakes | its install script, as `node` (unpinned, so each image rebuild takes the latest; the synced `pr:` block needs 1.75.0 or newer) | `no-mistakes update`, or image rebuild |
   | treehouse | its install script, as `node` | image rebuild |
   | uv (and `uvx`) | its install script, as `node` | `uv self update`, or image rebuild |
   | gh | official GitHub CLI apt repo | image rebuild |
   | agentsview | pinned release tarball, checksum-verified | bump `AGENTSVIEW_VERSION` in the Dockerfile |
   | git | base image | image rebuild |

   Also `jq`, `ripgrep`, `shellcheck` (shell linting), `tmux` (Claude's Remote Control session runs in it), `tini`
   (PID 1), `less` and `openssh-client`. No systemd runs in the container, and `systemctl`
   says so and fails (the devcontainers base image's own stub reports success, which sent
   no-mistakes after a service that never starts - cbundy/dev-system#101). Every tool binary lives outside `/persist`, so a new image always
   brings fresh binaries.
3. The persistence contract (below).
4. The `/shared` mount point for NAS file sharing (below). The image defines it but
   mounts nothing there.
5. The `/workspaces` mount point for repo checkouts, and the first-start clone of the
   repo named by `DEV_REPO_URL` (see [Workspace and repo](#workspace-and-repo)).
6. `dev-init`, the idempotent start-up setup for state that cannot be baked in.
7. `dev-doctor`, a health check that reports missing auth or broken state loudly.
   `dev-prune-worktrees` removes stale Claude bridge worktrees (see
   [`dev-prune-worktrees`](#dev-prune-worktrees)).
8. `dev-login`, which starts the logins for you and brings the sign-in links to the
   container log, an optional login page and an optional push notification (see
   [First-run logins](#first-run-logins)).
9. Default devcontainer metadata (the `devcontainer.metadata` image label), so desktop use
   gets the shared gh and secrets volumes and `dev-init` automatically.
10. The `/run/secrets/dev-system` mount point (`DEV_SECRETS_DIR`) for secrets the runtime
    supplies read-only, such as the agentsview URL (see
    [Central session history](#central-session-history-agentsview)). The image itself
    never contains one.
11. An entrypoint that runs `dev-init` and, on headless runtimes, keeps Claude Code running
    with Remote Control (below).
12. Opt-in OpenTelemetry export for Claude Code and codex, on only when the runtime sets
    `OTEL_EXPORTER_OTLP_ENDPOINT` (see [Telemetry](#telemetry-opentelemetry-export)).

The callum-tools watcher scripts (`pipeline-watch.sh`, `queue-watch.sh`) are staged at
`/usr/local/share/callum-tools/`, the same path the feature uses, so the `callum-flow`
orchestrator skill works unchanged. By default each prints one event line and exits; with
`--stream` it keeps running and prints one line per change, for a harness that turns each
output line into an event (Claude Code's Monitor tool). The scripts' headers document both
modes.

`usage-check.sh`, staged beside them, prints the Claude plan's 5-hour and weekly usage as
one line (`five_hour=<pct> resets_at=<time> ... seven_day=<pct> ...`) for the orchestrator's
usage gate. It reads the claude.ai usage endpoint with the logged-in OAuth token, falls back
to a recent status line snapshot (its `--record` mode is a status line command), and prints
`usage=unavailable reason=...` when neither answers. It spends no model tokens and runs no
background process. Only the image ships it, not the deprecated feature.

## What the image does not own

These belong to the consumer image or the runtime:

- Repo-specific tools (Terraform, Docker CLI, a full Python stack such as a pinned
  CPython, system libraries or a database client, and so on). Add them in the
  consumer's Dockerfile. The Python bootstrapper is in base, though: uv runs a Python
  repo's gates with no image of its own (see [Extending the image](#extending-the-image)).
- Secrets or credentials of any kind. The image is public.
- Where volumes come from (Docker named volume, k8s PVC, host bind, the NAS share). The
  image only defines the mount points.
- The checkout itself. The image carries at most the repo's URL (`DEV_REPO_URL`, set by
  CI in a consumer image) and clones it on first start; the checkout is work in progress
  and lives on the runtime's workspace volume, never in the image.
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

Only `/persist/gh` can be shared between repos. Every other directory is per repo (or per
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
- **Kubernetes**: one PVC per workspace mounted at `/persist`, with
  `securityContext.fsGroup: 1000` so `node` can write to it. `dev-init` creates any missing
  subdirectory on first start. gh is per workspace too, unless the runtime supplies
  `GH_TOKEN` instead.
- **Coder**: see the [template's storage reference](../../coder/dev-system/README.md#what-the-template-does)
  and [gh sharing option](../../coder/dev-system/README.md#sharing-one-gh-login).
- **Host bind mounts** work if the host directory is writable by UID 1000. Avoid binding a
  Windows-side directory (`${localEnv:USERPROFILE}`) under WSL: permissions and the
  no-mistakes daemon socket do not behave there (cbundy/dev-system#19). Use named volumes.

If a directory is not writable, `dev-init` prints a warning naming the fix and `dev-doctor`
fails that check. If it is writable but has no volume behind it (its state is lost with the
container), `dev-init` prints a `WARNING` at start-up naming each such directory and the
fix, and `dev-doctor` warns. Neither fails the start: a one-off `docker run IMAGE <cmd>`
has no volumes on purpose.

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

## Workspace and repo

A headless container (Coder, compose, Kubernetes) starts with no checkout. The image
carries a hint instead, the repo's clone URL, and `dev-init` clones the repo into
persistent storage on the first start (cbundy/dev-system#77). The repo is never in the
image: the image is the toolchain and is replaced on every rebuild, while the checkout is
work in progress.

| Variable | Default | Effect |
|---|---|---|
| `DEV_REPO_URL` | empty: no clone | The repo's HTTPS clone URL. A consumer image built by CI gets it as a build argument (`${{ github.server_url }}/${{ github.repository }}.git`), so nobody types it. A runtime value (Coder's `repo_url` parameter, compose `environment:`) overrides the image's. Local and desktop builds leave it empty, since their checkout is bind-mounted. |
| `DEV_REPO_BRANCH` | the remote's default branch | The branch the clone checks out. Only the first clone uses it. |
| `DEV_WORKSPACE` | `/workspaces/<repo name>` when `DEV_REPO_URL` is set | Where the repo is cloned, and where `dev-init` and Claude run. `<repo name>` is the last part of the URL without `.git` (`my-repo` for `https://github.com/me/my-repo.git`). |
| `DEV_DEFAULT_PLUGINS` | `callum-flow@callum=cbundy/dev-system` | The Claude plugins every workspace gets, with or without a repo (see "Claude plugins" below): whitespace-separated `<plugin>@<marketplace>=<marketplace source>` entries, where the source is what `claude plugin marketplace add` takes (a GitHub `owner/repo`, optionally `#ref`, or a git URL). A per-repo image (`ENV DEV_DEFAULT_PLUGINS=...`) or the runtime's environment can change it; empty disables image defaults, while repo-enabled plugins still install. |
| `DEV_PLUGIN_INSTALL_TIMEOUT` | `120` | Seconds `dev-init` may spend in all on installing the Claude plugins, the default ones and the repo's (see "Claude plugins" below). Once they are spent, the plugins not yet installed get one `WARNING`. |

**Precedence.** The workspace is an explicit `DEV_WORKSPACE`, else
`/workspaces/<repo name>` from `DEV_REPO_URL`. Until that directory exists (a clone still
pending), and without either variable, it is the start directory, or `$HOME` if that is
`/`. The supervisor works it out again at every Claude start, so a repo cloned after
Claude started is used from Claude's next restart.

**What `dev-init` does**, on every start, after wiring git to gh's credentials and before
the no-mistakes recovery:

- **Workspace missing, or an empty directory:**
  `git clone [--branch $DEV_REPO_BRANCH] $DEV_REPO_URL $DEV_WORKSPACE`, limited to 120s.
  git never prompts. A failure is logged with git's reason and the fix, and the container
  starts anyway.
- **Already a git repo** (an earlier start's clone, or a bind-mounted checkout):
  `git fetch --prune` only, best effort.
- **A non-empty directory that is not a repo:** a warning, and the directory is left alone.

**No automatic pull.** A pull or merge on start would sooner or later collide with
uncommitted work, local branches, a rebase in progress or agent worktrees. The fetch keeps
`origin/*` current; integrating it is up to you or the agent.

**Mount the workspace volume at `/workspaces`.** The directory exists in the image, owned
by `node`, so a new Docker named volume mounted there takes that ownership and `node` can
clone into it. A volume mounted at a path the image does not have, such as
`/workspaces/my-repo`, comes up owned by root instead. Each checkout is a directory below
the mount, so a volume root that is never empty (`lost+found` on ext4) does no harm. On
Kubernetes, `fsGroup: 1000` makes it writable, as for `/persist`. Desktop dev containers
bind-mount their checkout at `/workspaces/<folder>` as well.

**Credentials.** Use an HTTPS URL: both credential sources below answer only for HTTPS. An
`ssh://` or `git@host:path` URL gets a warning that it needs SSH keys in the container, and
is tried anyway.

| Runtime | Credential for a private repo |
|---|---|
| Coder | The agent's `GIT_ASKPASS` answers for github.com (GitHub external auth). `dev-init` runs from the agent's `startup_script` and inherits it, so the first start clones. |
| Docker with the shared `dev-system-gh` volume | gh's credential helper (`gh auth setup-git`, which `dev-init` redoes on every start). |
| The first container on a new host (no gh login yet) | None yet. The clone is tried anyway, since a public repo needs no credential. A private one fails with `Waiting for a GitHub login` in the log, and once gh's device login completes, `dev-login watch` (which the supervisor runs) runs `dev-init --repo` to clone it. After a login made any other way, run `dev-init --repo` yourself. |

`dev-init --repo` runs only the repo steps: git credentials, the clone or fetch, the Claude
plugins (below) and the no-mistakes recovery. `dev-init --plugins` runs only the Claude
plugins.

**Claude plugins.** `dev-init` installs two sets of Claude Code plugins, at user scope, so
they land in `/persist/claude` and stay across rebuilds:

- **The image's default plugins** (`DEV_DEFAULT_PLUGINS`, cbundy/dev-system#148): the
  base image lists `callum-flow` from this repo's marketplace (`callum-flow@callum`, added
  from `cbundy/dev-system`), so every workspace, with a repo or without, and onboarded or
  not, has the dev-system skills (`issue-orchestrator`, `implement-issue`, `onboard`,
  `update-dev`) and the plugin's hooks in its first Claude session, with no manual step.
  It is the one plugin the image itself asks for. A per-repo image sets
  `ENV DEV_DEFAULT_PLUGINS=` to opt out, or lists other plugins in the same format; the
  runtime's environment overrides both.
- **The repo's plugins.** A repo can enable plugins in its committed
  `.claude/settings.json` (`enabledPlugins`, from marketplaces it declares under
  `extraKnownMarketplaces`). Claude itself installs them only from its interactive
  folder-trust prompt, which a headless session, or any session on a fresh
  `/persist/claude` volume, may never show (cbundy/dev-system#112). So `dev-init`
  installs each plugin set to `true` there.

A default plugin set to `true` in `enabledPlugins` (as every onboarded repo does for
`callum-flow`) is installed once from the repo's declared marketplace source. Without
that declaration, it keeps the image's source. Set to `false`, the repo opts out and it
is not installed by `dev-init`; this does not uninstall an existing copy. Repo plugins
go first, so a marketplace both name is added from the repo's source when Claude does
not already know it.

It is the last step of a start, after the login page is up, since it needs the network and
can be slow while the plugins matter only once Claude starts (`dev-init --repo` runs it
right after the clone or fetch). For each wanted plugin Claude has not installed yet:

- the marketplace is added first (`claude plugin marketplace add`) if Claude does not know
  it: a default plugin's from the source `DEV_DEFAULT_PLUGINS` gives, a repo plugin's from
  its declared source, `github` (`repo`, plus `#ref` when one is set) or `git` (`url`). A
  repo plugin whose marketplace is unknown to Claude and has an unsupported or missing
  declaration gets a `WARNING` and is skipped;
- then `claude plugin install <plugin>@<marketplace>`. If that fails on a marketplace
  Claude already knew, it updates the marketplace and tries once more;
- each call is limited to 60s and runs outside the checkout, and the whole step to
  `DEV_PLUGIN_INSTALL_TIMEOUT` (120s): no call starts once that is spent, and no call runs
  past it, so a slow or unreachable network cannot use up a runtime's time limit for the
  start (Coder's is 300s). Once it is spent, one `WARNING` names the plugins not yet
  installed, with the fix `dev-init --plugins`;
- a failure is one `WARNING` line with the CLI's reason and a `Fix:` line, and the start
  carries on. No login is needed, only network access (and, for a private marketplace
  repo, git's credential).

A plugin already installed costs one `claude plugin list --json` call, so later starts
need no network for it. With no network at the first start, Claude starts without the
plugin and `dev-doctor` warns, naming the fix (`dev-init --plugins`, then a new Claude
session).

`dev-doctor` warns when the workspace's `origin` is not `DEV_REPO_URL` (a `.git` or a
trailing `/` does not count), when `DEV_REPO_URL` is set but nothing is cloned yet, and
when a headless container has neither a repo nor `DEV_REPO_URL`. In that last case Claude
runs in a bare directory: server mode cannot give each session a worktree, and the session
is not named after the repo. Desktop dev containers (`DEV_DESKTOP=1`, from the image
metadata) skip that check, since they open the checkout they bind-mount.

## `dev-init`

`/usr/local/bin/dev-init` runs as `node` on every container start. On the desktop the
image metadata runs it as `postStartCommand`; everywhere else the image entrypoint runs it
(see below). With `DEV_REPO_URL` set it clones the repo itself (see
[Workspace and repo](#workspace-and-repo)). A checkout made some other way after the
container started needs `dev-init --repo` once it is there, so the repo's Claude plugins
are installed and the no-mistakes recovery sees it. It is idempotent and best-effort: it logs problems but always exits 0, so a
container never fails to start because of it.

1. Checks that each `/persist` directory exists and is writable, creating missing ones and
   printing the fix (`fsGroup: 1000` / `chown 1000:1000`) for unwritable ones. One
   `WARNING` names every directory with no volume behind it, whose state is lost on the
   next rebuild, with the fix for a devcontainer, `docker run` and Kubernetes. It shows in
   the post-start output and the container log.
2. Records Claude's `installMethod: native` in `.claude.json` if missing (`claude doctor`
   warns without it, because the config directory starts empty).
3. Seeds `$CODEX_HOME/config.toml` with a top-level `sandbox_mode = "danger-full-access"`
   only if no top-level `sandbox_mode` is set. codex's bwrap sandbox cannot run inside
   these containers (cbundy/dev-system#19).
   With `OTEL_EXPORTER_OTLP_ENDPOINT` set, it also writes codex's `[otel]` table there
   (and removes it once the endpoint is unset), unless you have `otel` settings of your
   own (see [Telemetry](#telemetry-opentelemetry-export)).
4. Writes the no-mistakes pipeline's agent order and model pin in a managed block of
   `$NM_HOME/config.yaml`, between `# BEGIN dev-system managed` and
   `# END dev-system managed`. The block has two independent parts: the ordered agent list
   (`agent: [codex, claude]`, from `AGENTS`; no-mistakes moves to the next agent when one
   fails) and the model pin (`agent_args_override`: codex, and claude's model and effort, so
   the claude fallback runs on `CLAUDE_MODEL` at `CLAUDE_EFFORT`). It is rewritten on
   every start from [`models.env`](models.env) as it is on this repo's `main` branch,
   fetched once per start from `DEV_MODELS_URL`, so a change merged to `main` reaches every
   workspace on its next start, with no release or image rebuild. The fetch is short (3s to
   connect, 8s in all) and never fails the start: if it fails, or the file sets no valid
   key, one `WARNING` names the URL and the reason and the copy baked into the image is
   used. Per key, a valid fetched value beats the baked one. Content outside the markers is
   never touched. `DEV_NM_AGENTS` / `DEV_CODEX_MODEL` / `DEV_CLAUDE_MODEL` /
   `DEV_CLAUDE_EFFORT` override both; an empty value skips that part (`DEV_NM_AGENTS=""`
   writes no `agent`, `DEV_CODEX_MODEL=""` no pin; with both empty the block is removed).
   To run codex only, with no claude fallback, set `DEV_NM_AGENTS=codex`. A key in
   `models.env` that the image does not know yet (such as `CLAUDE_EFFORT` before 2.6.0) is
   ignored, so a new key needs the image that reads it. A key of your own outside the markers
   wins over its part only: a top-level `agent` drops the agent order, an
   `agent_args_override` or `agent_config` drops the model pin (delete the block, markers
   included, before setting both by hand). A repo whose `.no-mistakes.yaml` sets `agent`
   replaces the agent order for that repo. The unmarked pin older images wrote is replaced
   by the block.
5. If gh is logged in, runs `gh auth setup-git`. `~/.gitconfig` is not persisted, so this is
   redone on each start.
6. If `DEV_REPO_URL` is set, clones it into `$DEV_WORKSPACE` when that is missing or
   empty, or fetches when it is already a repo (see
   [Workspace and repo](#workspace-and-repo)).
7. If the workspace (`$DEV_WORKSPACE` once it exists, else the current directory) is in a
   git repo with `.no-mistakes.yaml`, starts the no-mistakes daemon (a process, so gone
   after every restart) and runs the callum-tools `recover-no-mistakes.sh` to re-register
   the repo if needed. A daemon that is already running (a second `dev-init` in the same
   container) is restarted instead when step 4 changed the managed block, since it reads the
   config only at start-up. If git refuses the checkout because another user owns it ("dubious
   ownership"), it warns with the fix instead of skipping silently. Each no-mistakes call
   has its own short time limit (30s), so a daemon that never answers is logged with the
   fix and never holds up the steps after it.
8. If an agentsview URL is configured (the secret file
   `/run/secrets/dev-system/agentsview-pg-url`, or `AGENTSVIEW_PG_URL`), starts the
   agentsview session push (see
   [Central session history](#central-session-history-agentsview)). A secret file it
   cannot read gets a `WARNING`.
9. If `$DEV_SHARED_DIR` is mounted but not writable by `node`, warns with the fix. Not
   mounted is fine; it is optional.
10. If `DEV_LOGIN_PORT` is set, starts the login page in the background (see
    [First-run logins](#first-run-logins)).
11. Installs the Claude plugins that are not installed yet: the image's default ones
    (`DEV_DEFAULT_PLUGINS`, `callum-flow` unless an image or the runtime changes it) and
    the ones the workspace repo's `.claude/settings.json` enables, adding their
    marketplaces first (see "Claude plugins" in [Workspace and repo](#workspace-and-repo)).
    An invalid settings file or `DEV_DEFAULT_PLUGINS` entry, an unsupported marketplace
    source or a failed install is a `WARNING` with the fix. Last, and within `DEV_PLUGIN_INSTALL_TIMEOUT` (120s) in all, so it can
    never hold up the login page or the steps before it.
12. Runs `dev-doctor --warn-only`.

The managed block in step 4 reads these variables:

| Variable | Default | Effect |
|---|---|---|
| `DEV_NM_AGENTS` | unset: the models file (`AGENTS`) | The pipeline's ordered agent list, comma-separated with no spaces (`codex,claude`; names such as `claude`, `codex`, `grok`, `opencode`, `acp:<name>`). Set, it beats the fetched and the baked models file; empty writes no `agent` in the block. An invalid list is skipped with a one-line note. |
| `DEV_CODEX_MODEL` | unset: the models file | The codex model no-mistakes runs on. Set, it beats the fetched and the baked models file; empty drops the model pin (and the block, when there is no agent order either). |
| `DEV_CLAUDE_MODEL` | unset: the models file | The model of claude. Set, it beats both models files; empty leaves claude unpinned. |
| `DEV_CLAUDE_EFFORT` | unset: the models file (`CLAUDE_EFFORT`) | claude's reasoning effort (its `--effort`): `low`, `medium`, `high`, `xhigh` or `max`. Set, it beats both models files; empty leaves claude's effort unpinned. Any other value is left out with a one-line note. |
| `DEV_MODELS_URL` | `https://raw.githubusercontent.com/cbundy/dev-system/main/images/base/models.env` | Where `dev-init` fetches the models file from on every start (`https://`, or `file://` for tests). Empty turns the fetch off, for an offline workspace or one pinned to its image's models. Trust: anyone who can merge to `cbundy/dev-system` `main` sets the agents and models for every workspace - the same trust as the published image. The file is parsed, never run: only known keys with plain values are read. |

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
- gh's token has the `workflow` scope, which pushing a change under `.github/workflows/`
  needs: a `WARN` when it lacks it (fix: `dev-login start`, or
  `gh auth refresh -h github.com -s workflow`; for `GH_TOKEN`, give that token the scope).
  When the scopes cannot be read (offline, or a fine-grained token, which has none), an
  `INFO` line says so and nothing is prompted;
- no-mistakes is installed and, inside a repo with `.no-mistakes.yaml`, registered and
  working (any `no-mistakes status` error fails the check);
- git can read the workspace repo (not blocked by "dubious ownership");
- the workspace repo, each a `WARN`: with `DEV_REPO_URL` set, that it is cloned and its
  `origin` matches; headless without it, that Claude's workspace is a git repo (see
  [Workspace and repo](#workspace-and-repo));
- the Claude plugins the workspace repo's `.claude/settings.json` enables are installed,
  with a `WARN` (not a failure: Claude runs, without their skills) naming any that are
  missing and the fix `dev-init --repo`, or that the file is not valid JSON; and the
  image's default plugins (`DEV_DEFAULT_PLUGINS`) not disabled or supplied by the repo,
  with a `WARN` naming any that are missing and the fix (`dev-init --plugins`, or the
  `claude plugin marketplace add` and `install` commands by hand). Only run when some
  plugin is wanted;
- treehouse is on `PATH`;
- uv is on `PATH`;
- agentsview is on `PATH`; with no URL configured, a `WARN` that the session push is off
  and how to turn it on; with one, the central database is reachable and a push is running
  (in this container or another one sharing the volume). A secret file that exists but
  cannot be read fails. Anything agentsview prints there is masked (`postgres://***@...`).
- stale bridge worktrees (see [`dev-prune-worktrees`](#dev-prune-worktrees)): a `WARN`
  with the count when some would be removed, `OK` when there are none, nothing when the
  workspace has no bridge worktrees;
- an `INFO` line, never a failure, on telemetry export (see
  [Telemetry](#telemetry-opentelemetry-export)): off, or on with the endpoint, the protocol
  and whether it is reachable.

It exits 1 if any check fails; `WARN` lines do not count. `dev-doctor --warn-only` prints
the same report and always exits 0.

## `dev-prune-worktrees`

Server mode gives every session a worktree, `<workspace>/.claude/worktrees/bridge-*`, on a
local branch `worktree-bridge-*`, locked with the server's pid in the reason. A server that
stops leaves them behind and nothing removes them. `dev-prune-worktrees` classifies each one
and removes the stale ones:

- **in use**: locked by a process that is still alive. Claude Code writes the lock reason
  as `claude <a> <b> (pid <PID> start <START>)`, where START is the process's starttime
  (field 22 of `/proc/<PID>/stat`, in clock ticks since boot), or `claude <a> <b> (pid <PID>)`
  on older versions or when the start is unknown. With `pid N start S` the worktree is in use
  only if pid N is alive and its starttime equals S exactly; a live pid with a different
  starttime was recycled, so the worktree is orphaned. With only `pid N`, a live pid counts if
  that process started no later than the lock was taken (the `locked` file's mtime, compared
  with the process start time from `/proc`, plus 5 s of slack). A lock whose reason names no
  pid cannot be proven dead, so it counts as in use. Never touched, whatever its age.
- **orphaned**: unlocked, or locked by a dead or recycled pid.
- **unsafe** (an orphaned one that is kept): uncommitted or untracked changes, or commits on
  no remote branch. A squash-merged branch's commits are on no remote branch, so HEAD also
  counts as pushed when GitHub reports it as the head of a merged pull request
  (`gh api repos/{owner}/{repo}/commits/<sha>/pulls`). With `gh` missing, logged out or
  offline that lookup finds nothing and the worktree stays unsafe.
- **idle**: the age of the newest of the worktree's HEAD, index and reflog and every file in
  it.

```sh
dev-prune-worktrees                 # dry run: a table of every worktree, then what --delete would remove
dev-prune-worktrees --delete        # remove orphaned + safe + idle >= 72h
dev-prune-worktrees --delete --older-than 12h   # 90m, 12h, 3d, or bare hours; 0 ignores idleness
```

`--delete` unlocks, runs `git worktree remove` (never `--force`), deletes the local
`worktree-bridge-*` branch and runs `git worktree prune`; everything it skips is logged with
the reason. `dev-remote-control` runs it with `--delete` before every start in server mode,
so a stop and start cleans up over time, and `dev-doctor` warns with the count of stale
ones. The workspace is the one `dev-init` uses (`--workspace DIR` overrides it).
Sessions the live server can still resume stay until that server stops; after the next
restart they are orphaned and the 72 hour rule applies. Tested by
`images/base/test/dev-prune-worktrees.test.sh` (part of `npm test`).

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

**`dev-entrypoint`** runs `dev-init` (best-effort, limited to 300s, which leaves room for a first clone, report on stderr) in
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
   (`projects[<dir>].hasTrustDialogAccepted` in `$CLAUDE_CONFIG_DIR/.claude.json`),
   Remote Control as accepted (`remoteDialogSeen`), the one-time "Try the new fullscreen
   renderer?" prompt as seen (`fullscreenUpsellSeenCount` raised to at least 3, a higher
   value is kept), and onboarding as done. An unattended
   Claude otherwise sits at the folder trust dialog, which comes before anything else, or
   at the one-time "Enable Remote Control? (y/n)" prompt, which `claude remote-control`
   shows on a fresh config (cbundy/dev-system#88). Enabling `DEV_REMOTE_CONTROL` (the
   headless default) is the consent to Remote Control, so the supervisor answers it for
   you. Existing unrelated values are preserved.
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
     the workspace itself; only the sessions started after it get a worktree. Observed
     with Claude Code 2.1.289 (cbundy/dev-system#86):
     - A session's worktree (`.claude/worktrees/bridge-<session id>`, locked while in
       use) starts from the remote's default branch (`origin/main`), not from the
       workspace's checked-out `HEAD`. A session does not see commits that exist only
       in the local checkout; push them first if it needs them.
     - Ending or deleting a session in claude.ai removes its worktree and branch.
       Sessions still open when the container stops keep theirs (locked, so they can be
       resumed). The next start does not reuse them, but `dev-remote-control` prunes the stale
       ones (see [`dev-prune-worktrees`](#dev-prune-worktrees)).
     - Besides the open sessions, the server keeps one spare session process running,
       ready for the next session.
   In `session` mode the supervisor also decides, at every start, whether to **resume**
   the workspace's last conversation (`DEV_REMOTE_CONTROL_RESUME=1`, see
   [Resuming the conversation](#resuming-the-conversation)) or start a fresh one, and
   adds that branch's first message (`DEV_REMOTE_CONTROL_PROMPT` /
   `DEV_REMOTE_CONTROL_RESUME_PROMPT`) as the last argument. The log says which branch it
   took: `resuming the last conversation (<id>) in <dir>` or
   `starting a fresh conversation`.
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
| `DEV_REMOTE_CONTROL_NAME` | the workspace's repo name | The session name in claude.ai (the environment name in `server` mode). By default the repo name from the workspace's `origin` URL (`dev-system` for `github.com/cbundy/dev-system`), else the name of its git top-level directory, else (no git repo) the repo name in `DEV_REPO_URL`, else the hostname: the container ID under Docker unless you pass `--hostname`, the pod name on Kubernetes. Worked out at every Claude start. |
| `DEV_REMOTE_CONTROL_NAME_FORMAT` | unset | `session` mode, when `DEV_REMOTE_CONTROL_NAME` is not set: the session name, with `{name}` replaced by the default name above, e.g. `🔄 {name} orchestrator` gives `🔄 dev-system orchestrator`. Emoji, spaces and `&` pass through as they are. |
| `DEV_REMOTE_CONTROL_RESUME` | `0` | `session` mode: `1` resumes the workspace's last conversation on every start, when there is one. See [Resuming the conversation](#resuming-the-conversation). |
| `DEV_REMOTE_CONTROL_PROMPT` | unset | `session` mode: the first message of a fresh conversation, e.g. a slash command such as `/callum-flow:issue-orchestrator`. Not sent when a conversation is resumed. |
| `DEV_REMOTE_CONTROL_RESUME_PROMPT` | unset | `session` mode: the message sent when a conversation is resumed, e.g. to re-arm a loop that did not survive the restart. |
| `DEV_REMOTE_CONTROL_SKIP_PERMISSIONS` | `0` | `1` runs Claude with `--dangerously-skip-permissions` (and skips its one-time consent dialog); in `server` mode, with `--permission-mode bypassPermissions` for the sessions it spawns, and `bypassPermissionsModeAccepted` set in `.claude.json`, since `claude remote-control` takes no `--settings` to skip the dialog per run. Only for a container you are happy to let act unsupervised. |
| `DEV_REMOTE_CONTROL_POLL` | `30` | Seconds between login checks. |
| `DEV_WORKSPACE` | `/workspaces/<repo name>` with `DEV_REPO_URL` set, else the start directory, or `$HOME` if that is `/` | Where `dev-init` and Claude run (see [Workspace and repo](#workspace-and-repo)). Re-read at every Claude start, so a workspace cloned after start-up is used from the next restart. |

`server` mode ignores the four conversation settings (`_NAME_FORMAT`, `_RESUME`,
`_PROMPT`, `_RESUME_PROMPT`) and logs one line for each that is set.

#### Resuming the conversation

By default every Claude start in `session` mode is a new, empty conversation, so a
restart (a stop and start, a template update, a crash) shows up in claude.ai as a new
session. With `DEV_REMOTE_CONTROL_RESUME=1`, each start instead looks in the
workspace's Claude project directory, `$CLAUDE_CONFIG_DIR/projects/<dir>/`, where
`<dir>` is the workspace's physical path with every character other than a letter or
digit replaced by `-` (`/workspaces/my_repo.x` becomes `-workspaces-my-repo-x`). It
resumes the newest transcript (`*.jsonl`) there that holds a user message, with
`claude --remote-control <name> --resume <session id>`. A transcript with nothing but
Remote Control bookkeeping (a start nobody wrote to) does not count, and with nothing to
resume Claude starts fresh, so a fresh volume does not loop on the backoff.

The decision is made again at every start: once a real conversation exists, every later
start, a crash loop included, resumes it and sends `DEV_REMOTE_CONTROL_RESUME_PROMPT`,
never the startup prompt again. A resumed session does not get back anything that lived
only in the old process, such as a `/loop` or a scheduled task, so use the resume prompt
to re-arm it.

Observed with Claude Code 2.1.289-2.1.292 (cbundy/dev-system#164):

- A positional prompt is delivered as the first message alongside `--remote-control`,
  including a built-in slash command (`/help`) and a plugin skill (`/<plugin>:<skill>`),
  and alongside `--resume` / `--continue`.
- A resumed session continues the same transcript (same session ID) and reattaches to
  the **same** claude.ai Remote Control session (same `bridgeSessionId` and session URL),
  with the full history.
- `--continue` resumes the newest transcript even when it is an empty start, which loses
  the real conversation and opens a new claude.ai session. That is why the supervisor
  picks the transcript itself and passes `--resume <session id>`.
- A name with an emoji and spaces is accepted by `--remote-control` and passes through
  tmux unchanged. How claude.ai and the Claude app show it was not checked.

The history lives in the config volume (`/persist`), so it survives a stop, restart and
image or template update, but not deleting the volume. Keep anything that must last in
files in the repo or on GitHub.

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
  -v dev-system-gh:/persist/gh -v my-repo-workspaces:/workspaces \
  -v dev-system-secrets:/run/secrets/dev-system:ro \
  -e DEV_REPO_URL=https://github.com/me/my-repo.git -e DEV_MACHINE_NAME=docker-my-repo \
  ghcr.io/cbundy/dev-system/base:2
docker logs my-repo                          # the sign-in links for Claude, codex and gh
docker exec my-repo dev-login <code>         # the code Claude's sign-in page shows
```

`DEV_REPO_URL` is only needed with the bare base image: a consumer image built by CI
already carries it. `dev-init` clones the repo into `/workspaces/my-repo` on the volume
(see [Workspace and repo](#workspace-and-repo)); a private repo waits for gh's login.
Claude starts within 30s of the login, no restart needed. Approving codex's and gh's
codes is enough for those. For the login page instead, add `-e DEV_LOGIN_PORT=8765` and
reach it through a reverse proxy (see [Several containers: one nginx route](#several-containers-one-nginx-route)).
For a single container on a LAN, `-p 8765:8765 -e DEV_LOGIN_PORT=8765` also works (LAN or
VPN only: see [Security](#security)); a second container then needs another host port
(`-p 8766:8765`), which the proxy avoids.

The same with docker compose. Compose prefixes volume names with the project name, which
keeps the four per-project volumes apart from other projects'; `name:` turns that off for
the shared gh and secrets volumes, so every project uses the same `dev-system-gh` and
`dev-system-secrets`:

```yaml
services:
  dev:
    image: ghcr.io/cbundy/dev-system/base:2
    environment:
      DEV_REPO_URL: https://github.com/me/my-repo.git   # not needed with a consumer image
      DEV_MACHINE_NAME: compose-my-repo                  # its label in agentsview
    volumes:
      - claude:/persist/claude
      - codex:/persist/codex
      - no-mistakes:/persist/no-mistakes
      - agentsview:/persist/agentsview
      - gh:/persist/gh
      - workspaces:/workspaces
      - secrets:/run/secrets/dev-system:ro
volumes:
  claude:
  codex:
  no-mistakes:
  agentsview:
  workspaces:
  gh:
    name: dev-system-gh   # shared by every project on this Docker host
  secrets:
    name: dev-system-secrets   # the agentsview URL, shared likewise
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
        - name: DEV_REPO_URL       # dev-init clones it into /workspaces/my-repo
          value: https://github.com/me/my-repo.git   # a consumer image carries it already
        - name: DEV_MACHINE_NAME   # its label in agentsview
          value: k8s-my-repo
      volumeMounts:
        - { name: persist, mountPath: /persist }
        - { name: workspaces, mountPath: /workspaces }
        - { name: secrets, mountPath: /run/secrets/dev-system, readOnly: true }
  volumes:
    - name: persist
      persistentVolumeClaim: { claimName: dev-persist }
    - name: workspaces
      persistentVolumeClaim: { claimName: dev-workspaces }
    - name: secrets                # the agentsview URL (Central session history)
      secret: { secretName: dev-system-secrets, defaultMode: 0440, optional: true }
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

Each repo on the desktop (each workspace on Kubernetes or Coder) needs one Claude login
and one codex login. gh needs one login per shared volume, or per workspace when its
storage is private; see [runtime mounts](#how-runtimes-should-mount-it). The logins land in
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
| gh | `gh auth login --web --scopes workflow`: a link and a one-time code; then `gh auth setup-git`. The `workflow` scope lets the pipeline push changes under `.github/workflows/`. A gh login without it (an older one, or one made by hand) gets `gh auth refresh --scopes workflow` instead: a link and a code the same way, which add the scope to the token gh already has. | Open the link and enter the code. If the runtime supplies `GH_TOKEN`, it replaces this login; see [Coder external auth](../../coder/dev-system/README.md#github-through-coder-external-auth). |

Each login runs in its own tmux session (`login-claude`, `login-codex`, `login-gh`), so
`tmux attach -t login-codex` shows it as it is. An attempt in progress is kept, so a link
you were given stays valid; one that ended (an expired code, a rejected paste) is
replaced, so there is always a fresh link. The supervisor (`dev-remote-control`) runs
`dev-login watch`, which does that every 15 seconds and logs each new link once, until
every login is done. On the desktop, where the supervisor is off by default, run
`dev-login start` in a terminal instead.

```text
dev-login status [--json]   each tool: in, out, other (Claude logged in, but not with
                            claude.ai), scope (gh logged in without the workflow scope),
                            token (gh: GH_TOKEN) or off (not in DEV_LOGIN_TOOLS)
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
`gh auth login --scopes workflow`, then `dev-init` to wire git to gh straight away). Run `dev-doctor` to
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
  -v dev-system-gh:/persist/gh -v dev-system-secrets:/run/secrets/dev-system:ro \
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

A Python repo usually needs no image of its own. The image's `python3` has no `pip` or
`venv`, but uv does that job: gates run as `uv run --with pytest --with pyyaml pytest`
(or `uv run pytest` with a `pyproject.toml`) and `uvx ruff check .`, and uv fetches the
packages, or a different Python with `uv python install`, at run time into node's home.

A repo that needs system tools has its own Dockerfile that adds them:

```dockerfile
FROM ghcr.io/cbundy/dev-system/base:2

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client \
  && rm -rf /var/lib/apt/lists/*
USER node
```

Switch back to `USER node` at the end, keep tool binaries out of `/persist`, and don't add a
`VOLUME` for it. Leave `ENTRYPOINT` alone (or keep `tini -- dev-entrypoint` in front of your
own) so `dev-init` and Remote Control keep working.

On the desktop, a thin `.devcontainer/devcontainer.json` with the per-repo state volumes is
enough. `npx callum-dev init` writes one (the `base-image` devcontainer, the default) and
`callum-dev update` keeps its mounts in step; a repo on the feature-based template moves
with `npx callum-dev update --devcontainer base-image` (see `templates/README.md`). By hand,
it is:

```jsonc
{
  "name": "my-repo",
  "build": { "dockerfile": "Dockerfile" },
  // or, with no repo-specific tools: "image": "ghcr.io/cbundy/dev-system/base:2"
  "mounts": [
    // Per-repo tool state. Keep these four as they are: ${devcontainerId} is
    // stable for this workspace folder and config file, and unique to them.
    { "type": "volume", "source": "dev-system-${devcontainerId}-claude", "target": "/persist/claude" },
    { "type": "volume", "source": "dev-system-${devcontainerId}-codex", "target": "/persist/codex" },
    { "type": "volume", "source": "dev-system-${devcontainerId}-no-mistakes", "target": "/persist/no-mistakes" },
    { "type": "volume", "source": "dev-system-${devcontainerId}-agentsview", "target": "/persist/agentsview" }
  ]
}
```

The image's metadata label supplies `remoteUser: node`, `updateRemoteUserUID: false`,
`containerEnv` with the `/persist` variables, `DEV_SHARED_DIR` and `DEV_REMOTE_CONTROL: "0"`,
`postStartCommand: dev-init && dev-remote-control --post-start` and the shared gh and
secrets volumes, which the devcontainer CLI and VS Code merge into your config:

| Named volume | Target | Scope |
|---|---|---|
| `dev-system-gh` | `/persist/gh` | every repo on the Docker host (image metadata) |
| `dev-system-secrets` | `/run/secrets/dev-system`, read-only | every repo on the Docker host (image metadata) |
| `dev-system-<devcontainerId>-claude` | `/persist/claude` | this repo (your `devcontainer.json`) |
| `dev-system-<devcontainerId>-codex` | `/persist/codex` | this repo (your `devcontainer.json`) |
| `dev-system-<devcontainerId>-no-mistakes` | `/persist/no-mistakes` | this repo (your `devcontainer.json`) |
| `dev-system-<devcontainerId>-agentsview` | `/persist/agentsview` | this repo (your `devcontainer.json`) |

The per-repo mounts cannot come from the image: the devcontainer CLI expands no variables
in image metadata (`${devcontainerId}` comes out empty), so every repo would get the same
volumes. Leave them out and that state lives in the container itself, lost on every
rebuild; `dev-init` warns about it at start-up, and so does `dev-doctor`. `${devcontainerId}` is a hash of the workspace
folder and the path of the devcontainer config file, so:

- a second clone of the same repo gets its own volumes, and a moved or renamed clone
  starts with new, empty ones (one more login);
- a repo with several configs (say `.devcontainer/devcontainer.json` and
  `.devcontainer/gpu/devcontainer.json`) gets separate volumes for each, so a separate
  Claude and codex login for each. gh is the exception: `dev-system-gh` is shared by
  all of them. Moving or renaming a config file also starts it on new, empty volumes.

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
   `base:2`. A repo scaffolded by `callum-dev` gets both from
   `npx callum-dev update --devcontainer base-image`.
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

It is on in every container that has the database URL, which you put in one place per
Docker host or cluster (below), and off otherwise. The image's anonymous telemetry ping
and update check are disabled (`AGENTSVIEW_TELEMETRY_ENABLED=0`,
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

### Each container: the URL, once per host

The URL (`postgres://user:pass@host:5432/agentsview?sslmode=require`) is a secret, and
the image is public, so it never goes into an image, a repo or a build. Every container
reads it at run time from one file, **`/run/secrets/dev-system/agentsview-pg-url`**
(`$DEV_SECRETS_DIR/agentsview-pg-url`), which the runtime mounts read-only. Each runtime
gets that directory from a place you fill once, so every container there, from any repo
and from consumer images built `FROM` this one, pushes with nothing set per repo
(cbundy/dev-system#103):

| Runtime | Where the file comes from | Set once per |
|---|---|---|
| Desktop dev containers | the `dev-system-secrets` named volume, mounted read-only by the image's devcontainer metadata | Docker host |
| `docker run`, compose | the same volume (`-v dev-system-secrets:/run/secrets/dev-system:ro`, see [First start, headless](#first-start-headless)) | Docker host |
| Coder ([`coder/dev-system`](../../coder/dev-system/README.md)) | a directory on the workspace Docker host (template variable `secrets_dir`, default `/etc/dev-system/secrets`), bind-mounted read-only | Docker host |
| Kubernetes | a Secret `dev-system-secrets` mounted at the directory (pod spec above) | namespace |

The value is never in the container's environment, so it is not in `docker inspect` or in
the shells agents run: `dev-init` hands it to the push alone and reads it again on every
restart of the push, so a new value takes effect at the next container start. Anything
that could echo it, the push log and `dev-doctor`, is masked. Where the file is missing
(an empty volume or directory, which is what a runtime creates when there is none yet) the
push is off: the container starts as usual, and `dev-doctor` shows a `WARN` naming the
file to fill. An unreadable file fails `dev-doctor`.

**Desktop and any Docker host** (WSL with Docker Desktop counts as one host). The value is
read without echo, so it is not in your shell history or on screen:

```bash
read -rsp 'agentsview URL: ' url && printf '%s\n' "$url" \
  | docker run --rm -i --user root --entrypoint "" \
      -v dev-system-secrets:/run/secrets/dev-system ghcr.io/cbundy/dev-system/base:2 \
      sh -c 'umask 077 && cat > /run/secrets/dev-system/agentsview-pg-url && chown 1000:1000 /run/secrets/dev-system/agentsview-pg-url'
unset url
```

The path is spelled out rather than taken from `$DEV_SECRETS_DIR`, so the command works
with any image version (images before 2.2.0 don't set the variable, and the file would
land in the throwaway container instead of the volume).

Then rebuild or restart each dev container (or run `dev-init` in it). A volume rather than
a host directory, because a devcontainer bind mount cannot be optional: a missing source
fails the container start on Docker Engine, and Docker Desktop creates it root-owned in
your home. A volume that does not exist yet is simply created empty. To change the value,
run the command again; to turn the push off on a host, `docker volume rm dev-system-secrets`
once no container uses it.

**Coder.** On the workspace Docker host, as root (an Ansible task can do the same):

```bash
install -d -m 0700 -o 1000 -g 1000 /etc/dev-system/secrets
(umask 077 && read -rsp 'agentsview URL: ' url && printf '%s\n' "$url" > /etc/dev-system/secrets/agentsview-pg-url)
chown 1000:1000 /etc/dev-system/secrets/agentsview-pg-url
```

Workspaces pick it up at their next start. The template mounts the directory whatever is
in it, and Docker creates a missing one empty, so a host without the file just has the
push off.

**Kubernetes.** `optional: true` keeps a pod starting without the Secret, and
`defaultMode: 0440` with the contract's `fsGroup: 1000` lets `node` read it:

```bash
read -rsp 'agentsview URL: ' url && kubectl create secret generic dev-system-secrets \
  --from-file=agentsview-pg-url=<(printf '%s\n' "$url"); unset url
```

**Consumer images** need nothing: they inherit the mount point and the metadata, and get
the file at run time like the base image. Never pass the URL as a build argument or bake a
file into one. A consumer Dockerfile that sets its own `devcontainer.metadata` label must
copy the `dev-system-secrets` mount into it (see [Extending the image](#extending-the-image)).

| Variable | Default | Purpose |
|---|---|---|
| `DEV_MACHINE_NAME` | desktop: `desktop-<checkout folder>`; Coder: `coder-<workspace>`; otherwise the hostname | This machine's label in the viewer. Use `<runtime>-<name>` everywhere (`docker-my-repo`, `compose-my-repo`, `k8s-my-repo`), so the viewer reads the same way for every runtime. Set, it overwrites `local_machine_name` in `config.toml` on every start; the desktop default is only written when none is there. |
| `AGENTSVIEW_PG_URL` | unset | The URL as an environment variable, which takes precedence over the file. For a one-off; the file keeps it out of `docker inspect`. |
| `DEV_SECRETS_DIR` | `/run/secrets/dev-system` | Where the secret file is read from. |
| `AGENTSVIEW_PG_SCHEMA` | `agentsview` | Schema name. |

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
and each Kubernetes or Coder workspace is its own machine. `DEV_MACHINE_NAME` tells them
apart in the viewer (defaults and naming above). Containers that do share a
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

## Telemetry (OpenTelemetry export)

Claude Code and codex can send usage metrics and events to an OpenTelemetry (OTLP)
collector. It is opt-in, by one variable: with `OTEL_EXPORTER_OTLP_ENDPOINT` set by the
runtime, the image turns export on; unset or empty, nothing is exported and nothing
complains. The image itself never contains an endpoint (it is public), so a desktop
container with no collector exports nothing (cbundy/dev-system#68). The receiving side
(a collector, Prometheus, Loki, Grafana) is not part of this repo.

### The contract

The runtime supplies:

| Variable | Example | Effect |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://otel-gateway:4318` | The collector's base URL. Set and non-empty: export on. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | unset (`http/protobuf`) | `http/protobuf` (port 4318 on most collectors), `http/json` or `grpc` (port 4317). Must match the collector. |
| `OTEL_RESOURCE_ATTRIBUTES` | `host=<name>,env=coder` | Labels on everything Claude Code and codex export (standard OTel syntax). |

With the endpoint set, the image adds what the endpoint alone does not turn on:

- **Claude Code**: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`,
  `OTEL_LOGS_EXPORTER=otlp` and `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`. A value the
  runtime set always wins, so it can pick `grpc`, or turn Claude's export off with
  `CLAUDE_CODE_ENABLE_TELEMETRY=0`. Any other `OTEL_*` setting Claude Code reads
  (`OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_METRIC_EXPORT_INTERVAL` and so on) passes straight
  through from the runtime.
- **codex**, which reads no `OTEL_*` variables: `dev-init` writes an `[otel]` table to
  `$CODEX_HOME/config.toml` that sends codex's log events and metrics to the endpoint
  (`otlp-http` to `<endpoint>/v1/logs` and `/v1/metrics`, or `otlp-grpc` to the endpoint
  itself when the protocol is `grpc`). Its metrics otherwise go to codex's default,
  statsig. codex reads `OTEL_RESOURCE_ATTRIBUTES` too, but sets its own `env` attribute
  from the table's `environment` (default `dev`), which beats the runtime's, so the table
  carries the runtime's `env` (when it sets one) as `environment` (cbundy/dev-system#171).
  The table sits between `# BEGIN dev-system telemetry` and
  `# END dev-system telemetry`, after the file's top-level keys and before its first
  table, so the tables codex appends (its `[projects."..."]` trust entries) stay outside
  it: `dev-init` rewrites it when the endpoint changes and removes it when the endpoint is
  unset (`images/base/codex-otel.sh`). If the file already has
  `otel` settings of yours (an `[otel]` table, or any `otel` key outside the markers),
  `dev-init` writes nothing, logs that it left them alone, and drops its own table if one
  was there. To customise codex's export (headers, TLS, `environment`), replace the block,
  markers included, with your own `[otel]` table.
- **no-mistakes** has no exporter of its own: its run logs are files under
  `/persist/no-mistakes/logs` (`$NM_HOME/logs`), for a collector or log shipper to tail if
  you want pipeline outcomes next to the rest.

Traces are not turned on. `dev-doctor` reports the
state in an `INFO` line, which never fails: export off, or on with the endpoint, the
protocol and whether a TCP connection to the endpoint opens within 2s.

### How it reaches Claude

`/usr/local/share/dev-system/telemetry.sh` holds the switch, and is sourced where a
`claude` process starts:

- by `dev-remote-control` in the tmux pane, right before each Claude start. It is sourced
  in the pane, not in the supervisor, because a pane gets the tmux server's environment
  and that server may already be running (started by `dev-login`);
- by login shells (`/etc/profile.d/dev-system-telemetry.sh`: `coder ssh`, tmux windows,
  `bash -l`) and interactive bash (`/etc/bash.bashrc`: `docker exec -it <c> bash`, VS Code
  terminals).

A `claude` started from a non-interactive, non-login shell (`docker exec <c> claude -p ...`
or a script) does not get the switch: set the variables in that command's environment, or
run it through `bash -lc`.

### What is collected

Claude Code (see its [monitoring docs](https://code.claude.com/docs/en/monitoring-usage)):

- metrics: sessions, lines of code changed, pull requests and commits created, cost, token
  usage, edit tool accept/reject decisions and active time (`claude_code.*`);
- events: one per prompt (its length, not its text), API request (model, cost, tokens,
  duration), API error, tool decision and tool result (name, success, duration), and a
  few more (auth, MCP connections, plugin and skill use);
- on every metric and event: the session ID, organisation ID, account UUID, user ID, the
  account's email address and the terminal type, plus the runtime's resource attributes.

codex: log events for each conversation start, API request, streamed response event,
user prompt (text redacted), tool decision and tool result, plus its usage metrics.

### Privacy defaults

Prompt text, assistant response text, tool arguments and tool output are **not**
exported: the image never sets `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`,
`OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT` or `OTEL_LOG_RAW_API_BODIES`, and codex's
table has `log_user_prompt = false`. A runtime that wants them sets those variables itself
(Claude Code only). The email address and account IDs above are always sent while export
is on; `OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false` drops the account UUID and ID.

### Turning it on

- **Coder**: the template's `otlp_endpoint` variable sets `OTEL_EXPORTER_OTLP_ENDPOINT`
  and `OTEL_RESOURCE_ATTRIBUTES=host=<container>,env=coder` (see
  [`coder/dev-system/README.md`](../../coder/dev-system/README.md)).
- **Kubernetes**: in the container spec,

  ```yaml
  env:
    - name: OTEL_EXPORTER_OTLP_ENDPOINT
      value: http://otel-gateway.monitoring:4318
    - name: OTEL_RESOURCE_ATTRIBUTES
      value: host=my-pod,env=homelab
  ```

- **`docker run`**: `-e OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-gateway:4318`.
- **Desktop dev container**: `containerEnv` in the consumer's `devcontainer.json`, so
  every process in the container sees it, a `docker exec` included:

  ```json
  "containerEnv": {
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://otel-gateway.lan:4318",
    "OTEL_RESOURCE_ATTRIBUTES": "host=desktop,env=desktop"
  }
  ```

- **The `callum-tools` feature** (deprecated, cbundy/dev-system#89) has no switch: set the
  Claude Code variables above yourself (`containerEnv` or `remoteEnv`), and an `[otel]`
  table in codex's `config.toml`.

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
docker build -f images/base/Dockerfile -t "dev-system-base:test-$(git rev-parse --short HEAD)" .
```

Tag test builds by commit, as above. Several agents can build and test at once on one Docker
host, and a shared tag lets one silently replace another's image mid-run.
`dev-system-base:local` is reserved: it is the image the dev-system-testbed's
`.devcontainer/local` config opens, so build it only on purpose, with the testbed's
`scripts/build-local-image.sh`, when you want to open a branch in that config.

Run the container test suite against it. Test 7 needs the devcontainer CLI; set
`DEVCONTAINER="npx -y @devcontainers/cli"` if it is not installed, or `SKIP_DEVCONTAINER=1`
to skip it. The agentsview section starts a throwaway `postgres:17` container to exercise the agentsview
push end to end:

```bash
images/base/test/test.sh "dev-system-base:test-$(git rev-parse --short HEAD)"
```

With no further argument it runs every section. Add a group name (`test.sh --list-groups`
prints them) or a section number to run just that part, for example `... logins` or `... 11`.
The sections are in `images/base/test/sections/`, the shared helpers in `lib.sh`; a new
section file must be added to a group in `test.sh` (`groups.test.sh`, part of `npm test`,
fails otherwise, and also checks the workflow matrix lists the same groups).

`.github/workflows/publish-base-image.yml`:

- **Pull requests** touching `images/base/`, `features/src/callum-tools/` or the workflow
  build and test the image. Nothing is pushed.
- **Manual dispatch** on `main` (Actions tab, or `gh workflow run publish-base-image.yml`)
  is the deliberate release: build, test, push the tags for the current `VERSION`. A
  dispatch from any other branch fails, since it would overwrite the mutable tags.
- **Weekly schedule** rebuilds and re-pushes the current `VERSION`'s tags, but only once
  that version has been released by hand, so merging a `VERSION` bump never publishes it
  by itself. A failed check fails the run rather than skipping the week.
- The image is built once and saved as an artifact; the test groups run as parallel jobs
  against it, and the push job (dispatch and schedule only) needs every one of them and
  sends that same tested image. The job `Base image result` is green only if the build and
  every test job passed and the push job passed or was skipped (pull requests): the one name a branch-protection rule could require.

**Visibility:** the package is public, so consumers pull it with no login. It took the
visibility of this public repo when the first dispatch created it (1.0.0, 2026-10-03), so
there is no manual step; see "GHCR visibility" in `docs/architecture.md`.
