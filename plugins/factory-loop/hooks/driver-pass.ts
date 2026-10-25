// The pass scheduler (v2 SPEC 13.2, D-39) and one pass (v2 SPEC 13.2): one at a time, 5 s apart, pings first,
// each reading the factory, planning and, in act mode, running plan's actions, then logging.
import type { EngineInterface } from 'claude-code'

import { actPass, commandOf, logLoop, loggedOf, planPass, sendNotice, updateDone } from './act'
import type { ActEnv, ActReport } from './act'
import { LOOP_FILES_KEEP_DAYS, pruneArgvs } from './exec'
import { GITHUB_BACKOFF_MS, observe } from './observe'
import type { Runtime, Stored } from './observe'
import { holdsLock, recordPass } from './pass-summary'
import { nextSnapshot, snapshotFailed, takeProblem } from './queue-snapshot'
import { LOCK_CAS_SCRIPT, actLockPath, checkRails, holdActLock, leaseMsOf, nextPass, noticeTell, parseLease, passEnded, pingsIgnored, requestPass, waitOver } from './rails'
import type { BreakerNotice, Notice, PassSource, RailEnv, RailMemory } from './rails'
import { keepTitles } from './report'
import { agentModelsOf, snapshotFrom, snapshotOf, writeSnapshot } from './settings-snapshot'
import type { Snapshot } from './settings-snapshot'
import { digestOf } from './state'
import { clocked } from './observe-clock'
import type { ObserveSplit } from './observe-clock'
import { attemptOf, begin, called, carve, newTracer, spent, traceRecord, tracedActIo, tracedIo, waitSince, waitingRows, wakeRows } from './trace'
import type { Config, Ms, PlanResult, State } from './types'
import { effectiveCap } from './v2/capacity'
import type { V2Stored } from './v2/observe'
import { transitionsOf } from './v2/plan'
import { opsFrom } from './v2/rules-settings'
import { stateCounts } from './v2/rules-state'
import { keepV2, noteIdle, noteKillSwitch, readStoredV2, storedV2 } from './v2/store'
import { windDownFiles, withRemembered } from './v2/wind-down-files'
import { windDownOf } from './v2/wind-down'
import { actIo, acting, append, appendLine, fileIo, githubHealth, io, killed, lockIo, lockOp, observing, offTitle, originOf, runtime, setTitle, text, v2StoreIo, wakeIdAt } from './driver-io'
import { offPassDone } from './driver-between'
import { closeOrphans, ensureLedger, isMs, keepSettings, keysOf, noticesFrom, persist, railMemoryFrom, stale, storeDelete, storeGet, storeIo, storeSet } from './driver-store'
import type { NoticeBook } from './driver-store'
import { holdView, settleResumed } from './session-hold'
import { clearUpdate, starvedOf, summaryOf, tellError, writeTrace } from './driver-pass-log'
import { ASKED_MAX, ERROR_PASSES, S, STATES_PER_DAY, STATE_KEEP_BYTES, between, cache, delivered, live, liveV2, reportedWakes } from './driver-state'
import type { AgentRow } from './driver-state'

// the last pass's summary (types/index.d.ts): the engine's validator reads a state reference only
// when it is a literal const of the file that uses it, so driver-controls.ts spells the same one
const lastPassRef = { plugin: 'factory-loop', key: 'lastPass' } as const

// request: a timer tick or a ping asks for a pass; the scheduler decides when it starts. The
// pass runs with the $ of whoever asked (a timer's closure, a hook's own). `why` names the asker
// for the pass's trigger; a ping the breaker ignores asks for nothing.
export async function request($: EngineInterface, source: PassSource, why: string) {
  if (S.headless) return
  const now = await $.clock.now()
  if (!(source === 'ping' && pingsIgnored(S.sched, now)) && !S.asked.includes(why) && S.asked.length < ASKED_MAX) S.asked.push(why)
  S.sched = requestPass(S.sched, source, now)
  await step($)
}

