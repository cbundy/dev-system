// Actions that run off the pass (v2 SPEC 13.2, 13.7.5): a long command whose result nothing else in
// the pass waits for starts inside the pass, with its running entry saved, and ends in the hook
// queue between passes. The pass does not wait for it, so a 40 s sweep no longer makes a 40 s pass.
// This module is free of the driver: act.ts hands it the pieces and register.ts' driver supplies the
// completion's place (the hook queue) through ActEnv.offPass.
import { CLI_TIMEOUT_MS } from './act-cli'
import type { ActEnv } from './act'
import type { Exec } from './exec'
import { finish } from './ledger'
import type { Completion } from './ledger'
import type { ActionKind, LedgerEntry, Ms } from './types'

// The one list of kinds that run off the pass. A later kind joins by being added here.
export const OFF_PASS: readonly ActionKind[] = ['heartbeat', 'sweep']

// The engine ends a command at its own timeout (act-cli.ts CLI_TIMEOUT_MS, NO_EXIT) and offers no
// kill handle, so the bound a pass marks is that timeout plus this margin, which covers the
// command's exit and the hook queue before its completion lands.
export const OFF_PASS_MARGIN_MS = 60_000

export function isOffPass(kind: ActionKind): boolean {
  return OFF_PASS.includes(kind)
}

// One off-pass command that ended: what the completion applies, and what the trace reports.
export type OffDone = {
  key: string
  kind: ActionKind
  // the entry as the pass started it: the attempt the completion must still find
  started: LedgerEntry
  exec: Exec
  // the command's own time, and when it ended
  ms: Ms
  endedAt: Ms
  config: ActEnv['rt']['config']
  prev: LedgerEntry | null
}

// What the driver gives an act step that may run a command off the pass.
export type OffPass = {
  // the engine calls of a command that outlives the pass: not the pass's traced io, whose tracer ended
  io: ActEnv['io']
  // the command ended: queue its completion (the hook queue); never awaited by the pass
  done: (done: OffDone) => void
}

// sameAttempt: the ledger still holds the attempt `started` began (a retry keeps the key, not the
// start), as a result applied later must find it.
export function sameAttempt(ledger: readonly LedgerEntry[], started: LedgerEntry): LedgerEntry | undefined {
  const current = ledger.find(e => e.key === started.key)
  return current !== undefined && current.startedAt === started.startedAt && current.attempts === started.attempts ? current : undefined
}

// launchOff: start the command without waiting for it; its Exec and timing go to off.done when it
// ends. `run` never rejects (act.ts dispatch turns a throw into a failed Exec); a rejection is
// still caught, so no completion is lost silently.
export async function launchOff(
  off: OffPass,
  now: () => Promise<Ms>,
  run: () => Promise<Exec>,
  at: Pick<OffDone, 'key' | 'kind' | 'started' | 'config' | 'prev'>,
): Promise<void> {
  const t0 = await now()
  const finished = async (exec: Exec) => {
    const endedAt = await now()
    off.done({ ...at, exec, ms: endedAt - t0, endedAt })
  }
  void run().then(finished, (err: unknown) => finished({ status: 'failed', summary: `${at.kind}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) })).catch(() => undefined)
}

// offPassExpired: the running off-pass entries that outlived their command's timeout and the
// margin: each is timed out, and a completion that arrives later finds it ended and is dropped.
export function offPassExpired(ledger: readonly LedgerEntry[], now: Ms): (Completion & { key: string })[] {
  const out: (Completion & { key: string })[] = []
  for (const e of ledger) {
    if (e.status !== 'running' || !isOffPass(e.kind)) continue
    const limit = CLI_TIMEOUT_MS[e.kind as keyof typeof CLI_TIMEOUT_MS] + OFF_PASS_MARGIN_MS
    if (now - e.startedAt <= limit) continue
    out.push({ key: e.key, status: 'timed-out', summary: `timed out: no completion within ${Math.round(limit / 1000)} s` })
  }
  return out
}

// completeOff: apply a finished off-pass command to the live ledger, the way the inline run does
// (act.ts record): only while the entry is still that attempt and still running, then saved. No
// loop event: the off-pass kinds log none (ledger.ts LOOP_KINDS; act-off.test.ts checks it).
// False when the completion was dropped: the attempt had ended (timed out, lost, retried) or is gone.
export async function completeOff(env: ActEnv, done: OffDone): Promise<boolean> {
  const current = sameAttempt(env.live.ledger, done.started)
  if (current === undefined || current.status !== 'running') return false
  env.live.ledger = finish(env.live.ledger, done.key, done.exec, done.endedAt, { config: done.config, prev: done.prev })
  await env.save()
  return true
}
