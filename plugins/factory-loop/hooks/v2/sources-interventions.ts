// The facts the interventions of docs/factory-loop/v2/SPEC.md 7.2 come from, beside the ledger and
// the records: the companion's log (<loop dir>/companion.jsonl: one line per refusal and per stop
// gate run, of which only a gate that could not run is an intervention, 10.4, 10.6), and the
// owner's files: control.json, the workspace config.json and the repo-local settings file.
// rules-interventions.ts turns each fact into one
// `intervention` event; the pushes no loop step produced are read there, from the records and the
// PRs.
//
// A hand edit is a difference between an owner's file and the last version the loop read or wrote,
// which the store keeps beside the records (files:<repo>, store.ts): an acting pass under planner
// v2 keeps what it read with the edit it found, to log (keepFiles); an owner op and the clearing
// of a done update keep what they wrote (store.ts noteWritten), and an op that finds its file
// already changed keeps that edit to log. The loop never writes the OFF file, so the kill switch is
// an edit of its own, kept when a pass finds it (store.ts noteKillSwitch). Nothing here is held in
// the module: what the loop last read or wrote survives a reload, and edits made while the loop was
// down are found on its next acting read.
import type { Ms, Source } from '../types'
import { interventionKey } from './keys'
import type { SourceCtx } from './observe'
import { FACT_WINDOW_MS, digest, editFacts, editsOf } from './rules-interventions'

// the companion's lines older than this are left alone (rules-interventions.ts FACT_WINDOW_MS)
export const COMPANION_WINDOW_MS = FACT_WINDOW_MS
// the companion's log is read whole; past this, only its newest lines
const COMPANION_MAX_LINES = 2_000

// The companion's causes that are interventions (7.2): a refused file write, push, command, or
// call in the background (10.4), and a stop gate that could not run (10.6). Its other lines
// (every gate run, `gate-pass` and `gate-fail`) are its record for an audit and are skipped here.
export const COMPANION_CAUSES = ['guard:write', 'guard:push', 'guard:command', 'gate-unknown'] as const

// One line of the companion's log (10.4, 10.6).
export type CompanionLine = { at: number; issue: number | null; life: string | null; seq: number | null; cause: string; reason: string }

// One version of an owner's file: its text (a missing file reads as empty) and that text's digest.
export type FileSeen = { digest: string; text: string }

// A hand edit kept to log: of control.json (and the kill switch) or of the settings, when it was
// found, the issues whose control entries changed (none: fleet-level) and what changed.
export type FileEdit = { what: 'control' | 'config'; at: Ms; issues: number[]; detail: string }

// files:<repo>: the last version of each file the loop read or wrote (null: none yet), the edits
// found outside an acting read, still to log, and whether the kill switch is already kept as one.
// v 2: settings is the repo-local file as written (v 1 kept it resolved, and reads as none).
export type FilesSeen = { v: 2; control: FileSeen | null; workspace: FileSeen | null; settings: FileSeen | null; edits: FileEdit[]; off: boolean }

export type InterventionFacts = {
  companion: CompanionLine[]
  // the digests of this pass's control.json and settings, for the decision log
  controlDigest: string | null
  configDigest: string | null
  // this pass's reads: control.json, the workspace config.json, and what the repo-local settings
  // file says; absent or null when not read
  control?: FileSeen | null
  workspace?: FileSeen | null
  settings?: FileSeen | null
  // files:<repo> as the pass found it; absent or null when the loop keeps none yet
  seen?: FilesSeen | null
}

export const EMPTY_INTERVENTIONS: InterventionFacts = { companion: [], controlDigest: null, configDigest: null }

export const EMPTY_FILES: FilesSeen = { v: 2, control: null, workspace: null, settings: null, edits: [], off: false }

export function seenOf(text: string): FileSeen {
  return { digest: digest(text), text }
}

// --- files:<repo> -------------------------------------------------------------------------------------

export const filesKey = (repo: string) => `files:${repo}`

const isSeen = (v: unknown): v is FileSeen | null =>
  v === null || (v !== null && typeof v === 'object' && typeof (v as FileSeen).digest === 'string' && typeof (v as FileSeen).text === 'string')

