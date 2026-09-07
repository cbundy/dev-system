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
- Synced: `auto_fix`, `agent`, and the commented-out optional
  sections (`commit`, `intent`, `test.evidence`) - uncomment a copy in your repo-owned
  block if you want to opt in, rather than uncommenting the synced copy in place.
- Not here: the codex model pin. `agent_args_override` / `agent_config` are global-only
  keys that no-mistakes silently ignores in a repo file; the `callum-tools` feature writes
  the pin into `~/.no-mistakes/config.yaml` instead (option `codexModel`).

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

## `gitignore` -> `.gitignore`

Ignore rules for the artefacts this system's tooling generates. **Note the source file
has no leading dot**, unlike every other template here: npm silently drops any file
named `.gitignore` from a package, so a `templates/.gitignore` would be missing from
every install (verified with `npm pack --dry-run`). The CLI maps it to `.gitignore` in
the consumer repo via the manifest's `src` field. Do not rename it back.

- Synced: this system's own generated paths (`.no-mistakes/`, `.treehouse/`,
  `.claude/worktrees/`, `.claude/settings.local.json`) plus the ecosystem defaults these
  projects consistently need - Node build output, Playwright reports, Python caches,
  secrets, logs, OS/editor cruft.
- Repo-owned: this repo's own paths. Build output under a non-standard name, local
  databases, fixture data, generated clients, vendored dependencies.

Two things about this file that are easy to get wrong:

- **The block order is reversed** relative to the other templates - repo-owned sits at the
  bottom. gitignore precedence is last-match-wins, so a repo-owned block placed first
  would be silently outranked by the synced rules below it, and a `!` un-ignore could
  never work.
- **Three of this system's files must stay tracked** and are commented as such in the
  template: `.no-mistakes.yaml` (the pipeline config, which sits right beside the ignored
  `.no-mistakes/` state directory - hence the trailing slash on that rule), and
  `.callum-dev.json` plus `.callum-dev/baseline/`, which are what make `callum-dev update`
  a 3-way merge rather than an overwrite. Ignoring any of them looks tidy and breaks
  things quietly.

## Validating your copy

- JSON files (`.claude/settings.json`) must parse with a strict JSON parser.
- `.devcontainer/devcontainer.json` is JSONC - strip `//` comments before parsing if you
  need to validate it programmatically.
- `.no-mistakes.yaml` must parse as YAML.
- No `<REPLACE>` placeholders should remain once a repo is wired up.
- `.gitignore`: check behaviour with `git check-ignore -v <path>`, not by eye. The rules
  that matter most are the directory-vs-file ones, and those are exactly the ones reading
  the patterns does not settle.
