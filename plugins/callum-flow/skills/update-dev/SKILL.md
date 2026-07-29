---
name: update-dev
description: >-
  Propose a change to Callum's dev-system (the shared skills, plugin, feature,
  or templates in cbundy/dev-system) as a reviewed PR, from any repo where the
  callum-flow plugin is installed. Use when the user invokes /update-dev with a
  description of what they want changed, or asks to upstream an improvement or
  fix to the shared dev flow. Clarifies intent with the user BEFORE creating
  anything, captures the motivating context from the current session, then
  raises an issue and a linked PR on cbundy/dev-system. Never merges.
---

# update-dev: propose a change to the shared dev system

You are turning a rough request ("the orchestrator should X", "add Y to the
implement-issue quality bar") into a reviewed upstream PR on
`cbundy/dev-system`. The whole point of this skill is the upstream-not-fork
discipline: shared behavior changes land in dev-system and flow out to
consumers via a release; they are never patched locally.

Hard rules, before anything else:

- NEVER edit the installed plugin cache (`~/.claude/plugins/...`) or a consumer
  repo's local `.claude/skills/` copies. All edits happen in a working clone of
  dev-system.
- NEVER merge the PR you raise. It waits for Callum's review.
- Do not use the em dash character in anything you write; use plain "-".
- Commit messages: conventional style, never add yourself as co-author.

## 1. Sync a working clone and read the current upstream state

Clone or update dev-system at a fixed path:

```
gh repo clone cbundy/dev-system /home/node/dev-system 2>/dev/null \
  || git -C /home/node/dev-system checkout main && git -C /home/node/dev-system pull
```

Then READ the current upstream version of whatever the request targets (skill
files under `plugins/callum-flow/skills/`, `README.md`, `templates/`,
`features/`). Do not assume the installed plugin matches upstream main - the
request may be about something already changed, moved, or fixed there. If the
request is already satisfied upstream, say so and stop; the user just needs a
`/plugin marketplace update` after the next release.

## 2. Clarify with the user BEFORE creating anything

Ask clarifying questions (use the AskUserQuestion tool) before creating any
issue, branch, or PR. Cover whatever is genuinely ambiguous, typically:

- Scope: which skill/file(s), and is this a behavior change or a wording/
  clarity fix?
- Intent edges: if the prompt admits materially different readings, present
  them as options rather than guessing.
- Version bump: patch (wording/clarity fix), minor (new skill or capability),
  major (breaking change to an existing skill's contract). Recommend one based
  on the release policy in dev-system's README and let the user confirm.

Skip questions whose answer is obvious from the prompt or session - do not
interrogate the user about things they already stated. One well-chosen round
of questions, not a quiz.

## 3. Capture the motivating context

If this session contains the incident that motivated the request (an agent
misbehaved, a gap was hit mid-task, an instruction was misread), write a short
factual account: what happened, what was expected, and the repo it happened
in. This context normally evaporates and is the most valuable part of the
report. If there is no session incident (the user simply wants an
improvement), record their stated motivation instead.

## 4. Raise the issue, then the PR

1. Create a dev-system issue: what should change, why (the captured context),
   and acceptance criteria. `gh issue create -R cbundy/dev-system ...`
2. Branch from up-to-date `main` in `/home/node/dev-system`, make the edits.
3. Bump `version` in `plugins/callum-flow/.claude-plugin/plugin.json` in the
   SAME change, at the level confirmed in step 2, whenever anything under
   `plugins/callum-flow/` changed. An unbumped version ships nothing to
   consumers. Changes outside `plugins/` (templates, features, README) do not
   require a plugin bump.
4. Push and open a PR against `main`. The body MUST contain the literal line
   `Closes #<issue>` plus a brief high-level description (2-4 sentences,
   written for a head of engineering - no low-level detail).
5. Verify linkage: `gh pr view <pr> -R cbundy/dev-system --json
   closingIssuesReferences` must list the issue. Fix the body if it does not.

## 5. Hand off

Report to the user: the PR URL, the issue URL, the version bump chosen, and a
one-line summary of the change. Remind them that after they merge, consumers
pick it up with `/plugin marketplace update` (or the next auto-update), and
that the current session keeps running on the old installed version until
then.
