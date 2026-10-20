// `/factory config` (#698): the grouped settings view, its sources, and its read-only op.
import { describe, expect, test } from 'claude-code/testing'

import { GATE_CPUS, resolveGateConcurrency, shortDuration } from '../hooks/config'
import { configText, sourceOf, viewOf } from '../hooks/config-view'
import type { ConfigView } from '../hooks/config-view'
import { DEFAULT_CONFIG, loadConfig } from '../hooks/config'
import { SETTING_EFFECT, checkSetting } from '../hooks/config-keys'
import { helpText, parseOp, runOp } from '../hooks/control'
import type { FileIo } from '../hooks/control'
import { effectiveCap } from '../hooks/v2/capacity'
import { MIN, NOW, control } from './fixtures'

// a view over the layers as register's runtime() loads them
function view(repo: Record<string, unknown>, workspace: Record<string, unknown> = {}, extra: Partial<ConfigView> = {}): ConfigView {
  const loaded = loadConfig(repo, workspace)
  return {
    config: loaded.config,
    device: 'dev-box',
    poolSize: 16,
    cap: effectiveCap(loaded.config, null, undefined),
    repoRaw: repo,
    workspaceRaw: workspace,
    problems: loaded.problems,
    modeFrom: 'plugin',
    deviceFrom: 'env',
    pluginVersion: '0.44.0',
    ...extra,
  }
}

const GROUPS = ['Loop', 'Capacity', 'Claims', 'Limits', 'Agents and gates', 'Usage', 'Config problems']
const KEYS = [
  'mode', 'passEvery', 'mainEvery', 'plugin', 'device', 'maxInFlight', 'slotMemoryMiB', 'memoryReserveMiB', 'memory', 'memory ceiling', 'effective cap', 'poolSize', 'worktreeReserve', 'maxStarts', 'serial', 'new work', 'readyLabel', 'priorityLabel', 'skipLabels', 'queueScore',
  'reviewFixCap', 'conflictFixCap', 'maxLives', 'maxTriages', 'windDown', 'minimumReleaseCadence', 'releaseBranchPrefix', 'releaseHold', 'releaseInProgress', 'stateTimeout', 'reviewer', 'reviewerModel', 'triageModel', 'gateCommands', 'gateTimeout', 'gateConcurrency', 'gateWaitTimeout',
  'slow/new/all %', 'override',
]
const line = (text: string, label: string) => text.split('\n').find(l => l.startsWith(`  ${label} `)) ?? ''

