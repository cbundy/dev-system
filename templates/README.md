# templates

Config files a consumer repo copies in, then customizes according to each file's ownership
rules below. Marker-split files use `synced: do not edit (managed by dev-system)` /
`repo-owned: edit freely` in their own comment syntax. `treehouse.toml`, `.claude/factory-loop.json`,
`.github/workflows/ci.yml` and `.claude/settings.json` use the ownership rules documented in their
sections instead.
`callum-dev update` merges upstream changes with repo edits and surfaces conflicts.

## `treehouse.toml` -> `treehouse.toml`

Worktree manager config. No synced structure to preserve - both `max_trees` and `root`
are repo-owned, tune freely. Shipped as a starting point matching dev-system's own repo.

## `.claude/factory-loop.json` -> `.claude/factory-loop.json`

The factory loop's stop gate: `{"gateCommands": [<lint>, <test>]}`. Init-only and fully
repo-owned. `callum-dev init` fills the commands from its lint and test prompts; a blank answer
leaves a `<REPLACE: ...>` string. The commands must match `CLAUDE.md` "Canonical commands" and
`.github/workflows/ci.yml`. Put the install step in front: the loop's slot has no dependencies
installed.

## `.github/workflows/ci.yml` -> `.github/workflows/ci.yml`

A one-job CI workflow on `pull_request` and `push` to the default branch: checkout, a
`<REPLACE:` toolchain-and-install step, then the same lint and test commands as
`gateCommands` (filled by init from the same answers). Init-only and fully repo-owned. A repo
with its own CI workflow deletes this one after checking its commands match.

## Retired templates

