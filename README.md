# dev-system

Callum's portable end-to-end development flow, extracted from the mealplanning repo so it can
bootstrap and stay in sync across repositories. One repo, one version history, five surfaces:

```
dev-system/
├── .claude-plugin/marketplace.json   # Claude Code plugin marketplace catalog
├── plugins/callum-flow/              # plugin: skills (issue-orchestrator, implement-issue), hooks
├── features/src/callum-tools/        # DEPRECATED Dev Container Feature; its scripts still feed images/base
├── features/test/callum-tools/       # feature tests, run in CI by test-features.yml
├── images/base/                      # base image ghcr.io/cbundy/dev-system/base: Dockerfile,
│                                     #   dev-init, dev-doctor, tests (publish-base-image.yml)
├── coder/dev-system/                 # Coder workspace template on the base image
├── templates/                        # repo config templates: .no-mistakes.yaml, treehouse.toml,
│                                     #   CLAUDE.md skeleton, .claude/settings.json, gitignore,
│                                     #   workflows
├── bin/callum-dev.js                 # CLI: `init` (scaffold a repo), `update` (3-way merge templates)
├── tests/                            # CLI end-to-end tests, run in CI by test-cli.yml
└── package.json                      # installable via github:cbundy/dev-system#semver:0.x
```

## The three layers and how each one distributes

| Layer | Contents | Mechanism | Update path in a consumer repo |
|---|---|---|---|
| Agent behavior | skills, generic agent rules | Claude Code plugin via private marketplace (this repo) | `/plugin marketplace update` or auto-update |
| Environment (deprecated) | devcontainer tooling installs | Dev Container Feature on GHCR | move to the base image: `npx callum-dev update --devcontainer base-image` |
| Environment | prebuilt agent image: Node, Claude Code, codex, no-mistakes, treehouse, agentsview, gh, plus the `/persist` state contract and a push of session history to a central agentsview, on wherever the runtime supplies its URL as a secret file | base image `ghcr.io/cbundy/dev-system/base` on GHCR, extended by a per-repo Dockerfile | rebuild/re-pull; tags are mutable and refreshed weekly |
| Repo config | `.no-mistakes.yaml`, `treehouse.toml`, `CLAUDE.md`, `.gitignore`, CI | templates + `callum-dev` CLI (npm git dependency) | `npm update` + `npx callum-dev update` |

## Plugin

`plugins/callum-flow` is distributed through the `callum` marketplace catalog at
`.claude-plugin/marketplace.json` in this repo's root. To install it in a consumer repo:

```
/plugin marketplace add cbundy/dev-system
```

Then enable `callum-flow@callum` (either interactively via `/plugin`, or by committing it
under `enabledPlugins` in `.claude/settings.json` - see "Consumer repo wiring" below).

**Version-bump-on-release policy**: the plugin manifest
(`plugins/callum-flow/.claude-plugin/plugin.json`) carries an explicit `version` field.
Consumers only receive an update when that field is bumped - `/plugin marketplace update`
(or an auto-update) pulls the new catalog, but a plugin pinned to an unchanged `version`
stays exactly as it was. Individual PRs do NOT bump the version: releasing is a separate,
deliberate step Callum runs when ready (eventually via a release workflow), bumping
`version` following semver - patch for wording fixes, minor for a new skill or capability,
major for a breaking change to an existing skill's contract. Until that bump, merged
changes live in this repo but ship to no consumer.

## Dev Container Feature (deprecated)

