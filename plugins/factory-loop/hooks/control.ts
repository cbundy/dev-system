// The owner's controls (SPEC 4.3; DECISIONS D-15, D-16, D-33, D-35, D-38). `/factory <op>` and
// the control tool (mcp__factory-loop__control, input { op }) take the same op text: parseOp
// reads it, applyOp returns the new Control (the old one is never changed) with the effects the
// driver carries out and the one line the command or tool answers, and runOp makes the round
// trip over ActIo's readFile and writeFile: `<loop dir>/control.json`, which observe reads each
// pass, and the workspace config file for `mode`. Everything but runOp and its two file
// wrappers is pure, so the tests and the replay harness drive it without the engine.
import type { CommandSpec, ToolSpec } from 'claude-code'

import type { PassSummary } from '../types'
import { EMPTY_CONTROL, controlFrom } from './config'
import type { ActIo } from './exec'
import type { Control, Mode, Ms } from './types'

const MIN = 60_000
const HOUR = 60 * MIN
// an override longer than the seven-day usage window is a typo, not a plan (I-19)
const OVERRIDE_MAX_HOURS = 168
// a reason rides on the restart's ledger entry and the drain-slow tell; a note goes into every
// matching agent prompt (SPEC 6.3). Both are refused past these, never cut.
const REASON_MAX = 300
const NOTE_MAX = 2000

