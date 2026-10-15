# Factory events

The factory event log is the factory's shared record of what happened: every claim, delegation,
pipeline transition, merge and loop action, from every device, in one table. This page is the
contract for it. It is written for two readers:

- **Implementers** adding, changing or retiring an event: read [Designing an event](#designing-an-event)
  and follow the [checklist](#checklist).
- **Consumers** reading the data (queries, `callum-flow-factory-state`, `callum-flow-evaluate`,
  the factory loop, dashboards): read [Reading events](#reading-events) and the
  [event catalogue](#event-catalogue).

The machine-readable half of the contract is the JSON Schemas in
[`schemas/events/`](../schemas/events/). `npm test` (`tests/events-schema.test.js`) holds the two
halves and the writer together: a state the writer knows without a schema, an example and a
catalogue row here fails the build.

## How events flow

```
caller ──> callum-flow-event <state> [--issue N] [--run ID] ... [--note TEXT]
              │  one JSON line, O_APPEND, no network, never fails its caller
              v
           /persist/events/<owner>__<repo>.jsonl     (per device, append-only)
              │  event-push-loop, within seconds (.wake), retried while the database is down
              v
           factory.events                            (central PostgreSQL, one row per line)
              columns: the envelope fields;  raw (jsonb): the whole line, unchanged
```

- **Writer.** [`callum-flow-event`](../images/base/callum-flow-event) in the base image is the only
  way to write an event. It checks the state against its closed vocabulary (its `STATES=` line),
  checks the few per-state rules it knows, fills in the envelope (time, device, session, versions,
  `event_id`) and appends one line. A failed write is a warning on stderr and exit 0: logging never
  fails the work it records. A usage error (unknown state, a missing required argument) is exit 2
  and writes nothing.
- **Log.** One JSONL file per repo per device under `/persist/events/`. Files are append-only: never
  edit or truncate one.
- **Shipping.** [`event-push-loop`](../images/base/event-push-loop) inserts each new line into
  `factory.events`, with the envelope fields as columns and the whole line in `raw`. Rows are unique
  on `event_id`, so a repeated push inserts nothing twice. Each insert notifies the
  `factory_events` channel (`LISTEN factory_events`).
- **Schema.** Nothing on the write or ship path validates against the JSON Schemas yet. They are
  enforced by tests: the saved examples, and the real writer run with every example's arguments.

## The envelope

Every line has the same top-level keys, defined by
[`envelope.v2.schema.json`](../schemas/events/envelope.v2.schema.json). The writer emits every key on
every line; a value it does not have is `null`, never an empty string and never a missing key.

| Field | Set by | Meaning |
| --- | --- | --- |
| `v` | writer | Envelope version, `2`. |
| `ts` | writer | UTC time of the write, to the second (`2026-10-15T09:00:00Z`). |
| `repo` | `--repo`, else `CALLUM_FLOW_REPO`, else the origin remote | `owner/name`. |
| `device` | writer | `DEV_MACHINE_NAME`, else the hostname. |
| `session_id` | writer | The Claude session that wrote it, when known. |
| `actor` | `--actor`, else `CALLUM_FLOW_ACTOR`, else `agent` | Who wrote it (see [Actors](#actors)). |
| `state` | caller (first argument) | What happened: one word of the closed vocabulary. |
| `issue` | `--issue`, else the `issue-<N>` in `--branch` | The GitHub issue. |
| `run_id` | `--run` | The no-mistakes pipeline run. |
| `branch` | `--branch` | The git branch. |
| `pr` | `--pr` | The pull request number. |
| `head` | `--head` | A commit sha; each state says whose. |
| `note` | `--note` | A short line for people. Some older states put machine-read fields here (see [Legacy notes](#legacy-notes)). |
| `event_id` | writer | A UUID made locally, unique per event. |
| `base_image`, `dev_image`, `template_version`, `plugin_version` | writer | The versions that wrote the event, from `dev-init`'s snapshot; null when unknown. |
| `data` | `--data` (planned, [#534](https://github.com/cbundy/dev-system/issues/534)) | The event's structured payload (see [Payloads](#payloads)). Absent on every event written today. |

The subject columns (`issue`, `run_id`, `branch`, `pr`, `head`) are shared by every state so that
any reader can join and filter events without knowing the state. Use them for what they name, and
nothing else.

**Older lines.** From 2026-10-08 (#230) to 2026-10-11 (#316) the writer produced `v: 1` lines: the
same keys without the four version fields (and, before 2026-10-10, without `event_id`). They are
still in `factory.events`, and [`envelope.v1.schema.json`](../schemas/events/envelope.v1.schema.json)
describes them; `event.schema.json` picks the envelope by `v`. Readers must accept both.

## Designing an event

### Do you need a new state?

A state is a kind of thing that happened, named in the past tense or as a condition (`claimed`,
`merged`, `ci_stalled`). Add one when readers need to tell this happening apart from everything
else, for example to count it, to give it a stage, or to react to it. Do not add one per variant:
the variants of one happening are one state with a field that tells them apart (`closed` carries
GitHub's close reason; `loop` carries its kind).

A state, once shipped, never changes meaning. If what it records has to mean something different,
that is a new state and the old one is retired (see [Retiring a state](#retiring-a-state)).

### Where each fact goes

1. **The subject columns** for the issue, run, branch, PR and head the event is about. Required ones
   are required by the state's schema.
2. **`data`** for every other fact a program will read: counts, enumerated outcomes, reasons as
   codes, durations, ids. One JSON object, with its own versioned schema (see [Payloads](#payloads)).
3. **`note`** for a person reading a row: a few words, not parsed. A reader that needs a fact from
   the note is a sign the fact belongs in `data` (until `--data` ships, see the bridge below).

Never add a top-level key: the envelope is closed (`additionalProperties: false`), and a new key is a
new envelope version that every reader must learn. Put it in the payload.

### Payloads

A payload is a JSON object in `data` that names its own schema and version:

```json
{"schema": "claim", "version": 1, "leaseMinutes": 120}
```

- `schema` names the payload, lower case with dots or dashes (`claim`, `loop.agent`). Its schema
  files live in `schemas/events/data/<schema>/`, one per version: `v1.schema.json`,
  `v2.schema.json`, and so on. Each pins its own `schema` and `version` with `const`.
- A state's schema lists the payloads it accepts in its `data` property (`false` for none). A state
  usually has one payload; a state whose variants carry different fields (`loop`) may accept several,
  one per variant.
- Payload fields are camelCase, times are ISO 8601 UTC strings, durations are milliseconds and name
  their unit (`durationMs`), and an absent value is `null` rather than a missing key, so a query
  never has to tell the two apart. Arrays and nested objects are fine; keep the whole line well under
  4 KiB.
- Free text a person wrote (a reason, an instruction) may go in a payload field when a reader needs
  it, but never anything secret or anything taken from untrusted issue or PR text.

**The bridge until `--data` ships.** `callum-flow-event` does not take `--data` yet: it is the next
step of [#534](https://github.com/cbundy/dev-system/issues/534) and reaches the fleet in a base image
release. Until then, a new event with fields a program reads:

1. designs its payload anyway: `schemas/events/data/<schema>/v1.schema.json` and its example, in the
   same change as the event (the example's line carries `data`; the writer test skips it until the
   writer takes `--data`);
2. writes the same fields into the note as space-separated `key=value` pairs, using the payload's
   camelCase field names and `null` for an absent value, so the move to `data` is mechanical;
3. gives its state schema a `note` `pattern` for that format and a row under
   [Legacy notes](#legacy-notes), like the other structured notes today.

Readers then read `data` when present and fall back to the note.

### Versioning

There are two kinds of version, and they move independently.

| What | Where | Changes when |
| --- | --- | --- |
| Envelope | `v` on every line; `envelope.v<N>.schema.json` | A top-level key is added, removed or changes meaning. Rare, and a project of its own: every reader changes. |
| Payload | `data.version`; `data/<schema>/v<N>.schema.json` | The payload changes in a way an existing reader could misread. |

A payload change is **compatible** (same version, edit the schema in place) only when every line
already written still validates and every existing reader still understands every new line:

- adding an optional field that readers may ignore;
- adding a value to an enumeration whose readers are documented to treat unknown values as "other"
  (say so in the field's description when you rely on this);
- loosening a constraint (a longer maximum, a field that may now be null).

Anything else is a **new version**: renaming or removing a field, changing a field's type, unit or
meaning, making a field required, adding a value to a closed enumeration, or tightening a
constraint. For a new version:

1. Add `data/<schema>/v<N+1>.schema.json`. Never edit or delete an older version's file: lines written
   with it stay in the log forever, and its examples must keep validating.
2. Add it to the state schema's `data` (keep the old versions there too).
3. Teach every reader the new version before or with the writer change. A reader refuses a version it
   does not know, by name (`unknown claim payload version 3`), rather than guessing.
4. Add an example of the new version, and keep the old ones.

The tests enforce the mechanical part: versions run from `v1` with none missing, each is accepted
by a state, and each has an example.

### Retiring a state

Remove it from the writer's `STATES=` line and from its callers. Keep its schema, examples and
catalogue row: its rows stay in `factory.events`, and readers of history still need to understand
them. Mark the schema `"deprecated": true` (the standard JSON Schema annotation) and start its
`description` and its catalogue meaning with **Retired** and the date and change that retired it.
The test then expects the writer not to know it, and still validates its examples.

### Checklist

For a new state:

- [ ] Add it to `STATES=` and to the States list in the header comment of
      `images/base/callum-flow-event`, with any rule the writer must enforce (a required `--issue`
      or `--run`; the test checks the schema requires exactly what the writer enforces).
- [ ] `schemas/events/states/<state>.schema.json`: pin `state`, narrow the envelope fields it
      constrains (a required subject column as non-null, a legacy note's `pattern`), and set `data`
      (a payload `$ref`, or `false`). It names no other key: facts of its own go in the payload.
- [ ] The payload's `schemas/events/data/<schema>/v1.schema.json`, if it has one.
- [ ] Add the state to `schemas/events/event.schema.json` (`enum` and an `if`/`then` branch).
- [ ] `schemas/events/examples/<state>.jsonl`: one realistic line per variant.
- [ ] A row in the [event catalogue](#event-catalogue) below.
- [ ] Where readers must treat it specially (stages, progress, coverage), the reader docs:
      [`factory-state.md`](factory-state.md), [`metrics.md`](metrics.md).
- [ ] `npm test`.

For a changed payload: the [versioning](#versioning) steps, the example, and the catalogue row if
the meaning changed.

## Reading events

- **Validate** a line with [`event.schema.json`](../schemas/events/event.schema.json): it applies the
  envelope of the line's `v` and then the rules of its state. A state schema on its own holds only
  that state's rules, not the envelope. Use a draft 2020-12 validator with ECMA-262 regular
  expressions (the `loop` note pattern uses lookaheads, which RE2-based validators lack); the
  repo's tests use Ajv.
- **Columns first.** Filter on `state`, `repo`, `issue`, `ts` and the subject columns, which are
  typed; `(repo, issue, ts)` is indexed.
- **Payload fields** are in `raw`: `raw->'data'->>'leaseMinutes'`, and dispatch on
  `raw->'data'->>'schema'` and `(raw->'data'->>'version')::int`. Refuse a version you do not know.
- **Notes** are for people. Where a state still keeps a machine-read field in its note, its schema
  gives the exact format (a `pattern`) and the catalogue says so; read it with the same pattern, and
  prefer `data` once the state has a payload.
- **Duplicates.** A row is unique on `event_id`, or on `(device, repo, seq)` for early rows without
  one. Some happenings can be logged more than once (`closed` by two devices, `implementer_routed`
  per delegate attempt, `untrusted_stripped` per read); count identical consecutive rows once there.
- **Housekeeping.** `loop`, `renewed`, `usage`, `watcher_error`, `untrusted_stripped`,
  `test_weakened`, `claim_lost` and `superseded` never set a stage or start a new life. Whether one
  counts as progress or as a device being alive differs by reader: see
  [`factory-state.md`](factory-state.md) and [`metrics.md`](metrics.md).

```sql
-- every claim in the last day, with its lease
select ts, repo, issue, device, substring(note from '^lease: ([0-9]+)$')::int as lease_minutes
from factory.events
where state = 'claimed' and ts > now() - interval '1 day'
order by ts;
```

## Actors

`actor` says which part of the factory wrote the event. It is free text in the envelope; the values
in use are:

| Actor | Written by |
| --- | --- |
| `agent` | The default: the factory loop (its own events and `loop`), the orchestrator and implementer skills, `callum-flow-claim`, `callum-flow-merge`, `callum-flow-regate`, `callum-flow-issue-read`, the routes, and `callum-flow-sweep`'s `reclaimed`. |
| `watcher` | `queue-watch.sh` (`ready`, `watcher_error`), `pipeline-watch.sh` (the pipeline states, `watcher_error`) and `usage-check.sh` (`usage`). |
| `sweep` | `callum-flow-sweep`'s `closed`. The factory loop reads a `sweep` event as proof a sweep ran. |
| `orchestrator`, `adjudicator` | No current writer. Older rows and test fixtures carry them, and metrics 5 still pairs `adjudicator` verdicts against others. |

Nothing in the repo sets `CALLUM_FLOW_ACTOR`. A new writer that is not an agent acting by hand
should pass `--actor` with a name of its own and add it here.

## Legacy notes

Some states predate payloads and carry machine-read fields in the note. Each moves into a payload in
a later step of [#534](https://github.com/cbundy/dev-system/issues/534), one state at a time. Until
then their formats are frozen: change one only together with every reader listed here. Where every
writer is code, the state schema pins the format with a `pattern`; where agents logged lines by hand
(`delegated`, `verdict`, `fix_requested`), older rows vary, so the schema describes the format
without enforcing it.

| State | Carries | Parsed by | Pattern in schema |
| --- | --- | --- | --- |
| [`claimed`](../schemas/events/states/claimed.schema.json) | the claim's lease in minutes; null on lines before the lease was recorded (readers then use 120) | `callum-flow-factory-state` (`/lease: *(\d+)/`) | yes |
| [`delegated`](../schemas/events/states/delegated.schema.json) | `brief <issue comment URL>` from the factory loop; a hand-logged line may have no note or other text. Readers take the first `https://github.com/.../issues/<n>#issuecomment-<id>` anywhere in the note | factory loop `derive.ts` (`factsOf`, `deriveLedger`) | no (described only) |
| [`verdict`](../schemas/events/states/verdict.schema.json) | `<VERDICT>: <finding id> <reason>` or `<VERDICT>: <finding id>: <reason>` with VERDICT one of CORRECT, WRONG, NIT, ENV, DUP (agents logged older lines by hand, so not every row follows it, and some have none). Readers take the word before the first colon as the verdict and the next word as the finding id | metrics 3 and 5, `callum-flow-evaluate`, the factory loop (`/^ENV:/`) | no (described only) |
| [`fix_requested`](../schemas/events/states/fix_requested.schema.json) | `review` when the fix answers the review gate; otherwise null or, on older hand-logged lines, other text | the factory loop (`note === 'review'`) | no (described only) |
| [`failed`](../schemas/events/states/failed.schema.json) | `cancelled` for a cancelled run, null for a failed one | the factory loop (`runState`) | yes |
| [`head_mismatch`](../schemas/events/states/head_mismatch.schema.json) | the three heads compared (`worktree=` only when the branch is checked out) | the factory loop (shown as the run's detail) | yes |
| [`ci_stalled`](../schemas/events/states/ci_stalled.schema.json) | `reason=no-workflow` (the repo has no workflows) or `reason=no-checks` (none ran) | the factory loop (`plan.ts`, rules P6, P6a) | yes |
| [`closed`](../schemas/events/states/closed.schema.json) | GitHub's close reason as GitHub gives it (`completed`, `not_planned`, `duplicate`); null when GitHub gives none | `callum-flow-factory-state` (detail), metrics queries | yes |
| [`design_routed`](../schemas/events/states/design_routed.schema.json) | the route, why, the hash bucket (`-` unless `reason=hash`) and the session percentage | no reader parses it yet | yes |
| [`implementer_routed`](../schemas/events/states/implementer_routed.schema.json) | the model alias, why, the hash bucket (`-` unless `reason=hash`) and the Opus percentage | metrics 8 (`model=([^ ]+)`, `reason=hash`) | yes |
| [`test_weakened`](../schemas/events/states/test_weakened.schema.json) | the pipeline step, the flagged commit, whether it was restored, what kinds of weakening and which test files (last, unescaped) | `callum-flow-evaluate`, metrics 5b | yes |
| [`usage`](../schemas/events/states/usage.schema.json) | the usage percentages (whole, rounded up), reset times and seconds to them, and the source; or `usage=unavailable reason=<r>[,<r>...]` | `scripts/factory-loop-replay.js` (`parse.ts` `parseUsage`) | yes |
| [`renewed`](../schemas/events/states/renewed.schema.json) | the renewed lease in minutes, as written in the claim comment | `callum-flow-factory-state` | yes |
| [`loop`](../schemas/events/states/loop.schema.json) | `kind=<kind> key=<key> status=<status>` then more `key=value` tokens (attempts, class, rule, started, ended, agent, agentId, wake and the outcome's `out=` tokens), values with `%` and whitespace percent-encoded and `none` for empty, at most 500 characters before the outcome is dropped; full grammar in SPEC 7.4 | the factory loop (`derive.ts` `entryFromLoop`); `callum-flow-event` itself refuses a note without the three keys | yes |

## Event catalogue

One row per state, in the writer's order. The schema link has the exact rules. "Read by" names the
readers; how they build stages, progress and metrics on these states is in
[`factory-state.md`](factory-state.md) and [`metrics.md`](metrics.md). "Fields" lists the subject
columns a state uses beyond the envelope: required ones plain, ones set only sometimes with `?`.

| State | Meaning | Written by | Fields | Read by |
| --- | --- | --- | --- | --- |
| [`ready`](../schemas/events/states/ready.schema.json) | The issue joined the trusted `ready` queue, as the queue watcher saw it. Starts lead time; the issue is `queued`. | `queue-watch.sh` (actor `watcher`), with `--if-changed` on a watcher's first sight | `issue` | factory-state (`queued`, new life), evaluate (releases a claim, ready time), metrics 1, 6, 7 |
| [`claimed`](../schemas/events/states/claimed.schema.json) | This device won the GitHub claim on the issue (the earliest live `claimed-by:` comment). Starts the `designing` stage and a lease. | `callum-flow-claim` | `issue`, note (structured) | factory-state (`designing`, holder, lease lapse), evaluate (claims, double claims), factory loop ledger rebuild, metrics 1, 6, 7 |
| [`briefed`](../schemas/events/states/briefed.schema.json) | The issue's design brief exists. In the vocabulary and read as a `designing` decision, but nothing writes it today. | none today | `issue` | factory-state (`designing`, new life), heartbeat-state, sweep |
| [`delegated`](../schemas/events/states/delegated.schema.json) | The brief was handed to the implementer sub-agent: design ends, implementation starts. | the factory loop (note `brief <url>`); the orchestrator skill (no note) | `issue`, note (structured) | factory-state (`implementing`, new life), evaluate (design and implementation time), factory loop (brief URL, ledger rebuild), metrics 1, 8 |
| [`run_started`](../schemas/events/states/run_started.schema.json) | An agent's optional record that it started a no-mistakes run. Pipeline facts come from the `nomistakes` mirror, never from this event; kept for the old rows' run links. | an implementer agent by hand (`implement-issue` skill, optional) | `issue`, `run_id`?, `branch`?, `head`? | metrics and evaluate (legacy run-to-issue link), factory-state (hint, new life), heartbeat-state |
| [`parked`](../schemas/events/states/parked.schema.json) | A run reached a gate waiting on an agent or the owner (`awaiting_agent` / `awaiting_approval`). The stage itself comes from the mirror. | `pipeline-watch.sh` (actor `watcher`) | `issue`, `run_id`?, `branch`?, `head`? | factory loop (the gate to answer, ledger rebuild), metrics 7 and evaluate (dispatcher-bound span), factory-state (hint) |
| [`verdict`](../schemas/events/states/verdict.schema.json) | One adjudicator verdict on one gate finding: `CORRECT`, `WRONG` (reviewer false positive), `NIT`, `ENV` or `DUP`. | the factory loop, one per verdict line; the orchestrator skill | `issue`, `run_id`?, `branch`?, note (structured) | metrics 3, 5 and evaluate (false positives, agreement), factory loop (review cap, ENV-only escalation, ledger rebuild) |
| [`fix_requested`](../schemas/events/states/fix_requested.schema.json) | The factory asked the pipeline to fix gate findings (`axi respond --action fix`). With note `review` it counts toward the review-fix cap; any one is a first-pass setback. | the factory loop (review fixes only); the orchestrator skill | `issue`, `run_id`?, `branch`?, note (structured) | factory loop (review-fix cap), metrics 2, 7, 8 and evaluate (setback, fix count) |
| [`failed`](../schemas/events/states/failed.schema.json) | The watcher saw the run fail, or be cancelled (note `cancelled`). Run id `unknown` means it failed at launch. Replay-prone: never sets a stage. | `pipeline-watch.sh` (actor `watcher`) | `issue`, `run_id`?, `branch`?, `head`?, note (structured) | metrics 2, 7, 8 and evaluate (setback, span end), factory loop (failed or cancelled run), factory-state (hint) |
| [`merge_ready`](../schemas/events/states/merge_ready.schema.json) | The run passed every step and CI, its head is the branch's head on origin and in the worktree, and GitHub says the PR is mergeable. Only the merge guards remain. | `pipeline-watch.sh` (actor `watcher`) | `issue`, `run_id`?, `branch`?, `head`? | metrics 1, 2, 7, 8 and evaluate (end of the pipeline stage, first green), factory loop (merge-ready run) |
| [`head_mismatch`](../schemas/events/states/head_mismatch.schema.json) | The run would be merge-ready, but its head is not the branch's head on origin or in the worktree, so its green proves nothing. Expected after `rebased_behind`. Replay-prone. | `pipeline-watch.sh` (actor `watcher`) | `issue`, `run_id`?, `branch`?, `head`?, note (structured) | factory loop (runs the merge guard), factory-state (hint) |
| [`conflict`](../schemas/events/states/conflict.schema.json) | The run is green and its head matches, but GitHub reports the PR not mergeable (`CONFLICTING` or `DIRTY`). Replay-prone. | `pipeline-watch.sh` (actor `watcher`) | `issue`, `run_id`?, `branch`?, `head`? | factory loop (spawns a conflict fixer), factory-state (hint) |
| [`ci_stalled`](../schemas/events/states/ci_stalled.schema.json) | The run sits in its CI step with no checks reported past the grace time, and GitHub confirms the PR has none. Replay-prone. | `pipeline-watch.sh` (actor `watcher`) | `issue`, `run_id`?, `branch`?, `head`?, note (structured) | factory loop (tells the owner, or reopens the PR to trigger CI), factory-state (hint) |
| [`merged`](../schemas/events/states/merged.schema.json) | The PR was squash-merged after every merge guard passed. A stage, not final: the issue stays visible until GitHub closes it. Throughput counts this state. | `callum-flow-merge` (run by the factory loop and the orchestrator) | `issue`, `run_id`?, `branch`?, `pr`?, `head`? | factory-state (`merged`), evaluate and metrics 1, 4, 7, 8 (throughput, lead time), factory loop (ledger rebuild of the merge and rollout), heartbeat-state, sweep |
| [`abandoned`](../schemas/events/states/abandoned.schema.json) | Work on the issue stopped: split into new issues, dropped, or a cancelled run dropped. Ends the issue until a new life starts. Replacing a run uses `superseded` instead. | the factory loop (split, judge's drop, `/factory drop`); the orchestrator skill | `issue`, `run_id`?, `branch`? | factory-state (ends the issue, new-life rules), evaluate (releases a claim), heartbeat-state, sweep, metrics 6, 7, 8 |
| [`closed`](../schemas/events/states/closed.schema.json) | The sweep saw GitHub close the issue while its latest lifecycle event was not final (closed outside the factory). Final, releases a claim; throughput still counts only `merged`. | `callum-flow-sweep` (actor `sweep`) | `issue`, note (structured) | factory-state (ends the issue, highest precedence), heartbeat-state, evaluate, sweep; two devices may both log it |
| [`reclaimed`](../schemas/events/states/reclaimed.schema.json) | The sweep found the issue's claim expired and put it back in the queue (`ready` label, claimant unassigned). | `callum-flow-sweep` (actor `agent`, not `sweep`) | `issue` | factory-state (`queued`, new life), evaluate (releases a claim, reclaim count), metrics 6, 7 |
| [`claim_lost`](../schemas/events/states/claim_lost.schema.json) | A claim attempt lost: another device holds a live claim, or this device lost the post-and-reread race. Proof that two devices contended. | `callum-flow-claim` (exit 3) | `issue` | evaluate (lost races per device), heartbeat-state (ends the issue for this device), metrics 6 |
| [`untrusted_stripped`](../schemas/events/states/untrusted_stripped.schema.json) | `callum-flow-issue-read` dropped or refused content by an untrusted author. Records the count, never the content. Housekeeping; written on every such read, so it repeats. | `callum-flow-issue-read`, under whichever tool read (queue-watch, claim, sweep, factory-state, routes, merge-guard, the loop) | `issue`, `pr`? | none read it beyond counting it as activity |
| [`design_routed`](../schemas/events/states/design_routed.schema.json) | `callum-flow-design-route` decided whether the issue is designed in a live session or by the designer sub-agent. Nothing calls the route today, so the event is rare. | `callum-flow-design-route` | `issue`, note (structured) | factory-state (`designing`, new life) |
| [`implementer_routed`](../schemas/events/states/implementer_routed.schema.json) | `callum-flow-implementer-route` picked the implementer's model (Sonnet or Opus, or a label's alias) for the model comparison. Logged again on every delegate attempt. | `callum-flow-implementer-route` (run by the factory loop and the orchestrator before `delegated`) | `issue`, note (structured) | factory-state (`implementing`, new life), metrics 8 (the model) |
| [`test_weakened`](../schemas/events/states/test_weakened.schema.json) | One commit of a merged PR deleted or weakened tests (removed assertions, `\|\| true`, skips and the like), as `callum-flow-test-weakening` flagged it. Advisory; one event per flagged commit, restored ones included. | `callum-flow-merge`, after the merge | `issue`, `run_id`?, `branch`?, `pr`?, `head`?, note (structured) | evaluate and metrics 5b (weakened tests by step, restored or not) |
| [`watcher_error`](../schemas/events/states/watcher_error.schema.json) | A streaming watcher died; it also prints a `watcher-error` line, so a crash is never silent. The `--once` modes the factory loop uses never log it. Housekeeping. | `queue-watch.sh`, `pipeline-watch.sh` in `--stream` mode (actor `watcher`) | - | counted only as activity (coverage, device alive) |
| [`usage`](../schemas/events/states/usage.schema.json) | One reading of the Claude plan's usage for the usage gate: the five-hour and weekly percentages and their resets, or why none was available. Housekeeping. | `usage-check.sh` on every check (actor `watcher`); the factory loop runs it every few minutes | note (structured) | the factory loop replay (`parseUsage`); counted as activity elsewhere |
| [`superseded`](../schemas/events/states/superseded.schema.json) | A run or branch was replaced for the same issue; `run_id` names the old run. Run-scoped: never a stage, ends nothing, releases no claim. | `callum-flow-regate`; the factory loop (a fixer's new branch); the orchestrator and judge skills | `issue`, `run_id`, `branch`? | factory-state and the factory loop (drop the named run), heartbeat-state |
| [`renewed`](../schemas/events/states/renewed.schema.json) | A claim heartbeat extended this device's claim on the issue. Housekeeping: never a stage, never progress, never a new life. | `callum-flow-claim --heartbeat`, one per claim comment it extended | `issue`, note (structured) | factory-state (lease lapse only), factory loop ledger rebuild (heartbeat) |
| [`rebased_behind`](../schemas/events/states/rebased_behind.schema.json) | A PR that was only behind its base was rebased and pushed without a new pipeline run, after the patch was proved unchanged against the gated run. The next `head_mismatch` for that run is expected. | the factory loop after `callum-flow-merge-guard --update-behind`; the orchestrator skill | `issue`, `run_id`?, `branch`?, `pr`?, `head`? | factory loop (ledger rebuild of the update; needs `branch`) |
| [`loop`](../schemas/events/states/loop.schema.json) | The factory loop's own bookkeeping (DECISIONS D-09): agent and wake starts and ends with their answers, owner notices, rate-cap holds and the ping breaker. Never a stage, never progress; rebuilds the loop's ledger after a lost store. | the factory loop (`ledger.ts` `loopEvent`, `act.ts` `capEventArgv`, `breakerEventArgv`) | `issue`?, `run_id`?, `pr`?, `head`?, note (structured) | factory loop (`derive.ts` `entryFromLoop`, ledger rebuild); counted as activity elsewhere |

## Related

- [`images/base/README.md`, factory event log](../images/base/README.md#factory-event-log): the
  writer and the tools that log events.
- [`metrics.md`](metrics.md): the saved queries and their definitions.
- [`factory-state.md`](factory-state.md): how the stage of an issue is derived from events.
- [`factory-loop/SPEC.md`](factory-loop/SPEC.md) section 7.4: the factory loop's events.
