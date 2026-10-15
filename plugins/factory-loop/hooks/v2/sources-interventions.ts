// The facts the interventions of docs/factory-loop/v2/SPEC.md 7.2 come from, beside the ledger and
// the records: the companion's log (<loop dir>/companion.jsonl: one line per refusal and per stop
// gate that could not run, 10.4, 10.6), and the hand edits of the owner's files: control.json and
// the OFF file, and the settings (the workspace config.json and the repo-local settings the loop
// runs with). rules-interventions.ts turns each fact into one `intervention` event; the pushes no
// loop step produced are read there, from the records and the PRs.
//
// A hand edit is a change to a file's digest, between two passes that both act under planner v2,
// that no op explains. The loop writes these files only through an owner op (control.ts runOp,
// whose own intervention act-events.ts logs, noting it here with noteOpLanded) and when it clears
// an update that ran (register.ts clearUpdate, which only sets updateDue to null). An op logs
// after its write lands, so a change is judged only once it has settled (SETTLE_MS): an op noted
// between the read before the change and the read that saw it explains it. A pass that does not
// act (observe, planner v1, a reload) starts the comparison over, so a mode or planner change
// never reads as a hand edit, and nothing seen while not acting is ever logged. What survives
// between passes is this module's memory: a reload starts it over, and the reload is itself an
// intervention (`restart`).
import type { Control, Ms, Source } from '../types'
import type { SourceCtx } from './observe'

const MIN = 60_000
const DAY = 24 * 60 * MIN
// a change is judged once an op that made it has surely logged
export const SETTLE_MS = 2 * MIN
// an op noted this long before the read that saw no change yet still explains the change
const OP_SLACK_MS = MIN
// judged changes and noted ops are kept this long; their interventions are long logged by then
const KEEP_MS = DAY
// the companion's lines older than this are left alone: the ledger keeps an intervention's key 7
// days, so a line older than that would be logged again
export const COMPANION_WINDOW_MS = 6 * DAY
// the companion's log is read whole; past this, only its newest lines
const COMPANION_MAX_LINES = 2_000

// The causes the companion logs (7.2): a refused file write, push, or command or background agent
// (10.4), and a stop gate that could not run (10.6).
export const COMPANION_CAUSES = ['guard:write', 'guard:push', 'guard:command', 'gate-unknown'] as const

// One line of the companion's log (10.4, 10.6).
export type CompanionLine = { at: number; issue: number | null; life: string | null; seq: number | null; cause: string; reason: string }

// A hand edit of the owner's files, judged: control.json or the OFF file, or the settings. issues:
// the issues whose control entries changed (none: a fleet-level change).
export type FileChange = { what: 'control' | 'config'; at: Ms; issues: number[]; detail: string }

export type InterventionFacts = {
  companion: CompanionLine[]
  controlDigest: string | null
  configDigest: string | null
  // absent where nothing read them (a State built outside a pass)
  changes?: FileChange[]
}

export const EMPTY_INTERVENTIONS: InterventionFacts = { companion: [], controlDigest: null, configDigest: null, changes: [] }

// --- the module's memory ------------------------------------------------------------------------------

type Read = { at: Ms; acting: boolean; control: string | null; config: string | null; settings: Record<string, unknown> | null; workspace: string | null }
type Pending = FileChange & { since: Ms }

export type Memory = { last: Read | null; pending: Pending[]; changes: FileChange[]; ops: Ms[] }

export function newMemory(): Memory {
  return { last: null, pending: [], changes: [], ops: [] }
}

const memory: Memory = newMemory()

// noteOpLanded: an owner op landed at this time (act-events.ts logOwnerOp), so the change it made
// to control.json or the settings is not a hand edit.
export function noteOpLanded(at: Ms, mem: Memory = memory): void {
  mem.ops.push(at)
}

// --- digests and diffs ------------------------------------------------------------------------------