export const OPS = [
  'status', 'pause', 'unpause', 'skip', 'noskip', 'priority', 'only', 'serial', 'new', 'override', 'resume', 'retry',
  'update', 'drop', 'note', 'mode',
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
  resume: 'resume <N|run id>',
  retry: 'retry <N>',
  update: 'update [<reason>]|off',
  drop: 'drop <N>',
  note: 'note [<N>] <text>',
  mode: 'mode off|observe|act',
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
  resume: 'release a hold that waits on you (an issue, or a run by its id)',
  retry: "clear issue N's used-up actions, so its rules try again",
  update: 'an update is due: drain, then restart the workspace; off cancels it',
  drop: 'abandon issue N: its agents stop and its claim is released',
  note: "an instruction for issue N's agents (for every issue without N)",
  mode: 'off runs nothing, observe plans and logs only, act does the work',
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

// One op, parsed. An empty priority or only list clears it.
export type Op =
  | { op: 'status' }
  | { op: 'pause' | 'unpause' | 'skip' | 'noskip' | 'retry' | 'drop'; issue: number }
  | { op: 'priority' | 'only'; issues: number[] }
  | { op: 'serial' | 'new'; on: boolean }
  // null: `override off`
  | { op: 'override'; until: { pct: number; hours: number } | null }
  // 'issue:<N>' or 'run:<id>', as plan's resumes() matches them
  | { op: 'resume'; subject: string }
  // null: `update off`
  | { op: 'update'; reason: string | null }
  | { op: 'note'; issue: number | null; text: string }
  | { op: 'mode'; mode: Mode }

export type Parsed = { ok: true; op: Op } | { ok: false; error: string }

// What the driver carries out besides writing control.json: retryIssue through the ledger's
// retryIssue (D-38), mode into the workspace config file (runOp does that one).
export type Effects = { retryIssue?: number; mode?: Mode }

export type Applied = { control: Control; effects: Effects; changed: boolean; text: string }

// --- parsing ---------------------------------------------------------------------------------

const ISSUE = /^#?([1-9]\d{0,8})$/
// a pipeline run id (a ULID such as 01M4RQ0045AAAA); unprefixed, a number alone reads as an issue
const RUN_CHARS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const RUN_ID = /^(?=.*[A-Za-z])[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const DECIMAL = /^(\d+(?:\.\d+)?)$/

function issueOf(word: string | undefined): number | null {
  const m = word === undefined ? null : ISSUE.exec(word)
  return m?.[1] === undefined ? null : Number(m[1])
}

function bad(name: OpName, why?: string): Parsed {
  return { ok: false, error: `${why === undefined ? '' : `${name}: ${why}. `}Usage: ${USAGE[name]}` }
}

function allUsage(): string {
  return OPS.map(name => USAGE[name]).join(', ')
}

// parseOp: one op as the owner types it after `/factory`, or the tool's `op`. The op name and
// its keywords ignore case, numbers take an optional leading #, and a list may use commas. An
// empty op is `status`. Anything malformed is an error naming the op and its usage, so a bad
// op never makes a partial change.
export function parseOp(text: string): Parsed {
  const words = text.trim().split(/\s+/).filter(w => w !== '')
  // the model may pass the command as typed
  if (words[0]?.toLowerCase() === '/factory') words.shift()
  const head = (words[0] ?? 'status').toLowerCase()
  const args = words.slice(1)
  const rest = args.join(' ')
  const word = args.length === 1 ? args[0]?.toLowerCase() : undefined
  if (head === 'help' || head === '--help' || head === '-h') return { ok: false, error: helpText() }
  if (!(OPS as readonly string[]).includes(head)) {
    return { ok: false, error: `Unknown op "${(words[0] ?? '').slice(0, 40)}". Ops: ${allUsage()}. /factory help explains each.` }
  }
  const name = head as OpName

  switch (name) {
    case 'status':
      return args.length === 0 ? { ok: true, op: { op: 'status' } } : bad(name)
    case 'pause':
    case 'unpause':
    case 'skip':
    case 'noskip':
    case 'retry':
    case 'drop': {
      const issue = args.length === 1 ? issueOf(args[0]) : null
      return issue === null ? bad(name, 'takes one issue number') : { ok: true, op: { op: name, issue } }
    }
    case 'priority':
    case 'only': {
      if (word === 'off') return { ok: true, op: { op: name, issues: [] } }
      const items = rest.split(/[\s,]+/).filter(w => w !== '')
      const issues = items.map(issueOf)
      if (items.length === 0 || issues.some(n => n === null)) return bad(name, 'takes issue numbers, or off')
      return { ok: true, op: { op: name, issues: [...new Set(issues as number[])] } }
    }
    case 'serial':
    case 'new':
      return word === 'on' || word === 'off' ? { ok: true, op: { op: name, on: word === 'on' } } : bad(name)
    case 'override': {
      if (word === 'off') return { ok: true, op: { op: 'override', until: null } }
      const pct = args.length === 2 ? DECIMAL.exec(args[0]?.replace(/%$/, '') ?? '') : null
      const hours = args.length === 2 ? DECIMAL.exec(args[1]?.replace(/h$/i, '') ?? '') : null
      if (pct?.[1] === undefined || hours?.[1] === undefined) return bad(name, 'takes a percentage and a number of hours')
      const p = Number(pct[1])
      const h = Number(hours[1])
      if (p <= 0 || p > 100) return bad(name, 'the percentage is above 0 and at most 100')
      if (h <= 0 || h > OVERRIDE_MAX_HOURS) return bad(name, `the hours are above 0 and at most ${OVERRIDE_MAX_HOURS}`)
      return { ok: true, op: { op: 'override', until: { pct: p, hours: h } } }
    }
    case 'resume': {
      // `issue:<N>` and `run:<id>` (formatOp's spelling) are read too
      const arg = args.length === 1 ? (args[0] ?? '') : ''
      const prefixed = /^(issue|run):(.+)$/i.exec(arg)
      const kind = prefixed?.[1]?.toLowerCase()
      const value = prefixed?.[2] ?? arg
      const issue = kind === 'run' ? null : issueOf(value)
      if (issue !== null) return { ok: true, op: { op: 'resume', subject: `issue:${issue}` } }
      const run = kind === 'run' ? RUN_CHARS.test(value) : kind === undefined && RUN_ID.test(value)
      return run ? { ok: true, op: { op: 'resume', subject: `run:${value}` } } : bad(name, 'takes one issue number or run id')
    }
    case 'update':
      if (args.length === 0) return { ok: true, op: { op: 'update', reason: 'owner' } }
      if (word === 'off') return { ok: true, op: { op: 'update', reason: null } }
      if (rest.length > REASON_MAX) return bad(name, `the reason is at most ${REASON_MAX} characters`)
      return { ok: true, op: { op: 'update', reason: rest } }
    case 'note': {
      const issue = issueOf(args[0])
      const note = (issue === null ? args : args.slice(1)).join(' ')
      if (note === '') return bad(name, 'needs the text')
      if (note.length > NOTE_MAX) return bad(name, `the text is at most ${NOTE_MAX} characters`)
      return { ok: true, op: { op: 'note', issue, text: note } }
    }
    case 'mode':
      return word === 'off' || word === 'observe' || word === 'act' ? { ok: true, op: { op: 'mode', mode: word } } : bad(name)
  }
}

// formatOp: the op as canonical text, for the decision log; parseOp reads it back, but for a
// note to every issue whose text starts with a number.
export function formatOp(op: Op): string {
  switch (op.op) {
    case 'status':
      return 'status'
    case 'pause':
    case 'unpause':
    case 'skip':
    case 'noskip':
    case 'retry':
    case 'drop':
      return `${op.op} ${op.issue}`
    case 'priority':
    case 'only':
      return `${op.op} ${op.issues.length === 0 ? 'off' : op.issues.join(' ')}`
    case 'serial':
    case 'new':
      return `${op.op} ${op.on ? 'on' : 'off'}`
    case 'override':
      return op.until === null ? 'override off' : `override ${op.until.pct} ${op.until.hours}`
    case 'resume':
      return `resume ${op.subject}`
    case 'update':
      return op.reason === null ? 'update off' : `update ${op.reason}`
    case 'note':
      return `note ${op.issue === null ? '' : `${op.issue} `}${op.text}`
    case 'mode':
      return `mode ${op.mode}`
  }
}

// --- applying --------------------------------------------------------------------------------

const tags = (issues: readonly number[]) => issues.map(n => `#${n}`).join(' ')
const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i])

