// M1, the default branch's state (docs/factory-loop/v2/SPEC.md 9.5, 14.1): one `main_state` event
// each time the state the main source read differs from the last one logged, so the metrics can say
// what state main was in after each merge and when it changed (docs/metrics.md "Main after merge").
// The loop only logs it: no merge waits on main and the owner is told nothing.
//
// The state is `<h>.<w>.<d>`: the head, each workflow's (id, newest completed run, attempt,
// conclusion, running) and each deployment's (environment, id, state), each part digested with
// FNV-1a. The last state logged is the one the newest done `main/` entry of the ledger moved to, or
// `none` (a fresh ledger, or one whose entries were pruned after 7 steady days). The key is
// `main/<last>/<current>`, so the ledger makes each transition once across restarts, a state that
// comes back is logged again, and a steady main is logged at most once more after a prune. Runs
// whatever the store's state; a pass with no reading (a failed or skipped read) logs nothing. Pure.
import { gate, skip } from '../foundation'
import type { MainStateData } from './events'
import { mainKey } from './keys'
import type { MainReading, V2Ctx } from './types'

// fnv1a: 32-bit FNV-1a of the text, 8 hex digits.
export function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

const PARTS = ['head', 'workflow', 'deploy'] as const

// stateKeyOf: the reading's state, `<h>.<w>.<d>`.
export function stateKeyOf(m: MainReading): string {
  const w = m.workflows.map(x => [x.id, x.run?.id ?? '', x.run?.attempt ?? '', x.run?.conclusion ?? '', x.running ? 1 : 0].join(',')).join(';')
  const d = m.deployments.map(x => [x.environment, x.id, x.state ?? ''].join(',')).join(';')
  return [fnv1a(m.head), fnv1a(w), fnv1a(d)].join('.')
}

const STATE = /^[0-9a-f]{8}\.[0-9a-f]{8}\.[0-9a-f]{8}$/

// lastLogged: the state the newest done `main/<last>/<current>` entry moved to; 'none' when there is none.
export function lastLogged(ledger: V2Ctx['state']['ledger']): string {
  let newest: { at: number; state: string } | null = null
  for (const e of ledger) {
    if (e.status !== 'done' || !e.key.startsWith('main/')) continue
    const [, , current] = e.key.split('/')
    if (current === undefined || !STATE.test(current)) continue
    const at = e.endedAt ?? e.startedAt
    if (newest === null || at >= newest.at) newest = { at, state: current }
  }
  return newest?.state ?? 'none'
}

// changedOf: what differs between the last state and this one: the first of head, workflow and
// deploy that does; `first` when none was logged.
export function changedOf(last: string, current: string): MainStateData['changed'] {
  if (!STATE.test(last)) return 'first'
  const a = last.split('.')
  const b = current.split('.')
  const i = a.findIndex((p, n) => p !== b[n])
  return i < 0 ? 'first' : PARTS[i] ?? 'first'
}

// mainStateOf: the event's data for a reading.
export function mainStateOf(m: MainReading, changed: MainStateData['changed']): MainStateData {
  const ok = ['success', 'skipped', 'neutral']
  return {
    observed_at: m.observedAt,
    branch: m.branch,
    head: m.head,
    pr: m.pr,
    workflows: m.workflows.map(w => w.name),
    workflow_ids: m.workflows.map(w => w.id),
    run_ids: m.workflows.map(w => w.run?.id ?? null),
    run_attempts: m.workflows.map(w => w.run?.attempt ?? null),
    run_heads: m.workflows.map(w => w.run?.head ?? null),
    run_events: m.workflows.map(w => w.run?.event ?? null),
    conclusions: m.workflows.map(w => w.run?.conclusion ?? null),
    running: m.workflows.map(w => w.running),
    green: m.workflows.every(w => w.run === null || ok.includes(w.run.conclusion)),
    deploy_environments: m.deployments.map(d => d.environment),
    deploy_ids: m.deployments.map(d => d.id),
    deploy_states: m.deployments.map(d => d.state),
    changed,
  }
}

export function mainRules(ctx: V2Ctx): void {
  const m = ctx.v2.main
  if (m === undefined) return
  const current = stateKeyOf(m)
  const last = lastLogged(ctx.state.ledger)
  if (last === current) return
  const key = mainKey(last, current)
  const data = mainStateOf(m, changedOf(last, current))
  const g = gate(ctx, key, 'event')
  if (g === 'go') ctx.out.push({ kind: 'event', key, class: 'free', rule: 'M1', reason: `main state: changed ${data.changed}, ${data.green ? 'green' : 'not green'}`, issue: null, event: { state: 'main_state', data } })
  else if (g === 'exhausted') skip(ctx, 'M1', null, `exhausted: ${key}: the state of main is not logged`)
}
