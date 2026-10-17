// The owner ops under planner v2 (docs/factory-loop/v2/SPEC.md appendix E, 7.2, 11): `resume
// <N...> ["note"]` unparks (P1) and takes no run id, `drop <N>` closes the record of the life it
// names (E1) and leaves the issue open, a resume of an issue that is not parked changes nothing,
// and an op that landed with v2 acting before or after it is a person intervention. control.ts delegates to these when
// planner v2 is in force, and register.ts asks parkedOf and opLanded; v1's meanings stay in
// control.ts until the delete wave. Pure.
import type { Op } from '../control'
import type { Control, Mode, Ms } from '../types'
import type { OpLanded } from './act-events'
import type { IssueRecord, Planner } from './types'

// v2's resume: unpark these issues, with the note for their next step (11, P1).
export type Unpark = { op: 'unpark'; issues: number[]; note: string | null }

// What an op changes in control.json, and the line it answers.
export type V2Applied = { patch: Partial<Control>; text: string }

// parseUnpark: `resume <N...> ["note"]` after the op name: one or more issue numbers, then the note,
// if any, in double quotes; why not, when it does not read.
export function parseUnpark(rest: string, issueOf: (word: string) => number | null, noteMax: number): Unpark | string {
  const m = /^([^"]*?)\s*(?:"(.*)")?\s*$/s.exec(rest)
  const items = (m?.[1] ?? '').split(/[\s,]+/).filter(w => w !== '')
  const issues = items.map(issueOf)
  if (m === null || items.length === 0 || issues.some(n => n === null)) return 'under planner v2, takes issue numbers and an optional note in double quotes'
  const note = (m[2] ?? '').trim()
  if (note.length > noteMax) return `the note is at most ${noteMax} characters`
  return { op: 'unpark', issues: [...new Set(issues as number[])], note: note === '' ? null : note }
}

// onlyParked: the resume narrowed to the issues parked now (parked: as the last pass's records say;
// null when not known, which keeps them all), with a line for each one left out; refused when
// none is parked.
export function onlyParked(op: Unpark, parked: readonly number[] | null | undefined): { op: Unpark; aside: string } | { refused: string } {
  if (parked === undefined || parked === null) return { op, aside: '' }
  const not = op.issues.filter(n => !parked.includes(n))
  const notes = not.map(n => `#${n} is not parked; use /factory note ${n}.`).join(' ')
  if (not.length === op.issues.length) return { refused: `Not changed: ${notes}` }
  return { op: { ...op, issues: op.issues.filter(n => parked.includes(n)) }, aside: not.length === 0 ? '' : ` ${notes}` }
}

// applyUnpark: the resumes control.json records, each with the note.
export function applyUnpark(control: Control, op: Unpark, now: Ms): V2Applied {
  const resumed = op.issues.map(n => (op.note === null ? { subject: `issue:${n}`, at: now } : { subject: `issue:${n}`, at: now, note: op.note }))
  const noted = op.note === null ? '' : ', with your note for its next step'
  return { patch: { resumed: [...control.resumed, ...resumed] }, text: `Resumed ${tagsOf(op.issues)}: back to queued, then on from where it parked${noted}.` }
}

// applyDrop: a drop applies to the life it closes, so a drop of an issue claimed again since is
// recorded again (4.1).
export function applyDrop(control: Control, issue: number, now: Ms): V2Applied {
  return {
    patch: { dropped: [...control.dropped.filter(d => d.issue !== issue), { issue, at: now }] },
    text: `Dropped #${issue}: its record closes and its factory labels go; the issue stays open, and adding ready brings it back.`,
  }
}

// parkedOf: the issues parked or waiting now, as the last pass's records say, under planner v2; null otherwise
// or when no pass read them.
export function parkedOf(planner: Planner, records: readonly IssueRecord[] | undefined): number[] | null {
  return planner === 'v2' && records !== undefined ? records.filter(r => r.state === 'parked' || r.state === 'waiting').map(r => r.issue) : null
}

// The planner and the mode in force.
export type InForce = { planner: Planner; mode: Mode }

// opLanded: an op that landed (logged) with planner v2 in act mode in force before it or after it,
// as the person intervention act-events.ts logs (7.2): its text, its name and the issues it names;
// null for any other. The op's own effect counts, so the ops that turn the loop on (`mode act`,
// `planner v2`) and off are logged too.
export function opLanded(before: InForce, op: Op, logged: string | null, issues: readonly number[], at: Ms): OpLanded | null {
  const after: InForce = { planner: op.op === 'planner' ? op.planner : before.planner, mode: op.op === 'mode' ? op.mode : before.mode }
  const acts = (s: InForce) => s.planner === 'v2' && s.mode === 'act'
  if (logged === null || !(acts(before) || acts(after))) return null
  return { text: logged, name: logged.split(' ')[0] ?? '', issues: [...issues], at }
}

function tagsOf(issues: readonly number[]): string {
  return issues.map(n => `#${n}`).join(' ')
}