// applyOp: the op against the control state as it stands. The input is never changed: a change
// returns a new Control with new arrays for what changed. `changed` says whether control.json
// needs writing; an op that changes nothing (pausing a paused issue) answers so and writes
// nothing. `last` is the last pass, for status.
export function applyOp(control: Control, op: Op, now: Ms, last: PassSummary | null = null): Applied {
  const keep = (text: string, effects: Effects = {}): Applied => ({ control, effects, changed: false, text })
  const set = (patch: Partial<Control>, text: string): Applied => ({ control: { ...control, ...patch }, effects: {}, changed: true, text })

  switch (op.op) {
    case 'status':
      return keep(statusText(last, control, now))
    case 'pause':
      return control.paused.includes(op.issue)
        ? keep(`#${op.issue} is already paused.`)
        : set({ paused: [...control.paused, op.issue] }, `Paused #${op.issue}: no action on it until unpause; its claim still renews.`)
    case 'unpause':
      return control.paused.includes(op.issue)
        ? set({ paused: control.paused.filter(n => n !== op.issue) }, `Unpaused #${op.issue}.`)
        : keep(`#${op.issue} is not paused.`)
    case 'skip':
      return control.skip.includes(op.issue)
        ? keep(`#${op.issue} is already skipped.`)
        : set({ skip: [...control.skip, op.issue] }, `Skipping #${op.issue}: it is never claimed.`)
    case 'noskip':
      return control.skip.includes(op.issue)
        ? set({ skip: control.skip.filter(n => n !== op.issue) }, `#${op.issue} can be claimed again.`)
        : keep(`#${op.issue} is not skipped.`)
    case 'priority':
      if (same(control.priority, op.issues)) return keep(op.issues.length === 0 ? 'No priority is set.' : `Priority is already ${tags(op.issues)}.`)
      return op.issues.length === 0
        ? set({ priority: [] }, 'Priority cleared.')
        : set({ priority: [...op.issues] }, `Priority: ${tags(op.issues)} are claimed first, in this order.`)
    case 'only':
      if (same(control.only, op.issues)) return keep(op.issues.length === 0 ? 'Only is already off.' : `Only is already ${tags(op.issues)}.`)
      return op.issues.length === 0
        ? set({ only: [] }, 'Only off: any ready issue can be claimed.')
        : set(
            { only: [...op.issues] },
            `Only ${tags(op.issues)}: claims only these, in this order (a tracker stands for its open sub-issues); work in flight goes on.`,
          )
    case 'serial':
      if (control.serial === op.on) return keep(`Serial is already ${op.on ? 'on' : 'off'}.`)
      return set({ serial: op.on }, op.on ? 'Serial on: one issue in flight at a time.' : 'Serial off.')
    case 'new':
      if (control.noNewWork === !op.on) return keep(`New work is already ${op.on ? 'on' : 'off'}.`)
      return set(
        { noNewWork: !op.on },
        op.on ? 'New work on.' : 'New work off: no new claims, designs or implementations; work in flight goes on.',
      )
    case 'override': {
      const live = control.usageOverride !== null && now < control.usageOverride.expiresAt
      if (op.until === null) {
        if (control.usageOverride === null) return keep('No usage override is set.')
        return set({ usageOverride: null }, live ? 'Usage override cleared.' : 'Expired usage override cleared.')
      }
      const expiresAt = now + Math.round(op.until.hours * HOUR)
      return set(
        { usageOverride: { untilPct: op.until.pct, expiresAt } },
        `Usage override: run past the usage tiers up to ${op.until.pct}% until ${clock(expiresAt, now)}.`,
      )
    }
    case 'resume': {
      const what = op.subject.startsWith('issue:') ? `issue #${op.subject.slice('issue:'.length)}` : `run ${op.subject.slice('run:'.length)}`
      return set({ resumed: [...control.resumed, { subject: op.subject, at: now }] }, `Resumed ${what}: its hold is released.`)
    }
    case 'retry':
      return keep(`Retry #${op.issue}: its exhausted actions are cleared.`, { retryIssue: op.issue })
    case 'update':
      if (op.reason === null) {
        return control.updateDue === null ? keep('No update is due.') : set({ updateDue: null }, 'Update cancelled: the loop stops draining.')
      }
      return set(
        { updateDue: { reason: op.reason, at: now } },
        `Update due (${op.reason}): the loop drains, then restarts this workspace once nothing is in flight.`,
      )
    case 'drop': {
      if (control.dropped.some(d => d.issue === op.issue)) return keep(`#${op.issue} is already dropped.`)
      // a pause holds every action, the abandon too (plan's owner filter)
      const paused = control.paused.includes(op.issue) ? ` It is paused: unpause it for the abandon to run.` : ''
      return set(
        { dropped: [...control.dropped, { issue: op.issue, at: now }] },
        `Dropped #${op.issue}: the loop abandons it and stops its agents.${paused}`,
      )
    }
    case 'note':
      return set(
        { notes: [...control.notes, { issue: op.issue, text: op.text, at: now }] },
        op.issue === null ? 'Note added for every issue: the next agent prompts carry it.' : `Note added for #${op.issue}: its next agent prompts carry it.`,
      )
    case 'mode':
      return keep(`Mode ${op.mode} set in the workspace config file; it applies from the next pass.`, { mode: op.mode })
  }
}

