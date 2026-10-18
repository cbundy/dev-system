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
(`CALLUM_FLOW_CLAIM_EVENTS_SOURCE`, `old|new|shadow`, default `shadow`; an invalid value warns once and reads old,
because the rule must never fail its callers) and records each shadow compare as a `shadow_read` event
(`reader` `claim-events`, `tool` the calling command), not as a line in `factory/.shadow/<tool>.jsonl`. The reason is
that a sourced shell rule cannot call `runShadow`, and the event is a record the metrics query already reads
([6b](../metrics.md#6b-reader-shadow-compares)). The compared value per `repo#issue` is what the rule decides on (the
lifecycle class, the latest claim type and its device); `CALLUM_FLOW_SHADOW_WINDOW_SECONDS` (default 604800) bounds
both reads and `CALLUM_FLOW_SHADOW_SETTLE_SECONDS` (default 600) cuts `differences`, while `live_differences`
counts the whole window.

Switched readers and their known differences from `old` (dropped before comparing, in `normalize`):

| Tool | Reader | Known differences |
|---|---|---|
| `callum-flow-evaluate` ([#899](https://github.com/cbundy/dev-system/issues/899)) | [`readers/evaluate.js`](../../scripts/factory-events-replay/readers/evaluate.js) | the `sources` block; `waiting` and `adjudicator_agreement`, which read n/a under `new`; the per-issue lead-time stages `design`, `implementation`, `pipeline` and `waiting_for_merge`, which time `delegated` and `merge_ready` by the transition's `seq_at` ([metrics.md](../metrics.md#reading-the-new-events)) |

To move a tool's default to `new`: its shadow runs must be clean, judged with the query in
[docs/metrics.md](../metrics.md#shadow-runs-source-switch). The threshold is set in
[#902](https://github.com/cbundy/dev-system/issues/902).
