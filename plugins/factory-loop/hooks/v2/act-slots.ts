// The `slot` executor (docs/factory-loop/v2/SPEC.md 10.1, 10.2, 10.8, appendix B): each op runs the
// plugin's own `bin/factory-slot` once and reads its one result line. The argv is argv.ts's; only
// its program is resolved to the plugin's copy, since the plugin's bin/ is not on the runtime's
// PATH (the answer script is called the same way). Each op has its own attempts on its action
// (lease 3, prepare 1, the old step's processes 1 and best effort, free 2).
//
// - lease: `LEASED path=<p> lease=<id>`; the tool keeps a lease the holder already has, so a
//   retry after a lost answer takes no second slot.
// - prepare: the step marker gets the loop dir (plan leaves it empty, rules-agent.ts markerOf);
//   `PREPARED head=<sha>`, and `LEFTOVERS file=<f>` when the slot held uncommitted work.
// - the old step's processes (entry action, 4.5): `KILLED <n>`; with no slot known there is nothing
//   to end.
// - free: `FREED path=<p>` once the pool shows the slot back, or `GONE path=<p>` when the lease is
//   no longer on it; either is done.
//
// The tool's exit 2 (usage) and 3 (it refused: not the loop's lease, a path outside the pool, a
// marker that does not match) are never retried; any other failure is.
import { commandFailure, NO_EXIT } from '../act-cli'
import type { Exec, ExecCtx, Executor } from '../exec'
import type { Action, ActionKind } from '../types'
import * as ARGV from './argv'
import type { SlotOp, V2Outcome } from './types'

// The tool under the plugin's root.
export const SLOT_SCRIPT = 'bin/factory-slot'

const SEC = 1000
// lease: treehouse fetches origin first; prepare: a fetch, the 5 s grace and a reset; free: the
// same, then the return
export const SLOT_TIMEOUT_MS: Readonly<Record<SlotOp, number>> = { lease: 180 * SEC, prepare: 300 * SEC, kill: 60 * SEC, free: 300 * SEC }
const SUMMARY_MAX = 200

type SlotAction = Extract<Action, { kind: 'slot' }>
type SlotOutcome = Extract<V2Outcome, { kind: 'slot' }>

function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > SUMMARY_MAX ? `${t.slice(0, SUMMARY_MAX - 3)}...` : t
}

function refused(why: string): Exec {
  return { status: 'failed', summary: clip(`refused: ${why}`), noRetry: true }
}

// slotArgv: argv.ts's command for the op, with the plugin's tool as its program; or why it cannot
// be built from the action.
export function slotArgv(a: SlotAction, rt: Pick<ExecCtx['rt'], 'pluginRoot' | 'loopDir'>): string[] | string {
  let argv: string[]
  if (a.op === 'lease') {
    if (a.issue === null) return 'a lease names no issue'
    argv = ARGV.slotLeaseArgv(a.issue, a.life)
  } else if (a.op === 'prepare') {
    if (a.path === null || a.lease === null || a.branch === null || a.marker === null) return 'a prepare needs its slot, lease, branch and marker'
    argv = ARGV.slotPrepareArgv(a.path, a.lease, a.branch, JSON.stringify({ ...a.marker, loopDir: rt.loopDir }))
  } else if (a.op === 'free') {
    if (a.path === null || a.lease === null) return 'a free needs its slot and lease'
    argv = ARGV.slotFreeArgv(a.path, a.lease, rt.loopDir)
  } else {
    if (a.path === null) return 'no slot'
    argv = ARGV.slotKillArgv(a.path)
  }
  return [`${rt.pluginRoot}/${SLOT_SCRIPT}`, ...argv.slice(1)]
}

const field = (text: string, word: string, name: string): string | null => {
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${word} `)) continue
    const m = new RegExp(`(?:^| )${name}=(.*?)(?= [a-z]+=|$)`).exec(line.slice(word.length).trimEnd())
    if (m?.[1] !== undefined && m[1] !== '') return m[1]
  }
  return null
}

// readSlot: the op's outcome from the tool's output; null when its result line is missing.
export function readSlot(op: SlotOp, stdout: string, a: Pick<SlotAction, 'path' | 'lease'>): SlotOutcome | null {
  const base: SlotOutcome = { kind: 'slot', op, path: a.path, lease: a.lease, head: null, killed: null }
  if (op === 'lease') {
    const path = field(stdout, 'LEASED', 'path')
    const lease = field(stdout, 'LEASED', 'lease')
    return path === null || lease === null ? null : { ...base, path, lease }
  }
  if (op === 'prepare') {
    const head = field(stdout, 'PREPARED', 'head')
    return head === null || !/^[0-9a-f]{7,64}$/.test(head) ? null : { ...base, head, leftovers: field(stdout, 'LEFTOVERS', 'file') }
  }
  if (op === 'free') {
    if (field(stdout, 'FREED', 'path') !== null) return base
    return field(stdout, 'GONE', 'path') === null ? null : { ...base, lease: null }
  }
  const m = /^KILLED (\d+)\s*$/m.exec(stdout)
  return m?.[1] === undefined ? null : { ...base, killed: Number(m[1]) }
}

function summaryOf(o: SlotOutcome): string {
  switch (o.op) {
    case 'lease':
      return clip(`leased ${o.path ?? '?'} (${o.lease ?? '?'})`)
    case 'prepare':
      return clip(`prepared at ${(o.head ?? '').slice(0, 7)}${o.leftovers ? `; leftovers saved to ${o.leftovers}` : ''}`)
    case 'free':
      return clip(o.lease === null ? `${o.path ?? 'the slot'}: the lease was gone already` : `freed ${o.path ?? 'the slot'}`)
    default:
      return clip(`${o.killed ?? 0} process(es) ended in ${o.path ?? 'the slot'}`)
  }
}

const slot: Executor = async (ctx: ExecCtx, action: Action): Promise<Exec> => {
  if (action.kind !== 'slot') return refused(`not a slot action: ${action.kind}`)
  const argv = slotArgv(action, ctx.rt)
  if (typeof argv === 'string') {
    // the old step's processes with no slot known: nothing runs there to end
    if (action.path === null && action.op !== 'lease' && action.op !== 'prepare' && action.op !== 'free') {
      return { status: 'done', outcome: { kind: 'slot', op: action.op, path: null, lease: null, head: null, killed: 0 }, summary: 'no slot is known: nothing to end' }
    }
    return refused(argv)
  }
  let r
  try {
    r = await ctx.cmd(argv, { timeoutMs: SLOT_TIMEOUT_MS[action.op], stdin: '' })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return { status: 'failed', outcome: { kind: 'cli', exit: NO_EXIT, detail: why.slice(0, 2000) }, summary: clip(`factory-slot ${action.op}: ${why}`) }
  }
  if (r.exitCode !== 0) {
    const failed = commandFailure(['factory-slot', action.op], r)
    return r.exitCode === 2 || r.exitCode === 3 ? { ...failed, status: 'failed', noRetry: true } : failed
  }
  const outcome = readSlot(action.op, r.stdout, action)
  if (outcome === null) return { status: 'failed', outcome: { kind: 'cli', exit: 0, detail: r.stdout.trim().slice(0, 2000) }, summary: clip(`factory-slot ${action.op}: no result line in its output`) }
  return { status: 'done', outcome, summary: summaryOf(outcome) }
}

export const executors: Partial<Record<ActionKind, Executor>> = { slot }
