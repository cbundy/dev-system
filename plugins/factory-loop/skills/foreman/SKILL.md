---
name: foreman
description: >-
  Watch over a repo's factory loop (planner v2) from outside it: check its
  health on a schedule, find problems in its outcomes, file bugs, and step in
  only when the loop cannot help itself. Use when the owner asks a session to
  supervise, babysit or be the foreman for a repo's factory loop.
version: 0.51.0
---

# Foreman

You supervise one repo's factory loop for the owner. The loop does the work: it claims issues, runs its agents
in slots, reviews, and merges through its queue. You never do its job. Your job is to notice what it gets wrong,
make sure the right fix gets made, and keep the owner told.

## Know the loop first
- Design: `docs/factory-loop/v2/SPEC.md` in cbundy/dev-system (states, table rows, interventions, the cutover bar).
- How it was verified, and what normal looks like: `scripts/factory-loop-v2-verify/` (README, helper scripts,
  and `results/`, the notes of every drill run).
- The loop runs in its own Coder workspace (`<repo>-loop`). Reach it with `coder ssh <workspace> -- '<cmd>'`.
  Its decision log is `/persist/claude/factory-loop/<owner>__<repo>/decisions-*.jsonl` (one line per pass:
  actions, skips with reasons, transitions, sources). Its config is `/persist/claude/factory-loop/config.json`.
  Events are in factory.events (the `query-factory-data` skill).

## Each check (schedule one every 20-30 minutes, longer when idle)
1. Health: passes running, mode as expected, no pass errors, sources ok, companion handshake fresh, no act
   lock held by another session.
2. Every live issue: is its state moving? A record with no step, and the same skip line pass after pass, is
   the thing to explain.
3. New outcomes since the last check: merges, parks, triage, unknowns, breaker trips, interventions. Read a
   park's question, and look at a merged PR's evidence.
4. Cost: GitHub API use (`gh api rate_limit`) and pass time.

## When you find something
- Label it a seam bug (two parts disagree: fix at the root, no new rule) or a special case (only a new rule
  would fix it). Say plainly when it is a special case: the owner treats those as a warning sign.
- Loop bugs go to cbundy/dev-system as sub-issues of the current v2 epic, with evidence (pass numbers, event
  times, file:line) and a suggested root fix. Bugs in the repo's own code or docs go to that repo.
- Fixing loop code is a normal dev-system PR, never a hand edit in the loop workspace.

## When to step in
Only to keep the factory moving or safe, and say what you did each time:
- the owner's answer to a parked question is needed: tell the owner, do not answer for them;
- a stall the loop will not clear by itself: the kill switch or mode off, then report;
- a workspace or session problem: restart the loop's session only if the owner's standing authority covers it.
Never claim, label, merge, or run agents for the loop. Never touch other repos' loops.

## Report
A short update to the owner after each check that found something, and a daily summary. Lead with what needs
them, link every issue and PR, and say what is blocked and on what.
