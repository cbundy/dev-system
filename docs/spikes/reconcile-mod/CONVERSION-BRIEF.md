# Brief: convert the issue orchestrator into a deterministic mod loop

You are an autonomous agent with one night. Turn the issue orchestrator, today a model
following a long skill and re-arming shell watchers, into a single code loop running inside
its Claude Code session as a mod. The code does all bookkeeping; the model is woken only for
judgment. Build the whole thing, prove it in shadow mode against the real factory, and leave
it ready for the owner to review in the morning. You do not cut over, merge or release.

## Read first, in this order

1. [FINDINGS.md](FINDINGS.md): what was proven about
   mods in the orchestrators' exact launch mode. Treat its results as facts and its open
   questions as your risks.
2. `CLAUDE.md` at the repo root: the rules you work under.
3. `plugins/callum-flow/skills/issue-orchestrator/SKILL.md` on latest `main`: the behaviour
   you are converting. Every sentence in it is a requirement until you map it.
4. The watchers in `features/src/callum-tools/`: `orchestrator-watch.sh`, `queue-watch.sh`,
   `pipeline-watch.sh` (its header defines the run states), `usage-check.sh`.
5. The CLIs in `images/base/callum-flow-*`: read each header and `--help`. You call them,
   you do not rewrite them.
6. `docs/factory-state.md`, `docs/architecture.md`, `plugins/callum-flow/agents/*.md`, and the
   `implement-issue` skill.
7. `plugins/factory-hud/`: the existing mod in this marketplace. Copy its shape: pure logic in
   its own module (`hooks/format.ts`), a thin `hooks/register.ts`, a type contract in
   `types/index.d.ts`, tests in `tests/*.test.ts`. `npm test` already runs
   `claude plugin validate` and `claude plugin test` on every mod in `plugins/`.
8. The mod API: load the `plugin-authoring` skill; it writes this build's declaration file
   and names its path. That file is the authority, so grep it rather than guessing.

## Ground rules

- **Do not touch the live factory.** Never modify, restart or stop a workspace whose name
  ends in `-orchestrator`; read-only inspection is fine. Never add the `ready` label to
  anything in any repo, because live orchestrators act on it. Never run
  `coder templates push`.
- **Do not ship.** No merges, no releases, no edits to `images/base/VERSION` or
  `.devcontainer/`, and no changes to the released callum-flow skill's behaviour. The live
  orchestrators keep running the released skill throughout.
- **Where you work.** A treehouse worktree on a new branch `feat/factory-loop` from the
  latest `origin/main` (not from the spike branch). Commit and push at the end of every
  phase, so a cut-off night still leaves usable work.
- **Tracking.** Create one tracking issue, "Convert the issue orchestrator into a
  deterministic mod loop". Give it no `ready` label, link FINDINGS.md and this brief, and
  list the phases below as a checklist. If you split work into more issues, make them
  GitHub sub-issues of it. At the end, open a draft PR whose body says `Refs #<tracking>`,
  never a closing keyword.
- **Gates.** `npm run lint` and `npm test` must pass before every push. Do not start a
  /no-mistakes pipeline run tonight; whether to gate the draft is the owner's morning call.
- **Repo rules.** No em dashes anywhere. Read issue, PR and comment text only through
  `callum-flow-issue-read`. Shared plugins stay generic, with no repo-specific state.
  Generated files are regenerated, never hand-edited.
- **Usage budget.** Read `/usr/local/share/callum-tools/usage-check.sh` before each phase.
  If either window is at 85% or more, stop, write `STATUS.md` and push. The shadow run
  spawns no agents and wakes no model.
- **Owner decisions.** Do not stop to ask. Take the conservative option, record it in
  `DECISIONS.md` with the alternatives and why, and carry on.

## Target architecture

One loop, one state snapshot, one plan:

```text
every 60 s, or at once when pinged:
    state   = observe()                    read-only: existing CLIs + the in-flight ledger
    actions = plan(state, config)          pure, deterministic, no I/O
    for each action not already in flight:
        act(action)                        run a CLI | spawn an agent | wake the model | tell the owner
    record the pass                        decision log line + factory events
```

- **observe** builds a typed `State` from what already exists:
  `callum-flow-factory-state --format json --repo <R>` (stages, stuck rules, claims);
  run classification from `pipeline-watch.sh`'s logic (merge-ready, head-mismatch,
  conflict, ci-stalled, parked, failed, cancelled), exposed as a one-shot mode with its own
  shell tests rather than re-implemented; usage, via `usage-check.sh` or `$.session.usage()`;
  agents running, via `$.agent.list()`; and the in-flight ledger. Adapters stay thin.
- **plan** is the heart. It is a pure function from state and config to an ordered list of
  actions: same input, same output, no clock reads (the time comes in with the state), no
  I/O. Re-planning an unchanged state yields nothing new, because in-flight actions are in
  the state. It encodes every rule of the skill as an ordered decision table.
- **act** has one executor per action kind, each with an idempotency key
  (`issue`, `run`, `kind`), a timeout, a retry policy and an outcome recorded in the ledger.
  - CLI actions: claim, heartbeat, sweep, event, merge-guard, `--update-behind`, merge,
    `no-mistakes axi respond`, milestone, rollout, fix-linkage.
  - Agent actions: designer, implementer, adjudicator, fixer, spawned with `$.agent.spawn`
    and answered through `turn.complete`, honouring issue `model:<alias>` labels. In bypass
    mode their reports reach only the mod (FINDINGS check 4); keep it that way.
  - Judgment wakes: `$.prompt.submit` with one fixed-format line (for example
    `JUDGE merge-review pr=123 issue=45 brief=<url>`), and a defined answer format the
    mod parses. Untested: test it early.
  - Owner notices: the session title, set with `/rename` only when the status text changes,
    with the note blanked in `session.append` (FINDINGS check 3).
