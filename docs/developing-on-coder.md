# Developing dev-system on Coder

A Coder workspace built from [`coder/dev-system`](../coder/dev-system/README.md) can develop
this repo end to end, with no step on the PC. This was proven in [cbundy/dev-system#119](https://github.com/cbundy/dev-system/issues/119): the
workspace `dev-system-orchestrator` ran the (since retired) skills-based issue orchestrator and took `ready` issues to
merged PRs, with the no-mistakes pipeline and GitHub CI green (the merged PRs from
[#176](https://github.com/cbundy/dev-system/pull/176) to [#186](https://github.com/cbundy/dev-system/pull/186), and [#192](https://github.com/cbundy/dev-system/pull/192), which closed [#148](https://github.com/cbundy/dev-system/issues/148)).

This page is for working on dev-system itself. To run some other repo on Coder, see
[onboarding](onboarding.md), step 6.

## Create the workspace

Use the `orchestrator-loop` template for one long-lived session run by the factory loop, or `dev-system`
for one session per task:

```bash
coder create dev-system-loop --template orchestrator-loop \
  --parameter repo_url=https://github.com/cbundy/dev-system \
  --parameter remote_control_skip_permissions=true \
  --parameter cpus=4 \
  --parameter memory_gb=8
```

- Bypass permissions (`remote_control_skip_permissions`) lets Claude work unattended.
  Only turn it on for a workspace you are happy to let act on its own.
- Add `--parameter coder_login=true` for a workspace that drives other workspaces (e.g. the
  factory loop's shadow and testbed runs): it logs the `coder` CLI in from a host token
  that reaches every workspace its user can reach.
- Add `--parameter template_testing=true` only if agents there will try Coder template
  changes (see below).

All parameters are in the [Coder template README](../coder/dev-system/README.md#parameters).

## Log in

Follow the [template's first-run login instructions](../coder/dev-system/README.md#first-run-logins),
including its gh sharing option and the `workflow` scope requirement for pushing changes
to `.github/workflows/`.

The workspace image includes the `coder` CLI, pinned to the server version. To use it from
the workspace, see [Coder CLI](../images/base/README.md#coder-cli) for the recommended auth, or the opt-in `coder_login` parameter for a login on every start.

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

The dev image includes a PostgreSQL 17 server (no system cluster, not started), so the
metrics SQL in `docs/metrics.md` (checked by `npm test` against a throwaway factory database, in
`tests/metrics-queries.test.js`) and `fabriek-factory-state` can be checked against a
local throwaway server without Docker. Section 9 in image CI is still the gate for the latter.

```sh
d=$(mktemp -d); pg=/usr/lib/postgresql/17/bin
$pg/initdb -D "$d/data" -A trust && $pg/pg_ctl -D "$d/data" -o "-k $d -c listen_addresses=" -w -l "$d/log" start
createdb -h "$d" t && psql -h "$d" -d t -c 'select 1'; $pg/pg_ctl -D "$d/data" -w stop
```

Coder template changes are tried with `coder/dev-system/push-next.sh`, which pushes only
`dev-system-next`. Enable `template_testing` after the owner's token setup (see
[Testing template changes from a workspace](../coder/dev-system/README.md#testing-template-changes-from-a-workspace)).
Pushed versions are named `<git describe>-<UTC timestamp>`, so the Coder UI maps each back to a commit.
Promoting a change to the production templates is the owner's step.

## Known friction

Friction issues recorded while proving this:

- [#187](https://github.com/cbundy/dev-system/issues/187): codex telemetry gaps for hand-started codex.
- [#188](https://github.com/cbundy/dev-system/issues/188): the Terraform limitation described above.
- [#189](https://github.com/cbundy/dev-system/issues/189): strict up-to-date branch protection makes each later merge need a branch update and a CI re-run.
- [#190](https://github.com/cbundy/dev-system/issues/190): a failed no-mistakes run blocks reuse of the branch name, and the private mirror refuses rebased histories.
- [#191](https://github.com/cbundy/dev-system/issues/191): during the proof, the template-testing token existed only by hand in the orchestrator's `/persist`. For the supported token setup, see [Testing template changes from a workspace](../coder/dev-system/README.md#testing-template-changes-from-a-workspace).