export async function step($: EngineInterface) {
  const now = await $.clock.now()
  const r = nextPass(S.sched, now)
  S.sched = r.scheduler
  if (r.next.do === 'start') {
    // every request since the last pass started is this one's trigger
    const trigger = S.asked.length > 0 ? S.asked.join(', ') : 'timer'
    S.asked = []
    void runPass($, r.notice, trigger)
      .catch(() => undefined)
      .finally(() => {
        S.sched = passEnded(S.sched)
        void step($).catch(() => undefined)
      })
  } else if (r.next.do === 'wait') {
    $.clock.after(r.next.ms, () => {
      S.sched = waitOver(S.sched)
      void step($).catch(() => undefined)
    })
  }
}

export function rearm($: EngineInterface, ms: Ms) {
  if (S.timer?.ms === ms) return
  S.timer?.cancel()
  const t = $.clock.every(ms, () => void request($, 'timer', 'timer').catch(() => undefined))
  S.timer = { ms, cancel: () => t.cancel() }
}

// listAgents: one agent list per pass. Only a successful read may mark agents lost.
export async function listAgents($: EngineInterface): Promise<{ ok: boolean; agents: AgentRow[] }> {
  try {
    return { ok: true, agents: (await $.agent.list()).map(a => ({ id: a.id, type: a.type, status: a.status })) }
  } catch {
    return { ok: false, agents: [] }
  }
}

export async function railEnv($: EngineInterface): Promise<RailEnv> {
  return {
    DEV_ROLE: await $.env.get('DEV_ROLE'),
    DEV_CODER_WORKSPACE: await $.env.get('DEV_CODER_WORKSPACE'),
    ORCHESTRATOR_WATCH_LOCK_DIR: await $.env.get('ORCHESTRATOR_WATCH_LOCK_DIR'),
    XDG_RUNTIME_DIR: await $.env.get('XDG_RUNTIME_DIR'),
    TMPDIR: await $.env.get('TMPDIR'),
    DEV_FACTORY_DB_MIGRATE_STATUS: await $.env.get('DEV_FACTORY_DB_MIGRATE_STATUS'),
  }
}

export async function runPass($: EngineInterface, breaker: BreakerNotice | null, trigger: string) {
  // the pass's time runs from here, for the decision log and the trace (#552)
  const t0 = performance.now()
  let rt: Runtime | undefined
  S.passObserve = null
  try {
    rt = await runtime($)
    S.lastRt = rt
    rearm($, rt.config.passEveryMs)
    await noteIdle(liveV2, v2StoreIo($), fileIo($), rt)
    const off = rt.mode === 'off' || (await noteKillSwitch(liveV2, v2StoreIo($), rt, await killed($)))
    if (off || rt.repo === '') {
      setTitle($, offTitle(rt))
    } else {
      S.passNo += 1
      await pass($, rt, breaker, trigger, t0)
    }
    S.failures = 0
    S.failingSince = null
    S.errorTold = false
  } catch (err) {
    S.failures += 1
    const now = await $.clock.now()
    S.failingSince ??= now
    if (rt !== undefined) {
      recordPass(now, Math.round(performance.now() - t0), false, true, S.passObserve)
      await appendLine($, rt, { pass: S.passNo, trigger, ms: Math.round(performance.now() - t0), error: String(err).slice(0, 500), failures: S.failures })
      const name = rt.repo.split('/')[1] ?? 'loop'
      const title = S.lastTitle === null ? `🔄 ${name} · error` : S.lastTitle.endsWith(' · error') ? S.lastTitle : `${S.lastTitle} · error`
      setTitle($, title)
      if (S.failures >= ERROR_PASSES && rt.mode === 'act' && !S.errorTold) S.errorTold = await tellError($, rt, now, String(err))
    }
  }
}

