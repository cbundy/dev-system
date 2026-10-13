// The safety rails (SPEC 2, 10.7, 11.2, 11.4; DECISIONS D-28, D-39): what must hold before the
// loop acts at all, the usage pre-check before each token-spending action, and the pass
// scheduler with its ping-storm breaker. Every decision is a pure function over a file's text, a
// query's rows or a clock reading; the thin wrappers read files and run commands through the io
// the driver passes, so the tests and the replay drive the decisions without the engine. Every
// rail fails safe: a read it cannot make keeps the loop in observe, with its own reason.
import type { ActIo, Exec, ExecCtx } from './exec'
import { parseCsv } from './parse'
import { tierOf } from './plan'
import type { Action, ActionClass, Config, Control, Ms, Tier } from './types'

const SECOND = 1_000
const MINUTE = 60_000
const PROBE_TIMEOUT_MS = 10_000
const QUERY_TIMEOUT_MS = 30_000

// What a rail reads and runs: the ledger-free part of ActIo and ExecCtx, since the rails run at
// the start of a pass, before any action has an entry.
export type LockIo = Pick<ActIo, 'readFile' | 'writeFile'>
export type RailIo = LockIo & { cmd: ExecCtx['cmd'] }

// --- the act lock (SPEC 11.2) ---------------------------------------------------------------

// A lease lasts a few passes and never under five minutes, so one long pass (a slow guard or
// merge) cannot outlive it and let a second session in mid-pass.
export const LEASE_PASSES = 5
export const LEASE_MIN_MS = 5 * MINUTE

export type Lease = { session: string; renewedAt: Ms; expiresAt: Ms }

export function actLockPath(loopDir: string): string {
  return `${loopDir}/act.lock`
}

export function leaseMsOf(config: Config): Ms {
  return Math.max(LEASE_PASSES * config.passEveryMs, LEASE_MIN_MS)
}

// parseLease: the lock file's lease; null for a missing, empty or malformed file, which any
// session may take (a torn write is the likeliest cause, and every writer reads its write back).
export function parseLease(text: string | null): Lease | null {
  if (text === null) return null
  try {
    const v: unknown = JSON.parse(text)
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
    const o = v as Record<string, unknown>
    const ms = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
    if (typeof o.session !== 'string' || o.session === '' || !ms(o.renewedAt) || !ms(o.expiresAt)) return null
    return { session: o.session, renewedAt: o.renewedAt, expiresAt: o.expiresAt }
  } catch {
    return null
  }
}

export function leaseText(lease: Lease): string {
  return JSON.stringify(lease) + '\n'
}

// took: the other session's expired lease this one replaced, for the decision log.
export type LockDecision = { hold: true; lease: Lease; took: Lease | null } | { hold: false; holder: Lease }

// decideLock: renew this session's own lease, take a missing or expired one, and refuse while
// another session's lease is live (up to the instant it expires).
export function decideLock(text: string | null, session: string, now: Ms, leaseMs: Ms): LockDecision {
  const current = parseLease(text)
  if (current !== null && current.session !== session && now < current.expiresAt) return { hold: false, holder: current }
  return {
    hold: true,
    lease: { session, renewedAt: now, expiresAt: now + leaseMs },
    took: current !== null && current.session !== session ? current : null,
  }
}

// releasedLease: this session's lease, expired now, for session.end; null when the file holds no
// lease of this session's (another session's lease is never touched).
export function releasedLease(text: string | null, session: string, now: Ms): Lease | null {
  const current = parseLease(text)
  if (current === null || current.session !== session) return null
  return { ...current, expiresAt: Math.min(current.expiresAt, now) }
}

export type LockResult = { held: true; lease: Lease; took: Lease | null } | { held: false; reason: string }

function heldBy(lease: Lease): string {
  return `act lock: session ${lease.session} holds it until ${new Date(lease.expiresAt).toISOString()}`
}

