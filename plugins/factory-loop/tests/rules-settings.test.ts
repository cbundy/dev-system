// N1, the settings that changed (rules-settings.ts): the diff of two snapshots, who made each change, the once
// key, the flood cap, and the pass that keeps the snapshot and the config ops (driver-pass.ts, driver-controls.ts).
import { describe, expect, test } from 'claude-code/testing'

import { loadConfig, resolveGateConcurrency } from '../hooks/config'
import type { Runtime } from '../hooks/observe'
import { SNAPSHOT_VERSION, snapshotFrom, snapshotOf } from '../hooks/settings-snapshot'
import type { Snapshot } from '../hooks/settings-snapshot'
import type { Action, State } from '../hooks/types'
import { eventArgv } from '../hooks/v2/events'
import { validateStrict } from '../hooks/v2/event-reader'
import { emptyV2State } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { SETTINGS_FLOOD, diffSnapshots, opsFrom, settingsKey } from '../hooks/v2/rules-settings'
import type { SettingsOp, V2State } from '../hooks/v2/types'
import { MIN, NOW, config, control, entry, state as baseState } from './fixtures'
import { REPO } from './host'

const CFG = config({ mode: 'act' })
const OK = { ok: true, at: NOW }

function runtime(repo: Record<string, unknown> = {}, workspace: Record<string, unknown> = {}, version = '0.60.0') {
  const loaded = loadConfig(repo, workspace)
  return {
    mode: 'act', repo: REPO, device: 'dev-box', runSource: 'local', poolSize: 16, cwd: '/work', loopDir: '/loop', sink: null, env: {}, toolsDir: '/tools', pluginRoot: '/plugin',
    config: loaded.config, cpus: 16, gateConcurrency: resolveGateConcurrency(loaded.config.gateConcurrency, 16), configProblems: loaded.problems,
    repoSettings: repo, workspaceRaw: workspace, deviceFrom: 'env', pluginVersion: version,
  } as unknown as Runtime
}
const snap = (rt: Runtime, at = NOW): Snapshot => snapshotOf(rt, control(), {}, {}, at)

type Ev = Extract<Action, { kind: 'event' }>
function plan(now: Snapshot, before: Snapshot | null, ops: SettingsOp[] = [], ledger = baseState().ledger): Ev[] {
  const s = baseState({ ledger })
  const v2: V2State = { ...emptyV2State(NOW), sources: { ...emptyV2State(NOW).sources, store: OK }, settings: { now, nowAt: Date.parse(now.at), before, beforeAt: before === null ? null : Date.parse(before.at), ops } }
  const result = planV2({ ...s, v2 }, CFG)
  return result.actions.filter((a): a is Ev => a.kind === 'event' && a.rule === 'N1')
}
const dataOf = (a: Ev | undefined) => (a?.event.state === 'settings_changed' ? a.event.data : null)

describe('the diff and who made each change', () => {
  const T0 = NOW - 10 * MIN
  const before = snap(runtime(), T0)

  test('a judge op and a person op name the key; the op decides over the layer', () => {
    const now = snap(runtime({}, { maxInFlightIssues: 5 }), NOW)
    const [a, ...rest] = plan(now, before, [{ key: 'maxInFlightIssues', by: 'judge', at: T0 + MIN }])
    expect(rest).toEqual([])
    expect(dataOf(a)).toEqual({ key: 'maxInFlightIssues', old_value: before.settings.maxInFlightIssues, new_value: 5, layer: 'workspace', who: 'judge', fact: settingsKey('maxInFlightIssues', NOW) })
    expect(dataOf(plan(now, before, [{ key: 'maxInFlightIssues', by: 'person', at: T0 + MIN }])[0])?.who).toBe('person')
  })

  test('an op older than the previous snapshot, or for another key, does not count', () => {
    const now = snap(runtime({}, { maxInFlightIssues: 5 }), NOW)
    expect(dataOf(plan(now, before, [{ key: 'maxInFlightIssues', by: 'judge', at: T0 - MIN }])[0])?.who).toBe('person')
    expect(dataOf(plan(now, before, [{ key: 'passEveryMs', by: 'judge', at: T0 + MIN }])[0])?.who).toBe('person')
  })

  test('a hand-edited workspace file (no op) is a person', () => {
    const d = dataOf(plan(snap(runtime({}, { maxInFlightIssues: 5 })), before)[0])
    expect(d).toMatchObject({ key: 'maxInFlightIssues', layer: 'workspace', who: 'person' })
  })

  test('a repo file change is the repo, an expanded object leaf is one key', () => {
    const d = dataOf(plan(snap(runtime({ stateTimeoutMs: { design: 5 * MIN } })), before)[0])
    expect(d).toMatchObject({ key: 'stateTimeoutMs.design', layer: 'repo', who: 'repo', new_value: 5 * MIN })
  })

  test('a default that moved with the plugin is the plugin; the same default without a new version is a person', () => {
    const old = snap(runtime({}, {}, '0.59.0'), T0)
    const now = snap(runtime({}, {}, '0.60.0'))
    const was = JSON.parse(JSON.stringify(now)) as Snapshot
    // the older plugin shipped another default
    old.settings.maxAttempts = { ...(old.settings.maxAttempts as object), claim: 99 }
    const moved = diffSnapshots(old, was)
    expect(moved.map(c => c.key)).toContain('plugin_version'.replace('plugin_version', 'maxAttempts.claim'))
    const d = plan(now, old).find(e => dataOf(e)?.key === 'maxAttempts.claim')
    expect(dataOf(d)).toMatchObject({ layer: 'default', who: 'plugin' })
    const same = { ...old, plugin_version: now.plugin_version }
    expect(dataOf(plan(now, same).find(e => dataOf(e)?.key === 'maxAttempts.claim'))).toMatchObject({ layer: 'default', who: 'person' })
  })

  test('a derived change has no layer and is the plugin', () => {
    const now = { ...snap(runtime()), derived: { ...before.derived, gateConcurrency: (before.derived.gateConcurrency ?? 0) + 1 } }
    const d = dataOf(plan(now, before)[0])
    expect(d).toMatchObject({ key: 'derived.gateConcurrency', layer: null, who: 'plugin', old_value: before.derived.gateConcurrency, new_value: (before.derived.gateConcurrency ?? 0) + 1 })
    const models = { ...snap(runtime()), derived: { ...before.derived, models: { ...before.derived.models, builder: 'opus' } } }
    expect(dataOf(plan(models, before)[0])?.key).toBe('derived.models.builder')
  })

  test('arrays are leaves, compared by value; at and problems are never diffed', () => {
    const a = snap(runtime({ gateCommands: ['npm test'] }), T0)
    expect(diffSnapshots(a, { ...snap(runtime({ gateCommands: ['npm test'] })), problems: ['x'] })).toEqual([])
    expect(diffSnapshots(a, snap(runtime({ gateCommands: ['npm test', 'npm run lint'] }))).map(c => c.key)).toEqual(['gateCommands'])
  })
})

