// The files of a wind-down (docs/factory-loop/v2/SPEC.md 10.11): the request and status file as
// text, and the pass's writes. The planner reaches wind-down.ts only; this module is observe's and
// register's, so it may read dates.
import type { LedgerEntry, Ms, State } from '../types'
import { WIND_DOWN_REQUEST, WIND_DOWN_STATUS, windDownOf, windDownPaths } from './wind-down'
import type { WindDown, WindDownRead } from './wind-down'

const TRIGGERS = ['restart-self', 'coder-stop']

// requestOf: the request file's text as a request; a file that does not read as one is a request
// at the file's mtime (a bad write never leaves the loop starting work during a stop), with the
// problem.
export function requestOf(text: string, mtime: Ms): NonNullable<WindDownRead['request']> {
  try {
    const v: unknown = JSON.parse(text)
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>
      const at = typeof o.requested_at === 'string' ? Date.parse(o.requested_at) : Number.NaN
      if (!Number.isNaN(at)) {
        const trigger = typeof o.trigger === 'string' && TRIGGERS.some(t => t === o.trigger) ? o.trigger : null
        return { requestedAt: at, iso: new Date(at).toISOString(), trigger, problem: o.trigger === null || trigger !== null ? null : `wind-down: trigger ${JSON.stringify(o.trigger)} is not restart-self, coder-stop or null` }
      }
    }
  } catch {
    // falls through
  }
  return { requestedAt: mtime, iso: new Date(mtime).toISOString(), trigger: null, problem: `wind-down: ${WIND_DOWN_REQUEST} is not a request (needs a requested_at time); treated as a request at its modification time` }
}

// withRemembered: the state with the request this session wrote for its own restart (R2), when the
// read found none: the file may be lost (the stop script leaves it in place, #931) while the
// container still runs, and nothing may start in those seconds. A request read from the file wins.
export function withRemembered(state: State, requestedAt: Ms | null): State {
  if (requestedAt === null || state.v2 === undefined || state.v2.windDown?.request != null) return state
  const request = { requestedAt, iso: new Date(requestedAt).toISOString(), trigger: 'restart-self', problem: null, remembered: true as const }
  return { ...state, v2: { ...state.v2, windDown: { stopNow: false, previous: null, ...state.v2.windDown, request } } }
}

// previousOf: the status file's requested_at and started_at, or null.
export function previousOf(text: string | null): WindDownRead['previous'] {
  if (text === null) return null
  try {
    const o = JSON.parse(text) as Record<string, unknown>
    const requestedAt = typeof o.requested_at === 'string' ? Date.parse(o.requested_at) : Number.NaN
    const startedAt = typeof o.started_at === 'string' ? Date.parse(o.started_at) : Number.NaN
    return Number.isNaN(requestedAt) || Number.isNaN(startedAt) ? null : { requestedAt, startedAt }
  } catch {
    return null
  }
}

const running = (e: LedgerEntry) => e.status === 'running'

// windDownStatus: wind-down.status.json's object for an active wind-down.
export function windDownStatus(state: State, wd: Extract<WindDown, { mode: 'active' }>) {
  const iso = (t: Ms) => new Date(t).toISOString()
  const steps = state.ledger.filter(e => running(e) && e.kind === 'agent-step')
  const queue = state.ledger.some(e => running(e) && (e.kind === 'queue-update' || e.kind === 'queue-merge'))
  const release = state.ledger.some(e => running(e) && e.kind === 'task' && e.wake === 'release')
  // the loop cannot see a stop gate apart from its step: a writer step that runs may be in its gate
  const gate = steps.some(e => e.step === 'build' || e.step === 'fix')
  return {
    requested_at: iso(wd.requestedAt),
    started_at: iso(wd.startedAt),
    cap_ms: wd.capMs,
    running: { steps: steps.map(e => e.key), gate, queue, release },
    idle: steps.length === 0 && !gate && !queue && !release,
    stop_now: state.v2?.windDown?.stopNow === true,
    at: iso(state.now),
  }
}

// The status file lands whole or not at all: written beside itself, then renamed over it.
export const WIND_DOWN_WRITE_SCRIPT = ['set -e', 'tmp="$1.tmp.$$"', 'trap \'rm -f -- "$tmp"\' EXIT', 'cat > "$tmp"', 'mv -f -- "$tmp" "$1"'].join('\n')

export type WindDownIo = { run: (argv: string[], init: { stdin?: string; timeoutMs: number }) => Promise<{ exitCode: number; stderr: string }> }

// windDownFiles: the pass's writes. An active wind-down writes the status file; a stale request
// is removed (the planner tells the owner once, from the same state). Off writes and removes
// nothing. Returns the problems for the decision log; a failed write never fails the pass.
export async function windDownFiles(io: WindDownIo, loopDir: string, state: State, config: { windDownMinutes: number }): Promise<string[]> {
  const wd = windDownOf(state, config)
  if (wd.mode === 'off') return []
  const problems = state.v2?.windDown?.request?.problem != null ? [state.v2.windDown.request.problem] : []
  const paths = windDownPaths(loopDir)
  const active = wd.mode === 'active'
  // a remembered request has no file: no status file for it (the stop script took the request away)
  if (active && state.v2?.windDown?.request?.remembered === true) return problems
  const argv = active ? ['sh', '-c', WIND_DOWN_WRITE_SCRIPT, 'wind-down-status', paths.status] : ['rm', '-f', '--', paths.request]
  const init = active ? { stdin: `${JSON.stringify(windDownStatus(state, wd), null, 2)}\n`, timeoutMs: 10_000 } : { timeoutMs: 10_000 }
  try {
    const r = await io.run(argv, init)
    if (r.exitCode !== 0) problems.push(`wind-down: ${active ? `${WIND_DOWN_STATUS} not written` : `${WIND_DOWN_REQUEST} not removed`} (exit ${r.exitCode}: ${r.stderr.trim().slice(0, 200)})`)
  } catch (err) {
    problems.push(`wind-down: ${String(err).slice(0, 200)}`)
  }
  return problems
}
