// The safety rails (rails.ts), rail by rail against fake files and commands: the act lock's
// lease, takeover and release (SPEC 11.2), the role, the old watcher's lock as
// orchestrator-watch.sh places and judges it, the heartbeat guard over factory.workers (D-28),
// all of them together, the usage pre-check per tier and class (SPEC 10.7) and the pass
// scheduler's ping-storm breaker (D-39). The heartbeat CSV is what psql --csv printed for the
// query over heartbeat-loop's own DDL on PostgreSQL 17; the lock names are GNU tr's output.
import { describe, expect, test } from 'claude-code/testing'

import type { RunInit, RunResult } from '../hooks/exec'
import {
  EMPTY_RAIL_MEMORY,
  HEARTBEAT_QUIET_MS,
  HEARTBEAT_SQL,
  LEASE_MIN_MS,
  LOCK_CAS_SCRIPT,
  PASS_GAP_MS,
  PRECHECKED,
  STORM_PASSES,
  STORM_QUIET_MS,
  STORM_WINDOW_MS,
  TIER_CLASSES,
  WATCHER_QUIET_MS,
  actLockPath,
  checkRails,
  decideLock,
  findWatcher,
  heartbeatArgv,
  heartbeatGuard,
  heartbeatVerdict,
  holdActLock,
  leaseMsOf,
  leaseText,
  namesWatcher,
  newScheduler,
  nextPass,
  noticeTell,
  parseBeats,
  parseLease,
  passEnded,
  pidOf,
  preCheck,
  releaseActLock,
  requestPass,
  roleProblem,
  usageVerdict,
  waitOver,
  watcherAlive,
  watcherLockPath,
} from '../hooks/rails'
import type { BreakerNotice, Lease, LockIo, PassSource, RailEnv, RailInput, RailIo, Scheduler, UsageReading } from '../hooks/rails'
import type { Action, ActionClass, Tier } from '../hooks/types'
import { DEVICE, MIN, NOW, OTHER, config, issue, mine, run, state } from './fixtures'
import { lockCas } from './host'

const CFG = config()
const REPO = 'cbundy/dev-system'
const LOOP_DIR = '/cfg/factory-loop/cbundy__dev-system'
const LOCK = `${LOOP_DIR}/act.lock`
const ENV: RailEnv = { DEV_ROLE: 'orchestrator', XDG_RUNTIME_DIR: '/run/user/1000' }
const WATCH_LOCK = '/run/user/1000/orchestrator-watch-cbundy_dev-system.lock'
const WATCHER_CMDLINE = '/bin/sh\0/usr/local/share/callum-tools/orchestrator-watch.sh\0--repo\0cbundy/dev-system\0--label\0ready\0'
const NO_BEATS = 'device,age_s\n'
const beats = (...rows: [string, number][]) => `device,age_s\n${rows.map(([d, a]) => `${d},${a}`).join('\n')}\n`

type Call = { argv: string[]; init: RunInit }
type Handler = (argv: string[]) => Partial<RunResult> | Error

// over: a files record as lockCas reads and writes it.
const over = (files: Record<string, string>) => ({ get: (p: string) => files[p], set: (p: string, t: string) => (files[p] = t) })

// fakeIo: files in a map, commands answered by `handler` (the act lock's compare-and-set by
// lockCas, as the shell runs it), every command and lease write recorded.
function fakeIo(files: Record<string, string> = {}, handler: Handler = world()) {
  const calls: Call[] = []
  const writes: { path: string; text: string }[] = []
  const io: RailIo = {
    readFile: async path => files[path] ?? null,
    cmd: async (argv, init) => {
      calls.push({ argv, init })
      // a lock directory exists when a file is under it
      if (argv[0] === 'test' && argv[1] === '-d') return { exitCode: Object.keys(files).some(p => p.startsWith(`${argv[2]}/`)) ? 0 : 1, stdout: '', stderr: '' }
      const cas = lockCas(over(files), argv, init.stdin)
      if (cas !== undefined) {
        if (cas.exitCode === 0) writes.push({ path: argv[4] ?? '', text: init.stdin ?? '' })
        return cas
      }
      const reply = handler(argv)
      if (reply instanceof Error) throw reply
      return { exitCode: 0, stdout: '', stderr: '', ...reply }
    },
  }
  return { io, files, calls, writes }
}

// world: the commands a rail runs. kill: the `kill -0` probe's exit; cmdline: what
// /proc/<pid>/cmdline holds, null where it cannot be read.
type World = { csv?: string; queryExit?: number; kill?: number; cmdline?: string | null }
function world(w: World = {}): Handler {
  return argv => {
    if (argv[0] === 'dev-query') {
      const exit = w.queryExit ?? 0
      return exit === 0 ? { stdout: w.csv ?? NO_BEATS } : { exitCode: exit, stderr: 'dev-query: no PostgreSQL URL configured\n' }
    }
    if (argv[0] === 'sh') return { exitCode: w.kill ?? 1 }
    if (argv[0] === 'cat') {
      const cmdline = w.cmdline === undefined ? WATCHER_CMDLINE : w.cmdline
      return cmdline === null ? { exitCode: 1, stderr: 'cat: /proc/4242/cmdline: Permission denied' } : { stdout: cmdline }
    }
    return new Error(`unexpected command: ${argv.join(' ')}`)
  }
}

