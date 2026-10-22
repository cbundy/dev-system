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
- [`replay.md`](replay.md): the replay of the old history into a throwaway database, its translation
  check and the compare harness every reader issue passes, during the switch only.

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
- **Regime.** The optional envelope field `regime` says which kind of run wrote an event:
  `factory_loop_v2` (work the v2 factory loop did), `testbed` (a testbed or experiment run) or
  `manual` (a person or an interactive session). Null means unknown and is never guessed. It ships
  ahead of its producers, so no event carries a value yet and every row reads null. A reader
  filters by naming the values it wants, never by excluding one.
- `reason` is always a short why-code, but each type has its own list: read it with `type`.
- Fields whose description starts "Loop state, for the record rebuild" (and all of `loop_entry`)
  exist so the loop can rebuild itself. Most consumers can ignore them.

Example queries, through `dev-query --factory` and the view (`factory.event_log` lives in the factory database) (percentiles and medians go in code):

```sh
# each issue's current state
dev-query --factory -v repo=cbundy/plant-console <<'SQL'
select issue, to_state, seq_at from (
  select issue, to_state, seq_at,
         row_number() over (partition by issue order by seq_at desc, seq desc) as n
  from factory.event_log where repo = :'repo' and type = 'transition') t
where n = 1;
SQL
# lead time: first ready to merge, per merged issue
dev-query --factory -v repo=cbundy/plant-console <<'SQL'
select m.issue, min(r.ts) as ready_at, m.ts as merged_at
from factory.event_log m
join factory.event_log r on r.repo = m.repo and r.issue = m.issue and r.type = 'ready' and r.ts <= m.ts
where m.repo = :'repo' and m.type = 'merged'
group by m.issue, m.ts;
SQL
# an issue's newest title: the newest ready or claimed event with a title
dev-query --factory -v repo=cbundy/plant-console <<'SQL'
select distinct on (issue) issue, title, labels, parent, ts
from factory.event_log
where repo = :'repo' and type in ('ready', 'claimed') and title is not null
order by issue, ts desc;
SQL
# each parked issue's question link: the newest transition per issue, if parked, and its comment
dev-query --factory -v repo=cbundy/plant-console <<'SQL'
select t.issue, t.life, t.seq, c.comment_url
from (select issue, life, seq, to_state,
             row_number() over (partition by issue order by seq_at desc, seq desc) as n
      from factory.event_log where repo = :'repo' and type = 'transition') t
left join factory.event_log c on c.repo = :'repo' and c.type = 'comment_posted'
  and c.issue = t.issue and c.life = t.life and c.seq = t.seq
where t.n = 1 and t.to_state = 'parked';
SQL
# the loop's newest queue per repo (empty until the loop writes queue_snapshot events)
dev-query --factory <<'SQL'
select repo, taken_at, reason, considered, free_slots, candidates,
       extract(epoch from (now() - taken_at)) as age_s
from (select *, row_number() over (partition by repo order by taken_at desc, ts desc) as n
      from factory.event_log where type = 'queue_snapshot') t
where n = 1;
SQL
# review false positives: declined findings over all handled ones
dev-query --factory -v repo=cbundy/plant-console <<'SQL'
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
  transition v3`), never guessing. The image's readers (`callum-flow-factory-state`,
  `callum-flow-evaluate`, `heartbeat-state`) instead skip and count such an event and go on (a lagging
  image must not go blind); the shared reader and the loop's record rebuild still fail the read. The loop's record rebuild from the new store (`eventsSource` `new`,
  `recordsFromNewRows` in `plugins/factory-loop/hooks/v2/record.ts`) fails its whole read on that
  error, or on a payload the reader refuses (store source not ok, its error names the event_id and
  the source `new`) and never skips the row, since a skipped transition quietly rebuilds an
  older record. Its old-store rebuild (`recordsFromEvents`) still skips a note it cannot parse.
  Shell tools read only envelope fields or the view.
