// The owner's controls (v2 SPEC 13.4.3; DECISIONS D-15, D-16, D-33, D-35, D-38). `/factory <op>` and
// the control tool (mcp__factory-loop__control, input { op }) take the same op text: parseOp
// reads it, applyOp returns the new Control (the old one is never changed) with the effects the
// driver carries out and the one line the command or tool answers, and runOp makes the round
// trip over ActIo's readFile and writeFile: `<loop dir>/control.json`, which observe reads each
// pass, and the workspace config file for `mode` and `trace`. Everything but runOp and
// its two file wrappers is pure, so the tests and the replay harness drive it without the engine.
// Three ops take v2's meaning (v2 SPEC appendix E), which v2/ops.ts holds: `resume <N...> ["note"]`
// unparks (P1), `drop` closes the current life's record (E1), and an issue that is not parked is
// not resumed.
import type { CommandSpec, ToolSpec } from 'claude-code'

import type { PassSummary } from '../types'
import { EMPTY_CONTROL, loadConfig } from './config'
import { DEFAULT_POOL_SIZE, checkKey, checkSetting, effectText, withoutSetting, shown, valueIn, valueOfText } from './config-keys'
import { clock, configText } from './config-view'
import type { ConfigView } from './config-view'
import { readControl, writeControl, writeKey, writeSetting } from './control-files'
import type { FileIo, LoadedControl } from './control-files'
import { configHelpText } from './config-help'
import { CONFIG_VERBS, HELP_TOPICS, HELP_USAGE, OPS, USAGE, helpText, hintText } from './control-help'
import type { HelpTopic, OpName } from './control-help'
import type { Control, Mode, Ms } from './types'
import { refusedText, uncheckedText } from './update-check'
import type { RestartCheck } from './update-check'
import { applyDrop, applyUnpark, onlyParked, parseUnpark, quoteNote, stopNow } from './v2/ops'
import type { Unpark } from './v2/ops'

const MIN = 60_000
const HOUR = 60 * MIN
// an override longer than the seven-day usage window is a typo, not a plan (I-19)
const OVERRIDE_MAX_HOURS = 168
// a reason rides on the restart's ledger entry and the drain-slow tell; a note goes into every
// matching agent prompt (v2 SPEC 13.6.3). Both are refused past these, never cut.
const REASON_MAX = 300
const NOTE_MAX = 2000

export { configFilePath, controlPath, controlText, loadControl, readControl, withMode, withSetting, writeControl, writeKey, writeSetting } from './control-files'
export type { FileIo, LoadedControl, SettingKey } from './control-files'
export { CONFIG_VERBS, HELP_TOPICS, HELP_USAGE, HINT_OPS, MEANING, OPS, USAGE, helpText, hintText } from './control-help'
export type { HelpTopic, OpName } from './control-help'

// One op, parsed. An empty priority or only list clears it.
export type Op =
  | { op: 'status' | 'stop-now' }
  // no change: the read-only view; a change sets a key in the workspace config file, or removes it
  // (no value). The key is as typed (`passEvery`, `stateTimeout.design`)
  | { op: 'config'; change?: { key: string; value?: unknown } }
  // help config: the list of every setting; no topic: the op table
  | { op: 'help'; topic?: HelpTopic }
  | { op: 'pause' | 'unpause' | 'skip' | 'noskip' | 'retry' | 'drop' | 'stamp'; issue: number }
  | { op: 'priority' | 'only'; issues: number[] }
  | { op: 'serial' | 'new' | 'trace'; on: boolean }
  // null: `override off`
  | { op: 'override'; until: { pct: number; hours: number } | null }
  // null: `update off`
  | { op: 'update'; reason: string | null }
  // null: `note [N] off`
  | { op: 'note'; issue: number | null; text: string | null }
  | { op: 'mode'; mode: Mode }
  // resume (v2/ops.ts)
  | Unpark

export type Parsed = { ok: true; op: Op } | { ok: false; error: string }

// What the driver carries out besides writing control.json: retryIssue through the ledger's
// retryIssue (D-38), mode and trace into the workspace config file (runOp does those).
export type Setting = { key: string; fileKey: string; sub: string | null }
export type Effects = { retryIssue?: number; mode?: Mode; trace?: boolean; setting?: { k: Setting; value?: unknown } }

export type Applied = { control: Control; effects: Effects; changed: boolean; text: string }

// --- parsing ---------------------------------------------------------------------------------

const ISSUE = /^#?([1-9]\d{0,8})$/
const DECIMAL = /^(\d+(?:\.\d+)?)$/

