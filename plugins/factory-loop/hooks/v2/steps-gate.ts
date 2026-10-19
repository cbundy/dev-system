// When a gated writer step may end (docs/factory-loop/v2/SPEC.md 10.6, 10.8): a build or fix attempt
// whose repo has stop-gate commands is taken only once the companion's log holds a settling gate
// line for that attempt, so the stop gate has its say before the loop prepares the slot for what
// follows. Pure, but for the one read of the companion's log (companionGates).
import type { ExecCtx } from '../exec'
import type { Config, Ms } from '../types'
import { gateLines } from './sources-interventions'
import type { GateLine } from './sources-interventions'

const MIN = 60_000

// What a step is looked up by: its issue, life and seq, and the time of its attempt's start; a
// gate line dated before it belongs to an earlier attempt.
export type GateAt = { issue: number; life: string; seq: number; since: Ms }

// A gate line that settles the step (its cause, its time), or the newest line's cause when it does
// not: 'gate-fail' keeps the step open, as the agent is refused and works on; null is no line.
export type GateSettled = { cause: 'gate-pass' | 'gate-unknown'; at: Ms } | { cause: 'gate-fail' | null }

// gateSettled: the newest `gate-pass`, `gate-fail` or `gate-unknown` line of the step, by its own
// time (the hook's catch line has no startedAt), dated at or after the attempt's start. `gate-wait`
// lines are ignored.
export function gateSettled(lines: readonly GateLine[], at: GateAt): GateSettled {
  let newest: GateLine | null = null
  for (const l of lines) {
    if (l.cause === 'gate-wait' || l.issue !== at.issue || l.life !== at.life || l.seq !== at.seq || l.at < at.since) continue
    if (newest === null || l.at >= newest.at) newest = l
  }
  if (newest === null) return { cause: null }
  if (newest.cause === 'gate-fail') return { cause: 'gate-fail' }
  return { cause: newest.cause === 'gate-pass' ? 'gate-pass' : 'gate-unknown', at: newest.at }
}

// gateHoldMs: how long a held answer waits for its gate line before it is taken anyway: past every
// line the companion guarantees to write (its wait for a slot, its run, and two minutes).
export function gateHoldMs(config: Pick<Config, 'gateWaitTimeoutMs' | 'gateTimeoutMs'>): Ms {
  return config.gateWaitTimeoutMs + config.gateTimeoutMs + 2 * MIN
}

// companionGates: the gate lines of the companion's log, read now: the last observe's may be older
// than the line (at a turn's end, much so). A log that cannot be read gives none.
export async function companionGates(ctx: ExecCtx): Promise<GateLine[]> {
  try {
    const text = await ctx.io.readFile(`${ctx.rt.loopDir}/companion.jsonl`)
    return gateLines(text, await ctx.io.now())
  } catch {
    return []
  }
}

// gateNote: how a step taken on its gate line says so in its summary.
export function gateNote(s: GateSettled): string {
  return 'at' in s ? ` (after its ${s.cause} at ${new Date(s.at).toISOString()})` : ''
}

export const holdNote = (config: Pick<Config, 'gateWaitTimeoutMs' | 'gateTimeoutMs'>): string => ` (no stop gate line within ${Math.round(gateHoldMs(config) / MIN)} min)`
