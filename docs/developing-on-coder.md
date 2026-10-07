# Developing dev-system on Coder

A Coder workspace built from [`coder/dev-system`](../coder/dev-system/README.md) can develop
this repo end to end, with no step on the PC. This was proven in [cbundy/dev-system#119](https://github.com/cbundy/dev-system/issues/119): the
workspace `dev-system-orchestrator` ran the issue orchestrator and took `ready` issues to
merged PRs, with the no-mistakes pipeline and GitHub CI green (the merged PRs from
[#176](https://github.com/cbundy/dev-system/pull/176) to [#186](https://github.com/cbundy/dev-system/pull/186), and [#192](https://github.com/cbundy/dev-system/pull/192), which closed [#148](https://github.com/cbundy/dev-system/issues/148)).

This page is for working on dev-system itself. To run some other repo on Coder, see
[onboarding](onboarding.md), step 6.

## Create the workspace

Use the `orchestrator` template for one long-lived orchestrator session, or `dev-system`
for one session per task:

```bash
coder create dev-system-orchestrator --template orchestrator \
  --parameter repo_url=https://github.com/cbundy/dev-system \
  --parameter remote_control_skip_permissions=true \
  --parameter cpus=4 \
  --parameter memory_gb=8
```

- Bypass permissions (`remote_control_skip_permissions`) lets Claude work unattended.
  Only turn it on for a workspace you are happy to let act on its own.
- Add `--parameter template_testing=true` only if agents there will try Coder template
  changes (see below).

All parameters are in the [Coder template README](../coder/dev-system/README.md#parameters).

## Log in

Open the workspace in the Coder dashboard and click **Log in**, or run `dev-login start` in the
workspace. Sign in to Claude, codex and gh. The gh login includes the `workflow` scope,
which pushes to `.github/workflows/` need ([#181](https://github.com/cbundy/dev-system/issues/181)). Logins live on the workspace's
`/persist` volume and survive restarts and image updates.

## What the workspace cannot verify

`npm run lint` and `npm test` run as normal, including the plain-shell feature tests.
Some checks cannot run there, and PR CI covers them. The image and feature workflows
run when a PR touches their paths; `ci.yml` runs on every PR. See each workflow's
`pull_request.paths` for its triggers.

| Not possible in the workspace | Why | Where it runs |
|---|---|---|
| Building the base image and running `images/base/test/test.sh` | No Docker | `publish-base-image.yml` on the PR |
| Building and smoke-testing the dev image | No Docker | `publish-dev-image.yml` on the PR |
| Feature tests in containers | No Docker | `test-features.yml` on the PR |
| Terraform checks on `coder/dev-system` | terraform is not on PATH in a base-image workspace, so `npm run lint` skips them ([#188](https://github.com/cbundy/dev-system/issues/188)) | `ci.yml` on the PR |

For changes in these areas, the evidence is the PR's CI run, never a local claim.

Coder template changes are tried with `coder/dev-system/push-next.sh`, which pushes only
`dev-system-next`. Enable `template_testing` after the owner's token setup (see
[Testing template changes from a workspace](../coder/dev-system/README.md#testing-template-changes-from-a-workspace)).
Promoting a change to the production templates is the owner's step.

## Known friction

Friction issues recorded while proving this:

- [#98](https://github.com/cbundy/dev-system/issues/98): `dev-login` and `dev-remote-control` hints say `docker exec`, which does not work on Coder.
- [#187](https://github.com/cbundy/dev-system/issues/187): codex telemetry gaps for hand-started codex.
- [#188](https://github.com/cbundy/dev-system/issues/188): the Terraform limitation described above.
- [#189](https://github.com/cbundy/dev-system/issues/189): strict up-to-date branch protection makes each later merge need a branch update and a CI re-run.
- [#190](https://github.com/cbundy/dev-system/issues/190): a failed no-mistakes run blocks reuse of the branch name, and the private mirror refuses rebased histories.
- [#191](https://github.com/cbundy/dev-system/issues/191): during the proof, the template-testing token existed only by hand in the orchestrator's `/persist`. For the supported token setup, see [Testing template changes from a workspace](../coder/dev-system/README.md#testing-template-changes-from-a-workspace).
