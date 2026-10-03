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
   | git | base image | image rebuild |

   Also `jq`, `ripgrep`, `tmux` (for a long-running `claude remote-control`), `less` and
   `openssh-client`. Every tool binary lives outside `/persist`, so a new image always
   brings fresh binaries.
3. The persistence contract (below).
4. `dev-init`, the idempotent start-up setup for state that cannot be baked in.
5. `dev-doctor`, a health check that reports missing auth or broken state loudly.
6. Default devcontainer metadata (the `devcontainer.metadata` image label), so desktop use
   gets the persistence volumes and `dev-init` automatically.

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

no-mistakes keeps its binary in `~/.no-mistakes/bin`, outside `/persist`, and
`no-mistakes update` replaces it there. `~/.no-mistakes/logs` is a link to
`/persist/no-mistakes/logs`, because the callum-flow skills read run logs at that path.

The same list is published as the image label
`dev.cbundy.persist=/persist/claude,/persist/codex,/persist/gh,/persist/no-mistakes`, so
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
image metadata runs it as `postStartCommand`. On other runtimes, run it from the start-up
hook after the workspace is cloned (for example a Coder `startup_script`). It is idempotent
and best-effort: it logs problems but always exits 0, so a container never fails to start
because of it.

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
7. Runs `dev-doctor --warn-only`.

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
- treehouse is on `PATH`.

It exits 1 if any check fails. `dev-doctor --warn-only` prints the same report and always
exits 0.

## First login

Run these once per machine (or per PVC). The logins land in `/persist`, so they survive
container rebuilds and image updates.

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
`VOLUME` for it.

On the desktop, a thin `.devcontainer/devcontainer.json` is enough:

```jsonc
{
  "name": "my-repo",
  "build": { "dockerfile": "Dockerfile" }
  // or, with no repo-specific tools: "image": "ghcr.io/cbundy/dev-system/base:1"
}
```

The image's metadata label supplies `remoteUser: node`, `updateRemoteUserUID: false`,
`containerEnv` with the `/persist` variables, `postStartCommand: dev-init` and these
mounts, which the devcontainer CLI and VS Code merge into your config:

| Named volume | Target |
|---|---|
| `dev-system-claude` | `/persist/claude` |
| `dev-system-codex` | `/persist/codex` |
| `dev-system-gh` | `/persist/gh` |
| `dev-system-no-mistakes` | `/persist/no-mistakes` |

`updateRemoteUserUID: false` keeps `node` at UID 1000 even on a Linux host whose user has
another UID. Otherwise the devcontainer CLI renumbers `node` to the host UID and it can no
longer write the 1000-owned volumes. On such a host, files `node` creates in a bind-mounted
workspace are owned by UID 1000 on the host.

The volumes are shared by every repo on the same Docker host, so you log in once per
machine. To isolate a repo, list a mount with the same `target` in its `devcontainer.json`;
the consumer's mount replaces the image default. If a consumer Dockerfile sets its own
`devcontainer.metadata` label, it replaces this one, so copy these entries into it.

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
to skip it:

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