function issueOf(word: string | undefined): number | null {
  const m = word === undefined ? null : ISSUE.exec(word)
  return m?.[1] === undefined ? null : Number(m[1])
}

function bad(name: OpName, why?: string): Parsed {
  return { ok: false, error: `${why === undefined ? '' : `${name}: ${why}. `}Usage: ${USAGE[name]}` }
}

function helpOf(op: { topic?: HelpTopic }): string {
  return op.topic === 'config' ? configHelpText() : helpText()
}

function allUsage(): string {
  return OPS.map(name => USAGE[name]).join(', ')
}

// parseOp: one op as the owner types it after `/factory`, or the tool's `op`. The op name and
// its keywords ignore case, numbers take an optional leading #, and a list may use commas. An
// empty op is `status`. Anything malformed is an error naming the op and its usage, so a bad
// op never makes a partial change. `resume` takes issue numbers and an optional note in double
// quotes, where `\"` is a `"` and `\\` a `\`. A note's text is kept as typed (only its ends are trimmed).
export function parseOp(text: string): Parsed {
  const words = text.trim().split(/\s+/).filter(w => w !== '')
  // the model may pass the command as typed
  if (words[0]?.toLowerCase() === '/factory') words.shift()
  const head = (words[0] ?? 'status').toLowerCase()
  const args = words.slice(1)
  const rest = args.join(' ')
  const raw = (/^(?:\/factory\s+)?\S+\s*([\s\S]*)$/i.exec(text.trim())?.[1] ?? '')
  const word = args.length === 1 ? args[0]?.toLowerCase() : undefined
  if (head === 'help' || head === '--help' || head === '-h') {
    if (args.length === 0) return { ok: true, op: { op: 'help' } }
    const topic = HELP_TOPICS.find(t => t === word)
    return topic === undefined ? { ok: false, error: `Usage: ${HELP_USAGE}` } : { ok: true, op: { op: 'help', topic } }
  }
  if (!(OPS as readonly string[]).includes(head)) {
    return { ok: false, error: `Unknown op "${(words[0] ?? '').slice(0, 40)}". Ops: ${allUsage()}. /factory help explains each.` }
  }
  const name = head as OpName

  switch (name) {
    case 'status':
    case 'stop-now':
      return args.length === 0 ? { ok: true, op: { op: name } } : bad(name)
    case 'config': {
      if (args.length === 0) return { ok: true, op: { op: 'config' } }
      const verb = args[0]?.toLowerCase()
      const key = args[1]
      if (verb === CONFIG_VERBS[1] && key !== undefined && args.length === 2) return { ok: true, op: { op: 'config', change: { key } } }
      if (verb === CONFIG_VERBS[0] && key !== undefined && args.length > 2) return { ok: true, op: { op: 'config', change: { key, value: valueOfText(args.slice(2).join(' ')) } } }
      return bad(name)
    }
    case 'pause':
    case 'unpause':
    case 'skip':
    case 'noskip':
    case 'retry':
    case 'drop':
    case 'stamp': {
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
    case 'trace':
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
      const unpark = parseUnpark(rest, issueOf, NOTE_MAX)
      return typeof unpark === 'string' ? bad(name, unpark) : { ok: true, op: unpark }
    }
    case 'update':
      if (args.length === 0) return { ok: true, op: { op: 'update', reason: 'owner' } }
      if (word === 'off') return { ok: true, op: { op: 'update', reason: null } }
      if (rest.length > REASON_MAX) return bad(name, `the reason is at most ${REASON_MAX} characters`)
      return { ok: true, op: { op: 'update', reason: rest } }
    case 'note': {
      const issue = issueOf(args[0])
      const note = (issue === null ? raw : raw.replace(/^\S+\s*/, '')).trim()
      if (note === '') return bad(name, 'needs the text')
      if (note === 'off') return { ok: true, op: { op: 'note', issue, text: null } }
      if (note.length > NOTE_MAX) return bad(name, `the text is at most ${NOTE_MAX} characters`)
      return { ok: true, op: { op: 'note', issue, text: note } }
    }
    case 'mode':
      return word === 'off' || word === 'observe' || word === 'act' ? { ok: true, op: { op: 'mode', mode: word } } : bad(name)
  }
}

// issuesOf: the issues an op names, which its intervention attaches to (v2 SPEC 7.2); none for a
// fleet-level op.
export function issuesOf(op: Op): number[] {
  if ('issue' in op) return op.issue === null ? [] : [op.issue]
  if ('issues' in op) return [...op.issues]
  return []
}

