# Translator: today's lines to the new events

Temporary: this mapping and its code are deleted with the old event path
([#656](https://github.com/cbundy/dev-system/issues/656)). Nobody maintains it after the switch.

One function turns one line of today's event log into at most one new event. It runs in two
places: inside `callum-flow-event` during dual write, on the line the writer has just built
([#649](https://github.com/cbundy/dev-system/issues/649)), and over the stored history for the
replay ([#650](https://github.com/cbundy/dev-system/issues/650)). It is built in
[#648](https://github.com/cbundy/dev-system/issues/648). Inputs are today's line keys
(`images/base/callum-flow-event:226-230`); outputs follow [`schemas/`](schemas/) and go to the
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
- Every event it makes validates strictly against its schema; the round-trip tests check this
  ([README](README.md#keeping-the-docs-in-step)).

## The envelope

| Today | New |
|---|---|
| `v` | dropped; `envelope` is 1 |
| `event_id` | `event_id`. The replay covers lines from 2026-10-16 02:00Z, which all have one; a line without one is a miss. |
| `ts` | `ts`. In dual write, the writer's own time with milliseconds; in the replay, the stored second with `.000Z`. |
| `state` | `type`, by the tables below; `type_version` is 1 |
| `session_id` | In dual write, `CLAUDE_SESSION_ID` or null, never today's guess from the newest transcript. The replay copies the stored value. |
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
| `ready` | `ready` | `{}` |
| `claimed` | `claimed` | `lease: <m>` gives `lease_minutes`. A null note (157 early rows) gives 120, the default when they were written. |
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
4. `split into <n>,<m>` gives `reason` split and `split_into` [n, m]. This is a v2 split logged
   through the v1 executor, `plugins/factory-loop/hooks/act-cli.ts:89`.
5. Any other text gives the `reason` its first word says (drop or dropped, split, triage, else
   other), as `abandonReason` does (`v2/events.ts:110-119`), and `detail` is the note.

Whenever `reason` is split, `split_into` also comes from a `split into <list>` anywhere in the
text. Otherwise it is `[]`. `stage` and `lives` are null outside reconcile and rejected.

## The loop's record, reviews and interventions

| Today | New | Mapping |
|---|---|---|
| `transition` | `transition` | `branch`, `pr` and `head` from the columns. Tokens: `life`, `seq`, `via`, `step`, `attempt`, `cut`, `triages`, `fixes`, `round`, `why`, `question`, `notes` and `lives` keep their names. Renamed: `row` to `table_row` (`recovered` passes through, `v2/rules-entry.ts:134`), `from` to `from_state`, `to` to `to_state`, `seqAt` to `seq_at` and `since` to `state_since` (both milliseconds to ISO), `resumeTo` to `resume_to`, `approvedPatch` to `approved_patch`, `brief` to `brief_url`, `prClosedAt` to `pr_closed_at` (verbatim). A note without `lives` gives 1, as `parseTransition` reads older notes (`v2/events.ts:336-337`). |
| `reviewed` | `reviewed` | `branch`, `pr` and `head` from the columns. `verdict`, `round`, `patch`, `errors`, `warnings`, `infos` and `reviewer` keep their names; `answer` becomes `answer_path`. |
| `verdict` | `finding_handled` | `branch`, `pr` and `head` from the columns. `CORRECT: <id>[:] <text>` gives `outcome` fixed; `WRONG: <id>[:] <text>` gives declined. The id becomes `finding` (for example r1-2, review-4 or conflict) and the text becomes `detail`. |
| `intervention` | `intervention` | `pr` from the column. `who`, `cause`, `life` and `fact` keep their names (null when the token is missing, as for a hand rescue); `reason` becomes `detail`, and a missing `reason` gives `""`. |

## Tools and housekeeping

| Today | New | Mapping |
|---|---|---|
| `implementer_routed` | same | `model`, `reason`, `bucket` (`-` becomes null), and `pct` becomes `opus_pct`. |
| `test_weakened` | same | `branch`, `pr` and `head` from the columns. `commit`, `restored` (yes/no), `kinds` and `files` (comma lists). `step` is dropped: it names a no-mistakes step and is always `none` under v2. |
| `untrusted_stripped` | same | `pr` from the column. `list stripped=N` gives `source` list and `count` N; `timeline=N` and `comments=N` likewise, with `refused` false. A bare `issue`, `pr` or `comment` gives that `source`, `refused` true and `count` null. |
| `loop` | `loop_entry` | `kind`, `key`, `status`, `attempts`, `class`, `rule` and `wake` keep their names; `started` becomes `started_at` and `ended` becomes `ended_at` (milliseconds to ISO); `agentId` becomes `agent_id`. The `agent=` token and the `run`, `pr` and `head` columns (which v2 never sets) are dropped. |
| `usage` | same | `five_hour` becomes `five_hour_pct`, `resets_at` becomes `five_hour_resets_at`, `seven_day` becomes `seven_day_pct`; `seven_day_resets_at` and `source` keep their names. `resets_in` and `seven_day_resets_in` are dropped, since each is the reset time minus `ts`. `usage=unavailable reason=a,b` gives `available` false, `reasons` [a, b] and null readings. |

Renamed where the old name misled: `renewed` to `claim_renewed`; `loop` to `loop_entry`;
`reclaimed` to `requeued` (under v2, "reclaim" means the loop taking a lapsed claim back);
`verdict` to `finding_handled` (the review's verdict is `reviewed.verdict`).

## Lines that make no new event

| Today | Why |
|---|---|
| `delegated`, `fix_requested`, `merge_ready` | Each is covered by the `transition` written in the same step: to building (`brief_url` is the URL in `brief <url>`), to fixing (`via` fix:review, fix:ci, fix:conflict or triage:.., except a fix resumed after an unpark, whose via is `lease`: its kind is the `fix-cap:<kind>` via of the transition that parked it), and to merge-queue (`round` is the N in `round N`). All 164 since 2026-10-15 03:00Z have that transition within two minutes. The replay keeps checking it. Lead time, first-pass rate and fix rounds read the transitions instead ([#652](https://github.com/cbundy/dev-system/issues/652)). |
| `loop` with `kind=breaker` (`plugins/factory-loop/hooks/act.ts:356-357`) | The breaker opening is already an `intervention` with cause `breaker`. |
| `loop` with `key=cap:...` and `status=held` (`act.ts:346-352`) | A rate-cap hold is a planner notice, not a ledger entry. [#655](https://github.com/cbundy/dev-system/issues/655) removes this writer and the breaker's. |
| `loop` with kind spawn, delegate or judge; `verdict` with NIT, DUP or ENV | v1 ledger kinds and the v1 adjudicator's prefixes, last written on 2026-10-15. |
| `prompt_denied`, `prompt_waiting` | The companion's record of a refused or waiting permission prompt ([v2 SPEC 10.10](../factory-loop/v2/SPEC.md)), first written on 2026-10-16. No new-format event type exists for them yet, so they are skipped by name, not missed. The same refusal is also an `intervention` with cause `prompt-denied`, which does translate. |
| `briefed`, `design_routed`, `run_started`, `parked`, `failed`, `head_mismatch`, `conflict`, `ci_stalled`, `rebased_behind`, `superseded`, `watcher_error` | Dead or v1-only, last written by 2026-10-15. |

Not carried over, since only v1 code reads them or they can be derived: `run_id`, the v1 `loop`
outcome tokens, `resets_in`, and `test_weakened.step`.
