// The memory ceiling on the issues held at once (docs/factory-loop/v2/SPEC.md 13.4.2, v2/capacity.ts):
// the memory read, the slot estimate, the ceiling and the effective cap, the capacity tell, and the
// settings, view, snapshot and pass log that carry them.
import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG, loadConfig, parseMemory, parseMemoryRead, readMemory } from '../hooks/config'
import { configText } from '../hooks/config-view'
import type { ConfigView } from '../hooks/config-view'
import { snapshotFrom, snapshotOf } from '../hooks/settings-snapshot'
import type { Action, PlanResult, State } from '../hooks/types'
import { DEFAULT_SLOT_MEMORY_MIB, capText, effectiveCap, memoryCeiling, slotEstimate } from '../hooks/v2/capacity'
import type { GateLine } from '../hooks/v2/sources-interventions'
import { lifeOf } from '../hooks/v2/keys'
import { emptyV2State } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { madeRecord } from '../hooks/v2/table'
import { SLOT_STATES } from '../hooks/v2/types'
import type { IssueRecord, Lease, V2State } from '../hooks/v2/types'
import type { Runtime } from '../hooks/observe'
import { MIN, NOW, config, control, entry, issue, state as baseState } from './fixtures'
import { REPO } from './host'

const MIB = 1024 * 1024
const GIB = 1024 * MIB
// the plant-console container: 12.9 GB
const PLANT = 13_851_371_520
const CFG = config({ mode: 'act', maxInFlightIssues: 3, worktreeReserve: 2 })
const cfg = (over: Record<string, unknown> = {}) => ({ ...DEFAULT_CONFIG, ...over })

function gateLine(n: number, added: number | null, over: Partial<GateLine> = {}): GateLine {
  return {
    at: NOW, issue: n, life: 'abc', seq: 1, cause: 'gate-pass', head: null, ms: 1000, waitMs: 0, concurrency: 1, startedAt: `2026-10-20T10:0${n % 10}:00.000Z`, startedMs: null, derived: null,
    queuedBehind: null, clean: null, hasClean: false, failedTests: null, memStartBytes: added === null ? null : GIB, memPeakBytes: added === null ? null : GIB + added, memLimitBytes: null, rerun: false, ...over,
  }
}

describe('parseMemory', () => {
  test('memory.max in bytes; `max` or absent falls back to MemTotal in kB; anything unreadable is null', () => {
    expect(parseMemory('13851371520\n', 'MemTotal: 99999999 kB\n')).toBe(PLANT)
    expect(parseMemory('max\n', 'MemTotal:       16384000 kB\nMemFree: 1 kB\n')).toBe(16_384_000 * 1024)
    expect(parseMemory(null, 'MemTotal:       16384000 kB\n')).toBe(16_384_000 * 1024)
    expect(parseMemory('', 'MemTotal:       16384000 kB\n')).toBe(16_384_000 * 1024)
    expect(parseMemory('max', '')).toBeNull()
    expect(parseMemory(null, null)).toBeNull()
    expect(parseMemory('lots', 'MemTotal: lots kB')).toBeNull()
  })

  test('the command prints both files as JSON; garbage or a failing command is no memory', async () => {
    expect(parseMemoryRead(JSON.stringify({ max: '1073741824\n', info: '' }))).toBe(GIB)
    expect(parseMemoryRead(JSON.stringify({ max: 'max\n', info: 'MemTotal: 1024 kB\n' }))).toBe(1024 * 1024)
    expect(parseMemoryRead('not json')).toBeNull()
    expect(parseMemoryRead('null')).toBeNull()
    expect(await readMemory(async () => ({ exitCode: 1, stdout: JSON.stringify({ max: '1073741824' }) }))).toBeNull()
    expect(await readMemory(async () => Promise.reject(new Error('no node')))).toBeNull()
    expect(await readMemory(async argv => ({ exitCode: 0, stdout: argv[0] === 'node' ? JSON.stringify({ max: '1073741824' }) : '' }))).toBe(GIB)
  })
})