// holdActLock: acquire or renew the lease, once per pass. The file is read back after the
// write, so of two sessions that raced for a free lock the one whose write did not land refuses.
export async function holdActLock(io: LockIo, path: string, session: string, now: Ms, leaseMs: Ms): Promise<LockResult> {
  if (session === '') return { held: false, reason: 'act lock: this session has no id' }
  try {
    const d = decideLock(await io.readFile(path), session, now, leaseMs)
    if (!d.hold) return { held: false, reason: heldBy(d.holder) }
    await io.writeFile(path, leaseText(d.lease))
    const back = parseLease(await io.readFile(path))
    if (back === null) return { held: false, reason: `act lock: ${path} did not read back` }
    if (back.session !== session) return { held: false, reason: heldBy(back) }
    return { held: true, lease: d.lease, took: d.took }
  } catch (err) {
    return { held: false, reason: `act lock: ${String(err).slice(0, 200)}` }
  }
}

// releaseActLock: at session.end, expire this session's lease so the next session acts at once.
export async function releaseActLock(io: LockIo, path: string, session: string, now: Ms): Promise<boolean> {
  try {
    const released = releasedLease(await io.readFile(path), session, now)
    if (released === null) return false
    await io.writeFile(path, leaseText(released))
    return true
  } catch {
    return false
  }
}

// --- the role (SPEC 11.2, D-28) ---------------------------------------------------------------

export const ORCHESTRATOR_ROLE = 'orchestrator'

// roleProblem: a desktop session with the plugin installed never acts by accident; the
// repo-local allowActOutsideOrchestrator lifts it for a testbed.
export function roleProblem(role: string | undefined, config: Config): string | null {
  if (role === ORCHESTRATOR_ROLE || config.allowActOutsideOrchestrator) return null
  return `role: DEV_ROLE is ${role ? role : 'unset'}, act needs ${ORCHESTRATOR_ROLE}`
}

// --- the old watcher (SPEC 11.2, D-28) ----------------------------------------------------------

// The session environment the rails read: the role, and what orchestrator-watch.sh places its
// lock by.
export type RailEnv = {
  DEV_ROLE?: string
  ORCHESTRATOR_WATCH_LOCK_DIR?: string
  XDG_RUNTIME_DIR?: string
  TMPDIR?: string
}

// watcherLockPath: the lock orchestrator-watch.sh takes for a repo, computed as it does:
// ${ORCHESTRATOR_WATCH_LOCK_DIR:-${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}} (an empty value falls
// through, as `:-` does), then the repo with every byte outside A-Za-z0-9._- made `_` (GNU tr
// works on bytes, so a multibyte character gives one `_` per byte).
export function watcherLockPath(env: RailEnv, repo: string): string {
  const dir = env.ORCHESTRATOR_WATCH_LOCK_DIR || env.XDG_RUNTIME_DIR || env.TMPDIR || '/tmp'
  let safe = ''
  for (const ch of repo) {
    const cp = ch.codePointAt(0) ?? 0
    safe += /^[A-Za-z0-9._-]$/.test(ch) ? ch : '_'.repeat(cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4)
  }
  return `${dir}/orchestrator-watch-${safe}.lock`
}

// pidOf: the pid file's text as `$(cat "$lock/pid")` gives it (trailing newlines dropped). The
// watcher writes its own `$$`, always decimal, so nothing else is probed.
export function pidOf(text: string | null): string | null {
  const p = (text ?? '').replace(/\n+$/, '')
  return /^[0-9]+$/.test(p) ? p : null
}

// namesWatcher: /proc/<pid>/cmdline as `tr '\0' ' ' | grep -q orchestrator-watch` reads it.
export function namesWatcher(cmdline: string): boolean {
  return cmdline.replace(/\0/g, ' ').includes('orchestrator-watch')
}

// watcherAlive: the watcher's own alive_watcher: `kill -0` reached the pid, and its cmdline is
// unreadable (no /proc) or names the watcher, so a pid reused by another program is stale.
export function watcherAlive(signalled: boolean, cmdline: string | null): boolean {
  return signalled && (cmdline === null || namesWatcher(cmdline))
}

export type WatcherCheck = { kind: 'none' } | { kind: 'live'; pid: string; path: string } | { kind: 'error'; reason: string }