describe('when nothing is logged', () => {
  const now = snap(runtime({}, { maxInFlightIssues: 5 }))
  test('no snapshot kept, an unchanged one, a corrupt one or one of another version', () => {
    expect(plan(now, null)).toEqual([])
    expect(plan(now, snap(runtime({}, { maxInFlightIssues: 5 }), NOW - MIN))).toEqual([])
    expect(snapshotFrom('nope')).toBeNull()
    expect(snapshotFrom({ ...now, v: SNAPSHOT_VERSION + 1 })).toBeNull()
    expect(snapshotFrom({ ...now, at: 'never' })).toBeNull()
    expect(snapshotFrom({ ...now, settings: null })).toBeNull()
    expect(snapshotFrom(JSON.parse(JSON.stringify(now)))).toEqual({ snap: now, at: NOW })
    expect(opsFrom([{ key: 'a', by: 'judge', at: 1 }, { key: 'b' }, 'x'])).toEqual([{ key: 'a', by: 'judge', at: 1 }])
    expect(opsFrom(undefined)).toEqual([])
  })

  test('a replayed pair logs once: the once key is the same, and its done entry stops it', () => {
    const before = snap(runtime())
    const [a] = plan(now, before)
    const [b] = plan(now, before)
    expect(a?.key).toBe(b?.key)
    expect(a?.key).toBe(`settings/maxInFlightIssues/${NOW.toString(36)}`)
    expect(plan(now, before, [], [...baseState().ledger, entry(a?.key ?? '', 'event', { rule: 'N1', startedAt: NOW, endedAt: NOW })])).toEqual([])
  })
})

describe('the flood guard', () => {
  test('more than 50 changed leaves log 50 events and one skip line', () => {
    const before = snap(runtime())
    const now = JSON.parse(JSON.stringify(before)) as Snapshot
    for (let i = 0; i < 60; i++) now.settings[`extra${i}`] = i
    for (let i = 0; i < 60; i++) now.layers[`extra${i}`] = 'workspace'
    expect(diffSnapshots(before, now)).toHaveLength(60)
    const s = baseState()
    const v2: V2State = { ...emptyV2State(NOW), sources: { ...emptyV2State(NOW).sources, store: OK }, settings: { now, nowAt: Date.parse(now.at), before, beforeAt: Date.parse(before.at), ops: [] } }
    const result = planV2({ ...s, v2 }, CFG)
    expect(result.actions.filter(a => a.kind === 'event' && a.rule === 'N1')).toHaveLength(SETTINGS_FLOOD)
    expect(result.skipped.filter(k => k.rule === 'N1').map(k => k.why)).toEqual([expect.stringContaining('60 settings changed at once; the first 50 are logged, 10 skipped')])
  })
})

describe('the event', () => {
  test('goes through the real writer argv and matches settings_changed.v1', () => {
    const before = snap(runtime())
    const events = plan(snap(runtime({}, { maxInFlightIssues: 5 })), before)
    const argv = eventArgv(events[0]?.event as never)
    expect(argv.slice(0, 3)).toEqual(['fabriek-event', '--type', 'settings_changed'])
    const data = JSON.parse(argv[4] ?? '{}') as unknown
    expect(validateStrict('settings_changed', 1, data)).toEqual([])
    const derived = plan({ ...snap(runtime()), derived: { ...before.derived, cpus: 3 } }, before)
    expect(validateStrict('settings_changed', 1, dataOf(derived[0]))).toEqual([])
  })
})
