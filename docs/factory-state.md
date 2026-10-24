# Factory state

`callum-flow-factory-state` (in the base image, read-only) answers "what is the factory doing right
now?" in one deterministic report, so no reader has to write its own SQL against raw tables. Read
naively those tables are wrong: on 2026-10-10 half the issues that looked in progress were closed on
GitHub. The database decides each issue's state: the tool reads the
[`factory.issue_state_at` view](#the-issue_state-view) of the factory database through
`dev-query --factory` and adds the GitHub cross-check, the stuck flags and the queue. This page is the
contract; `tests/factory-state.test.js` runs the tool against the fixtures in
`tests/fixtures/factory-state/` loaded into a throwaway database (each `<name>.input.json` is the event
rows, with the reviewed `<name>.expected.json` beside it). The `factory-state` skill runs the tool and
adds a short narrative.

## Usage

```
callum-flow-factory-state [--repo <owner/name>]... [--at <ISO time>] [--format text|json]
                          [--rule <state>=<minutes>]... [--github on|off] [--source new]
```

`--repo` is matched case-insensitively, and the report's `repos[].repo` is always lower case.

Exit 0 ok, 2 bad arguments, 1 when the factory database cannot be read or has no
`factory.issue_state_at` (a database behind migration 0033: the tool prints one line naming it and
`factory-db-bootstrap --migrate`). Nothing is read but the factory database and GitHub. A missing GitHub
shows as `n/a` with the reason.

`--source` is retired: the old store is gone. `--source new`, `--source=new` and
`CALLUM_FLOW_FACTORY_STATE_SOURCE=new` are accepted silently. The two other names of the former switch
(`old` and the comparison mode) print one line on stderr saying the old store is retired and the view is read, then
read the view and exit 0, so a caller written against the switch keeps working; no comparison record is
written. Any other value is a usage error. See [replay.md](factory-events/replay.md#source-switch).

## States

An issue is in exactly one state, the view's `state`, and shows as one stage. `stuck` is a flag on a
state, not a state.

| State | Stage | Meaning |
| --- | --- | --- |
| `queued` | `queued` | waiting for a claim: a `ready` or `requeued` event, or a lease-step transition |
| `designing` | `designing` | claimed, being designed |
| `building` | `implementing` | the implementer is working |
| `reviewing`, `fixing` | `in pipeline` | the gates are running, or a fix after a finding |
| `merge-queue` | `ready to merge` | approved, waiting for the merge |
| `parked` | `parked` | waiting on the owner's answer (`question` is set) |
| `waiting` | `waiting` | the factory loop holds the claim and re-checks the wait conditions each pass, with no slot |
| `closed` | `merged` or `closed without merge` | `merged` when `why` is `merged`, `merged-by-hand` or `done`, else `closed without merge` |

The stage is the compatibility field older readers parse (`parse.ts` of the factory loop, the HUD, the
reconcile); new readers use `state`. Stage order is the sort order of the output.

A closed issue is final: it shows under "recently ended" for the 24 hours after it closed (the view's
window), as `merged` or `closed without merge`.

## Lives

An issue's record is the newest `transition` event of its newest life (`life` is the claim's start time as a
base-36 token). `v2` is `{ state, step, attempt, life, seq, why }` when a transition decides, and null for a row
with no deciding transition: an issue that is only `ready`, `requeued` or `claimed`, so a reader can tell
a claim the loop has not recorded yet (the reconcile's orphan check relies on it). `life`, `step`, `attempt`
and `why` are top-level fields of every issue too. The full rules are under
[The issue_state view](#the-issue_state-view).

### The issue_state view

`factory.issue_state` is the database's own reading of the factory loop v2's state (migration
`0033_issue_state.sql`, cbundy/dev-system#1292). It is `factory.issue_state_at(now())`; the function
`factory.issue_state_at(at timestamptz)` is the same read as of an instant. Both are plain SQL
over `factory.event_log` (the function is `STABLE`, not `SECURITY DEFINER`), so the reader role
selects from the view and runs the function, and the panel role reaches neither. It returns one row
per (repo, issue) that is live at `at`, or whose life ended in the 24 hours before it. It reads only
event types at the version it understands (all version 1 today): a row of a newer version is left
out, not misread.

| Column | Meaning |
| --- | --- |
| `repo`, `issue` | the repo (lower case) and the issue number |
| `state` | a v2 state: `queued`, `designing`, `building`, `reviewing`, `fixing`, `merge-queue`, `parked`, `waiting` or `closed` |
| `step`, `attempt`, `life`, `seq` | the deciding transition's record; null when no transition decides (a released issue) |
| `state_since` | when the issue entered the state (the transition's `state_since`, else its time; the releasing event's time for a released issue; the end for a closed one) |
| `branch`, `pr` | the life's branch and pull request |
| `why` | closed rows only: the closing transition's `why`, or `merged` for a `merged` event |
| `question`, `decision`, `context`, `options`, `recommended`, `recommendation` | parked rows only: the owner's question and its structured form |
| `holder`, `claimed_at` | the device and the time of the newest `claimed` event |
| `lease_until`, `lease_lapsed` | the newest `claimed` or `claim_renewed` plus its `lease_minutes` (120 when absent or not positive); whether that time has passed |
| `ended` | the life ended (`merged`, `closed` or `abandoned` event, or a `closed` transition) with no new life since |
| `stuck_minutes`, `stuck` | the state's rule below; whether `state_since` is older than it. `stuck` is false for an ended row and for a state with no rule |

The life rules, which the database applies (the tool reads them and derives nothing):

- The newest `transition` of the newest life decides. Lives order by their start time (the `life`
  token decoded as base 36; a token that does not decode sorts lowest); within a life, by `seq_at`,
  then `seq`. A `closed` transition with `why` `claim-lost` is another device's and is ignored.
- A `requeued`, `ready` or `claimed` event newer than that transition releases the issue. It is
  `queued` when the newest of those is a `ready` or `requeued` with no claim since, and `designing`
  when it is a `claimed` with no transition yet (a life with a claim and no transition is
  `designing` too).
- `merged`, `closed` and `abandoned` events end the life, and so does a `closed` transition, until a
  `ready`, `requeued` or `claimed` event follows (a new life).
- A lapsed lease with no release keeps the loop's state: the loop claims the issue again.
  Only `lease_lapsed` shows the lapse.

`factory.stuck_rules (state, minutes)` holds the thresholds. It is a view over `VALUES`, so only the
owner role can change it (a migration replaces it); a table would give the writer INSERT and UPDATE.
The defaults:

| State | Minutes |
| --- | --- |
| `designing` | 240 |
| `building` | 60 |
| `parked` | 30 |
| `merge-queue` | 30 |
| `queued`, `reviewing`, `fixing`, `waiting` | none (`NULL`) |

The saved "Stuck issues" query is in [metrics.md](metrics.md#stuck-issues).

## Holder and lease

`holder` is the device of the newest `claimed` event. `lease` is `{ until, lapsed }`: the newest `claimed` or
`claim_renewed` event plus its `lease_minutes` (120 when absent), and whether that time is at or before `--at`;
null when the issue has no claim.

A lapsed lease with a recorded state keeps the loop's state: the loop claims the issue again. A claim with
no transition (`life` null) that is `designing` and lapsed shows as stage `queued` with the detail
`claim lapsed at <ISO time>`; its `state` stays `designing`, as the view says.

## `--at`

`--at` defaults to the database's `now()`, resolved once and printed with its source. The view function,
the event counts, the skipped events and the queue are all bounded by `ts <= at`. The same rows, `--at`
and GitHub answers give byte-identical output, with a fixed sort order (repo, stage order, issue number).

## Stuck rules

The thresholds are those of `factory.stuck_rules` (see [The issue_state view](#the-issue_state-view)).
Without `--rule`, an issue's `stuck` is `{ rule: <state>, minutes: <threshold> }` exactly when the view's
`stuck` is true, else null. `--rule <state>=<minutes>` (an integer of at least 1, for a state the view
lists) makes the tool apply that threshold to the state: stuck when `state_since` is older than it. `S1`,
`S2`, `S3` and `S4` are accepted as aliases for `designing`, `building`, `parked` and `merge-queue`; any
other name is a usage error (exit 2).
The top-level `rules` echoes `{ <state>: minutes | null }` with the overrides applied, and `stuck` lists
`{ repo, issue, state, stage, rule, minutes_in_state }` for every live stuck issue. `waiting` has no rule
of its own: the loop tells the owner after 24 h.

## Output

Per repo, each live issue (`issues`, view `ended = false`) and each recently ended one (`recent`):

- the view's record: `state`, `step`, `attempt`, `life`, `why`, `state_since`, `question` (set only when
  parked), `lease`, `holder`, `pr`, `v2`;
- the compatibility fields: `stage`, `detail` (`v2 <state>[, step S][, attempt N]`, `v2 closed (<why>)`, the
  lapse text above or `GitHub label only, no events`), `entered_at` (= `state_since`), `minutes_in_stage`,
  `run` (always null), `stuck`, `source` (`event`, or `github` for what GitHub decided), `flags`, `github`.

Also per repo: `coverage` (`events`, `last_event_at`, each device's events and last event, the live issues by
source, notes) and `queue`. Across repos: the `stuck` list, the `rules`, `github` and `skipped_events`.

### Queue

`queue` is the factory loop's claim queue as of the repo's newest `queue_snapshot` event at or before
`--at`: `{ taken_at, age_minutes, reason, considered, free_slots, owner, top, rest }`.

- `taken_at` is when the claim pass that made the view ended, and `age_minutes` the minutes from it to
  `--at` (a heartbeat is written when the view does not change, so an old snapshot means the loop has
  not looked since, not that the queue is stable). `reason` is `changed` or `heartbeat`.
- `top` is the snapshot's first 10 candidates in its order: `{ issue, rank, score, claimable, why }`
  (`why` is null exactly when the claim rule would take the issue; the score factors are left out).
  `considered` is the number of candidates the rule looked at and `rest` the snapshot's own count of
  those past the first 50, by `why`.
- `free_slots` is the claims left under the in-flight cap (null: unset). `owner` is the owner's
  controls in force: `priority` and `only` (issue lists, empty when off), `serial` (one at a time)
  and `new_off` (no new work).

`queue` is `{ "n/a": <reason> }` when there is nothing to show, never an empty queue: `not read`
(the pure derivation was given no queue), `factory.event_log has no queue_snapshot columns (the factory
database predates migration 0023)`, `cannot read the queue snapshot: <error>` (the read failed; the
tool still exits 0, as for the workers) and `no queue_snapshot for this repo at or before --at`. Only
repos already listed (from `--repo`, the view or the event counts) get a `queue`.

Text output adds, under each repo's `==` block after its notes, `queue (snapshot <age> old, <reason>):
#N score S, #M score T (blocked), ..., +K more` (`score -` when unscored, the `why` in parentheses
when set, `+K more` when `considered` is above the entries shown, `empty` for no candidates), then
`queue controls: free slots <n|unset>, priority <#a #b|none>, only <#a #b|none>, one at a time
<on|off>, no new work <on|off>`; without a snapshot the line is `queue: n/a: <reason>`.

## GitHub flags

GitHub is read live (through `callum-flow-issue-read`: open or closed, labels, the claim comment), so for a
past `--at` its facts are not as of that time; the output says so. `--github off` gives a database-only view.

- A closed issue is final: stage `merged` or `closed without merge`, `source` `github`, detail
  `closed on GitHub (<reason>)`.
- Flags are disagreements between sources and never change the stage: for an issue with a deciding
  transition, a missing `factory:<state>` label or any other `factory:*` label (but `factory:rejected` on a
  closed one: the loop rejected the issue at its last life, v2 SPEC 6.4, and that label is not a state);
  for any other issue, a `queued` one without `ready`; a GitHub claim comment held by another device than
  the events say; a GitHub state that could not be read. No label marks a claim: `In development` is gone
  (v2 SPEC 3.6).
- An open issue at `ready to merge` that carries the issue label `don't-merge` (any case) shows the flag
  `held: don't-merge (waits on the owner)`, and its stuck flag is cleared: the owner holds it, not the
  factory. The tool reads issue labels only, so a `don't-merge` label on the PR alone is not seen here.
- An open issue labelled `factory:<state>` or `ready` that the database has never seen is listed with
  source `github`, its stage from the `factory:*` label (as in the table above), else `queued`, so a
  missing event never hides work. `factory:rejected` names no state.
- Unreadable or untrusted-author issues add a note to the repo's coverage.

## Skipped events

A `factory.event_log` row whose type and version `factory-event-shapes.json` does not list as current (a
newer writer's event) is not read. The top-level `skipped_events` lists `{ type, type_version, count, derived }`
sorted by type then version (`[]` when nothing was skipped), and the text format adds a line such as
`skipped events: claimed v2 x1 (derived), mystery v1 x1`. `derived` is true when the type is one the view
reads (`transition`, `claimed`, `claim_renewed`, `requeued`, `ready`, `merged`, `closed` or `abandoned`):
the state may then be stale until the view reads the newer version. A test keeps the tool's list equal to
the view's.

## Worked examples

One per fixture; the exact output is the fixture's `.expected.json`. Times are minutes before
`--at` = 2026-10-10T12:00Z unless said.

- `lapsed-claim` (`--at` = 2026-10-12T07:00Z): #1 was claimed 7 hours ago with no renewal, #5 has a
  `lease: 30` and was claimed 40 minutes ago, #7 and #8 were claimed with a lease of 120 minutes before:
  all are claim-only and lapsed, so `queued` with `claim lapsed at ...` and no `v2`. #2 is freshly claimed,
  and #3 and #4 were renewed within the lease: `designing`. #6 was `closed` and a `claim_renewed` after it
  changes nothing: it is recently ended.
- `parked`: #50 has waited 170 minutes (the `parked` rule trips), #51 20 minutes; each carries its `question`.
- `github`: #80 is closed on GitHub, so it is `closed without merge` with source `github`. #82 is `queued`
  but has no `ready` label, #84 is `designing` with no label and no flag (no label marks a claim), #81's
  claim comment names another device, #86's GitHub state could not be read, #83 is `merged` (recently
  ended), #90 (`ready`) and #91 (`factory:building`, so `implementing`) carry a label and are unknown to
  the database.
- `v2`: the factory loop's issues. #100 is `building` (so `implementing`), #101 is `parked` for an hour (the
  rule trips), #102 is `reviewing` but still labelled `factory:building` (flagged), #103 closed as merged
  (`merged`), #104 was dropped (`closed without merge`), #105 was dropped and then `ready` again (`queued`, a
  new life), #106's record closed as `claim-lost` while another device holds it (`designing`, held by `dev-b`),
  #107 is `queued` and #109 `designing`, #111 was requeued, #112 was claimed by a second device whose newer
  life decides (`building`, stuck), and #108 is labelled `factory:fixing` with no events (`in pipeline` from
  GitHub).
- `queue`: `acme/widgets` has two snapshots, an older `changed` one with 12 candidates and a newer
  `heartbeat` 5 minutes before `--at`, which is shown: the first 10 of its 14 considered candidates (one
  unscored, most blocked), free slots 1, priority `#300 #301`, no new work on. `acme/gadgets` has events and
  no snapshot, so its `queue` is n/a.
- `v2-waiting`: the `waiting` state. #200 is `waiting` for 30 hours with no stuck rule, #201 is `waiting`
  but labelled `factory:parked` (flagged), #202 is `parked` and #203 `queued` (they sort before the waiting
  ones), #204 is labelled `factory:waiting` with no events (`waiting` from GitHub) and #205 is `waiting`
  while another device's claim comment holds it (flagged).
