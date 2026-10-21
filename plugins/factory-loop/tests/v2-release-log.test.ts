// The release log (docs/factory-loop/v2/SPEC.md 11, 14.1: O4, O5): rule O4 logs each new release tag
// through callum-flow-released, rule O5 logs one milestone_state per change of the milestone's reading.
import { describe, expect, test } from 'claude-code/testing'

import type { ExecCtx } from '../hooks/exec'
import type { Action, LedgerEntry, Milestone, State } from '../hooks/types'
import { eventArgv } from '../hooks/v2/events'
import { validateStrict } from '../hooks/v2/event-reader'
import { emptyV2State } from '../hooks/v2/observe'
import { executors, RELEASED_TIMEOUT_MS } from '../hooks/v2/act-release-log'
import { planV2 } from '../hooks/v2/plan'
import { fingerprintOf, readingOf } from '../hooks/v2/rules-release-log'
import type { V2State } from '../hooks/v2/types'
import { MIN, NOW, config, entry, state as baseState } from './fixtures'
import { REPO } from './host'

const OK = { ok: true, at: NOW }
const CFG = config({ mode: 'act' })
const MS: Milestone = { open: 1, closed: 3, openIssues: [7], expected: 'minor', oldestClosedAt: '2026-10-17T10:00:00.000Z' }

function world(over: { milestone?: Milestone | null; tag?: string | null | 'unread'; ledger?: LedgerEntry[]; release?: State['release']; backoff?: boolean } = {}): State {
  const s = baseState({ ledger: [...baseState().ledger, ...(over.ledger ?? [])] })
  const v2: V2State = { ...emptyV2State(NOW), sources: { ...emptyV2State(NOW).sources, store: OK }, ...(over.tag === 'unread' ? {} : { tag: over.tag === undefined ? 'v1.2.0' : over.tag }) }
  return { ...s, milestone: over.milestone === undefined ? MS : over.milestone, release: over.release ?? null, githubBackoffUntil: over.backoff === true ? NOW + 10 * MIN : null, v2 }
}
const plan = (s: State) => planV2(s, CFG).actions
const released = (s: State) => plan(s).filter((a): a is Extract<Action, { kind: 'released' }> => a.kind === 'released')
const states = (s: State) => plan(s).filter((a): a is Extract<Action, { kind: 'event' }> => a.kind === 'event' && a.rule === 'O5')
const data = (a: Extract<Action, { kind: 'event' }> | undefined) => (a?.event.state === 'milestone_state' ? a.event.data : null)

const task = (tag: string, decision: 'done' | 'hold', over: Partial<LedgerEntry> = {}): LedgerEntry =>
  entry(`task:release:${tag}:2026-10-17T10`, 'task', {
    wake: 'release',
    class: 'drive',
    outcome: { kind: 'wake', decision, reason: decision === 'hold' ? 'an open issue changes the same schema' : null, instructions: null, bump: null, bumpReason: null, fields: {} },
    ...over,
  })
const loggedTag = (tag: string, at = NOW - 5 * MIN): LedgerEntry => entry(`released:${REPO}:${tag}`, 'released', { rule: 'O4', startedAt: at, endedAt: at })
const doneState = (a: Extract<Action, { kind: 'event' }>, at: number): LedgerEntry => entry(a.key, 'event', { rule: 'O5', startedAt: at, endedAt: at })

describe('O4: log a new release tag', () => {
  test('a new tag with a milestone plans one released action, keyed by repo and tag', () => {
    const [a, ...rest] = released(world())
    expect(rest).toEqual([])
    expect(a).toMatchObject({ key: `released:${REPO}:v1.2.0`, class: 'free', rule: 'O4', issue: null, tag: 'v1.2.0', source: 'workflow' })
  })

  test('the same tag already done plans none; nothing with no milestone or no tag', () => {
    expect(released(world({ ledger: [loggedTag('v1.2.0')] }))).toEqual([])
    expect(released(world({ milestone: null }))).toEqual([])
    expect(released(world({ tag: null }))).toEqual([])
  })

  test('the source is loop after a done release task keyed on the previous logged tag; workflow with none or after a hold', () => {
    const prior = [loggedTag('v1.1.0'), task('v1.1.0', 'done')]
    expect(released(world({ ledger: prior }))[0]?.source).toBe('loop')
    expect(released(world({ ledger: [loggedTag('v1.1.0'), task('v1.1.0', 'hold')] }))[0]?.source).toBe('workflow')
    expect(released(world({ ledger: [loggedTag('v1.1.0'), task('v1.0.0', 'done')] }))[0]?.source).toBe('workflow')
    expect(released(world())[0]?.source).toBe('workflow')
  })

  test('with no logged tag, the previous one is the newest done release task\'s tag that differs from the new one', () => {
    expect(released(world({ ledger: [task('v1.1.0', 'done')] }))[0]?.source).toBe('loop')
    // a task keyed on the new tag itself is no previous release
    expect(released(world({ ledger: [task('v1.2.0', 'done')] }))[0]?.source).toBe('workflow')
    expect(released(world({ ledger: [task('v1.1.0', 'hold')] }))[0]?.source).toBe('workflow')
  })

  test('GitHub backoff holds it', () => {
    expect(released(world({ backoff: true }))).toEqual([])
    expect(released(world())).toHaveLength(1)
  })
})

