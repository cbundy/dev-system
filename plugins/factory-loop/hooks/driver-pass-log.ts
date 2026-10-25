// What a pass leaves behind: its trace record (v2 SPEC 13.12.1), the action summaries of its decision-log
// line, the update drain's end (rule H4) and the owner's word that passes keep throwing (v2 SPEC 13.10 item 9).
import type { EngineInterface } from 'claude-code'

import { passErrorTell, sendNotice } from './act'
import { readControl, writeControl } from './control'
import type { Runtime } from './observe'
import { roleProblem } from './rails'
import { CUT_ROOM, byteLength, cutLine, isCutLine, traceName, traceRoom } from './trace'
import type { Action, Control, Ms, PlanResult, State } from './types'
import { noteWritten, notingIo } from './v2/store'
import { append, appendLine, fileIo, killed, v2StoreIo } from './driver-io'
import { bareState, ensureLedger, hookEnv } from './driver-store'
import { S, liveV2 } from './driver-state'

// starvedOf: the pass line's `starved`, while the pass is starved: when the spell began (this pass, on its
// first) and its age in minutes; undefined otherwise, so a spell's start and end show in the log.
export function starvedOf(result: PlanResult, state: State): { since: string; minutes: number } | undefined {
  if (result.starved !== true) return undefined
  const since = state.v2?.starvedSince ?? state.now
  return { since: new Date(since).toISOString(), minutes: Math.floor((state.now - since) / 60_000) }
}

// tellError: three passes in a row threw; the owner hears of it once (v2 SPEC 13.10 item 9), from a session
// that may act: a role the rails refuse tells nothing, as checkRails does.
export async function tellError($: EngineInterface, rt: Runtime, now: Ms, error: string): Promise<boolean> {
  try {
    const problems: string[] = []
    if (roleProblem(await $.env.get('DEV_ROLE'), rt.config) !== null || (await killed($))) return false
    if (!(await ensureLedger($, rt, problems))) return false
    const env = hookEnv($, rt, now, await $.session.id())
    const sent = await sendNotice(env, S.lastState ?? bareState(rt, now), passErrorTell(S.failingSince ?? now, S.failures, error))
    return sent === 'sent'
  } catch {
    return false
  }
}

// writeTrace: the pass's trace record beside its decision log, within config traceMaxBytes
// (trace.ts traceRoom): the oldest trace files go first, and today's is cut short rather than
// pass the cap. A cut stays for the day across reloads: the first write of a load reads whether
// today's file already ends with the cut line (v2 SPEC 13.12.1). A trace that cannot be written never
// fails the pass.
export async function writeTrace($: EngineInterface, rt: Runtime, record: Record<string, unknown>) {
  const at = String(record.at)
  const day = at.slice(0, 10)
  const cap = rt.config.traceMaxBytes
  const dayCap = `${day}:${cap}`
  const line = JSON.stringify(record) + '\n'
  const files = (await $.fs.list(rt.loopDir)).filter(e => e.kind === 'file')
  const path = `${rt.loopDir}/${traceName(day)}`
  if (S.traceCut !== dayCap && S.traceChecked !== dayCap) {
    if (files.some(f => f.name === traceName(day) && f.size > 0) && (await endsCut($, path, cap))) S.traceCut = dayCap
    S.traceChecked = dayCap
  }
  const room = traceRoom(files, day, byteLength(line), cap, S.traceCut === dayCap)
  if (room.remove.length > 0) {
    const r = await $.process.run(['rm', '-f', '--', ...room.remove.map(name => `${rt.loopDir}/${name}`)], { timeoutMs: 10_000 })
    if (r.exitCode !== 0) return
  }
  if (room.write === 'record') await append($, path, line)
  if (room.write === 'cut') {
    await append($, path, cutLine(at, cap))
    S.traceCut = dayCap
  }
}

// endsCut: the trace file's last line is the cut line of this cap. Only its tail is read, since
// the file may be far larger than $.fs.read takes; the cut line fits in CUT_ROOM bytes.
export async function endsCut($: EngineInterface, path: string, cap: number): Promise<boolean> {
  const r = await $.process.run(['tail', '-c', String(CUT_ROOM), '--', path], { timeoutMs: 10_000 })
  return r.exitCode === 0 && isCutLine(r.stdout.trimEnd().split('\n').pop() ?? '', cap)
}

export function summaryOf(a: Action) {
  return {
    key: a.key,
    kind: a.kind,
    class: a.class,
    rule: a.rule,
    issue: a.issue,
    step: a.kind === 'agent-step' ? a.step : undefined,
    run: 'run' in a && typeof a.run === 'string' ? a.run : undefined,
    pr: 'pr' in a && typeof a.pr === 'number' ? a.pr : undefined,
    reason: a.reason,
    // a wake action's fields (a tell's since, roots, why...), so the decision log says what it named
    fields: 'fields' in a && typeof a.fields === 'object' && a.fields !== null ? a.fields : undefined,
  }
}

// clearUpdate: control.json without updateDue, once the restart for it ran (rule H4). Its line
// is appended outside the owner's op queue, which holds only file reads and writes (#558).
export async function clearUpdate($: EngineInterface, rt: Runtime, at: Ms | null): Promise<boolean> {
  if (at === null) return false
  const run = S.ops.then(async () => {
    const fio = notingIo(fileIo($), noteWritten(liveV2, v2StoreIo($), rt))
    const loaded = await readControl(fio, rt.loopDir)
    if (loaded.error !== null || loaded.control.updateDue?.at !== at) return false
    await writeControl(fio, rt.loopDir, { ...loaded.control, updateDue: null })
    return true
  })
  S.ops = run.catch(() => undefined)
  const cleared = await run.catch(() => false)
  if (cleared) await appendLine($, rt, { control: 'update off', text: `restart:${at} ran: the update is done and the drain ends` })
  return cleared
}

// failUpdate: the restart for the update at `at` failed (rule R2): control.json without updateDue and with
// updateFailed, so the update is no longer due and the owner's notice lasts until `update <reason>` or
// `update off`. Nothing is written when the owner changed updateDue meanwhile. Returns what it wrote.
export async function failUpdate($: EngineInterface, rt: Runtime, at: Ms | null, failedAt: Ms, summary: string): Promise<Control['updateFailed']> {
  if (at === null) return null
  const error = summary.slice(0, 300)
  const run = S.ops.then(async () => {
    const fio = notingIo(fileIo($), noteWritten(liveV2, v2StoreIo($), rt))
    const loaded = await readControl(fio, rt.loopDir)
    const due = loaded.control.updateDue
    if (loaded.error !== null || due?.at !== at) return null
    const updateFailed = { reason: due.reason, at, failedAt, error }
    await writeControl(fio, rt.loopDir, { ...loaded.control, updateDue: null, updateFailed })
    return updateFailed
  })
  S.ops = run.catch(() => undefined)
  const failed = await run.catch(() => null)
  if (failed !== null) await appendLine($, rt, { control: 'update failed', text: `update failed: ${error}; the update is no longer due` })
  return failed
}