describe('slotEstimate', () => {
  test('a set number wins over the measurement', () => {
    const lines = [1, 2, 3, 4].map(n => gateLine(n, 100 * MIB))
    expect(slotEstimate(512, lines)).toEqual({ bytes: 512 * MIB, source: 'setting' })
  })

  test('auto with fewer than 3 measured runs is the default; with 3 or more it is their p90, nearest rank', () => {
    expect(slotEstimate('auto', undefined)).toEqual({ bytes: DEFAULT_SLOT_MEMORY_MIB * MIB, source: 'default' })
    expect(slotEstimate('auto', [gateLine(1, 100 * MIB), gateLine(2, 200 * MIB)])).toEqual({ bytes: 3072 * MIB, source: 'default' })
    const ten = Array.from({ length: 10 }, (_, i) => gateLine(i + 1, (i + 1) * 100 * MIB))
    // rank ceil(0.9 * 10) = 9: the ninth smallest
    expect(slotEstimate('auto', ten)).toEqual({ bytes: 900 * MIB, source: 'measured' })
    expect(slotEstimate('auto', ten.slice(0, 3))).toEqual({ bytes: 300 * MIB, source: 'measured' })
  })

  test('a run counts once however many lines carry it; a line without both fields, or that added nothing, is ignored', () => {
    const lines = [gateLine(1, 100 * MIB), gateLine(1, 100 * MIB, { cause: 'gate-fail' }), gateLine(2, 100 * MIB), gateLine(3, null), gateLine(4, 0)]
    expect(slotEstimate('auto', lines).source).toBe('default')
    // the same issue, life and seq at another start is another run
    expect(slotEstimate('auto', [...lines, gateLine(1, 100 * MIB, { startedAt: '2026-10-20T11:00:00.000Z' })])).toEqual({ bytes: 100 * MIB, source: 'measured' })
    expect(slotEstimate('auto', [gateLine(5, 10, { memStartBytes: 5 * GIB }), gateLine(6, 0), gateLine(7, 0)]).source).toBe('default')
  })
})

describe('effectiveCap', () => {
  test('a 12.9 GB container with the default estimate and reserve holds 3, for any maxInFlightIssues of 3 or more', () => {
    expect(memoryCeiling(PLANT, 2048 * MIB, 3072 * MIB)).toBe(3)
    for (const k of [3, 4, 8, null]) expect(effectiveCap(cfg({ maxInFlightIssues: k }), PLANT, []).effective).toBe(3)
    expect(effectiveCap(cfg({ maxInFlightIssues: 2 }), PLANT, [])).toMatchObject({ effective: 2, ceiling: 3, bound: 'setting' })
    expect(effectiveCap(cfg({ maxInFlightIssues: 4 }), PLANT, [])).toMatchObject({ effective: 3, configured: 4, ceiling: 3, memoryBytes: PLANT, estimateBytes: 3072 * MIB, estimateSource: 'default', bound: 'memory' })
  })

  test('no memory read means no ceiling: the configured cap stands, and both null is no cap', () => {
    expect(effectiveCap(cfg({ maxInFlightIssues: 5 }), null, [])).toMatchObject({ effective: 5, ceiling: null, bound: 'setting' })
    expect(effectiveCap(cfg({ maxInFlightIssues: null }), null, [])).toMatchObject({ effective: null, ceiling: null, bound: null })
  })

  test('memory below the reserve gives 1; a configured 0 stays 0; a null configured takes the ceiling', () => {
    expect(effectiveCap(cfg(), GIB, []).ceiling).toBe(1)
    expect(effectiveCap(cfg(), GIB, []).effective).toBe(1)
    expect(effectiveCap(cfg({ maxInFlightIssues: 0 }), PLANT, []).effective).toBe(0)
    expect(effectiveCap(cfg({ maxInFlightIssues: null }), 100 * GIB, [])).toMatchObject({ effective: 32, bound: 'memory' })
  })

  test('a set slotMemoryMiB and memoryReserveMiB size the ceiling', () => {
    expect(effectiveCap(cfg({ maxInFlightIssues: 20, slotMemoryMiB: 1024, memoryReserveMiB: 0 }), 8 * GIB, [])).toMatchObject({ effective: 8, estimateSource: 'setting', estimateBytes: GIB })
  })

  test('the skip text names the memory ceiling only when it is the bound', () => {
    const mem = effectiveCap(cfg({ maxInFlightIssues: 4 }), PLANT, [])
    expect(capText(mem, 3, 'queued or in flight')).toBe('capacity: 3 of 3 queued or in flight (memory ceiling: 12.9 GiB, 3.0 GiB per slot, default)')
    const set = effectiveCap(cfg({ maxInFlightIssues: 2 }), PLANT, [])
    expect(capText(set, 2, 'in flight')).toBe('capacity: 2 of 2 in flight')
  })
})