describe('the released executor', () => {
  const action: Extract<Action, { kind: 'released' }> = { kind: 'released', key: `released:${REPO}:v1.2.0`, class: 'free', rule: 'O4', reason: 'r', issue: null, tag: 'v1.2.0', source: 'loop' }
  async function run(cmd: ExecCtx['cmd']) {
    const seen: { argv: string[]; timeoutMs: number }[] = []
    const ctx = { rt: { repo: 'o/n' }, cmd: async (argv: string[], init: { timeoutMs: number }) => (seen.push({ argv, timeoutMs: init.timeoutMs }), cmd(argv, init)) } as unknown as ExecCtx
    const r = await executors.released?.(ctx, action)
    return { r, seen }
  }
  const exit = (exitCode: number, stderr = ''): ExecCtx['cmd'] => async () => ({ exitCode, stdout: '', stderr })

  test('the argv is exact and the timeout five minutes; exit 0 is done', async () => {
    const { r, seen } = await run(exit(0))
    expect(seen).toEqual([{ argv: ['callum-flow-released', 'v1.2.0', '--repo', 'o/n', '--source', 'loop'], timeoutMs: 300_000 }])
    expect(RELEASED_TIMEOUT_MS).toBe(300_000)
    expect(r?.status).toBe('done')
  })

  test('exit 1 fails and is retried; exit 2 fails with noRetry', async () => {
    const one = (await run(exit(1, 'gh down'))).r
    expect(one).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: 1 } })
    expect(one && 'noRetry' in one).toBe(false)
    expect((await run(exit(2, 'usage'))).r).toMatchObject({ status: 'failed', noRetry: true })
  })

  test('a tool missing from the image (a spawn error naming ENOENT or not found, or exit 127) ends done with a summary', async () => {
    for (const cmd of [
      async () => { throw new Error('spawn callum-flow-released ENOENT') },
      async () => { throw new Error('callum-flow-released: command not found') },
      exit(127, 'sh: callum-flow-released: not found'),
    ] as ExecCtx['cmd'][]) {
      expect((await run(cmd)).r).toMatchObject({ status: 'done', summary: 'callum-flow-released is not on this image' })
    }
  })

  test('a timeout (the run throws with no missing tool) fails', async () => {
    const { r } = await run(async () => { throw new Error('timed out after 300000ms') })
    expect(r).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: -1 } })
  })
})