describe('configText', () => {
  test('every group and key, in order, nothing over the width', () => {
    const text = configText(view({ gateCommands: ['npm run lint', 'npm test'] }), control(), NOW)
    const at = (needle: string) => text.split('\n').findIndex(l => l === needle || l.startsWith(`  ${needle} `))
    const order = [...GROUPS.slice(0, 6), ...KEYS].map(at)
    expect(order.every(i => i >= 0)).toBe(true)
    expect(at('Config problems')).toBeGreaterThan(at('override'))
    // groups in order, keys in order within them
    expect([...GROUPS.map(at)]).toEqual([...GROUPS.map(at)].sort((a, b) => a - b))
    expect(KEYS.map(at)).toEqual(KEYS.map(at).sort((a, b) => a - b))
    expect(text).toContain('npm run lint')
    expect(Math.max(...text.split('\n').map(l => l.length))).toBeLessThanOrEqual(60)
  })

  test('the Claims group shows the labels with their sources', () => {
    const def = configText(view({}), control(), NOW)
    expect(line(def, 'priorityLabel')).toContain('priority')
    expect(line(def, 'priorityLabel')).toContain('default')
    expect(line(def, 'skipLabels')).toContain('default')
    const set = configText(view({}, { priorityLabel: 'urgent' }), control(), NOW)
    expect(line(set, 'priorityLabel')).toContain('urgent')
    expect(line(set, 'priorityLabel')).toContain('workspace')
  })

  test('the Claims group shows the queueScore weights with their source; a set weight shows as repo or workspace, mixed when they differ', () => {
    const def = configText(view({}), control(), NOW)
    expect(line(def, 'queueScore')).toEndWith(' default')
    expect(def).toContain('priorityLabel 30 bug 25 unblocksDirect 10')
    expect(def).toContain('failedLife 10 failedLivesCap 30')
    const set = configText(view({}, { queueScore: { bug: 40 } }), control(), NOW)
    expect(set).toContain('bug 40')
    expect(line(set, 'queueScore')).toContain('mixed')
    expect(set).toContain('workspace: bug')
    const all = configText(view({}, { queueScore: Object.fromEntries(Object.keys(DEFAULT_CONFIG.queueScore).map(k => [k, 1])) }), control(), NOW)
    expect(line(all, 'queueScore')).toEndWith(' workspace')
    const mixed = configText(view({ queueScore: { epicStarted: 0 } }, { queueScore: { bug: 40 } }), control(), NOW)
    expect(line(mixed, 'queueScore')).toContain('mixed')
    expect(mixed).toContain('repo: epicStarted; workspace: bug')
  })

  test('queueScore.<name> sets one weight: whole numbers of at least 0; an unknown entry, a negative and a fraction are refused', () => {
    expect(checkSetting('queueScore.bug', 40)).toMatchObject({ ok: true, key: 'queueScore', sub: 'bug' })
    expect(checkSetting('queueScore.bug', 0)).toMatchObject({ ok: true })
    expect(checkSetting('queueScore.size', 5)).toMatchObject({ ok: false, error: 'queueScore.size: unknown entry. Not changed.' })
    const negative = checkSetting('queueScore.bug', -5)
    expect(negative).toMatchObject({ ok: false })
    expect(negative.ok ? '' : negative.error).toContain('queueScore.bug: -5 is not a whole number')
    const fraction = checkSetting('queueScore.bug', 1.5)
    expect(fraction.ok ? '' : fraction.error).toContain('queueScore.bug: 1.5 is not a whole number')
    expect(checkSetting('queueScore', 5)).toMatchObject({ ok: false })
    expect(SETTING_EFFECT.queueScore).toBe('next-pass')
  })

  test('conflictFixCap defaults to 5, applies on the next pass and shows in the view', () => {
    expect(DEFAULT_CONFIG.conflictFixCap).toBe(5)
    expect(SETTING_EFFECT.conflictFixCap).toBe('next-pass')
    expect(line(configText(view({}, {}), control(), NOW), 'conflictFixCap')).toContain('5')
  })

  test('the planner and shadow keys are retired: a file that sets either still loads, each is ignored and shown as a config problem', () => {
    const none = configText(view({}), control(), NOW)
    expect(none).not.toContain('planner')
    expect(none).toContain('Config problems\n  none')
    const text = configText(view({ planner: 'v1' }, { shadow: 'v2' }), control(), NOW)
    expect(text).not.toContain('v1 plans')
    expect(text).toContain('planner: retired, the loop always plans with v2, and')
    expect(text).toContain('shadow: retired, the loop always plans with v2, and')
    expect(line(text, 'maxInFlight')).toContain('3')
  })

  test('a long value, problem or gate command is cut to the width', () => {
    const long = 'x'.repeat(200)
    const text = configText(view({ gateCommands: [long], [long]: 1 }), control(), NOW)
    expect(Math.max(...text.split('\n').map(l => l.length))).toBeLessThanOrEqual(60)
    expect(text).toContain('...')
  })

  test('sources: default, repo, workspace', () => {
    const none = configText(view({}), control(), NOW)
    expect(line(none, 'passEvery')).toEndWith(' default')
    expect(line(configText(view({ passEvery: '2m' }), control(), NOW), 'passEvery')).toEndWith(' repo')
    expect(line(configText(view({ passEvery: '2m' }, { passEveryMs: 300_000 }), control(), NOW), 'passEvery')).toEndWith(' workspace')
    expect(line(configText(view({ passEvery: '2m' }), control(), NOW), 'passEvery')).toContain('2m')
  })

  test('mode and device come from the plugin, the workspace file or the machine; serial and new from directives', () => {
    const text = configText(view({}, {}, { modeFrom: 'workspace' }), control({ serial: true, noNewWork: true }), NOW)
    expect(line(text, 'mode')).toEndWith(' workspace')
    expect(line(text, 'device')).toContain('dev-box')
    expect(line(text, 'serial')).toContain('on')
    expect(line(text, 'serial')).toEndWith(' directive')
    expect(line(text, 'new work')).toContain('off')
  })

  test('a rejected workspace value shows the fallback source and its problem', () => {
    const rejected = view({ maxLives: 5 }, { maxLives: 0 })
    const text = configText(rejected, control(), NOW)
    expect(rejected.config.maxLives).toBe(5)
    expect(line(text, 'maxLives')).toContain('5')
    expect(line(text, 'maxLives')).toEndWith(' repo')
    expect(text).toContain('maxLives: 0 is not a whole number of at least 1')
    const fallback = configText(view({}, { passEvery: 'soon' }), control(), NOW)
    expect(line(fallback, 'passEvery')).toEndWith(' default')
    expect(fallback.split('Config problems\n')[1]).toContain('passEvery: "soon" is not a duration')
    expect(configText(view({}), control(), NOW).split('Config problems\n')[1]).toBe('  none')
  })

  test('mainEvery shows its value and source', () => {
    const def = configText(view({}), control(), NOW)
    expect(line(def, 'mainEvery')).toContain('5m')
    expect(line(def, 'mainEvery')).toEndWith(' default')
  })

  test('releaseBranchPrefix and releaseHold show their value and source; a hold of 0 shows off', () => {
    const def = configText(view({}), control(), NOW)
    expect(line(def, 'releaseBranchPrefix')).toContain('none')
    expect(line(def, 'releaseBranchPrefix')).toEndWith(' default')
    expect(line(def, 'releaseHold')).toContain('10m')
    expect(line(def, 'releaseHold')).toEndWith(' default')
    const set = configText(view({ releaseBranchPrefix: 'chore/release-', releaseHold: '0' }, { releaseHold: 0 }), control(), NOW)
    expect(line(set, 'releaseBranchPrefix')).toContain('chore/release-')
    expect(line(set, 'releaseBranchPrefix')).toEndWith(' repo')
    expect(line(set, 'releaseHold')).toContain('off')
    expect(line(set, 'releaseHold')).toEndWith(' workspace')
  })

  test('releaseInProgress shows its value and source; 0 shows off', () => {
    const def = configText(view({}), control(), NOW)
    expect(line(def, 'releaseInProgress')).toContain('2h')
    expect(line(def, 'releaseInProgress')).toEndWith(' default')
    const set = configText(view({ releaseInProgress: '0' }, { releaseInProgress: 0 }), control(), NOW)
    expect(line(set, 'releaseInProgress')).toContain('off')
    expect(line(set, 'releaseInProgress')).toEndWith(' workspace')
  })

  test('minimumReleaseCadence shows short form with its source, and a rejected value shows the fallback (#772)', () => {
    expect(line(configText(view({}), control(), NOW), 'minimumReleaseCadence')).toContain('6h')
    expect(line(configText(view({}), control(), NOW), 'minimumReleaseCadence')).toEndWith(' default')
    expect(line(configText(view({ minimumReleaseCadence: '3h' }), control(), NOW), 'minimumReleaseCadence')).toEndWith(' repo')
    expect(line(configText(view({}, { minimumReleaseCadence: '90m' }), control(), NOW), 'minimumReleaseCadence')).toContain('90m')
    const rejected = configText(view({}, { minimumReleaseCadence: '30m' }), control(), NOW)
    expect(line(rejected, 'minimumReleaseCadence')).toEndWith(' default')
    expect(rejected).toContain('minimumReleaseCadence: "30m" is not a duration of at le')
  })

  test('windDown shows minutes with its source, off for 0, and a rejected value shows the fallback', () => {
    expect(line(configText(view({}), control(), NOW), 'windDown')).toContain('10m')
    expect(line(configText(view({}), control(), NOW), 'windDown')).toEndWith(' default')
    expect(line(configText(view({ windDownMinutes: 3 }), control(), NOW), 'windDown')).toContain('3m')
    expect(line(configText(view({ windDownMinutes: 3 }), control(), NOW), 'windDown')).toEndWith(' repo')
    expect(line(configText(view({ windDownMinutes: 3 }, { windDownMinutes: 0 }), control(), NOW), 'windDown')).toContain('off')
    expect(line(configText(view({ windDownMinutes: 3 }, { windDownMinutes: 0 }), control(), NOW), 'windDown')).toEndWith(' workspace')
    const rejected = configText(view({}, { windDownMinutes: 1.5 }), control(), NOW)
    expect(line(rejected, 'windDown')).toEndWith(' default')
    expect(rejected).toContain('windDownMinutes: 1.5 is not a whole number')
    expect(loadConfig({ windDownMinutes: -1 }).config.windDownMinutes).toBe(DEFAULT_CONFIG.windDownMinutes)
  })

  test('stateTimeoutMs entries are checked one by one, on a compact line', () => {
    const text = configText(view({ stateTimeout: { design: '90m' } }, { stateTimeoutMs: { fix: 5 * MIN } }), control(), NOW)
    expect(line(text, 'stateTimeout')).toEndWith(' mixed')
    expect(text).toContain('repo: design')
    expect(text).toContain('workspace: fix')
    expect(text).toContain('design 90m')
    expect(text).toContain('fix 5m')
    expect(line(configText(view({}), control(), NOW), 'stateTimeout')).toEndWith(' default')
  })

  test('stateTimeoutMs lists the waiting period (24h by default) and takes a repo\'s value for it', () => {
    expect(configText(view({}), control(), NOW)).toContain('waiting 24h')
    const text = configText(view({ stateTimeout: { waiting: '6h' } }), control(), NOW)
    expect(text).toContain('repo: waiting')
    expect(text).toContain('waiting 6h')
  })

  test('the origin-unreadable problem is listed', () => {
    const problem = "settings: origin's default branch not read (origin/main: bad ref); the main checkout's file is used"
    const text = configText(view({}, {}, { problems: [problem] }), control(), NOW)
    expect(text).toContain("origin's default branch not read")
  })

  test('an override in force prints its end time; an expired one is none', () => {
    const live = control({ usageOverride: { untilPct: 97, expiresAt: NOW + 60 * MIN } })
    expect(line(configText(view({}), live, NOW), 'override')).toContain('to 97% until')
    const clock = new Date(NOW + 60 * MIN).toISOString().slice(11, 16)
    expect(configText(view({}), live, NOW)).toContain(`${clock} UTC`)
    const expired = control({ usageOverride: { untilPct: 97, expiresAt: NOW - 1 } })
    expect(line(configText(view({}), expired, NOW), 'override')).toContain('none')
    expect(line(configText(view({}), control(), NOW), 'override')).toContain('none')
  })

  test('no pass yet', () => {
    expect(configText(null, control(), NOW)).toBe('Factory loop: no pass yet, so no settings are loaded.')
  })
})

