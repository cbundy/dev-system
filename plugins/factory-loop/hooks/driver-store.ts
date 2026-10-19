// The driver's store: the ledger (v2 SPEC 13.7) loaded from and saved to $.store, the backoff, the queue's
// known list, rail memory and notices, and the environment an act step runs in outside a pass.
import type { EngineInterface } from 'claude-code'

import { logLoop, loggedOf, transition } from './act'
import type { ActEnv } from './act'
import { EMPTY_CONTROL } from './config'
import { finish, load, onLoad, save } from './ledger'
import type { StoreIo } from './ledger'
import type { Runtime } from './observe'
import { EMPTY_RAIL_MEMORY, actLockPath, decideLock, leaseMsOf } from './rails'
import type { Notice, RailMemory } from './rails'
import type { LedgerEntry, Ms, SourceName, State } from './types'
import { loadV2 } from './v2/store'
import { orphanedWakes } from './wake'
import { actIo, acting, killed, mayWrite, message, text, v2StoreIo, wakeIdAt } from './driver-io'
import { S, live, liveV2 } from './driver-state'

export const keysOf = (repo: string) => ({
  backoff: `backoff:${repo}`,
  starved: `starved:${repo}`,
  known: `queue-known:${repo}`,
  rails: `rails:${repo}`,
  notices: `notices:${repo}`,
  titles: `titles:${repo}`,
})

// mayLoad: no other session holds a live act lease, so this one may load the store's ledger, which
// is then fresh. The act lock is the one writer's lease (v2 SPEC 13.11.2).
export async function mayLoad($: EngineInterface, rt: Runtime): Promise<{ ok: boolean; basis: string | null }> {
  try {
    const basis = await text($, actLockPath(rt.loopDir))
    return { ok: decideLock(basis, await $.session.id(), await $.clock.now(), leaseMsOf(rt.config)).hold, basis }
  } catch {
    return { ok: false, basis: null }
  }
}

// ensureLedger: the ledger in memory, loaded from the store once per module load (and again
// when this session takes the act lock over from another), with every running command entry
// marked lost (v2 SPEC 13.7.5). A store that cannot be read leaves it unloaded: falling back to the
// event log would overwrite the real ledger at the next save.
export async function ensureLedger($: EngineInterface, rt: Runtime, problems: string[]): Promise<boolean> {
  if (live.loaded && live.repo === rt.repo) return true
  // a pass and a hook that both need it load it once
  S.loading ??= loadLedger($, rt, problems).finally(() => {
    S.loading = null
  })
  return S.loading
}

export async function loadLedger($: EngineInterface, rt: Runtime, problems: string[]): Promise<boolean> {
  const may = await mayLoad($, rt)
  if (!may.ok) return false
  let stored: LedgerEntry[] | null
  try {
    stored = await load(storeIo($), rt.repo)
  } catch (err) {
    problems.push(`ledger: the store could not be read: ${message(err).slice(0, 200)}`)
    return false
  }
  live.ledger = stored ?? []
  live.logged = loggedOf(live.ledger)
  live.loaded = true
  live.repo = rt.repo
  live.basis = may.basis
  // v2's records and heads load with the ledger, whose lease keeps them too
  await loadV2(liveV2, v2StoreIo($), rt.repo)
  const now = await $.clock.now()
  const env = hookEnv($, rt, now)
  // running commands died with the old module; wakes another session submitted went with it
  const moved = transition(live, l => onLoad(l, now))
  moved.push(...closeOrphans(await $.session.id(), now))
  await persist($, rt)
  await logLoop(env, moved)
  problems.push(...env.problems)
  return true
}

// closeOrphans: the live ledger's wakes no one can answer any more lost at once (wake.ts
// orphanedWakes, v2 SPEC 13.7.5); the entries it moved, for the loop events.
export function closeOrphans(session: string, now: Ms): LedgerEntry[] {
  const moved: LedgerEntry[] = []
  for (const u of orphanedWakes(live.ledger, session, S.loadedAt)) moved.push(...transition(live, l => finish(l, u.key, u, now)))
  return moved
}

// persist: write the live ledger, one save at a time; whether it was written. save prunes it, and
// the memory takes what was written unless a transition came in meanwhile (the next save prunes
// that). A store that refuses the write is kept in saveProblem until a save succeeds: the pass
// reports it, and nothing starts while the ledger cannot be saved (act.ts actOne).
export function persist($: EngineInterface, rt: Runtime): Promise<boolean> {
  const run = S.saving.then(async (): Promise<boolean> => {
    if (!live.loaded) return false
    if (!(await mayWrite($, rt))) {
      // another session acts now: it keeps the ledger, and this one reloads before it acts again
      live.loaded = false
      return false
    }
    const snapshot = live.ledger
    try {
      const written = await save(storeIo($), rt.repo, snapshot, await $.clock.now())
      if (live.ledger === snapshot) live.ledger = written
      S.saveProblem = null
      return true
    } catch (err) {
      S.saveProblem = message(err).slice(0, 200)
      return false
    }
  })
  S.saving = run.then(
    () => undefined,
    () => undefined,
  )
  return run.catch(() => false)
}

