// The pass summary's running half (#680): the book of passes, whether the last pass held the act
// lock and the minute timer. passes.ts does the arithmetic and the note; this keeps the module
// state and asks register.ts, through SummaryHost, for what only it knows.
import type { EngineInterface } from 'claude-code'

import { MINUTE_MS, closeMinute, minuteOf, notePass, passesEventArgv } from './passes'
import type { PassBook } from './passes'

import { newSessionTokenState, readSessionTokens } from './session-tokens'
import type { ObserveSplit } from './observe-clock'
import type { Tier } from './types'
import type { Runtime } from './observe'
import type { RunInit, RunResult } from './exec'

export type SummaryHost = {
  // the last runtime the loop resolved
  rt: () => Runtime | null
  killed: () => Promise<boolean>
  // the process load time (epoch ms): a baseline token read counts requests since then
  loadedAt: () => number
  // runs the event's argv, best-effort (one try, 60 s)
  send: (rt: Runtime, argv: string[]) => Promise<unknown>
  // runs an argv (stat, dd, find) to read the session transcript, best-effort
  run: (rt: Runtime, argv: string[], init: RunInit) => Promise<RunResult>
}

const book: PassBook = new Map()
const sessionTokens = newSessionTokenState(-1)
let lockHeld = false
let timer: { cancel: () => void } | null = null

// recordPass: a pass ended now and took ms.
export function recordPass(at: number, ms: number, acted: boolean, error: boolean, split: ObserveSplit | null = null, tier: Tier | null = null, overridden: boolean | null = null): void {
  notePass(book, at, ms, acted, error, split, tier, overridden)
}

// forgetSessionTokens: start over as a new process would (for tests).
export function forgetSessionTokens(): void {
  sessionTokens.state = null
  sessionTokens.cutoffMs = -1
}

// holdsLock: the last pass this session finished did (or did not) hold the act lock.
export function holdsLock(held: boolean): void {
  lockHeld = held
}

// flushMinute: close the minute that just ended and send its one event, once and without retry.
// Nothing is sent, and the minute dropped, unless the loop runs in act mode with a repo, the kill
// switch is off and the last pass finished held the act lock.
export async function flushMinute($: EngineInterface, host: SummaryHost): Promise<void> {
  const minute = minuteOf(await $.clock.now()) - MINUTE_MS
  const rt = host.rt()
  if (rt === null) return
  const summary = closeMinute(book, minute, { mode: rt.mode, passEveryMs: rt.config.passEveryMs })
  // read every minute, sent or not, so the offset advances and no tokens fall to a later minute
  if (rt.configDir !== undefined && rt.sessionCwd !== undefined && rt.workspace !== undefined) {
    const now = await $.clock.now()
    if (sessionTokens.cutoffMs < 0) sessionTokens.cutoffMs = host.loadedAt()
    const read = await readSessionTokens((argv, init) => host.run(rt, argv, init), sessionTokens, { configDir: rt.configDir, sessionCwd: rt.sessionCwd, session: rt.workspace.session }, now).catch(() => null)
    if (read?.tokens) {
      summary.inputTokens = read.tokens.input
      summary.outputTokens = read.tokens.output
      summary.cacheReadTokens = read.tokens.cacheRead
      summary.cacheCreationTokens = read.tokens.cacheCreation
      summary.costUsd = read.cost
    }
  }
  if (rt.mode !== 'act' || rt.repo === '' || !lockHeld || (await host.killed())) return
  await host.send(rt, passesEventArgv(summary)).catch(() => undefined)
}

// armSummary: the timer, aligned to the next UTC minute boundary and re-armed from the clock at
// each, so a minute in which a pass hangs, or none ends, still reports.
export function armSummary($: EngineInterface, host: SummaryHost): void {
  timer?.cancel()
  void $.clock.now().then(
    now => {
      const t = $.clock.after(minuteOf(now) + MINUTE_MS - now, () => {
        void flushMinute($, host).catch(() => undefined)
        armSummary($, host)
      })
      timer = { cancel: () => t.cancel() }
    },
    () => undefined,
  )
}
