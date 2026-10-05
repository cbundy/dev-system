# Onboarding: make this a dev-system repo

Instructions for an agent. Run them in the target folder, whether it is empty or an
existing repo. Run every step; each one says how to check it worked. Background for any step
is in [`architecture.md`](architecture.md) and [`../templates/README.md`](../templates/README.md).

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
- Ask the user before any outward-facing step: creating a GitHub repo, or pushing.

## 0. Ask the user first

Get these before running anything. Do not guess them.

| Question | Used in |
|---|---|
| Repo name | devcontainer `name`, the GitHub repo |
| Language and stack, or "decide later" for an empty folder | lint and test commands, `.gitignore` repo-owned block, per-repo Dockerfile |
| Lint command and full test command, if they exist yet | `.no-mistakes.yaml`, `CLAUDE.md` |
| GitHub owner and visibility; create the repo now? | step 4 |
| Extra system tools the repo needs (Python, Terraform, a DB client, ...)? | step 3e |

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
4. For `.claude/settings.json`, keep the template's keys exactly, and add the repo's own
   entries to the end of `permissions.allow`.

### 3c. Fill every placeholder

```bash
grep -rn '<REPLACE' --exclude-dir=node_modules --exclude-dir=.callum-dev .
```

| File | Placeholder | Fill with |
|---|---|---|
| `.no-mistakes.yaml` | `commands.lint`, `commands.test` | Commands that work in a **fresh worktree with no dependencies installed**: include the install step, e.g. `npm ci && npm run lint`. With no tests yet, use a command that exits 0 and say so to the user. |
| `.no-mistakes.yaml` | the commented ignore-glob example | Delete the line, or replace it with real globs |
| `.no-mistakes.yaml` | `document.instructions` | Which paths own which docs. If there is no rule, delete the whole `document:` block. |
| `CLAUDE.md` | e2e visual verification doc path | The repo's UI screenshot doc. For a repo with no UI, replace it with `n/a - no UI`. |
| `CLAUDE.md` | `## Canonical commands` | One command per gate (lint, typecheck, test) and which CI job calls each |
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

If the agent is running inside a dev-system container, also run `dev-init --repo` and
then `dev-doctor`. Login failures are expected until the user logs in. Report any other
`FAIL`.

## 6. Tell the user

Report:

- what was created and what was merged,
- the commands you chose and any you could not determine,
- what the user still has to do, with the commands:

| Next step | How |
|---|---|
| Open it on the desktop | Reopen in Container (VS Code) or `devcontainer up --workspace-folder .`. Then log in once: `dev-login start`. |
| Run it in Coder | `coder create <name> --template dev-system --parameter repo_url=<https clone url>` |
| Enable the workflow plugin | Trust the folder in Claude Code. `.claude/settings.json` enables `callum-flow@callum`. |
| Session history (agentsview) | Nothing per repo. The URL is set once per host (`images/base/README.md`, "Central session history"). |
| Keep in sync later | `npm update @callum/dev-system && npx callum-dev update`, then commit. Optionally run `npx callum-dev check` in CI. |