// storeIo: ledger.ts's StoreIo over $.store.
export function storeIo($: EngineInterface): StoreIo {
  return { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) }
}

export async function storeGet($: EngineInterface, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

export async function storeSet($: EngineInterface, key: string, value: unknown, problems: string[]) {
  try {
    await $.store.set(key, value)
  } catch (err) {
    problems.push(`store: ${key} not saved: ${message(err).slice(0, 200)}`)
  }
}

export async function storeDelete($: EngineInterface, key: string, problems: string[]) {
  try {
    await $.store.delete(key)
  } catch (err) {
    problems.push(`store: ${key} not removed: ${message(err).slice(0, 200)}`)
  }
}

export const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function railMemoryFrom(raw: unknown): RailMemory {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const hb = o.heartbeat as Record<string, unknown> | null | undefined
  const w = o.watcher as Record<string, unknown> | null | undefined
  return {
    heartbeat: hb && isMs(hb.since) && typeof hb.device === 'string' ? { since: hb.since, device: hb.device } : EMPTY_RAIL_MEMORY.heartbeat,
    watcher: w && isMs(w.since) && typeof w.pid === 'string' ? { since: w.since, pid: w.pid, seenAt: isMs(w.seenAt) ? w.seenAt : w.since } : EMPTY_RAIL_MEMORY.watcher,
  }
}

// Notices that come from outside plan wait here until no wake is open; caps are the hourly
// rate-cap loop events already logged.
export type NoticeBook = { pending: Notice[]; caps: string[] }

export function noticeOf(raw: unknown): Notice | null {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  if (o === null || !isMs(o.since)) return null
  if (o.kind === 'heartbeat-other' && typeof o.device === 'string') return { kind: o.kind, device: o.device, since: o.since }
  if (o.kind === 'old-watcher' && typeof o.pid === 'string') return { kind: o.kind, pid: o.pid, since: o.since }
  if (o.kind === 'schema-behind' && typeof o.to === 'string' && typeof o.error === 'string') return { kind: o.kind, to: o.to, error: o.error, since: o.since }
  if (o.kind === 'breaker' && isMs(o.until) && isMs(o.passes)) return { kind: o.kind, since: o.since, until: o.until, passes: o.passes }
  return null
}

export function noticesFrom(raw: unknown): NoticeBook {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const pending = Array.isArray(o.pending) ? o.pending.map(noticeOf).filter((n): n is Notice => n !== null) : []
  const caps = Array.isArray(o.caps) ? o.caps.filter((c): c is string => typeof c === 'string') : []
  return { pending, caps }
}

// stale: a notice whose spell ended before it could go out says nothing true any more.
export function stale(n: Notice, memory: RailMemory | null, now: Ms): boolean {
  if (n.kind === 'breaker') return now >= n.until
  // keyed by the status's own `at`: the ledger's key makes it go out once
  if (n.kind === 'schema-behind') return false
  if (memory === null) return false
  if (n.kind === 'heartbeat-other') return memory.heartbeat?.since !== n.since
  return memory.watcher?.since !== n.since
}

// hookEnv: an act step's environment outside a pass (a hook, a notice): real events.
export function hookEnv($: EngineInterface, rt: Runtime, now: Ms, session = ''): ActEnv {
  return {
    io: actIo($),
    rt: acting(rt),
    live,
    commands: [],
    wakeId: () => wakeIdAt(now),
    session,
    save: () => persist($, rt),
    holds: async () => true,
    killed: () => killed($),
    problems: [],
  }
}

// bareState: a state for an act step outside a pass when none was planned yet this load.
export function bareState(rt: Runtime, now: Ms): State {
  const off = { ok: false, at: null }
  const names: SourceName[] = ['factory', 'facts', 'runs', 'queue', 'github', 'usage', 'pool', 'milestone']
  return {
    now,
    repo: rt.repo,
    device: rt.device,
    loadedAt: S.loadedAt,
    sources: Object.fromEntries(names.map(n => [n, off])) as State['sources'],
    usage: { fiveHour: null, sevenDay: null, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: true },
    issues: [],
    queue: [],
    runs: [],
    pool: null,
    agents: [],
    milestone: null,
    ledger: live.ledger,
    control: EMPTY_CONTROL,
    lastTitle: S.lastTitle,
    lastTitleAt: S.lastTitleAt,
    githubBackoffUntil: null,
    checkout: null,
  }
}
