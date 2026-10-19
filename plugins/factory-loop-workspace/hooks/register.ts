// factory-loop-workspace: the factory loop's companion plugin (docs/factory-loop/v2/SPEC.md 10.3 to
// 10.6, 10.9). The engine never runs a plugin's hooks for what that plugin's own code started, and
// the loop starts its agents from its timer, so its own hooks never see them (docs/spikes/factory-loop-workspace/README.md). This
// second plugin's hooks do, and carry what the loop needs around each agent it starts:
//
// - the folder (10.3): a spawn whose prompt opens with `factory-slot: <path>` is started in that
//   slot, once the slot's step marker matches the spawn; a missing or mismatched marker refuses it;
// - the map: the agent's id, and its children's, to its slot and marker, kept in $.state;
// - the write guard (10.4): file writes and commands the agent's role may not make are refused,
//   each refusal appended to <loop dir>/companion.jsonl, which the loop logs as an intervention;
// - the timeout (10.5): a Bash call with no timeout gets 10 minutes;
// - the stop gate (10.6): a writer may not finish while the repo's gate commands fail; a gate that
//   cannot run lets it finish, logged as gate-unknown; every run is a line of companion.jsonl, the
//   last also in factory-gate.json; a `gate-start` line says a gate began, and the session that holds the
//   loop's act lock runs again, once per loop dir, a gate whose process is gone before it settled
//   (a restart cut it), as `gate-rerun` and a settling line with `rerun: true`, or gives it up as `gate-cut`;
// - prompts nobody answers (10.10): a call of a mapped agent that Claude Code would put to a person
//   (tool.check answered `ask`) is denied instead, with a reason that tells the agent to find another
//   way, and written as a native `prompt_denied` event and a `prompt-denied` line of companion.jsonl; a
//   permission_prompt notification of a mapped agent is a native `prompt_waiting` event. A caller that is
//   not in the map (the owner's own session) is never touched;
// - the handshake (10.9): <CLAUDE_CONFIG_DIR>/factory-loop/workspace/<session>.json says this
//   session has the companion, and in which process, written again every minute; the loop holds
//   every agent step while its own is missing, from another process or stale.
//
// It acts only on spawns that carry the slot line, so the loop's v1 agents and every other agent
// pass untouched.
import type { EngineInterface, Register } from 'claude-code'
import type { WorkspaceAgent } from '../types'
import { blockText, gateLine, gateRecord, oneLine, runGates, waitedOut } from './gate'
import type { GateResult, Ran } from './gate'
import { bootMs, gateEntries, isDead, judge, leaseHeld, openGates, pidOf, startMs } from './recover'
import { recordWindow } from './window'
import { FILE_TOOLS, agentRefusal, backgroundRefusal, bashRefusal, fileRefusal, needsHead, normalize, within } from './guard'
import type { Guarded, Refusal } from './guard'
import { MARKER_FILE, mismatch, nameParts, parseMarker, slotLine } from './marker'
import { PROMPT_NOTIFICATIONS, inputOf, promptData, promptReason, transcriptOf, whyOf } from './prompt'
import type { Decided, PromptFields } from './prompt'
import { withScratch } from './scratch'
import { createTurns } from './turns'
import type { Turn } from './turns'

const ME = 'factory-loop-workspace'
const AGENTS = { plugin: 'factory-loop-workspace', key: 'agents' } as const
export const BASH_TIMEOUT_MS = 600_000
// the most a single $.process.run may take
const RUN_MAX_MS = 600_000
const QUICK_MS = 15_000
// the handshake is written again this often: its `at` shows the companion runs now, and the loop
// takes a handshake a few beats old as missing (factory-loop hooks/v2/sources-workspace.ts)
export const HANDSHAKE_EVERY_MS = 60_000
const HANDSHAKE_PRUNE_DAYS = 7
// the longest a finished writer waits for its gate's turn when its marker does not say (config.ts
// gateWaitTimeoutMs)
const GATE_WAIT_TIMEOUT_MS = 30 * 60_000
// a queued gate always has a host call in flight, a sleep of this many seconds started again as each
// ends: the engine gives a hook handler 10 s of budget, which host calls pause and clock ops do not
const IDLE_S = 5
// the stop gates' turns, one set for the whole process: every slot's writer shares it
const turns = createTurns()

