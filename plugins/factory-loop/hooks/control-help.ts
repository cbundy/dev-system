// The text of the owner controls (SPEC 4.3): the op table, each op's usage and meaning, the
// `/factory help` page and the typeahead hint. control.ts parses and applies the ops; this module
// holds only what the owner reads, so the two files stay under the size guard.

export const OPS = [
  'status', 'pause', 'unpause', 'skip', 'noskip', 'priority', 'only', 'serial', 'new', 'override', 'resume', 'retry',
  'update', 'drop', 'note', 'mode', 'trace', 'planner',
] as const
export type OpName = (typeof OPS)[number]

// Each op's form, for the usage errors and the tool's description (SPEC 4.3). `priority off`
// and `override off` are the only way to lift those two, as `only off` and `update off` are.
export const USAGE: Record<OpName, string> = {
  status: 'status',
  pause: 'pause <N>',
  unpause: 'unpause <N>',
  skip: 'skip <N>',
  noskip: 'noskip <N>',
  priority: 'priority <N...>|off',
  only: 'only <N...>|off',
  serial: 'serial on|off',
  new: 'new on|off',
  override: 'override <pct> <hours>|off',
  resume: 'resume <N...> ["note"]|<run id>',
  retry: 'retry <N>',
  update: 'update [<reason>]|off',
  drop: 'drop <N>',
  note: 'note [<N>] <text>',
  mode: 'mode off|observe|act',
  trace: 'trace on|off',
  planner: 'planner v1|v2',
}

// The short form of each op in the typeahead placeholder, in the order it shows them. It drops
// the long forms (resume's note and run id, override's arguments): `/factory help` has them.
export const HINT_OPS: readonly [OpName, string][] = [
  ['status', 'status'],
  ['only', 'only <N...>|off'],
  ['priority', 'priority <N...>|off'],
  ['pause', 'pause <N>'],
  ['resume', 'resume <N...>'],
  ['retry', 'retry <N>'],
  ['drop', 'drop <N>'],
  ['note', 'note [<N>] <text>'],
  ['new', 'new on|off'],
  ['mode', 'mode off|observe|act'],
  ['update', 'update|off'],
]

// hintText: the placeholder `/factory` shows in the typeahead, one bracketed line like `/plan`'s.
export function hintText(): string {
  return `[${[...HINT_OPS.map(([, form]) => form), 'help'].join(' | ')}]`
}

// What each op does, one line each, for `/factory help` (SPEC 4.3).
export const MEANING: Record<OpName, string> = {
  status: "show the loop's last pass and the owner directives in force",
  pause: 'take no action on issue N (its claim still renews)',
  unpause: 'undo pause',
  skip: 'never claim issue N',
  noskip: 'undo skip',
  priority: 'claim these first, in this order; off clears it',
  only: 'claim only these, in this order (a tracker stands for its open sub-issues); off clears it',
  serial: 'on: one issue in flight at a time',
  new: 'off: claim and start nothing new (work in flight goes on)',
  override: 'run past a usage tier up to <pct> for <hours>; off ends it',
  resume: 'release what waits on you: under planner v2, unpark issues N (a note goes to their next step); under v1, a hold on an issue or a run',
  retry: "clear issue N's used-up actions, so its rules try again",
  update: 'an update is due: drain, then restart the workspace; off cancels it',
  drop: 'abandon issue N: its agents stop and its claim is released (under planner v2, for this life only; ready brings it back)',
  note: "an instruction for issue N's agents (for every issue without N)",
  mode: 'off runs nothing, observe plans and logs only, act does the work',
  trace: "on: each pass's timing goes to trace-YYYY-MM-DD.jsonl beside the decision log",
  planner: 'the layer that plans and acts, in the workspace config file; v1 may run the v2 shadow beside it',
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
