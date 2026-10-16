# Factory loop v2: foundation map

What the v2 rule layer builds on. The owner's decisions keep the loop's foundation (a pure plan
over a keyed ledger, the rails, usage tiers, owner controls, the decision log and the trace) and
replace its rule layer (`/persist/claude/factory-loop-v2-build/OWNER-BRIEF.md`, "The verdict in
one paragraph"; verdict, "Verdict"). This map names each module's fate, the interfaces a new layer
must plug into, the tests and decisions on each side, and the couplings to cut.

- **Base:** `feat/factory-loop-v2` at `d633030`. Paths are under `plugins/factory-loop/` unless
  they start with `docs/` or `tests/` (repo root). Sizes are `wc -l`.
- **Sources:** the code itself, `docs/factory-loop/SPEC.md` and `DECISIONS.md`, the verdict
  (`2026-10-14-verdict.md`), G2 (`G2-code-and-spec.md`) and C3 (`C3-coarsest-viable-loop.md`)
  in `/persist/claude/factory-loop-review/`.
- **Read with:** [SPEC.md](SPEC.md), which makes the choices this map leaves open, and
  [SPIKES.md](SPIKES.md). Where this map suggested a v2 choice, the spec's decision is noted
  inline: triage is a spawned agent, not a wake; the reviewer and the v2 designer have their own
  definitions; a companion plugin sets each agent's folder.

## The map in five lines

1. **Foundation:** the pass driver (`register.ts`), the act step (`act.ts`, `exec.ts`), the
   ledger (`ledger.ts`), the rails (`rails.ts`), owner controls (`control.ts`, `config.ts`), the
   wake machinery (`wake.ts`), the trace (`trace.ts`) and the answer channel (`contract.mjs`,
   `bin/factory-answer`, `agent-tools.ts`, the spawn half of `act-agents.ts`).
2. **Rule layer:** `plan.ts` except its generic admission code, the pipeline and merge executors
   in `act-merge.ts`, the agent purposes, prompts and reply contracts, `deriveLedger`, the
   `runs`, `pool` and `checkout` sources, and the judge skill's JUDGE and TASK sections.
3. **The seam:** `plan(state: State, config: Config): PlanResult` (`hooks/plan.ts:178`), called
   twice (`act.ts:456`, `register.ts:921`). A new layer is another function of that signature.
4. **What blocks a clean swap:** the usage tier, the admission filters, the title and the agent
   liveness test live inside `plan.ts` and the foundation imports them; and the closed unions in
   `types.ts` and `config.ts` hold the old rule vocabulary (section 4).
5. **Size, by file verdict (section 1):** keep 1,125 hook lines, change 8,922, replace 3,263.
   Inside the "change" files, C3 estimates that about 6,700 of today's 13,308 hook lines survive
   in all (C3 6, an estimate).

## 1. Modules

Verdicts: **keep** (foundation as is), **change** (foundation with rule-layer parts to cut or
move), **replace** (rule layer: deleted in the delete wave once v2 plans).

| File | Lines | Verdict | Reason |
|---|---|---|---|
| `hooks/register.ts` | 1,600 | change | The only holder of `$` (`register.ts:1-14`): scheduler, rails, store, decision log, hooks, controls. Cut the update-drain restart (`updateDone`/`clearUpdate`, `register.ts:1118`), the hidden-agent `agent.offer` list (`:1591-1597`) and the single `plan` call (`:921`). |
| `hooks/act.ts` | 704 | change | Dispatcher, `runActions`, `actOne`, `transition`, `logLoop`, `sendNotice` are generic. Cut `GITHUB_KINDS` (`:40`), `reconcilable`'s repair grace (`:357-394`), `updateDone` (`:396`) and the `plan`/`turnEnded` import (`:17`). |
| `hooks/exec.ts` | 149 | keep | The executor contract (`ActIo`, `ExecCtx`, `Exec`, `Executor`). Only `respondLogPath` (`:129`) is rule layer. |
| `hooks/ledger.ts` | 464 | change | Pure keyed ledger and store codec. Cut `foldRecheck` (`:166`), the A1 stop special case (`:142-146`), the env-retry and update-behind cases in `retryIssue`/`maxAttemptsOf` (`:340-383`) and the `turnEnded` import from plan (`:12`). |
| `hooks/rails.ts` | 558 | keep | Act lock, role, old watcher, heartbeat guard, usage pre-check, scheduler, notices. Only its `tierOf` import from `plan.ts` (`:9`) must move. |
| `hooks/trace.ts` | 418 | keep | Phases, command timing, wait ages. `sourceOf` (`:135-150`) names `pipeline-watch.sh` and slot reflogs: update with the sources. |
| `hooks/control.ts` | 603 | change | `/factory`, the control tool, `control.json`. Change `resume` (subjects `issue:N` or `run:<id>`, `:92-104`), `retry` and `update` to the v2 meanings (section 2.8). |
| `hooks/config.ts` | 269 | change | Loaders and `EMPTY_CONTROL` stay. `DEFAULT_CONFIG` (`:8-83`) and `ACTION_KINDS` (`:113-117`) carry rule-layer keys and kinds. |
| `hooks/types.ts` | 431 | change | Foundation types (`Ms`, `Tier`, `ActionClass`, `Source`, `Usage`, `Control`, `LedgerEntry`, `State` frame, `PlanResult`, `Skip`) beside rule unions (`Stage`, `RunView`, `Slot`, `Checkout`, `Outcome`, `ActionKind`, `Action`, purposes). |
| `hooks/observe.ts` | 572 | change | Keep `factory`, `facts`, `queue`, `github`, `usage`, agents and the ledger choice. Cut `runs` (`pipeline-watch.sh`, `:208-224`), the slot reflog inference (`:418-472`) and the `task:run-it:` key read (`:341`). |
| `hooks/parse.ts` | 470 | change | Keep the factory, CSV, issue, queue, usage, pool and milestone parsers. Cut `parsePipelineLine/Once` (`:269-330`) and `parseReflog` (`:389`). |
| `hooks/state.ts` | 201 | change | Keep `buildState` (`:120`) and `digestOf` (`:183`). Cut `seenRuns`/`runsFromWatch` (`:85-118`). |
| `hooks/derive.ts` | 559 | change | Keep the event reader (`EVENTS_SQL`, `eventsFromRows`) and the `loop` note codec (`loopNote`, `loopEventArgs`, `entryFromLoop`). Replace `deriveLedger` (`:210`), which rebuilds old key families, and `runsFromEvents` (`:138`). |
| `hooks/plan.ts` | 2,541 | replace | The decision table. Before the delete wave, extract its foundation part (about 400 lines): `tierOf` (`:133`), `ALLOWED` (`:98`), `gate`/`want` (`:288-332`), `admit` (`:2378`), `oneWake` (`:2494`), `titleOf` (`:2520`), `blindPass` (`:492`), `issueFromBranch`, `sameLabel`, `guardSeq`, `listedLive`, `turnEnded`. |
| `hooks/wake.ts` | 498 | change | Wake executor, ANSWER blocks, turn tracking, timeouts, the answer tool. Replace the decision table `WAKE_DECISIONS` (`:133-143`) and `wakeDetails`' respond-stuck case (`:76-92`). |
| `hooks/act-cli.ts` | 439 | change | The CLI step runner, `stop-agent`, `title`, claim, heartbeat, sweep, abandon, close, milestone, `release-worktree`, `restart-self`. Cut `pr-close` (M8) and `pr-reopen` (P6a) (`:96-121`, `:339`). |
| `hooks/act-merge.ts` | 722 | replace | Keep `merge`, `rollout` and a reduced `guard` (C3 6: about 215 lines). Delete `respond`, `env-retry`, `update-behind`, `fast-forward`, `update-checkout`, `fix-linkage` and their scripts (`:83-224`, `:421-488`, `:550-600`). |
| `hooks/act-agents.ts` | 646 | change | Spawn, spawn record, reading answers by script, tool or text are foundation. Agent purposes, the `delegate` route and the `verdict`/`superseded` events (`:286-318`) are rule layer. |
| `hooks/prompts.ts` | 495 | change | Keep the framework: `neutral`, closing-keyword rewrite, `askOf`, `repairPrompt`, `FOREGROUND_RULE`, `COMMAND_RULE` (`:140-149`). Replace the per-purpose templates (`:292-443`) and `CHECKOUT_RULE` (`:143`). |
| `hooks/replies.ts` | 366 | change | Keep the designer `RESULT` parser. Replace the adjudicator gate parsing and the no-mistakes handoff (`run=`, `gated=`). |
| `hooks/agent-tools.ts` | 132 | change | The tool mechanism stays; the schemas (verdict purposes, handoff fields) change with the contracts. |
| `hooks/contract.mjs`, `.d.mts` | 425, 48 | change | Keep the job and answer-file mechanics (`:354-425`). Replace `ACTIONS_FOR`, `declinedFindings` and the handoff shapes (`:18-28`, `:228-340`). |
| `hooks/hooks.json` | 1 | keep | Loads `register.ts`. |
| `bin/factory-answer` | 236 | keep | A checked, atomic, one-file writer. It is contract-agnostic: contracts come from `contract.mjs` and the job file. |
| `agents/designer.md` | 81 | replace | v1's design step; it writes to GitHub itself and carries the no-mistakes exception (`:22`, `:26`, `:71-77`). v2 uses `agents/designer-v2.md`, a reader in the issue's slot, renamed `designer.md` at the delete wave (SPEC 8.7). |
| `agents/adjudicator.md` | 97 | replace | The gate-adjudicator purposes go. Its merge judgement becomes the interim reviewer, in a new `agents/reviewer.md` (OWNER-BRIEF decision 5; SPEC 8.3). |
| `skills/judge/SKILL.md` | 283 | change | Keep TELL format, owner chat, memory and session start (`:159-283`). Replace JUDGE and TASK (`:45-158`) with v2's TELL kinds and the release task; triage is a spawned agent, not a wake (SPEC 5.2). |
| `types/index.d.ts` | 22 | keep | `PassSummary`, the `lastPass` plugin state. |
| `.claude-plugin/plugin.json` | 51 | change | `userConfig` keeps `mode`, `repo`, `shadowDevice`. `runSource` (`local` or `events`) names the pipeline watcher. |

## 2. Interfaces

### 2.1 How a pass is driven

- **Clock.** `ensure` (`register.ts:1504`) runs once per module load, from `session.start` or
  `session.append` (`:1523-1539`). It arms a first pass after 5 s and a `$.clock.every` timer of
  `config.passEveryMs` (default 60 s), which `rearm` (`:656`) resets when the setting changes.
- **Wakes of the driver (pings).** `ping(why)` (`register.ts:625`) is called when an agent
  answers (`agent <id>`), a wake is answered (`wake <id>`) or an owner op lands (`owner <op>`).
  Timer and ping both go through `request(source, why)` (`:611`).
- **Scheduler.** `rails.ts:451-530`: `newScheduler`, `requestPass`, `nextPass` (one pass at a
  time, `PASS_GAP_MS` 5 s apart), `waitOver`, `passEnded`. The ping-storm breaker
  (`STORM_PASSES` 30 in `STORM_WINDOW_MS` 10 min) ignores pings for `STORM_QUIET_MS` and returns
  a `BreakerNotice` (D-39).
- **Triggers.** The decision log's `trigger` is the joined `why` of every request since the last
  pass (`register.ts:637-640`).
- **One pass.** `runPass` (`register.ts:724`) then `pass` (`:771`), in phases `setup`, `rails`,
  `observe`, `plan`, `act`, `log` (`trace.ts:18`):
  1. agent list (`:776`);
  2. rails in act mode (`:789-827`);
  3. `observe(...)` (`:845`);
  4. act mode: `actPass` (`:897`, `act.ts:441`); otherwise `plan` alone (`:921`);
  5. notices from outside plan (`:926-951`);
  6. decision log, states, prune, `lastPass`, trace (`:967-1050`).
- **Kill switch.** The file `${CLAUDE_CONFIG_DIR}/factory-loop/OFF` (`register.ts:1233`). It is
  checked before each action (`act.ts:214-240`).
- **Headless sessions** never run the loop (`register.ts:1523-1530`, D-61).

### 2.2 What observe returns

- **Signature.** `observe(io: Io, rt: Runtime, cache: Cache, loadedAt, lastTitle, stored?:
  Stored): Promise<Observation>` (`observe.ts:153`).
  - `Observation` = `{ state: State, commands, queueKnown, ledgerSource, rateLimited }`
    (`observe.ts:129`).
  - `Io` (`:143`) = `now`, `run`, `readFile`, `sessionLimits`, `agents`.
  - `Stored` (`:73`) = store ledger, GitHub backoff, queue `known` list.
- **`State`** (`types.ts:252`): `now`, `repo`, `device`, `loadedAt`, `sources`, `usage`,
  `issues: IssueView[]`, `queue`, `runs: RunView[]`, `pool`, `agents: AgentView[]`, `milestone`,
  `ledger`, `control`, `lastTitle`, `githubBackoffUntil`, `checkout`. It is assembled by
  `buildState` (`state.ts:120`).
- **Sources** (`SourceName`, `types.ts:22`), each a `Source { ok, at, error? }`. A failed read
  keeps its last value and age.

| Source | Command | Where | v2 |
|---|---|---|---|
| `factory` | `callum-flow-factory-state --format json --github off` | `observe.ts:184-193` | keep; required (blind pass, G2) |
| `facts` | `dev-query` with `EVENTS_SQL` (3 days) | `:195-202`, `derive.ts:38` | keep; change the state list |
| `runs` | `pipeline-watch.sh --once` | `:208-224` | delete (no-mistakes out) |
| `queue` | `queue-watch.sh --once` (act), `callum-flow-issue-read --list` (observe) | `:227-258` | keep |
| `github` | `callum-flow-issue-read --json N` (+ `--comments`, `--timeline`) | `:330-404` | keep |
| `usage` | `usage-check.sh` + `$.session.usage()` | `:405-417`, `:549` | keep |
| `pool` | `treehouse status --json` + per-slot reflog and status | `:418-490` | change: the loop's own lease record replaces inference |
| `checkout` | `git symbolic-ref`, `git status` | `:491-508` | change: a tripwire only (C3 sizing) |
| `milestone` | `callum-flow-milestone show next` | `:509-516` | keep (release side) |
| ledger | `$.store`, else 7 days of events | `:260-305` | keep the choice; replace `deriveLedger` |

- **Issues read.** The GitHub read set is running work, held issues, live stages, the queue and
  `only` (`observe.ts:306-357`). At most 12 issue reads per pass (`GITHUB_READS_PER_PASS`, `:35`).

### 2.3 The plan function

- **Signature.** `plan(state: State, config: Config): PlanResult` (`plan.ts:178`). Pure: it
  imports types only, which `tests/factory-loop-plan.test.js` enforces. The replay harness
  loads it under plain Node (`scripts/factory-loop-replay.js:211`).
- **Output.** `PlanResult` (`types.ts:419`) = `{ tier, overridden, actions: Action[], skipped:
  Skip[], title, owner, capped, atCap }`.
  - `Action` (`types.ts:341`) is a union over `ActionKind` with `Base = { key, class, rule,
    reason, issue }`.
  - `Skip` = `{ rule, issue, why }`.
- **Order inside `plan`** (`plan.ts:204-233`): rule functions fill `ctx.out` through
  `want(ctx, action)`, which drops a key that is running, done, waiting a backoff or exhausted
  (`gate`, `plan.ts:288`). Then `admit(ctx)` filters in this order (`plan.ts:2378-2491`):
  1. pause and drop;
  2. GitHub state not read;
  3. checkout moved;
  4. checkout readers;
  5. one writer per branch;
  6. no new work;
  7. update drain;
  8. tier;
  9. GitHub backoff;
  10. breakers;
  11. rate caps.

  Then `oneWake` keeps one wake (`:2494`), the title is added and `restart-self` goes last.
- **Foundation inside `plan.ts`.** The generic parts are `tierOf`, `ALLOWED`, `gate`, `want`,
  the control, tier, backoff, breaker and rate-cap filters of `admit`, `oneWake` and `titleOf`.
  v2 calls them, so they move to a foundation module before v2 plans (coupling C1). The checkout
  filters, the one-writer filter (`heldBy`) and the drain filter are rule layer.
- **Properties every plan keeps** (SPEC 5.9; `tests/plan.test.ts:62-98`): determinism,
  idempotence, tier safety at four usage levels, control safety (pause, no new work) and bounds
  (one wake, `maxStartsPerPass` claims, rate caps). They take any `(State, Config) =>
  PlanResult`, so they carry over to v2 as they are.
- **Layer switch.** The owner brief wants a setting that picks the planning layer, with v2 able
  to shadow v1 (OWNER-BRIEF "How the build works"). The two call sites above are where it goes.

### 2.4 How actions are executed

- **Executors.** `Executor<A> = (ctx: ExecCtx, action: A) => Promise<Exec>` (`exec.ts:93`).
  - `ExecCtx` (`:41`) = `io`, `rt`, `state`, `entry`, `cmd`, `event`, `wakeId`.
  - `Exec` (`:87`) = `done | failed (noRetry, rateLimited, extra) | running (agentId, wakeId) |
    skipped`.
  - `ActIo` (`:23`) = `run`, `spawnAgent`, `stopAgent`, `submit`, `rename`, `usage`,
    `readFile`, `writeFile`. `register.ts:343` builds it over `$`.
- **Registry.** `EXECUTORS` (`act.ts:31`) merges `cliExecutors`, `mergeExecutors`,
  `agentExecutors` and `wakeExecutors`. `dispatch` (`act.ts:63`) turns a missing kind into a
  failed `noRetry`. A v2 kind registers here.
- **The act loop.** `actPass` (`act.ts:441`):
  1. apply what the agent list proves (`reconcilable`, `reconcileAgents`);
  2. expire wakes (`expireWakes`);
  3. plan;
  4. `runActions` (`:214`), in plan order.

  `runActions` checks before each action: the kill switch, `env.holds()` (the act lease renewed)
  and a GitHub limit met this pass. `actOne` (`:242`) then does `start`, the usage `preCheck`
  (`rails.ts:432`), saves the running entry before the executor, dispatches, and `record`s the
  result (`:278`).
- **Rails** (`checkRails`, `rails.ts:354`), run at the start of every act pass, fail safe
  (D-43). In order:
  1. the checkout's origin is the repo (`register.ts:794-796`);
  2. `DEV_ROLE=orchestrator` (`roleProblem`, `:162`);
  3. no armed `orchestrator-watch.sh` (`findWatcher`, `:217`);
  4. no other orchestrator heartbeat within 2 min (`heartbeatGuard`, `:300`, over
     `factory.workers`);
  5. the act lock.

  A refused pass runs as observe and logs `rails` reasons.
- **Act lock.** `<loop dir>/act.lock` (`rails.ts:34`).
  - A lease `{ session, renewedAt, expiresAt }` of `max(5 passes, 15 min)` (`:29-40`).
  - Taken and renewed by a compare-and-swap script under `flock` (`LOCK_CAS_SCRIPT`, `:96`;
    `holdActLock`, `:122`).
  - Renewed before every action and on a timer during the pass (`register.ts:861-880`).
  - Released at `session.end` (`:1556`).
  - The ledger writes back only while the lease is this session's (`mayWrite`, `register.ts:459`).
- **Mode wiring.** In observe mode `rt.env` carries `CALLUM_EVENTS_DIR=<loop dir>/sink-events`,
  so CLI event writes go to a sink (`register.ts:257-267`, SPEC 11.1, D-10).

### 2.5 The ledger

- **Entry.** `LedgerEntry` (`types.ts:224`; SPEC 7.1) = `key`, `kind`, `class`, `rule`,
  `issue`, `run`, `pr`, `head`, `agent?`, `wake?`, `status` (`running|done|failed|timed-out|lost`),
  `attempts`, `startedAt`, `endedAt`, `agentId?`, `outcome?`, `wakeId?`, `turnId?`, `reminded?`,
  `session?`, `summary?`.
- **API** (`ledger.ts`, pure):
  - `start(ledger, action, now, session)` (`:54`): a retry keeps the key and adds an attempt.
  - `finish(ledger, key, Exec | Completion, now, {config, prev})` (`:116`).
  - `onLoad` (`:213`): running CLI entries become lost.
  - `reconcileAgents` (`:224`).
  - `prune` (7 days, `:244`) and `fit` (3 MiB, `:251`).
  - `choose` (store or events, `:274`).
  - `load`/`save` over `StoreIo` (`:318`, `:323`).
  - `retryIssue` (`:340`), `exhausted` (`:361`), `maxAttemptsOf` (`:377`).
  - `loopEvent` (`:389`), `changedEntries` (`:395`).
- **Live ledger.** One in-memory array replaced whole by `transition(live, fn)` (`act.ts:131`).
  Saves go through `persist` (`register.ts:519`), one at a time, before each loop event (D-40).
- **Key families.** About 62 today (G2 1). Examples: `claim:<n>`, `heartbeat:*`, `sweep:*`,
  `design:<n>:*`, `delegate:<n>:<brief>`, `adjudicate:*`, `respond:*`, `guard:<pr>:<head>:<seq>`,
  `update-behind:<pr>:<head>`, `fast-forward:*`, `merge:<pr>:<head>`, `rollout:<issue>`,
  `fixer:*`, `judge:<name>:*`, `task:<name>:*`, `tell:<kind>:*`, `stop:<agentId>`, `restart:<at>`,
  and 11 or more families with an owner-resume suffix `:r<n>` (G2 1).
- **What is foundation.** The key scheme is plan's alone; the ledger compares keys, never parses
  them, except for coupling C3. C3 estimates about 12 families for v2 (C3 "Sizing").

### 2.6 Factory events

- **Emitter.** `ExecCtx.event(state, fields)` = `eventOf(cmd)` (`act.ts:102`), which runs
  `callum-flow-event <state> --issue --run --branch --pr --head --note` (`eventArgv`, `act.ts:89`).
  Exit 2 is a usage error, never retried. CLI steps can also be `{ event, fields }`
  (`act-cli.ts:56-61`).
- **What the loop logs itself, and where:**

| Event | Where | v2 |
|---|---|---|
| `delegated` | `act-agents.ts:593` | keep |
| `verdict` | `act-agents.ts:296-299` | replace with review events |
| `superseded` | `act-agents.ts:307-308` | delete |
| `fix_requested --note review` | `act-merge.ts:568` | replace |
| `rebased_behind` | `act-merge.ts:438` | delete |
| `abandoned` | `act-cli.ts:89`, `:95` | keep (a closing event) |
| `loop` (agent and wake entries, at start and end) | `ledger.ts:389`, via `logLoop` (`act.ts:174`) | keep |
| `loop` (rate-cap holds, `kind=<bucket> status=held`) | `act.ts:336` | keep |
| `loop` (ping breaker) | `act.ts:346` | keep |

- **The `loop` note.** `kind=`, `key=`, `status=`, `attempts=`, `class=`, `rule=`, times, agent,
  wake and outcome tokens (`derive.ts:369-398`; SPEC 7.4; D-09). Readers treat `loop` as
  bookkeeping, never as a stage. A lost store is rebuilt from these events (`entryFromLoop`,
  `derive.ts:445`).
- **What the CLIs log.** The loop calls CLIs that log their own events (D-09, SPEC 7.4):
  `callum-flow-claim` (`claimed`, `renewed`, `claim_lost`), `callum-flow-sweep` (`reclaimed`,
  `closed`), `callum-flow-merge` (`merged`), `queue-watch.sh --once` (`ready`).
- **What v2 adds.** The state-change, manual-touch and review events (OWNER-BRIEF decisions 1, 3
  and 5) go through the same `ctx.event` (coupling C9).

### 2.7 Usage tiers

- **Tiers.** `Tier` = `normal | slow | stop-new | stop-all`. `tierOf(usage, config, override,
  now)` (`plan.ts:133`) reads the higher of the 5-hour and 7-day windows against
  `usageSlowPct` 85, `usageStopNewPct` 90 and `usageStopAllPct` 95 (`config.ts:15-17`). A
  missing reading is `normal`. The owner override keeps `normal` below its percentage.
- **Classes per tier.** Each action has a class (`free | owner | drive | develop | start`).
  `ALLOWED` (`plan.ts:98`) is mirrored as `TIER_CLASSES` (`rails.ts:399`), and
  `rails.test.ts` holds the two equal.
- **The two checks.** Plan's tier filter in `admit`, and `preCheck` (`rails.ts:432`), which reads
  the session's usage again before any `start`, `develop` or `drive` action and skips it with no
  attempt counted.
- **Readings.** `usage-check.sh` every 5 min, plus `$.session.usage()` each pass
  (`observe.ts:405-417`, D-06).
- **Slow.** Slow's extra rule (one claim per pass, a 10 min gap, none in a pass with merge work,
  D-07) lives in `claims()` (`plan.ts:2106`). It is rule layer, but v2 must keep it or replace it
  deliberately.

