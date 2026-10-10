---
name: factory-state
description: >-
  Say what the agent factory is doing right now: which issues are queued,
  being designed, being implemented, in the pipeline, parked, ready to merge or
  merged, which are stuck and why, which repos have only partial data, and how
  that agrees with GitHub. Runs the read-only `callum-flow-factory-state` tool
  and adds a short narrative. Use for "what is the factory doing right now?",
  "what is in flight?", "what is stuck?" or "what needs attention?". For
  historical numbers use query-factory-data, for a windowed report use
  evaluate-sessions.
version: 0.25.0
---

# Factory state: what is going on right now

One deterministic answer to "what is the factory doing right now?". The tool does all the
work; this skill runs it and tells the reader what to look at first. The definitions (stages,
source precedence, stuck rules, coverage classes) are in
https://github.com/cbundy/dev-system/blob/main/docs/factory-state.md

## Run

```sh
callum-flow-factory-state --format json
```

Add `--repo <owner/name>` (repeatable) to narrow it, `--at <ISO time>` to look at a past moment
(pipeline facts are then marked approximate, and GitHub facts are still read now), and
`--rule S1=<minutes>` to try another stuck threshold. Exit 2 is a bad argument. Exit 1 means the
fleet database cannot be read: say so and stop, never guess a state. This skill only reads. It
never queries tables itself, never edits labels, issues or runs, and never "fixes" a stuck item.

## Narrate (and nothing else)

Lead with what needs attention, in this order, then stop:

1. `stuck` items, each with its rule and the minutes in stage. Name the rule's meaning, for
   example S3 means a pipeline run has waited on an agent or the owner too long.
2. Issues in `parked`, then `ready to merge`, because a person or the orchestrator can act on them.
3. `flags` on any issue (label or claim disagreeing with GitHub, GitHub state unreadable): these
   are disagreements between sources, not facts about the work.

Then one short line per repo on **coverage**, because a gap must never read as idle:

- `pipeline only`: the repo has runs but no factory events, so claims, delegation and queue state
  are unknown.
- `events only`: no mirrored runs, so pipeline stages are only what agents logged.
- `none`: nothing in the database for the repo.
- `workers` reading `n/a` means there is no worker heartbeat yet: say liveness is unknown, do not
  say workers are healthy. Rule S6 is then not evaluated.
- `approximate` pipeline facts mean the question was asked about a past time.

Report numbers exactly as the tool prints them. Do not add stages, thresholds or causes the output
does not contain. If the question is about latency, throughput or cost over time, hand off to
`query-factory-data` or `evaluate-sessions`.