describe('settings', () => {
  test('both keys load with their defaults; bad values are problems and keep the default', () => {
    expect(DEFAULT_CONFIG).toMatchObject({ slotMemoryMiB: 'auto', memoryReserveMiB: 2048 })
    expect(loadConfig({ slotMemoryMiB: 4096, memoryReserveMiB: 0 }, {})).toMatchObject({ config: { slotMemoryMiB: 4096, memoryReserveMiB: 0 }, problems: [] })
    expect(loadConfig({ slotMemoryMiB: 'auto' }, {}).problems).toEqual([])
    for (const bad of [-1, 1.5, 'lots', 0, null]) {
      const loaded = loadConfig({ slotMemoryMiB: bad }, {})
      expect(loaded.config.slotMemoryMiB).toBe('auto')
      expect(loaded.problems.some(p => p.startsWith('slotMemoryMiB:'))).toBe(true)
    }
    for (const bad of [-1, 1.5, 'lots', null]) {
      const loaded = loadConfig({ memoryReserveMiB: bad }, {})
      expect(loaded.config.memoryReserveMiB).toBe(2048)
      expect(loaded.problems.some(p => p.startsWith('memoryReserveMiB:'))).toBe(true)
    }
  })
})

describe('the config view', () => {
  const view = (memoryBytes: number | null, over: Record<string, unknown> = {}): ConfigView => {
    const loaded = loadConfig({ maxInFlightIssues: 4, ...over }, {})
    return {
      config: loaded.config, device: 'd', poolSize: 16, cpus: 8, cap: effectiveCap(loaded.config, memoryBytes, []), repoRaw: { maxInFlightIssues: 4, ...over }, workspaceRaw: {}, problems: loaded.problems, modeFrom: 'plugin', deviceFrom: 'env', pluginVersion: '1',
    }
  }
  const line = (text: string, label: string) => text.split('\n').find(l => l.startsWith(`  ${label} `)) ?? ''

  test('the Capacity group shows the cap as configured, the estimate and its source, the memory, the ceiling and the effective cap', () => {
    const text = configText(view(PLANT), control(), NOW)
    expect(line(text, 'maxInFlight')).toContain('4')
    expect(line(text, 'slotMemoryMiB')).toContain('auto (3.0 GiB, default)')
    expect(line(text, 'memoryReserveMiB')).toContain('2048 MiB')
    expect(line(text, 'memory')).toContain('12.9 GiB')
    expect(line(text, 'memory ceiling')).toContain('3')
    expect(line(text, 'effective cap')).toContain('3')
    expect(Math.max(...text.split('\n').map(l => l.length))).toBeLessThanOrEqual(60)
  })

  test('an unreadable memory says so', () => {
    const text = configText(view(null), control(), NOW)
    expect(line(text, 'memory')).toContain('not readable: no memory ceiling')
    expect(line(text, 'memory ceiling')).toContain('none')
    expect(line(text, 'effective cap')).toContain('4')
    expect(line(configText(view(PLANT, { slotMemoryMiB: 2048 }), control(), NOW), 'slotMemoryMiB')).toContain('2048 MiB (2.0 GiB, setting)')
  })
})