// findWatcher: a live orchestrator-watch.sh lock for the repo, as given and lower-cased (the
// skill's REPO and the origin URL may differ in case). The pid reaches each command as an
// argument, never inside a shell string.
export async function findWatcher(io: RailIo, env: RailEnv, repo: string): Promise<WatcherCheck> {
  const paths = [...new Set([watcherLockPath(env, repo), watcherLockPath(env, repo.toLowerCase())])]
  for (const path of paths) {
    try {
      const pid = pidOf(await io.readFile(`${path}/pid`))
      if (pid === null) continue
      // signal 0 delivers nothing: it only asks whether the pid exists
      const probe = await io.cmd(['sh', '-c', 'kill -0 "$1" 2>/dev/null', 'sh', pid], { timeoutMs: PROBE_TIMEOUT_MS })
      if (probe.exitCode === 1) continue
      if (probe.exitCode !== 0) return { kind: 'error', reason: `old watcher: cannot probe pid ${pid} (exit ${probe.exitCode})` }
      const proc = await io.cmd(['cat', `/proc/${pid}/cmdline`], { timeoutMs: PROBE_TIMEOUT_MS })
      if (watcherAlive(true, proc.exitCode === 0 ? proc.stdout : null)) return { kind: 'live', pid, path }
    } catch (err) {
      return { kind: 'error', reason: `old watcher: cannot check ${path}: ${String(err).slice(0, 200)}` }
    }
  }
  return { kind: 'none' }
}

// --- the heartbeat guard (D-28) -----------------------------------------------------------------

// Another orchestrator's heartbeat this recent holds acting, and the same window is the quiet the
// loop waits for once it stops (heartbeat-loop beats every 60 s, so a live one is never quiet).
export const HEARTBEAT_QUIET_MS = 120 * SECOND

// Every other device's orchestrator row for the repo, aged by the database's clock through
// factory.workers_status, as heartbeat-loop asks readers to (it stores the repo lower-cased).
export const HEARTBEAT_SQL = `select device, extract(epoch from age) as age_s
from factory.workers_status
where role = 'orchestrator'
  and lower(repo) = lower(:'repo')
  and device <> :'device'
order by age, device;
`

export function heartbeatArgv(repo: string, device: string): string[] {
  return ['dev-query', '--csv', '-v', `repo=${repo}`, '-v', `device=${device}`]
}

export type Beat = { device: string; ageMs: Ms }

// parseBeats: the query's CSV as beats; null when it is not the query's output. A row with no
// age (no last_seen) is no heartbeat; a negative age (a clock step) counts as just now.
export function parseBeats(stdout: string): Beat[] | null {
  const header = (stdout.split(/\r?\n/, 1)[0] ?? '').trim()
  if (header !== 'device,age_s') return null
  return parseCsv(stdout).flatMap(row => {
    const device = row.device ?? ''
    const age = row.age_s === undefined || row.age_s.trim() === '' ? Number.NaN : Number(row.age_s)
    return device !== '' && Number.isFinite(age) ? [{ device, ageMs: Math.max(0, age * SECOND) }] : []
  })
}

// A blocking spell: when this loop first saw it, and the device it saw.
export type Spell = { since: Ms; device: string }

// notice: the spell that started this pass, told once (TELL heartbeat-other).
export type GuardVerdict = { ok: boolean; reason: string | null; spell: Spell | null; notice: Spell | null }

// heartbeatVerdict: block while any beat is at most HEARTBEAT_QUIET_MS old. A spell starts at
// the first pass that sees one, with its one notice, and ends at the first pass that sees none.
// A failed query (beats null) blocks too, fail safe, and leaves the spell as it was.
export function heartbeatVerdict(beats: Beat[] | null, prev: Spell | null, now: Ms, error = 'no output'): GuardVerdict {
  if (beats === null) return { ok: false, reason: `heartbeat: query failed (${error})`, spell: prev, notice: null }
  const recent = beats.filter(b => b.ageMs <= HEARTBEAT_QUIET_MS).sort((a, b) => a.ageMs - b.ageMs)
  const newest = recent[0]
  if (newest === undefined) return { ok: true, reason: null, spell: null, notice: null }
  const seen = recent.map(b => `${b.device} ${Math.round(b.ageMs / SECOND)}s ago`).join(', ')
  const spell = prev ?? { since: now, device: newest.device }
  return {
    ok: false,
    reason: `heartbeat: another orchestrator on this repo is up (${seen})`,
    spell,
    notice: prev === null ? spell : null,
  }
}