### 2.8 Owner controls

- **`Control`** (`types.ts:116`): `paused`, `noNewWork`, `skip`, `priority`, `only`, `serial`,
  `usageOverride`, `updateDue`, `resumed[{subject, at}]`, `dropped`, `notes`.
- **Where it is stored.** `<loop dir>/control.json`, read each pass (`observe.ts:565`,
  `controlFrom`, `config.ts:236`).
- **Ops** (`control.ts:24-27`): `status`, `pause`, `unpause`, `skip`, `noskip`, `priority`,
  `only`, `serial`, `new`, `override`, `resume <N|run id>`, `retry <N>`, `update`, `drop`,
  `note [N] <text>`, `mode`, `trace`.
  - `parseOp` (`:139`) reads an op and `applyOp` (`:258`) applies it.
  - `runOp` (`:519`) makes the file round trip. `mode` and `trace` write the workspace file.
  - Only the main conversation may change an op (`:525`).
- **Entry points.** `/factory <op>` (`FACTORY_COMMAND`, `control.ts:569`; `register.ts:1562`) and
  `mcp__factory-loop__control` (`CONTROL_TOOL`, `:580`; `register.ts:1566`). Both go through
  `ownerOp` (`register.ts:1389`): serialized, answered within 2 s, a ping and a decision-log line
  on change. `retry` also clears exhausted entries in the live ledger (`register.ts:1418`,
  `ledger.ts:340`).
