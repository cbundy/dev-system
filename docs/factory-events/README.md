# Factory events

The factory's event format: one JSON object per event, with a small envelope and a typed,
versioned payload, stored in the factory database and read through one view. Design for
[#645](https://github.com/cbundy/dev-system/issues/645), part of
[#534](https://github.com/cbundy/dev-system/issues/534). This README holds the decisions only.

- [`schemas/`](schemas/) is the catalogue and the single source: the envelope
  ([`envelope.v1.json`](schemas/envelope.v1.json)) and one JSON Schema per event type and version
  (`<type>.v<N>.json`), each with the event's description, every field's description and examples.
  [`REFERENCE.md`](REFERENCE.md) beside this file is generated from them; read that.
- [`translator.md`](translator.md): how today's `callum-flow-event` lines map onto these, during
  the switch only.

## Reading events

- **One issue's story.** `ready`, then `claimed` (with `claim_renewed` while it is held), then
  `transition`s as the loop moves it (`reviewed`, `finding_handled` and `intervention` in between),
  and one event that ends the claim: `merged`, `closed`, `abandoned` or `requeued`. A requeued
  issue starts again at `claimed`, in a new life.
- **Current state.** An issue's state is the `to_state` of its newest `transition` (by `seq_at`,
  then `seq`). Time transitions by `seq_at`, not `ts`: a transition logged again after a re-claim
  keeps its `seq_at`.
- **Count once.** A retried write can repeat an event. Each type's description names its key, for
  example `(issue, life, seq)` for `transition`.
- **Select by name.** Pick the types you need by name; never filter by excluding "noise" types, so
  a new type cannot change your answer.
- **Unknown values.** Handle a code or enum value you do not know (a default branch, or count it
  as other): adding one is not a version bump.
- **Absent fields.** A field added to a version after its first release is missing from that
  version's older events. The shared reader and the view give it as null.
- `reason` is always a short why-code, but each type has its own list: read it with `type`.
- Fields whose description starts "Loop state, for the record rebuild" (and all of `loop_entry`)
  exist so the loop can rebuild itself. Most consumers can ignore them.

Example queries, through `dev-query` and the view (percentiles and medians go in code):

```sh
# each issue's current state
dev-query -v repo=cbundy/plant-console <<'SQL'
select issue, to_state, seq_at from (
  select issue, to_state, seq_at,
         row_number() over (partition by issue order by seq_at desc, seq desc) as n
  from factory.event_log where repo = :'repo' and type = 'transition') t
where n = 1;
SQL
# lead time: first ready to merge, per merged issue
dev-query -v repo=cbundy/plant-console <<'SQL'
select m.issue, min(r.ts) as ready_at, m.ts as merged_at
from factory.event_log m
join factory.event_log r on r.repo = m.repo and r.issue = m.issue and r.type = 'ready' and r.ts <= m.ts
where m.repo = :'repo' and m.type = 'merged'
group by m.issue, m.ts;
SQL
# review false positives: declined findings over all handled ones
dev-query -v repo=cbundy/plant-console <<'SQL'
select outcome, count(*) from factory.event_log
where repo = :'repo' and type = 'finding_handled' group by outcome;
SQL
```

## Versioning

- **What a version is.** Each type has its own `type_version`, an integer from 1, and each version
  its own schema file, never deleted. A new type starts at `<type>.v1.json`.
- **One rule for a bump.** An existing version's file may only gain: new or better descriptions
  and examples, a new optional field (not in `required`), a new enum value, a looser bound. An
  older reader survives each of these. Anything else (removing, renaming or retyping a field,
  making one required, removing an enum value, a tighter bound, a changed unit or meaning) is a
  new file, `<type>.v<N+1>.json`.
- **Readers are tolerant.** Code reads payloads through one shared reader. It checks that the type
  and version are known and the required fields are present, ignores fields it does not know,
  gives absent optional fields as null, and upgrades older versions to the current one. On an
  unknown type or version it fails with an error naming both (`unknown factory event:
  transition v3`), never guessing. The loop's record rebuild fails its whole read on that error
  (store source not ok) and never skips the row, since a skipped transition quietly rebuilds an
  older record. [#654](https://github.com/cbundy/dev-system/issues/654) changes
  `plugins/factory-loop/hooks/v2/record.ts:46-51`, which skips today. Shell tools read only
  envelope fields or the view.
- **The writer never refuses what a newer caller may know.** `callum-flow-event` ships in the
  image and its callers in the plugin, and the two roll out separately. So at run time it checks
  the envelope and, for a type and version it knows, that every required field is present with
  its JSON type; it exits 2 only on those. A type or version it does not know is written with a
  warning naming it. Enum values, bounds and unknown fields are checked strictly only in `npm test`.
- **Bumps roll out in two releases.** The new schema file, the shared reader's upgrade step and
  any view change ship one release before any producer writes the new version. The same holds for
  a new type, so every reader knows it before it appears.
- **Old versions stay readable for good.** The store keeps every version.
- **The envelope follows the same rules;** a change to it is also a database migration.

## Field conventions

- **Names.** snake_case. A shared name (`pr`, `branch`, `head`, `life`, `round`) means the same
  thing in every type, which is what lets the view lift it into one column.
- **Times.** UTC ISO 8601 ending in `Z`, named `*_at` (the envelope uses `ts`). Times the writer
  makes carry exactly three millisecond digits, so they sort as text. Times copied from elsewhere
  (`pr_closed_at`, `holder_since`, the usage reset times) stay exactly as given.
- **Presence.** A missing value is JSON `null`, never the string `"none"`. **Flat:** scalars, or
  at most arrays of scalars; no nested objects.
- **Codes.** A closed list is an `enum`. An open family (`cause`, `via`) is a patterned string with
  examples in its description.
- **Free text** (`detail`, `question`, `notes`) is for people and never parsed. When a reader
  needs something from free text, it becomes its own field.
- **Bounds.** A schema bound is never tighter than the producer's own (the loop's note and
  question clips, `plugins/factory-loop/hooks/v2/table.ts:108-109,194`), or a valid event fails.

## Where events live

- **Local log.** Each device appends one line per event to
  `/persist/events/factory/<owner>__<repo>.jsonl`. During dual write the old line still goes to
  today's file, and nothing that reads today's file sees the new one: not `callum-flow-claim`,
  `callum-flow-sweep`, `--if-changed` (which keeps comparing old lines only) or the old shipper's
  `$DIR/*.jsonl` glob (`images/base/event-push-loop:202`).
- **Shipping.** The new push loop keeps its own cursor and stores each line's number in the file
  as `device_seq`. A line the database refuses is set aside with a warning naming it and its
  error, and the cursor moves on: one bad line never holds back the lines after it.
- **Store.** `factory.event_store`: the envelope fields and `device_seq` as columns, `data` as
  JSON, primary key `event_id`, so a re-push never makes a second row. It accepts any type and
  version; the writer and the readers are what check them.
- **View.** `factory.event_log`: one row per event, the envelope columns and `device_seq`, plus
  one column for each payload field marked `"x-column": true` in the schemas (what today's tools
  and saved queries read, and each type's counting key). Each lifted column is read from `data` by
  name whatever the version; a version that renames or retypes a lifted field ships its view
  change with its schema. A column is null when the type lacks the field. Rows order by `ts`,
  `device`, `device_seq`. `ts` is `timestamptz` in Postgres and ISO text in SQLite. Shared queries
  read only the view and keep the [#644](https://github.com/cbundy/dev-system/issues/644) rules: no
  `@>`, no `DISTINCT ON`, percentiles in code.

## Keeping the docs in step

Checks fail whenever code and docs disagree, so nobody has to remember a process step.

- **One source.** An event's meaning, each field's meaning, its examples and whether the view lifts
  it live in its schema file.
- **Generated reference.** `scripts/build-event-docs.js` writes `REFERENCE.md` from the schemas,
  the way `scripts/build-skills.js` writes SKILL.md: a type index, the envelope, the view's columns,
  and for each type its description, versions and fields. `npm run build:events` writes it.
  `npm run lint` (`node scripts/build-event-docs.js --check`) fails when it is stale, when a schema
  or field lacks a description or an example, or when a field outside `required` cannot be null.
- **Version lock.** The script keeps `schemas/versions.lock.json`: each version's shape without
  its annotations. Lint fails on any shape change to an existing version other than the
  ones the bump rule allows (a new optional nullable field, a new enum value, a looser bound), and
  says "add `<type>.v<N+1>.json`". It also fails when a version is missing, a version file is gone,
  or an older version has no upgrade step to the next one in the reader.
- **Reader shapes.** The plugin cannot read `docs/` at run time, so the script also writes
  `plugins/factory-loop/hooks/v2/event-schemas.ts`, the same shapes as a typed constant plus each
  type's current version. The shared reader is `plugins/factory-loop/hooks/v2/event-reader.ts`: it
  reads only that file and exports `readEvent`, `UPGRADES` (one step per `<type>.v<N>`) and
  `validateStrict`.
- **Supported keywords.** The generator and the reader's validator know only these. Checked:
  `type` (a string or an array, including `"null"`), `enum`, `const`, `properties`, `required`,
  `additionalProperties: false`, `items`, `pattern`, `minimum`, `maximum`, `minLength`,
  `maxLength`, `minItems`, `maxItems` and `format: date-time`. Annotations: `$schema`, `$id`,
  `title`, `description`, `examples`, `x-column` and `x-issue` (`required`, `optional` or `none`).
  Lint fails on any other keyword.
- **Tests (`npm test`).** Every example validates strictly against its own schema and, through the
  shared reader's upgrade, against the type's current version. Every event fixture of a producer
  (`tests/factory-loop-v2-events.test.js` for the loop, and the shell producers' own tests) goes
  through the real `callum-flow-event`, the translator during dual write, strict validation and the
  shared reader, and must come back equal to what went in. The view's lifted columns must match
  the `x-column` fields.

Who does what:

- **Builder.** Changes the schema (fields, descriptions, an example) in the same PR as the code
  that writes the event; adds or extends a producer fixture for every new event or field; adds the
  next version and its upgrade step when lint asks; runs `npm run build:events`.
- **Reviewer.** Reads the schema diff as a consumer would: does each description give the field's
  meaning, unit and null case? A change of meaning with no change of shape needs a new version;
  that is the one change the lock cannot see.
- **CI.** Nothing new: `ci.yml` already runs `npm run lint` and `npm test`.