// heartbeatGuard: one dev-query per pass. A device with no name cannot tell its own beat from
// another's, so it refuses rather than guess.
export async function heartbeatGuard(io: RailIo, repo: string, device: string, prev: Spell | null, now: Ms): Promise<GuardVerdict> {
  if (device === '') {
    return { ok: false, reason: 'heartbeat: this device has no name (DEV_MACHINE_NAME), so its own beat cannot be told apart', spell: prev, notice: null }
  }
  try {
    const r = await io.cmd(heartbeatArgv(repo, device), { stdin: HEARTBEAT_SQL, timeoutMs: QUERY_TIMEOUT_MS })
    if (r.exitCode !== 0) {
      const last = r.stderr.trim().split('\n').pop()?.slice(0, 200) ?? ''
      return heartbeatVerdict(null, prev, now, `exit ${r.exitCode}${last === '' ? '' : `: ${last}`}`)
    }
    return heartbeatVerdict(parseBeats(r.stdout), prev, now, 'unexpected output')
  } catch (err) {
    return heartbeatVerdict(null, prev, now, String(err).slice(0, 200))
  }
}

// --- the rails together (SPEC 11.2) ------------------------------------------------------------

// What the rails remember between passes, so each blocking spell is told once. Plain JSON: the
// driver keeps it beside the ledger in the store, so a reload does not tell a spell again.
export type WatcherSpell = { since: Ms; pid: string }
export type RailMemory = { heartbeat: Spell | null; watcher: WatcherSpell | null }
export const EMPTY_RAIL_MEMORY: RailMemory = { heartbeat: null, watcher: null }

export type RailNotice = { kind: 'heartbeat-other'; device: string; since: Ms } | { kind: 'old-watcher'; pid: string; since: Ms }

export type RailInput = {
  repo: string
  device: string
  // $.session.id(): the act lock's holder
  session: string
  loopDir: string
  config: Config
  env: RailEnv
  now: Ms
  memory: RailMemory
}

// act: every rail passed and this session holds the lease. reasons: each refusal, in the fixed
// order. lock: the lease outcome, null when another rail refused (the lease is left alone).
export type RailResult = { act: boolean; reasons: string[]; notices: RailNotice[]; memory: RailMemory; lock: LockResult | null }

// checkRails: run at the start of every act-mode pass, before any action, in a fixed order:
// the role, the old watcher, the heartbeat guard, then the act lock. The first three always run,
// so the log names every refusal and each spell is tracked; the lock is taken only when they
// pass. A session that fails the role check can never act, so it tells nothing.
export async function checkRails(io: RailIo, input: RailInput): Promise<RailResult> {
  const { config, env, now, memory } = input
  const reasons: string[] = []
  const notices: RailNotice[] = []

  const role = roleProblem(env.DEV_ROLE, config)
  if (role !== null) reasons.push(role)

  const watcher = await findWatcher(io, env, input.repo)
  let watcherSpell = memory.watcher
  if (watcher.kind === 'live') {
    reasons.push(`old watcher: orchestrator-watch.sh holds ${watcher.path} (pid ${watcher.pid})`)
    if (watcherSpell === null) {
      watcherSpell = { since: now, pid: watcher.pid }
      notices.push({ kind: 'old-watcher', pid: watcher.pid, since: now })
    }
  } else if (watcher.kind === 'error') {
    reasons.push(watcher.reason)
  } else {
    watcherSpell = null
  }

  const guard = await heartbeatGuard(io, input.repo, input.device, memory.heartbeat, now)
  if (guard.reason !== null) reasons.push(guard.reason)
  if (guard.notice !== null) notices.push({ kind: 'heartbeat-other', device: guard.notice.device, since: guard.notice.since })

  let lock: LockResult | null = null
  if (reasons.length === 0) {
    lock = await holdActLock(io, actLockPath(input.loopDir), input.session, now, leaseMsOf(config))
    if (!lock.held) reasons.push(lock.reason)
  }
  return {
    act: reasons.length === 0,
    reasons,
    notices: role === null ? notices : [],
    memory: { heartbeat: guard.spell, watcher: watcherSpell },
    lock,
  }
}

