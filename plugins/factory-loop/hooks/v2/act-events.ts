// The events the loop writes outside a plan's actions (docs/factory-loop/v2/SPEC.md 7.2): an owner
// op's person intervention, which register.ts ownerOp logs here once the op has landed (every op
// but status and help, with planner v2 in act mode before or after it; opLanded in ops.ts says
// which). One event per issue the op names, each attached to its issue; an op that names none
// (mode, pause of the whole loop, serial) is fleet-level and attached to none. Every event goes
// through events.ts. What the op wrote to control.json or the settings is kept as the loop's own
// version when it is written (store.ts noteWritten), so it is never read as a hand edit.
// logEvent writes a v2 event logged outside a plan's actions. The `event` executor (act-state.ts)
// runs the same events.ts argv through its ExecCtx, so both carry the actor events.ts names (a
// fixer's `verdict`, 7.1).
import { commandOf } from '../act'
import type { ActEnv } from '../act'
import type { ExecCtx } from '../exec'
import { eventArgv, intervention } from './events'
import type { InterventionEvent, V2Event } from './events'
import { factKey } from './keys'

// callum-flow-event is one jq call and one append; a minute is ample (act.ts EVENT_TIMEOUT_MS)
const EVENT_TIMEOUT_MS = 60_000

// What an op that landed was: its canonical text (control.ts formatOp), its name and the issues
// it names.
export type OpLanded = { text: string; name: string; issues: number[]; at: number }

// The ops that change nothing and are no intervention (7.2, appendix E).
const NOT_INTERVENTIONS = ['status', 'help']

// opInterventions: the person interventions one op is: one per issue it names, else one with no
// issue. The fact is the op at its time, `op:<name>/<i<N>|fleet>/<ms, base 36>`.
export function opInterventions(op: OpLanded): InterventionEvent[] {
  if (op.name === '' || NOT_INTERVENTIONS.includes(op.name)) return []
  const at = Math.trunc(op.at).toString(36)
  const cause = `op:${op.name}`
  const issues: (number | null)[] = op.issues.length === 0 ? [null] : [...new Set(op.issues)]
  return issues.map(issue => intervention('person', cause, factKey(cause, issue === null ? 'fleet' : `i${issue}`, at), op.text, { issue, life: null, pr: null }))
}

// logEvent: one v2 event through callum-flow-event, as events.ts builds it (its actor included,
// which ExecCtx.event cannot pass). Like ExecCtx.event (act.ts eventOf), a refusal throws with the
// exit as `exitCode`: callum-flow-event exits non-zero only on a usage error (2), a loop bug that is
// never retried.
export async function logEvent(cmd: ExecCtx['cmd'], e: V2Event): Promise<void> {
  const r = await cmd(eventArgv(e), { timeoutMs: EVENT_TIMEOUT_MS })
  if (r.exitCode === 0) return
  const why = r.stderr.trim().split('\n').pop() ?? ''
  throw Object.assign(new Error(`callum-flow-event ${e.state}: exit ${r.exitCode}${why === '' ? '' : `: ${why}`}`), { exitCode: r.exitCode })
}

// logOwnerOp: the op's interventions, logged; notes on what failed, for the decision log.
export async function logOwnerOp(env: Pick<ActEnv, 'io' | 'rt' | 'commands'>, op: OpLanded): Promise<string[]> {
  const cmd = commandOf(env.io, env.rt, env.commands)
  const notes: string[] = []
  for (const e of opInterventions(op)) {
    try {
      await logEvent(cmd, e)
    } catch (err) {
      notes.push(`intervention ${e.cause}${e.issue === null ? '' : ` #${e.issue}`} not logged: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`)
    }
  }
  return notes
}