describe('O5: log the milestone\'s state on each change', () => {
  test('the first reading writes, with every field milestone_state.v1 requires', () => {
    const rel = { tag: 'v1.2.0', oldest: Date.parse('2026-10-17T09:55:12Z') }
    const [a, ...rest] = states(world({ release: rel }))
    expect(rest).toEqual([])
    expect(a?.key).toMatch(/^milestone-state\/[0-9a-f]{8}\/0$/)
    expect(a).toMatchObject({ class: 'free', rule: 'O5', issue: null })
    expect(data(a)).toEqual({ milestone_closed: 3, milestone_open: 1, oldest_closed_at: '2026-10-17T10:00:00.000Z', last_tag: 'v1.2.0', oldest_unreleased_merge_at: '2026-10-17T09:55:12.000Z', expected: 'minor', holding: false, hold_reason: null })
    expect(validateStrict('milestone_state', 1, data(a))).toEqual([])
    if (a?.event === undefined) throw new Error('no event')
    const argv = eventArgv(a.event)
    expect(argv.slice(0, 4)).toEqual(['callum-flow-event', '--type', 'milestone_state', '--data'])
    expect(argv).not.toContain('--issue')
  })

  test('last_tag is an own key of the planned data, the tag or null, and the argv carries it', () => {
    for (const tag of ['v1.2.0', null]) {
      const a = states(world({ tag }))[0]
      if (a?.event === undefined) throw new Error('no event')
      const sent = JSON.parse(eventArgv(a.event)[4] ?? '{}')
      expect(Object.prototype.hasOwnProperty.call(sent, 'last_tag')).toBe(true)
      expect(sent.last_tag).toBe(tag)
    }
  })

  test('with the tag not read yet O5 plans nothing and records why', () => {
    const s = world({ tag: 'unread' })
    expect(states(s)).toEqual([])
    expect(planV2(s, CFG).skipped).toContainEqual({ rule: 'O5', issue: null, why: 'the release tag is not read yet' })
  })

  test('O4 plans a released action for a tag string, none when the tag is null or unread', () => {
    expect(released(world({ tag: 'v1.2.0' }))).toHaveLength(1)
    expect(released(world({ tag: null }))).toEqual([])
    expect(released(world({ tag: 'unread' }))).toEqual([])
  })

  test('an unchanged reading writes nothing; a changed one does', () => {
    const [a] = states(world())
    const ledger = [doneState(a as never, NOW - 3 * MIN)]
    expect(states(world({ ledger }))).toEqual([])
    expect(states(world({ ledger, milestone: { ...MS, closed: 4 } }))).toHaveLength(1)
    // the merge time is not part of the reading
    expect(states(world({ ledger, release: { tag: 'v1.2.0', oldest: NOW - MIN } }))).toEqual([])
  })

  test('A, then B, then A writes three events with three keys', () => {
    const A = MS
    const B = { ...MS, open: 0 }
    const [e1] = states(world({ milestone: A }))
    const l1 = [doneState(e1 as never, NOW - 3 * MIN)]
    const [e2] = states(world({ milestone: B, ledger: l1 }))
    const l2 = [...l1, doneState(e2 as never, NOW - 2 * MIN)]
    const [e3] = states(world({ milestone: A, ledger: l2 }))
    expect(new Set([e1?.key, e2?.key, e3?.key]).size).toBe(3)
    expect(states(world({ milestone: A, ledger: [...l2, doneState(e3 as never, NOW - MIN)] }))).toEqual([])
  })

  test('holding and hold_reason come from a hold release task on the newest tag, the reason clipped to 200', () => {
    const long = task('v1.2.0', 'hold', { outcome: { kind: 'wake', decision: 'hold', reason: `why\n${'x'.repeat(400)}`, instructions: null, bump: null, bumpReason: null, fields: {} } })
    const d = data(states(world({ ledger: [long] }))[0])
    expect(d?.holding).toBe(true)
    expect(d?.hold_reason?.length).toBe(200)
    expect(d?.hold_reason).not.toContain('\n')
    expect(validateStrict('milestone_state', 1, d)).toEqual([])
    // a hold on an older tag, or an answer of done, is not holding
    expect(data(states(world({ ledger: [task('v1.1.0', 'hold')] }))[0])).toMatchObject({ holding: false, hold_reason: null })
    expect(data(states(world({ ledger: [task('v1.2.0', 'hold', { endedAt: NOW - 20 * MIN }), task('v1.2.0', 'done')] }))[0])?.holding).toBe(false)
  })

  test('oldest_unreleased_merge_at is null when the release read belongs to another tag', () => {
    expect(data(states(world({ release: { tag: 'v1.1.0', oldest: NOW - MIN } }))[0])?.oldest_unreleased_merge_at).toBeNull()
  })

  test('no milestone writes nothing; an unread oldest closed is null', () => {
    expect(states(world({ milestone: null }))).toEqual([])
    expect(data(states(world({ milestone: { open: 0, closed: 1, openIssues: [], expected: null } }))[0])?.oldest_closed_at).toBeNull()
  })

  test('the fingerprint is stable and changes with the reading', () => {
    const s = world()
    const r = readingOf({ state: s, config: CFG, v2: s.v2 } as never)
    expect(r).not.toBeNull()
    expect(fingerprintOf(r as never)).toMatch(/^[0-9a-f]{8}$/)
    expect(fingerprintOf({ ...(r as never), holding: true })).not.toBe(fingerprintOf(r as never))
  })
})