// --- the usage pre-check (SPEC 10.7) -------------------------------------------------------------

// The classes each tier lets run: plan's own matrix (ALLOWED in plan.ts, not exported), mirrored
// here and held to plan's behaviour by rails.test.ts.
export const TIER_CLASSES: Record<Tier, readonly ActionClass[]> = {
  normal: ['free', 'owner', 'drive', 'develop', 'start'],
  slow: ['free', 'owner', 'drive', 'develop', 'start'],
  'stop-new': ['free', 'owner', 'drive'],
  'stop-all': ['free', 'owner'],
}

// The token-spending classes, read against the session's usage again just before they run.
export const PRECHECKED: readonly ActionClass[] = ['start', 'develop', 'drive']

export type UsageReading = { fiveHour: number | null; sevenDay: number | null }

const pct = (v: number | null) => (v === null ? 'n/a' : `${v}%`)

// usageVerdict: why this reading forbids the class now, or null. tierOf decides the tier, the
// owner's override included; a missing reading is Normal, as plan fails open.
export function usageVerdict(
  reading: UsageReading,
  klass: ActionClass,
  config: Config,
  override: Control['usageOverride'],
  now: Ms,
): string | null {
  if (!PRECHECKED.includes(klass)) return null
  const usage = { ...reading, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: false }
  const { tier } = tierOf(usage, config, override, now)
  if (TIER_CLASSES[tier].includes(klass)) return null
  return `usage: tier ${tier} forbids ${klass} (5h ${pct(reading.fiveHour)}, 7d ${pct(reading.sevenDay)})`
}

// preCheck: before a start, develop or drive action, the session's usage read again (it is
// free); a tier that now forbids the class skips the action, no attempt counted, and the next
// pass re-plans. A failed read leaves plan's tier standing.
export async function preCheck(
  io: Pick<ActIo, 'usage' | 'now'>,
  action: Action,
  config: Config,
  override: Control['usageOverride'],
): Promise<Extract<Exec, { status: 'skipped' }> | null> {
  if (!PRECHECKED.includes(action.class)) return null
  let reading: UsageReading
  try {
    reading = await io.usage()
  } catch {
    return null
  }
  const why = usageVerdict(reading, action.class, config, override, await io.now())
  return why === null ? null : { status: 'skipped', summary: why }
}

// --- the pass scheduler and the ping-storm breaker (SPEC 2, 11.4, D-39) --------------------------

export const PASS_GAP_MS = 5 * SECOND
export const STORM_PASSES = 30
export const STORM_WINDOW_MS = 10 * MINUTE
export const STORM_QUIET_MS = 10 * MINUTE

export type PassSource = 'ping' | 'timer'

export type Scheduler = {
  running: boolean
  // the one pass wanted next: the timer's when any tick asked for it, else a ping's
  queued: PassSource | null
  lastStart: Ms | null
  // a wait for the end of the gap is set (one timer, however many requests arrive)
  wakeAt: Ms | null
  // when each ping-driven pass of the last STORM_WINDOW_MS started
  pingStarts: Ms[]
  // the breaker: pings are ignored until then, timer ticks never are
  pingsIgnoredUntil: Ms | null
}

export type NextPass = { do: 'start'; source: PassSource } | { do: 'wait'; ms: Ms } | { do: 'idle' }

// The breaker's one notice: TELL breaker kind=ping, plus a loop event.
export type BreakerNotice = { kind: 'breaker'; since: Ms; until: Ms; passes: number }

