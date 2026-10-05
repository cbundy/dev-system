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

Wires up the `callum` plugin marketplace and enables `callum-flow`, and ships the
generic `permissions.allow` list the implement-issue/orchestrator flow needs
(`no-mistakes axi run/rerun/abort/sync/status`, `no-mistakes runs`/`axi logs`,
`treehouse get/return/status`, `gh issue/api/pr view/pr checks/pr list`) - see
dev-system#44. This list exists here, not as plugin-shipped permissions, because a
Claude Code plugin's own `settings.json` only applies its `agent` and
`subagentStatusLine` keys; every other key, including `permissions`, is dropped at
load ([plugin manifest reference](https://code.claude.com/docs/en/plugins-reference):
"Settings Claude Code applies while the plugin is enabled. Only `agent` and
`subagentStatusLine` take effect; other keys are dropped at load."). Shipping the
allow list from this synced template is the only mechanism that reaches every
consumer repo.

JSON has no comment syntax, so the split is documented here instead of inline:

- **Synced, do not hand-edit**: everything in the file except `permissions.allow`
  (`extraKnownMarketplaces`, `enabledPlugins`, and any future top-level key). A future
  `callum-dev update` replaces these wholesale, the same as before this file carried
  permissions.
- **Repo-owned**: entries you append to `permissions.allow` beyond the synced list
  above - e.g. this repo's own `Bash(scripts/evidence-upload.sh *)` or
  `Bash(scripts/worktree-bootstrap.sh *)` (see mealplanning#442 for the pattern).
  `callum-dev update` unions the array: the fresh synced list plus whatever entries
  you added beyond the old baseline, deduplicated. Add your own by editing this
  committed file directly - it is the only settings file a treehouse worktree
  sub-agent ever sees.
- **Never here**: powers that must stay orchestrator-only in the main checkout -
  `gh pr merge`, `gh pr edit`, `no-mistakes axi respond`, and any pipeline/queue
  watcher script. Keep those as `allow` entries in the gitignored, uncommitted
  `.claude/settings.local.json` in the main checkout instead. Do not add a `deny`
  rule for them here: committed settings apply in the main checkout too, so a `deny`
  would also block the orchestrator, not just worktree sub-agents. The split that
  keeps a worktree sub-agent from merging is that `settings.local.json` never leaves
  the main checkout - worktrees start with none of it - not a rule that blocks the
  command everywhere.

## `.devcontainer/devcontainer.json` -> `.devcontainer/devcontainer.json`

Thin devcontainer config. devcontainer.json is JSONC (comments allowed) per the spec
itself, so the split is marked inline like the other templates. There are two kinds, and
each repo uses one: `callum-dev init` asks (or takes `--devcontainer base-image|feature`)
and records the choice as `devcontainer` in `.callum-dev.json`. A stamp without the key is
a `feature` repo, the only kind before the choice existed.

To switch an existing repo, run `callum-dev update --devcontainer <kind>`. It merges from
the old kind's template to the new one like any update, so the repo's name comes across
and untouched synced content is swapped. A line both the repo and the switch change (a
custom `image`, say) is left as a conflict to resolve by hand. The baseline is kept as
`.callum-dev/baseline/.devcontainer/devcontainer.json` for both kinds.

`feature` is deprecated (cbundy/dev-system#89): `init` and `update` warn while a repo is on
it, and the fix is `callum-dev update --devcontainer base-image`.

### `base-image` (default): `.devcontainer/devcontainer.base-image.json`

Built on the dev-system base image (`images/base/README.md`), whose own metadata supplies
`remoteUser`, the `/persist` environment, `dev-init` at post-start and the gh volume
shared by every repo on the host.

- Repo-owned: `name`, `image` (`ghcr.io/cbundy/dev-system/base:2`, or swap for a `build`
  block with a Dockerfile `FROM` it for repo-specific tools), `remoteEnv`, and the nested
  repo-owned slot at the top of `mounts` (each added mount followed by a comma, so the
  synced lines below it stay untouched).
- Synced: `mounts` - the four per-repo volumes (`dev-system-${devcontainerId}-claude`,
  `-codex`, `-no-mistakes`, `-agentsview`) at `/persist/*`. They live here, not in the
  image, because the devcontainer CLI expands no variables in image metadata: there
  `${devcontainerId}` comes out empty and every repo would share one set (cbundy/dev-system#73,
  #78). Synced, so `callum-dev update` keeps every repo's set correct. Without them that
  state is lost on every rebuild, and `dev-init` warns at start-up. `${devcontainerId}`
  hashes the workspace folder and the config file's path, so a repo with several
  devcontainer configs gets separate volumes, and so separate Claude and codex logins, for
  each config (gh's volume is shared).

### `feature`: `.devcontainer/devcontainer.json`

Any base image plus the `callum-tools` feature. No `/persist` contract.

- Repo-owned: `name`, `image` (swap for whatever base this repo needs, or a `build` block
  for a custom Dockerfile), `mounts` (empty by default; don't bind-mount a host `~/.no-mistakes` - its state is per
  repo, and a Windows-side bind under WSL breaks it, cbundy/dev-system#19 and #73), and
  `remoteEnv`.
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