`.no-mistakes.yaml` and `.github/pull_request_template.md` are no longer templates: onboarded
repos are set up for the factory loop only (dev-system#795). On `callum-dev update`, a repo
whose stamp lists them keeps both files byte for byte, gets one `unsynced` line each, and
loses their baseline copies and stamp entries; the files are repo-owned from then on, so delete
them if unused. The seven `no-mistakes` entries the settings template used to ship in
`permissions.allow` are kept in the repo's file the same way (update says so once). Update
never creates an init-only file that has no baseline (`.claude/factory-loop.json`,
`.github/workflows/ci.yml` in an older repo): it prints a `new` line naming it, and
`docs/onboarding.md` says how to add it. An init-only file that has a baseline
(`treehouse.toml`) is still restored if deleted.

## `CLAUDE.md` -> `CLAUDE.md`

Global agent instructions.

- Synced: the `# global agent instructions` bullet list (em dash ban, no co-author, no
  manual CHANGELOG edits, research-issue-stays-open policy, PR-issue linkage rules with
  closing/non-closing keywords and the `closingIssuesReferences` verification step,
  quality-over-dev-cost, E2E-first bug fixing, pixel-perfection UI standard, screenshot
  evidence requirement, brief PR descriptions, engineering-excellence/lint/flakiness
  standard), the `## Dev container is ephemeral` section and `## Two ways work gets done`,
  which says what a factory loop agent does and leaves to the loop, and what the manual path
  (a worktree plus the gate commands) is for. It is the same for every
  repo, so it is synced and holds for loop agents whatever the repo-owned block says.
- Repo-owned: `## Canonical commands` and `## Implementation sub-agents (manual path)` - both ship as
  placeholder headings only. Fill in this repo's actual lint/test/typecheck commands (and
  which one CI calls, so they can't drift), and this repo's worktree/isolation mechanism for the
  manual path. A loop agent works in the loop's slot instead.
- One placeholder inside the synced screenshot-evidence bullet: the path to this repo's
  e2e visual verification doc. Fill that in even though the surrounding bullet is synced.

## `.claude/settings.json` -> `.claude/settings.json`

Wires up the `callum` plugin marketplace and enables `callum-flow`, and ships the
generic `permissions.allow` and `permissions.deny` lists the implement-issue/orchestrator flow needs
(`treehouse get/return/status`, `gh issue comment/edit/close/create`, `gh pr view/pr checks/pr list`,
`callum-flow-issue-read` (the one filtered reader of issue, comment and PR text),
`callum-flow-merge-guard` (see its [mode reference](../images/base/README.md#factory-event-log)), `callum-flow-rollout`, the read-only
Rollout lookup the guard derives its linkage expectation from, and the read-only
`check-pr-linkage.sh`) - see
dev-system#44. This list exists here, not as plugin-shipped permissions, because a
Claude Code plugin's own `settings.json` only applies its `agent` and
`subagentStatusLine` keys; every other key, including `permissions`, is dropped at
load ([plugin manifest reference](https://code.claude.com/docs/en/plugins-reference):
"Settings Claude Code applies while the plugin is enabled. Only `agent` and
`subagentStatusLine` take effect; other keys are dropped at load."). Shipping the
allow list from this synced template is the only mechanism that reaches every
consumer repo.

The template also owns `attribution.commit` (`""`), which turns off the harness's default
Co-Authored-By commit trailer for every session and sub-agent in the repo (dev-system#571).
`callum-dev update` adds it to consumers lacking it and resets a consumer-set commit
attribution to `""`. Repo-added attribution keys such as `attribution.pr` survive under
the key-path rules below. PR attribution and the session trailer are unchanged.

JSON has no comment syntax, so the split is documented here instead of inline:

The split is by key path, compared against the pristine baseline in
`.callum-dev/baseline/.claude/settings.json` (plain objects key by key; arrays and other
values are compared whole):

- **Synced, do not hand-edit**: every key the template defines, at any depth
  (`extraKnownMarketplaces.callum.source`, `enabledPlugins.callum-flow@callum`, the
  synced entries of `permissions.allow`, and anything a future template adds).
  `callum-dev update` sets each one to the new template's value, so a hand edit to a
  synced key is reset, and a key the template drops is dropped from your file too.
- **Repo-owned**: any key the repo adds that the template does not have, at any depth -
  a new top-level key, or one nested inside a synced object, such as
  `"autoUpdate": false` under `extraKnownMarketplaces.callum` (dev-system#57).
  `callum-dev update` keeps keys present in your file but absent from the old baseline
  unless the new template defines them, even if the template later drops their parent
  object. Newly defined template keys win over repo-added values.
- **Repo-owned**: entries you append to `permissions.allow` beyond the synced list
  above - e.g. this repo's own `Bash(scripts/evidence-upload.sh *)` or
  `Bash(scripts/worktree-bootstrap.sh *)` (see mealplanning#442 for the pattern).
  `callum-dev update` unions the array: the fresh synced list plus whatever entries
  you added beyond the old baseline, deduplicated. Add your own by editing this
  committed file directly - it is the only settings file a treehouse worktree
  sub-agent ever sees.
- **Synced**: `permissions.deny`, which denies `gh issue view`, `gh issue list` and
  `gh issue status` (bare and `*` forms) so a raw issue read is refused even without the
  plugin. It merges by value exactly like `allow`: the fresh synced list, plus entries
  your repo added beyond the old baseline, minus entries the template dropped. A deny
  list your repo already had survives the update that first introduces the template's.
- With no baseline (deleted, or never committed), every key the template does not
  define counts as repo-owned and is kept, and every current `permissions.allow` entry
  is unioned in.
- **Never here**: powers that must stay orchestrator-only in the main checkout -
  `gh pr merge`, `callum-flow-merge` (the guarded merge; only
  `callum-flow-merge-guard` is synced), `callum-flow-fix-linkage` (the linkage repair; only
  the read-only `check-pr-linkage.sh` is synced), `gh pr edit`, and any pipeline/queue
  watcher script. Keep those as `allow` entries in the gitignored, uncommitted
  `.claude/settings.local.json` in the main checkout instead. Do not add a `deny`
  rule for these orchestrator-only powers: committed settings apply in the main
  checkout too, so a `deny` would also block the orchestrator, not just worktree
  sub-agents. Raw reads of issue and PR text are the deliberate exception: they are
  denied everywhere, orchestrator and owner included, because that text may come from
  an untrusted author and `callum-flow-issue-read` is the one door (dev-system#307; the
  `forbid-raw-gh-read` plugin hook is the second layer and also covers `gh api`, curl
  and WebFetch). The split that
  keeps a worktree sub-agent from merging is that `settings.local.json` never leaves
  the main checkout - worktrees start with none of it - not a rule that blocks the
  command everywhere.
- **Deliberately absent**: `gh api`. It can merge a PR through the REST API
  (`gh api -X PUT .../pulls/N/merge`), crossing the orchestrator-only merge boundary,
  and permission rules match by prefix, so no "read-only" `gh api` pattern can exclude
  a method flag appended later (dev-system#58). An orchestrator that needs it allows it
  in `.claude/settings.local.json` in the main checkout, like the powers above.

This allow list saves permission prompts; it is not a hard boundary. An agent running in
bypass-permissions mode is not stopped by it either way.

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
`remoteUser`, the `/persist` environment, `dev-init` at post-start and the volumes shared
by every repo on the host: gh, and `dev-system-secrets` (read-only at
`/run/secrets/dev-system`, from image 2.2.0), which carries the agentsview URL. That URL is
set once per Docker host, not per repo, so nothing in this template (synced or repo-owned)
wires it, and it must never be added to `remoteEnv` or `containerEnv` here
(cbundy/dev-system#103). The synced header comment says so; it ships with the next
`callum-dev` release.

- Repo-owned: `name`, `image` (`ghcr.io/cbundy/dev-system/base:2`, or swap for a `build`
  block with a Dockerfile `FROM` it for repo-specific tools), `remoteEnv`, and the nested
  repo-owned slot at the top of `mounts` (each added mount followed by a comma, so the
  synced lines below it stay untouched).
- Synced: `containerEnv` - `CALLUM_FLOW_TRUSTED_AUTHORS`, forwarded from the host
  (`${localEnv:CALLUM_FLOW_TRUSTED_AUTHORS}`), the GitHub authors whose text the factory
  trusts (cbundy/dev-system#307). Export it on the desktop host as `login:numeric_id`
  (comma-separated for several; `gh api users/<login> --jq .id` gives the id) before the
  container starts. The image bakes no list, so unset or malformed `dev-doctor` FAILs. On
  Coder the template sets it instead. It lands in a repo with its next `callum-dev update`.
- Synced: `mounts` - the five per-repo volumes (`dev-system-${devcontainerId}-claude`,
  `-codex`, `-no-mistakes`, `-agentsview`, `-events`) at `/persist/*`. They live here, not in the
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
- **Some of this system's files must stay tracked** and are commented as such in the
  template: `.claude/factory-loop.json`, `.no-mistakes.yaml` if the repo still has one (it
  sits right beside the ignored `.no-mistakes/` state directory - hence the trailing slash
  on that rule), and `.callum-dev.json` plus `.callum-dev/baseline/`, which are what make `callum-dev update`
  a 3-way merge rather than an overwrite. Ignoring any of them looks tidy and breaks
  things quietly.

## Validating your copy

- JSON files (`.claude/settings.json`, `.claude/factory-loop.json`) must parse with a strict JSON parser.
- `.devcontainer/devcontainer.json` is JSONC - strip `//` comments before parsing if you
  need to validate it programmatically.
- `.claude/factory-loop.json` must parse as JSON, with a `gateCommands` array.
- No `<REPLACE>` placeholders should remain once a repo is wired up.
- `.gitignore`: check behaviour with `git check-ignore -v <path>`, not by eye. The rules
  that matter most are the directory-vs-file ones, and those are exactly the ones reading
  the patterns does not settle.
