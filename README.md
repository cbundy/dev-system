# dev-system

Callum's portable end-to-end development flow, extracted from the mealplanning repo so it can
bootstrap and stay in sync across repositories. One repo, one version history, four surfaces:

```
dev-system/
├── .claude-plugin/marketplace.json   # Claude Code plugin marketplace catalog
├── plugins/callum-flow/              # plugin: skills (issue-orchestrator, implement-issue), hooks
├── features/src/callum-tools/        # Dev Container Feature: installs no-mistakes, treehouse, Claude Code
├── features/test/callum-tools/       # feature tests, run in CI by test-features.yml
├── templates/                        # repo config templates: .no-mistakes.yaml, treehouse.toml,
│                                     #   CLAUDE.md skeleton, .claude/settings.json, workflows
├── bin/callum-dev.js                 # CLI: `init` (scaffold a repo), `update` (3-way merge templates)
├── tests/                            # CLI end-to-end tests, run in CI by test-cli.yml
└── package.json                      # installable via github:cbundy/dev-system#semver:0.x
```

## The three layers and how each one distributes

| Layer | Contents | Mechanism | Update path in a consumer repo |
|---|---|---|---|
| Agent behavior | skills, generic agent rules | Claude Code plugin via private marketplace (this repo) | `/plugin marketplace update` or auto-update |
| Environment | devcontainer tooling installs | Dev Container Feature on GHCR | container rebuild pulls latest matching tag |
| Repo config | `.no-mistakes.yaml`, `treehouse.toml`, `CLAUDE.md`, CI | templates + `callum-dev` CLI (npm git dependency) | `npm update` + `npx callum-dev update` |

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

## Dev Container Feature

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

**Visibility decision**: the GHCR package is public while this source repo stays private.
The package contains only install scripts for tools that are themselves public, and a
private package would require a `packages:read` PAT docker-login on every machine and CI
job that builds a consumer container. After the first publish, flip the package to public
in GHCR package settings (new packages default to private).

## Templates and the callum-dev CLI

`templates/` holds the repo config files (see `templates/README.md` for the per-file
synced/repo-owned split); `bin/callum-dev.js` scaffolds and syncs them. In a consumer repo:

```
npm i -D github:cbundy/dev-system#semver:0.x
npx callum-dev init
```

`init` copies the templates in (never clobbering existing files), prompts for the
repo-owned values (repo name, lint/test commands), and records two things to commit
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

## Consumer repo wiring

A consumer repo commits only:

- `.claude/settings.json` with `extraKnownMarketplaces` pointing at `cbundy/dev-system` and
  `enabledPlugins` for `callum-flow@callum` - skills install themselves on folder trust.
- A thin `.devcontainer/devcontainer.json` referencing the `callum-tools` feature plus
  repo-specific mounts/env.
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
`features/src/callum-tools` via GHCR, and `templates/` via the `callum-dev` CLI
(npm git dependency; installable from the first tag that contains `package.json`,
i.e. v0.3.0 onwards). `/update-dev <change request>` in any consumer repo proposes
a change to this repo as a reviewed PR. Releasing is documented in `RELEASING.md`.
Remaining extraction work (migrating mealplanning itself onto these layers) is
tracked in this repo's issues.