describe('sourceOf', () => {
  test('short spellings and sub-keys', () => {
    expect(sourceOf('passEveryMs', { passEvery: '1m' }, {})).toBe('repo')
    expect(sourceOf('passEveryMs', {}, { passEveryMs: 5 })).toBe('workspace')
    expect(sourceOf('stateTimeoutMs.fix', { stateTimeout: { fix: '1m' } }, {})).toBe('repo')
    expect(sourceOf('stateTimeoutMs.design', { stateTimeout: { fix: '1m' } }, {})).toBe('default')
    expect(sourceOf('passEveryMs', null, null)).toBe('default')
  })

  test('a rejected value is skipped for the lower layer whose value is in force', () => {
    const problems = ['maxLives: 0 is not a whole number of at least 1']
    expect(sourceOf('maxLives', { maxLives: 5 }, { maxLives: 0 }, problems)).toBe('repo')
    expect(sourceOf('maxLives', { maxLives: 0 }, { maxLives: 5 }, problems)).toBe('workspace')
    expect(sourceOf('maxLives', { maxLives: 0 }, { maxLives: 0 }, problems)).toBe('default')
    expect(sourceOf('maxLives', {}, { maxLives: 0 }, problems)).toBe('default')
  })
})

describe('shortDuration', () => {
  test('reads back through parseDuration', () => {
    expect([60_000, 5 * MIN, 120 * MIN, 30_000, 1500, 0].map(shortDuration)).toEqual(['1m', '5m', '2h', '30s', '1500ms', '0s'])
    expect(shortDuration(DEFAULT_CONFIG.passEveryMs)).toBe('1m')
  })
})

