// The text of the owner controls (v2 SPEC 13.4.3): the op table, each op's usage and meaning, the
// `/factory help` page and the typeahead hint. control.ts parses and applies the ops; this module
// holds only what the owner reads, so the two files stay under the size guard.

export const OPS = [
  'status', 'pause', 'unpause', 'skip', 'noskip', 'priority', 'only', 'serial', 'new', 'override', 'resume', 'retry',
  'update', 'drop', 'note', 'mode', 'trace', 'config', 'stamp', 'stop-now',
] as const
export type OpName = (typeof OPS)[number]

// Each op's form, for the usage errors and the tool's description (v2 SPEC 13.4.3). `priority off`
// and `override off` are the only way to lift those two, as `only off` and `update off` are.
export const USAGE: Record<OpName, string> = {
  status: 'status',
  config: 'config [set <key> <value>|unset <key>]',
  pause: 'pause <N>',
  unpause: 'unpause <N>',
  skip: 'skip <N>',
  noskip: 'noskip <N>',
  priority: 'priority <N...>|off',
  only: 'only <N...>|off',
  serial: 'serial on|off',
  new: 'new on|off',
  override: 'override <pct> <hours>|off',
  resume: 'resume <N...> ["note"]',
  retry: 'retry <N>',
  update: 'update [<reason>]|off',
  drop: 'drop <N>',
  stamp: 'stamp <N>',
  note: 'note [<N>] <text>',
  mode: 'mode off|observe|act',
  trace: 'trace on|off',
  'stop-now': 'stop-now',
}

// The short form of each op in the typeahead placeholder, in the order it shows them. It drops
// the long forms (resume's note, override's arguments): `/factory help` has them.
export const HINT_OPS: readonly [OpName, string][] = [
  ['status', 'status'],
  ['only', 'only <N...>'],
  ['priority', 'priority <N...>'],
  ['pause', 'pause <N>'],
  ['resume', 'resume <N...>'],
  ['drop', 'drop <N>'],
  ['stamp', 'stamp <N>'],
  ['note', 'note <text>'],
  ['new', 'new on|off'],
  ['mode', 'mode off|observe|act'],
  ['config', 'config set <key> <value>'],
  ['config', 'config unset <key>'],
]

// hintText: the placeholder `/factory` shows in the typeahead, one bracketed line like `/plan`'s.
export function hintText(): string {
  return `[${[...HINT_OPS.map(([, form]) => form), 'help'].join(' | ')}]`
}

// What each op does, one line each, for `/factory help` (v2 SPEC 13.4.3).
export const MEANING: Record<OpName, string> = {
  status: "show the loop's last pass and the owner directives in force",
  config:
    'show the settings the loop runs with, each with its source; config set <key> <value> saves one in the workspace config file (a value is JSON when it parses, else text; ' +
    'checked as the loader reads it, refused if bad); config unset <key> removes it, so the repo file or the default applies again',
  pause: 'take no action on issue N (its claim still renews)',
  unpause: 'undo pause',
  skip: 'never claim issue N',
  noskip: 'undo skip',
  priority: 'claim these first, in this order; off clears it',
  only: 'claim only these, in this order (a tracker stands for its open sub-issues); off clears it',
  serial: 'on: one issue in flight at a time',
  new: 'off: claim and start nothing new (work in flight goes on)',
  override: 'run past a usage tier up to <pct> for <hours>; off ends it',
  resume: 'release what waits on you: unpark issues N (a note goes to their next step)',
  retry: "clear issue N's used-up actions, so its rules try again",
  update: 'an update is due: wind down (up to windDownMinutes), then restart the workspace; off cancels it',
  drop: 'abandon issue N: its agents stop and its claim is released (for this life only; ready brings it back)',
  stamp: 'dry-run the intake reader on one issue; writes nothing',
  note: "an instruction for issue N's agents (for every issue without N)",
  mode: 'off runs nothing, observe plans and logs only, act does the work',
  trace: "on: each pass's timing goes to trace-YYYY-MM-DD.jsonl beside the decision log",
  'stop-now': 'during a wind-down: tell the stopper not to wait for what still runs (writes wind-down.stop-now)',
}

// helpText: `/factory help`, in the shape of a command's --help, built from the same table the
// parser checks, so the two cannot drift.
export function helpText(): string {
  const rows: [string, string][] = [...OPS.map(name => [USAGE[name], MEANING[name]] as [string, string]), ['help', 'this list']]
  const width = Math.max(...rows.map(([usage]) => usage.length)) + 2
  return [
    'Usage: /factory <op> [arguments]',
    '',
    'Owner controls for the factory loop. A change is logged, wakes the loop, and applies on its next pass.',
    '',
    'Ops:',
    ...rows.map(([usage, meaning]) => `  ${usage.padEnd(width)}${meaning}`),
    '',
    'N is an issue number, with or without #; a list takes spaces or commas. In chat, the model sets',
    'the same ops through mcp__factory-loop__control with { "op": "<op>" }.',
  ].join('\n')
}
