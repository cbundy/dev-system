// settings.json (settings-snapshot.ts): the snapshot of the settings in force and its write.
import { describe, expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG, loadConfig, resolveGateConcurrency } from '../hooks/config'
import type { Runtime } from '../hooks/observe'
import { agentModelsOf, forgetModels, leafKeys, modelOf, shareOf, snapshotOf, writeSnapshot } from '../hooks/settings-snapshot'
import type { Snapshot } from '../hooks/settings-snapshot'
import { WIND_DOWN_WRITE_SCRIPT } from '../hooks/v2/wind-down-files'
import { MIN, NOW, control } from './fixtures'

const TOKEN = 'ghp_FAKE_SECRET_TOKEN_123'

function runtime(repo: Record<string, unknown> = {}, workspace: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const loaded = loadConfig(repo, Object.fromEntries(Object.entries(workspace).filter(([k]) => k !== 'poolSize')))
  return {
    mode: 'observe',
    repo: 'o/r',
    device: 'dev-box',
    runSource: 'local',
    poolSize: typeof workspace.poolSize === 'number' ? workspace.poolSize : 16,
    cwd: '/work',
    loopDir: '/loop',
    sink: null,
    env: { GH_TOKEN: TOKEN },
    toolsDir: '/tools',
    pluginRoot: '/plugin',
    config: loaded.config,
    cpus: 16,
    gateConcurrency: resolveGateConcurrency(loaded.config.gateConcurrency, 16),
    configProblems: loaded.problems,
    repoSettings: repo,
    workspaceRaw: { ...workspace, token: TOKEN },
    deviceFrom: 'env',
    pluginVersion: '0.60.0',
    ...extra,
  } as unknown as Runtime & { workspaceRaw: Record<string, unknown>; pluginVersion: string; deviceFrom: 'env' }
}

const snap = (rt = runtime(), models = {}, env = {}, at = NOW, ctl = control()): Snapshot => snapshotOf(rt, ctl, models, env, at)

describe('snapshotOf', () => {
  const rt = runtime({ stateTimeoutMs: { design: 5 * MIN }, gateCommands: ['npm test'] }, { maxInFlightIssues: 2, poolSize: 8 })
  const s = snap(rt)

  test('every config key, the extras, the fixed shape', () => {
    expect(s.problems).toEqual([])
    expect(s).toMatchObject({ v: 1, repo: 'o/r', at: new Date(NOW).toISOString(), plugin_version: '0.60.0', problems: [] })
    for (const key of Object.keys(DEFAULT_CONFIG)) expect(s.settings).toHaveProperty([key])
    expect(Object.keys(s.settings).slice(0, Object.keys(DEFAULT_CONFIG).length)).toEqual(Object.keys(DEFAULT_CONFIG))
    expect(s.settings).toMatchObject({ poolSize: 8, device: 'dev-box', serial: false, noNewWork: false, usageOverride: null, maxInFlightIssues: 2, gateCommands: ['npm test'] })
  })

  test('layers: the source of each leaf, keys equal the settings leaves', () => {
    expect(s.layers['stateTimeoutMs.design']).toBe('repo')
    expect(s.layers['stateTimeoutMs.build']).toBe('default')
    expect(s.layers.gateCommands).toBe('repo')
    expect(s.layers.maxInFlightIssues).toBe('workspace')
    expect(s.layers.poolSize).toBe('workspace')
    expect(s.layers.device).toBe('env')
    expect(s.layers.mode).toBe('plugin')
    expect(s.layers.serial).toBe('directive')
    expect(s.layers.noNewWork).toBe('directive')
    expect(s.layers.usageOverride).toBe('directive')
    const leaves = [...leafKeys(rt.config), 'poolSize', 'device', 'serial', 'noNewWork', 'usageOverride']
    expect(Object.keys(s.layers).sort()).toEqual([...leaves].sort())
    expect(Object.keys(s.layers)).toContain('rateCaps.start')
    expect(Object.keys(s.layers)).not.toContain('rateCaps')
    expect(Object.keys(s.layers)).toContain('queueScore.bug')
    expect(s.settings).toHaveProperty(['queueScore', 'bug'], 25)
    // the intake settings and weights (#995)
    expect(s.settings).toMatchObject({ intakeStamp: 'off', intakeModel: 'haiku', intakeAreas: ['factory', 'product'] })
    expect(s.settings).toHaveProperty(['queueScore', 'areaFactory'], 20)
    expect(s.settings).toHaveProperty(['queueScore', 'needsOwner'], 40)
    expect(s.settings).toHaveProperty(['queueScore', 'overlap'], 15)
    expect(s.settings).toMatchObject({ regime: 'factory_loop_v2' })
    for (const key of ['regime', 'intakeStamp', 'intakeModel', 'intakeAreas', 'queueScore.areaFactory', 'queueScore.needsOwner', 'queueScore.overlap']) expect(s.layers[key]).toBe('default')
  })

  test('a mode from the workspace file, and a pool size nobody set', () => {
    const t = snap(runtime({}, { mode: 'act' }))
    expect(t.layers.mode).toBe('workspace')
    expect(t.layers.poolSize).toBe('default')
  })

  test('a value the loader rejected reports the lower layer', () => {
    const t = snap(runtime({ maxLives: 5 }, { maxLives: 0 }))
    expect(t.problems.length).toBeGreaterThan(0)
    expect(t.settings.maxLives).toBe(5)
    expect(t.layers.maxLives).toBe('repo')
  })

  test('a live usage override is written, an expired one is null', () => {
    const ctl = control({ serial: true, noNewWork: true, usageOverride: { untilPct: 97, expiresAt: NOW + MIN } })
    expect(snap(runtime(), {}, {}, NOW, ctl).settings).toMatchObject({ serial: true, noNewWork: true, usageOverride: { untilPct: 97, expiresAt: NOW + MIN } })
    expect(snap(runtime(), {}, {}, NOW + 2 * MIN, ctl).settings.usageOverride).toBeNull()
  })

  test('derived: models, concurrency, cpus and shares', () => {
    const t = snap(runtime({ triageModel: 'sonnet' }), { designer: 'opus', builder: 'sonnet', fixer: null }, { implementerOpusPct: '25', designSessionPct: 'abc' })
    expect(t.derived).toEqual({
      gateConcurrency: 2,
      cpus: 16,
      memoryBytes: null,
      effectiveCap: null,
      models: { designer: 'opus', builder: 'sonnet', fixer: null, triage: 'sonnet', reviewer: DEFAULT_CONFIG.reviewerModel, adjudicator: null },
      experiment: { implementerOpusPct: 25, designSessionPct: null },
    })
  })

  test('two snapshots differ only in at; no environment or workspace secret is written', () => {
    const a = JSON.stringify(snap(rt, {}, {}, NOW))
    const b = JSON.stringify(snap(rt, {}, {}, NOW + MIN))
    expect(a.replace(new Date(NOW).toISOString(), '')).toBe(b.replace(new Date(NOW + MIN).toISOString(), ''))
    expect(a).not.toContain(TOKEN)
    expect(a).not.toContain('"checkout"')
  })
})

