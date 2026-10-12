// factory-loop: the issue orchestrator as one code loop (docs/factory-loop/SPEC.md).
//
// This build runs the observe half only: every minute it reads the factory (observe.ts), plans
// (plan.ts), appends one decision-log line, records the state when it changed, and shows the
// status in the session title. It has no executors, so it changes nothing anywhere: in observe
// mode by design, and in act mode too until the act half is built (it says so in the log).
import type { EngineInterface, Register } from 'claude-code'

import { DEFAULT_CONFIG } from './config'
import { emptyCache, observe } from './observe'
import type { Io, Runtime } from './observe'
import { issueFromBranch, plan } from './plan'
import { digestOf } from './state'
import type { Config } from './types'

const PASS_EVERY_MS = 60_000
const FIRST_PASS_AFTER_MS = 5_000
const STATE_KEEP_BYTES = 3_500_000

const lastPassRef = { plugin: 'factory-loop', key: 'lastPass' } as const

let started: Promise<void> | undefined
let loadedAt = 0
let cwd = '.'
let passNo = 0
let running = false
let again = false
let lastTitle: string | null = null
let lastDigest: string | null = null
const cache = emptyCache()

// Options as the manifest's userConfig gives them; the workspace config file overrides them.
type Options = { mode?: unknown; repo?: unknown; shadowDevice?: unknown; runSource?: unknown }
let options: Options = {}

async function text($: EngineInterface, path: string): Promise<string | null> {
  try {
    return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : null
  } catch {
    return null
  }
}

