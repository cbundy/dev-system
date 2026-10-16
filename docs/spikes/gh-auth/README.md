# gh-auth spike (research only)

Results: [FINDINGS.md](FINDINGS.md). Issue: cbundy/dev-system#686, which stays open after this
spike merges.

The question: should each workspace be able to choose a shared or private GitHub CLI (gh) login,
the way it can now choose for Claude (the `claude_login` parameter, PR #682)? And can gh's login be
shared on its own, without sharing the rest of gh's config directory, and is that safe?

Today gh keeps everything in `GH_CONFIG_DIR=/persist/gh`. On Coder, the template variable
`gh_volume_name` (`dev-system-gh` in `coder/dev-system/terraform.tfvars`) mounts one shared volume
there in every workspace, with no per-workspace choice. On the desktop the image's devcontainer
metadata mounts the shared `dev-system-gh` volume by default, and a repo can mount its own.

Nothing here changes the template, the image or any workspace. The probes ran against gh 2.102.0
with a scratch `GH_CONFIG_DIR` and fake tokens, so no GitHub token was created, rotated or revoked.

## How to read the results

- [FINDINGS.md](FINDINGS.md): the answers to the four questions, the recommendation, and a short
  design brief for a per-workspace choice in case one is wanted later. Each claim names its
  evidence: a probe below, a line of gh's source at the installed version, or a GitHub doc.
- [evidence/probe-gh-config.sh](evidence/probe-gh-config.sh) and its output
  [evidence/probe-gh-config.out](evidence/probe-gh-config.out): what gh writes into an empty config
  dir, how it writes `hosts.yml` (in place or by rename), whether a symlinked `hosts.yml` works, and
  what concurrent writers do. Re-run it with `bash docs/spikes/gh-auth/evidence/probe-gh-config.sh`;
  it needs only `gh` and touches nothing outside a temporary directory.
- [evidence/inspect-workspace-gh.sh](evidence/inspect-workspace-gh.sh) and its output
  [evidence/workspace-persist-gh.txt](evidence/workspace-persist-gh.txt): a read-only look at a real
  Coder workspace's `/persist/gh` (the `devsystem` workspace, on the shared volume), showing file
  names, keys and token shapes only, never a token value.
