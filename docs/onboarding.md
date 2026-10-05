# Onboarding: make this a dev-system repo

Instructions for an agent. Run them in the target folder, whether it is empty or an
existing repo. Run every step; each one says how to check it worked. Background for any step
is in [`architecture.md`](architecture.md) and [`../templates/README.md`](../templates/README.md).

With the `callum-flow` plugin installed, `/callum-flow:onboard` gives an agent these same
instructions as a skill (generated from this page, never edited by hand).

## Done when

- `.no-mistakes.yaml`, `CLAUDE.md`, `.claude/settings.json`,
  `.devcontainer/devcontainer.json`, `.gitignore`, `treehouse.toml`, `.callum-dev.json`
  and `.callum-dev/baseline/` are committed.
- `package.json` has `@callum/dev-system` as a devDependency, from
  `github:cbundy/dev-system#semver:0.x`.
- `grep -rn '<REPLACE' --exclude-dir=node_modules --exclude-dir=.callum-dev .` prints
  nothing.
- `npx callum-dev check` exits 0.
- The checks in [Verify](#5-verify) pass.

## Rules

- Do not edit, copy or vendor anything from `node_modules/@callum/dev-system` into the
  repo by hand, apart from the synced blocks in step 3b. Shared behaviour changes upstream
  through `/update-dev`.
- Do not edit inside `--- synced ---` blocks. Fill in only `--- repo-owned ---` blocks and
  `<REPLACE>` placeholders.
- Use the `base-image` devcontainer. Never use `feature`: it is deprecated
  (cbundy/dev-system#89).
- Never put secrets in the repo, including the agentsview URL. Secrets come from the
  runtime.
- Do not delete or gitignore `.callum-dev.json` or `.callum-dev/baseline/`. Without them,
  `update` cannot merge.
- Ask the user before any outward-facing step: creating a GitHub repo, pushing, or creating
  a Coder workspace.

## 0. Ask the user first

Get these before running anything. Do not guess them.

| Question | Used in |
|---|---|
| Repo name | devcontainer `name`, the GitHub repo |
| Language and stack, or "decide later" for an empty folder | lint and test commands, `.gitignore` repo-owned block, per-repo Dockerfile |
| Lint command and full test command, if they exist yet | step 3 (commands) |
| GitHub owner and visibility; create the repo now? | step 4 |
| Extra system tools the repo needs (Python, Terraform, a DB client, ...)? | step 3e |
| Run it on Coder? With which per-repo image, if any? | step 6 |

## 1. Prerequisites

Required: `git`, `node` 18 or later with `npm`, and network access to github.com. `gh`,
logged in, is needed only for step 4.

```bash
git --version && node --version && npm --version
```

Inside a dev-system container all of these are already there.

## 2. Initialise git and npm

Empty folder:

```bash
git init -b main
npm init -y
npm pkg set private=true
```

An existing repo keeps its own git history. If it has no `package.json`, create one as
above, even for a project that does not use Node: the file only carries the dev-system
dependency.

Then:

```bash
npm i -D github:cbundy/dev-system#semver:0.x
```

Check: `npx callum-dev --version` prints a version.

## 3. Scaffold the config

### Settle the commands first

Every agent, every sub-agent and the no-mistakes pipeline run these commands, often many
times per change. Get them right before writing any file. Start from the commands the repo
really uses (`package.json` scripts, `Makefile`, `pyproject.toml`, CI workflows, the README)
and run each to confirm it works.

**Why it matters.** Everything a gate prints lands in an agent's context, on every run. A
suite that prints a line per passing test costs thousands of lines a run, multiplied by
every sub-agent, every pipeline retry and every agent that reads the pipeline log. An
ambiguous or multi-step gate makes agents improvise their own commands, run gates piecemeal
and skip some. A gate that passes with warnings scrolling past teaches agents to ignore
output, and then they miss the real failure.

**The contract.** Each gate (lint, typecheck, test, e2e if there is one) gets exactly one
command that:

- runs from the repo root, non-interactively, and gives the same result every time. Its
  exit code is the verdict: 0 passes, anything else fails.
- covers the whole gate. If a gate is spread across several commands or directories, add
  a single entrypoint (an npm script, a make target or a `scripts/` file) that runs them
  all, so a new test file needs no extra wiring.
- is quiet on success: one summary line at most. No per-test pass lines, progress bars,
  banners or coverage tables, and no log lines that tests trigger on purpose.
- on failure prints only what is needed to act: the failing test names or `file:line`, and
  the assertion or error.
- has that behaviour built in, in the command itself or the tool's config file (reporter,
  `addopts`, ...), never in a flag an agent has to remember, so the agent, the pipeline and
  CI all see the same output.
- treats warnings as failures, or turns the rule off. A warning that passes is noise.
- works in a fresh worktree with no dependencies installed, which is what no-mistakes
  runs. Either the command installs what it needs, or `.no-mistakes.yaml` puts the install
  step in front, e.g. `npm ci && npm run test`.

A combined `check` command that runs the fast gates in order and stops at the first
failure (auto-fixers such as a formatter first) is worth adding: an agent then verifies a
change in one call before handoff. If e2e is slow, decide which gate runs it (the pipeline
or CI) and when an agent should run it locally.

Write exactly these commands into `CLAUDE.md` "Canonical commands" and `.no-mistakes.yaml`
`commands`, with nothing added in the YAML except the install step. The sub-agent brief and
the pipeline then cannot drift. If a gate has no command yet, say so to the user rather
than inventing one.

Examples only; adapt them to the repo and check the options against the installed version:

| Tool | Quiet on success, failures only |
|---|---|
| Node `node:test` | `node --test --test-reporter=dot` |
| Vitest | `reporters: ['dot']` and `silent: true` in the config |
| Bun | `onlyFailures = true` under `[test]` in `bunfig.toml` |
| Playwright | `reporter: 'dot'` in the config (keep `html` as a second reporter for digging in) |
| pytest | `addopts = "-q --tb=short"` in `pyproject.toml` |
| Go | `go test ./...` without `-v`: one `ok` line per package, failures in full |
| ESLint | `eslint . --max-warnings=0`: nothing when clean, warnings fail |
| ShellCheck | `shellcheck -f gcc <files>`: one `file:line:col` line per finding, nothing when clean |

**Check it.** Run each command twice and report both results to the user:

1. On the clean tree: exit 0, and at most a few lines of output.
2. With a deliberately failing test (for the test gate) or lint error (for the lint gate):
   non-zero exit, and a few lines that name the file, the test and the error. Then revert
   the breakage.

If either output is long, fix the tool's config before going on.

### 3a. Run init

`init` reads three answers from stdin, one per line: repo name, lint command, test
command. A blank line leaves a `<REPLACE>` placeholder in place.

```bash
printf '%s\n' "<repo name>" "<lint command>" "<test command>" \
  | npx callum-dev init --devcontainer base-image
```

It prints `created` or `skipped` for each file, and lists the files that still have
placeholders. If `.callum-dev.json` already exists, init refuses to run. The repo is already
onboarded: run `npx callum-dev update` instead and stop here.

### 3b. Merge files that init skipped (existing repos only)

init never overwrites an existing file. For each file reported as `skipped`, typically
`CLAUDE.md` and `.gitignore`:

1. Open the template, `node_modules/@callum/dev-system/templates/<file>`. For `.gitignore`
   the template is `templates/gitignore`, with no dot.
2. Copy its `--- synced ---` block into the repo's file verbatim, markers included, so a
   later `update` can find and merge it.
3. Wrap the repo's existing content in a `--- repo-owned ---` block, in the positions the
   template uses. In `.gitignore` the repo-owned block goes at the **bottom**.
4. For `.claude/settings.json`, keep the template's keys exactly, add the repo's own
   entries to the end of `permissions.allow`, and keep any keys of the repo's own that the
   template does not have.

### 3c. Fill every placeholder

```bash
grep -rn '<REPLACE' --exclude-dir=node_modules --exclude-dir=.callum-dev .
```

| File | Placeholder | Fill with |
|---|---|---|
| `.no-mistakes.yaml` | `commands.lint`, `commands.test` | The commands from "Settle the commands first", working in a **fresh worktree with no dependencies installed**: include the install step, e.g. `npm ci && npm run lint`. With no tests yet, use a command that exits 0 and say so to the user. |
| `.no-mistakes.yaml` | the commented ignore-glob example | Delete the line, or replace it with real globs |
| `.no-mistakes.yaml` | `document.instructions` | Which paths own which docs. If there is no rule, delete the whole `document:` block. |
| `CLAUDE.md` | e2e visual verification doc path | The repo's UI screenshot doc. For a repo with no UI, replace it with `n/a - no UI`. |
| `CLAUDE.md` | `## Canonical commands` | The commands from "Settle the commands first", one per gate, the same as `.no-mistakes.yaml` minus the install step, and which CI job calls each |
| `CLAUDE.md` | worktree mechanism | `a treehouse worktree` unless the user says otherwise |
| `CLAUDE.md` | repo-specific variations | Extra build or boot steps before the app can run, or delete the line |
| `.devcontainer/devcontainer.json` | `remoteEnv` example | Delete the comment line, or add real env vars, e.g. `"DEV_LOGIN_TOOLS": "claude,gh"` for a repo that never uses codex |

Leave `treehouse.toml` as it is unless the user says otherwise.

### 3d. Repo-owned `.gitignore` entries

Add the stack's own build output, local databases and generated files to the bottom
repo-owned block. Check each rule with `git check-ignore -v <path>`.

### 3e. Per-repo image (only if the repo needs extra tools)

Create `.devcontainer/Dockerfile`:

```dockerfile
FROM ghcr.io/cbundy/dev-system/base:2
USER root
RUN apt-get update && apt-get install -y --no-install-recommends <packages> \
  && rm -rf /var/lib/apt/lists/*
USER node
```

In `.devcontainer/devcontainer.json`, replace `"image": ...` with
`"build": { "dockerfile": "Dockerfile" }`. Do not change `ENTRYPOINT`, add a `VOLUME`,
install anything under `/persist`, or set a `devcontainer.metadata` label. See
[Extending the image](../images/base/README.md#extending-the-image).

## 4. Commit (and GitHub, if the user said yes)

```bash
git add -A
git status --short   # must include .callum-dev.json and .callum-dev/; must not include node_modules/, .env, settings.local.json
git commit -m "chore: onboard to dev-system"
```

Only if the user agreed in step 0:

```bash
gh repo create <owner>/<name> --<private|public> --source . --push
```

## 5. Verify

Run all of these and report each result.

```bash
npx callum-dev check
node -e 'JSON.parse(require("fs").readFileSync(".claude/settings.json","utf8"))'
grep -rn '<REPLACE' --exclude-dir=node_modules --exclude-dir=.callum-dev . || echo "no placeholders"
git check-ignore -v .no-mistakes.yaml .callum-dev.json .callum-dev/baseline/CLAUDE.md && echo "BAD: tracked file ignored" || echo ok
```

Once committed, run the `.no-mistakes.yaml` lint and test commands in a fresh worktree, the
way the pipeline does, then remove it:

```bash
git worktree add --detach ../gatecheck-tmp
(cd ../gatecheck-tmp && <commands.lint> && <commands.test>)
git worktree remove --force ../gatecheck-tmp
```

If the agent is running inside a dev-system container, also run `dev-init --repo` and
then `dev-doctor`. Login failures are expected until the user logs in. Report any other
`FAIL`.

## 6. Run it on Coder (if the user said yes)

Needs the `coder` CLI logged in, the repo pushed (step 4), and the `dev-system` template
on the Coder server. The template, its parameters and first-run logins are documented in
the [Coder template README](../coder/dev-system/README.md).

```bash
coder create <name> --template dev-system --parameter repo_url=<https clone url>
```

- Remote Control mode `auto` (the default) becomes `server` when there is a repo: each
  session started in claude.ai gets its own worktree.
- A private repo needs a GitHub credential before the clone works: Coder external auth, or
  the gh login on the Log in page.
- A repo with a per-repo image (step 3e) must have that image built and pushed to a
  registry, then passed with `--parameter image=<image>`. A private image needs registry
  credentials on the template (README, "Private images").

Then the user opens the workspace in the Coder dashboard, clicks **Log in** and signs in
to Claude (and codex and gh). Within 30s the workspace shows up in claude.ai. Check with
`coder ssh <name> -- dev-login status`, and `coder ssh <name> -- dev-doctor` once logged in.

## 7. Tell the user

Report:

- what was created and what was merged,
- the commands you chose, their clean and deliberately broken output, and any command you
  could not determine,
- what the user still has to do, with the commands:

| Next step | How |
|---|---|
| Open it on the desktop | Reopen in Container (VS Code) or `devcontainer up --workspace-folder .`. Then log in once: `dev-login start`. |
| Run it in Coder | Step 6, if not done: `coder create <name> --template dev-system --parameter repo_url=<https clone url>`, then **Log in** in the dashboard. |
| Enable the workflow plugin | Trust the folder in Claude Code. `.claude/settings.json` enables `callum-flow@callum`. |
| Session history (agentsview) | Nothing per repo. The URL is set once per host (`images/base/README.md`, "Central session history"). |
| Keep in sync later | `npm update @callum/dev-system && npx callum-dev update`, then commit. Optionally run `npx callum-dev check` in CI. |
