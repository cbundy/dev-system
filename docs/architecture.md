# Architecture

How dev-system is put together, how a change gets from this repo into a consumer repo, and
where each part lives when something breaks.

## Layers

dev-system has three layers. Each one is distributed and pinned on its own.

| Layer | Source here | Distributed as | Consumer pins | Consumer updates with |
|---|---|---|---|---|
| Agent behaviour: skills, named agents, hooks | `plugins/callum-flow/` | Claude Code plugin in the `callum` marketplace (`.claude-plugin/marketplace.json`) | Release-tag marketplace `ref` in `.claude/settings.json` | Refresh templates with `npm update @callum/dev-system && npx callum-dev update`, then run `dev-init` |
| Environment | `images/base/` | Image `ghcr.io/cbundy/dev-system/base` on GHCR | Image tag (`:2`) or digest | Rebuild or re-pull. Tags are mutable: they are rebuilt weekly. |
| Repo config | `templates/`, `bin/callum-dev.js` | npm git dependency `github:cbundy/dev-system#semver:0.x` | `.callum-dev.json` stamp | `npm update @callum/dev-system && npx callum-dev update` |

Two more surfaces build on the layers:

- `.devcontainer/`: dev-system's own dev environment, a per-repo image like any
  consumer's. `.devcontainer/Dockerfile` adds terraform to the base image;
  `publish-dev-image.yml` publishes it as `ghcr.io/cbundy/dev-system/dev` (`latest` and
  `sha-<short>`) on every change on main and weekly, after the base image's rebuild. No
  consumer pulls it.
- `coder/dev-system/`: a Coder template that runs the base image. You push it to a Coder
  server; consumer repos never pull it.
