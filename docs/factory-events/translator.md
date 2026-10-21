# Translator: today's lines to the new events

Temporary: this mapping and its code are deleted with the old event path
([#656](https://github.com/cbundy/dev-system/issues/656)). Nobody maintains it after the switch.

One function turns one line of today's event log into at most one new event. It runs in two
places: inside `callum-flow-event` during dual write, on the line the writer has just built
([#649](https://github.com/cbundy/dev-system/issues/649)), and over the stored history for the
replay ([#650](https://github.com/cbundy/dev-system/issues/650)). It is
[`images/base/factory-event-translate.js`](../../images/base/factory-event-translate.js)
(built in [#648](https://github.com/cbundy/dev-system/issues/648)): plain CommonJS with no
dependencies, so the image carries it and the replay script requires the same file. Inputs are
today's line keys (the jq object in `images/base/callum-flow-event`, about lines 229-236); outputs follow [`schemas/`](schemas/) and go to the
new log ([README](README.md#where-events-live)).

Rules:

- **The old line is untouched.** The new event shares its `event_id`, so old and new rows join
  one to one.
- **Never guess.** A line that does not match a shape below gives no new event: it is a miss. The
  writer warns with the state and the reason, and the replay counts misses per state. A token
  note (`transition`, `reviewed`, `intervention`, `loop`, a release) with a token the mapping does
  not name is a miss too, warned with the token's name, so a field added on the old path is never
  dropped quietly. A miss is a bug to fix in the translator or the producer. The lines under
  "Lines that make no new event" are skipped by name, not missed.
- **Old writers are dropped, not translated.** The replay starts at 2026-10-16 02:00Z (owner). A
  line from v1 or an older orchestrator in that window is one of the named skips below, so it is
  dropped and counted, never a miss. On 2026-10-16 the window held none: every line came from the
  two v2 loops, a usage watcher or a hand merge.
- **The dual-write check** ([#649](https://github.com/cbundy/dev-system/issues/649)): every old line
  is translated or skipped by name, misses are zero, and the new events of each type equal the old
  lines of the mapped state minus the named skips.
- **The replay check** ([`replay.md`](replay.md)): `scripts/factory-events-replay.js load` runs the same
  rule over the stored history into a throwaway database and prints it per old state.
- Every event it makes validates strictly against its schema; the round-trip tests check this
  ([README](README.md#keeping-the-docs-in-step)).

## The envelope

| Today | New |
|---|---|
| `v` | dropped; `envelope` is 1 |
| `event_id` | `event_id`. The replay covers lines from 2026-10-16 02:00Z, which all have one; a line without one is a miss. |
| `ts` | `ts`. In dual write, the writer's own time with milliseconds; in the replay, the stored second with `.000Z`. |
| `state` | `type`, by the tables below; `type_version` is 1 |
| `session_id` | In dual write, `CLAUDE_SESSION_ID`, else `CLAUDE_CODE_SESSION_ID`, or null, never today's guess from the newest transcript. The replay copies the stored value. |
| `repo`, `device`, `actor`, `issue`, `base_image`, `dev_image`, `template_version`, `plugin_version` | the same |
| `run_id` | dropped: v1 runs. No v2 event has one. |
| `branch`, `pr`, `head` | payload fields where the type has them, else dropped |
| `note` | payload fields, by the tables below |

**Token notes** are read as `v2/events.ts` reads them
(`plugins/factory-loop/hooks/v2/events.ts:123-188`): split on single spaces into `key=value`,
keeping the first of each key; `none` becomes null and values are percent-decoded; a list is
comma-split, then each item is decoded; `yes`/`no` become booleans; epoch milliseconds become
ISO 8601 with three millisecond digits.

## Queue and claim

| Today | New | Mapping |
|---|---|---|
| `ready` | `ready` | `{}` in replay. A dual write may add `title`, `labels` and `parent` from `callum-flow-event --data`; replay gives none. |
| `claimed` | `claimed` | `lease: <m>` gives `lease_minutes`. A null note (157 early rows) gives 120, the default when they were written. A dual write may add `title`, `labels`, `parent`, `score` and `factors` from `--data`; replay gives none. |
| `renewed` | `claim_renewed` | as `claimed` |
| `claim_lost` | `claim_lost` | `held by <dev> since <at>` gives `holder`, `holder_since` and `race` false. `race lost to <dev>` gives `holder` (null for the text "another device"), `holder_since` null and `race` true. |
| `reclaimed` | `requeued` | `lease expired` gives `reason` lease-expired and leaves the rest null except `branch` and `pr` from the columns. `reason=reconcile ...` (outcome requeue) gives `reason` reconcile plus `stage`, `lives` and `detail` (from `checked`), with `branch` and `pr` from the columns (`pr`, else the `pr=` token). |
| `closed` | `closed` | The note gives `reason`; an empty note gives null. |

## End of work

| Today | New | Mapping |
|---|---|---|
| `abandoned` | `abandoned` | The first shape that matches decides (below). `branch` and `pr` come from the columns, else from the tokens. |
| `merged` | `merged` | `pr`, `branch` and `head` come from the columns. No note gives `by` factory and `recovered` false. `merged by the factory loop` gives factory and true. `merged by hand`, or any other text (old hand rows), gives hand and true. |

The `abandoned` shapes, tried in order:

1. `reason=reconcile outcome=reject ...` gives `reason` rejected, plus `stage`, `lives` and
   `detail` (from `checked`).
2. `reason=reconcile ...`, with `outcome=leave` or no outcome (early release rows), gives
   `reason` reconcile and the same fields.
3. `reason=<r> note=<text>` gives `reason` r (dropped, split, triage or other) and `detail` text.
   A v2 split also carries `why_split`, `why_count`, `why_parts`, `why_order` and `child_whys` (a
   list in the order of `split_into`), which give the fields of the same names; each is null when
   its token is absent. Every other shape gives them null.
4. `split into <n>,<m>` gives `reason` split and `split_into` [n, m]. This is a v2 split logged
   through the v1 executor, `plugins/factory-loop/hooks/act-cli.ts:89`.
5. Any other text gives the `reason` its first word says (drop or dropped, split, triage, else
   other), as `abandonReason` does (`v2/events.ts:110-119`), and `detail` is the note.

Whenever `reason` is split, `split_into` also comes from a `split into <list>` anywhere in the
text. Otherwise it is `[]`. `stage` and `lives` are null outside reconcile and rejected.

## The loop's record, reviews and interventions

| Today | New | Mapping |
|---|---|---|
| `transition` | `transition` | `branch`, `pr` and `head` from the columns. Tokens: `life`, `seq`, `via`, `step`, `attempt`, `cut`, `triages`, `fixes`, `round`, `why`, `question`, `notes` and `lives` keep their names. Renamed: `row` to `table_row` (`recovered` passes through, `v2/rules-entry.ts:134`), `from` to `from_state`, `to` to `to_state`, `seqAt` to `seq_at` and `since` to `state_since` (both milliseconds to ISO), `resumeTo` to `resume_to`, `approvedPatch` to `approved_patch`, `brief` to `brief_url`, `prClosedAt` to `pr_closed_at` (verbatim). `wait` (optional) is one comma list: `issue:<n>` gives `issue-closed`, `pr:<n>` gives `pr-merged`, `tag:<sha>` gives `tag-contains`, the long forms `issue:<owner>/<name>#<n>` and `tag:<owner>/<name>@<sha>` add `repo` (lower-case; a `repo` key appears only then), and `none` gives null; a note without it leaves `wait` out of the event, and a malformed item (unknown prefix, bad number or sha, empty item, more than 8) is a miss naming `wait=`. `decision`, `context`, `recommended` and `recommendation` (all optional, encoded text, `none` gives null) and `options` (optional, percent-encoded compact JSON of 2 to 6 closed `{key, title, detail}` objects with distinct keys A-F, `none` gives null) are read only when present, and a note without them leaves those fields out; a malformed `options=` is a miss naming `options=`, and a `recommended=` that is not one of the option keys (or has no options) is a miss naming `recommended=`. `conflicts` (optional) is an integer read only when present; a note without it leaves the field out, and a malformed value (`x`, `-1`, `none`) is a miss naming `conflicts=`. A note without `lives` gives 1, as `parseTransition` reads older notes (`v2/events.ts:336-337`). |
| `reviewed` | `reviewed` | `branch`, `pr` and `head` from the columns. `verdict`, `round`, `patch`, `errors`, `warnings`, `infos` and `reviewer` keep their names; `answer` becomes `answer_path`. |
| `verdict` | `finding_handled` | `branch`, `pr` and `head` from the columns. `CORRECT: <id>[:] <text>` gives `outcome` fixed; `WRONG: <id>[:] <text>` gives declined. The id becomes `finding` (for example r1-2, review-4 or conflict) and the text becomes `detail`. |
| `intervention` | `intervention` | `pr` from the column. `who`, `cause`, `life` and `fact` keep their names (null when the token is missing, as for a hand rescue); `reason` becomes `detail`, and a missing `reason` gives `""`. Optional tokens: `flaky` (`yes` or `no`), `failed_tests` and `failed_jobs` (comma lists, as `child_whys`) and `head`; each is null when its token is missing or `none`. |

## Tools and housekeeping

| Today | New | Mapping |
|---|---|---|
| `implementer_routed` | same | `model`, `reason`, `bucket` (`-` becomes null), and `pct` becomes `opus_pct`. |
| `test_weakened` | same | `branch`, `pr` and `head` from the columns. `commit`, `restored` (yes/no), `kinds` and `files` (comma lists). `step` is dropped: it names a no-mistakes step and is always `none` under v2. |
| `untrusted_stripped` | same | `pr` from the column. `list stripped=N` gives `source` list and `count` N; `timeline=N` and `comments=N` likewise, with `refused` false. A bare `issue`, `pr` or `comment` gives that `source`, `refused` true and `count` null. |
| `prompt_denied`, `prompt_waiting` | same | The companion's record of a refused or waiting permission prompt ([v2 SPEC 10.10](../factory-loop/v2/SPEC.md)). `branch` and `pr` from the columns; no token is required. `life`, `seq`, `step`, `attempt`, `agent_type`, `slot`, `session` and `transcript` keep their names; `agent` becomes `agent_id` (empty or `none` gives null), `tool` becomes `tool_name`, `input` becomes `tool_input`, and a denied prompt's `why` becomes `ask_reason`. `seq` and `attempt` are integers; `none` and a missing token give null. A waiting prompt has no `ask_reason`: its `why` (always `none`) is dropped, and its `tool` must be `none` (a value is a miss, since the notification names no tool). A denied `input` over 2000 characters is a miss. Any other token is a miss. |
| `loop` (not `kind=passes`) | `loop_entry` | `kind`, `key`, `status`, `attempts`, `class`, `rule` and `wake` keep their names; `started` becomes `started_at` and `ended` becomes `ended_at` (milliseconds to ISO); `agentId` becomes `agent_id`. The `agent=` token and `out` are dropped. On a `kind=task` line with `out=wake`, `decision` and `reason` become `decision` and `decision_reason` (decoded, `none` is null, the reason cut to 200 and kept only with a decision); every other line drops them. The `run`, `pr` and `head` columns (which v2 never sets) are dropped. |
| `loop` with `kind=passes` | `loop_passes` | The loop's per-minute summary of its passes (`passesNote`, `plugins/factory-loop/hooks/passes.ts`). `from` and `to` become `from_at` and `to_at` (verbatim: already ISO with milliseconds); `passes`, `mean_ms`, `p50_ms`, `p90_ms`, `max_ms`, `acting`, `acting_mean_ms`, `idle_mean_ms`, `errors`, `mode`, `planner` and `pass_every_ms` keep their names, and `none` becomes null. Four optional tokens, `observe_mean_ms`, `observe_commands_mean_ms`, `observe_in_process_mean_ms` and `observe_in_process_max_ms`, keep their names; `none` gives null, a negative or non-integer value is a miss, and an absent token leaves the field out of the data (older loops write none of them). `key` and `status` are checked, not carried: the line is a miss unless `status=done` and `key` is `passes:<epoch ms of from>`. Any other or missing token is a miss. It is never a `loop_entry`. |
| `usage` | same | `five_hour` becomes `five_hour_pct`, `resets_at` becomes `five_hour_resets_at`, `seven_day` becomes `seven_day_pct`; `seven_day_resets_at` and `source` keep their names. `resets_in` and `seven_day_resets_in` are dropped, since each is the reset time minus `ts`. `usage=unavailable reason=a,b` gives `available` false, `reasons` [a, b] and null readings. An optional `auth=subscription|api-key` token on either shape gives `auth`. A spend reading, `auth=api-key spend_usd=N budget_usd=N|none budget_resets_at=ISO|none source=spend` (`auth`, `spend_usd` and `source` required), gives `available` true, null window fields, `reasons` [], `source` spend and the numbers as JSON numbers. A negative or non-numeric dollar value or another `auth` is a miss. |

New with no old name: `loop_passes`, from the `loop` lines with `kind=passes` (one new type, so the
summary is not a `loop_entry`, which is a ledger entry). Renamed where the old name misled:
`renewed` to `claim_renewed`; `loop` to `loop_entry`;
`reclaimed` to `requeued` (under v2, "reclaim" means the loop taking a lapsed claim back);
`verdict` to `finding_handled` (the review's verdict is `reviewed.verdict`).

## Lines that make no new event

| Today | Why |
|---|---|
| `delegated`, `fix_requested`, `merge_ready` | No longer written by the loop (dev-system#1141); old lines still translate to nothing. Each was covered by the `transition` written in the same step: to building (`brief_url` is the URL in `brief <url>`), to fixing (`via` fix:review, fix:ci, fix:conflict or triage:.., except a fix resumed after an unpark, whose via is `lease`: its kind is the `fix-cap:<kind>` via of the transition that parked it), and to merge-queue (`round` is the N in `round N`). All 164 since 2026-10-15 03:00Z have that transition within two minutes. The replay keeps checking it. Lead time, first-pass rate and fix rounds read the transitions instead ([#652](https://github.com/cbundy/dev-system/issues/652)). |
| `loop` with `kind=breaker` (`plugins/factory-loop/hooks/act.ts:356-357`) | The breaker opening is already an `intervention` with cause `breaker`. |
| `loop` with `key=cap:...` and `status=held` (`act.ts:346-352`) | A rate-cap hold is a planner notice, not a ledger entry. [#655](https://github.com/cbundy/dev-system/issues/655) removes this writer and the breaker's. |
| `loop` with kind spawn, delegate or judge; `verdict` with NIT, DUP or ENV | v1 ledger kinds and the v1 adjudicator's prefixes, last written on 2026-10-15. |
| `briefed`, `design_routed`, `run_started`, `parked`, `failed`, `head_mismatch`, `conflict`, `ci_stalled`, `rebased_behind`, `superseded`, `watcher_error` | Dead or v1-only, last written by 2026-10-15. |

Not carried over, since only v1 code reads them or they can be derived: `run_id`, the v1 `loop`
outcome token `out` (and `decision` on lines that are not task wakes), `resets_in`, and `test_weakened.step`.

## The module

`translate(line, opts)` returns exactly one of `{ event }`, `{ skip: "<name>" }` or
`{ miss: "<state>: <reason>" }`, never a partial event. It is pure: no clock, environment, file or
network reads. With no `opts` it is the replay; with `{ ts, sessionId }` it is dual write.
`node factory-event-translate.js [--ts T --session-id S] [--quiet]` reads old lines as JSONL on stdin and writes
new events as JSONL on stdout; it prints one stderr line per miss and a count per state (`--quiet` drops the counts and keeps the
miss lines, which the writer relays as its warning), and exits 1 on any miss. The writer finds it
next to itself, else in `${DEV_SYSTEM_SHARE:-/usr/local/share/dev-system}`. The tests (`tests/factory-event-translate.test.js`, corpus in
`tests/fixtures/factory-events/`) prove it against the schemas and against the plugin's own token
parse.
