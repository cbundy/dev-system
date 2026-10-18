// The driver's engine calls: the runtime one pass runs with, the IO that observe and the act half
// work through (closures over $, which only the driver modules and register.ts hold), the act lock's
// IO, the decision log's appends, and the kill switch. Part of register.ts's driver (driver-state.ts).
import type { AgentSpawnArgs, EngineInterface } from 'claude-code'

import { gateLimits, jsonObject } from './config'
import { DEFAULT_POOL_SIZE, RUNTIME_KEYS } from './config-keys'
import type { ViewInputs } from './config-view'
import { loopBaseOf, loopDirOf } from './contract.mjs'
import type { FileIo } from './control'
import type { ActIo } from './exec'
import type { Io, Runtime } from './observe'
import { actLockPath, parseLease } from './rails'
import type { LockIo } from './rails'
import { lockTimed } from './trace'
import type { Tracer } from './trace'
import type { Config, Ms } from './types'
import { repoLoaded } from './v2/settings'
import type { SettingsIo } from './v2/settings'
import { v2IoOf } from './v2/store'
import type { V2StoreIo } from './v2/store'
import type { V2Io } from './v2/types'
import { processIdOf, withSlotLine } from './v2/workspace'
import { within } from './within'
import { DEFAULT_TOOLS_DIR, RENAME_TIMEOUT_MS, S, SPAWN_TIMEOUT_MS, STOP_TIMEOUT_MS, SUBMIT_GRACE_MS, live, liveV2, ping, settingsCache } from './driver-state'
import type { AgentRow, Options } from './driver-state'

export async function text($: EngineInterface, path: string): Promise<string | null> {
  try {
    return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : null
  } catch {
    return null
  }
}

export const str = (v: unknown) => (typeof v === 'string' ? v : '')

