// `/factory config` (#698): the grouped settings view, its sources, and its read-only op.
import { describe, expect, test } from 'claude-code/testing'

import { shortDuration } from '../hooks/config'
import { configText, sourceOf, viewOf } from '../hooks/config-view'
import type { ConfigView } from '../hooks/config-view'
import { DEFAULT_CONFIG, loadConfig } from '../hooks/config'
import { SETTING_EFFECT } from '../hooks/config-keys'
import { helpText, parseOp, runOp } from '../hooks/control'
import type { FileIo } from '../hooks/control'
import { MIN, NOW, control } from './fixtures'

// a view over the layers as register's runtime() loads them
function view(repo: Record<string, unknown>, workspace: Record<string, unknown> = {}, extra: Partial<ConfigView> = {}): ConfigView {
  const loaded = loadConfig(repo, workspace)
  return {
    config: loaded.config,
    device: 'dev-box',
    poolSize: 16,
    repoRaw: repo,
    workspaceRaw: workspace,
    problems: loaded.problems,
    modeFrom: 'plugin',
    deviceFrom: 'env',
    pluginVersion: '0.44.0',
    ...extra,
  }
}

const GROUPS = ['Loop', 'Capacity', 'Limits', 'Agents and gates', 'Usage', 'Config problems']
const KEYS = [
  'mode', 'planner', 'passEvery', 'plugin', 'device', 'maxInFlight', 'poolSize', 'worktreeReserve', 'maxStarts', 'serial', 'new work',
  'reviewFixCap', 'maxLives', 'maxTriages', 'stateTimeout', 'reviewer', 'reviewerModel', 'triageModel', 'gateCommands', 'gateTimeout',
  'slow/new/all %', 'override',
]
const line = (text: string, label: string) => text.split('\n').find(l => l.startsWith(`  ${label} `)) ?? ''

describe('configText', () => {
  test('every group and key, in order, nothing over the width', () => {
    const text = configText(view({ gateCommands: ['npm run lint', 'npm test'] }), control(), NOW)
    const at = (needle: string) => text.split('\n').findIndex(l => l === needle || l.startsWith(`  ${needle} `))
    const order = [...GROUPS.slice(0, 5), ...KEYS].map(at)
    expect(order.every(i => i >= 0)).toBe(true)
    expect(at('Config problems')).toBeGreaterThan(at('override'))
    // groups in order, keys in order within them
    expect([...GROUPS.map(at)]).toEqual([...GROUPS.map(at)].sort((a, b) => a - b))
    expect(KEYS.map(at)).toEqual(KEYS.map(at).sort((a, b) => a - b))
    expect(text).toContain('npm run lint')
    expect(Math.max(...text.split('\n').map(l => l.length))).toBeLessThanOrEqual(60)
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

  test('stateTimeoutMs entries are checked one by one, on a compact line', () => {
    const text = configText(view({ stateTimeout: { design: '90m' } }, { stateTimeoutMs: { fix: 5 * MIN } }), control(), NOW)
    expect(line(text, 'stateTimeout')).toEndWith(' mixed')
    expect(text).toContain('repo: design')
    expect(text).toContain('workspace: fix')
    expect(text).toContain('design 90m')
    expect(text).toContain('fix 5m')
    expect(line(configText(view({}), control(), NOW), 'stateTimeout')).toEndWith(' default')
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
