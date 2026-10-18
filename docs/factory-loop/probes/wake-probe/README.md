# Wake probe: can a mod wake the model and get an answer back?

Step 1 of the go-ahead on 2026-10-12, and the first open risk in v2 SPEC 13.8.4. A throwaway mod
(`hooks/register.ts`), loaded in the `spike-reconcile-mod` workspace in the orchestrators' exact
launch mode (`claude --remote-control ... --dangerously-skip-permissions --resume ...`, Claude
Code 2.1.296). The raw log is [`evidence/log.jsonl`](evidence/log.jsonl).

## Results

| Question | Answer | Evidence |
|---|---|---|
| Does `$.prompt.submit` start a model turn? | **Yes.** The turn started 20 to 70 ms after the call (the session was idle) | every `submitted` line |
| What does the model see? | The text, framed: "The wake-probe plugin sent a message: ..." plus an engine note that a plugin started the turn. It shows in the transcript, so on the phone too | the spike terminal |
| Text answer (`ANSWER w2 ok`) | **Works**, three times out of three: 2 s, 12 output tokens, 370 to 630 tokens of context | `turn` lines for `w2` |
| Typed answer through a tool the mod registers (`mcp__wake-probe__answer`) | **Works when the mod is stable**: the call arrived 3.7 s after the wake, 750 tokens of context | 22:54 `answer-tool` line |
| Same, right after a load | **Failed twice.** Once right after the workspace restart, once when a file copy reloaded the mod as the turn started; the model said the tool was missing. A reload re-registers the tool, and a turn that starts in between does not get it | 22:43 and 22:46 `turn` lines |
| Hidden context for the probe's own prompt, through its own `prompt.submit` hook | **Not possible.** A plugin's own hooks do not see its own `$.prompt.submit`; the hook ran only for a prompt a person typed | the one `prompt-hook` line (origin `composer`) |
| Do other plugins' mods and timers survive? | Yes: the spike mod's timer kept its one-minute beat through `/reload-plugins` and came back after the restart | spike log |

Found on the way:

- `CLAUDE_CODE_PLUGIN_DIRS` is read when the session starts. `/reload-plugins` does not pick up a
  new folder, and a folder added later is not watched. Adding one needs a restart, and
  `coder restart spike-reconcile-mod` brought the same conversation back in 20 seconds.
- Copying a file over a loaded mod reloads it, and so does a changed `plugin.json`. Deploys
  should touch only the files that changed (a `git pull` does).
- When the model cannot do what a wake asks, it explains at length (400 output tokens). The judge
  skill has to make short answers the rule.

## What changes in the spec

- **Answers** (v2 SPEC 13.8.2): the text block (`ANSWER <id> <decision>` and optional `key: value`
  lines) is the primary channel. It survives reloads and costs least. The tool stays an accepted
  alternative.
- **Details** (v2 SPEC 13.8.1): a wake carries its details in the visible prompt text, after the
  first line, since a mod cannot attach hidden context to its own prompt. The owner sees them on
  the phone, which suits notices and judgments alike.
- **Starting** (v2 SPEC 13.2): the loop starts from `session.start` and, as a fallback, from the first
  other hook that fires (`session.append` fires every minute with the title), so it never depends
  on one event.
