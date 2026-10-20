# Replay and compare

Temporary: deleted with the old event path ([#656](https://github.com/cbundy/dev-system/issues/656)).

The replay proves the new event store holds what the old one does
([#650](https://github.com/cbundy/dev-system/issues/650), part of [#534](https://github.com/cbundy/dev-system/issues/534)).
It is two commands of `scripts/factory-events-replay.js`. It is not the plan replay
(`scripts/factory-loop-replay.js`), which rebuilds the factory's state at past moments and compares what
the loop would have *decided*; this one compares what the two stores *hold*.

URLs come from the environment, never argv. The old store is `FACTORY_REPLAY_OLD_URL`, else
`AGENTSVIEW_PG_URL`, else the `agentsview-pg-url` secret. The admin connection that makes the throwaway
database (a role with CREATEDB and CREATEROLE) is `FACTORY_DB_ADMIN_URL`. The old store is only read, in a
read-only session; the only database written is the one `load` makes.

## `load`

```
node scripts/factory-events-replay.js load --db NAME [--since ISO] [--out FILE]
```

It reads the old `factory.events` rows from `--since` (default `2026-10-16T02:00:00Z`, the owner's start),
runs each row's `raw` line through `translate()` in replay mode, and stores the events in
`factory.event_store` of database `NAME`, made with `factory-db-bootstrap` (the old row's `seq` becomes
`device_seq`). It refuses a database that already has rows and never touches one it did not make: drop
`NAME` and its three roles when you are done (`DROP DATABASE NAME WITH (FORCE)`, then `NAME_owner`,
`NAME_writer`, `NAME_reader`).

It prints the translation check and saves it as JSON (`--out`, default `factory-events-replay-check.json`):
per old state the lines, events made, skips per skip name and misses per reason; new events per type; a
total. Exit 0 only when misses are 0, every row is translated or skipped by name, and the new events of each
type equal the old lines of the mapped state minus the named skips
([translator.md](translator.md)). Otherwise exit 1, naming each miss with its device, seq and `event_id`.
Exit 2 is a usage error, a refused database or an unreachable store.

## `compare`

```
node scripts/factory-events-replay.js compare --reader MODULE --db NAME [--since ISO] [--until ISO]
```

`MODULE` exports `old(ctx)`, `new(ctx)` and optionally `normalize(output)`. `ctx` is
`{ oldUrl, newUrl, since, until, psql }`: the old-store URL, the URL of database `NAME`, the window as ISO
times (`until` may be null) and `psql(url, sql)`, a read-only psql returning the rows unaligned. Both
functions may be async. The harness normalises both outputs, deep-compares them and reports each
difference by path (`$.a.b[2]`) with the old and new value; exit 0 only on no difference.
[`self-test-reader.js`](../../scripts/factory-events-replay/self-test-reader.js) (events per type and issue,
`factory.events` against `factory.event_log`) is the harness's self-test. The first real reader is
[`readers/claim-events.js`](../../scripts/factory-events-replay/readers/claim-events.js) (the claim tools' held
rule, per `repo#issue`): it runs the shipped `images/base/claim-events.sh` functions against a dev-query
stand-in ([`devq-standin.js`](../../scripts/factory-events-replay/devq-standin.js)) that reads `ctx.oldUrl`, or
with `--factory` `ctx.newUrl`, read-only.

## What a reader issue passes

A reader that moves to the new store ([#651](https://github.com/cbundy/dev-system/issues/651),
[#652](https://github.com/cbundy/dev-system/issues/652), [#653](https://github.com/cbundy/dev-system/issues/653),
[#654](https://github.com/cbundy/dev-system/issues/654)) brings a reader module that:

1. matches on the corpus in `npm test`: `tests/factory-events-replay.test.js` loads
   `tests/fixtures/factory-events-replay/` (real old rows, see its README) into a per-test database and
   runs `compare` over it; and
2. matches once on the full history, `load` then `compare` over the development database from
   2026-10-16T02:00Z, before the reader's shadow starts. Drop the database afterwards.

## Source switch

A read tool that moves from the old store to the new one carries a source switch
([#897](https://github.com/cbundy/dev-system/issues/897)). The helper is `images/base/factory-source.js`
(CommonJS, node built-ins only); a node tool in `images/base` requires it from beside itself, else from
`$DEV_SYSTEM_SHARE` (the image copies it to `/usr/local/share/dev-system/`).

The source is chosen by the `--source old|new|shadow` flag (or `--source=X`), else by
`CALLUM_FLOW_<TOOL>_SOURCE` (the tool name upper-cased, `-` becoming `_`, so `factory-state` reads
`CALLUM_FLOW_FACTORY_STATE_SOURCE`), else by the tool's own default. Anything else is a usage error
(`resolveSource` throws an Error with `code: "USAGE"`).

- `old`: the tool reads the old store only.
- `new`: the tool reads the new store only. `dev-query --factory` is the new store's read path (the
  `factory.event_log` view, as the reader role).
- `shadow`: the tool reads both through `runShadow`, answers from old, and records how new differed. A
  failing new read or an unwritable record never fails the tool; a failing old read does.

Each shadow run appends one JSON line to `${CALLUM_EVENTS_DIR:-/persist/events}/factory/.shadow/<tool>.jsonl`
(directory mode 0700, file mode 0600). The push loop's `factory/*.jsonl` glob does not reach `.shadow/`, so
these records stay on the device. Fields:

| Field | Meaning |
|---|---|
| `ts`, `tool`, `device`, `repo` | when, which tool, which machine (`DEV_MACHINE_NAME`, else the hostname), the caller's repo or null |
| `args` | the caller's summary of its arguments; it must hold no secrets |
| `old_ms`, `new_ms` | how long each read took |
| `differences` | the number of differing paths, or null when new failed |
| `paths` | up to the first 5 `{ path, old, new }`, each value JSON-stringified and clipped to 200 characters |
| `new_error` | null, or the new read's error message (clipped to 200 characters) |

A run with differences also prints `<tool>: shadow: N difference(s), first at <path> (see <file>)` on stderr.

The claim tools (`callum-flow-claim`, `callum-flow-sweep`) are the exception
([#905](https://github.com/cbundy/dev-system/issues/905)): their rule is a shell file sourced inside the heartbeat
and the sweep (`images/base/claim-events.sh`), so the switch is shell too. It uses the same names and values
(`CALLUM_FLOW_CLAIM_EVENTS_SOURCE`, `old|new|shadow`, default `new`, `old` the way back; an invalid value warns once and reads old,
because the rule must never fail its callers) and records each shadow compare as a `shadow_read` event
(`reader` `claim-events`, `tool` the calling command), not as a line in `factory/.shadow/<tool>.jsonl`. The reason is
that a sourced shell rule cannot call `runShadow`, and the event is a record the metrics query already reads
([6b](../metrics.md#6b-reader-shadow-compares)). The compared value per `repo#issue` is what the rule decides on (the
lifecycle class, the latest claim type and its device); `CALLUM_FLOW_SHADOW_WINDOW_SECONDS` (default 604800) bounds
both reads and `CALLUM_FLOW_SHADOW_SETTLE_SECONDS` (default 600) cuts `differences`, while `live_differences`
counts the whole window. Both reads leave out the history from before a device's first new-store event (its
floor, the first row of that device for the repo in `factory.event_log`, read once per compare): the production new
store holds only dual-written events and is not backfilled (`factory-events-replay.js load` fills a throwaway
database only), so the 7-day window reaches back before it begins and an old event of a device older than its floor
has no new counterpart by design. The compare drops such events from both sides and from both local logs; a device
with no new row keeps all its old events and still shows as a difference: a device that stopped writing before the dual
write began (an orchestrator session, an old container name) is such a device, and its issues stay differences until the
7-day window passes its last event, which is harmless (checked on 2026-10-19 against the real stores: the only
differences left were issues decided by such devices). The event names this device's floor as
`scope_floor`. Under `new` the claim tools lack that history until the 7-day window passes the floor (for
cbundy/dev-system, 2026-10-17 13:26 UTC, so until 2026-10-24 13:26 UTC).

Tools behind the switch: `callum-flow-factory-state` ([#898](https://github.com/cbundy/dev-system/issues/898),
default `new`; its replay reader is `scripts/factory-events-replay/readers/factory-state.js`, and what its
shadow comparison leaves out is listed in [factory-state.md](../factory-state.md#sources-oldnewshadow)) and
`heartbeat-state` ([#900](https://github.com/cbundy/dev-system/issues/900), default `new`; its replay reader is
`scripts/factory-events-replay/readers/heartbeat-state.js`; `new` reads this device's local new log under a 500 ms
deadline, and a shadow record is kept for every difference or error but an agreeing run only once per quiet period).

The factory loop ([#976](https://github.com/cbundy/dev-system/issues/976)) is the other exception: its switch is the
loop setting `eventsSource` (`old|new|shadow`, default `new` since [#978](https://github.com/cbundy/dev-system/issues/978), `/factory config set eventsSource old` the way
back; an invalid value is a config problem and reads old), taken on the next pass. It picks where the record
rebuild reads (`hooks/v2/record.ts`, `hooks/v2/sources-records.ts`): `old` reads `factory.events`, `new` reads
`factory.event_store` with `dev-query --factory` and fails the whole read, naming the event_id, on a row it cannot
read, and `shadow` (opt-in) reads both once per load and then hourly, compares the two rebuilds per issue and field with both
sides cut 600 s back, answers from old, and writes one `shadow_read` event (`reader` `loop-records`, `tool`
`factory-loop`). A compare with differences also tells the owner once per distinct set of issues.

The same setting also picks where the loop reads its facts every pass and the 7-day ledger rebuild of a lost store
([#977](https://github.com/cbundy/dev-system/issues/977), `hooks/v2/sources-facts.ts`), and with them the events
behind v2's once keys. `new` reads the types `requeued`, `claimed`, `claim_renewed`, `merged`, `loop_entry`,
`intervention`, `reviewed` and `ready`, and `closed` by the sweep, maps each row to the event the facts code reads and fails the
whole read, naming the event_id, on a row it cannot read. `shadow` decides on old and compares four things hourly,
cut 600 s back: the newest `reclaimed` and the newest `ready` per issue, this device's derived ledger and the once keys (`shadow_read` with
`reader` `loop-facts`, `diff_keys` `reclaimed:#N`, `ready:#N`, `ledger:<key>` or `once:<key>`; the owner is told once per distinct
set, `tell(facts-shadow)`). Before comparing, `shadow` reads each device's first new-store time for the repo (one
`dev-query --factory` read, `NEW_FLOORS_SQL`, only on the compare pass) and drops from both sides every event of a
device older than that floor. The production new store holds only dual-written events and is not backfilled, so the
old read's 3-day window reaches back before it begins; that history is out of scope by design. Events of a device with
no new-store row, and events with no device, are kept. The event carries `scope_floor` (this device's floor, or null)
and `out_of_scope` (how many events the floor left out); a failing floor read is a compare with `new_ok` false. Under
`new` the facts lack that history until the 3-day window passes the floor (for cbundy/dev-system, 2026-10-17 13:26 UTC,
so until 2026-10-20 13:26 UTC), and the 7-day ledger rebuild until 2026-10-24 13:26 UTC.

Switched readers and their known differences from `old` (dropped before comparing, in `normalize`):

| Tool | Reader | Known differences |
|---|---|---|
| `callum-flow-evaluate` ([#899](https://github.com/cbundy/dev-system/issues/899)) | [`readers/evaluate.js`](../../scripts/factory-events-replay/readers/evaluate.js) | the `sources` block; `waiting` and `adjudicator_agreement`, which read n/a under `new`; the per-issue lead-time stages `design`, `implementation`, `pipeline` and `waiting_for_merge`, which time `delegated` and `merge_ready` by the transition's `seq_at` ([metrics.md](../metrics.md#reading-the-new-events)) |
| the factory loop's record rebuild ([#976](https://github.com/cbundy/dev-system/issues/976)) | [`readers/loop-records.js`](../../scripts/factory-events-replay/readers/loop-records.js) | none known: it runs the plugin's own `record.ts` over both stores, per repo and device |
| the factory loop's facts and ledger rebuild ([#977](https://github.com/cbundy/dev-system/issues/977)) | [`readers/loop-facts.js`](../../scripts/factory-events-replay/readers/loop-facts.js) | the facts left out under `new` because no v2 path reads them: `briefs` (only `IssueView.delegatedBrief`, which only `state.ts` sets), and `reviewFixes`, `verdicts`, `superseded`, `answered` and `pipeline` (only `runsFromEvents`, whose `state.runs` only the plan replay, `scripts/factory-loop-replay.js`, and the state digest read); the `out`, `decision` columns and the run, PR and head of a `loop_entry`, dropped from the loop-logged ledger entries on both sides (no v2 path reads the outcome of a tell, task or judge entry: the outcomes v2 reads are the claim, adopt and rollout ones of entries it keys itself, which are never logged through `loop`); times are whole seconds on both sides (the old log stores no milliseconds); the history from before a device's first new-store event, which the production new store never held (the shadow drops it from both sides, `scope_floor`; the replay's throwaway database holds the full history, so it needs no floor) |
| `heartbeat-state` ([#900](https://github.com/cbundy/dev-system/issues/900)) | [`readers/heartbeat-state.js`](../../scripts/factory-events-replay/readers/heartbeat-state.js) | the per-entry `state` (old state names against new types); the v1-only events the new log lacks (`run_started`, `superseded`, `owner_wait`, `briefed`, `design_routed` and the replayed run facts `failed`, `head_mismatch`, `conflict`, `ci_stalled`); history from before the device's dual write; a window that ends in the few seconds between a transition into building, fixing or merge-queue and the v1 line the loop writes after it (`new` derives `delegated`, `fix_requested` and `merge_ready` from the transition) |

## Defaults moved to new

The default source of these tools moved from `shadow` to `new` on 2026-10-18
([#902](https://github.com/cbundy/dev-system/issues/902); the factory loop row under [#978](https://github.com/cbundy/dev-system/issues/978)). The owner decided to skip the shadow runs: the evidence is the
full-history compare ([#650](https://github.com/cbundy/dev-system/issues/650)) and the dual-write check. The way back
is the same for each: `--source old` or `<VARIABLE>=old`, at once. `--source shadow` still works and still writes its
records ([metrics.md](../metrics.md#shadow-runs-source-switch)).

| Tool | Moved | Evidence | Way back |
|---|---|---|---|
| `callum-flow-factory-state` | 2026-10-18 | owner's decision to skip shadow runs; corpus compare in `npm test`; full-history compare (see below) | `CALLUM_FLOW_FACTORY_STATE_SOURCE=old` |
| `callum-flow-evaluate` | 2026-10-18 | the same; evaluate's v1-only metrics read n/a under `new` | `CALLUM_FLOW_EVALUATE_SOURCE=old` |
| `heartbeat-state` | 2026-10-18 | the same; `new` reads only this device's local new log under a 500 ms deadline, so an issue whose only lifecycle events came before the device's dual write reads idle | `CALLUM_FLOW_HEARTBEAT_STATE_SOURCE=old` |
| the factory loop (`eventsSource`: record rebuild, facts, ledger rebuild, once keys) | 2026-10-18 | the owner decided to skip the `loop-facts` shadow run (it had no compare, since v0.59.0 was not yet run by the loop); the `loop-records` compares of query 6b for cbundy/dev-system: 3 compares on 2026-10-18 between 21:42 and 23:42 UTC, 0 differences, 1 live difference (push lag, not counted), no failed reads | `/factory config set eventsSource old` (next pass) |
| the factory HUD (via factory-state) | 2026-10-18 | it passes no source when `FACTORY_HUD_SOURCE` is unset, so it follows factory-state | `FACTORY_HUD_SOURCE=old` |

Full-history compare (`load`, then `compare --reader scripts/factory-events-replay/readers/<tool>.js` from
2026-10-16T02:00Z): the builder of this change could not run it. The slot has no `FACTORY_DB_ADMIN_URL` and no
old-store URL, so there is no PASS or FAIL line, event count or difference count to record here, and none is
invented. The reader issues ([#898](https://github.com/cbundy/dev-system/issues/898),
[#899](https://github.com/cbundy/dev-system/issues/899), [#900](https://github.com/cbundy/dev-system/issues/900))
asked their builders for the full-history result in their answers. Whoever has database access should run the
compare for each reader and add the PASS or FAIL line, event count and difference count to this section. The claim tools
keep their own default.