> **Deprecated (2026-10-05, cbundy/dev-system#89).** The base image (below) is the supported
> environment. The published feature `ghcr.io/cbundy/dev-system/callum-tools` and the
> `feature` devcontainer template get no new capabilities: new environment work goes into
> `images/base/`. Repos already pinned to `callum-tools:1` keep working. Move them with
> `npx callum-dev update --devcontainer base-image`. The scripts in
> `features/src/callum-tools/` are **not** deprecated, since the base image builds from
> them, so fixes to them still land here and `test-features.yml` keeps testing them.
> Removing the feature is a separate, later decision.

`features/src/callum-tools` installs the flow's tooling - the no-mistakes pipeline CLI,
treehouse, and the Claude Code CLI (each toggleable via a boolean option). Because these
are per-user installs (and `~/.no-mistakes` may be a run-time bind mount), the feature
installs nothing at image build time: it stages a setup script that the feature's
`postCreateCommand` runs as the remote user, judging each install by whether the tool
ends up on PATH. Consumers reference it as:

```jsonc
"features": {
  "ghcr.io/cbundy/dev-system/callum-tools:1": {}
}
```

Publishing is manual (`Publish features` workflow, Actions tab), mirroring the deliberate
release policy; the devcontainers action only pushes versions that do not already exist,
so a feature change must bump `version` in its `devcontainer-feature.json` to publish.
CI (`test-features.yml`) builds a container with the feature applied and verifies the
tools install, on every PR touching `features/`.

**Auto-recovery of no-mistakes runtime state**: the binaries survive a container
rebuild, but two pieces of no-mistakes runtime state do not - the daemon (a process)
and the repo's registration under `~/.no-mistakes/repos/`, which is machine-local even
where `~/.no-mistakes` is itself a host bind mount (issue #18). After the no-mistakes
install step, `setup.sh` runs `recover-no-mistakes.sh`: if the workspace has a
checked-in `.no-mistakes.yaml` and `no-mistakes status` reports the repo unregistered,
it runs `no-mistakes daemon start` then `no-mistakes init` (init needs the daemon up
first, and re-reads the checked-in config to reinstall the gate). This is best-effort
and idempotent, like the rest of setup.sh: an already-registered repo, a repo with no
`.no-mistakes.yaml`, or a container with `installNoMistakes: false` are all no-ops, and
a failure here (auth or mounts not ready yet) logs to stderr without failing setup.
`recover-no-mistakes.sh` resolves the workspace via `git rev-parse --show-toplevel`
from `$PWD` - the containers.dev spec already guarantees `postCreateCommand` runs with
`$PWD` set to the workspace folder, and the toplevel walk additionally covers a
workspaceFolder pointed below the repo root (e.g. a monorepo).

**Visibility decision**: the GHCR packages (this feature and the base image) are public.
They contain only install scripts and tools that are themselves public, and a private
package would require a `packages:read` PAT docker-login on every machine and CI job that
builds a consumer container. A package first published from this repo's Actions takes the
repository's visibility, so with this repo public the packages are public with no manual
step; if the repo is ever made private, set each package's visibility in its GHCR settings.

## Base image

`images/base/` builds `ghcr.io/cbundy/dev-system/base`, a prebuilt agent dev environment
for places that never run the devcontainer lifecycle (Kubernetes pods, Coder workspaces,
plain `docker run`) as well as the desktop. Tools are baked in at build time, and tool
state (Claude, codex, gh and no-mistakes logins and config) lives under `/persist`, so it
survives rebuilds when a volume is mounted there - one per repo, except gh's, which repos
share. Consumer repos start their own
Dockerfile `FROM ghcr.io/cbundy/dev-system/base:2`. It is the supported environment: the
`callum-tools` feature is deprecated (see above), and the image reuses that feature's
scripts rather than forking them. See [`images/base/README.md`](images/base/README.md)
for the persistence contract, `dev-init`/`dev-doctor`, the mutable tag policy and how to
extend it.

## Coder workspace template

`coder/dev-system/` is the Coder template for a dev-system workspace: one container per
workspace from the base image on a Docker host, with a `/persist` volume per workspace,
`dev-init` and Claude Code with Remote Control started by the agent, a "Log in" app for
the first-run logins and a "Logins" row on the workspace page. With every parameter at its
default, `coder create <name> --template dev-system` gives a working workspace. See
[`coder/dev-system/README.md`](coder/dev-system/README.md) for the push command,
parameters and variables.

## Templates and the callum-dev CLI

`templates/` holds the repo config files (see `templates/README.md` for the per-file
synced/repo-owned split); `bin/callum-dev.js` scaffolds and syncs them. In a consumer repo:

```
npm i -D github:cbundy/dev-system#semver:0.x
npx callum-dev init
```

`init` copies the templates in (never clobbering existing files), prompts for the
repo-owned values (repo name, lint/test commands) and the devcontainer kind (`base-image`,
the default, or the deprecated `feature`; `--devcontainer <kind>` skips the prompt), and records two things to commit
alongside the config: a stamp (`.callum-dev.json`, the applied template version) and a
pristine baseline copy of each template (`.callum-dev/baseline/`). Those two make
updates a real 3-way merge instead of an overwrite:

```
npm update @callum/dev-system
npx callum-dev update
```

`update` merges each file with `git merge-file` (your file vs the baseline vs the new
template): repo-owned edits survive, upstream synced changes come forward, and a genuine
conflict is left as standard conflict markers with a non-zero exit rather than silently
resolved. Fully-synced files (`.claude/settings.json`) are replaced wholesale; fully
repo-owned ones (`treehouse.toml`) are never touched after init. `npx callum-dev check`
exits non-zero when the stamp lags the installed package - a CI-friendly drift gate.
`npx callum-dev update --devcontainer base-image` moves a repo from the deprecated
feature-based devcontainer to the base image, as an ordinary merge. `init` and `update`
print a deprecation warning while a repo is on `feature`.

## Consumer repo wiring

A consumer repo commits only:

- `.claude/settings.json` with `extraKnownMarketplaces` pointing at `cbundy/dev-system`,
  `enabledPlugins` for `callum-flow@callum` - skills install themselves on folder trust -
  and a synced `permissions.allow` list the flow's sub-agents and orchestrator need
  (`no-mistakes`/`treehouse`/`gh` read commands; see `templates/README.md` for the exact
  list and why it ships here rather than from the plugin). A repo appends its own
  `permissions.allow` entries (e.g. a local script) directly to this committed file;
  `callum-dev update` unions that array instead of overwriting it. Orchestrator-only
  powers (`gh pr merge`, `gh pr edit`, `no-mistakes axi respond`, watchers) stay out of
  this file entirely, in the main checkout's gitignored `.claude/settings.local.json`.
- A thin `.devcontainer/devcontainer.json`: the dev-system base image with its synced
  per-repo `/persist` volumes, or any image plus the `callum-tools` feature, either way
  with repo-specific mounts/env.
- Repo-owned config values (test/lint commands in `.no-mistakes.yaml`, repo section of
  `CLAUDE.md`); the synced structure around them comes from `templates/`.
- `@callum/dev-system` as a devDependency (`github:cbundy/dev-system#semver:0.x`), plus
  the `callum-dev` stamp and baseline that `init` records.

## Design rules

- Shared skills are stateless and generic: repo-specific state lives at repo-local paths
  (e.g. `.claude/orchestrator-memory.md`), never inside the skill directory.
- Every synced config file splits into a synced part and a repo-owned part, so template
  updates merge cleanly. Divergence lives in data the skills read, never in forked skill text.
- Changes to shared behavior are made HERE, tagged, and pulled into consumers - never
  patched in a consumer repo.
- Releases are git tags (`v1.2.0`); the plugin `version` field, feature tag, and npm semver
  range give consumers independent pinning per layer.

## Status

All three layers are extracted: `plugins/callum-flow` (issue-orchestrator,
implement-issue, and update-dev skills) distributes via the `callum` marketplace,
`features/src/callum-tools` via GHCR (deprecated in favour of the base image
`images/base/`, also on GHCR), and `templates/` via the `callum-dev` CLI
(npm git dependency; installable from the first tag that contains `package.json`,
i.e. v0.3.0 onwards). `/update-dev <change request>` in any consumer repo proposes
a change to this repo as a reviewed PR. Releasing is documented in `RELEASING.md`.
Remaining extraction work (migrating mealplanning itself onto these layers) is
tracked in this repo's issues.