- **Where the meaning lives.** Plan reads `resumed` by subject (`plan.ts:411-421`), so the meaning
  of a resume is rule layer. v2 needs `resume N "note"` and the label-removal resume
  (OWNER-BRIEF decisions 1 and 7).

### 2.9 The decision log and the trace

- **Decision log.** `<loop dir>/decisions-YYYY-MM-DD.jsonl`, one line per pass
  (`register.ts:968-1006`). Fields: `v`, `at`, `pass`, `loaded`, `trigger`, `ms`, `mode`,
  `executed`, `device`, `tier`, `digest`, `sources`, `counts`, `actions`, `skipped` (60 at most),
  `outcomes`, `capped`, `atCap`, `rails`, `ledgerSource`, `breaker`, `told`, `config`,
  `problems`, `commands`, `title`.
  - Hooks between passes append lines with `agent`, `turn`, `control` or `tool` keys
    (`appendLine`, `register.ts:413`).
  - `counts` reads `Stage` (`:983-989`): coupling C6.
- **States.** Full `State` snapshots in observe mode, 288 a day at most (`register.ts:1009-1018`),
  for the replay harness.
- **Trace.** `trace-YYYY-MM-DD.jsonl` (`trace.ts`; SPEC 12.1; D-69): phases, every command
  (source, exit, bytes), actions with queued, start and end times, wake latencies, and
  `waitingRows` (what each issue waits on and since when, built from `skipped`, `trace.ts:305`).
  Kept under `traceMaxBytes` (100 MiB).