export function newScheduler(): Scheduler {
  return { running: false, queued: null, lastStart: null, wakeAt: null, pingStarts: [], pingsIgnoredUntil: null }
}

export function pingsIgnored(s: Scheduler, now: Ms): boolean {
  return s.pingsIgnoredUntil !== null && now < s.pingsIgnoredUntil
}

// requestPass: a ping or a timer tick arrived, during a pass or not. Requests merge into one
// queued pass; a ping is dropped while the breaker is open.
export function requestPass(s: Scheduler, source: PassSource, now: Ms): Scheduler {
  if (source === 'ping' && pingsIgnored(s, now)) return s
  return { ...s, queued: s.queued === 'timer' || source === 'timer' ? 'timer' : 'ping' }
}

// nextPass: what the driver does now; call it after every request, pass end and wait. Passes
// never overlap and start PASS_GAP_MS apart: `wait` asks for one timer, whose callback calls
// waitOver and then nextPass again. Starting the ping-driven pass that makes more than
// STORM_PASSES in STORM_WINDOW_MS opens the breaker for STORM_QUIET_MS, with its one notice.
export function nextPass(s: Scheduler, now: Ms): { scheduler: Scheduler; next: NextPass; notice: BreakerNotice | null } {
  if (s.running || s.queued === null || (s.wakeAt !== null && now < s.wakeAt)) return { scheduler: s, next: { do: 'idle' }, notice: null }
  if (s.lastStart !== null && now < s.lastStart + PASS_GAP_MS) {
    const wakeAt = s.lastStart + PASS_GAP_MS
    return { scheduler: { ...s, wakeAt }, next: { do: 'wait', ms: wakeAt - now }, notice: null }
  }
  const source = s.queued
  let pingStarts = s.pingStarts.filter(t => now - t < STORM_WINDOW_MS)
  let pingsIgnoredUntil = pingsIgnored(s, now) ? s.pingsIgnoredUntil : null
  let notice: BreakerNotice | null = null
  if (source === 'ping') {
    pingStarts = [...pingStarts, now]
    if (pingStarts.length > STORM_PASSES) {
      pingsIgnoredUntil = now + STORM_QUIET_MS
      notice = { kind: 'breaker', since: now, until: pingsIgnoredUntil, passes: pingStarts.length }
      pingStarts = []
    }
  }
  return {
    scheduler: { running: true, queued: null, lastStart: now, wakeAt: null, pingStarts, pingsIgnoredUntil },
    next: { do: 'start', source },
    notice,
  }
}

// waitOver: the wait's timer fired (early or late, nextPass judges the gap again).
export function waitOver(s: Scheduler): Scheduler {
  return { ...s, wakeAt: null }
}

// passEnded: the pass is over; nextPass then starts the one queued meanwhile, if any.
export function passEnded(s: Scheduler): Scheduler {
  return { ...s, running: false }
}

// --- notices as tell wakes (SPEC 9.2) -----------------------------------------------------------

export type Notice = RailNotice | BreakerNotice

// noticeTell: the tell wake a notice becomes, keyed by its spell so it goes out once:
// `TELL heartbeat-other device=<d>` under tell:heartbeat-other:<since>, `TELL breaker kind=ping`
// under tell:breaker:pings:<since> (plan's breaker keys name an action kind, never `pings`).
// SPEC 9.2 has no kind for the old watcher yet (11.2 says the owner is told): old-watcher.
export function noticeTell(n: Notice): Action {
  const tell = (wake: string, key: string, fields: Record<string, string>): Action => ({
    kind: 'tell',
    wake,
    key,
    class: 'owner',
    rule: 'O2',
    reason: `tell ${wake}`,
    issue: null,
    fields,
    context: [],
  })
  switch (n.kind) {
    case 'heartbeat-other':
      return tell('heartbeat-other', `tell:heartbeat-other:${n.since}`, { device: n.device })
    case 'old-watcher':
      return tell('old-watcher', `tell:old-watcher:${n.since}`, { pid: n.pid })
    case 'breaker':
      return tell('breaker', `tell:breaker:pings:${n.since}`, { kind: 'ping' })
  }
}
