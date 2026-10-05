# Architecture

How dev-system is put together, how a change gets from this repo into a consumer repo, and
where each part lives when something breaks.

## Layers

dev-system has three layers. Each one is distributed and pinned on its own.

| Layer | Source here | Distributed as | Consumer pins | Consumer updates with |
|---|---|---|---|---|
| Agent behaviour: skills, hooks | `plugins/callum-flow/` | Claude Code plugin in the `callum` marketplace (`.claude-plugin/marketplace.json`) | `version` in `plugin.json` | `/plugin marketplace update`, or auto-update |
| Environment | `images/base/` | Image `ghcr.io/cbundy/dev-system/base` on GHCR | Image tag (`:2`) or digest | Rebuild or re-pull. Tags are mutable: they are rebuilt weekly. |
| Repo config | `templates/`, `bin/callum-dev.js` | npm git dependency `github:cbundy/dev-system#semver:0.x` | `.callum-dev.json` stamp | `npm update @callum/dev-system && npx callum-dev update` |

Two more surfaces build on the layers:

- `coder/dev-system/`: a Coder template that runs the base image. You push it to a Coder
  server; consumer repos never pull it.
- `features/src/callum-tools/`: the deprecated Dev Container Feature (see
  [Deprecated](#deprecated-callum-tools-feature)). Its scripts are still part of the image
  build.

## Repo layout

```
.claude-plugin/marketplace.json   plugin marketplace catalog ("callum")
plugins/callum-flow/              skills (issue-orchestrator, implement-issue, update-dev), hooks
images/base/                      base image: Dockerfile, dev-* scripts, tests, VERSION
coder/dev-system/                 Coder template (Terraform) on the base image
templates/                        repo config templates synced by callum-dev
bin/callum-dev.js                 CLI: init, update, check. Node built-ins and git only.
features/src/callum-tools/        deprecated feature; its scripts feed images/base
tests/                            CLI and hook tests (test-cli.yml)
scripts/lint.sh                   lint entrypoint (npm run lint)
.github/workflows/                release.yml, publish-base-image.yml, publish-features.yml, tests
package.json                      makes the repo npm-installable (bin + templates only)
docs/                             these docs
```

## Versioning and release

PRs never bump versions. Releasing is a separate, deliberate step. See
[`RELEASING.md`](../RELEASING.md) for the commands.

| What | Version lives in | Released by | Reaches consumers when |
|---|---|---|---|
| Plugin, skills, CLI, templates | `package.json`, `plugin.json`, each `SKILL.md` (all synced by the workflow) | `Release` workflow: tag `vX.Y.Z`, GitHub Release | Plugin: the marketplace update sees the new `version`. CLI and templates: npm resolves `semver:0.x` against git tags. |
| Base image | `images/base/VERSION` | `Publish base image` workflow, plus a weekly rebuild of the current version | The next pull of the tag. Pin by digest if you need the exact image. |
| Feature (deprecated) | `features/src/callum-tools/devcontainer-feature.json` | `Publish features` workflow | The next rebuild of a container pinned to `callum-tools:1` |

Semver for each: patch for wording fixes, minor for a new skill, template or capability,
major for a breaking change to an existing contract.

A plugin pinned to an unchanged `version` stays as it is. Changes merged to main reach no
consumer until a release bumps that version.

## How a change reaches a consumer repo

```
change in this repo ──PR──▶ main ──release──▶ tag / image / plugin version
                                                    │
         consumer repo ◀── npm update + callum-dev update   (templates, CLI)
                       ◀── /plugin marketplace update        (skills, hooks)
                       ◀── image re-pull / rebuild            (environment)
```

The flow also runs in reverse. `/update-dev <request>` in any consumer repo opens a PR here
with the motivating context. Shared behaviour is never patched in the consumer repo.

## What a consumer repo commits

`npx callum-dev init` writes all of these. See [`onboarding.md`](onboarding.md) for the
steps.

| File | Strategy on `update` | Contents |
|---|---|---|
| `.no-mistakes.yaml` | 3-way merge | Repo owns: lint and test commands, ignore globs, docs policy. Synced: auto-fix limits, agent. |
| `CLAUDE.md` | 3-way merge | Synced: global agent rules, ephemeral-container rules. Repo owns: canonical commands, sub-agent isolation. |
| `.claude/settings.json` | key-path merge: template keys synced, repo-added keys kept, `permissions.allow` unioned | Synced: marketplace, `callum-flow@callum` enabled, the flow's allow list. Repo owns: any key the template does not have, extra allow entries. |
| `.devcontainer/devcontainer.json` | 3-way merge | Repo owns: name, image or build, env, extra mounts. Synced: the four per-repo `/persist` volumes. |
| `.gitignore` | 3-way merge | Synced block on top, repo-owned block at the bottom (last match wins) |
| `treehouse.toml` | init only | Fully repo-owned |
| `.callum-dev.json` | rewritten | Stamp: applied template version, devcontainer kind |
| `.callum-dev/baseline/` | rewritten | Pristine copy of each template: the base of the 3-way merge |
| `package.json` devDependency | - | `@callum/dev-system` from `github:cbundy/dev-system#semver:0.x` |

dev-system is itself a consumer: it commits these files too, minus the devDependency. It
runs its own checkout's CLI (`node bin/callum-dev.js`), and its stamp is brought up to date
after each release (`RELEASING.md`).

Never committed: `.claude/settings.local.json`. It holds powers that only the orchestrator
in the main checkout gets (`gh pr merge`, `gh pr edit`, `no-mistakes axi respond`,
watchers). Treehouse worktrees start without it, so a worktree sub-agent cannot merge.

The split between synced and repo-owned content is marked inline:
`--- synced: do not edit ---` / `--- repo-owned: edit freely ---`, in each file's comment
syntax. JSON has no comments, so the split for `settings.json` is documented in
[`templates/README.md`](../templates/README.md). `update` uses `git merge-file`, leaves
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
| `/persist/{claude,codex,gh,no-mistakes,agentsview}` | Tool state and logins. One volume each, per repo, except gh, which is shared per host. |
| `/workspaces/<repo>` | The checkout (`DEV_WORKSPACE`). Cloned from `DEV_REPO_URL` on the first start. |
| `/run/secrets/dev-system/` | Secrets mounted read-only by the runtime, e.g. `agentsview-pg-url` |
| `/shared` | Optional NAS share for files exchanged with the PC. Not for checkouts or state. |
| `/usr/local/bin/dev-*` | `dev-entrypoint`, `dev-init`, `dev-doctor`, `dev-login`, `dev-remote-control` |
| `/usr/local/share/callum-tools/` | Watcher scripts used by the orchestrator skill |

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
above. `dev-init` is safe to re-run. `dev-init --repo` redoes only the clone, the fetch and
the no-mistakes registration.

## Design rules

- Shared skills are generic and stateless. Repo-specific state lives at repo-local paths in
  the consumer (e.g. `.claude/orchestrator-memory.md`), never in the skill.
- Every synced file splits into synced and repo-owned parts, so `update` merges cleanly.
  Differences between repos live in data the skills read, never in forked skill text.
- Shared behaviour changes here, gets released, and is pulled by consumers.
- The image holds no secrets and no checkout. Secrets come from the runtime at
  `/run/secrets/dev-system`. The checkout lives on a volume.
- Each layer is pinned on its own: plugin `version`, image tag, npm semver range.

## Deprecated: callum-tools feature

Deprecated by cbundy/dev-system#89 in favour of the base image. The feature
(`ghcr.io/cbundy/dev-system/callum-tools`) and the `feature` devcontainer template get no
new capabilities. Repos pinned to `callum-tools:1` keep working. Move them with
`npx callum-dev update --devcontainer base-image`. The scripts in
`features/src/callum-tools/` (setup, codex model pin, no-mistakes recovery, watchers) are
still maintained, because the image builds from them. `test-features.yml` still tests them.

## GHCR visibility

The image and feature packages are public. They contain only public tools and install
scripts. A private package would need a `packages:read` token on every machine and CI job
that pulls it. Packages take this repo's visibility on first publish. If the repo is ever
made private, set each package's visibility by hand.
