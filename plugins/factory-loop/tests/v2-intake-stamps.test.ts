// The intake stamps' store key and the in-flight paths source (hooks/v2/stamps.ts, store.ts,
// sources-paths.ts; docs/factory-loop/v2/SPEC.md 2.4, epic #995).
import { describe, expect, test } from 'claude-code/testing'

import { emptyCache } from '../hooks/observe'
import type { Io, Runtime } from '../hooks/observe'
import { loadV2, newV2Live, readStoredV2, storedV2 } from '../hooks/v2/store'
import type { V2StoreIo } from '../hooks/v2/store'
import { observeV2, recordsToStore } from '../hooks/v2/observe'
import type { SourceCtx, V2Readers } from '../hooks/v2/observe'
import { readPaths, topLevel } from '../hooks/v2/sources-paths'
import type { PathsCache } from '../hooks/v2/sources-paths'
import { stampsFromStore, stampsKey } from '../hooks/v2/stamps'
import type { IssueRecord } from '../hooks/v2/types'
import { madeRecord } from '../hooks/v2/table'
import { DEVICE, NOW, CLEAN, PLUGIN_ROOT, config, state as baseState } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

const GOOD = { version: 'b1', area: 'factory', needsOwner: true, touches: ['plugins/x'], at: NOW, labels: ['area:factory'] }

describe('stamps:<repo>', () => {
  test('stampsFromStore keeps good entries, drops a malformed one, and gives {} for anything else', () => {
    expect(stampsFromStore({ v: 1, stamps: { '12': GOOD, '13': { ...GOOD, version: '' }, '14': { ...GOOD, touches: 'x' }, '15': { ...GOOD, needsOwner: 'yes' }, '16': { ...GOOD, at: 'now' }, '17': null, x: GOOD } })).toEqual({ '12': GOOD })
    for (const raw of [undefined, null, 'x', 4, [], { v: 2, stamps: { '12': GOOD } }, { v: 1 }, { v: 1, stamps: [] }, { stamps: { '12': GOOD } }]) expect(stampsFromStore(raw)).toEqual({})
  })

  test('loadV2, storedV2 and readStoredV2 read the key; a read that throws still loads the records', async () => {
    const records = [madeRecord({ issue: 5, life: 'l1', branch: 'issue-5', pr: null, others: [] }, NOW)]
    const values = new Map<string, unknown>([
      [`records:${REPO}`, recordsToStore(records, NOW)],
      [stampsKey(REPO), { v: 1, stamps: { '5': GOOD } }],
    ])
    let failStamps = false
    const io: V2StoreIo = {
      get: async key => {
        if (failStamps && key === stampsKey(REPO)) throw new Error('down')
        return values.get(key)
      },
      set: async () => undefined,
      now: async () => NOW,
    }
    const live = newV2Live()
    await loadV2(live, io, REPO)
    expect(live.loaded).toBe(true)
    expect(live.stamps).toEqual({ '5': GOOD })
    expect((await storedV2(live, io, REPO)).stamps).toEqual({ '5': GOOD })
    expect((await readStoredV2(io, REPO)).stamps).toEqual({ '5': GOOD })
    failStamps = true
    const broken = newV2Live()
    await loadV2(broken, io, REPO)
    expect(broken).toMatchObject({ loaded: true, stamps: {} })
    expect(broken.records).toHaveLength(1)
    // no stamps: the field is absent from what observe is handed
    values.delete(stampsKey(REPO))
    failStamps = false
    expect(await readStoredV2(io, REPO)).not.toHaveProperty('stamps')
  })
})

const SHA1 = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)
const rec = (n: number, over: Partial<IssueRecord> = {}): IssueRecord => ({ ...madeRecord({ issue: n, life: 'l1', branch: `issue-${n}`, pr: null, others: [] }, NOW), head: SHA1, ...over })