function input(over: Partial<RailInput> = {}): RailInput {
  return { repo: REPO, device: DEVICE, session: 'session-a', loopDir: LOOP_DIR, config: CFG, env: ENV, now: NOW, memory: EMPTY_RAIL_MEMORY, ...over }
}

const lease = (session: string, expiresAt: number, renewedAt = expiresAt - 5 * MIN): Lease => ({ session, renewedAt, expiresAt })

// --- the act lock -------------------------------------------------------------------------------

describe('the act lock (SPEC 11.2)', () => {
  test('a free lock is taken and written as a JSON lease of a few passes, never under fifteen minutes', async () => {
    const { io, files } = fakeIo()
    const r = await holdActLock(io, LOCK, 'session-a', NOW, leaseMsOf(CFG))
    expect(r).toEqual({ held: true, lease: { session: 'session-a', renewedAt: NOW, expiresAt: NOW + 15 * MIN }, took: null })
    expect(JSON.parse(files[LOCK] ?? '')).toEqual({ session: 'session-a', renewedAt: NOW, expiresAt: NOW + 15 * MIN })
    expect(actLockPath(LOOP_DIR)).toBe(LOCK)
    expect(leaseMsOf(config({ passEveryMs: 4 * MIN }))).toBe(20 * MIN)
    expect(leaseMsOf(config({ passEveryMs: 10_000 }))).toBe(LEASE_MIN_MS)
    // longer than the longest step: a merge (600 s) and its rollout read (60 s)
    expect(LEASE_MIN_MS).toBeGreaterThan(660_000)
  })

  test('the holder renews it each pass; another session refuses while it is live', async () => {
    const { io, files, writes } = fakeIo({ [LOCK]: leaseText(lease('session-a', NOW + 4 * MIN, NOW - MIN)) })
    const renewed = await holdActLock(io, LOCK, 'session-a', NOW, 5 * MIN)
    expect(renewed).toEqual({ held: true, lease: { session: 'session-a', renewedAt: NOW, expiresAt: NOW + 5 * MIN }, took: null })
    writes.length = 0
    const refused = await holdActLock(io, LOCK, 'session-b', NOW + 5 * MIN - 1, 5 * MIN)
    expect(refused).toEqual({ held: false, reason: `act lock: session session-a holds it until ${new Date(NOW + 5 * MIN).toISOString()}` })
    expect(writes).toEqual([])
    expect(parseLease(files[LOCK] ?? null)?.session).toBe('session-a')
  })

  test('an expired lease is taken over from the instant it expires', async () => {
    const old = lease('session-a', NOW)
    expect(decideLock(leaseText(old), 'session-b', NOW - 1, 5 * MIN)).toEqual({ hold: false, holder: old })
    const { io, files } = fakeIo({ [LOCK]: leaseText(old) })
    const r = await holdActLock(io, LOCK, 'session-b', NOW, 5 * MIN)
    expect(r).toEqual({ held: true, lease: { session: 'session-b', renewedAt: NOW, expiresAt: NOW + 5 * MIN }, took: old })
    expect(parseLease(files[LOCK] ?? null)?.session).toBe('session-b')
  })

  test('a missing, empty or malformed file holds no lease', () => {
    for (const text of [null, '', '{', '[]', 'null', '{"session":"","renewedAt":1,"expiresAt":2}', '{"session":"a","renewedAt":"1","expiresAt":2}']) {
      expect([text, parseLease(text)]).toEqual([text, null])
    }
    expect(decideLock('{"sess', 'session-a', NOW, MIN)).toEqual({ hold: true, lease: { session: 'session-a', renewedAt: NOW, expiresAt: NOW + MIN }, took: null })
  })

  test('of two sessions that both read the lock free, only the first write lands: the other refuses (SPEC 11.2)', async () => {
    // A reads free, B reads free, A writes and reads back, B writes and reads back
    const files: Record<string, string> = {}
    const a = await holdActLock(fakeIo(files).io, LOCK, 'session-a', NOW, 5 * MIN)
    expect(a.held).toBe(true)
    let first = true
    const stale: LockIo = {
      // session-b read the lock before session-a's write landed
      readFile: async path => (first ? ((first = false), null) : (files[path] ?? null)),
      cmd: async (argv, init) => lockCas(over(files), argv, init.stdin) ?? { exitCode: 0, stdout: '', stderr: '' },
    }
    const b = await holdActLock(stale, LOCK, 'session-b', NOW, 5 * MIN)
    expect(b).toEqual({ held: false, reason: `act lock: session session-a holds it until ${new Date(NOW + 5 * MIN).toISOString()}` })
    expect(parseLease(files[LOCK] ?? null)?.session).toBe('session-a')
    // the write is one compare-and-set under flock, landing by rename
    expect(LOCK_CAS_SCRIPT).toContain('flock -w 5 9')
    expect(LOCK_CAS_SCRIPT).toContain('[ "$cur" = "$2" ] || exit 3')
    expect(LOCK_CAS_SCRIPT).toContain('mv -f -- "$1.$$" "$1"')
  })

  test('a lease this session renewed from elsewhere meanwhile still counts as held', async () => {
    const files: Record<string, string> = { [LOCK]: leaseText(lease('session-a', NOW + MIN)) }
    let first = true
    const io: LockIo = {
      readFile: async path => files[path] ?? null,
      cmd: async (argv, init) => {
        // another of this session's renewals lands first
        if (first) {
          first = false
          files[LOCK] = leaseText(lease('session-a', NOW + 10 * MIN, NOW))
        }
        return lockCas(over(files), argv, init.stdin) ?? { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    expect(await holdActLock(io, LOCK, 'session-a', NOW, 5 * MIN)).toEqual({ held: true, lease: lease('session-a', NOW + 10 * MIN, NOW), took: null })
  })

  test('a lock that cannot be written, or a session with no id, refuses (fail safe)', async () => {
    const io: RailIo = {
      readFile: async () => null,
      cmd: async () => ({ exitCode: 2, stdout: '', stderr: 'sh: cannot create /cfg/factory-loop/x/act.lock.12: Permission denied' }),
    }
    const r = await holdActLock(io, LOCK, 'session-a', NOW, 5 * MIN)
    expect(r.held).toBe(false)
    expect(r.held ? '' : r.reason).toBe(`act lock: ${LOCK} not written (exit 2: sh: cannot create /cfg/factory-loop/x/act.lock.12: Permission denied)`)
    const throws: RailIo = { readFile: async () => null, cmd: async () => Promise.reject(new Error('EACCES: permission denied')) }
    expect(await holdActLock(throws, LOCK, 'session-a', NOW, 5 * MIN)).toEqual({ held: false, reason: 'act lock: Error: EACCES: permission denied' })
    expect(await holdActLock(fakeIo().io, LOCK, '', NOW, 5 * MIN)).toEqual({ held: false, reason: 'act lock: this session has no id' })
  })

  test("session.end releases only this session's own lease, and the next session acts at once", async () => {
    const { io, files, writes } = fakeIo({ [LOCK]: leaseText(lease('session-a', NOW + 4 * MIN)) })
    expect(await releaseActLock(io, LOCK, 'session-a', NOW)).toBe(true)
    expect(parseLease(files[LOCK] ?? null)).toEqual(lease('session-a', NOW, NOW - MIN))
    const next = await holdActLock(io, LOCK, 'session-b', NOW, 5 * MIN)
    expect(next.held && next.took?.session).toBe('session-a')
    writes.length = 0
    expect(await releaseActLock(io, LOCK, 'session-a', NOW + MIN)).toBe(false)
    expect(writes).toEqual([])
    expect(parseLease(files[LOCK] ?? null)?.session).toBe('session-b')
  })
})

// --- the role ---------------------------------------------------------------------------------

describe('the role (SPEC 11.2, D-28)', () => {
  test('act needs DEV_ROLE=orchestrator unless the repo allows acting outside it', () => {
    expect(roleProblem('orchestrator', CFG)).toBeNull()
    expect(roleProblem('dev', CFG)).toBe('role: DEV_ROLE is dev, act needs orchestrator')
    expect(roleProblem(undefined, CFG)).toBe('role: DEV_ROLE is unset, act needs orchestrator')
    expect(roleProblem('', CFG)).toBe('role: DEV_ROLE is unset, act needs orchestrator')
    expect(roleProblem('dev', config({ allowActOutsideOrchestrator: true }))).toBeNull()
  })
})

// --- the old watcher ------------------------------------------------------------------------------

describe('the old watcher (SPEC 11.2, D-28)', () => {
  test("its lock directory follows the watcher's ${A:-${B:-${C:-/tmp}}}, an empty value falling through", () => {
    const name = 'orchestrator-watch-cbundy_dev-system.lock'
    expect(watcherLockPath({ ORCHESTRATOR_WATCH_LOCK_DIR: '/l', XDG_RUNTIME_DIR: '/x', TMPDIR: '/t' }, REPO)).toBe(`/l/${name}`)
    expect(watcherLockPath({ XDG_RUNTIME_DIR: '/x', TMPDIR: '/t' }, REPO)).toBe(`/x/${name}`)
    expect(watcherLockPath({ TMPDIR: '/t' }, REPO)).toBe(`/t/${name}`)
    expect(watcherLockPath({}, REPO)).toBe(`/tmp/${name}`)
    expect(watcherLockPath({ ORCHESTRATOR_WATCH_LOCK_DIR: '', XDG_RUNTIME_DIR: '', TMPDIR: '/t' }, REPO)).toBe(`/t/${name}`)
  })

  test('every byte of the repo outside A-Za-z0-9._- becomes _, as GNU tr -c printed it', () => {
    const tr: [string, string][] = [
      ['cbundy/dev-system', 'cbundy_dev-system'],
      ['a/b;rm -rf $HOME', 'a_b_rm_-rf__HOME'],
      ['Own.er/re po-é_1🙂', 'Own.er_re_po-___1____'],
      [`o'w"n/r\`x`, 'o_w_n_r_x'],
    ]
    for (const [repo, safe] of tr) expect(watcherLockPath({}, repo)).toBe(`/tmp/orchestrator-watch-${safe}.lock`)
  })

  test('the pid is read as $(cat pid) gives it, and only a decimal pid is ever probed', () => {
    expect(pidOf('4242\n')).toBe('4242')
    expect(pidOf('4242\n\n')).toBe('4242')
    for (const text of [null, '', '\n', 'abc', '42 43', '-1', ' 42', '$(reboot)', '42\n43']) expect([text, pidOf(text)]).toEqual([text, null])
  })

  test("alive as the watcher's alive_watcher judges it: kill -0, then a cmdline naming orchestrator-watch", () => {
    expect(namesWatcher(WATCHER_CMDLINE)).toBe(true)
    expect(namesWatcher('sleep\x0030\x00')).toBe(false)
    expect(watcherAlive(true, WATCHER_CMDLINE)).toBe(true)
    expect(watcherAlive(true, null)).toBe(true)
    expect(watcherAlive(true, 'sleep\x0030\x00')).toBe(false)
    expect(watcherAlive(false, WATCHER_CMDLINE)).toBe(false)
  })

  test('a live watcher is found, with the pid passed to each command as an argument', async () => {
    const { io, calls } = fakeIo({ [`${WATCH_LOCK}/pid`]: '4242\n' }, world({ kill: 0 }))
    expect(await findWatcher(io, ENV, REPO)).toEqual({ kind: 'live', pid: '4242', path: WATCH_LOCK })
    expect(calls.map(c => c.argv)).toEqual([
      ['sh', '-c', 'kill -0 "$1" 2>/dev/null', 'sh', '4242'],
      ['cat', '/proc/4242/cmdline'],
    ])
    expect(calls.every(c => c.init.timeoutMs > 0 && c.init.stdin === undefined)).toBe(true)
  })

  test('no lock, a stale pid, or a pid reused by another program is no watcher', async () => {
    const none = fakeIo({}, world({ kill: 0 }))
    expect(await findWatcher(none.io, ENV, REPO)).toEqual({ kind: 'none' })
    expect(none.calls.map(c => c.argv)).toEqual([['test', '-d', WATCH_LOCK]])

    const stale = fakeIo({ [`${WATCH_LOCK}/pid`]: '4242\n' }, world({ kill: 1 }))
    expect(await findWatcher(stale.io, ENV, REPO)).toEqual({ kind: 'none' })
    expect(stale.calls).toHaveLength(1)

    const reused = fakeIo({ [`${WATCH_LOCK}/pid`]: '4242\n' }, world({ kill: 0, cmdline: 'sleep\x0030\x00' }))
    expect(await findWatcher(reused.io, ENV, REPO)).toEqual({ kind: 'none' })

  })

  test('a lock directory with no readable decimal pid blocks (fail safe), and its pid is never probed', async () => {
    for (const pid of ['$(reboot)\n', '', '\n']) {
      const odd = fakeIo({ [`${WATCH_LOCK}/pid`]: pid }, world({ kill: 0 }))
      expect(await findWatcher(odd.io, ENV, REPO)).toEqual({ kind: 'error', reason: `old watcher: ${WATCH_LOCK} exists with no readable pid` })
      expect(odd.calls.map(c => c.argv)).toEqual([['test', '-d', WATCH_LOCK]])
    }
    // a directory whose pid file cannot be read at all (readFile gives null), or is not written yet
    const unreadable = fakeIo({ [`${WATCH_LOCK}/.keep`]: '' }, world({ kill: 0 }))
    expect(await findWatcher(unreadable.io, ENV, REPO)).toEqual({ kind: 'error', reason: `old watcher: ${WATCH_LOCK} exists with no readable pid` })
  })

  test('where the cmdline cannot be read, kill -0 alone decides, as the watcher does', async () => {
    const { io } = fakeIo({ [`${WATCH_LOCK}/pid`]: '4242\n' }, world({ kill: 0, cmdline: null }))
    expect(await findWatcher(io, ENV, REPO)).toEqual({ kind: 'live', pid: '4242', path: WATCH_LOCK })
  })

  test("the lower-cased repo's lock counts too", async () => {
    const { io } = fakeIo({ [`${WATCH_LOCK}/pid`]: '4242\n' }, world({ kill: 0 }))
    expect(await findWatcher(io, ENV, 'CBundy/Dev-System')).toEqual({ kind: 'live', pid: '4242', path: WATCH_LOCK })
  })

  test('a probe that cannot run blocks (fail safe)', async () => {
    const broken = fakeIo({ [`${WATCH_LOCK}/pid`]: '4242\n' }, world({ kill: 127 }))
    expect(await findWatcher(broken.io, ENV, REPO)).toEqual({ kind: 'error', reason: 'old watcher: cannot probe pid 4242 (exit 127)' })
    const thrown = fakeIo({ [`${WATCH_LOCK}/pid`]: '4242\n' }, () => new Error('spawn failed'))
    expect(await findWatcher(thrown.io, ENV, REPO)).toEqual({ kind: 'error', reason: `old watcher: cannot check ${WATCH_LOCK}: Error: spawn failed` })
  })
})

// --- the heartbeat guard -----------------------------------------------------------------------------

describe('the heartbeat guard (D-28)', () => {
  test('one dev-query --csv call, with the repo and this device as psql variables and the SQL on stdin', async () => {
    const { io, calls } = fakeIo()
    expect((await heartbeatGuard(io, REPO, DEVICE, null, NOW)).ok).toBe(true)
    expect(calls.map(c => c.argv)).toEqual([heartbeatArgv(REPO, DEVICE)])
    expect(heartbeatArgv(REPO, DEVICE)).toEqual(['dev-query', '--csv', '-v', `repo=${REPO}`, '-v', `device=${DEVICE}`])
    expect(calls[0]?.init.stdin).toBe(HEARTBEAT_SQL)
    for (const part of ['from factory.workers_status', "role = 'orchestrator'", "lower(repo) = lower(:'repo')", "device <> :'device'"]) {
      expect(HEARTBEAT_SQL).toContain(part)
    }
  })

  test('the CSV is read as psql printed it', () => {
    const printed = 'device,age_s\ncoder-other,51.573429\ncoder-old,10806.573429\n'
    expect(parseBeats(printed)?.map(b => [b.device, Math.round(b.ageMs)])).toEqual([
      ['coder-other', 51573],
      ['coder-old', 10806573],
    ])
    expect(parseBeats('device,age_s\n')).toEqual([])
    expect(parseBeats('device,age_s\ncoder-x,\ncoder-y,-2.5\n')).toEqual([{ device: 'coder-y', ageMs: 0 }])
    expect(parseBeats('')).toBeNull()
    expect(parseBeats('ERROR:  relation "factory.workers_status" does not exist\n')).toBeNull()
  })

  test('a beat from another orchestrator in the last 120 seconds blocks; one older does not', () => {
    expect(heartbeatVerdict([{ device: OTHER, ageMs: HEARTBEAT_QUIET_MS }], null, NOW).ok).toBe(false)
    expect(heartbeatVerdict([{ device: OTHER, ageMs: HEARTBEAT_QUIET_MS + 1 }], null, NOW)).toEqual({ ok: true, reason: null, spell: null, notice: null })
    expect(heartbeatVerdict([], null, NOW).ok).toBe(true)
    expect(heartbeatVerdict([{ device: 'coder-b', ageMs: 80_000 }, { device: OTHER, ageMs: 12_400 }], null, NOW).reason).toBe(
      `heartbeat: another orchestrator on this repo is up (${OTHER} 12s ago, coder-b 80s ago)`,
    )
  })

  test('one notice per blocking spell, and acting again after 120 seconds of quiet', () => {
    const first = heartbeatVerdict([{ device: OTHER, ageMs: 30_000 }], null, NOW)
    expect(first).toMatchObject({ ok: false, spell: { since: NOW, device: OTHER }, notice: { since: NOW, device: OTHER } })
    const second = heartbeatVerdict([{ device: OTHER, ageMs: 20_000 }], first.spell, NOW + MIN)
    expect(second).toMatchObject({ ok: false, spell: { since: NOW, device: OTHER }, notice: null })
    // the other stopped beating: 119 s of quiet still holds, 121 s lets the loop act
    const quieting = heartbeatVerdict([{ device: OTHER, ageMs: 119_000 }], second.spell, NOW + 3 * MIN)
    expect(quieting).toMatchObject({ ok: false, notice: null })
    const quiet = heartbeatVerdict([{ device: OTHER, ageMs: 121_000 }], quieting.spell, NOW + 3 * MIN + 2_000)
    expect(quiet).toEqual({ ok: true, reason: null, spell: null, notice: null })
    const again = heartbeatVerdict([{ device: OTHER, ageMs: 5_000 }], quiet.spell, NOW + 10 * MIN)
    expect(again.notice).toEqual({ since: NOW + 10 * MIN, device: OTHER })
  })

  test('a failed query blocks with its own reason and leaves the spell as it was', async () => {
    const spell = { since: NOW - MIN, device: OTHER }
    const down = await heartbeatGuard(fakeIo({}, world({ queryExit: 78 })).io, REPO, DEVICE, spell, NOW)
    expect(down).toEqual({ ok: false, reason: 'heartbeat: query failed (exit 78: dev-query: no PostgreSQL URL configured)', spell, notice: null })
    const odd = await heartbeatGuard(fakeIo({}, world({ csv: 'garbage\n' })).io, REPO, DEVICE, null, NOW)
    expect(odd).toEqual({ ok: false, reason: 'heartbeat: query failed (unexpected output)', spell: null, notice: null })
    const thrown = await heartbeatGuard(fakeIo({}, () => new Error('timed out')).io, REPO, DEVICE, null, NOW)
    expect(thrown.reason).toBe('heartbeat: query failed (Error: timed out)')
  })

  test('a device with no name refuses without querying: it cannot tell its own beat apart', async () => {
    const { io, calls } = fakeIo()
    const r = await heartbeatGuard(io, REPO, '', null, NOW)
    expect(r.ok).toBe(false)
    expect(r.reason).toStartWith('heartbeat: this device has no name')
    expect(calls).toEqual([])
  })
})

// --- the rails together ----------------------------------------------------------------------------

describe('checkRails (SPEC 11.2)', () => {
  test('every rail passes: the lease is taken and the loop acts', async () => {
    const { io, calls, files } = fakeIo()
    const r = await checkRails(io, input())
    expect(r).toEqual({
      act: true,
      reasons: [],
      notices: [],
      memory: { heartbeat: null, watcher: null },
      lock: { held: true, lease: { session: 'session-a', renewedAt: NOW, expiresAt: NOW + 15 * MIN }, took: null },
    })
    // no watcher's lock directory, the heartbeat query, then the lease's one compare-and-set
    expect(calls.map(c => c.argv[0])).toEqual(['test', 'dev-query', 'sh'])
    expect(calls[2]?.argv.slice(0, 5)).toEqual(['sh', '-c', LOCK_CAS_SCRIPT, 'act-lock', LOCK])
    expect(parseLease(files[LOCK] ?? null)?.session).toBe('session-a')
  })

  test('refusals come in a fixed order; the lease is left alone, and a session that may never act tells nothing', async () => {
    const files = { [`${WATCH_LOCK}/pid`]: '4242\n' }
    const { io, writes } = fakeIo(files, world({ kill: 0, csv: beats([OTHER, 30]) }))
    const r = await checkRails(io, input({ env: { ...ENV, DEV_ROLE: 'dev' } }))
    expect(r.act).toBe(false)
    expect(r.reasons).toEqual([
      'role: DEV_ROLE is dev, act needs orchestrator',
      `old watcher: orchestrator-watch.sh holds ${WATCH_LOCK} (pid 4242)`,
      `heartbeat: another orchestrator on this repo is up (${OTHER} 30s ago)`,
    ])
    expect(r.notices).toEqual([])
    expect(r.lock).toBeNull()
    expect(writes).toEqual([])
  })

  test('the old watcher and another orchestrator are each told once per spell', async () => {
    const files: Record<string, string> = { [`${WATCH_LOCK}/pid`]: '4242\n' }
    const busy = world({ kill: 0, csv: beats([OTHER, 30]) })
    const first = await checkRails(fakeIo(files, busy).io, input())
    expect(first.act).toBe(false)
    expect(first.notices).toEqual([
      { kind: 'old-watcher', pid: '4242', since: NOW },
      { kind: 'heartbeat-other', device: OTHER, since: NOW },
    ])
    expect(first.memory).toEqual({ heartbeat: { since: NOW, device: OTHER }, watcher: { since: NOW, pid: '4242', seenAt: NOW } })

    const second = await checkRails(fakeIo(files, busy).io, input({ now: NOW + MIN, memory: first.memory }))
    expect(second.notices).toEqual([])
    expect(second.reasons).toHaveLength(2)
    expect(second.memory).toEqual({ ...first.memory, watcher: { since: NOW, pid: '4242', seenAt: NOW + MIN } })

    const quiet = await checkRails(fakeIo({}, world({ csv: beats([OTHER, 125]) })).io, input({ now: NOW + 12 * MIN, memory: second.memory }))
    expect(quiet).toMatchObject({ act: true, reasons: [], notices: [], memory: { heartbeat: null, watcher: null } })
  })

  test("the old watcher's lock must stay gone ten minutes: the released skill arms it again each turn (SPEC 11.2, D-28)", async () => {
    const armed = { [`${WATCH_LOCK}/pid`]: '4242\n' }
    const seen = await checkRails(fakeIo(armed, world({ kill: 0 })).io, input())
    expect(seen.act).toBe(false)
    // between two events the lock is gone: still the released skill's spell
    const gap = await checkRails(fakeIo({}, world()).io, input({ now: NOW + 10_000, memory: seen.memory }))
    expect(gap.act).toBe(false)
    expect(gap.reasons).toEqual([`old watcher: its lock was seen ${new Date(NOW).toISOString()}; acting after 10 minutes without it`])
    expect(gap.memory.watcher).toEqual(seen.memory.watcher)
    expect(gap.notices).toEqual([])
    // armed again with a new pid: the same spell, told once, seen later
    const again = await checkRails(fakeIo({ [`${WATCH_LOCK}/pid`]: '4300\n' }, world({ kill: 0 })).io, input({ now: NOW + 3 * MIN, memory: gap.memory }))
    expect(again.notices).toEqual([])
    expect(again.memory.watcher).toEqual({ since: NOW, pid: '4300', seenAt: NOW + 3 * MIN })
    expect((await checkRails(fakeIo({}, world()).io, input({ now: NOW + 12 * MIN, memory: again.memory }))).act).toBe(false)
    expect((await checkRails(fakeIo({}, world()).io, input({ now: NOW + 13 * MIN, memory: again.memory }))).act).toBe(true)
    expect(WATCHER_QUIET_MS).toBe(10 * MIN)
  })

  test("another session's live lease keeps this one in observe", async () => {
    const held = lease('session-b', NOW + 2 * MIN)
    const { io, writes } = fakeIo({ [LOCK]: leaseText(held) })
    const r = await checkRails(io, input())
    expect(r.act).toBe(false)
    expect(r.reasons).toEqual([`act lock: session session-b holds it until ${new Date(NOW + 2 * MIN).toISOString()}`])
    expect(r.lock).toEqual({ held: false, reason: r.reasons[0] })
    expect(writes).toEqual([])
  })

  test('a failed heartbeat query or watcher probe keeps the loop in observe', async () => {
    const down = await checkRails(fakeIo({}, world({ queryExit: 2 })).io, input())
    expect(down.act).toBe(false)
    expect(down.reasons[0]).toStartWith('heartbeat: query failed (exit 2')
    const broken = await checkRails(fakeIo({ [`${WATCH_LOCK}/pid`]: '7\n' }, world({ kill: 126 })).io, input())
    expect(broken.reasons).toEqual(['old watcher: cannot probe pid 7 (exit 126)'])
  })
})

// --- the usage pre-check -----------------------------------------------------------------------------

const READINGS: Record<Tier, UsageReading> = {
  normal: { fiveHour: 10, sevenDay: 84 },
  slow: { fiveHour: 86, sevenDay: 10 },
  'stop-new': { fiveHour: 10, sevenDay: 91 },
  'stop-all': { fiveHour: 96, sevenDay: 10 },
}
const CLASSES: ActionClass[] = ['free', 'owner', 'drive', 'develop', 'start']
const TIERS: Tier[] = ['normal', 'slow', 'stop-new', 'stop-all']
const claimOf = (klass: ActionClass): Action => ({ kind: 'claim', key: `test:${klass}`, class: klass, rule: 'test', reason: 'test', issue: 7 })

function usageIo(reading: UsageReading | Error) {
  let reads = 0
  return {
    io: {
      now: async () => NOW,
      usage: async () => {
        reads += 1
        if (reading instanceof Error) throw reading
        return reading
      },
    },
    reads: () => reads,
  }
}

describe('the usage pre-check (SPEC 10.7)', () => {
  test('each tier refuses the classes it forbids, and only those', () => {
    const refused: Record<Tier, ActionClass[]> = {
      normal: [],
      slow: [],
      'stop-new': ['develop', 'start'],
      'stop-all': ['drive', 'develop', 'start'],
    }
    for (const tier of TIERS) {
      const got = CLASSES.filter(klass => usageVerdict(READINGS[tier], klass, CFG, null, NOW) !== null)
      expect([tier, got]).toEqual([tier, refused[tier]])
    }
    expect(PRECHECKED).toEqual(['start', 'develop', 'drive'])
  })

  test('a refused action is skipped with the reading; free and owner actions never read usage', async () => {
    const high = usageIo(READINGS['stop-new'])
    expect(await preCheck(high.io, claimOf('start'), CFG, null)).toEqual({ status: 'skipped', summary: 'usage: tier stop-new forbids start (5h 10%, 7d 91%)' })
    expect(await preCheck(high.io, claimOf('drive'), CFG, null)).toBeNull()
    expect(high.reads()).toBe(2)
    expect(await preCheck(high.io, claimOf('free'), CFG, null)).toBeNull()
    expect(await preCheck(high.io, claimOf('owner'), CFG, null)).toBeNull()
    expect(high.reads()).toBe(2)
    expect(await preCheck(usageIo(READINGS['stop-all']).io, claimOf('drive'), CFG, null)).toEqual({
      status: 'skipped',
      summary: 'usage: tier stop-all forbids drive (5h 96%, 7d 10%)',
    })
  })

  test("the owner's override, a missing reading and a failed read leave the action to run", async () => {
    const high = usageIo(READINGS['stop-all']).io
    expect(await preCheck(high, claimOf('start'), CFG, { untilPct: 100, expiresAt: NOW + MIN })).toBeNull()
    expect(await preCheck(high, claimOf('start'), CFG, { untilPct: 100, expiresAt: NOW })).toMatchObject({ status: 'skipped' })
    expect(await preCheck(usageIo({ fiveHour: null, sevenDay: null }).io, claimOf('start'), CFG, null)).toBeNull()
    expect(await preCheck(usageIo(new Error('no session')).io, claimOf('start'), CFG, null)).toBeNull()
    expect(usageVerdict({ fiveHour: null, sevenDay: 99 }, 'start', CFG, null, NOW)).toBe('usage: tier stop-all forbids start (5h n/a, 7d 99%)')
  })
})

// --- the pass scheduler and the ping-storm breaker --------------------------------------------------

// pass: request a pass, start it at once and end it; the scheduler after it, and its notice.
function pass(s: Scheduler, source: PassSource, now: number): { s: Scheduler; notice: BreakerNotice | null } {
  const r = nextPass(requestPass(s, source, now), now)
  expect([now, r.next]).toEqual([now, { do: 'start', source }])
  return { s: passEnded(r.scheduler), notice: r.notice }
}

// pings: ping-driven passes at these times, with every notice they gave.
function pings(s: Scheduler, times: number[]) {
  const notices: BreakerNotice[] = []
  for (const t of times) {
    const r = pass(s, 'ping', t)
    s = r.s
    if (r.notice !== null) notices.push(r.notice)
  }
  return { s, notices }
}

const every = (from: number, n: number, gap = PASS_GAP_MS) => Array.from({ length: n }, (_, k) => from + k * gap)

describe('the pass scheduler and the ping-storm breaker (SPEC 2, D-39)', () => {
  test('passes never overlap: requests during a pass make one more pass, the timer named first', () => {
    let s = requestPass(newScheduler(), 'ping', NOW)
    const first = nextPass(s, NOW)
    expect(first.next).toEqual({ do: 'start', source: 'ping' })
    s = first.scheduler
    for (const [source, t] of [['ping', 1_000], ['timer', 2_000], ['ping', 3_000]] as const) {
      s = requestPass(s, source, NOW + t)
      expect(nextPass(s, NOW + t).next).toEqual({ do: 'idle' })
    }
    s = passEnded(s)
    const again = nextPass(s, NOW + 10_000)
    expect(again.next).toEqual({ do: 'start', source: 'timer' })
    expect(nextPass(passEnded(again.scheduler), NOW + 20_000).next).toEqual({ do: 'idle' })
  })

  test('passes start at least 5 seconds apart, with one wait however many requests arrive', () => {
    let s = pass(newScheduler(), 'timer', NOW).s
    s = requestPass(s, 'ping', NOW + 1_000)
    const wait = nextPass(s, NOW + 1_000)
    expect(wait.next).toEqual({ do: 'wait', ms: PASS_GAP_MS - 1_000 })
    s = requestPass(wait.scheduler, 'ping', NOW + 2_000)
    expect(nextPass(s, NOW + 2_000).next).toEqual({ do: 'idle' })
    // a timer that fires a millisecond early waits out the rest
    const early = nextPass(waitOver(s), NOW + PASS_GAP_MS - 1)
    expect(early.next).toEqual({ do: 'wait', ms: 1 })
    const start = nextPass(waitOver(early.scheduler), NOW + PASS_GAP_MS)
    expect(start.next).toEqual({ do: 'start', source: 'ping' })
  })

  test('30 ping-driven passes in 10 minutes do not trip it, and timer passes never count', () => {
    let s = newScheduler()
    const notices: BreakerNotice[] = []
    for (const t of every(NOW, 2 * STORM_PASSES)) {
      const r = pass(s, (t - NOW) % (2 * PASS_GAP_MS) === 0 ? 'ping' : 'timer', t)
      s = r.s
      if (r.notice !== null) notices.push(r.notice)
    }
    expect(notices).toEqual([])
    expect(s.pingStarts).toHaveLength(STORM_PASSES)
  })

  test('the 31st opens the breaker: pings are ignored for 10 minutes, timer passes go on, one notice', () => {
    const times = every(NOW, STORM_PASSES + 1)
    const tripped = times[STORM_PASSES] ?? 0
    const { s, notices } = pings(newScheduler(), times)
    expect(notices).toEqual([{ kind: 'breaker', since: tripped, until: tripped + STORM_QUIET_MS, passes: STORM_PASSES + 1 }])
    const tell = noticeTell(notices[0] as BreakerNotice)
    expect(tell).toMatchObject({ kind: 'tell', wake: 'breaker', key: `tell:breaker:pings:${tripped}`, fields: { kind: 'ping' } })

    const ignored = requestPass(s, 'ping', tripped + 6_000)
    expect(ignored).toEqual(s)
    expect(nextPass(ignored, tripped + 6_000).next).toEqual({ do: 'idle' })
    const ticked = pass(s, 'timer', tripped + MIN)
    expect(ticked.notice).toBeNull()
    expect(requestPass(ticked.s, 'ping', tripped + STORM_QUIET_MS - 1)).toEqual(ticked.s)
    // at 10 minutes pings count again, from zero
    const back = pass(ticked.s, 'ping', tripped + STORM_QUIET_MS)
    expect(back.notice).toBeNull()
    expect(back.s.pingStarts).toEqual([tripped + STORM_QUIET_MS])
    expect(back.s.pingsIgnoredUntil).toBeNull()
  })

  test('the window is 10 minutes: a ping pass exactly 10 minutes old has left it', () => {
    // one pass at NOW, 29 in the middle, then the 31st at 10 minutes or a millisecond sooner
    const middle = every(NOW + 5 * MIN, STORM_PASSES - 1)
    expect(pings(newScheduler(), [NOW, ...middle, NOW + STORM_WINDOW_MS]).notices).toEqual([])
    expect(pings(newScheduler(), [NOW, ...middle, NOW + STORM_WINDOW_MS - 1]).notices).toHaveLength(1)
  })
})

// --- notices as tells ----------------------------------------------------------------------------------

describe('notices as tell wakes (SPEC 9.2)', () => {
  test('each notice is a tell keyed by its spell, so it goes out once', () => {
    const base = { kind: 'tell', class: 'owner', rule: 'O2', issue: null, context: [] }
    expect(noticeTell({ kind: 'heartbeat-other', device: OTHER, since: NOW })).toEqual({
      ...base,
      wake: 'heartbeat-other',
      key: `tell:heartbeat-other:${NOW}`,
      reason: 'tell heartbeat-other',
      fields: { device: OTHER },
    })
    expect(noticeTell({ kind: 'breaker', since: NOW, until: NOW + STORM_QUIET_MS, passes: 31 })).toEqual({
      ...base,
      wake: 'breaker',
      key: `tell:breaker:pings:${NOW}`,
      reason: 'tell breaker',
      fields: { kind: 'ping' },
    })
    expect(noticeTell({ kind: 'old-watcher', pid: '4242', since: NOW })).toMatchObject({ key: `tell:old-watcher:${NOW}`, fields: { pid: '4242' } })
  })
})