- **The writer never refuses what a newer caller may know.** `callum-flow-event` (its native mode,
  `--type`) ships in the image and its callers in the plugin, and the two roll out separately. So at run time it checks
  the envelope and, for a type and version it knows, that every required field is present with
  its JSON type; it exits 2 only on those. A type or version it does not know is written with a
  warning naming it. Enum values, bounds and unknown fields are checked strictly only in `npm test`.
  The check reads the image's shapes file, `factory-event-shapes.json`, generated from the schemas.
- **Readers skew by three minor releases.** The readers in the image of each of the last three
  minor releases must read every event the current plugin writes. A new type, or a new version of
  an existing type, ships its schema (in the shapes file), the shared reader's upgrade step and any
  view change in release N, and no producer writes it before release N+3 (the third minor after
  it). The image readers skip and count an unknown type or version (#1204), so an early producer
  does not crash the loop, but a skipped derived type turns the pass blind and any other raises the
  `reader-behind` owner notice until the images catch up (see G2 in
  [the v2 spec](../factory-loop/v2/SPEC.md)). This is a separate rule from the database window
  below (database schema vs event readers).
- **The database keeps a ten-minor-release window.** The schema at any release works for the writers and
  readers of the last 10 minor releases; migrations are expand-only, enforced by `npm run lint`
  ([Schema compatibility](../factory-db.md#schema-compatibility)).
- **Old versions stay readable for good.** The store keeps every version.
- **The envelope follows the same rules;** a change to it is also a database migration.

## Field conventions

- **Names.** snake_case. A shared name (`pr`, `branch`, `head`, `life`, `round`) means the same
  thing in every type, which is what lets the view lift it into one column (`decision` is shared between `loop_entry` and `transition`).
- **Times.** UTC ISO 8601 ending in `Z`, named `*_at` (the envelope uses `ts`). Times the writer
  makes carry exactly three millisecond digits, so they sort as text. Times copied from elsewhere
  (`pr_closed_at`, `holder_since`, the usage reset times) stay exactly as given.
- **Presence.** A missing value is JSON `null`, never the string `"none"`. **Flat:** scalars, or
  at most arrays of scalars; no nested objects. The exception is a bounded list of objects whose schema is closed
  (`additionalProperties: false`): `wait` and `options`.
- **Codes.** A closed list is an `enum`. An open family (`cause`, `via`) is a patterned string with
  examples in its description.
- **Free text** (`detail`, `question`, `notes`) is for people and never parsed. When a reader
  needs something from free text, it becomes its own field.
- **Bounds.** A schema bound is never tighter than the producer's own (the loop's note and
  question clips, `plugins/factory-loop/hooks/v2/table.ts:108-109,194`), or a valid event fails.

## Where events live

- **A CI release.** A repo that cuts releases in a workflow attaches the `released` event to the GitHub
  Release as the asset `factory-released.json` (the composite action `.github/actions/released-event`); a
  device's `factory-event-push-loop` collects it with `callum-flow-released --collect` into its own log and
  pushes it. The same release may reach the store from two devices; count it once by `(repo, tag)`.
- **Local log.** Each device appends one line per event to
  `/persist/events/factory/<owner>__<repo>.jsonl` (`callum-flow-event --new-path` prints the path; `factory/` is made
  0700). The old log `<events dir>/<owner>__<repo>.jsonl` and `factory.events` get no new lines any more
  (dev-system#1143): there is no dual write. The native mode, `callum-flow-event --type <type> --data '<json>' [--type-version N]
  [--issue N] [--repo O/N] [--actor NAME] [--regime R]`, writes a new event straight to that file and nothing to
  the old log. The image's tools write natively (dev-system#1140): `callum-flow-claim` (`claimed`,
  `claim_renewed`, `claim_lost`), `callum-flow-sweep` (`closed`, `merged`, `requeued`; its `merged` rows include the merges to the default branch that no event recorded, logged as recovered hand merges, with no issue unless a trusted pull request closes one), `callum-flow-merge`
  (`merged` with the pull request's files, per-file line counts (`file_lines`), additions and deletions, `test_weakened`), `callum-flow-issue-read` (`untrusted_stripped`), `callum-flow-implementer-route`
  (`implementer_routed`) and `usage-check.sh` (`usage`), each with the type and data `translate()` made from the
  old line it wrote before ([translator.md](translator.md) has the mapping; `tests/factory-event-native.test.js`
  pins them equal). `callum-flow-design-route`, `callum-flow-regate` and `pipeline-watch.sh` no longer log: their
  states (`design_routed`, `superseded`, the watcher's run states and `watcher_error`) have no new type.
  `queue-watch.sh` keeps the old-state call (`ready --if-changed`, which has no native form); it lands only here.
  The factory loop writes natively too (dev-system#1141): its `transition`, `reviewed`, `intervention`, `requeued`,
  `abandoned`, `merged`, `closed` and `finding_handled` events (hooks/v2/events.ts, event-native.ts) carry the data
  `translate()` made from the old lines it wrote before, pinned equal by `tests/factory-loop-v2-events.test.js`; it
  no longer writes `delegated`, `fix_requested` or `merge_ready`.
  The old-state mode, `callum-flow-event <state> ...`, builds the old-format line as before (same validation and
  note checks), translates it ([translator.md](translator.md)) and appends only the new event, then touches `.wake`:
  every old-state call, from any plugin version, lands in this file and never in the old log. A state the translator
  skips writes nothing; a translator miss, or a missing node or translator, writes nothing, warns once and exits 0.
  `--new-only` is a no-op kept for older callers (it is what the mode does now), and `--new-only --new-path` is still the
  capability probe: it prints the new path with exit 0, and an older image exits 2. `--path` still prints the old log's
  path and writes nothing. Removing these options is #656.
  `--if-changed` translates first, then compares with the newest event for the same issue in this file (skipping
  `loop_entry` and `loop_passes`) and writes nothing when its `type` and `data` are the same; a missing log or no earlier
  event counts as changed. `--branch` no longer narrows the match (the envelope has no branch). So a re-armed
  `queue-watch.sh` logs nothing for a ready issue already logged with the same title, labels and parent, and logs it again
  when one of them changed. It combines with `--new-only`.
  `callum-flow-event <state> ... --data '<json object>'` hands the translator extra payload fields that only the new
  event carries: `ready` and `claimed` get the issue's `title`, `labels` and `parent` this way. Not an object: exit 2,
  nothing written. A key the type does not accept is a translator miss (no event, one warning). An older image answers
  `--data` with exit 2.
  `callum-flow-claim` and `callum-flow-sweep` read both logs under a
  source switch (`CALLUM_FLOW_CLAIM_EVENTS_SOURCE`, [replay.md](replay.md#source-switch)): `new` (the default) reads this
  file and `factory.event_log`. `old` and `shadow` read the old log and `factory.events`, which are frozen at the cutover,
  so they are no longer a way back; an invalid value still reads old (changing that is #656).
- **Shipping.** `factory-event-push-loop` (as the writer role, with `FACTORY_DB_WRITER_URL` or the
  `factory-db-writer-url` secret) keeps its own cursor in `factory/.pushed/` and stores each line's number in the file
  as `device_seq`. Set-aside lines go to `factory/.refused/<file>`. A line the database refuses is set aside with a warning naming it and its
  error, and the cursor moves on: one bad line never holds back the lines after it.
- **Checking.** `callum-flow-dual-write-check [--repo O/N] [--device D] [--since T]` compares the old table
  (`factory.events`, read with the agentsview URL; it gets no new rows since the cutover, so the check only compares
  the history before it) with `factory.event_store` (read with the reader URL only), read-only.
  Each old row goes through the translator in replay mode and is matched to the new store by `event_id`. For each old
  state it prints old lines, skipped (by skip name), expected new events, found, missing (with the ids) and translator
  misses (with their reason); new events with no old row are extras, counted per type, except a type the translator never
  makes (`TRANSLATED_TYPES`, for example `gate_run`): those are counted per type as `new-only` and never fail the check. `--device` defaults to this
  device (`DEV_MACHINE_NAME`, `hostname`, `/etc/hostname`), `--repo` to every repo, and `--since` to the device's earliest new
  event; both sides cut at the second. The verdict line is `OK` or `DIFFERENT` with `missing`, `misses`, `extras` and `new-only` counts.
  Exit 0 only when missing, misses and extras are all zero (new-only does not count), 1 when any is not, and 2 on a
  usage error, an unconfigured or unreachable store, or no new rows for the device and no `--since`.
  A `transition` with `via=dual-write` and no old row is not an extra: the backfill writes it to the new log
  only, by design.
  Events written by the native mode (`callum-flow-event --type`) have no old row and show as extras under their
  type, and so does every event written after the cutover, so the check proves dual write only for the history before it.
- **Store.** `factory.event_store`: the envelope fields and `device_seq` as columns, `data` as
  JSON, primary key `event_id`, so a re-push never makes a second row. It accepts any type and
  version; the writer and the readers are what check them.
- **View.** `factory.event_log`: one row per event, the envelope columns and `device_seq`, plus
  one column for each payload field marked `"x-column": true` in the schemas (what today's tools
  and saved queries read, and each type's counting key). Each lifted column is read from `data` by
  name whatever the version (an array field is lifted as `jsonb`); a version that renames or retypes a lifted field ships its view
  change with its schema. A column is null when the type lacks the field. Rows order by `ts`,
  `device`, `device_seq`. `ts` is `timestamptz` in Postgres and ISO text in SQLite. Shared queries
  read only the view and keep the [#644](https://github.com/cbundy/dev-system/issues/644) rules: no
  `@>`, no `DISTINCT ON`, percentiles in code.

## Adding an event

1. Add `<type>.v1.json` to `schemas/` with descriptions, an example and `x-issue`.
2. Run `npm run build:events`. It rewrites the reference, the lock, `event-schemas.ts` and
   `images/base/factory-event-shapes.json`.
3. Ship the schema in release N and let no producer write it before release N+3 (the three-minor
   reader-skew rule above), so every reader and the image's writer of the last three minors know the
   type first.
4. Write the event with `callum-flow-event --type <type> --data '<json object>' [--issue N]`. The
   writer exits 2 on a missing required field, a wrong JSON type, a missing `--issue` for an
   `x-issue: required` type or a bad option, and writes nothing.
5. Add a producer fixture to `tests/fixtures/factory-events/tool-calls.json` (the old line and the native call; `tests/factory-event-native.test.js` asserts that `translate()` makes the same type and data from the old line).

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
  `validateStrict`. The script also writes `images/base/factory-event-shapes.json` (`_generated`,
  `current` and `schemas`, the same data as JSON), which the image installs beside
  `factory-event-write.js` in `/usr/local/share/dev-system/` for the native writer.
- **Supported keywords.** The generator and the reader's validator know only these. Checked:
  `type` (a string or an array, including `"null"`), `enum`, `const`, `properties`, `required`,
  `additionalProperties: false`, `items`, `pattern`, `minimum`, `maximum`, `minLength`,
  `maxLength`, `minItems`, `maxItems` and `format: date-time`. Annotations: `$schema`, `$id`,
  `title`, `description`, `examples`, `x-column` and `x-issue` (`required`, `optional` or `none`).
  Lint fails on any other keyword.
- **Tests (`npm test`).** Every example validates strictly against its own schema and, through the
  shared reader's upgrade, against the type's current version. Every event fixture of a producer
  (`tests/factory-loop-v2-events.test.js` for the loop, `tests/factory-event-native.test.js` for the native mode, and the shell producers' own tests) goes
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