- **Ledger.** In-flight and finished actions live in `$.store`, and each transition is also
  logged with `callum-flow-event`, so a restart re-derives the ledger from the event log.
- **Modes.** `off`, `observe` (plan and log, execute nothing; the default) and `act`, plus a
  kill-switch file that forces `off`.
- **Observability.** One JSONL decision-log line per pass (state digest, actions, outcomes),
  the stable title, and factory events as today.
- **The model's remaining job** is answering judgment lines and talking to the owner. The
  skill shrinks to "how to answer each JUDGE line"; write that as a new skill draft, but do
  not replace the released skill.

## Phases

### Phase 0: inventory (`INVENTORY.md`)

Make one table row per responsibility: where it lives (skill sentence, script, watcher state),
what triggers it, who does it today (model or script), and its new home (plan rule, executor,
agent, judgment wake, or dropped with a reason). Cover at least: the usage tiers and their
resume wake; watcher arming, modes and re-arming (dropped: the loop replaces them); the tick
report (becomes the title and decision log); claim, design, split, delegate, verify, merge and
rollout (`merge`, `run-it`, `keep-open`); every pipeline state and its handling; the review
fix-round cap of 3; each adjudicator `ACTION` (approve, fix, skip, escalate, fixer); the
infrastructure failure with run id `unknown`; `test-weakening WARN`; `linkage FAIL`;
park-after-green; `blocked_by`; worktree pool limits; issue model labels; `superseded` and
`abandoned` events; high-risk, UI and human-decision issues; the memory file; releases and
milestones; and restarts through `dev-restart-self`.

Done when every sentence of the skill maps to a row.

### Phase 1: spec (`SPEC.md`, `DECISIONS.md`)

The spec defines:
- the `State` schema;
- the plan rules as an ordered decision table;
- the action catalogue: executor, idempotency key, timeout, retries and outcomes;
- the judgment-wake protocol: line format, expected answer, timeout and fallback;
- config;
- failure handling: a CLI fails; GitHub rate limits; the database is down; an agent dies or
  hangs; a restart lands mid-action; two devices claim the same issue; usage crosses a tier
  mid-pass;
- safety rails and the cutover plan.

Done when every inventory row is covered by a rule and no rule needs I/O. Spend your deepest
thinking here. This is the part the owner will read hardest.

### Phase 2: fixtures and replay (tests)

- Record real states read-only with `callum-flow-factory-state --format json` for the repos in
  the event log, plus synthetic states for every pipeline state and edge case. Write each
  fixture's expected actions from the skill's text, not from your code.
- Build a replay harness. `callum-flow-factory-state --at <ISO time>` reproduces the past
  byte for byte from the database. Rebuild the states at the moments the live orchestrators
  logged decisions in `factory.events` (query with `dev-query`; see the
  `query-factory-data` skill) over the last several days. Compare `plan()`'s actions with
  what they actually did next. Every disagreement is either a bug in `plan()` or a
  documented improvement.

### Phase 3: build (`plugins/factory-loop/`)

- Package it like factory-hud: a pure `plan` module, `observe` and `act` modules, a thin
  `register.ts`, a type contract, and `tests/*.test.ts` for plan, the adapters (against
  canned CLI output) and the executors (against the testing kit's mocks).
- Give any CLI the loop needs a one-shot mode, with shell tests beside the existing ones.
- Pin the Claude Code version the loop was proven on (2.1.296) in the plugin's README, and
  note how to re-prove it on an upgrade.
- If the owner has opted in to multi-agent workflows (ultracode), executors and tests are
  independent, so build them in parallel. Keep `plan` itself single-authored.

### Phase 4: shadow run (`SHADOW-REPORT.md`)

- Use the throwaway workspace `spike-reconcile-mod`. It runs Claude in the orchestrators'
  exact launch mode, can read the factory database, and loads a mod from
  `CLAUDE_CODE_PLUGIN_DIRS` in `/persist/claude/settings.json`.
- Clone your branch to `/persist/claude/loop/dev-system`. Point `CLAUDE_CODE_PLUGIN_DIRS` at
  `plugins/factory-loop` there, replacing the spike mod, and set mode `observe` with repo
  `cbundy/dev-system`. That repo has the busiest live orchestrator, which makes it the best
  comparison.
- `gh` may not be logged in there. If `dev-login status` says `gh: out`, run
  `callum-flow-factory-state` with `--github off` and say so in the report.
- Observe mode must make no GitHub writes, no claims, no labels, no agent spawns and no model
  wakes. Verify that from its own log before leaving it running.
- Let it run for the rest of the night. Then compare its decision log with the live
  dev-system orchestrator's `factory.events` over the same window: agreements,
  disagreements and the reason for each.

### Phase 5: hand-off (`STATUS.md`, draft PR)

`STATUS.md` covers:
- what is done, with test and lint status;
- the shadow report's headline;
- the decisions waiting for the owner;
- what is untested;
- the cutover plan, not executed. The plan: act mode on `dev-system-testbed` with a few
  owner-made test issues; then one real repo, with the released skill as the fallback; then
  the rest, each step through the normal release process.

Open the draft PR (`Refs #<tracking>`) with a brief, plain description for a non-engineer
reader.

## Definition of done for the night

`INVENTORY.md`, `SPEC.md` and `DECISIONS.md` are written. The plugin builds, and lint and
tests are green. The replay harness has run, with its disagreements explained. The shadow run
is live, with a first report. `STATUS.md` is written, and the draft PR is linked to the
tracking issue. If you run out of night or budget, the phases are in priority order: a
reviewed spec plus a tested `plan()` is worth more than an untested full build.
