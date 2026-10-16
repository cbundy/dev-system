# Testbed loop setup (verification stage), working notes

Started 2026-10-15 ~19:40 UTC by the setup agent.

- Workspace dev-system-testbed-loop: template orchestrator-loop, was stopped on v0.37.0-1-gd288375.
  Params before: repo_url=https://github.com/cbundy/dev-system-testbed.git (immutable), cpus=2,
  memory 8, session mode, resume true, skip permissions true, ring consumer.
- repo_url is immutable (coder/dev-system/main.tf repo_url mutable=false), so the scratch repo is
  cloned beside it and the loop's workspace config.json points checkout/repo at it.
- cbundy/dev-system-scratch was EMPTY at 19:40 (no default branch).
- 19:39:33 another verification agent seeded cbundy/dev-system-scratch (main 95ddf08 "Seed the
  scratch repo from dev-system-testbed", tag drill-base, PRs #1 #2; .claude/factory-loop.json has
  gateCommands [npm run lint, npm test] and maxInFlightIssues 2; protection strict, ci required).
  I had built my own seed in the scratchpad but did NOT push it; the repo is theirs to shape.
- 19:44 coder update dev-system-testbed-loop --parameter cpus=4 (moved it to the active
  orchestrator-loop version v0.38.1-1-g5dbee5b, which shares the dev-system-gh volume).
- 19:45 old /persist/claude/factory-loop/config.json was {"mode":"act"} (repo from the session
  checkout = dev-system-testbed). Saved as config.json.before-v2-setup and set to {"mode":"off"}
  before Claude started.
- 19:48 cloned feat/factory-loop-v2 (901a0a8) to /persist/claude/loop/dev-system-v2 and
  cbundy/dev-system-scratch (95ddf08) to /workspaces/dev-system-scratch.
- 19:48 moved the testbed checkout to /workspaces/dev-system-testbed.real and made
  /workspaces/dev-system-testbed a symlink to /workspaces/dev-system-scratch. Why: the session
  starts in DEV_WORKSPACE (/workspaces/dev-system-testbed, from the immutable repo_url) and
  dev-remote-control resolves it with pwd -P, so the loop session now runs in the scratch checkout:
  CLAUDE_PROJECT_DIR is the scratch main checkout, so callum-flow's main-checkout write guard,
  the session's project settings and CLAUDE.md are the scratch repo's, as in production. dev-init
  only fetches an existing checkout, so a workspace restart keeps this. The old conversation is
  under the testbed's project dir, so the first start is a fresh conversation.
  Revert: rm /workspaces/dev-system-testbed && mv /workspaces/dev-system-testbed.real /workspaces/dev-system-testbed
- 19:48 /persist/claude/factory-loop/config.json (workspace file):
  mode off, repo cbundy/dev-system-scratch, checkout /workspaces/dev-system-scratch,
  toolsDir <branch>/features/src/callum-tools, binDir <branch>/images/base, planner v2,
  shadow off, maxInFlightIssues 2, trace true.
- 19:48 /persist/claude/settings.json env CLAUDE_CODE_PLUGIN_DIRS = the branch's
  plugins/callum-flow : plugins/factory-loop : plugins/factory-loop-workspace (backup
  settings.json.before-v2-setup). `claude plugin list` shows all three as session-only
  @inline 0.38.2 from /persist/claude/loop/dev-system-v2. callum-flow is loaded from the branch
  too because the installed one is 0.37.0, which lacks forbid-main-checkout-write.sh (v2 SPEC
  10.4 relies on it). Disabled the marketplace factory-loop@callum (user scope) so only one loop
  can run; dev-init keeps a user-disabled default plugin disabled (plugins.sh RESTORE_DISABLED).
- binDir CLIs resolve to the branch (callum-flow-event, -claim, -sweep, -factory-state,
  -patch-id, -merge, -merge-guard). gh logged in as cbundy (shared dev-system-gh volume).
  CALLUM_FLOW_TRUSTED_AUTHORS set. Claude Code 2.1.300 in the workspace.
- BLOCKER 19:49: Claude is NOT logged in (credentials file has empty tokens). Needs the owner:
  open https://coder.buddycloud.net/@callum-bundy/dev-system-testbed-loop.main/apps/login/
  and complete the Claude sign-in (paste the code into the page), or open the sign-in link that
  /tmp/dev-remote-control.log shows and run: coder ssh dev-system-testbed-loop -- dev-login <code>
  Claude then starts within 30 s by itself, with mode off, so nothing acts.
- After the login: /persist/claude/factory-loop-v2-build/verify/testbed-check.sh (read only), then
  `testbed-check.sh observe 200` (observe for 200 s, then back to off) to see planner v2 and the
  workspace rail in the decision log.