export async function pass($: EngineInterface, rt: Runtime, breaker: BreakerNotice | null, trigger: string, t0: number) {
  const now = await $.clock.now()
  // trace mode (#552): the pass's phases, every engine call it makes and its totals; null when off
  const tr = rt.config.trace ? newTracer(() => performance.now(), t0, now) : null
  const keys = keysOf(rt.repo)
  const listed = await called(tr, 'agent.list', () => listAgents($), r => (r.ok ? {} : { error: 'not read' }))
  const commands: string[] = []
  const problems: string[] = []
  const aio = tr === null ? actIo($) : tracedActIo(tr, actIo($))
  const keepInStore = (key: string, value: unknown) => spent(tr, 'persistMs', () => storeSet($, key, value, problems))
  let railReasons: string[] = []
  let railTwins: { device: string; age_s: number }[] = []
  let memory: RailMemory | null = null
  let book: NoticeBook = { pending: [], caps: [] }
  let booked = JSON.stringify(book)
  let act = false
  let sid = ''

  // the rails, at the start of every act-mode pass, before anything acts (v2 SPEC 13.11.2)
  begin(tr, 'rails')
  if (rt.mode === 'act') {
    sid = await $.session.id()
    const remembered = railMemoryFrom(await storeGet($, keys.rails))
    // the CLIs act on the checkout's own origin, the gh executors on rt.repo: they must be one
    // repo, or a merge lands in one and its follow-ups in the other (v2 SPEC 13.11.5)
    const origin = await originOf($, rt.cwd, rt.env)
    const refusals = origin.toLowerCase() === rt.repo.toLowerCase() ? [] : [`repo: the checkout ${rt.cwd} is ${origin === '' ? 'no GitHub repository' : origin}, not ${rt.repo}`]
    // the rails' probes join the pass's command list; the lease's write does not
    const logged = commandOf(aio, rt, commands)
    const rails = await checkRails(
      { cmd: (argv, init) => (argv[2] === LOCK_CAS_SCRIPT ? lockIo($, tr).cmd(argv, init) : logged(argv, init)), readFile: aio.readFile },
      { repo: rt.repo, device: rt.device, session: sid, loopDir: rt.loopDir, config: rt.config, env: await railEnv($), now, memory: remembered, refusals },
    )
    memory = rails.memory
    railReasons = rails.reasons
    railTwins = rails.twins.map(b => ({ device: b.device, age_s: Math.round(b.ageMs / 1000) }))
    act = rails.act
    if (JSON.stringify(rails.memory) !== JSON.stringify(remembered)) await keepInStore(keys.rails, rails.memory)
    if (rails.lock !== null && rails.lock.held) {
      S.heldLock = true
      // another session's lease ran out under it: the store holds its ledger, the truth now
      if (rails.lock.took !== null) live.loaded = false
    }
    book = noticesFrom(await storeGet($, keys.notices))
    booked = JSON.stringify(book)
    const fresh: Notice[] = breaker === null ? rails.notices : [...rails.notices, breaker]
    for (const n of fresh) if (!book.pending.some(p => noticeTell(p).key === noticeTell(n).key)) book.pending.push(n)
    if (act && S.restartAsked !== null && S.restartRequestAt === null) {
      act = false
      railReasons.push(`restart: dev-restart-self asked for a new workspace at ${new Date(S.restartAsked).toISOString()}; nothing acts until it restarts`)
    }
    if (act && !(await ensureLedger($, rt, problems))) {
      act = false
      railReasons.push('ledger: not loaded, so nothing is acted on this pass')
    }
  }

  // observe: act mode reads the store's ledger, backoff and queue list; anything else runs as
  // observe, its events to the sink
  begin(tr, 'observe')
  const passRt = act ? rt : rt.mode === 'act' ? observing(rt) : rt
  let stored: Stored | undefined
  // API-key mode's tally: read in every mode, written only by an acting pass
  const spendStored = rt.apiKey === undefined ? undefined : await storeGet($, keys.spend)
  if (act) {
    const backoff = await storeGet($, keys.backoff)
    const known = await storeGet($, keys.known)
    const starved = await storeGet($, keys.starved)
    stored = {
      starvedSince: isMs(starved) ? starved : null,
      ledger: live.ledger.length > 0 ? live.ledger : null,
      githubBackoffUntil: isMs(backoff) ? backoff : null,
      queueKnown: Array.isArray(known) && known.every(n => typeof n === 'number') ? known : null,
    }
  }
  // A shadow watches another session: this module's own load says nothing about when that
  // session restarted, so the first-pass heartbeat (rule H1) is left to real lease timing.
  const shadowing = rt.device !== ((await $.env.get('DEV_MACHINE_NAME')) || '')
  const clock = clocked(tr === null ? io($, listed.agents) : tracedIo(tr, io($, listed.agents)), () => performance.now())
  const reads = clock.io
  // v2's records and heads: act mode's own, else the store's, read and never written (v2 SPEC 2.3)
  const v2Stored: V2Stored = await (act ? storedV2(liveV2, v2StoreIo($), rt.repo) : readStoredV2(v2StoreIo($), rt.repo))
  const observeStart = performance.now()
  const observed = await observe(reads, passRt, cache, shadowing ? 0 : S.loadedAt, S.lastTitle, S.lastTitleAt, stored, v2Stored, spendStored)
  const observeSplit: ObserveSplit = clock.split(observeStart, performance.now())
  S.passObserve = observeSplit
  let state: State = { ...observed.state, hold: holdView() }
  // the main checkout this pass read, for `/factory stamp` (driver-stamp.ts) in any mode
  S.checkout = state.checkout
  // the settings in force, for whoever reads them (settings.json); best effort, a problem line when it fails
  let snap: Snapshot | null = null
  let before: Snapshot | null = null
  try {
    snap = snapshotOf(
      rt,
      state.control,
      await agentModelsOf(path => text($, path), rt.pluginRoot),
      { implementerOpusPct: await $.env.get('CALLUM_FLOW_IMPLEMENTER_OPUS_PCT'), designSessionPct: await $.env.get('CALLUM_FLOW_DESIGN_SESSION_PCT') },
      state.now,
      effectiveCap(rt.config, rt.memoryBytes ?? null, state.v2?.interventions.gates),
    )
    problems.push(...(await writeSnapshot({ run: (argv, init) => $.process.run(argv, init) }, rt.loopDir, snap)))
  } catch (e) {
    problems.push(`settings snapshot: ${e instanceof Error ? e.message : String(e)}`)
  }
  // an acting pass hands the planner the snapshot and the last one kept, with the config ops since (rule N1)
  if (act && snap !== null && state.v2 !== undefined) {
    const kept = snapshotFrom(await storeGet($, keys.settings))
    before = kept?.snap ?? null
    state = { ...state, v2: { ...state.v2, settings: { now: snap, nowAt: state.now, before, beforeAt: kept?.at ?? null, ops: opsFrom(await storeGet($, keys.settingsOps)) } } }
  }
  if (act) await keepV2(liveV2, observed.v2Heads, state, keepInStore)
  // an acting pass renews its lease before every action and on a timer while it runs, so no
  // step outlives it; once another session holds it, this pass runs nothing more and keeps the
  // ledger no longer (the next pass that holds it reloads the store)
  let holding = true
  const renew = async (): Promise<boolean> => {
    if (!holding) return false
    const path = actLockPath(rt.loopDir)
    // a save that found the lock another session's let the ledger go: nothing more acts on it
    const lock = live.loaded ? await lockOp(async () => holdActLock(lockIo($, tr), path, sid, await $.clock.now(), leaseMsOf(rt.config))) : null
    if (lock !== null && lock.held && lock.took === null) return true
    holding = false
    live.loaded = false
    if (lock !== null && !lock.held) problems.push(lock.reason)
    else {
      // a lease taken over mid-pass, or written meanwhile, was another session's: its ledger is the truth
      const other = lock?.took?.session ?? parseLease(await text($, path))?.session ?? 'unknown'
      problems.push(`act lock: session ${other} held it during this pass; this one keeps the ledger no longer`)
    }
    return false
  }
  // a save writes only while this pass holds the lease, and persist checks it again
  const save = async (): Promise<boolean> => {
    if (act && !holding) return false
    return spent(tr, 'persistMs', () => persist($, rt))
  }
  const holds = () => (act ? renew() : Promise.resolve(holding))
  // a snapshot write that failed since the last pass line is told once, here
  const late = takeProblem()
  if (late !== null) problems.push(late)
  const env: ActEnv = { io: aio, rt, live, commands, wakeId: () => wakeIdAt(state.now), session: sid, save, holds, killed: () => killed($), problems, offPass: { io: actIo($), done: d => void offPassDone($, rt, d) } }

  let report: ActReport | null = null
  let result: PlanResult
  // when plan handed the actions over, for the trace
  let queuedAt: Ms | null = null
  const told: string[] = []
  const renewal = act ? $.clock.every(rt.config.passEveryMs, () => void renew().catch(() => undefined)) : null
  try {
    if (act) {
      begin(tr, 'act')
      // a lost store, rebuilt from the event log, becomes the ledger the loop keeps
      if (observed.ledgerSource === 'events' && live.ledger.length === 0 && state.ledger.length > 0) {
        live.ledger = [...state.ledger]
        live.logged = loggedOf(live.ledger)
        // a wake it rebuilt was open in an earlier session, which took its prompt along
        const moved = closeOrphans(sid, state.now)
        await spent(tr, 'persistMs', () => persist($, rt))
        await logLoop(env, moved)
      }
      // the restart for an update ran: the update is done, so the drain ends (rule H4)
      if (updateDone(live.ledger, state.control, S.loadedAt) && (await clearUpdate($, rt, state.control.updateDue?.at ?? null))) {
        state = { ...state, control: { ...state.control, updateDue: null } }
      }
      // wind-down (v2 SPEC 10.11): the status file of an active one, or a stale request removed
      state = withRemembered(state, S.restartRequestAt)
      const winding = windDownOf(state, rt.config)
      problems.push(...(await windDownFiles({ run: (argv, init) => $.process.run(argv, init) }, rt.loopDir, state, rt.config)))
      const acted = await actPass(env, state, listed, between)
      carve(tr, 'plan', acted.planned.ms)
      queuedAt = acted.planned.at
      state = acted.state
      result = acted.result
      report = acted.report
      S.lastState = state
      // a request that went stale was told by the plan above: the restart never came, so the loop plans normally
      if (winding.mode === 'stale' && S.restartRequestAt !== null) [S.restartAsked, S.restartRequestAt] = [null, null]
      const restarted = report.outcomes.find(o => o.kind === 'restart-self' && o.status === 'done')
      if (restarted !== undefined) {
        S.restartAsked = state.now
        const planned = result.actions.find(a => a.key === restarted.key)
        S.restartRequestAt = planned?.kind === 'restart-self' && planned.windDownAt != null ? planned.windDownAt : null
      }
      // the kill switch stopped the pass between actions: the title says off now, not next pass
      if (report.killed) setTitle($, offTitle(rt))
      // the queue the plan saw: one `queue_snapshot` when it changed or on the heartbeat, sent without waiting so it never slows the pass
      if (!report.killed && result.queue !== undefined) {
        const claimed = result.actions.some(a => a.kind === 'claim' && a.rule === 'S1')
        const argv = nextSnapshot(result.queue, state.now, claimed)
        if (argv !== null) {
          void commandOf(env.io, rt, commands)(argv, { timeoutMs: 60_000 }).then(
            r => {
              if (r.exitCode !== 0) snapshotFailed(`exit ${r.exitCode}`)
            },
            (e: unknown) => snapshotFailed(e instanceof Error ? e.message : String(e)),
          )
        }
      }
    } else {
      // a pass that may not act plans as observe mode does, and its title says so
      const config: Config = rt.mode === 'act' ? { ...rt.config, mode: 'observe' } : rt.config
      begin(tr, 'plan')
      result = planPass(state, config)
      begin(tr, 'act')
      if (result.actions.some(a => a.kind === 'title')) setTitle($, result.title)
    }

    // notices from outside plan go out once no wake is open, acting or not (v2 SPEC 13.9.2, 13.11.2), until a
    // restart was asked for
    if (rt.mode === 'act' && (S.restartAsked === null || S.restartRequestAt !== null)) {
      book.pending = book.pending.filter(n => !stale(n, memory, state.now))
      if (book.pending.length > 0 && (act || (await ensureLedger($, rt, problems)))) {
        const nenv: ActEnv = { ...env, rt: acting(rt) }
        let waiting = false
        for (const n of book.pending) {
          const tell = noticeTell(n)
          if (waiting || live.ledger.some(e => e.key === tell.key && e.status !== 'lost')) continue
          const sent = await sendNotice(nenv, state, tell)
          if (sent === 'sent') told.push(tell.key)
          else waiting = true
        }
        // a notice stays until its tell ended: one the engine dropped after the submit (lost,
        // lateDrop) goes out once more
        book.pending = book.pending.filter(n => {
          const e = live.ledger.find(x => x.key === noticeTell(n).key)
          return e === undefined || e.status === 'running' || e.status === 'lost'
        })
      }
      if (JSON.stringify(book) !== booked) await keepInStore(keys.notices, book)
    }
  } finally {
    renewal?.cancel()
  }

  // what act mode keeps for the next pass: the queue's known list and the GitHub backoff
  if (act) {
    if (observed.queueKnown !== null) await keepInStore(keys.known, observed.queueKnown)
    if (observed.spend !== null) await keepInStore(keys.spend, observed.spend)
    // an off-pass command that met the limit since the last pass counts as one this pass met
    const limited = report?.rateLimited === true || S.offRateLimited
    S.offRateLimited = false
    const until = Math.max(state.githubBackoffUntil ?? 0, limited ? state.now + GITHUB_BACKOFF_MS : 0)
    if (until > state.now) await keepInStore(keys.backoff, until)
    // the starved spell (S1): it starts on the first starved pass, stands through unknown passes and ends
    // on the first pass that is not starved
    if (result.starved === true && stored?.starvedSince == null) await keepInStore(keys.starved, state.now)
    else if (result.starved === false && stored?.starvedSince != null) await storeDelete($, keys.starved, problems)
    if (snap !== null) await keepSettings(keepInStore, $, keys, snap, before)
    problems.push(...(await githubHealth($, rt.loopDir, rt.repo)))
    await keepTitles(storeIo($), keys.titles, state.github, state.v2?.records ?? [], problems)
  }

  if (act && S.saveProblem !== null) problems.push(`ledger: not saved, so nothing starts until a save succeeds: ${S.saveProblem}`)
  // each skip keeps the time it was first seen while it lasts, for the trace's waits
  S.waits = waitSince(S.waits, result.skipped, state.now)
  const digest = digestOf(state)
  const at = new Date(state.now).toISOString()
  begin(tr, 'log')
  const passMs = Math.round(performance.now() - t0)
  const line = {
    v: 1,
    at,
    pass: S.passNo,
    // pass numbers restart when the module reloads; the load time tells the runs apart
    loaded: new Date(S.loadedAt).toISOString(),
    // what asked for the pass, and its time up to this line (#552)
    trigger,
    ms: passMs,
    mode: rt.mode,
    executed: act,
    device: rt.device,
    // the loop always plans with v2; the field keeps the line's shape for its readers
    planner: 'v2',
    tier: result.tier,
    digest,
    sources: Object.fromEntries(
      [...Object.entries(state.sources), ...Object.entries(state.v2?.sources ?? {}).map(([k, v]) => [`v2.${k}`, v] as const)].map(([k, s]) => [k, s.ok ? 'ok' : `failed${s.error ? `: ${s.error}` : ''}`]),
    ),
    starved: starvedOf(result, state),
    counts: { queue: state.queue.length, ...stateCounts(state.v2?.records ?? []), owner: result.owner },
    actions: result.actions.filter(a => a.kind !== 'title').map(summaryOf),
    transitions: transitionsOf(result),
    skipped: result.skipped.slice(0, 60),
    outcomes: report?.outcomes.filter(o => o.kind !== 'title').map(o => ({ key: o.key, status: o.status, ms: o.ms, summary: o.summary })),
    capped: result.capped.length > 0 ? result.capped : undefined,
    atCap: result.atCap ? true : undefined,
    cap: result.cap === undefined ? undefined : { effective: result.cap.effective, configured: result.cap.configured, ceiling: result.cap.ceiling, memoryBytes: result.cap.memoryBytes, estimateBytes: result.cap.estimateBytes, estimateSource: result.cap.estimateSource },
    rails: railReasons.length > 0 ? railReasons : undefined,
    railTwins: railTwins.length > 0 ? railTwins : undefined,
    ledgerSource: act ? observed.ledgerSource : undefined,
    breaker: breaker === null ? undefined : { since: new Date(breaker.since).toISOString(), until: new Date(breaker.until).toISOString(), passes: breaker.passes },
    told: told.length > 0 ? told : undefined,
    config: rt.configProblems.length > 0 ? rt.configProblems : undefined,
    problems: problems.length > 0 ? problems : undefined,
    commands: [...observed.commands, ...commands],
    title: result.title,
  }
  await append($, `${rt.loopDir}/decisions-${at.slice(0, 10)}.jsonl`, JSON.stringify(line) + '\n')
  // full states for the replay harness, in observe mode only (v2 SPEC 13.4.2 recordStates), a day's worth
  // at most
  const day = at.slice(0, 10)
  if (S.statesToday.day !== day) S.statesToday = { day, count: 0 }
  if (digest !== S.lastDigest && rt.mode !== 'act' && S.statesToday.count < STATES_PER_DAY) {
    const body = JSON.stringify(state)
    if (body.length < STATE_KEEP_BYTES) {
      await $.fs.write(`${rt.loopDir}/states/${day}/${S.passNo}.json`, body)
      S.statesToday.count += 1
    }
    S.lastDigest = digest
  }
  // once a day, the loop dir's files older than the ledger's week go (v2 SPEC 13.11.6)
  if (S.prunedDay !== day) {
    S.prunedDay = day
    for (const argv of pruneArgvs(rt.loopDir, LOOP_FILES_KEEP_DAYS)) await $.process.run(argv, { timeoutMs: 60_000 }).catch(() => undefined)
  }
  await $.state.set(lastPassRef, {
    pass: S.passNo, at: state.now,
    mode: rt.mode, executed: act,
    rails: railReasons,
    tier: result.tier,
    title: result.title,
    actions: line.actions.length,
    owner: result.owner,
    held: S.held === null ? null : { since: S.held.since },
  })
  if (act) settleResumed()
  const ledger = act ? live.ledger : state.ledger
  const offPass = S.offFinished.splice(0)
  if (tr !== null) {
    // ended wakes since the last pass, or since this module loaded: not the ledger's whole week
    const wakes = wakeRows(ledger, delivered, reportedWakes, Math.max(S.prevPassAt, S.loadedAt))
    for (const attempt of wakes.reported) reportedWakes.add(attempt)
    const record = traceRecord({
      tr,
      line: { at, pass: S.passNo, loaded: line.loaded, mode: rt.mode, executed: act, trigger },
      state,
      made: rt.runSource === 'events' ? ['runs', 'pool'] : [],
      outcomes: report?.outcomes ?? [],
      queuedAt,
      wakes: wakes.rows,
      waiting: waitingRows(state, result, ledger, S.waits),
      observe: observeSplit,
      offPass,
    })
    await writeTrace($, rt, record).catch(() => undefined)
  }
  // the wake attempts a ledger let go are forgotten: the hooks time the live ledger's turns
  if (delivered.size > 0) {
    const held = new Set(live.ledger.map(attemptOf))
    for (const attempt of delivered.keys()) if (!held.has(attempt)) delivered.delete(attempt)
  }
  if (reportedWakes.size > 0) {
    const shown = new Set(ledger.map(attemptOf))
    for (const attempt of reportedWakes) if (!shown.has(attempt)) reportedWakes.delete(attempt)
  }
  S.prevPassAt = state.now
  // the title says error until the store takes the ledger again (v2 SPEC 13.10 item 9)
  if (act && S.saveProblem !== null) throw new Error(`ledger: not saved: ${S.saveProblem}`)
  holdsLock(act)
  recordPass(await $.clock.now(), passMs, report?.outcomes.some(o => o.kind !== 'title') ?? false, false, observeSplit, result.tier, result.overridden)
}