function json(raw: string | null): Record<string, unknown> {
  try {
    const v = raw === null ? {} : JSON.parse(raw)
    return v !== null && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

async function configDir($: EngineInterface) {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) || '~'}/.claude`
}

// runtime: the settings one pass runs with (SPEC 4.1): plugin options, then the workspace
// file ${CLAUDE_CONFIG_DIR}/factory-loop/config.json, then the repo's .claude/factory-loop.json.
async function runtime($: EngineInterface): Promise<Runtime> {
  const base = `${await configDir($)}/factory-loop`
  const file = json(await text($, `${base}/config.json`))
  const pick = (key: keyof Options) => (typeof file[key] === 'string' && file[key] !== '' ? file[key] : options[key])
  const checkout = typeof file.checkout === 'string' && file.checkout !== '' ? file.checkout : cwd
  let repo = typeof pick('repo') === 'string' && pick('repo') !== '' ? String(pick('repo')) : ''
  if (repo === '') {
    const r = await $.process.run(['git', 'remote', 'get-url', 'origin'], { cwd: checkout })
    repo = r.stdout.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/)?.[1] ?? ''
  }
  const requested = pick('mode')
  const mode = requested === 'off' || requested === 'act' ? requested : 'observe'
  const shadow = typeof pick('shadowDevice') === 'string' ? String(pick('shadowDevice')) : ''
  const host = (await $.env.get('DEV_MACHINE_NAME')) || ''
  // the shadow device stands in only while nothing can be executed
  const device = shadow !== '' && mode !== 'act' ? shadow : host
  const repoLocal = json(await text($, `${checkout}/.claude/factory-loop.json`))
  const config: Config = { ...DEFAULT_CONFIG, ...repoLocal, mode } as Config
  const loopDir = `${base}/${repo.replace('/', '__')}`
  return {
    mode,
    repo,
    device,
    runSource: pick('runSource') === 'events' ? 'events' : 'local',
    poolSize: typeof file.poolSize === 'number' ? file.poolSize : 16,
    cwd: checkout,
    loopDir,
    sink: mode === 'act' ? null : `${loopDir}/sink-events`,
    config,
  }
}

// io: the engine calls observe makes, as closures over $ (the validator keeps $ in this file).
function io($: EngineInterface): Io {
  return {
    now: () => $.clock.now(),
    run: (argv, init) => $.process.run(argv, init),
    readFile: path => text($, path),
    sessionLimits: async () => (await $.session.usage()).rateLimits,
    agents: async () => (await $.agent.list()).map(a => ({ id: a.id, type: a.type, status: a.status })),
  }
}

async function append($: EngineInterface, path: string, line: string) {
  await $.process.run(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', path], { stdin: line, timeoutMs: 10_000 })
}

async function setTitle($: EngineInterface, title: string) {
  if (title === lastTitle) return
  await $.command.run({ command: 'rename', args: title })
  lastTitle = title
}

async function pass($: EngineInterface) {
  if (running) {
    again = true
    return
  }
  running = true
  const day = () => new Date().toISOString().slice(0, 10)
  let rt: Runtime | undefined
  try {
    rt = await runtime($)
    const off = rt.mode === 'off' || (await $.fs.exists(`${await configDir($)}/factory-loop/OFF`))
    if (off || rt.repo === '') {
      await setTitle($, `🔄 ${rt.repo.split('/')[1] ?? 'loop'} · off`)
      return
    }
    // A shadow watches another session: this module's own load says nothing about when that
    // session restarted, so the first-pass heartbeat (rule H1) is left to real lease timing.
    const shadowing = rt.device !== ((await $.env.get('DEV_MACHINE_NAME')) || '')
    const observed = await observe(io($), rt, cache, shadowing ? 0 : loadedAt, lastTitle)
    const result = plan(observed.state, rt.config)
    passNo += 1
    const digest = digestOf(observed.state)
    const at = new Date(observed.state.now).toISOString()
    const issues = observed.state.issues
    const line = {
      v: 1,
      at,
      pass: passNo,
      // pass numbers restart when the module reloads; the load time tells the runs apart
      loaded: new Date(loadedAt).toISOString(),
      mode: rt.mode,
      executed: false,
      note: rt.mode === 'act' ? 'act requested, but this build has no executors: nothing was run' : undefined,
      device: rt.device,
      tier: result.tier,
      digest,
      sources: Object.fromEntries(
        Object.entries(observed.state.sources).map(([k, s]) => [k, s.ok ? 'ok' : `failed${s.error ? `: ${s.error}` : ''}`]),
      ),
      counts: {
        queued: observed.state.queue.length,
        dev: issues.filter(i => i.stage === 'designing' || i.stage === 'implementing').length,
        pipeline: issues.filter(i => i.stage === 'in pipeline' || i.stage === 'parked').length,
        merge: issues.filter(i => i.stage === 'ready to merge').length,
        owner: result.owner,
      },
      actions: result.actions
        .filter(a => a.kind !== 'title')
        .map(a => ({
          key: a.key,
          kind: a.kind,
          class: a.class,
          rule: a.rule,
          issue: a.issue,
          agent: a.kind === 'spawn' ? a.agent : undefined,
          run: 'run' in a && typeof a.run === 'string' ? a.run : undefined,
          pr: 'pr' in a && typeof a.pr === 'number' ? a.pr : undefined,
          reason: a.reason,
        })),
      skipped: result.skipped.slice(0, 60),
      commands: observed.commands,
      title: result.title,
    }
    await append($, `${rt.loopDir}/decisions-${at.slice(0, 10)}.jsonl`, JSON.stringify(line) + '\n')
    if (digest !== lastDigest && rt.mode !== 'act') {
      const body = JSON.stringify(observed.state)
      if (body.length < STATE_KEEP_BYTES) await $.fs.write(`${rt.loopDir}/states/${at.slice(0, 10)}/${passNo}.json`, body)
      lastDigest = digest
    }
    await setTitle($, result.title)
    await $.state.set(lastPassRef, {
      pass: passNo,
      at: observed.state.now,
      mode: rt.mode,
      tier: result.tier,
      title: result.title,
      actions: line.actions.length,
      owner: result.owner,
    })
  } catch (err) {
    if (rt !== undefined) {
      const line = JSON.stringify({ v: 1, at: new Date().toISOString(), pass: passNo, error: String(err).slice(0, 500) })
      await append($, `${rt.loopDir}/decisions-${day()}.jsonl`, line + '\n').catch(() => undefined)
    }
  } finally {
    running = false
    if (again) {
      again = false
      void pass($).catch(() => undefined)
    }
  }
}

// ensure: start once per module load, from whichever hook fires first. session.start does not
// fire for a plugin a /reload-plugins adds to a running session (the wake probe saw it).
function ensure($: EngineInterface) {
  started ??= (async () => {
    loadedAt = await $.clock.now()
    $.clock.after(FIRST_PASS_AFTER_MS, () => void pass($).catch(() => undefined))
    $.clock.every(PASS_EVERY_MS, () => void pass($).catch(() => undefined))
  })().catch(() => {
    started = undefined
  })
  return started
}

export const register: Register = (on, opts) => {
  options = opts as Options

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    cwd = e.cwd
    await ensure($)
    return result
  })

  // The note /rename leaves for the model is blanked as it is stored, so a title costs the
  // conversation about 3 tokens (FINDINGS check 3). Any row also starts the loop if needed.
  on('session.append', async ($, e, next) => {
    void ensure($)
    const isRenameNote =
      e.door === 'prompt' && e.origin.kind === 'plugin' && JSON.stringify(e.message.content ?? '').includes('named this session')
    return next(isRenameNote ? { ...e, message: { ...e.message, content: [] } } : e)
  }).catch(($, e, next) => next(e))
}

// for the tests
export const testing = { issueFromBranch }