// retryText: what `retry <N>` answers once the driver ran the ledger's retryIssue (D-38).
export function retryText(issue: number, cleared: readonly string[]): string {
  if (cleared.length === 0) return `#${issue} has no exhausted actions: nothing to clear.`
  const shown = cleared.slice(0, 3).join(', ')
  const more = cleared.length > 3 ? ` and ${cleared.length - 3} more` : ''
  const noun = cleared.length === 1 ? 'action' : 'actions'
  return `Retry #${issue}: cleared ${cleared.length} exhausted ${noun} (${shown}${more}); its rules try again from the next pass.`
}

// --- status ----------------------------------------------------------------------------------

// clock: a time as HH:MM UTC, with the date when it is not today's.
function clock(at: Ms, now: Ms): string {
  const iso = new Date(at).toISOString()
  const day = iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? '' : `${iso.slice(0, 10)} `
  return `${day}${iso.slice(11, 16)} UTC`
}

function ago(ms: Ms): string {
  if (ms < MIN) return `${Math.max(0, Math.round(ms / 1000))}s`
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`
  return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MIN)}m`
}

// directives: the control state in force, one short phrase each; an expired override is left out.
export function directives(control: Control, now: Ms): string[] {
  const out: string[] = []
  if (control.noNewWork) out.push('no new work')
  if (control.updateDue !== null) out.push(`update due since ${clock(control.updateDue.at, now)} (${control.updateDue.reason || 'no reason'})`)
  if (control.only.length > 0) out.push(`only ${tags(control.only)}`)
  if (control.priority.length > 0) out.push(`priority ${tags(control.priority)}`)
  if (control.serial) out.push('serial')
  if (control.paused.length > 0) out.push(`paused ${tags(control.paused)}`)
  if (control.skip.length > 0) out.push(`skip ${tags(control.skip)}`)
  const o = control.usageOverride
  if (o !== null && now < o.expiresAt) out.push(`usage override to ${o.untilPct}% until ${clock(o.expiresAt, now)}`)
  const dropped = [...new Set(control.dropped.map(d => d.issue))]
  if (dropped.length > 0) out.push(`dropped ${tags(dropped)}`)
  if (control.notes.length > 0) out.push(`${control.notes.length} ${control.notes.length === 1 ? 'note' : 'notes'}`)
  return out
}