// invocations the .catch has seen fail, by event: a handler the engine cut off still gets its turn later
const cut = new WeakSet<object>()
// cutOff: the engine's budget for this handler ran out (its signal aborted or no budget left), or the catch marked it
function cutOff(e: object, next: unknown): boolean {
  const n = next as { signal?: { aborted?: boolean }; budget?: { remainingMs?: number } } | undefined
  return cut.has(e) || n?.signal?.aborted === true || n?.budget?.remainingMs === 0
}

// the catch's reason: the error's one line when one reached it
function failedReason(err: unknown): string {
  const m = typeof err === 'string' ? err : (err as { message?: unknown } | null | undefined)?.message
  let text = typeof m === 'string' ? m : ''
  if (text === '' && err !== undefined && err !== null) {
    try {
      text = JSON.stringify(err) ?? ''
    } catch {
      text = ''
    }
  }
  return text === '' ? 'the stop gate hook failed' : `the stop gate hook failed (${oneLine(text)})`
}

// --- small helpers over $ ---------------------------------------------------------------------------

async function run($: EngineInterface, argv: string[], opts: { cwd?: string; stdin?: string; timeoutMs?: number } = {}) {
  return $.process.run(argv, { timeoutMs: QUICK_MS, ...opts })
}

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

// writeFile: written whole by rename, its folder made first.
async function writeFile($: EngineInterface, path: string, text: string): Promise<void> {
  const r = await run($, ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1.tmp.$$" && mv -f "$1.tmp.$$" "$1"', 'sh', path], { stdin: text })
  if (r.exitCode !== 0) throw new Error(`${path}: ${oneLine(r.stderr)}`)
}

async function appendFile($: EngineInterface, path: string, text: string): Promise<void> {
  const r = await run($, ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', path], { stdin: text })
  if (r.exitCode !== 0) throw new Error(`${path}: ${oneLine(r.stderr)}`)
}

// configDir: CLAUDE_CONFIG_DIR, else ~/.claude, as the loop builds its own paths.
async function configDir($: EngineInterface): Promise<string> {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) || '~'}/.claude`
  return dir.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')
}

// --- the handshake (10.9) ---------------------------------------------------------------------------

// handshakePath: one file per session, so two sessions with the companion never write one file.
export function handshakePath(configDir: string, session: string): string {
  return `${configDir}/factory-loop/workspace/${session.replace(/[^A-Za-z0-9._-]/g, '_')}.json`
}

// processIdOf: the process that /proc/<pid>/stat describes, by its pid and start time, which no
// other process has: not a child, which has its own, and not a later one given the same pid. Its
// field 22 is counted after the command name, which may hold spaces. undefined: no stat to read.
export function processIdOf(stat: string | null): string | undefined {
  const pid = stat?.split(' ', 1)[0] ?? ''
  const start = stat?.slice(stat.lastIndexOf(') ') + 2).split(' ')[19] ?? ''
  return /^\d+$/.test(pid) && /^\d+$/.test(start) ? `${pid}:${start}` : undefined
}

// handshake: this session's file, written whole with this process's id and the time now (no id:
// null, which the loop never takes).
async function handshake($: EngineInterface): Promise<void> {
  const session = await $.session.id()
  // this process, as the loop, a plugin of the same process, reads it too
  const proc = processIdOf(await readText($, '/proc/self/stat')) ?? null
  const now = await $.clock.now()
  const path = handshakePath(await configDir($), session)
  const manifest = await readText($, `${$.plugin.root}/.claude-plugin/plugin.json`)
  let version = 'unknown'
  try {
    const v = (JSON.parse(manifest ?? '{}') as { version?: unknown }).version
    if (typeof v === 'string') version = v
  } catch {
    // the version is for people reading the file; the loop reads the rest
  }
  await writeFile($, path, `${JSON.stringify({ v: 1, session, process: proc, version, at: new Date(now).toISOString() })}\n`)
}

// beatOnce: the handshake, and the window beside it, each caught on its own.
async function beatOnce($: EngineInterface): Promise<void> {
  await Promise.all([handshake($).catch(() => undefined), recordWindow($).catch(() => undefined)])
}

let beat: { cancel: () => void } | null = null

// beating: the handshake now and again every minute, so its `at` stays fresh, a /clear's new
// session gets its own file, and a pruned or deleted one comes back.
async function beating($: EngineInterface): Promise<void> {
  beat?.cancel()
  // the recovery runs from the clock's callback, never inside a hook handler, so its gate is not
  // cut by a handler's budget
  beat = $.clock.every(HANDSHAKE_EVERY_MS, () => {
    void beatOnce($)
    void recoverGates($).catch(() => undefined)
  })
  await beatOnce($)
}

async function pruneHandshakes($: EngineInterface): Promise<void> {
  const dir = `${await configDir($)}/factory-loop/workspace`
  await run($, ['find', dir, '-maxdepth', '1', '-name', '*.json', '-mtime', `+${HANDSHAKE_PRUNE_DAYS}`, '-delete'])
}

// --- the map ----------------------------------------------------------------------------------------

async function agentOf($: EngineInterface, agentId: string): Promise<WorkspaceAgent | null> {
  const { value } = await $.state.get({ ...AGENTS, id: agentId })
  return value ?? null
}

async function keep($: EngineInterface, agentId: string, agent: WorkspaceAgent): Promise<void> {
  await $.state.set({ ...AGENTS, id: agentId }, agent)
}

// --- the slot (10.3) --------------------------------------------------------------------------------

// placeOf: the slot's git dir, real path and repository roots, or why it is no slot.
async function placeOf($: EngineInterface, slot: string): Promise<{ gitDir: string; real: string; roots: string[] } | { deny: string }> {
  let real: string
  try {
    const st = await $.fs.stat(slot, { resolve: true })
    if (st.kind !== 'dir') return { deny: `${slot} is not a folder` }
    real = st.realPath ?? slot
  } catch {
    return { deny: `${slot} does not exist` }
  }
  const r = await run($, ['git', '-C', slot, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'])
  const [top, gitDir, common] = r.stdout.trim().split('\n')
  if (r.exitCode !== 0 || gitDir === undefined || common === undefined) return { deny: `${slot} is not a git checkout: ${oneLine(r.stderr)}` }
  if (top !== real && top !== slot) return { deny: `${slot} is not the top of its checkout (${top})` }
  const roots = [...new Set([slot, real, ...(common.endsWith('/.git') ? [common.slice(0, -'/.git'.length)] : [])])]
  return { gitDir, real, roots }
}

// --- the guard (10.4) -------------------------------------------------------------------------------

function guardedOf(a: WorkspaceAgent): Guarded {
  return { slot: a.slot, role: a.role, branch: a.branch, roots: a.roots }
}

// placed: a path's real location, symlinks resolved through its nearest existing folder; null when
// none can be read.
async function placed($: EngineInterface, path: string): Promise<string | null> {
  let rest = ''
  let at = path
  for (let i = 0; i < 64 && at !== ''; i++) {
    const st = await $.fs.stat(at, { resolve: true }).catch(() => null)
    if (st !== null && st.realPath !== undefined) return normalize(`${st.realPath}${rest}`, '/')
    const cut = at.lastIndexOf('/')
    rest = `${at.slice(cut)}${rest}`
    at = at.slice(0, cut)
  }
  return null
}

async function headBranch($: EngineInterface, slot: string): Promise<string | null> {
  const r = await run($, ['git', '-C', slot, 'symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null)
  return r !== null && r.exitCode === 0 ? r.stdout.trim() : null
}

async function refusalOf($: EngineInterface, a: WorkspaceAgent, e: Record<string, unknown>, tool: string): Promise<Refusal | null> {
  const g = guardedOf(a)
  const background = backgroundRefusal(tool, e)
  if (background !== null) return background
  if (tool === 'Agent') return agentRefusal(e)
  if ((FILE_TOOLS as readonly string[]).includes(tool)) {
    const raw = typeof e.file_path === 'string' ? e.file_path : typeof e.notebook_path === 'string' ? e.notebook_path : null
    if (raw === null) return null
    const path = normalize(raw, a.slot)
    const lexical = fileRefusal(g, path)
    if (lexical !== null) return lexical
    // a symlink must not carry a write out of the slot, or into the repository for a reader
    const real = await placed($, path)
    if (real === null || real === path) return null
    const refused = fileRefusal({ ...g, slot: within(path, a.slot) ? a.real : g.slot }, real)
    return refused === null ? null : { ...refused, reason: `${raw} resolves to ${real}: ${refused.reason}` }
  }
  if (tool === 'Bash' && typeof e.command === 'string') {
    const head = needsHead(e.command) ? await headBranch($, a.slot) : null
    return bashRefusal(g, e.command, head)
  }
  return null
}

// logLine: one line of the companion's log, which the loop reads (v2/sources-interventions.ts).
async function logLine($: EngineInterface, a: Pick<WorkspaceAgent, 'issue' | 'life' | 'seq' | 'loopDir'>, cause: string, reason: string, fields: Record<string, unknown> = {}): Promise<void> {
  const line = { at: new Date(await $.clock.now()).toISOString(), issue: a.issue, life: a.life, seq: a.seq, cause, reason: oneLine(reason, 500), ...fields }
  await appendFile($, `${a.loopDir}/companion.jsonl`, `${JSON.stringify(line)}\n`).catch(() => undefined)
}

// --- prompts nobody answers (10.10) -----------------------------------------------------------------

// the transcripts SubagentStart reported before the agent was in the map, by agent id (the newest
// 200); the map's own record has it once it is
const transcripts = new Map<string, string>()
const TRANSCRIPTS_KEPT = 200

function transcriptSeen(agentId: string, a: WorkspaceAgent): string | null {
  return a.transcript ?? transcripts.get(agentId) ?? null
}

// eventLine: one native factory event through `callum-flow-event --type`, in the issue's repository.
// A failure (an image that cannot write it, a missing command) is swallowed: the caller has already
// done what it must.
async function eventLine($: EngineInterface, a: WorkspaceAgent, type: 'prompt_denied' | 'prompt_waiting', data: Record<string, unknown>): Promise<void> {
  const argv = ['callum-flow-event', '--type', type, '--data', JSON.stringify(data), '--issue', String(a.issue), '--repo', a.repo]
  await run($, argv, { cwd: a.slot }).catch(() => undefined)
}

// promptFields: the event's facts for this agent; what cannot be read is null.
async function promptFields($: EngineInterface, a: WorkspaceAgent, agentId: string): Promise<PromptFields> {
  const session = await $.session.id().catch(() => null)
  return {
    life: a.life,
    seq: a.seq,
    step: a.step,
    attempt: a.attempt,
    agent: agentId,
    agent_type: a.agentType,
    slot: a.slot,
    session,
    transcript: transcriptSeen(agentId, a),
    branch: a.branch,
    pr: typeof a.pr === 'number' ? a.pr : null,
  }
}

// refusePrompt: the deny for a mapped agent's call that Claude Code answered `ask`, with its event
// and its line. Whatever of those fails, the deny stands.
async function refusePrompt($: EngineInterface, a: WorkspaceAgent, e: { tool: string; input?: unknown; agentId?: string }, decided: Decided): Promise<{ decision: 'deny'; reason: string }> {
  const reason = promptReason(e.tool, e.input, decided)
  try {
    const data = promptData('prompt_denied', { ...(await promptFields($, a, e.agentId ?? '')), tool: e.tool, why: whyOf(decided), input: inputOf(e.tool, e.input) })
    await eventLine($, a, 'prompt_denied', data)
  } catch {
    // the deny is what matters
  }
  await logLine($, a, 'prompt-denied', `${e.tool}: ${reason}`).catch(() => undefined)
  return { decision: 'deny', reason }
}

// --- the stop gate (10.6) ---------------------------------------------------------------------------

async function runIn($: EngineInterface, slot: string, command: string, budgetMs: number): Promise<Ran> {
  try {
    const r = await $.process.run(['sh', '-c', `exec 2>&1\n${command}`], { cwd: slot, timeoutMs: Math.min(budgetMs, RUN_MAX_MS) })
    return { exitCode: r.exitCode, output: r.stdout }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

async function headSha($: EngineInterface, slot: string): Promise<string | null> {
  const r = await run($, ['git', '-C', slot, 'rev-parse', 'HEAD']).catch(() => null)
  return r !== null && r.exitCode === 0 ? r.stdout.trim() : null
}

// slotClean: whether `git status --porcelain` ran and printed nothing (null: it could not run or failed).
async function slotClean($: EngineInterface, slot: string): Promise<boolean | null> {
  const r = await run($, ['git', '-C', slot, 'status', '--porcelain']).catch(() => null)
  return r !== null && r.exitCode === 0 ? r.stdout.trim() === '' : null
}

// What a stop gate needs of an attempt: a writer's agent, or the marker of a slot whose gate a
// restart cut.
type GateTarget = Pick<WorkspaceAgent, 'slot' | 'gitDir' | 'issue' | 'life' | 'seq' | 'gateCommands' | 'gateTimeoutMs' | 'loopDir' | 'gateConcurrency' | 'gateWaitTimeoutMs'>

// runStopGate: the one gate run of a stop (the writer's finish) and of the recovery (a re-run), so the two
// cannot drift: a turn first (10.6; at most gateConcurrency gates run at once in this process, a marker
// with no limit takes none), then the head and tree, the commands, factory-gate.json and the settling
// line (with `rerun: true` for the recovery's). ran: false when `cut` said the engine ended the caller
// while it waited, and no gate ran. A turn always goes back, so a stuck or crashed gate never blocks the others.
async function runStopGate($: EngineInterface, a: GateTarget, startedAt: string, opts: { rerun?: boolean; cut?: () => boolean } = {}): Promise<{ ran: true; result: GateResult } | { ran: false }> {
  const rerun = opts.rerun === true
  const limit = a.gateConcurrency
  let turn: Extract<Turn, { ok: true }> | null = null
  let waitMs = 0
  let queuedBehind = 0
  if (limit !== undefined) {
    const cap = a.gateWaitTimeoutMs ?? GATE_WAIT_TIMEOUT_MS
    const got = await turns.acquire(limit, {
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      maxWaitMs: cap,
      idle: () => run($, ['sleep', String(IDLE_S)], { timeoutMs: IDLE_S * 1000 + QUICK_MS }),
    })
    waitMs = got.waitMs
    queuedBehind = got.queuedBehind
    if (!got.ok) {
      const result = waitedOut(got.waitMs, cap, limit)
      const head = await headSha($, a.slot)
      await writeFile($, `${a.gitDir}/factory-gate.json`, `${JSON.stringify(gateRecord(result, head, await $.clock.now(), a.gateCommands, waitMs), null, 2)}\n`).catch(() => undefined)
      const line = gateLine(result, head, waitMs, limit, startedAt, queuedBehind, null, rerun)
      await logLine($, a, line.cause, line.reason, line.fields)
      return { ran: true, result }
    }
    turn = got
  }
  // the engine cut the caller off while it waited: the loop has moved on, so it runs no gate
  if (opts.cut?.() === true) {
    turn?.release()
    return { ran: false }
  }
  try {
    if (turn !== null && turn.queuedBehind > 0) await logLine($, a, 'gate-wait', `the stop gate waited ${Math.round(waitMs / 1000)} s for a turn`, { waitMs, queuedBehind: turn.queuedBehind, concurrency: limit })
    const headBefore = await headSha($, a.slot)
    const cleanBefore = await slotClean($, a.slot)
    const result = await runGates({ run: (command, budgetMs) => runIn($, a.slot, command, budgetMs), now: () => $.clock.now() }, a.gateCommands, a.gateTimeoutMs)
    const head = await headSha($, a.slot)
    // a head that moved during the run means the tree did too: never clean
    const clean = cleanBefore === null ? null : head !== headBefore ? false : cleanBefore
    const record = gateRecord(result, head, await $.clock.now(), a.gateCommands, waitMs, clean)
    await writeFile($, `${a.gitDir}/factory-gate.json`, `${JSON.stringify(record, null, 2)}\n`).catch(() => undefined)
    const line = gateLine(result, head, waitMs, limit ?? null, startedAt, queuedBehind, clean, rerun)
    await logLine($, a, line.cause, line.reason, line.fields)
    return { ran: true, result }
  } finally {
    turn?.release()
  }
}

// this process, as the handshake names it (undefined: no /proc/self/stat)
async function ownProcess($: EngineInterface): Promise<string | undefined> {
  return processIdOf(await readText($, '/proc/self/stat'))
}

// --- the recovery of a cut gate (10.6) --------------------------------------------------------------

// the loop dirs whose recovery has run in this process, and those being looked at now
const recovered = new Set<string>()
const checking = new Set<string>()

// recoverGates: on a handshake beat, until it has run for each loop dir: the loop dirs of the config dir
// whose act lock this session holds. The owner's own sessions hold none, so they never run it.
async function recoverGates($: EngineInterface): Promise<void> {
  const session = await $.session.id()
  const base = `${await configDir($)}/factory-loop`
  const entries = await $.fs.list(base).catch(() => [])
  for (const ent of entries) {
    if (ent.kind !== 'dir' || ent.name === 'workspace') continue
    const loopDir = `${base}/${ent.name}`
    if (recovered.has(loopDir) || checking.has(loopDir)) continue
    checking.add(loopDir)
    try {
      if (!leaseHeld(await readText($, `${loopDir}/act.lock`), session, await $.clock.now())) continue
      recovered.add(loopDir)
      await recoverDir($, loopDir).catch(() => undefined)
    } finally {
      checking.delete(loopDir)
    }
  }
}

// recoverDir: every gate of the loop dir's log that a restart cut (recover.ts), run again when its slot's
// marker still names the attempt and given up otherwise, each one line (`gate-rerun` or `gate-cut`).
async function recoverDir($: EngineInterface, loopDir: string): Promise<void> {
  const open = openGates(gateEntries(await readText($, `${loopDir}/companion.jsonl`), await $.clock.now()))
  if (open.length === 0) return
  const ownStart = startMs(await readText($, '/proc/self/stat'), bootMs(await readText($, '/proc/stat')))
  for (const g of open) {
    const pid = pidOf(g.process)
    const current = pid === null ? undefined : processIdOf(await readText($, `/proc/${pid}/stat`))
    if (!isDead(g, current, ownStart)) continue
    const marker = g.gitDir !== null && g.gitDir.startsWith('/') ? parseMarker(await readText($, `${g.gitDir}/${MARKER_FILE}`)) : null
    const verdict = judge(g, marker)
    const attempt = { issue: g.issue, life: g.life, seq: g.seq, loopDir }
    const cutAt = g.startedAt ?? new Date(g.at).toISOString()
    const fields = { cutStartedAt: g.startedAt, process: g.process, slot: g.slot, gitDir: g.gitDir, marker: marker === null ? null : { issue: marker.issue, life: marker.life, seq: marker.seq } }
    if (!verdict.rerun || marker === null || g.slot === null || g.gitDir === null) {
      await logLine($, attempt, 'gate-cut', `the stop gate started at ${cutAt} was cut by a restart and is not run again: ${verdict.rerun ? 'its marker did not read' : verdict.why}`, fields)
      continue
    }
    await logLine($, attempt, 'gate-rerun', `the stop gate started at ${cutAt} was cut by a restart; it runs again, with no agent to refuse`, fields)
    const target: GateTarget = { ...attempt, slot: g.slot, gitDir: g.gitDir, gateCommands: marker.gateCommands, gateTimeoutMs: marker.gateTimeoutMs, gateConcurrency: marker.gateConcurrency, gateWaitTimeoutMs: marker.gateWaitTimeoutMs }
    try {
      await runStopGate($, target, new Date(await $.clock.now()).toISOString(), { rerun: true })
    } catch (err) {
      // a gate that could not run is never passed silently
      await logLine($, attempt, 'gate-unknown', failedReason(err), { rerun: true })
    }
  }
}

// --- the hooks --------------------------------------------------------------------------------------

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await beating($)
    await pruneHandshakes($).catch(() => undefined)
    return r
  })

  // session.start does not fire for a plugin a /reload-plugins adds to a running session: the
  // first row or turn after such a load starts the beat instead
  on('session.append', async ($, e, next) => {
    if (beat === null) void beating($).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (beat === null) void beating($).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    // a child of an agent in a slot: the same slot and rules, and its folder is inherited
    if (e.parentAgentId !== undefined) {
      const parent = await agentOf($, e.parentAgentId)
      if (parent !== null) {
        const r = await next(e)
        // its own type; its transcript is its own too, learned when it starts
        const { transcript: _t, ...inherited } = parent
        if (r.agentId !== undefined) await keep($, r.agentId, { ...inherited, agentType: e.subagentType })
        return r
      }
    }
    const slot = slotLine(e.prompt)
    if (slot === null) return next(e)
    const place = await placeOf($, slot)
    if ('deny' in place) return { deny: `${ME}: ${place.deny}` }
    const marker = parseMarker(await readText($, `${place.gitDir}/${MARKER_FILE}`))
    const why = mismatch(marker, e)
    if (why !== null || marker === null) return { deny: `${ME}: ${why ?? 'no marker'}` }
    const r = await next({ ...e, cwd: slot })
    if (r.agentId !== undefined) {
      const { v: _v, ...fields } = marker
      const attempt = nameParts(e.name)?.attempt
      await keep($, r.agentId, { ...fields, root: r.agentId, slot, real: place.real, roots: place.roots, gitDir: place.gitDir, agentType: e.subagentType, ...(attempt === undefined ? {} : { attempt }) })
    }
    return r
  }).catch(($, e, next) => (next.called ? next(e) : slotLine(e.prompt) !== null ? { deny: `${ME}: its spawn hook failed, so the agent was not started outside its slot` } : next(e)))

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const a = await agentOf($, e.agentId)
    if (a === null) return next(e)
    const input = e as unknown as Record<string, unknown>
    const refused = await refusalOf($, a, input, e.tool)
    if (refused !== null) {
      await logLine($, a, refused.cause, `${e.tool}: ${refused.reason}`)
      return { deny: `${ME}: ${refused.reason}` }
    }
    if (e.tool === 'Bash') {
      // the guard judged the agent's own command; what runs has the scratch folder exported first
      const command = a.scratch !== undefined && typeof input.command === 'string' ? withScratch(input.command, a.scratch) : undefined
      if (command !== undefined || e.timeout === undefined) {
        return next({ ...input, ...(command === undefined ? {} : { command }), ...(e.timeout === undefined ? { timeout: BASH_TIMEOUT_MS } : {}) } as unknown as typeof e)
      }
    }
    return next(e)
  }).catch(($, e, next) => (next.called || e.agentId === undefined ? next(e) : { deny: `${ME}: its guard failed, so the call is refused` }))

  // the call Claude Code would ask a person about: a mapped agent has nobody to ask
  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (r.decision !== 'ask' || e.agentId === undefined) return r
    const a = await agentOf($, e.agentId)
    if (a === null) return r
    return refusePrompt($, a, e, r)
  }).catch(async ($, e, next) => {
    // a failure after `ask` came back, for a mapped agent, is still a deny
    const r = await next(e)
    if (r.decision !== 'ask' || e.agentId === undefined) return r
    const a = await agentOf($, e.agentId).catch(() => null)
    return a === null ? r : { decision: 'deny', reason: promptReason(e.tool, e.input, r) }
  })

  // a subagent's transcript is beside the session's: the hook's transcript_path is the session's
  on('classic.SubagentStart', async ($, e, next) => {
    const transcript = transcriptOf((e as { transcript_path?: unknown }).transcript_path, e.agent_id)
    if (transcript !== null) {
      transcripts.delete(e.agent_id)
      transcripts.set(e.agent_id, transcript)
      for (const old of [...transcripts.keys()].slice(0, Math.max(0, transcripts.size - TRANSCRIPTS_KEPT))) transcripts.delete(old)
      const a = await agentOf($, e.agent_id)
      if (a !== null) await keep($, e.agent_id, { ...a, transcript })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // a mapped agent's permission prompt, waiting: written, never answered
  on('classic.Notification', async ($, e, next) => {
    const agentId = (e as { agent_id?: unknown }).agent_id
    if (typeof agentId === 'string' && PROMPT_NOTIFICATIONS.includes(e.notification_type)) {
      const a = await agentOf($, agentId)
      if (a !== null) {
        const data = promptData('prompt_waiting', { ...(await promptFields($, a, agentId)), input: e.message })
        await eventLine($, a, 'prompt_waiting', data)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    cut.delete(e)
    const a = await agentOf($, e.agent_id)
    if (a === null || a.root !== e.agent_id || a.role !== 'writer' || a.gateCommands.length === 0) return next(e)
    // when the gate asked for its turn, before any wait, with or without a limit; the start line
    // is written before it asks, so a restart that cuts the gate leaves a trace of it (recovery)
    const startedAt = new Date(await $.clock.now()).toISOString()
    const started = ownProcess($).then(process => logLine($, a, 'gate-start', 'the stop gate started', { startedAt, slot: a.slot, gitDir: a.gitDir, ...(process === undefined ? {} : { process }) }))
    const out = await runStopGate($, a, startedAt, { cut: () => cutOff(e, next) }).finally(() => started.catch(() => undefined))
    if (out.ran && out.result.result === 'fail') return { block: blockText(out.result, a.slot, a.gateCommands) }
    return next(e)
  }).catch(async ($, e, next) => {
    cut.add(e)
    // the engine hands the catch the error on its next
    const err = (next as unknown as { error?: unknown }).error
    // a gate that could not run is never passed silently
    try {
      const a = await agentOf($, e.agent_id)
      if (a !== null && a.root === e.agent_id && a.role === 'writer' && a.gateCommands.length > 0) await logLine($, a, 'gate-unknown', failedReason(err))
    } catch {
      // nothing more can be said
    }
    return next(e)
  })
}
