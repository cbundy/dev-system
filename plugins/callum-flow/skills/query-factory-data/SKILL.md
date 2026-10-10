---
name: query-factory-data
description: >-
  Answer an ad-hoc question about the agent factory from its fleet data: e2e or
  issue latency and lead time, throughput, how long work spent waiting versus
  being worked, pipeline cost, fix rounds, slow or failing gates, parked time,
  and token spend for an issue, a run or a time window. Routes the question to
  the right saved query in factory.events or the nomistakes mirror and runs it
  with dev-query. Use for a quick targeted number. For a full windowed report
  or a comparison with a baseline, use evaluate-sessions instead.
version: 0.23.0
---

# Query factory data

Answer a question about how the factory performed from the central fleet database, not
from guesses or from grepping repos. This skill is a router: it names the saved query for
each question type and the caveats to state with the number. The queries themselves live
in the metrics reference:
https://github.com/cbundy/dev-system/blob/main/docs/metrics.md

## When to use this, and when not

- Use it for a targeted question: "what has our e2e latency been over the last two days?",
  "why was the pipeline slow on #123?", "how many fix rounds does the review gate take?".
- For a full report over a window, or a comparison with a baseline, use the
  `evaluate-sessions` skill (the read-only `callum-flow-evaluate` tool) instead.

## Connect

Run every query through `dev-query` (SQL with `-c '<sql>'` or on stdin; read-only; add
`-At` or `--csv` for machine-readable output). Never call `psql` directly or look for the
database URL: it is deliberately not in the environment, and `dev-query` keeps it out of
output. `dev-query --help` lists the flags.

If `dev-query` is not found, or exits 69 (`psql` missing), the container image is older
than the base image that ships it. Rebuild or pull the container (`dev-version` compares
versions); do not install anything by hand. Exit 78 means no database URL is configured
and 77 means its secret file is unreadable or empty; report that, do not work around it.

## Question to query

Name queries by schema and title, never by bare number: both sets are numbered 1 to 7.

| Question | Source |
|---|---|
| Lead time and stage times | `factory.events`, [1. Lead time by stage](https://github.com/cbundy/dev-system/blob/main/docs/metrics.md#1-lead-time-by-stage) |
| Waiting versus working, dispatcher or gate bound | `factory.events`, [7. The waiting split](https://github.com/cbundy/dev-system/blob/main/docs/metrics.md#7-the-waiting-split) |
| Gate pass rate, fix rounds, findings, agent tokens and wall time, parked time, failure categories | `nomistakes`, the six [Saved queries](https://github.com/cbundy/dev-system/blob/main/docs/metrics.md#saved-queries) 1 to 6 by title: "First-pass rate per gate", "Fix rounds per step", "Findings per round and share dismissed", "Agent tokens and wall time", "Time parked", "Failure categories and fallback reasons" |
| Per-run lead time across both sources | `nomistakes`, [7. Run lead time joined to factory.events](https://github.com/cbundy/dev-system/blob/main/docs/metrics.md#7-run-lead-time-joined-to-factoryevents) (joins on `run_id`) |
| Full windowed report, comparison with a baseline | `evaluate-sessions` / `callum-flow-evaluate` |

Copy the query from the reference, narrow it to the repo, issue, run or window asked about,
and run it with `dev-query`. The reference explains each column and definition; do not
restate or invent your own.

## Caveats to state with any number

- `ready` is rarely logged, so `factory.events` lead time starts at `claimed`, unless
  GitHub timeline ready times are supplied (see the ready-times paragraph in
  [7. The waiting split](https://github.com/cbundy/dev-system/blob/main/docs/metrics.md#7-the-waiting-split)).
- Coverage: before quoting a window, check the earliest row per device and repo, and never
  extrapolate before it. The one-line check is
  `select device, min(ts), max(ts) from factory.events where repo = '<owner/name>' group by device`.
  Start dates are in [Data coverage](https://github.com/cbundy/dev-system/blob/main/docs/metrics.md#data-coverage).
- When a `nomistakes` column is quiet or NULL, check `runs.no_mistakes_version`: the mirror
  reads an unstable internal layout (see
  [no-mistakes pipeline data](https://github.com/cbundy/dev-system/blob/main/docs/metrics.md#no-mistakes-pipeline-data-nomistakes-schema)).
- A device whose container is stale pushes nothing, so a missing device means missing
  data, not zero work.

## How to answer

Give the number, the window it covers, the caveats that apply, and which query you used
(schema and title). If the data does not cover the window asked about, say so rather than
estimating.