// configDir: CLAUDE_CONFIG_DIR, else ~/.claude, with no doubled or trailing /: every path the loop
// issues is built on it, and the answer script refuses a path that is not plain.
export async function configDir($: EngineInterface) {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) || '~'}/.claude`
  return dir.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')
}

// runtime: the settings one pass runs with (SPEC 4.1): plugin options, then the workspace
// file ${CLAUDE_CONFIG_DIR}/factory-loop/config.json, then the repo's .claude/factory-loop.json.
// env is every command's base environment: the repo, the configured labels (callum-flow-claim
// and callum-flow-sweep read them), binDir ahead of PATH when the workspace file names one (a
// testbed runs the branch's own CLIs), and the event sink when the mode is not act.
export async function runtime($: EngineInterface): Promise<Runtime & ViewInputs> {
  const dir = await configDir($)
  const base = loopBaseOf(dir)
  const file = jsonObject(await text($, `${base}/config.json`))
  const pick = (key: keyof Options) => (typeof file[key] === 'string' && file[key] !== '' ? file[key] : S.options[key])
  const checkout = str(file.checkout) || S.cwd
  let repo = typeof pick('repo') === 'string' && pick('repo') !== '' ? String(pick('repo')) : ''
  if (repo === '') repo = await originOf($, checkout)
  const requested = pick('mode')
  const mode = requested === 'off' || requested === 'act' ? requested : 'observe'
  const shadow = typeof pick('shadowDevice') === 'string' ? String(pick('shadowDevice')) : ''
  const host = (await $.env.get('DEV_MACHINE_NAME')) || ''
  // the shadow device stands in only while nothing can be executed
  const shadowing = shadow !== '' && mode !== 'act'
  const device = shadowing ? shadow : host
  // where the device came from, for `/factory config`: the workspace file or the plugin option
  // when the shadow stands in, else the machine name's environment variable
  const deviceFrom: ViewInputs['deviceFrom'] = shadowing ? (typeof file.shadowDevice === 'string' && file.shadowDevice !== '' ? 'workspace' : 'plugin') : device === '' ? 'default' : 'env'
  // the repo-local settings, durations and all (SPEC 4.2), then the workspace file's over them.
  // The repo's are origin's default branch's. What either gets wrong is logged.
  const over = Object.fromEntries(Object.entries(file).filter(([key]) => !RUNTIME_KEYS.includes(key)))
  const loaded = await repoLoaded(settingsIo($), settingsCache, checkout, jsonObject(await text($, `${checkout}/.claude/factory-loop.json`)), over)
  const config: Config = { ...loaded.config, mode: mode as Config['mode'] }
  const loopDir = loopDirOf(dir, repo)
  const sink = mode === 'act' ? null : `${loopDir}/sink-events`
  const env: Record<string, string> = {
    CALLUM_FLOW_REPO: repo,
    CALLUM_FLOW_READY_LABEL: config.readyLabel,
    CALLUM_FLOW_IN_DEV_LABEL: config.inDevLabel,
  }
  const binDir = str(file.binDir)
  if (binDir !== '') env.PATH = `${binDir}:${(await $.env.get('PATH')) || '/usr/local/bin:/usr/bin:/bin'}`
  if (sink !== null) env.CALLUM_EVENTS_DIR = sink
  return {
    mode,
    repo,
    device,
    runSource: pick('runSource') === 'events' ? 'events' : 'local',
    poolSize: typeof file.poolSize === 'number' ? file.poolSize : DEFAULT_POOL_SIZE,
    cwd: checkout,
    loopDir,
    workspace: { session: await $.session.id(), process: processIdOf(await text($, '/proc/self/stat')) },
    sink,
    env,
    toolsDir: str(file.toolsDir) || DEFAULT_TOOLS_DIR,
    // where the answer script lives (#561): the plugin's own directory, wherever it was loaded from
    pluginRoot: $.plugin.root,
    config,
    ...(await gateLimits(argv => $.process.run(argv, { timeoutMs: 15_000 }), loaded.config)),
    configProblems: loaded.problems,
    repoSettings: loaded.raw,
    workspaceRaw: file,
    deviceFrom,
    pluginVersion: str(jsonObject(await text($, `${$.plugin.root}/.claude-plugin/plugin.json`)).version) || 'unknown',
  }
}

// settingsIo and v2StoreIo: what v2/settings.ts and v2/store.ts run on.
export function settingsIo($: EngineInterface): SettingsIo {
  return { run: (argv, opts) => $.process.run(argv, opts), now: () => $.clock.now() }
}

export function v2StoreIo($: EngineInterface): V2StoreIo {
  return { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value), now: () => $.clock.now() }
}

// originOf: the GitHub repo (owner/name) the checkout's origin names, or '' when it names none.
export async function originOf($: EngineInterface, checkout: string, env?: Record<string, string>): Promise<string> {
  try {
    const r = await $.process.run(['git', 'remote', 'get-url', 'origin'], env === undefined ? { cwd: checkout, timeoutMs: 10_000 } : { cwd: checkout, env, timeoutMs: 10_000 })
    return r.exitCode === 0 ? (r.stdout.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/)?.[1] ?? '') : ''
  } catch {
    return ''
  }
}

// observing: the runtime of a pass that executes nothing: its events go to the sink (SPEC 11.1).
export function observing(rt: Runtime): Runtime {
  const sink = `${rt.loopDir}/sink-events`
  return { ...rt, sink, env: { ...rt.env, CALLUM_EVENTS_DIR: sink } }
}

// acting: the runtime for work the loop did start in act mode (an agent's answer, a wake's
// turn, a notice): its events are real ones.
export function acting(rt: Runtime): Runtime {
  const { CALLUM_EVENTS_DIR: _sink, ...env } = rt.env
  return { ...rt, sink: null, env }
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// io: the engine calls observe makes, as closures over $ (the validator keeps $ in this file).
// The agent list is read once per pass, before observe (listAgents).
export function io($: EngineInterface, agents: AgentRow[]): Io {
  return {
    now: () => $.clock.now(),
    run: (argv, init) => $.process.run(argv, init),
    readFile: path => text($, path),
    sessionLimits: async () => (await $.session.usage()).rateLimits,
    agents: async () => agents,
  }
}

// actIo: the engine calls the act half makes (exec.ts ActIo).
export function actIo($: EngineInterface): ActIo {
  return {
    now: () => $.clock.now(),
    run: (argv, init) => $.process.run(argv, init),
    spawnAgent: async input => {
      // an agent step starts in its slot: the companion reads the slot line (v2 SPEC 10.3)
      const args: AgentSpawnArgs = { subagentType: input.subagentType, prompt: withSlotLine(input.prompt, input.cwd), description: input.description }
      if (input.cwd !== undefined) args.cwd = input.cwd
      if (input.name !== undefined) args.name = input.name
      if (input.model !== undefined) args.model = input.model
      const r = await within($, SPAWN_TIMEOUT_MS, $.agent.spawn(args), 'agent spawn')
      if (r.deny !== undefined) return { deny: r.deny }
      return r.agentId === undefined ? {} : { agentId: r.agentId }
    },
    stopAgent: async agentId => {
      const r = await within($, STOP_TIMEOUT_MS, $.tool.call({ tool: 'TaskStop', task_id: agentId }), 'TaskStop')
      if (r.deny !== undefined) return { stopped: false, error: r.deny }
      if (r.isError === true) return { stopped: false, error: r.text ?? 'TaskStop reported an error' }
      return { stopped: true }
    },
    submit: async prompt => {
      const settled = $.prompt.submit({ text: prompt }).then(
        r => (r.drop === undefined ? null : `dropped: ${r.drop}`),
        err => `refused: ${message(err)}`,
      )
      const early = await within($, SUBMIT_GRACE_MS, settled, 'submit').catch(() => 'queued')
      if (early === 'queued') {
        void settled.then(why => (why === null ? undefined : S.lateDrop?.(prompt, why)))
        return
      }
      if (early !== null) throw new Error(`the prompt was ${early}`)
    },
    rename: async title => {
      await within($, RENAME_TIMEOUT_MS, $.command.run({ command: 'rename', args: title }), 'rename')
    },
    usage: async () => {
      const limits = (await $.session.usage()).rateLimits
      const pct = (kind: string) => limits.find(l => l.kind === kind)?.percentUsed ?? null
      return { fiveHour: pct('five_hour'), sevenDay: pct('seven_day') }
    },
    readFile: path => text($, path),
    writeFile: (path, body) => $.fs.write(path, body),
    v2: v2Io($),
  }
}

// v2Io: the live records for the transition executor, stored after every ledger save queued
// before them (v2/store.ts), the driver's ping and the live ledger (v2 SPEC 3.3, 4.6).
export function v2Io($: EngineInterface): V2Io {
  return v2IoOf(liveV2, v2StoreIo($), { ready: () => live.loaded && S.lastRt !== null, write: save => afterSaves($, S.lastRt, save), ping: why => ping(why), ledger: () => live.ledger })
}

export function fileIo($: EngineInterface): FileIo {
  return { readFile: path => text($, path), writeFile: (path, body) => $.fs.write(path, body) }
}

// lockIo: the act lock's reads and its one compare-and-set command (rails.ts LOCK_CAS_SCRIPT),
// timed when a traced pass writes it.
export function lockIo($: EngineInterface, tr: Tracer | null = null): LockIo {
  return {
    readFile: path => text($, path),
    cmd: (argv, init) =>
      lockTimed(tr, () => $.process.run(argv, init.stdin === undefined ? { timeoutMs: init.timeoutMs } : { stdin: init.stdin, timeoutMs: init.timeoutMs })),
  }
}

// lockOp: one write of the act lock at a time from this module (a pass's renewals, session.end).
export function lockOp<T>(work: () => Promise<T>): Promise<T> {
  const run = S.locking.then(work)
  S.locking = run.catch(() => undefined)
  return run
}

export async function append($: EngineInterface, path: string, line: string) {
  await $.process.run(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', path], { stdin: line, timeoutMs: 10_000 })
}

// appendLine: one more decision-log line, beside the pass lines: an owner op, a turn's
// problems, a pass that threw (SPEC 12).
export async function appendLine($: EngineInterface, rt: Runtime, line: Record<string, unknown>) {
  const at = new Date(await $.clock.now()).toISOString()
  await append($, `${rt.loopDir}/decisions-${at.slice(0, 10)}.jsonl`, JSON.stringify({ v: 1, at, ...line }) + '\n').catch(() => undefined)
}

// offTitle: the title while the loop is off (mode off or the kill switch).
export function offTitle(rt: Runtime): string {
  return `🔄 ${rt.repo.split('/')[1] ?? 'loop'} · off`
}

export async function setTitle($: EngineInterface, title: string) { // every rename, the driver's own included, starts the throttle window
  if (title === S.lastTitle) return
  await $.command.run({ command: 'rename', args: title })
  S.lastTitle = title
  S.lastTitleAt = await $.clock.now()
}

// wakeIdAt: a fresh wake id, from the clock so it stays unique across restarts (SPEC 8.1).
export function wakeIdAt(now: Ms): string {
  S.lastWakeAt = Math.max(now, S.lastWakeAt + 1)
  return `w${S.lastWakeAt.toString(36)}`
}

// mayWrite: the ledger in memory is still the store's truth: the act lock names this session, or
// stands as it did at the load (a session the rails keep in observe, sending a notice). A lease
// another session wrote since, live or expired, means that session kept the ledger meanwhile: this
// one never writes over it, and reloads the store before it acts again.
export async function mayWrite($: EngineInterface, rt: Runtime): Promise<boolean> {
  try {
    const now = await text($, actLockPath(rt.loopDir))
    return parseLease(now)?.session === (await $.session.id()) || now === live.basis
  } catch {
    return false
  }
}

// afterSaves: a store write queued after every save before it, run only while this session may
// still write the store (mayWrite); whether it ran without error.
export function afterSaves($: EngineInterface, rt: Runtime | null, write: () => Promise<void>): Promise<boolean> {
  const run = S.saving.then(async (): Promise<boolean> => {
    if (rt === null || !(await mayWrite($, rt))) return false
    await write()
    return true
  })
  S.saving = run.then(
    () => undefined,
    () => undefined,
  )
  return run.catch(() => false)
}

// killed: the kill switch exists (SPEC 11.3).
export async function killed($: EngineInterface): Promise<boolean> {
  return $.fs.exists(`${await configDir($)}/factory-loop/OFF`)
}