describe('the settings snapshot', () => {
  const rt = (memoryBytes?: number | null): Runtime => {
    const loaded = loadConfig({}, {})
    return { mode: 'act', repo: REPO, device: 'd', runSource: 'local', poolSize: 16, cwd: '/work', loopDir: '/loop', sink: null, env: {}, toolsDir: '/tools', pluginRoot: '/plugin', config: loaded.config, configProblems: [], ...(memoryBytes === undefined ? {} : { memoryBytes }) } as unknown as Runtime
  }

  test('derived carries memoryBytes and effectiveCap as integers or null', () => {
    const r = rt(PLANT)
    const s = snapshotOf(r, control(), {}, {}, NOW, effectiveCap(r.config, PLANT, []))
    expect(s.derived).toMatchObject({ memoryBytes: PLANT, effectiveCap: 3 })
    expect(snapshotOf(rt(), control(), {}, {}, NOW).derived).toMatchObject({ memoryBytes: null, effectiveCap: null })
  })

  test('a snapshot from before the fields still parses', () => {
    const old = JSON.parse(JSON.stringify(snapshotOf(rt(), control(), {}, {}, NOW))) as { derived: Record<string, unknown> }
    delete old.derived.memoryBytes
    delete old.derived.effectiveCap
    expect(snapshotFrom(old)).not.toBeNull()
  })
})

// --- the planner ------------------------------------------------------------------------------------------

const LIFE = lifeOf(NOW - 2 * 60 * MIN)
const OK = { ok: true, at: NOW }
function rec(n: number, over: Partial<IssueRecord> = {}): IssueRecord {
  return { ...madeRecord({ issue: n, life: LIFE, branch: `issue-${n}`, pr: null, others: [] }, NOW - 30 * MIN), seq: 3, seqAt: NOW - 20 * MIN, state: 'building', step: 'build', since: NOW - 20 * MIN, ...over }
}
const queued = (n: number) => rec(n, { state: 'queued', step: 'lease', seq: 1 })
const leaseFor = (r: Pick<IssueRecord, 'issue' | 'life'>): Lease => ({ path: `/slots/${r.issue}`, lease: `L${r.issue}`, holder: `factory-loop:${r.issue}:${r.life}`, issue: r.issue, life: r.life, status: 'leased', busy: false })

function world(records: IssueRecord[], v2: Partial<V2State> = {}, over: Partial<State> = {}): State {
  const s = baseState({ pool: { free: 10, total: 16, slots: [] }, ...over })
  return { ...s, v2: { ...emptyV2State(NOW, records), sources: { store: OK, leases: OK, prs: OK, interventions: OK, comments: OK, dualWrite: OK }, leases: records.filter(r => SLOT_STATES.includes(r.state)).map(leaseFor), ...v2 } }
}
const said = (r: PlanResult, n: number) => r.skipped.filter(s => s.issue === n).map(s => s.why)
const capTells = (r: PlanResult) => r.actions.filter((a): a is Extract<Action, { kind: 'tell' }> => a.kind === 'tell' && a.wake === 'capacity')
const claims = (r: PlanResult) => r.actions.filter(a => a.kind === 'claim').map(a => a.issue)