// A fake git: base 'main', diffs by head sha; `fail` names the verbs that fail.
function fake(diffs: Record<string, string>, over: { checkout?: unknown; on?: boolean; limited?: boolean } = {}) {
  const log: string[][] = []
  const fail = new Set<string>()
  const ctx = (records: IssueRecord[]): SourceCtx =>
    ({
      now: NOW,
      rt: { config: config({ intakeStamp: over.on === false ? 'off' : 'on' }) },
      state: { checkout: over.checkout === undefined ? CLEAN : over.checkout },
      records,
      run: async (argv: string[]) => {
        log.push(argv)
        const verb = argv[1] === 'diff' || argv[1] === 'merge-base' || argv[1] === 'cat-file' ? (argv[1] as string) : 'fetch'
        if (fail.has(verb)) return { exitCode: 1, stdout: '', stderr: 'no' }
        if (argv[1] === 'merge-base') return { exitCode: 0, stdout: 'cafe\n', stderr: '' }
        if (argv[1] === 'diff') {
          const head = (argv[4] as string).split('..')[1] as string
          return { exitCode: 0, stdout: diffs[head] ?? '', stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }) as unknown as SourceCtx
  return { log, fail, ctx }
}

describe('the in-flight paths source', () => {
  test('topLevel cuts to the first segment, de-duplicated and sorted', () => {
    expect(topLevel(['plugins/a/b.ts', 'docs/x.md', 'plugins/c.ts', 'README.md', '', 'docs/y.md'])).toEqual(['README.md', 'docs', 'plugins'])
  })

  test('reads each live record\'s pushed head against origin/<default>: fetch, check, merge-base, diff --name-only', async () => {
    const f = fake({ [SHA1]: 'plugins/a/b.ts\ndocs/x.md\nplugins/c.ts\n' })
    const r = await readPaths(f.ctx([rec(5)]), {}, () => false)
    expect(r.paths).toEqual({ 5: ['docs', 'plugins'] })
    expect(r.cache).toEqual({ [`5 ${SHA1}`]: ['docs', 'plugins'] })
    expect(f.log).toEqual([
      ['git', 'fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      ['git', 'cat-file', '-e', `${SHA1}^{commit}`],
      ['git', 'merge-base', 'refs/remotes/origin/main', SHA1],
      ['git', 'diff', '--name-only', '--no-renames', `cafe..${SHA1}`],
    ])
  })

  test('a head missing here is fetched by its sha', async () => {
    const f = fake({})
    f.fail.add('cat-file')
    await readPaths(f.ctx([rec(5)]), {}, () => false)
    expect(f.log.some(a => a.join(' ') === `git fetch --quiet origin ${SHA1}`)).toBe(true)
  })

  test('a cached head is not read again until it moves', async () => {
    const f = fake({ [SHA1]: 'a/x\n', [SHA2]: 'b/x\n' })
    const first = await readPaths(f.ctx([rec(5)]), {}, () => false)
    f.log.length = 0
    const again = await readPaths(f.ctx([rec(5)]), first.cache, () => false)
    expect(again.paths).toEqual({ 5: ['a'] })
    expect(f.log).toEqual([])
    const moved = await readPaths(f.ctx([rec(5, { head: SHA2 })]), again.cache, () => false)
    expect(moved.paths).toEqual({ 5: ['b'] })
    expect(moved.cache).toEqual({ [`5 ${SHA2}`]: ['b'] })
  })

  test('a failed read gives null for that record, keeps nothing, and is tried again next pass', async () => {
    const f = fake({ [SHA1]: 'a/x\n' })
    f.fail.add('diff')
    const r = await readPaths(f.ctx([rec(5), rec(6, { head: SHA2 })]), {}, () => false)
    expect(r.paths).toEqual({ 5: null, 6: null })
    expect(r.cache).toEqual({})
    f.fail.clear()
    const next = await readPaths(f.ctx([rec(5)]), r.cache, () => false)
    expect(next.paths).toEqual({ 5: ['a'] })
    f.fail.add('merge-base')
    expect((await readPaths(f.ctx([rec(5)]), {}, () => false)).paths).toEqual({ 5: null })
    f.fail.clear()
    f.fail.add('fetch')
    expect((await readPaths(f.ctx([rec(5)]), {}, () => false)).paths).toEqual({ 5: null })
  })

  test('closed records and records without a head are skipped', async () => {
    const f = fake({ [SHA1]: 'a/x\n' })
    const r = await readPaths(f.ctx([rec(5, { state: 'closed' }), rec(6, { head: null }), rec(7)]), {}, () => false)
    expect(Object.keys(r.paths)).toEqual(['7'])
  })

  test('nothing runs with the switch off, without a default branch, or while blocked', async () => {
    const off = fake({}, { on: false })
    expect(await readPaths(off.ctx([rec(5)]), {}, () => false)).toEqual({ paths: {}, cache: {} })
    expect(off.log).toEqual([])
    for (const checkout of [null, { error: 'x' }]) {
      const none = fake({}, { checkout })
      expect((await readPaths(none.ctx([rec(5)]), {}, () => false)).paths).toEqual({})
      expect(none.log).toEqual([])
    }
    const blocked = fake({ [SHA1]: 'a/x\n' })
    const cache: PathsCache = { [`6 ${SHA1}`]: ['kept'] }
    const r = await readPaths(blocked.ctx([rec(5), rec(6)]), cache, () => true)
    expect(blocked.log).toEqual([])
    expect(r.paths).toEqual({ 6: ['kept'] })
  })
})

// observeV2 itself: the run log with the switch off, and the V2State fields with it on
describe('observeV2 and the intake switch', () => {
  async function pass(intakeStamp: 'off' | 'on', tag?: string | null) {
    const runs: string[][] = []
    const run = async (argv: string[]) => {
      runs.push(argv)
      if (argv[1] === 'merge-base') return { exitCode: 0, stdout: 'cafe\n', stderr: '' }
      if (argv[1] === 'diff') return { exitCode: 0, stdout: 'plugins/a.ts\ndocs/b.md\n', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const io: Io = { now: async () => NOW, run, readFile: async () => null, sessionLimits: async () => [], agents: async () => [] }
    const rt: Runtime = { mode: 'act', repo: REPO, device: DEVICE, runSource: 'local', poolSize: 16, cwd: '/work', loopDir: LOOP_DIR, sink: null, env: {}, toolsDir: TOOLS, pluginRoot: PLUGIN_ROOT, config: config({ intakeStamp }), configProblems: [] }
    const readers: V2Readers = {
      prs: async ctx => ({ read: { prs: [] }, source: { ok: true, at: NOW }, heads: ctx.heads }),
      interventions: async () => ({ read: { companion: [], controlDigest: null, configDigest: null }, source: { ok: true, at: NOW } }),
    }
    const cache = emptyCache()
    const out = await observeV2({
      io, rt, cache: cache.v2, run, state: baseState({ now: NOW, checkout: CLEAN }),
      stored: { records: [rec(5)], heads: null, stamps: { '5': GOOD }, error: null },
      poolJson: null, github: cache.github, backoff: false, limited: () => false, readers,
      ...(tag === undefined ? {} : { tag }),
    })
    return { runs, v2: out.v2 }
  }

  test('off: no git command runs for the paths, and the state carries neither stamps nor paths', async () => {
    const { runs, v2 } = await pass('off')
    expect(runs.filter(a => a[0] === 'git')).toEqual([])
    expect(v2).not.toHaveProperty('stamps')
    expect(v2).not.toHaveProperty('inFlightPaths')
  })

  test('the newest release tag reaches v2.tag: a string, null, or absent when unread', async () => {
    expect((await pass('off', 'v1.2.0')).v2.tag).toBe('v1.2.0')
    expect((await pass('off', null)).v2.tag).toBeNull()
    expect((await pass('off')).v2).not.toHaveProperty('tag')
  })

  test('on: the stamps and the in-flight paths ride on the state', async () => {
    const { runs, v2 } = await pass('on')
    expect(runs.some(a => a[0] === 'git' && a[1] === 'diff')).toBe(true)
    expect(v2.stamps).toEqual({ '5': GOOD })
    expect(v2.inFlightPaths).toEqual({ 5: ['docs', 'plugins'] })
  })
})