// formatOp: the op as canonical text, for the decision log; parseOp reads it back, but for a
// note to every issue whose text starts with a number.
export function formatOp(op: Op): string {
  switch (op.op) {
    case 'status':
    case 'stop-now':
      return op.op
    case 'config':
      if (op.change === undefined) return 'config'
      return 'value' in op.change ? `config set ${op.change.key} ${JSON.stringify(op.change.value)}` : `config unset ${op.change.key}`
    case 'help':
      return op.topic === undefined ? 'help' : `help ${op.topic}`
    case 'pause':
    case 'unpause':
    case 'skip':
    case 'noskip':
    case 'retry':
    case 'drop':
    case 'stamp':
      return `${op.op} ${op.issue}`
    case 'priority':
    case 'only':
      return `${op.op} ${op.issues.length === 0 ? 'off' : op.issues.join(' ')}`
    case 'serial':
    case 'new':
    case 'trace':
      return `${op.op} ${op.on ? 'on' : 'off'}`
    case 'override':
      return op.until === null ? 'override off' : `override ${op.until.pct} ${op.until.hours}`
    case 'update':
      return op.reason === null ? 'update off' : `update ${op.reason}`
    case 'note':
      return `note ${op.issue === null ? '' : `${op.issue} `}${op.text === null ? 'off' : op.text}`
    case 'mode':
      return `mode ${op.mode}`
    case 'unpark':
      return `resume ${op.issues.join(' ')}${op.note === null ? '' : ` "${quoteNote(op.note)}"`}`
  }
}

// --- applying --------------------------------------------------------------------------------

const tags = (issues: readonly number[]) => issues.map(n => `#${n}`).join(' ')
const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i])

// applyChange: `config set|unset`: the key and value checked as loadConfig reads them, then the
// answer (the old value in force, the new one, when it applies) and the effect runOp writes. A
// refusal answers why and has no effect.
function applyChange(control: Control, change: { key: string; value?: unknown }, view: ConfigView | null): Applied {
  const set = 'value' in change
  const checked = set ? checkSetting(change.key, change.value) : checkKey(change.key)
  if (!checked.ok) return { control, effects: {}, changed: false, text: checked.error }
  const { key, sub } = checked
  const now = (config: Parameters<typeof valueIn>[0] | undefined) => (config === undefined ? undefined : valueIn(config, key, sub))
  // the value in force, and what an unset leaves in force: the repo's, else the default
  const was = key === 'poolSize' ? view?.poolSize : now(view?.config)
  const after = set ? change.value : key === 'poolSize' ? DEFAULT_POOL_SIZE : now(loadConfig(view?.repoRaw ?? {}, withoutSetting(view?.workspaceRaw ?? {}, checked)).config)
  const name = sub === null ? change.key : `${checked.fileKey}.${sub}`
  const text = `${set ? 'Set' : 'Unset'} ${name}: was ${was === undefined ? 'unknown' : shown(key, was)}, now ${shown(key, after)}; ${effectText(key)}.`
  const setting = { k: { key, fileKey: checked.fileKey, sub }, ...(set ? { value: change.value } : {}) }
  return { control, effects: { setting }, changed: false, text }
}