// digest: a short FNV-1a hash of a text, for the decision log; the comparison keeps the texts.
export function digest(text: string | null): string | null {
  if (text === null) return null
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function objectOf(text: string | null): Record<string, unknown> {
  if (text === null) return {}
  try {
    const v: unknown = JSON.parse(text)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// The issues one control field's entries name: numbers, `issue:<N>` subjects, `{ issue }` entries.
function issuesIn(v: unknown): Map<string, number | null> {
  const out = new Map<string, number | null>()
  if (!Array.isArray(v)) return out
  for (const item of v) {
    let n: number | null = null
    if (typeof item === 'number') n = item
    else if (item !== null && typeof item === 'object') {
      const o = item as Record<string, unknown>
      if (typeof o.issue === 'number') n = o.issue
      else if (typeof o.subject === 'string' && /^issue:\d+$/.test(o.subject)) n = Number(o.subject.slice(6))
    }
    out.set(JSON.stringify(item), Number.isInteger(n) ? n : null)
  }
  return out
}

// controlDiff: what changed between two control.json texts and kill-switch states, and the issues
// whose entries changed; null when nothing a person did changed: an update cleared after its
// restart ran is the loop's own write (register.ts clearUpdate).
export function controlDiff(before: string | null, after: string | null): { fields: string[]; issues: number[] } | null {
  const [b, a] = [splitControl(before), splitControl(after)]
  const fields: string[] = []
  const issues = new Set<number>()
  if (b.off !== a.off) fields.push(a.off ? 'the OFF file was created' : 'the OFF file was removed')
  const keys = [...new Set([...Object.keys(b.control), ...Object.keys(a.control)])].sort()
  for (const k of keys) {
    const [x, y] = [b.control[k], a.control[k]]
    if (same(x, y)) continue
    if (k === 'updateDue' && (y === null || y === undefined)) continue
    fields.push(k)
    const [bx, ay] = [issuesIn(x), issuesIn(y)]
    for (const [item, n] of [...bx, ...ay]) if (n !== null && bx.has(item) !== ay.has(item)) issues.add(n)
  }
  return fields.length === 0 ? null : { fields, issues: [...issues].sort((m, n) => m - n) }
}

// control.json's text and the kill switch, as one text: `<off>\n<control.json>`.
function controlText(control: string | null, off: boolean): string {
  return `${off ? 'OFF' : 'on'}\n${control ?? ''}`
}

function splitControl(text: string | null): { off: boolean; control: Partial<Record<keyof Control, unknown>> & Record<string, unknown> } {
  if (text === null) return { off: false, control: {} }
  const i = text.indexOf('\n')
  return { off: text.slice(0, i) === 'OFF', control: objectOf(text.slice(i + 1)) }
}

// configDiff: the settings keys that changed, and whether the workspace file did.
function configDiff(before: Read, after: Read): string[] {
  const out: string[] = []
  const [b, a] = [before.settings ?? {}, after.settings ?? {}]
  for (const k of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) if (!same(b[k], a[k])) out.push(k)
  if (before.workspace !== after.workspace && out.length === 0) out.push('the workspace config.json')
  return out
}

// --- the companion's log ------------------------------------------------------------------------------

// companionLines: the companion's log, one JSON object per line; a line that does not read, or
// names a cause it does not log, is skipped. Only lines within the window.
export function companionLines(text: string | null, now: Ms): CompanionLine[] {
  if (text === null) return []
  const out: CompanionLine[] = []
  for (const raw of text.split('\n').slice(-COMPANION_MAX_LINES)) {
    if (raw.trim() === '') continue
    let o: Record<string, unknown>
    try {
      const v: unknown = JSON.parse(raw)
      if (v === null || typeof v !== 'object' || Array.isArray(v)) continue
      o = v as Record<string, unknown>
    } catch {
      continue
    }
    const at = typeof o.at === 'number' ? o.at : typeof o.at === 'string' ? Date.parse(o.at) : Number.NaN
    const cause = COMPANION_CAUSES.find(c => c === o.cause)
    if (!Number.isFinite(at) || cause === undefined || now - at > COMPANION_WINDOW_MS) continue
    const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)
    out.push({
      at,
      issue: int(o.issue) === 0 ? null : int(o.issue),
      life: typeof o.life === 'string' && /^[0-9a-z]+$/.test(o.life) ? o.life : null,
      seq: int(o.seq),
      cause,
      reason: typeof o.reason === 'string' ? o.reason : '',
    })
  }
  return out
}

// --- one pass's read ----------------------------------------------------------------------------------

// The loop's base directory: the loop dir's parent (contract.mjs loopDirOf), where the workspace
// config.json and the OFF file live.
function baseOf(loopDir: string): string {
  return loopDir.replace(/\/[^/]+\/?$/, '')
}

// The settings the loop runs with, without the mode (a mode change is an op, or a pass that does
// not act): the repo's merged under the workspace file's, as runtime() loaded them. null when
// origin's default branch could not be read, so the checkout's file stands in for this pass only.
function settingsOf(ctx: SourceCtx): Record<string, unknown> | null {
  if (ctx.rt.configProblems.some(p => p.startsWith("settings: origin's default branch not read"))) return null
  const { mode: _mode, ...rest } = ctx.rt.config as unknown as Record<string, unknown>
  return { ...rest, runSource: ctx.rt.runSource, poolSize: ctx.rt.poolSize, checkout: ctx.rt.cwd, toolsDir: ctx.rt.toolsDir, path: ctx.rt.env.PATH ?? null }
}

// judge: the pending changes old enough to judge: an op noted in their window explains them;
// the rest are hand edits.
function judge(mem: Memory, now: Ms): void {
  const still: Pending[] = []
  for (const p of mem.pending) {
    if (now - p.at < SETTLE_MS) {
      still.push(p)
      continue
    }
    if (mem.ops.some(t => t >= p.since - OP_SLACK_MS && t <= p.at)) continue
    mem.changes.push({ what: p.what, at: p.at, issues: p.issues, detail: p.detail })
  }
  mem.pending = still
  mem.changes = mem.changes.filter(c => now - c.at <= KEEP_MS)
  mem.ops = mem.ops.filter(t => now - t <= KEEP_MS)
}

// readInterventions: the companion's lines, the files' digests, and the hand edits judged so far.
export async function readInterventions(ctx: SourceCtx, mem: Memory = memory): Promise<{ read: InterventionFacts; source: Source }> {
  const now = ctx.now
  const base = baseOf(ctx.rt.loopDir)
  const errors: string[] = []
  const read = async (path: string): Promise<string | null> => {
    try {
      return await ctx.readFile(path)
    } catch (err) {
      errors.push(`${path}: ${String(err).slice(0, 120)}`)
      return null
    }
  }
  const [companion, control, off, workspace] = await Promise.all([
    read(`${ctx.rt.loopDir}/companion.jsonl`),
    read(`${ctx.rt.loopDir}/control.json`),
    read(`${base}/OFF`),
    read(`${base}/config.json`),
  ])
  const settings = settingsOf(ctx)
  const acting = ctx.rt.mode === 'act' && ctx.rt.config.planner === 'v2' && errors.length === 0
  const cur: Read = { at: now, acting, control: controlText(control, off !== null), config: null, settings, workspace }
  cur.config = settings === null ? null : `${workspace ?? ''}\n${JSON.stringify(settings)}`

  const last = mem.last
  if (last !== null && last.acting && acting) {
    const diff = controlDiff(last.control, cur.control)
    if (diff !== null) mem.pending.push({ what: 'control', at: now, since: last.at, issues: diff.issues, detail: `control changed with no op: ${diff.fields.join(', ')}` })
    if (last.config !== null && cur.config !== null && last.config !== cur.config) {
      mem.pending.push({ what: 'config', at: now, since: last.at, issues: [], detail: `settings changed with no op: ${configDiff(last, cur).join(', ')}` })
    }
  }
  if (!acting) mem.pending = []
  // the settings not read this pass keep the last ones, so the next comparison spans the gap
  mem.last = settings === null && last !== null ? { ...cur, config: last.config, settings: last.settings, workspace: last.workspace } : cur
  judge(mem, now)

  const facts: InterventionFacts = {
    companion: companionLines(companion, now),
    controlDigest: digest(cur.control),
    configDigest: digest(cur.config),
    changes: [...mem.changes],
  }
  const source: Source = errors.length === 0 ? { ok: true, at: now } : { ok: false, at: now, error: errors.join('; ').slice(0, 300) }
  return { read: facts, source }
}
