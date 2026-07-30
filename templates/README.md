# templates

Config files a consumer repo copies in verbatim, then edits at the marked repo-owned
points. Every file uses inline markers - `synced: do not edit (managed by dev-system)` /
`repo-owned: edit freely` - in that file's own comment syntax, so `callum-dev update` can
merge synced blocks forward without touching repo-owned ones. JSON has no comment syntax,
so `.claude/settings.json`'s split is documented here instead (see below).

## `.no-mistakes.yaml` -> `.no-mistakes.yaml`

no-mistakes pipeline config.

- Repo-owned: `commands.lint` / `commands.test` (fill in the `<REPLACE>` placeholders -
  remember fresh no-mistakes worktrees have no dependencies installed, so install first if
  your package manager needs it), additions to `ignore_patterns`, and the optional
  `document.instructions` block.
- Synced: `auto_fix`, `agent`, `agent_args_override`, and the commented-out optional
  sections (`commit`, `intent`, `test.evidence`) - uncomment a copy in your repo-owned
  block if you want to opt in, rather than uncommenting the synced copy in place.

## `treehouse.toml` -> `treehouse.toml`

Worktree manager config. No synced structure to preserve - both `max_trees` and `root`
are repo-owned, tune freely. Shipped as a starting point matching dev-system's own repo.

## `CLAUDE.md` -> `CLAUDE.md`

Global agent instructions.

- Synced: the `# global agent instructions` bullet list (em dash ban, no co-author, no
  manual CHANGELOG edits, research-issue-stays-open policy, PR-issue linkage rules with
  closing/non-closing keywords and the `closingIssuesReferences` verification step,
  quality-over-dev-cost, E2E-first bug fixing, pixel-perfection UI standard, screenshot
  evidence requirement, brief PR descriptions, engineering-excellence/lint/flakiness
  standard) and the `## Dev container is ephemeral` section.
- Repo-owned: `## Canonical commands` and `## Implementation sub-agents` - both ship as
  placeholder headings only. Fill in this repo's actual lint/test/typecheck commands (and
  which one CI calls, so they can't drift), and this repo's worktree/isolation mechanism.
- One placeholder inside the synced screenshot-evidence bullet: the path to this repo's
  e2e visual verification doc. Fill that in even though the surrounding bullet is synced.

## `.claude/settings.json` -> `.claude/settings.json`

Wires up the `callum` plugin marketplace and enables `callum-flow`. JSON has no comment
syntax, so the split is documented here instead of inline: the whole file is synced -
there is no repo-owned content in it. Do not hand-edit; a future `callum-dev update`
replaces it wholesale.

## `.devcontainer/devcontainer.json` -> `.devcontainer/devcontainer.json`

Thin devcontainer example. devcontainer.json is JSONC (comments allowed) per the spec
itself, so the split is marked inline like the other templates.

- Repo-owned: `name`, `image` (swap for whatever base this repo needs, or a `build` block
  for a custom Dockerfile), `mounts` (the example shows the no-mistakes bind-mount pattern
  - note `${localEnv:USERPROFILE}` is Windows-host-specific, use `${localEnv:HOME}` on
  Linux/macOS, or drop the mount if unneeded), and `remoteEnv`.
- Synced: `features` (git, github-cli, and `callum-tools` - the dev-system feature that
  installs no-mistakes, treehouse, etc.) and `remoteUser`. A nested repo-owned marker
  inside `features` shows where to add extra features without disturbing the synced ones.

## Validating your copy

- JSON files (`.claude/settings.json`) must parse with a strict JSON parser.
- `.devcontainer/devcontainer.json` is JSONC - strip `//` comments before parsing if you
  need to validate it programmatically.
- `.no-mistakes.yaml` must parse as YAML.
- No `<REPLACE>` placeholders should remain once a repo is wired up.