describe('S1 and W1 hold to the effective cap', () => {
  const four = config({ mode: 'act', maxInFlightIssues: 4, worktreeReserve: 2 })

  test('S1: with maxInFlightIssues 4 and a ceiling of 3, three in flight hold the fourth claim, with the memory text and atCap set', () => {
    const s = world([rec(1), rec(2), rec(3)], { memoryBytes: PLANT }, { queue: [7], issues: [issue(7)] })
    const r = planV2(s, four)
    expect(claims(r)).toEqual([])
    expect(said(r, 7)).toEqual(['capacity: 3 of 3 queued or in flight (memory ceiling: 12.9 GiB, 3.0 GiB per slot, default)'])
    expect(r.atCap).toBe(true)
    expect(r.cap).toMatchObject({ effective: 3, configured: 4, ceiling: 3, memoryBytes: PLANT, estimateBytes: 3072 * MIB, estimateSource: 'default' })
    // without a memory read the configured cap stands: the fourth is claimed
    const free = planV2(world([rec(1), rec(2), rec(3)], { memoryBytes: null }, { queue: [7], issues: [issue(7)] }), four)
    expect(claims(free)).toEqual([7])
    expect(free.cap).toMatchObject({ effective: 4, ceiling: null })
  })

  test('S1: the configured cap holds with its unchanged text when it is the lower bound', () => {
    const r = planV2(world([rec(1), rec(2), rec(3)], { memoryBytes: PLANT }, { queue: [7], issues: [issue(7)] }), CFG)
    expect(said(r, 7)).toEqual(['capacity: 3 of 3 queued or in flight'])
    expect(capTells(r)).toEqual([])
  })

  test('W1: a queued record is not leased past the ceiling, and the text names the memory', () => {
    const s = world([rec(1), rec(2), rec(3), queued(10)], { memoryBytes: PLANT })
    const r = planV2(s, four)
    expect(r.actions.filter(a => a.kind === 'slot' && a.op === 'lease')).toEqual([])
    expect(said(r, 10)).toContain('W1: capacity: 3 of 3 in flight (memory ceiling: 12.9 GiB, 3.0 GiB per slot, default)')
    expect(r.atCap).toBe(true)
  })

  test('the measured estimate sizes the ceiling', () => {
    const lines = [1, 2, 3].map(n => gateLine(n, 2 * GIB))
    const s = world([rec(1)], { memoryBytes: PLANT, interventions: { ...emptyV2State(NOW).interventions, gates: lines } })
    const r = planV2(s, config({ mode: 'act', maxInFlightIssues: 8 }))
    // (12.9 - 2) GiB / 2 GiB = 5
    expect(r.cap).toMatchObject({ effective: 5, ceiling: 5, estimateBytes: 2 * GIB, estimateSource: 'measured' })
  })
})

describe('the capacity tell', () => {
  const four = config({ mode: 'act', maxInFlightIssues: 4 })

  test('the owner is told once per (configured, ceiling) pair, not as an owner item, naming the memory, reserve, estimate and effective cap', () => {
    const r = planV2(world([], { memoryBytes: PLANT }), four)
    const [tell] = capTells(r)
    expect(tell).toMatchObject({ key: 'tell:capacity:4:3', class: 'owner', fields: { configured: '4', ceiling: '3', effective: '3' } })
    expect(tell?.context.join('\n')).toMatch(/12\.9 GiB.*2\.0 GiB reserve.*3\.0 GiB per slot \(default\).*at most 3/s)
    expect(r.owner).toBe(0)
    // told: the same pair is not wanted again
    const told = world([], { memoryBytes: PLANT }, { ledger: [entry('tell:capacity:4:3', 'tell', { status: 'done', startedAt: NOW - 5 * MIN, endedAt: NOW - 4 * MIN, wake: 'capacity' })] })
    expect(capTells(planV2(told, four))).toEqual([])
    // a new ceiling is a new pair
    expect(capTells(planV2(world([], { memoryBytes: 9 * GIB }), four))[0]?.key).toBe('tell:capacity:4:2')
    expect(capTells(planV2(told, config({ mode: 'act', maxInFlightIssues: 5 })))[0]?.key).toBe('tell:capacity:5:3')
  })

  test('no tell while the configured cap is within the ceiling or the memory is unknown', () => {
    expect(capTells(planV2(world([], { memoryBytes: PLANT }), CFG))).toEqual([])
    expect(capTells(planV2(world([], { memoryBytes: null }), four))).toEqual([])
    expect(capTells(planV2(world([], {}), four))).toEqual([])
  })
})