describe('viewOf deviceFrom', () => {
  test('is the Runtime\'s own, else env or default', () => {
    const base = { config: DEFAULT_CONFIG, poolSize: 16, configProblems: [], repoSettings: null }
    const of = (rt: object) => viewOf({ ...base, ...rt } as unknown as Parameters<typeof viewOf>[0]).deviceFrom
    expect(of({ device: 'coder-shadowed', deviceFrom: 'workspace' })).toBe('workspace')
    expect(of({ device: 'box' })).toBe('env')
    expect(of({ device: '' })).toBe('default')
  })
})

describe('viewOf', () => {
  test('a Runtime without the provenance fields reads as defaults', () => {
    const rt = { config: DEFAULT_CONFIG, device: '', poolSize: 16, configProblems: [], repoSettings: null } as unknown as Parameters<typeof viewOf>[0]
    const v = viewOf(rt)
    expect(v).toMatchObject({ repoRaw: {}, workspaceRaw: {}, modeFrom: 'plugin', pluginVersion: 'unknown' })
  })
})

describe('the config op', () => {
  const io: FileIo = { readFile: async () => null, writeFile: async () => Promise.reject(new Error('read-only op wrote')) }
  const paths = { loopDir: '/l', configDir: '/c' }

  test('parses with no argument only, and help lists it', () => {
    expect(parseOp('config')).toEqual({ ok: true, op: { op: 'config' } })
    expect(parseOp('config x')).toEqual({ ok: false, error: 'Usage: config [set <key> <value>|unset <key>]' })
    expect(helpText()).toContain('config')
  })

  test('an agent may run it, and it changes nothing', async () => {
    const v = view({})
    const reply = await runOp(io, paths, 'config', NOW, { agentId: 'a1', view: v })
    expect(reply).toMatchObject({ ok: true, ping: false, logged: null, text: configText(v, control(), NOW) })
  })
})

