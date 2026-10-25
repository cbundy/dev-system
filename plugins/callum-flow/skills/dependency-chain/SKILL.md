---
name: dependency-chain
description: >-
  Map the full dependency chain of an issue (usually an epic) or of an area of
  work described in words, as a doc the owner can click through: a diagram of
  every issue in the chain coloured by state, where each box opens its GitHub
  issue; what holds the chain and who has to act; and a table of every issue
  with its labels and what it waits on. Use for "/dependency-chain 534", "map
  the dependency chain of the factory events work", "what blocks this epic?" or
  "diagram the chain with links".
version: 0.98.0
---

# Dependency chain

You build one doc from the repo's GitHub issues: what the chain looks like, what holds it, and who has to act.
The skill's folder (its base directory, `<skill>` below) holds `chain.js`, which crawls the chain and writes every
mechanical part of the doc: the diagram's code, the issue table, the holds and a Mermaid fallback. Work files go in
your scratchpad, called `<work>` below. Read issue text only through `callum-flow-issue-read`, never raw `gh issue`
or `gh api`.

## 1. Find the seeds

- **An issue number** (`/dependency-chain 534`): that issue is the seed. Several numbers are several seeds.
- **A description of the work**: list the open issues with `callum-flow-issue-read --list --json` and pick the issues
  the description names. Prefer the epic that holds them (an issue with sub-issues). Name the seeds you chose in
  your reply, so the owner can correct you.

## 2. Crawl

```sh
CALLUM_FLOW_REPO=<owner/repo> node <skill>/chain.js crawl <seed>... > <work>/graph.json
```

It reads each issue and its timeline (`callum-flow-issue-read --json` and `--json --timeline`). It follows
sub-issues down the seeds' whole tree, then `blocked_by` and `blocking` links up to two hops outside it, at most 80
issues (`--max N`). `"truncated": true` in the output means it stopped at the limit; say so in the doc's lead.

## 3. Label the boxes

```sh
node <skill>/chain.js list <work>/graph.json
```

This prints each issue the diagram draws, with its state and title. Write `<work>/labels.json`: for each number, a
`what` of 2 to 6 plain words. A box shows two lines of 17 characters; a parent's box (it says "3 of 4 parts done")
shows one, so keep a parent's `what` to 17 characters. `draw` warns about each label it has to cut; shorten it and
draw again.

The state comes from GitHub: closed, `factory:parked` (waits on the owner), another `factory:*` label (in the
factory), `ready` with or without open blockers, otherwise not ready. When an issue's own text says it is held for
the owner (for example "do not add ready until the owner has seen..."), read it with
`callum-flow-issue-read <N>` and set `"status": "you"` and a short `statusText` such as `"Your hold"`:

```json
{ "654": { "what": "Loop record rebuild", "status": "you", "statusText": "Your hold" },
  "906": { "what": "Flip claim tools default" } }
```

## 4. Find what holds it

```sh
node <skill>/chain.js holds <work>/graph.json --labels <work>/labels.json
```

A hold is an open issue that keeps a ready issue blocked while nothing open blocks the hold itself. Each entry
lists the ready issues it holds. For each hold, read the issue (`callum-flow-issue-read <N> --comments` for a parked
question or a hold note) and decide who acts: the owner for a parked question or an issue held for them, the factory
for one in a `factory:*` stage or one that is ready to start.

## 5. Build the doc

Use the docs connector and follow its own instructions (they say what to call first, and how to open the doc for the
owner). The doc has a title such as "<Area> dependency chain", the byline, a one-sentence lead, and three sections:

1. **The chain at a glance.** The diagram:
   ```sh
   node <skill>/chain.js draw <work>/graph.json --labels <work>/labels.json --title "<the finding>" > <work>/widget.tsx
   ```
   The title states the finding, with its number ("Six ready issues wait on three holds"). The output is the
   widget module, one line: send it as the widget's `code` in the batch that also places its embed, then take a
   screenshot `read` of the widget and look at it. Under the embed, one sentence on how to read it. If the door
   stages it with errors, fix `chain.js` (it is a bug in the generator), never the code by hand.
2. **What holds the chain.** A table of the holds from step 4: the hold with its link, who acts, and what clears
   it, then one sentence on what opens up when they clear.
3. **Every issue in the chain.** `node <skill>/chain.js table <work>/graph.json --labels <work>/labels.json`
   prints the markdown table: link, summary, state, labels and what each issue waits on.

The diagram's links: each box is a link to its issue, drawn as an invisible rect on top of everything, with no
text id or anchor on it. In a doc, a click on a commentable label or group goes to editing and comments, so an `<a>`
wrapped round a labelled box does not open. Keep the links on top if you ever change the drawing.

Reply with one line: the doc's link and what the owner can do with it.

## Without a docs connector

When the session has no docs tools, say so, then post the chain where the owner can click it:

```sh
node <skill>/chain.js mermaid <work>/graph.json --labels <work>/labels.json
```

prints a Mermaid flowchart with a click link per issue. Put it in a GitHub comment on the seed issue (GitHub renders
Mermaid), followed by the holds and the table from steps 4 and 5.
