---
name: update-dev
description: >-
  Propose a change to Callum's dev-system (the shared skills, plugin, feature,
  or templates in cbundy/dev-system) as a reviewed PR, from any repo where the
  callum-flow plugin is installed. Use when the user invokes /update-dev with a
  description of what they want changed, or asks to upstream an improvement or
  fix to the shared dev flow. Clarifies intent with the user BEFORE creating
  anything, captures the motivating context from the current session, then
  raises a PR on cbundy/dev-system. Never merges.
version: 0.2.3
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
- Do NOT bump the plugin `version` or touch release machinery. Releasing is a
  separate, deliberate step Callum runs when ready.
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
request is already satisfied upstream, say so and stop; the user just needs
the next release.

## 2. Clarify with the user BEFORE creating anything

Ask clarifying questions (use the AskUserQuestion tool) before creating any
branch or PR. Cover whatever is genuinely ambiguous, typically:

- Scope: which skill/file(s), and is this a behavior change or a wording/
  clarity fix?
- Intent edges: if the prompt admits materially different readings, present
  them as options rather than guessing.

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

## 4. What a good change looks like

Content standards for the edit itself:

- Brief. Make the smallest edit that achieves the intent. Prefer tightening an
  existing sentence over adding a new paragraph; prefer one new bullet over a
  new section. If the diff is growing past what the request strictly needs,
  cut it back.
- Toolkit-generic. dev-system is a reusable toolkit consumed by many repos.
  Never write repo-specific content into shared files: no hardcoded repo
  names, paths, commands, ports, or tool choices from the repo where the
  incident happened. Generalize to the established pattern: "consult the
  consumer repo's CLAUDE.md / config files", with concrete details framed as
  examples ("something like ..."), and conventions stated as conventions.
- In voice. Match the tone and structure of the file being edited; do not
  restructure a document to land a one-line improvement.
- Preserve hard-won detail. When editing near existing operational gotchas,
  keep them intact - do not summarize away detail that earned its place.

## 5. Raise the PR

1. Branch from up-to-date `main` in `/home/node/dev-system`, make the edits.
2. Push and open a PR against `main` with this description content:
   - A write-up of what the change hopes to achieve (60 words max).
   - If this came from a failure case: the factual write-up from step 3 of
     what happened.

## 6. Hand off

Report to the user: the PR URL and a one-line summary of the change. Remind
them that the change reaches consumers only after they merge AND the next
release bumps the plugin version - the current session keeps running on the
installed version until then.
