# dev-system

Callum's portable end-to-end development flow, extracted from the mealplanning repo so it can
bootstrap and stay in sync across repositories. One repo, one version history, four surfaces:

```
dev-system/
├── .claude-plugin/marketplace.json   # Claude Code plugin marketplace catalog
├── plugins/callum-flow/              # plugin: skills (issue-orchestrator, implement-issue), hooks
├── features/callum-tools/            # Dev Container Feature: installs no-mistakes, treehouse, etc.
├── templates/                        # repo config templates: .no-mistakes.yaml, treehouse.toml,
│                                     #   CLAUDE.md skeleton, .claude/settings.json, workflows
├── bin/callum-dev.js                 # CLI: `init` (scaffold a repo), `update` (3-way merge templates)
└── package.json                      # installable via github:cbundy/dev-system#semver:^1
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
stays exactly as it was. So every release that changes anything under `plugins/callum-flow`
MUST bump `version` in the same change, following semver: patch for a skill wording fix,
minor for a new skill or capability, major for a breaking change to an existing skill's
contract (e.g. a renamed parameter or removed behavior). Skipping the bump ships the change
to this repo but not to any consumer.

## Consumer repo wiring

A consumer repo commits only:

- `.claude/settings.json` with `extraKnownMarketplaces` pointing at `cbundy/dev-system` and
  `enabledPlugins` for `callum-flow@callum` - skills install themselves on folder trust.
- A thin `.devcontainer/devcontainer.json` referencing the `callum-tools` feature plus
  repo-specific mounts/env.
- Repo-owned config values (test/lint commands in `.no-mistakes.yaml`, repo section of
  `CLAUDE.md`); the synced structure around them comes from `templates/`.
- `@callum/dev-system` as a devDependency: `github:cbundy/dev-system#semver:^1`.

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

`plugins/callum-flow` (issue-orchestrator, implement-issue skills) is extracted and
distributed via the `callum` marketplace. `features/` and `templates/` extraction is
tracked in this repo's remaining issues.
