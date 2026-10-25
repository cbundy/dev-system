---
name: factory-state
description: >-
  Say what the agent factory is doing right now: which issues are queued,
  being designed, building, reviewing, fixing, in the merge queue, parked, waiting or
  closed, which are stuck and why, which repos have only partial data, and how
  that agrees with GitHub. Runs the read-only `callum-flow-factory-state` tool
  and adds a short narrative. Use for "what is the factory doing right now?",
  "what is in flight?", "what is stuck?" or "what needs attention?". For
  historical numbers use query-factory-data, for a windowed report use
  evaluate-sessions.
version: 0.97.0
---

# Factory state: what is going on right now

One deterministic answer to "what is the factory doing right now?". The tool does all the
work; this skill runs it and tells the reader what to look at first. The definitions (the states
queued, designing, building, reviewing, fixing, merge-queue, parked, waiting and closed, source
precedence, stuck rules) are in
https://github.com/cbundy/dev-system/blob/main/docs/factory-state.md

## Run

```sh
callum-flow-factory-state --format json
```

Add `--repo <owner/name>` (repeatable) to narrow it, `--at <ISO time>` to look at a past moment
(GitHub facts are still read now), and
`--rule <state>=<minutes>` to try another stuck threshold for a state (the old S1 to S4 still work as aliases for designing, building, parked and merge-queue). Exit 2 is a bad argument. Exit 1 means the
fleet database cannot be read: say so and stop, never guess a state. This skill only reads. It
never queries tables itself, never edits labels, issues or runs, and never "fixes" a stuck item.

## Narrate (and nothing else)

Lead with what needs attention, in this order, then stop. Name each item by what it does, with
the issue number in parentheses, and say who has to act on it, especially when it is the owner:

1. `stuck` items, each with its rule (a state, such as `parked`) and the minutes in state. Name the rule's meaning, for
   example `parked` means a run has waited on an agent or the owner too long.
2. Issues in `parked`, then `merge-queue` (`waiting` is the loop's own hold on wait conditions and needs no action unless it is old), because a person or the orchestrator can act on them.
3. `flags` on any issue (label or claim disagreeing with GitHub, GitHub state unreadable): these
   are disagreements between sources, not facts about the work.

Per repo, say what its `queue` shows: the top of the claim queue, how old the snapshot is and the blocked reasons. An old snapshot or `n/a` means the loop's queue view is unknown, not empty.

Then say whether a repo has little data: the report's per-repo `coverage` notes (no events in the
database, GitHub not read) mean a gap, never idle.

Report numbers exactly as the tool prints them. Do not add states, thresholds or causes the output
does not contain. If the question is about latency, throughput or cost over time, hand off to
`query-factory-data` or `evaluate-sessions`.