function editOfStore(v: unknown): FileEdit | null {
  const o = v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null
  if (o === null || (o.what !== 'control' && o.what !== 'config') || typeof o.at !== 'number' || typeof o.detail !== 'string') return null
  if (!Array.isArray(o.issues) || !o.issues.every(n => typeof n === 'number' && Number.isInteger(n) && n > 0)) return null
  return { what: o.what, at: o.at, issues: [...(o.issues as number[])], detail: o.detail }
}

// filesFromStore: files:<repo> as the store holds it; null when it holds none, or nothing that reads.
export function filesFromStore(raw: unknown): FilesSeen | null {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  if (o === null || o.v !== 2 || !isSeen(o.control) || !isSeen(o.workspace) || !isSeen(o.settings) || !Array.isArray(o.edits)) return null
  const edits = o.edits.map(editOfStore).filter((e): e is FileEdit => e !== null)
  return { v: 2, control: o.control, workspace: o.workspace, settings: o.settings, edits, off: o.off === true }
}

const sameSeen = (a: FileSeen | null, b: FileSeen | null) => (a === null ? b === null : b !== null && a.digest === b.digest)

// keepFiles: what an acting pass under planner v2 keeps once it has read the files (store.ts
// keepV2), at `at`. kept: the record as it is now (an op may have written it since the pass read
// it); facts: the pass's reads, with the record as the pass found it; logged: whether an
// intervention key is done. Each version read is kept at once, with what changed since the version
// before as an edit found at `at`, which the next pass logs, so a change is logged once whatever
// version it goes back to; a part an op wrote since the read keeps the op's version (the op keeps
// what it found); a part not read keeps the last. An edit kept goes once logged, and the kill
// switch's flag clears: an acting pass runs only without it. null: nothing changes.
export function keepFiles(kept: FilesSeen | null, facts: InterventionFacts, at: Ms, logged: (key: string) => boolean): FilesSeen | null {
  const base = kept ?? EMPTY_FILES
  const found = facts.seen ?? null
  const take = (part: 'control' | 'workspace') => {
    const read = facts[part] ?? null
    return read !== null && sameSeen(base[part], found?.[part] ?? null) ? read : base[part]
  }
  const taken = { control: take('control'), workspace: take('workspace'), settings: facts.settings ?? base.settings }
  const edits = [...base.edits.filter(e => !editFacts(e).every(f => logged(interventionKey(f.fact)))), ...editsOf(base, taken, at)]
  const next: FilesSeen = { v: 2, ...taken, edits, off: false }
  return JSON.stringify(next) === JSON.stringify(kept) ? null : next
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
export function baseOf(loopDir: string): string {
  return loopDir.replace(/\/[^/]+\/?$/, '')
}

// readInterventions: the companion's lines and the owner's files as they are now. A file that
// could not be read is null, and the source says why.
export async function readInterventions(ctx: SourceCtx): Promise<{ read: InterventionFacts; source: Source }> {
  const now = ctx.now
  const errors: string[] = []
  const read = async (path: string): Promise<string | null | undefined> => {
    try {
      return await ctx.readFile(path)
    } catch (err) {
      errors.push(`${path}: ${String(err).slice(0, 120)}`)
      return undefined
    }
  }
  const [companion, control, workspace] = await Promise.all([
    read(`${ctx.rt.loopDir}/companion.jsonl`),
    read(`${ctx.rt.loopDir}/control.json`),
    read(`${baseOf(ctx.rt.loopDir)}/config.json`),
  ])
  const controlSeen = control === undefined ? null : seenOf(control ?? '')
  const workspaceSeen = workspace === undefined ? null : seenOf(workspace ?? '')
  // the settings are what the repo-local file says, which a person edits, never the defaults a build
  // fills in; not read when origin's default branch was not, so the checkout's file stands in for
  // this pass only (v2/settings.ts)
  const settingsSeen = ctx.rt.repoSettings == null ? null : seenOf(JSON.stringify(ctx.rt.repoSettings))
  const facts: InterventionFacts = {
    companion: companionLines(companion ?? null, now),
    controlDigest: controlSeen?.digest ?? null,
    configDigest: workspaceSeen === null || settingsSeen === null ? null : digest(`${workspaceSeen.text}\n${settingsSeen.text}`),
    control: controlSeen,
    workspace: workspaceSeen,
    settings: settingsSeen,
  }
  const source: Source = errors.length === 0 ? { ok: true, at: now } : { ok: false, at: now, error: errors.join('; ').slice(0, 300) }
  return { read: facts, source }
}