- **Prune.** Daily, of files older than 7 days (`exec.ts:143`, D-46).
- **Last pass.** `$.state` `lastPass` holds a `PassSummary` (`types/index.d.ts`;
  `register.ts:1024`), which `/factory status` reads.

### 2.10 Agent spawning and the answer channel

- **Spawn.** `start(ctx, action, model, env)` (`act-agents.ts:538`):
  1. write the job file for the answer script (`scriptFor`, `:520`);
  2. write the spawn record `<loop dir>/spawns/<key>.json` (`:147`);
  3. call `io.spawnAgent(SpawnInput { subagentType, prompt, description, name, model })`
     (`exec.ts:13`; `$.agent.spawn` under a 60 s bound, `register.ts:351`).

  The entry runs with `agentId` until the answer arrives.
  - `SUBAGENT_OF` (`act-agents.ts:102`) maps types to `factory-loop:adjudicator`,
    `factory-loop:designer`, `callum-flow:implementer` and `callum-flow:fixer`.
  - The engine's spawn input has no working-directory or environment field (verdict
    "Unverified", `act-agents.ts:111-121`; D-11). This matters for slot leasing (OWNER-BRIEF
    decision 6). The agent-folder spike settled it: `$.agent.spawn({ cwd })` is dropped on
    2.1.300, and a second plugin's `agent.spawn` hook sets the folder (SPIKES.md; SPEC 10.3).
  - Agents spawned from the loop's timer never reach the loop's own hooks or registered tools,
    so `answerChannel` stays `script` (SPIKES.md, the hooks spike).