- `features/src/callum-tools/`: the deprecated Dev Container Feature (see
  [Deprecated](#deprecated-callum-tools-feature)). Its scripts are still part of the image
  build.

## Repo layout

```
.claude-plugin/marketplace.json   plugin marketplace catalog ("callum")
plugins/callum-flow/              skills (issue-orchestrator, implement-issue, update-dev, onboard), agents (explorer, implementer, fixer), hooks
images/base/                      base image: Dockerfile, dev-* scripts, tests, VERSION
coder/dev-system/                 Coder template (Terraform) on the base image
.devcontainer/                    this repo's dev container and dev image (base + terraform)
templates/                        repo config templates synced by callum-dev
bin/callum-dev.js                 CLI: init, update, check. Node built-ins and git only.
features/src/callum-tools/        deprecated feature; its scripts feed images/base
tests/                            CLI and hook tests (ci.yml)
scripts/lint.sh                   lint entrypoint (npm run lint)
scripts/test.sh                   test entrypoint (npm test); discovers tests by glob, quiet on success
scripts/test-reporter.js          node:test reporter: failing test, file:line and assertion only
scripts/build-skills.js           generates doc-backed skills, e.g. onboard (npm run build:skills)
scripts/release-bump.js           sets the release version everywhere and refreshes the stamp
.github/workflows/                ci.yml (lint and test on every PR and push to main; the
                                  required check), release.yml, publish-base-image.yml,
                                  publish-dev-image.yml, publish-features.yml, test-features.yml
package.json                      makes the repo npm-installable (bin + templates only)
docs/                             these docs
```

## Versioning and release

Ordinary PRs never bump the main release version. Releasing is a separate, deliberate step: a bump PR made
with `scripts/release-bump.js`, then the `Release` workflow, which tags without pushing to
main. See [`RELEASING.md`](../RELEASING.md) for the commands.

| What | Version lives in | Released by | Reaches consumers when |
|---|---|---|---|
| Plugin, skills, CLI, templates | `package.json`, `plugin.json`, each `SKILL.md` (all set by `scripts/release-bump.js` in the bump PR) | `Release` workflow: tag `vX.Y.Z`, GitHub Release | CLI and templates: npm resolves `semver:0.x` against git tags. Plugin: the refreshed template advances the marketplace `ref`; `dev-init` migrates the installation. |
| Base image | `images/base/VERSION` | `Publish base image` workflow, plus a weekly rebuild of the current version | The next pull of the tag. Pin by digest if you need the exact image. |
| Dev image (this repo only) | none: follows main | `Publish dev image` workflow, on every change to `.devcontainer/` on main, plus a weekly rebuild | Not a consumer layer. Workspaces for this repo pull `latest`. |
| Feature (deprecated) | `features/src/callum-tools/devcontainer-feature.json` | `Publish features` workflow | The next rebuild of a container pinned to `callum-tools:1` |

Semver for each: patch for wording fixes, minor for a new skill, template or capability,
major for a breaking change to an existing contract.

A plugin at an unchanged marketplace `ref` stays on that release. Changes merged to main
reach no consumer until a release is published and the consumer advances its pin.

Pinning rule: the plugin is installed from a release tag, never from main - the templates'
`.claude/settings.json` pins the `callum` marketplace `ref` (set by `release-bump.js`), and
the base image's default plugin is pinned to the release current at its build.

## How a change reaches a consumer repo

```
change in this repo ──PR──▶ main ──release──▶ tag / image / plugin version
                                                    │
         consumer repo ◀── npm update + callum-dev update   (templates, CLI)
                       ◀── refreshed marketplace ref + dev-init (skills, hooks)
                       ◀── image re-pull / rebuild            (environment)
```

Commit the updated `.claude/settings.json` from `callum-dev update`, then restart the
container or run `dev-init --plugins` in it. `dev-init` removes the old marketplace
(which uninstalls its plugins), adds it at the new ref, and installs the wanted plugins.
`marketplace update`, auto-update, and `plugin install` or `plugin update` keep the old
ref; they do not advance a release pin. Adding the new ref while the old marketplace
is declared in user settings is refused because its source does not match that entry.

The flow also runs in reverse. `/update-dev <request>` in any consumer repo opens a PR here
with the motivating context. Shared behaviour is never patched in the consumer repo.

## What a consumer repo commits

`npx callum-dev init` writes all of these. See [`onboarding.md`](onboarding.md) for the
steps.

| File | Strategy on `update` | Contents |
|---|---|---|
| `.no-mistakes.yaml` | 3-way merge | Pipeline config; see [template ownership rules](../templates/README.md). |
| `.github/pull_request_template.md` | 3-way merge | Synced: the four-heading PR body skeleton that `pr.template` in `.no-mistakes.yaml` enforces. |
| `CLAUDE.md` | 3-way merge | Synced: global agent rules, ephemeral-container rules. Repo owns: canonical commands, sub-agent isolation. |
| `.claude/settings.json` | key-path merge: template keys synced, repo-added keys kept, `permissions.allow` unioned | Synced: marketplace, `callum-flow@callum` enabled, the flow's allow list. Repo owns: any key the template does not have, extra allow entries. |
| `.devcontainer/devcontainer.json` | 3-way merge | Repo owns: name, image or build, env, extra mounts. Synced: the four per-repo `/persist` volumes. |
| `.gitignore` | 3-way merge | Synced block on top, repo-owned block at the bottom (last match wins) |
| `treehouse.toml` | init only | Fully repo-owned |
| `.callum-dev.json` | rewritten | Stamp: applied template version, devcontainer kind |
| `.callum-dev/baseline/` | rewritten | Pristine copy of each template: the base of the 3-way merge |
| `package.json` devDependency | - | `@callum/dev-system` from `github:cbundy/dev-system#semver:0.x` |

dev-system is itself a consumer: it commits these files too, minus the devDependency. It
runs its own checkout's CLI (`node bin/callum-dev.js`), and each release's bump PR brings
its stamp up to date (`RELEASING.md`).

Never committed: `.claude/settings.local.json`. It holds powers that only the orchestrator
in the main checkout gets (`gh pr merge`, `gh pr edit`, `no-mistakes axi respond`,
watchers). Treehouse worktrees start without it, so a worktree sub-agent cannot merge.

The per-file split between synced and repo-owned content, including files without ownership
markers, is documented in [`templates/README.md`](../templates/README.md).
`update` uses `git merge-file`, leaves
real conflicts as markers and exits non-zero. A missing or edited baseline breaks the merge,
so the baseline is committed.

## Runtime map

Where to look inside a running container. Full detail is in
[`images/base/README.md`](../images/base/README.md).

**Start-up order**

| Runtime | Who runs `dev-init` | Who starts Claude |
|---|---|---|
| `docker run`, Kubernetes | `dev-entrypoint` (image `ENTRYPOINT`, under `tini`) | `dev-remote-control` (default `CMD`) |
| Coder | agent `startup_script` (Coder replaces the entrypoint) | `dev-remote-control --post-start`, started in the background |
| Desktop dev container | `postStartCommand` from image metadata | nobody by default (`DEV_REMOTE_CONTROL=0`) |

**Paths**

| Path | What |
|---|---|
| `/persist/{claude,codex,gh,no-mistakes,agentsview}` | Tool state and logins. Mount layout depends on the runtime; see the [image persistence contract](../images/base/README.md#how-runtimes-should-mount-it). |
| `/workspaces/<repo>` | The checkout (`DEV_WORKSPACE`). Cloned from `DEV_REPO_URL` on the first start. |
| `/run/secrets/dev-system/` | Secrets mounted read-only by the runtime, e.g. `agentsview-pg-url` |
| `/shared` | Optional NAS share for files exchanged with the PC. Not for checkouts or state. |
| `/usr/local/bin/dev-*` | `dev-entrypoint`, `dev-init`, `dev-doctor`, `dev-login`, `dev-remote-control` |
| `/usr/local/share/callum-tools/` | Watcher and usage-check scripts used by the orchestrator skill |

**Logs and sessions**

| Where | What |
|---|---|
| container log (`docker logs`, `kubectl logs`) | `dev-init` report, supervisor, login links (headless) |
| `/tmp/dev-remote-control.log` | Supervisor log on Coder |
| `/tmp/coder-startup-script.log` | Coder startup script |
| `/tmp/dev-login-page.log` | Login page |
| `/tmp/dev-agentsview-push.log`, `/persist/agentsview/pg-watch.log` | agentsview push |
| tmux `claude` | The Claude session: `tmux attach -t claude`, as `node` |
| tmux `login-claude`, `login-codex`, `login-gh` | Logins in progress |

**First commands when debugging:** `dev-doctor`, then `dev-login status`, then the logs
above. `dev-init` is safe to re-run. For its `--repo` and `--plugins` modes, see
[Workspace and repo](../images/base/README.md#workspace-and-repo).

## Design rules

- Shared skills are generic and stateless. Repo-specific state lives at repo-local paths in
  the consumer (e.g. `.claude/orchestrator-memory.md`), never in the skill.
- Template customization follows the [per-file ownership rules](../templates/README.md).
  Differences between repos live in data the skills read, never in forked skill text.
- Shared behaviour changes here, gets released, and is pulled by consumers.
- The image holds no secrets and no checkout. Secrets come from the runtime at
  `/run/secrets/dev-system`. The checkout lives on a volume.
- Each layer is pinned on its own: plugin marketplace release-tag `ref`, image tag, npm semver range.

## Deprecated: callum-tools feature

Deprecated by cbundy/dev-system#89 in favour of the base image. The feature
(`ghcr.io/cbundy/dev-system/callum-tools`) and the `feature` devcontainer template get no
new capabilities. Repos pinned to `callum-tools:1` keep working. Move them with
`npx callum-dev update --devcontainer base-image`. The scripts in
`features/src/callum-tools/` (setup, codex model pin, no-mistakes recovery, watchers) are
still maintained, because the image builds from them. `test-features.yml` still tests them.

## GHCR visibility

The image and feature packages are public, the `dev` image included. They contain only
public tools and install scripts. A private package would need a `packages:read` token on every machine and CI job
that pulls it. Packages take this repo's visibility on first publish. If the repo is ever
made private, set each package's visibility by hand.