// statusText: the `/factory status` answer: the last pass (PassSummary), its title, and the
// owner directives in force.
export function statusText(last: PassSummary | null, control: Control, now: Ms): string {
  const lines: string[] = []
  if (last === null) {
    lines.push('Factory loop: no pass yet.')
  } else {
    const noun = last.actions === 1 ? 'action' : 'actions'
    lines.push(`Pass ${last.pass}, ${ago(now - last.at)} ago: ${last.mode}, tier ${last.tier}, ${last.actions} ${noun}, ${last.owner} for the owner.`)
    lines.push(last.title)
  }
  const d = directives(control, now)
  lines.push(d.length === 0 ? 'Directives: none.' : `Directives: ${d.join('; ')}.`)
  return lines.join('\n')
}

// --- the files -------------------------------------------------------------------------------

export function controlPath(loopDir: string): string {
  return `${loopDir}/control.json`
}

// The workspace config file (SPEC 4.1), where `mode` lives beside repo, shadowDevice and the rest.
export function configFilePath(configDir: string): string {
  return `${configDir}/factory-loop/config.json`
}

export type LoadedControl = { control: Control; error: string | null }

// loadControl: control.json's text as Control. A missing or empty file is no directive; a
// missing or malformed field takes its empty value (controlFrom). A file that is not a JSON
// object is an error, so a write never replaces directives the owner can still recover.
export function loadControl(text: string | null): LoadedControl {
  if (text === null || text.trim() === '') return { control: EMPTY_CONTROL, error: null }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { control: EMPTY_CONTROL, error: 'control.json is not valid JSON' }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { control: EMPTY_CONTROL, error: 'control.json is not a JSON object' }
  return { control: controlFrom(raw), error: null }
}

export function controlText(control: Control): string {
  return JSON.stringify(control, null, 2) + '\n'
}

