// factory-loop-workspace: the factory loop's companion plugin (docs/factory-loop/v2/SPEC.md 10.3 to
// 10.6, 10.9). The engine never runs a plugin's hooks for what that plugin's own code started, and
// the loop starts its agents from its timer, so its own hooks never see them (SPIKES.md). This
// second plugin's hooks do, and carry what the loop needs around each agent it starts:
//
// - the folder (10.3): a spawn whose prompt opens with `factory-slot: <path>` is started in that
//   slot, once the slot's step marker matches the spawn; a missing or mismatched marker refuses it;
// - the map: the agent's id, and its children's, to its slot and marker, kept in $.state;
// - the write guard (10.4): file writes and commands the agent's role may not make are refused,
//   each refusal appended to <loop dir>/companion.jsonl, which the loop logs as an intervention;
// - the timeout (10.5): a Bash call with no timeout gets 10 minutes;
// - the stop gate (10.6): a writer may not finish while the repo's gate commands fail; a gate that
//   cannot run lets it finish, logged as gate-unknown; each result goes to factory-gate.json;
// - the handshake (10.9): <CLAUDE_CONFIG_DIR>/factory-loop/workspace/<session>.json says this
//   session has the companion, written again every minute; the loop holds every agent step while
//   its own is missing or stale.
//
// It acts only on spawns that carry the slot line, so the loop's v1 agents and every other agent
// pass untouched.
import type { EngineInterface, Register } from 'claude-code'
import type { WorkspaceAgent } from '../types'
import { blockText, gateRecord, oneLine, runGates } from './gate'
import type { Ran } from './gate'
import { FILE_TOOLS, agentRefusal, bashRefusal, fileRefusal, needsHead, normalize, within } from './guard'
import type { Guarded, Refusal } from './guard'
import { MARKER_FILE, mismatch, parseMarker, slotLine } from './marker'

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

// handshake: this session's file, written whole with the time now.
async function handshake($: EngineInterface): Promise<void> {
  const session = await $.session.id()
  const now = await $.clock.now()
  const path = handshakePath(await configDir($), session)
  const manifest = await readText($, `${$.plugin.root}/.claude-plugin/plugin.json`)
  let version = 'unknown'
  try {
    const v = (JSON.parse(manifest ?? '{}') as { version?: unknown }).version
    if (typeof v === 'string') version = v
  } catch {
    // the version is for people reading the file; the loop reads the session
  }
  await writeFile($, path, `${JSON.stringify({ v: 1, session, version, at: new Date(now).toISOString() })}\n`)
}

let beat: { cancel: () => void } | null = null

// beating: the handshake now and again every minute, so its `at` stays fresh, a /clear's new
// session gets its own file, and a pruned or deleted one comes back.
async function beating($: EngineInterface): Promise<void> {
  beat?.cancel()
  beat = $.clock.every(HANDSHAKE_EVERY_MS, () => void handshake($).catch(() => undefined))
  await handshake($).catch(() => undefined)
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
async function logLine($: EngineInterface, a: WorkspaceAgent, cause: string, reason: string): Promise<void> {
  const line = { at: new Date(await $.clock.now()).toISOString(), issue: a.issue, life: a.life, seq: a.seq, cause, reason: oneLine(reason, 500) }
  await appendFile($, `${a.loopDir}/companion.jsonl`, `${JSON.stringify(line)}\n`).catch(() => undefined)
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
        if (r.agentId !== undefined) await keep($, r.agentId, parent)
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
      await keep($, r.agentId, { ...fields, root: r.agentId, slot, real: place.real, roots: place.roots, gitDir: place.gitDir })
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
    if (e.tool === 'Bash' && e.timeout === undefined && e.run_in_background !== true) return next({ ...e, timeout: BASH_TIMEOUT_MS })
    return next(e)
  }).catch(($, e, next) => (next.called || e.agentId === undefined ? next(e) : { deny: `${ME}: its guard failed, so the call is refused` }))

  on('classic.SubagentStop', async ($, e, next) => {
    const a = await agentOf($, e.agent_id)
    if (a === null || a.root !== e.agent_id || a.role !== 'writer' || a.gateCommands.length === 0) return next(e)
    const result = await runGates({ run: (command, budgetMs) => runIn($, a.slot, command, budgetMs), now: () => $.clock.now() }, a.gateCommands, a.gateTimeoutMs)
    const record = gateRecord(result, await headSha($, a.slot), await $.clock.now(), a.gateCommands)
    await writeFile($, `${a.gitDir}/factory-gate.json`, `${JSON.stringify(record, null, 2)}\n`).catch(() => undefined)
    if (result.result === 'fail') return { block: blockText(result, a.slot, a.gateCommands) }
    if (result.result === 'unknown') await logLine($, a, 'gate-unknown', `the stop gate could not run: ${result.why}`)
    return next(e)
  }).catch(async ($, e, next) => {
    // a gate that could not run is never passed silently
    try {
      const a = await agentOf($, e.agent_id)
      if (a !== null && a.root === e.agent_id && a.role === 'writer' && a.gateCommands.length > 0) await logLine($, a, 'gate-unknown', 'the stop gate hook failed')
    } catch {
      // nothing more can be said
    }
    return next(e)
  })
}