describe('SETTING_EFFECT', () => {
  test('names when every setting applies: each DEFAULT_CONFIG key, poolSize, and each key the view reads', () => {
    const table = Object.keys(SETTING_EFFECT).sort()
    expect(table).toEqual([...Object.keys(DEFAULT_CONFIG), 'poolSize'].sort())
    // every key configText reads from the config (a Proxy records them), and the view's poolSize
    const read = new Set<string>(['poolSize'])
    const spy = new Proxy(DEFAULT_CONFIG, {
      get: (target, prop, receiver) => {
        if (typeof prop === 'string') read.add(prop)
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    configText({ ...view({}), config: spy }, control(), NOW)
    expect(read.size).toBeGreaterThan(10)
    for (const key of read) expect(key in SETTING_EFFECT).toBe(true)
  })
})

describe('gate concurrency', () => {
  test('auto is max(1, floor(cpus / GATE_CPUS)); a number stays; a CPU count that is no positive integer is 1', () => {
    expect(GATE_CPUS).toBe(8)
    expect([1, 7, 8, 16, 17].map(cpus => resolveGateConcurrency('auto', cpus))).toEqual([1, 1, 1, 2, 2])
    expect([0, -4, 2.5, Number.NaN].map(cpus => resolveGateConcurrency('auto', cpus))).toEqual([1, 1, 1, 1])
    expect(resolveGateConcurrency(3, 64)).toBe(3)
  })

  test('the defaults are auto and 30 minutes; whole numbers of at least 1 and auto are kept, anything else is a problem', () => {
    const none = loadConfig({}, {})
    expect(none.config.gateConcurrency).toBe('auto')
    expect(none.config.gateWaitTimeoutMs).toBe(30 * MIN)
    expect(loadConfig({ gateConcurrency: 3, gateWaitTimeout: '5m' }, {}).config).toMatchObject({ gateConcurrency: 3, gateWaitTimeoutMs: 5 * MIN })
    expect(loadConfig({ gateConcurrency: 'auto' }, {}).problems).toEqual([])
    for (const bad of [0, -1, 'many', 2.5]) {
      const loaded = loadConfig({ gateConcurrency: bad }, {})
      expect(loaded.config.gateConcurrency).toBe('auto')
      expect(loaded.problems.some(p => p.startsWith(`gateConcurrency: ${JSON.stringify(bad)} is not `))).toBe(true)
    }
  })

  test('the view shows the number with where it came from, and the wait cap', () => {
    const auto = (cpus: number) => configText(view({}, {}, { cpus }), control(), NOW)
    expect(line(auto(8), 'gateConcurrency')).toContain('1 (auto: 8 CPUs / 8)')
    expect(line(auto(16), 'gateConcurrency')).toContain('2 (auto: 16 CPUs / 8)')
    expect(line(configText(view({ gateConcurrency: 3 }, {}, { cpus: 16 }), control(), NOW), 'gateConcurrency')).toContain('3 (repo)')
    expect(line(configText(view({ gateConcurrency: 3 }, { gateConcurrency: 4 }, { cpus: 16 }), control(), NOW), 'gateConcurrency')).toContain('4 (workspace)')
    expect(line(auto(8), 'gateWaitTimeout')).toContain('30m')
  })
})

describe('eventsSource (the record rebuild\'s source, v2 SPEC 3.3)', () => {
  test('new by default; old, new and shadow validate in either file; the key applies on the next pass', () => {
    expect(DEFAULT_CONFIG.eventsSource).toBe('new')
    expect(loadConfig({}).config.eventsSource).toBe('new')
    expect(SETTING_EFFECT.eventsSource).toBe('next-pass')
    for (const source of ['old', 'new', 'shadow'] as const) expect(loadConfig({ eventsSource: source })).toMatchObject({ config: { eventsSource: source }, problems: [] })
    expect(loadConfig({ eventsSource: 'new' }, { eventsSource: 'old' }).config.eventsSource).toBe('old')
  })

  test('an invalid value is a config problem and reads as old, the way back', () => {
    for (const bad of ['newest', 'OLD', true, 1, null]) {
      const loaded = loadConfig({ eventsSource: bad })
      expect(loaded.config.eventsSource).toBe('old')
      expect(loaded.problems).toEqual([`eventsSource: ${JSON.stringify(bad)} is not old, new or shadow (read as old)`])
    }
  })

  test('/factory config set takes a valid value and refuses an invalid one', () => {
    expect(checkSetting('eventsSource', 'old')).toMatchObject({ ok: true, key: 'eventsSource' })
    expect(checkSetting('eventsSource', 'sideways')).toMatchObject({ ok: false })
  })
})