- **Answer, three channels** (`config.answerChannel`; README "How agents answer"; D-68, D-73,
  D-74):
  - **script** (default): the prompt names `bin/factory-answer --to <file>` and a per-attempt
    path `answers/<key>.a<n>.<startedAt>.answer.json` (`exec.ts:122`). The script checks the JSON
    against `contract.mjs` and the job file, and writes atomically. The loop re-checks it at the
    agent's `turn.complete` (`onAgentAnswer`, `act-agents.ts:365`), or before marking the agent
    lost (`answeredBeforeLost`, `act.ts:422`).
  - **tool**: `mcp__factory-loop__verdict|design|handoff` (`agent-tools.ts:23-128`;
    `register.ts:1577-1585`, through `agentTool`, `:1456`).
  - **text**: the machine line (`replies.ts`).
- **Repair.** An unreadable answer gets one repair message (`repairTo`, `register.ts:1320`; the
  `between` maps, `act.ts:408`).
- **Agent end.** `turn.complete` with `agentId` (`register.ts:1547-1553`, then
  `agentTurnEnded`, `:1279`). Each pass reconciles the agent list: gone means lost, failed or
  killed means failed, idle or completed means lost after one pass (`ledger.ts:224`, `act.ts:369`).
  Stopping uses `TaskStop` for the loop's own agents only (`act-cli.ts:361-385`).

