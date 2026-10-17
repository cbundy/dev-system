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
`factory.events` against `factory.event_log`) is the only reader the harness ships.

## What a reader issue passes

A reader that moves to the new store ([#651](https://github.com/cbundy/dev-system/issues/651),
[#652](https://github.com/cbundy/dev-system/issues/652), [#653](https://github.com/cbundy/dev-system/issues/653),
[#654](https://github.com/cbundy/dev-system/issues/654)) brings a reader module that:

1. matches on the corpus in `npm test`: `tests/factory-events-replay.test.js` loads
   `tests/fixtures/factory-events-replay/` (real old rows, see its README) into a per-test database and
   runs `compare` over it; and
2. matches once on the full history, `load` then `compare` over the development database from
   2026-10-16T02:00Z, before the reader's shadow starts. Drop the database afterwards.
