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
7. An opt-in OpenTelemetry switch for Claude Code and codex that stays off unless the
   runtime supplies a collector endpoint (see [Telemetry](#telemetry)).

The callum-tools watcher scripts (`pipeline-watch.sh`, `queue-watch.sh`) are staged at
`/usr/local/share/callum-tools/`, the same path the feature uses, so the `callum-flow`
orchestrator skill works unchanged.

## What the image does not own

These belong to the consumer image or the runtime:

- Repo-specific tools (Terraform, Python stacks, Docker CLI and so on). Add them in the
  consumer's Dockerfile.
- Secrets or credentials of any kind. The image is public.
- Telemetry endpoints and resource attributes. The runtime supplies them; the image only
  knows how to turn export on when it does.
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
4. Writes or removes codex's OTel export config, `/etc/codex/config.toml`, depending on
   whether `OTEL_EXPORTER_OTLP_ENDPOINT` is set (see [Telemetry](#telemetry)).
5. Pins the codex model no-mistakes uses in `$NM_HOME/config.yaml`, only if no pin exists,
   with the same rules as the callum-tools `codexModel` option. `DEV_CODEX_MODEL` overrides
   the default (the feature's `codexModel` default); `DEV_CODEX_MODEL=""` skips the pin.
6. If gh is logged in, runs `gh auth setup-git`. `~/.gitconfig` is not persisted, so this is
   redone on each start.
7. If `$DEV_WORKSPACE` (default: the current directory) is in a git repo with
   `.no-mistakes.yaml`, starts the no-mistakes daemon (a process, so gone after every
   restart) and runs the callum-tools `recover-no-mistakes.sh` to re-register the repo if
   needed. If git refuses the checkout because another user owns it ("dubious
   ownership"), it warns with the fix instead of skipping silently.
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
- treehouse is on `PATH`.

It also prints `INFO` lines for telemetry: off (no endpoint), or the endpoint, protocol and
resource attributes, whether Claude Code and codex export is switched on, and whether the
collector accepts a TCP connection. Telemetry is opt-in, so these lines never count as a
failure, an unreachable collector included.

It exits 1 if any check fails. `dev-doctor --warn-only` prints the same report and always
exits 0.

## Telemetry

Containers built from this image can export OpenTelemetry metrics and events from Claude
Code and codex, for example into Grafana through an OTLP gateway (the homelab side is
cbundy/network#137). It is **opt-in by presence of `OTEL_EXPORTER_OTLP_ENDPOINT`**: when the
runtime sets it, export switches on; when it is unset (a desktop container with no
collector, say), nothing is exported, no telemetry variable is set and nothing errors.

### The env contract

The runtime (Coder template, k8s pod spec, `devcontainer.json`) supplies:

| Variable | Required | Example | Notes |
|---|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | yes - the switch | `http://<gateway>:4318` | base URL, no `/v1/...` path |
| `OTEL_RESOURCE_ATTRIBUTES` | recommended | `host=<name>,repo=<repo>,env=homelab` | comma-separated `key=value`, no spaces, quotes, commas or backslashes in values (percent-encode them) |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | no | `grpc` | default `http/protobuf`; set `grpc` for a `:4317` endpoint |

`host`, `repo` and `env` are the label names the gateway keeps (cbundy/network#137); use
exactly these keys. Any standard `OTEL_*` variable the runtime sets (headers, per-signal
endpoints, export intervals, `OTEL_METRICS_INCLUDE_*`) passes straight through to Claude Code.

When the endpoint is set, the image fills in only what is still unset:

```
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

A value the runtime sets wins, so `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` or
`CLAUDE_CODE_ENABLE_TELEMETRY=0` (keep the endpoint for other tools, but not Claude) work as
expected. `http/protobuf` is the default because it is also the OpenTelemetry spec default,
so other OTel-instrumented programs in the container see no change. Claude Code itself has
no default protocol, so one is always set.

### Where the switch lives, and why

The issue (cbundy/dev-system#68) was that `dev-init` exporting variables reaches only its
own process, not the shells, tmux sessions, `claude remote-control` or Coder scripts started
later. The endpoint itself is container environment, so every process inherits it; only
the derived switches need computing. They are computed by one POSIX snippet,
`/etc/profile.d/dev-system-otel.sh` (source: `images/base/otel-env.sh`), hooked into every
shell entry point:

| Started as | Hook | Covers |
|---|---|---|
| login shell (`bash -l`, `sh -l`) | `/etc/profile.d/` | VS Code and Coder terminals, tmux windows, `docker exec ... bash -l`, the no-mistakes daemon, which resolves its agents' environment from a login shell |
| interactive non-login bash | `/etc/bash.bashrc` | `docker exec -it ... bash` |
| non-interactive bash | `BASH_ENV` (image `ENV`) | scripts, `bash -c`, Coder `startup_script`, `dev-init` |
| zsh (any) | `/etc/zsh/zshenv` | a user whose shell is zsh |

`claude` inherits from whichever of these started it, as do `claude remote-control` in tmux
and the agents no-mistakes spawns. The snippet is idempotent and only exports, because
`BASH_ENV` sources it into every bash script.

Alternatives considered:

- **Managed Claude Code settings** (`/etc/claude-code/managed-settings.d/*.json` with an
  `env` block, written by `dev-init`). It would also reach a `claude` exec'd with no shell,
  but managed `OTEL_EXPORTER_OTLP_*` values override and remove ones the runtime sets, it
  needs a root write at start-up, it would make every container report a managed policy
  source, and a malformed managed file stops Claude Code from starting at all. Not worth it
  for the one case it adds.
- **Static image `ENV`** for the Claude switches. With no endpoint, Claude Code would still
  have its exporters switched on with nowhere to send to. The docs do not define that case
  (it is not verified quiet), and it breaks the "unset means nothing is enabled" rule.
- **User settings** (`$CLAUDE_CONFIG_DIR/settings.json` `env`). That file is persisted and
  shared by every container on the volume, so a switch written there would outlive the
  runtime that set the endpoint.

**Not covered:** a `claude` exec'd directly with no shell in between (for example a pod
`command: ["claude", ...]`, or `docker exec <ctr> claude ...`). Wrap it in `bash -c` (or
`bash -lc`) so `BASH_ENV` applies, or set the Claude variables above in the runtime too. A
consumer image that sets its own `BASH_ENV` replaces this one and should source
`/etc/profile.d/dev-system-otel.sh` from its file. `sh -c` (dash) reads no start-up file.

Claude Code ignores OTel exporter variables in a repository's `.claude/settings.json`, so a
repo cannot redirect or enable telemetry. Telemetry variables in your own
`$CLAUDE_CONFIG_DIR/settings.json` `env` block, or in managed settings, are honoured as usual.

### codex

codex reads its exporters from `config.toml` only. When the endpoint is set, `dev-init`
writes codex's **system** config, `/etc/codex/config.toml` (the directory is `node`-owned in
the image), with an `[otel]` table: logs and metrics exporters derived from the endpoint and
protocol (`otlp-http` gets the per-signal `/v1/logs` and `/v1/metrics` URLs codex needs, or
the `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` / `_METRICS_ENDPOINT` values when set; `otlp-grpc`
gets the endpoint as is), `environment` copied from the `env=` resource attribute (codex
otherwise stamps its own `env=dev` over `OTEL_RESOURCE_ATTRIBUTES`) and
`log_user_prompt = false`. codex still picks up `OTEL_RESOURCE_ATTRIBUTES` for `host` and
`repo`. Traces stay off.

- **Your config is never touched, and wins.** The system layer ranks below
  `$CODEX_HOME/config.toml`. codex merges layers table by table, so rather than mix two
  `[otel]` tables (an `otlp-grpc` exporter of yours over an `otlp-http` one of dev-init's
  would not parse), `dev-init` writes nothing while your `config.toml` has an `[otel]`
  table or `otel.` keys, and your settings apply alone.
- **Nothing outlives the runtime.** The file is in the container filesystem, not `/persist`,
  and `dev-init` removes it on a start without the endpoint.
- Only a file carrying `dev-init`'s marker line is rewritten or removed; a consumer image's
  own `/etc/codex/config.toml` is left alone (and then codex is not configured by `dev-init`).
- codex reads the file when it starts, so a codex started before `dev-init` ran does not
  export. Run `dev-init` from the start-up hook before starting agents.

### no-mistakes

no-mistakes has no OTLP export of its own, and the image does not add one. The contract:

- **Agent activity is covered.** The no-mistakes daemon resolves its environment from a
  login shell, so the Claude Code and codex agents it runs export like any other, with the
  same resource attributes.
- **Run outcomes stay on the volume** at the documented paths: one directory per run under
  `$NM_HOME/logs/<run-id>/` (`/persist/no-mistakes/logs`, also reachable as
  `~/.no-mistakes/logs`) and the run database `$NM_HOME/state.sqlite`, which
  `no-mistakes runs` and `no-mistakes stats` read. Shipping them to Loki is the collector
  side's job (cbundy/network#137): a log tailer with access to the `/persist` volume.

no-mistakes' own anonymous usage telemetry is a separate upstream feature, controlled by
`NO_MISTAKES_TELEMETRY`; the image does not change it.

### What is collected, and privacy defaults

- **Claude Code** metrics (`claude_code.session.count`, `.token.usage`, `.cost.usage`,
  `.lines_of_code.count`, `.commit.count`, `.pull_request.count`,
  `.code_edit_tool.decision`, `.active_time.total`) and events (`claude_code.api_request`,
  `.api_error`, `.tool_result`, `.tool_decision`, `.user_prompt` and others), per the
  [Claude Code monitoring docs](https://code.claude.com/docs/en/monitoring-usage). Each
  carries `session.id`, `user.id`, `user.email` and similar standard attributes; dropping
  per-session ids from metric labels is the gateway's job.
- **codex** metrics (`codex.api_request`, `codex.tool.call`, ...) and log events
  (`codex.conversation_starts`, `codex.api_request`, `codex.tool_decision`, ...).
- **Prompt text is off.** `OTEL_LOG_USER_PROMPTS` is never set by the image, so the
  `claude_code.user_prompt` event carries the prompt length with the prompt redacted, and codex gets
  `log_user_prompt = false`. Setting `OTEL_LOG_USER_PROMPTS=1` in the runtime turns prompt
  text on for both. Tool parameters (`OTEL_LOG_TOOL_DETAILS`), assistant responses and raw
  API bodies stay at Claude Code's defaults (off).

### Enabling it

Coder template (Terraform), on the agent or container:

```hcl
env = {
  OTEL_EXPORTER_OTLP_ENDPOINT = "http://<gateway>:4318"
  OTEL_RESOURCE_ATTRIBUTES    = "host=${data.coder_workspace.me.name},repo=<repo>,env=homelab"
}
```

Kubernetes pod spec:

```yaml
env:
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: http://<gateway>:4318
  - name: OTEL_RESOURCE_ATTRIBUTES
    value: host=<name>,repo=<repo>,env=homelab
```

`devcontainer.json` (desktop): use `containerEnv`, so the variables are in the container's
own environment for every process, not just VS Code's terminals:

```jsonc
"containerEnv": {
  "OTEL_EXPORTER_OTLP_ENDPOINT": "http://<gateway>:4318",
  "OTEL_RESOURCE_ATTRIBUTES": "host=<name>,repo=<repo>,env=desktop"
}
```

Then start the agents after `dev-init` has run (it already runs first on the desktop and
should run first in a Coder `startup_script`), and check with `dev-doctor`.

### callum-tools feature users

The `callum-tools` feature does not ship this switch. A feature consumer owns its
`devcontainer.json`, which is already per-repo, static configuration, so the simplest
equivalent is to set the full Claude Code variables there (in `containerEnv`):
`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`,
`OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_ENDPOINT` and
`OTEL_RESOURCE_ATTRIBUTES`, and the `[otel]` table above in `~/.codex/config.toml` for codex.
Shipping the conditional through the feature would need a feature version bump and a
runtime hook that the feature does not otherwise have.

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

**First publish:** new GHCR packages are private. After the first dispatch, open the
`dev-system/base` package settings on GitHub and change its visibility to public, as for
the `callum-tools` feature.