### 2.11 The judge: wake and task kinds

- **A wake.** A `judge | task | tell` action (`types.ts:414`). The wake executor
  (`wake.ts:111`) submits `<JUDGE|TASK|TELL> <name> id=<id> repo=<r> k=v...`, then context lines,
  then `Answer with the factory-loop:judge skill.` (`wake.ts:64`, `exec.ts:134`).
- **Answers.** An `ANSWER <id> <decision>` block (`parseAnswers`, `wake.ts:184`) or the answer
  tool (`ANSWER_TOOL`, `wake.ts:456`; `register.ts:1571`). Both are checked by `checkAnswer`
  (`:289`) against `WAKE_DECISIONS` (`:133`).
- **Turns and timeouts.** `onTurnStart` and `onTurnComplete` (`wake.ts:327-400`) track the turn
  and send one reminder. `expireWakes` (`:422`) ends a wake at `wakeTimeoutMs` (judge 30 min,
  task 6 h, tell 30 min): a judge falls back to `hold`, a task and a tell time out.
  `orphanedWakes` (`:439`) handles a wake from another session.
- **One wake open at a time** (`oneWake`, D-26). Notices from outside plan wait for it
  (`sendNotice`, `act.ts:305`, D-44).
- **Kinds today:**
  - judge: `sequence`, `guard-fail`, `cancelled`, `handoff`, `report`;
  - task: `redrive`, `run-it`, `release`, `respond-stuck` (`wake.ts:133-143`);
  - tell: 21 names built with `wake('tell', ...)` in `plan.ts` and `agent-failed` or
    `task-timeout` (`plan.ts:2309`), with `OWNER_TELLS` ranked first (`plan.ts:58-72`), plus
    `heartbeat-other`, `old-watcher` and ping `breaker` (`rails.ts:538-558`), and `pass-error`
    (`act.ts:313`).
- **v2.** v2 keeps tell and the wake machinery and `task release`, and replaces the other judge
  and task kinds. C3 suggested one triage wake ("What each side does"); the spec makes triage a
  spawned agent instead, because wakes go one at a time and queue behind tells (SPEC 5.2 and
  section 15).

### 2.12 Persistence and configuration

- **`$.store`** (through `StoreIo`, `ledger.ts:284`; `register.ts:546-562`) holds 4 MiB for all
  keys:
  - `ledger:<repo>` = `{ v: 1, savedAt, entries }`;
  - `backoff:<repo>`, `queue-known:<repo>`, `rails:<repo>` (rail memory) and `notices:<repo>`
    (`register.ts:437-442`; SPEC 7.1).

  v2's per-issue record needs either a new key here or a ledger entry kind (coupling C2).
- **`$.state`.** `lastPass` (`register.ts:126`).
- **Configuration, in layers** (`runtime`, `register.ts:238-284`; SPEC 4.1):
  1. plugin `userConfig` (`mode`, `repo`, `shadowDevice`, `runSource`);
  2. the workspace file `${CLAUDE_CONFIG_DIR}/factory-loop/config.json` (those four, plus
     `checkout`, `poolSize`, `toolsDir`, `binDir`, `trace`, `answerChannel`);
  3. the repo-local `.claude/factory-loop.json`, loaded by `loadConfig` (`config.ts:130`) over
     `DEFAULT_CONFIG` (`:8`). It holds every `Config` key, and the workspace file wins for `trace`
     and `answerChannel`.

  A bad key is dropped and named in the log's `config` field.
- **`Runtime`** (`observe.ts:47`): `mode`, `repo`, `device`, `runSource`, `poolSize`, `cwd`,
  `loopDir`, `sink`, `env`, `toolsDir`, `pluginRoot`, `config`, `configProblems`.
- **Loop dir.** `<CLAUDE_CONFIG_DIR>/factory-loop/<owner>__<repo>/` (`loopDirOf`,
  `contract.mjs:369`). It holds:
  - `decisions-*`, `trace-*`, `control.json`, `act.lock`, `sink-events`;
  - `spawns/`, `answers/`, `respond/`, `states/` (SPEC 11.6).

## 3. Tests and decisions

### 3.1 Tests