describe('modelOf and shareOf', () => {
  test('modelOf reads the frontmatter model line only', () => {
    expect(modelOf('---\nname: x\nmodel: opus\n---\nmodel: haiku\n')).toBe('opus')
    expect(modelOf('---\nname: x\n---\nbody')).toBeNull()
    expect(modelOf(null)).toBeNull()
  })
  test('shareOf is an integer 0-100', () => {
    expect([shareOf('25'), shareOf('0'), shareOf('100')]).toEqual([25, 0, 100])
    expect([shareOf(undefined), shareOf(null), shareOf(''), shareOf('abc'), shareOf('101'), shareOf('2.5'), shareOf('-1')]).toEqual([null, null, null, null, null, null, null])
  })
})

describe('agentModelsOf', () => {
  test('reads each agent file once per plugin; a missing file is null', async () => {
    forgetModels()
    const reads: string[] = []
    const read = async (p: string) => {
      reads.push(p)
      return p.endsWith('fixer.md') ? null : '---\nmodel: opus\n---\n'
    }
    const a = await agentModelsOf(read, '/p1')
    await agentModelsOf(read, '/p1')
    expect(a).toEqual({ designer: 'opus', builder: 'opus', fixer: null })
    expect(reads).toHaveLength(3)
    expect(reads.some(r => r.includes('adjudicator'))).toBe(false)
    expect(reads).toContain('/p1/agents/designer-v2.md')
    await agentModelsOf(read, '/p2')
    expect(reads).toHaveLength(6)
  })
})

describe('writeSnapshot', () => {
  test('runs the atomic write script over settings.json with the JSON on stdin', async () => {
    const calls: { argv: string[]; stdin?: string }[] = []
    const out = await writeSnapshot({ run: async (argv, init) => (calls.push({ argv, stdin: init.stdin }), { exitCode: 0, stderr: '' }) }, '/loop', snap())
    expect(out).toEqual([])
    expect(calls[0]?.argv).toEqual(['sh', '-c', WIND_DOWN_WRITE_SCRIPT, 'settings-snapshot', '/loop/settings.json'])
    expect(calls[0]?.stdin?.endsWith('}\n')).toBe(true)
    expect(JSON.parse(calls[0]?.stdin ?? '')).toMatchObject({ v: 1, repo: 'o/r' })
  })
  test('a non-zero exit and a throw are each one problem and never throw', async () => {
    const failed = await writeSnapshot({ run: async () => ({ exitCode: 1, stderr: 'no space' }) }, '/loop', snap())
    expect(failed).toHaveLength(1)
    expect(failed[0]).toStartWith('settings snapshot: ')
    const threw = await writeSnapshot({ run: async () => Promise.reject(new Error('boom')) }, '/loop', snap())
    expect(threw).toEqual(['settings snapshot: write failed (boom)'])
  })
})
