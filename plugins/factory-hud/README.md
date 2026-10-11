# factory-hud

A Claude Code mod that keeps a one-line readout on screen:

```text
20:41  ctx 42%  5h 73%  7d 53%  | 6 live: design 2 dev 1 pipe 2 merge 1 | queued 2  | cc 2.1.296 flow 0.27.0 img 2.27.0 nm 1.84.0
```

- the time (in the workspace's `TZ`), the context window fill, and the plan's 5-hour and
  7-day usage;
- for an orchestrator, the factory's counts for the session's repo, by
  [`callum-flow-factory-state`](../../docs/factory-state.md) stage: `live` is every active
  stage, `design` designing, `dev` implementing, `pipe` in pipeline plus parked, `merge` ready
  to merge. Refreshed every minute; counts older than five minutes show their age;
- the versions of Claude Code, callum-flow, the base image and no-mistakes.

It also shows a toast, once per conversation, when the context passes 85% or a usage window
passes 90%.

It only draws. Nothing it shows reaches the conversation, and it never calls a model.

Unlike [`dev-statusline`](../../images/base/README.md#dev-statusline), which only the
terminal draws, a mod is drawn by every client the session shows on: the terminal, the
desktop app, VS Code and the Claude mobile app through Remote Control.

## Turn it on

It ships in the `callum` marketplace that every dev-system workspace already has, from the
first release that includes it. It is opt-in: install it where you want it.

**An orchestrator workspace (Coder).** Install it once, at user scope, from the workspace's
own Claude session: attach to it (`coder ssh <workspace> -- tmux attach -t claude`) and type

```text
/plugin install factory-hud@callum
```

and pick the user scope. It runs from then on, in that session and every later one. From a
shell in the workspace instead: `claude plugin install factory-hud@callum --scope user`, then
`/reload-plugins` in the session (from the terminal, the phone or claude.ai). The counts show
on their own there, since the workspace runs with `DEV_ROLE=orchestrator`.

**Watching it from your phone or the desktop app.** Nothing to install on that side: the mod
runs where the session runs (the workspace), and the app you watch from draws its readout.
Open the session in the Claude app or claude.ai as usual.

**Local sessions on your own machine (terminal or the desktop app's Code tab).** Install it
from a terminal, `claude plugin install factory-hud@callum --scope user`; the desktop app's
local sessions load it too. (`/plugin` does not work inside the desktop app.)

## Use it

- `/hud` hides it in the current conversation, and shows it again. It answers with a toast,
  so the conversation stays untouched.
- The `factory` option picks when the counts show: `auto` (the default: when `DEV_ROLE` is
  `orchestrator`), `on` or `off`. Change it in `/config`, or from the phone with
  `/config factory-hud.factory=on`.
- Uninstall with `claude plugin uninstall factory-hud@callum`.

## How it works

- The context and usage figures come from Claude Code itself (`$.session.usage()`, then the
  `session.measure` event each time they move), so they cost nothing.
- The counts come from `callum-flow-factory-state --repo <origin> --github off`, run once a
  minute in the background, so the line never waits on the database. A failed read keeps the
  last counts.
- The versions come from `dev-version`'s snapshot (`DEV_VERSIONS_FILE`, default
  `/tmp/dev-versions.json`); outside a dev-system image it shows Claude Code's alone.

## Develop it

`claude --plugin-dir plugins/factory-hud` loads this checkout's copy for one session and
reloads it as files change. `npm test` validates it and runs `tests/*.test.ts` through
`claude plugin validate` and `claude plugin test`.