| File | Lines | Side | Note |
|---|---|---|---|
| `tests/rails.test.ts` | 688 | foundation | Lock, role, watcher, heartbeat, pre-check, scheduler, notices. |
| `tests/ledger.test.ts` | 926 | foundation | `foldRecheck` and the env-retry and update-behind retry cases are rule layer (coupling C3). |
| `tests/trace.test.ts` | 619 | foundation | |
| `tests/control.test.ts` | 520 | foundation | `resume` and `retry` texts change. |
| `tests/wake.test.ts` | 710 | foundation | Except "plan reads what wakes leave behind" (`:596`) and the judge and task names. |
| `tests/driver.test.ts` | 1,943 | foundation | The driver in the engine's test host. Its fixtures use v1 kinds. |
| `tests/act.test.ts` | 1,347 | mixed | Dispatcher, `runActions` and notices (`:133-1081`) are foundation. The claim-to-merge path (`:1082`, D-60) is v1's path: keep the harness, rewrite the path. |
| `tests/safety.test.ts` | 550 | foundation | Its ban list must widen for v2's writes (coupling C10). |
| `tests/observe.test.ts` | 1,329 | mixed | parse, state, config, control and the loop event are foundation. Pipeline lines, reflog and `deriveLedger` are rule layer. |
| `tests/agent-tools.test.ts`, `answer-contract.test.ts`, `answer-cases.mjs` | 270, 107, 142 | mixed | The mechanism is foundation; the cases are v1 contracts. |
| `tests/act-cli.test.ts` | 674 | mixed | `pr-close` (`:324`) and `pr-reopen` are rule layer. |
| `tests/act-agents.test.ts` | 768 | mixed | Spawn and the answer read are foundation. Purposes and events are rule layer. |
| `tests/prompts.test.ts` | 590 | mixed | Keyword hygiene is foundation. The templates are rule layer. |
| `tests/plan.test.ts` | 2,736 | rule layer | 324 exact-key and 56 skip-string assertions (G2 5). Keep only `properties` (`:62-98`), re-pointed at v2. |
| `tests/act-merge.test.ts` | 1,030 | rule layer | Keep the merge and rollout cases (`:591-699`). |
| `tests/replies.test.ts` | 549 | rule layer | |
| `tests/host.ts`, `fixtures.ts` | 318, 204 | foundation, rule layer | The test host is generic; the fixtures build v1 states. |
| `tests/factory-loop-plan.test.js` | 69 | foundation | Purity. Apply it to the v2 layer's files too. |
| `tests/factory-loop-safety.test.js` | 293 | foundation | Its bans conflict with v2 writes (coupling C10). |
| `tests/factory-loop-answer.test.js`, `-loop-events`, `-prune` | 312, 86, 75 | foundation | |
| `tests/factory-loop-agents.test.js` | 117 | change | Ties `agents/` to the callum-flow definitions (D-70). |
| `tests/factory-loop-judge-skill.test.js` | 155 | change | Checks that the skill covers every wake and op. The mechanism stays; the lists change. |
| `tests/factory-loop-respond-launch`, `-fast-forward`, `-update-checkout` | 110, 213, 180 | rule layer | Delete with their executors. |
| `scripts/factory-loop-replay.js` | 360 | foundation | Imports `plan.ts` by path (`:211`). Needs the layer switch for the v2 replay (OWNER-BRIEF workflow 5). |

### 3.2 DECISIONS

My classification, from each entry's decision line. C3 6 is the cross-check: it keeps 40,
changes 17 and retires 19 of the 76.

- **Foundation, keep as is:**
  - Driver, ledger and modes: D-03, D-09, D-10, D-40, D-46, D-54, D-55, D-61.
  - Wakes and notices: D-04, D-25, D-26, D-44.
  - Rails: D-28, D-39, D-43.
  - Usage and controls: D-06, D-16, D-24, D-33, D-35, D-38, D-58.
  - Title and trace: D-23, D-27, D-69.
  - Agents and answers: D-11, D-22, D-68, D-70, D-74, with D-73 superseded by D-74.
  - Testbed and harness: D-42, D-60.
  - Process: D-01, D-02, D-31.
- **Foundation, keep but change:**
  - D-07 and D-08: tier semantics tied to claims and merges.
  - D-15 and D-53: restart without the pipeline drain.
  - D-41: the queue and the rebuild stay; the pipeline watcher goes.
  - D-45: the `--once` modes stay only for the queue.
  - D-47: the retry counts per v1 kind.
  - D-48: the narrow-writes rule must admit label, PR-create and update-branch writes.
  - D-56: keep the keyword rewrite; the `RESULT` shapes change.
  - D-57: plan details, mostly title and cap.
  - D-59: TELL format stays; JUDGE and TASK go.
  - D-72: the read order stays; "finished" maps to closed.
- **Rule layer:**
  - Changed in v2: D-05 (merge review becomes the reviewer), D-12 (conflicts go to a fixer), D-13
    (re-drives become triage), D-14 (designer `RESULT`), D-17 (trackers), D-29 (rollout
    follow-ups), D-34 and D-36 (heartbeat timing), D-62 (adjudicator parsing), D-63 (one writer
    becomes structural).
  - Obsolete: D-18 (derived holds), D-20, D-21 (pipeline-watch), D-37, D-49 (respond), D-50,
    D-65, D-66 (guard, head and fast-forward), D-51, D-52 (resume rounds, Run-it holds), D-64,
    D-76 (env-retry, resumed escalations), D-67, D-71, D-75 (agent liveness inference).
  - Done process notes: D-30, D-32.

## 4. Couplings a new layer must cut or replace

- **C1. Foundation code lives in `plan.ts`.**
  - The coupling:
    - `rails.ts:9` imports `tierOf`.
    - `ledger.ts:12` and `act.ts:17` import `turnEnded`.
    - `observe.ts:30` imports `LIVE`, `ENDED`, `issueFromBranch` and `listedLive`.
    - `act-cli.ts:10` imports `issueFromBranch` and `listedLive`.
    - `state.ts:6` imports `issueFromBranch`.
    - `act-merge.ts:11` imports `guardSeq`.
    - `admit`, `oneWake`, `titleOf` and `ALLOWED` are private to it (`plan.ts:2378-2541`).
  - The cut: move these into a foundation module both layers import, before `plan.ts` is
    deleted.