// withMode: the workspace config file's text with `mode` set and every other key kept, in place.
// A file that is not a JSON object is left alone: the owner's settings matter more than the op.
export function withMode(text: string | null, mode: Mode): { ok: true; text: string } | { ok: false; error: string } {
  let raw: unknown = {}
  if (text !== null && text.trim() !== '') {
    try {
      raw = JSON.parse(text)
    } catch {
      return { ok: false, error: 'the workspace config file is not valid JSON' }
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'the workspace config file is not a JSON object' }
  return { ok: true, text: JSON.stringify({ ...(raw as Record<string, unknown>), mode }, null, 2) + '\n' }
}

export type FileIo = Pick<ActIo, 'readFile' | 'writeFile'>

export async function readControl(io: FileIo, loopDir: string): Promise<LoadedControl> {
  return loadControl(await io.readFile(controlPath(loopDir)))
}

// writeControl: the whole file, every field (SPEC 4.3).
export async function writeControl(io: FileIo, loopDir: string, control: Control): Promise<void> {
  await io.writeFile(controlPath(loopDir), controlText(control))
}

export async function writeMode(io: FileIo, configDir: string, mode: Mode): Promise<string | null> {
  const path = configFilePath(configDir)
  const next = withMode(await io.readFile(path), mode)
  if (!next.ok) return next.error
  await io.writeFile(path, next.text)
  return null
}

// --- the command and the tool ----------------------------------------------------------------

export type ControlPaths = { loopDir: string; configDir: string }

// The caller: `last` for status; agentId when the tool call came from inside an agent's loop.
export type OpFrom = { last?: PassSummary | null; agentId?: string }

// What `/factory` or the tool answers. ping: something changed (control.json, the mode, or a
// retry to run), so the driver pings the loop and logs `logged` (SPEC 4.3). retryIssue: the
// driver runs the ledger's retryIssue and may answer retryText in place of `text`.
export type OpReply = {
  ok: boolean
  text: string
  op: Op | null
  control: Control | null
  ping: boolean
  retryIssue: number | null
  mode: Mode | null
  logged: string | null
}

const refused = (text: string, op: Op | null = null): OpReply => ({
  ok: false,
  text,
  op,
  control: null,
  ping: false,
  retryIssue: null,
  mode: null,
  logged: null,
})

// runOp: one op, start to finish: parse, read control.json, apply, write what changed. Only the
// main conversation changes directives: an agent the loop spawned may read the status, never
// set an op (SPEC 6.1: the loop's agents act on their own issue only).
export async function runOp(io: FileIo, paths: ControlPaths, input: string, now: Ms, from: OpFrom = {}): Promise<OpReply> {
  const parsed = parseOp(input)
  if (!parsed.ok) return refused(parsed.error)
  const op = parsed.op
  if (from.agentId !== undefined && op.op !== 'status') return refused('Not changed: only the main conversation sets owner directives.', op)
  let loaded: LoadedControl
  try {
    loaded = await readControl(io, paths.loopDir)
  } catch (err) {
    loaded = { control: EMPTY_CONTROL, error: `control.json could not be read (${String(err).slice(0, 200)})` }
  }
  if (op.op === 'status') {
    const text = statusText(from.last ?? null, loaded.control, now)
    const warning = loaded.error === null ? '' : `\n${loaded.error}: fix or remove it.`
    return { ok: true, text: text + warning, op, control: loaded.control, ping: false, retryIssue: null, mode: null, logged: null }
  }
  if (loaded.error !== null) return refused(`Not changed: ${loaded.error}; fix or remove it.`, op)
  const applied = applyOp(loaded.control, op, now)
  try {
    if (applied.changed) await writeControl(io, paths.loopDir, applied.control)
    if (applied.effects.mode !== undefined) {
      const error = await writeMode(io, paths.configDir, applied.effects.mode)
      if (error !== null) return refused(`Not changed: ${error}.`, op)
    }
  } catch (err) {
    return refused(`Not changed: the write failed (${String(err).slice(0, 200)}).`, op)
  }
  const ping = applied.changed || applied.effects.mode !== undefined || applied.effects.retryIssue !== undefined
  return {
    ok: true,
    text: applied.text,
    op,
    control: applied.control,
    ping,
    retryIssue: applied.effects.retryIssue ?? null,
    mode: applied.effects.mode ?? null,
    logged: ping ? formatOp(op) : null,
  }
}

// controlTool: the tool's handler: input { op: string }, then runOp.
export async function controlTool(io: FileIo, paths: ControlPaths, input: unknown, now: Ms, from: OpFrom = {}): Promise<OpReply> {
  const o = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null
  if (o === null || typeof o.op !== 'string') return refused(`Not changed: op is required, as text. Ops: ${allUsage()}`)
  return runOp(io, paths, o.op, now, from)
}

// `/factory`: immediate, so a directive typed while a long wake turn runs (a task may take
// hours) applies at once; the hook only reads and writes files.
export const FACTORY_COMMAND: CommandSpec = {
  name: 'factory',
  description:
    'Factory loop owner controls: status, pause, unpause, skip, noskip, priority, only, serial, new, override, resume, retry, update, drop, note, mode',
  argumentHint: '<op>',
  immediate: true,
}

// mcp__factory-loop__control: the same ops for the model, when the owner says so in chat (the
// judge skill's Owner chat section). Behind ToolSearch, as the answer tool is, so it costs the
// prompt nothing between directives.
export const CONTROL_TOOL: ToolSpec = {
  name: 'control',
  description:
    "Set the factory loop's owner directives (control.json) when the owner asks, as `/factory <op>` does; " +
    'one op per call, answered in one line, and a malformed op changes nothing. Ops: ' +
    'status (what the loop is doing); pause <N> / unpause <N> (no action at all on N; its claim still renews); ' +
    'skip <N> / noskip <N> (never claim N); priority <N...>|off (claim these first, in order); ' +
    'only <N...>|off (claim only these; a tracker stands for its open sub-issues); serial on|off (one issue in ' +
    'flight at a time); new on|off (off: no new claims, designs or implementations); override <pct> <hours>|off ' +
    '(run past the usage tiers up to pct for hours); resume <N|run id> (release a hold on an issue or a run); ' +
    "retry <N> (clear N's exhausted actions); update [<reason>]|off (drain, then restart this workspace for an " +
    'update); drop <N> (abandon N); note [<N>] <text> (an instruction the next agent prompts carry); ' +
    'mode off|observe|act (only when the owner asks for that mode).',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', description: 'one op as /factory takes it, e.g. "only 522" or "new off"' },
    },
    required: ['op'],
    additionalProperties: false,
  },
  isDeferred: true,
}