// applyOp: the op against the control state as it stands. The input is never changed: a change
// returns a new Control with new arrays for what changed. `changed` says whether control.json
// needs writing; an op that changes nothing (pausing a paused issue) answers so and writes
// nothing. `last` is the last pass, for status. A drop applies to the life it closes, so a drop of
// an issue claimed again since is recorded again (v2 SPEC 4.1).
export function applyOp(control: Control, op: Op, now: Ms, last: PassSummary | null = null, view: ConfigView | null = null): Applied {
  const keep = (text: string, effects: Effects = {}): Applied => ({ control, effects, changed: false, text })
  const set = (patch: Partial<Control>, text: string): Applied => ({ control: { ...control, ...patch }, effects: {}, changed: true, text })

  switch (op.op) {
    case 'status':
      return keep(statusText(last, control, now))
    case 'config':
      return op.change === undefined ? keep(configText(view, control, now)) : applyChange(control, op.change, view)
    case 'help':
      return keep(helpOf(op))
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
    case 'stamp': return keep('Stamp is started by the driver (driver-stamp.ts).')
    case 'retry':
      return keep(`Retry #${op.issue}: its exhausted actions are cleared.`, { retryIssue: op.issue })
    case 'update':
      if (op.reason === null) {
        if (control.updateDue === null) return control.updateFailed === null ? keep('No update is due.') : set({ updateFailed: null }, 'Update failure notice cleared.')
        return set({ updateDue: null, updateFailed: null }, 'Update cancelled: the loop stops draining.')
      }
      return set(
        { updateDue: { reason: op.reason, at: now }, updateFailed: null },
        `Update due (${op.reason}): the loop winds down (up to windDownMinutes), then restarts this workspace.`,
      )
    case 'drop': {
      const v2 = applyDrop(control, op.issue, now)
      return set(v2.patch, v2.text)
    }
    case 'note': {
      const scope = op.issue === null ? 'every issue' : `#${op.issue}`
      const same = control.notes.filter(n => n.issue === op.issue)
      const others = control.notes.filter(n => n.issue !== op.issue)
      if (op.text === null) {
        if (same.length === 0) return keep(op.issue === null ? 'No note for every issue.' : `No note for #${op.issue}.`)
        return set({ notes: others }, `Notes for ${scope} cleared: ${op.issue === null ? 'the' : 'its'} next agent prompts carry none.`)
      }
      const text =
        same.length > 0
          ? `Note for ${scope} replaced: ${op.issue === null ? 'the' : 'its'} next agent prompts carry the new one.`
          : op.issue === null ? 'Note added for every issue: the next agent prompts carry it.' : `Note added for #${op.issue}: its next agent prompts carry it.`
      return set({ notes: [...others, { issue: op.issue, text: op.text, at: now }] }, text)
    }
    case 'mode':
      return keep(`Mode ${op.mode} set in the workspace config file; it applies from the next pass.`, { mode: op.mode })
    case 'stop-now': return keep('Stop-now is written by runOp.')
    case 'unpark': {
      const v2 = applyUnpark(control, op, now)
      return set(v2.patch, v2.text)
    }
    case 'trace':
      return keep(
        op.on
          ? "Trace on, in the workspace config file: from the next pass, each pass's timing goes to trace-YYYY-MM-DD.jsonl beside the decision log."
          : "Trace off, in the workspace config file: from the next pass, the decision log alone carries each pass's time.",
        { trace: op.on },
      )
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

function ago(ms: Ms): string {
  if (ms < MIN) return `${Math.max(0, Math.round(ms / 1000))}s`
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`
  return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MIN)}m`
}

// directives: the control state in force, one short phrase each; an expired override is left out.
export function directives(control: Control, now: Ms): string[] {
  const out: string[] = []
  if (control.noNewWork) out.push('no new work')
  if (control.updateFailed !== null) out.push(`update failed at ${clock(control.updateFailed.failedAt, now)} (${control.updateFailed.reason || 'no reason'}): ${control.updateFailed.error} - fix it, then /factory update again`)
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

// --- the command and the tool ----------------------------------------------------------------

export type ControlPaths = { loopDir: string; configDir: string }

// The caller: `last` for status; agentId when the tool call came from inside an agent's loop; the
// issues parked now, as the last pass's records say (null: not known), so a resume of one that is
// not parked changes nothing.
export type OpFrom = {
  last?: PassSummary | null
  agentId?: string
  parked?: readonly number[] | null
  view?: ConfigView | null
  restartCheck?: () => Promise<RestartCheck>
}

// What `/factory` or the tool answers. ping: something changed (control.json, the mode, trace, or
// a retry to run), so the driver pings the loop and logs `logged` (v2 SPEC 13.4.3). retryIssue: the
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
  // a refusal worth a log line and an intervention (update-refused <reason>), without a ping
  noted?: string | null
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
// set an op (v2 SPEC 13.6.1: the loop's agents act on their own issue only).
export async function runOp(io: FileIo, paths: ControlPaths, input: string, now: Ms, from: OpFrom = {}): Promise<OpReply> {
  const parsed = parseOp(input)
  if (!parsed.ok) return refused(parsed.error)
  // help reads and writes nothing, and an agent may ask for it as it may for the status
  if (parsed.op.op === 'help') return { ok: true, text: helpOf(parsed.op), op: null, control: null, ping: false, retryIssue: null, mode: null, logged: null }
  let op = parsed.op
  let aside = ''
  if (op.op === 'unpark') {
    const only = onlyParked(op, from.parked)
    if ('refused' in only) return refused(only.refused, op)
    op = only.op
    aside = only.aside
  }
  const viewOnly = op.op === 'status' || op.op === 'stamp' || (op.op === 'config' && op.change === undefined)
  if (from.agentId !== undefined && !viewOnly) return refused('Not changed: only the main conversation sets owner directives.', op)
  // the driver starts the dry run and answers (driver-stamp.ts); nothing is read or written here
  if (op.op === 'stamp') return { ok: true, text: '', op, control: null, ping: false, retryIssue: null, mode: null, logged: null }
  // an update needs a workspace that can restart itself (update-check.ts); before control.json is touched
  let unchecked = ''
  if (op.op === 'update' && op.reason !== null && from.restartCheck !== undefined) {
    const check = await from.restartCheck()
    if (check.kind === 'missing') return { ...refused(refusedText(check.reason), op), noted: `update-refused ${check.reason}` }
    if (check.kind === 'unchecked') unchecked = uncheckedText(check.why)
  }
  if (op.op === 'stop-now') return stopNow(io, paths.loopDir, op, now)
  let loaded: LoadedControl
  try {
    loaded = await readControl(io, paths.loopDir)
  } catch (err) {
    loaded = { control: EMPTY_CONTROL, error: `control.json could not be read (${String(err).slice(0, 200)})` }
  }
  if (viewOnly) {
    const text = op.op === 'status' ? statusText(from.last ?? null, loaded.control, now) : configText(from.view ?? null, loaded.control, now)
    const warning = loaded.error === null ? '' : `\n${loaded.error}: fix or remove it.`
    return { ok: true, text: text + warning, op, control: loaded.control, ping: false, retryIssue: null, mode: null, logged: null }
  }
  if (loaded.error !== null) return refused(`Not changed: ${loaded.error}; fix or remove it.`, op)
  const applied = applyOp(loaded.control, op, now, null, from.view ?? null)
  if (op.op === 'config' && applied.effects.setting === undefined) return refused(applied.text, op)
  let text = applied.text
  let nothing = false
  try {
    const setting = applied.effects.setting
    if (setting !== undefined) {
      const wrote = await writeKey(io, paths.configDir, setting.k, setting.value)
      if (wrote.error !== null) return refused(`Not changed: ${wrote.error}.`, op)
      if (!wrote.changed) {
        text = `${op.change?.key ?? ''} ${op.change !== undefined && 'value' in op.change ? 'already has that value in the workspace config file' : 'is not set in the workspace config file'}: nothing changed.`
        nothing = true
      }
    }
    if (applied.changed) await writeControl(io, paths.loopDir, applied.control)
    for (const key of ['mode', 'trace'] as const) {
      const value = applied.effects[key]
      const error = value === undefined ? null : await writeSetting(io, paths.configDir, key, value)
      if (error !== null) return refused(`Not changed: ${error}.`, op)
    }
  } catch (err) {
    return refused(`Not changed: the write failed (${String(err).slice(0, 200)}).`, op)
  }
  const ping = !nothing && (applied.changed || Object.keys(applied.effects).length > 0)
  return {
    ok: true,
    text: `${text}${aside}${unchecked}`,
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
    'Factory loop owner controls: pause, prioritise, retry or drop issues, set the mode; see /factory help, and /factory help config for every setting',
  argumentHint: hintText(),
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
    'status (what the loop is doing); help [config] (the op list, or every setting with its default); stamp <N> (dry-run the intake reader on one issue; writes nothing); config [set <key> <value>|unset <key>] (no argument: the settings it runs with, each with its source; config set <key> <value> saves one setting in the workspace config file and config unset <key> removes it, checked as the loader reads it, only when the owner asks); pause <N> / unpause <N> (no action at all on N; its claim still renews); ' +
    'skip <N> / noskip <N> (never claim N); priority <N...>|off (claim these first, in order); ' +
    'only <N...>|off (claim only these; a tracker stands for its open sub-issues); serial on|off (one issue in ' +
    'flight at a time); new on|off (off: no new claims, designs or implementations); override <pct> <hours>|off ' +
    '(run past the usage tiers up to pct for hours); resume <N...> ["note"] (release what waits on you: ' +
    'unpark issues, the note going to their next step); ' +
    "retry <N> (clear N's exhausted actions); update [<reason>]|off (wind down, up to windDownMinutes, then restart this workspace for an " +
    'update); drop <N> (abandon N); note [<N>] <text>|off (an instruction the next agent prompts carry; a newer note replaces the older one, off clears it); ' +
    "mode off|observe|act (only when the owner asks for that mode); trace on|off (each pass's timing to a local " +
    'trace file, for troubleshooting); stop-now (during a wind-down, stop at once without waiting for what runs, only when the owner asks).',
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