- **C2. Closed vocabularies.**
  - The coupling:
    - `ActionKind` (`types.ts:191`), `Action` (`:341`) and `Outcome` (`:159`) are closed unions
      of v1 kinds.
    - `ACTION_KINDS` (`config.ts:113`) gates which stored entries survive a load
      (`ledger.ts` `entryOf`) and which `maxAttempts` keys are valid.
    - `classOf` (`ledger.ts:200`) hardcodes classes for extra entries.
  - The cut: a v2 kind must be added in all three places or it is dropped silently on reload. The
    per-issue record (state, branch, slot, PR, approved patch id, step, attempt, round) has no home
    in `State` or the store yet.
- **C3. The ledger knows v1 rules.**
  - The coupling:
    - `finish` folds guard, fast-forward and update-checkout rechecks (`ledger.ts:137-141`,
      `:166`).
    - `finish` marks A1-stopped agents by the `stop:` key prefix and rule `A1` (`:142-146`).
    - `retryIssue` and `maxAttemptsOf` special-case `env-retry` and `update-behind`
      (`:340-383`), duplicating `plan.ts:263-268`.
  - The cut: make these data the layer supplies, or delete them with the kinds.
- **C4. The event codec and rebuild speak v1.**
  - The coupling:
    - `EVENTS_SQL` lists the pipeline states (`derive.ts:38-50`).
    - `outcomeTokens`/`outcomeOf` serialize v1 `Outcome` kinds into `loop` notes (`:400-540`).
    - `deriveLedger` (`:210`) rebuilds v1 key families from CLI events.
  - The cut: v2 needs its own rebuild of the per-issue record from its state events. That is
    also what the reconcile of OWNER-BRIEF decision 2 reads.
- **C5. Observe reads sources v2 drops, and ledger keys.**
  - The coupling:
    - `pipeline-watch.sh` (`observe.ts:208`) and the `runSource` option.
    - The slot reflog inference (`:418-472`).
    - The `task:run-it:` key prefix in the GitHub read set (`:341`).
    - `RunView` and `Slot.leaseBranch` in `State`.
- **C6. `Stage` from `callum-flow-factory-state` stands in for issue state.**
  - The coupling: `LIVE`/`ENDED` (`plan.ts:53-54`), the in-flight cap (`claims`, `plan.ts:2135`),
    the title counts (`titleOf`), the decision log `counts` (`register.ts:983-989`) and the trace
    wait rows (`trace.ts:289-326`).
  - The cut: v2's explicit state and labels replace stages. Until the factory-state view reads the
    new state events, the two can disagree (OWNER-BRIEF decision 2).
- **C7. Agent-liveness inference spans foundation files.**
  - The coupling:
    - `reconcilable` and `REPAIR_GRACE_MS` (`act.ts:357-394`).
    - `answeredBeforeLost` (`act.ts:422`).
    - The `between` maps (`register.ts:177`).
    - `stillAtWork` and `interim` (`act-agents.ts:326-337`).
    - `answeredLive` and `heldBy` (`plan.ts:363-380`).
  - The cut: keep the basic `reconcileAgents` (`ledger.ts:224`). Replace the rest with "an answer
    ends the step; the loop stops the agent and kills slot processes" (verdict, change 4).
- **C8. Update drain and self-restart.**
  - The coupling: `updateDone` (`act.ts:396`) depends on the `restart:<at>` key.
    `restartWhenDrained` and `drainBlockers` (`plan.ts:625-652`) wait on pipeline runs. The drain
    filter is in `admit`.
  - The cut: C3 makes restart drain-free.
- **C9. Wake vocabulary is spread over four places.**
  - The coupling: `WAKE_DECISIONS` (`wake.ts:133`), `wakeDetails` (`:76`), `OWNER_TELLS`
    (`plan.ts:58`), and the judge skill with its coverage test
    (`tests/factory-loop-judge-skill.test.js`).
  - The cut: v2's wake changes (the judge and task kinds but `task release` go; triage is an
    agent, not a wake) must change all four together. Owner notices from v2 (parked, breaker,
    stalled, checkout, workspace; SPEC appendix D) must join `OWNER_TELLS` to rank first.
- **C10. The safety nets ban v2's writes.**
  - The coupling: `tests/factory-loop-safety.test.js:163-169` and `tests/safety.test.ts:280-300`
    forbid:
    - `gh pr edit` and `gh pr merge`;
    - adding a label;
    - a `--body` outside a PR comment;
    - killing a process by name;
    - any git write but a fast-forward in a script.
  - The cut: v2 writes `factory:*` labels (decision 1), opens PRs with its own body (decision 5),
    runs `gh pr update-branch` (decision 4) and kills slot processes (verdict, change 4). Widen
    the allowlists deliberately, one argv each, and keep the rest of the bans.
- **C11. Agent definitions and prompts assume no-mistakes and the main checkout.**
  - The coupling:
    - `CHECKOUT_RULE` and `COMMAND_RULE`'s `axi run` exception (`prompts.ts:143-149`).
    - The handoff contract's `run=`, `gated=` and `newBranch` (`contract.mjs:28`, `:310`).
    - `declinedFindings` (`:228`).
    - The hidden-type `agent.offer` hooks for `adjudicator` and `designer` only
      (`register.ts:1591-1597`).
    - `SUBAGENT_OF` (`act-agents.ts:102`).
  - The cut: new types (designer-v2, builder, fixer, reviewer, triage) need their own entries, and
    a v2 `COMMAND_RULE` without the no-mistakes exception (SPEC 10.5). The agent's folder is set by
    the companion plugin, not by a spawn argument (SPIKES.md; SPEC 10.3).
- **C12. Control meanings bound to v1.**
  - The coupling: `resume <run id>` names no-mistakes runs (`control.ts:92-104`). `retry` clears
    v1 exhaustion (`ledger.ts:340`). `update` starts the drain.
  - The cut: v2's `resume N "note"` and unpark on label removal need op and plan support. The
    observe-first reconcile of OWNER-BRIEF decision 2 is a one-shot tool outside the plan
    (SPEC 6.3).
