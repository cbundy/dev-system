---
name: evaluate-sessions
description: >-
  Evaluate how the agent factory performed in a repo over a time window and post
  the report on a GitHub issue: throughput and lead time, first-pass gate rate,
  reviewer false positives and adjudicator agreement, token and model spend by
  role, wasted wakes, and a ranked list of gaps with evidence. Every number comes
  from the read-only `callum-flow-evaluate` tool in the base image; this skill
  adds GitHub context and the narrative. Use when asked to evaluate, audit or
  review the orchestrator and sub-agent sessions for a window, or to compare one
  window with a baseline.
version: 0.19.0
---

# evaluate-sessions: report on a window of agent work

Arguments you need (ask once if missing, otherwise do not ask):

- the repo (`owner/name`, default: the current checkout's `origin`),
- the window (`--since`, optional `--until`, ISO timestamps, UTC),
- the target issue to post the report on,
- optionally a baseline issue whose earlier report to compare with.

## The number rule

Every number in the report comes from `callum-flow-evaluate` output. Never count,
sum, average or estimate a number yourself, not even "about N". If a figure you
want is not in the output, say it is not measured and, if it matters, list the gap
as a finding ("the tool does not report X"). GitHub context (PR titles, issue
numbers, review text) is evidence for the narrative, not a source of metrics.

## 1. Run the tool

```
callum-flow-evaluate --repo <owner/name> --since <ISO> [--until <ISO>] --format json     > /tmp/eval.json
callum-flow-evaluate --repo <owner/name> --since <ISO> [--until <ISO>] --format markdown > /tmp/eval.md
```

It reads transcripts, the local event log and the no-mistakes database, makes no
network calls, and needs no flags in a normal workspace. Exit 2 is a bad argument,
exit 1 a source that exists but could not be read (report that and stop).

If `callum-flow-evaluate` is not on PATH, the image predates it. It ships in the
base image from version 2.10.0 (`images/base/VERSION`). Say which image version is
needed and stop. Never fall back to counting by hand, with `jq`, `grep` or `gh`.

Read the `sources` table first. A source marked `n/a` (no event log, no
no-mistakes database, no transcripts) makes the metrics that need it `n/a`; the
report says so rather than filling the gap.

### A window across several devices

The default event log is this device's. For a window that covers other devices'
work, export `factory.events` as JSON lines and pass it with `--events`:

```
PGSSLROOTCERT=system psql "$AGENTSVIEW_PG_URL" -At -c \
  "SELECT row_to_json(e) FROM (SELECT ts, repo, device, session_id, actor, state, issue, run_id, branch, pr, head, note
   FROM factory.events WHERE repo = '<owner/name>' ORDER BY ts) e" > /tmp/events.jsonl
callum-flow-evaluate --repo <owner/name> --since <ISO> --events /tmp/events.jsonl --format json
```

Transcripts and the no-mistakes database are always this device's.

## 2. Gather GitHub context

For the same window, with `gh` (read-only):

- PRs merged: `gh pr list --state merged --search "merged:>=<date>" --json number,title,mergedAt,headRefName`
- issues closed: `gh issue list --state closed --search "closed:>=<date>" --json number,title,closedAt`

Use them to name what shipped and to connect an issue number in the tool's tables
to its PR.

## 3. Find evidence for the gaps

From the JSON, look at:

- `waste.top_wakes`: for each of the top few, open the session transcript around
  its timestamp (session id and `ts` are in the row) and see what the wake did.
  Note what the model could have skipped (a re-armed Monitor that kept dying, a
  repeated `gh pr checks`, a notification for work already merged).
- failed or parked runs: `pipeline.by_status`, `first_pass.setback_issues`, and the
  `parked`, `failed` and `fix_requested` events for those issues in the event log.
- model mismatches in `spend.sub_agent_model_mismatches`, fallback invocations and
  review rounds in `pipeline`.

Each piece of evidence is an id someone can open: a session id with a timestamp,
a run id, a PR or issue number.

## 4. Write the report

Write exactly these sections, in this order. Paste the matching markdown tables
from `/tmp/eval.md` verbatim under each; add prose only to interpret them.

1. **Bottom line**: three to five sentences. What the factory did, the one or two
   numbers that matter most, and the top gap.
2. **Throughput and lead time**: `throughput`, with `window` counts.
3. **First-pass green rate**: `first_pass`, naming the setback issues.
4. **Reviewer false-positive rate and adjudicator agreement**: `review` and
   `adjudicator_agreement`. Say when a rate rests on very few verdicts.
5. **Token/model spend by role**: `spend`, including model mismatches.
6. **Wasted turns**: `waste` (idle wakes, re-arms, stale wakes, repeated checks, the
   top wakes), with what the evidence in step 3 showed.
7. **Ranked gaps with evidence**: highest impact first. Each gap has: the
   evidence (session, run, PR and issue ids), the impact (which number it moves),
   a one-line direction (not a design), and related issues.

If a baseline issue was given, add a short comparison after the gaps: read its
last report with `gh issue view <baseline> --comments`, and compare only the
numbers both reports contain, quoting both. Do not recompute the baseline's
numbers; if its window needs re-running, run the tool for that window.

Use plain "-" instead of the em dash.

## 5. Post it

```
gh issue comment <N> --body-file /tmp/eval-report.md
```

Post once. This skill reads and reports; it never edits code, labels or other
issues, and never merges anything.
