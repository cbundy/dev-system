---
name: backlog-triage
description: >-
  Triage a repo's open GitHub backlog into a private decision page where the
  owner picks an outcome per issue, then apply those choices. With a direction
  from the owner (for example "clear out everything tied to the abandoned v1
  loop") it judges every issue against that direction. Without one it produces
  two lists: issues to close or rewrite because they are stale, done or written
  for old mechanics, and issues to prioritise for factory success (bugs that
  caused real trouble, significant observability, lingering epics close to
  done). Use for "triage the backlog", "clean up the issues", "what should we
  prioritise?" or "process my triage choices".
version: 0.93.0
---

# Backlog triage

Two halves, run in different turns: **build** the page (read-only on GitHub), then, when the owner says they
have chosen, **apply** their choices. Nothing on GitHub changes until the owner has picked an outcome on the page.
Invoking this skill is the owner's opt-in to the two workflows below.

The skill's folder (its base directory) holds what you need: `page.html` (the decision page), `triage-prep.js`
(batching and seeding), `triage.workflow` and `rewrite.workflow` (the Workflow scripts, run by `scriptPath`). Work
files go in your scratchpad, called `<work>` below.

## Build

### 1. Get up to date and write the brief

Sync to the default branch. Read the repo's CLAUDE.md, its architecture and spec docs, the last few weeks of merged
work (`git log --oneline --since=<4 weeks ago>`), and the owner's memory notes. Write `<work>/context.md`, at most
400 words, for agents that know nothing: how work gets done now, what was abandoned or replaced (name the files,
skills and labels), what is planned, and which owner decisions agents must not reopen. Every assessment rests on
this brief, so make it concrete.

Then decide the lists:

- **No direction:** both lists, `["cleanup", "priority"]`.
- **A direction:** keep the owner's words verbatim as `direction`. A direction about cutting ("what is not
  needed", "anything tied to X") gets `["cleanup"]`; one about pushing ("what should we do next for Y") gets
  `["priority"]`; one that asks both gets both.

### 2. Batch the open issues

```sh
callum-flow-issue-read --list --state open --json > <work>/list.json
node <skill>/triage-prep.js prep <work>/list.json <work> --batch 30
```

This writes `<work>/batches.json` (epic trees kept in one batch) and `<work>/issues.json`. Pick `--batch` so there
are three to six batches. Read issue text only through `callum-flow-issue-read`, never raw `gh issue` or `gh api`.

### 3. Run the triage workflow

`Workflow` with `scriptPath: <skill>/triage.workflow` and
`args: { repo, context: <contents of context.md>, direction: <words or "">, lists, batches: <batches.json> }`.

One agent assesses each batch and a skeptic re-checks it. With the priority list, one agent gathers the factory's
own evidence (incidents, parks, repeated failures, blind spots, epic progress) via `query-factory-data`, a ranker
keeps at most 20 candidates in order, and a skeptic challenges that order. It is read-only. When it returns, save
its result to `<work>/results.json` and check `missing`: assess any missing issue yourself before seeding.

### 4. Publish the page and seed it

Load the `artifact-design` and `artifact-capabilities` skills first. Copy `page.html` to `<work>/<name>.html` and
replace `__TITLE__` with a two-to-four-word name for this run (for example "V2 Backlog Cut"). Publish it with
`icon: "list"` and `capabilities: { db: {} }`. Then:

```sh
node <skill>/triage-prep.js seed <work>/results.json <work> --repo <owner/name> --title "<name>" \
  --lede "<one sentence: what was checked and what to pick>" [--direction "<owner's words>"]
```

It prints the paths of `writes-<k>.json` files. Pass each file's array as the `writes` of one `ArtifactData`
`batch` call to the new page's URL. Then `list` the `issues` collection to confirm the count matches.

The page reads everything from its db: `meta/page` (title, repo, lede, direction, lists), `issues/<N>` (list,
recommend, confidence, reason, evidence, tags, rewrite sketch, impact, rank, remaining sub-issues, the skeptic's
note) and `decisions/<N>` (`{choice, note}`, written by the owner). The clean-up tab groups by confidence
with a collapsed "Not affected" section, and choosing on an epic fills its undecided sub-issues. The priority tab
groups by impact (bugs, observability, lingering epics, other) in rank order. Each group has an "Accept
suggestions" button.

### 5. Remember it and report

Write a project memory: the page URL, the date, the collections, and "apply with the backlog-triage skill". Then
give the owner the link, the counts per list and group, and what to do: pick outcomes, then say to process them.

## Apply

When the owner says they have chosen, read `decisions` with `ArtifactData` (`list`, `limit: 1000`) and the
matching `issues`. Their choices are the instruction: do not ask to confirm them and do not argue with them. An
issue with no decision is left alone and named in the report.

### Close

Comment, then close, in one call: `gh issue close <N> --reason "not planned" --comment "<text>"` (use
`--reason completed` when the work is already done). Start the comment with "Closed in the backlog triage (owner
decision, <YYYY-MM-DD>)." and add one plain sentence of reason. When the owner overrode the suggestion, give their
note or "owner decision" as the reason, never the triage's argument for keeping it.

Before closing an epic, move any open sub-issue that is not also closing out from under it, so it stays visible:
`gh api -X DELETE repos/<owner>/<name>/issues/<epic>/sub_issue -F sub_issue_id=<child's numeric id>` (the `id`
field in `list.json`, not the number). A research-only issue whose question is still live stays open.

### Rewrite

Group the rewrites into themes of three to six issues and run `Workflow` with
`scriptPath: <skill>/rewrite.workflow` and `args: { repo, context, draftDir: "<work>/rewrites",
styleIssues: [two or three recent well-written issue numbers], groups: [{ name, issues: [{ n, t, reason, sketch,
note }] }] }`, putting each issue's rewrite sketch in `sketch` and the owner's note in `note`. Read every draft
yourself: it must be accurate to the code, follow the owner's note, contain no em dash and no closing keyword.
A draft that came back as `close` is closed as above with its evidence.

For each rewrite: if it is labelled `ready`, take the label off first so a loop does not claim it half-edited.
Post the original title and body as a comment inside `<details><summary>Original issue before the backlog triage
rewrite</summary>...</details>`, then `gh issue edit <N> --title "<new>" --body-file <draft body>`, then put
`ready` back. Never rewrite an issue that is in flight (a `factory:*` label or an open PR): skip it and say so.

### Prioritise, queue, not now

- **Prioritise:** add the `priority` label and `ready`. For an epic, do this to the open sub-issues named in
  its `remaining` field, not to the epic itself. If the repo has no `priority` label, add `ready` only and say so.
- **Queue:** add `ready` only.
- **Not now** and **Leave:** change nothing.

Skip anything already in flight. Post an owner's note on a prioritised or queued issue as a comment starting with
"Owner note from the backlog triage:".

### Finish

Re-list the open issues and check the counts. Update the memory with "Applied <date>" and what was done. Report
to the owner: lead with anything they still need to decide (undecided issues, skipped in-flight ones, sub-issues
left without a parent, owner decisions a rewrite deliberately kept), then the counts closed, rewritten,
prioritised and queued, and the side effects. Link every issue.
