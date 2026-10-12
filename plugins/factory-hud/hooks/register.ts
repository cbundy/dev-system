// factory-hud: the session readout as a mod, so it draws wherever the session does
// (terminal, desktop, VS Code, mobile through Remote Control). It only ever draws: the
// status entry and the toasts never reach the conversation, and no model is called.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { counts, dueAlerts, repoSlug, statusText, versionsText } from './format'
import type { Readout } from './format'

// Hidden in this conversation (/hud): kept across a reload, not into a new conversation.
const isHidden = atom({ plugin: 'factory-hud', key: 'isHidden' } as const, false)
// The toasts already shown in this conversation, so each shows once.
const alerted = atom({ plugin: 'factory-hud', key: 'alerted' } as const, [] as string[])

const CLOCK_EVERY_MS = 30_000
const FACTORY_EVERY_MS = 60_000

type Hud = Readout & { repo?: string; zone?: string }

// The module's own state; a reload starts it over and session.start fills it again.
const hud: Hud = { limits: [], isFactoryShown: false, isFactoryLoading: false, versions: '' }

async function draw($: EngineInterface) {
  if (await read($, isHidden)) {
    $.ui.status(undefined)
    return
  }
  $.ui.status(statusText(hud, await $.clock.now(), hud.zone))
}

async function alert($: EngineInterface) {
  const due = dueAlerts(hud.context, hud.limits, await read($, alerted))
  if (due.length === 0) return
  await update($, alerted, shown => [...shown, ...due.map(([key]) => key)])
  for (const [, text] of due) $.ui.toast(text, { timeoutMs: 8000 })
}

// output: a command's stdout, or undefined when it cannot run or fails.
async function output($: EngineInterface, argv: string[], cwd: string) {
  try {
    const { exitCode, stdout } = await $.process.run(argv, { cwd, timeoutMs: 30_000 })
    return exitCode === 0 ? stdout : undefined
  } catch {
    return undefined
  }
}

async function refreshFactory($: EngineInterface, cwd: string) {
  if (!hud.repo) return
  const json = await output(
    $,
    ['callum-flow-factory-state', '--repo', hud.repo, '--github', 'off', '--format', 'json'],
    cwd,
  )
  // A failed read keeps the last counts, which then show their age.
  const next = json === undefined ? undefined : counts(json, await $.clock.now())
  if (next) hud.factory = next
  hud.isFactoryLoading = false
  await draw($)
}

async function snapshot($: EngineInterface) {
  try {
    return await $.fs.read((await $.env.get('DEV_VERSIONS_FILE')) || '/tmp/dev-versions.json')
  } catch {
    return undefined
  }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hud',
      description: 'Hide or show the factory HUD in this conversation',
    })
    const role = await $.env.get('DEV_ROLE')
    // A new session starts from nothing: no counts or repo carried over from the last.
    hud.factory = undefined
    hud.repo = undefined
    hud.isFactoryLoading = false
    hud.isFactoryShown = options.factory === 'on' || (options.factory !== 'off' && role === 'orchestrator')
    hud.zone = (await $.env.get('TZ')) || undefined
    const usage = await $.session.usage()
    hud.context = usage.context
    hud.limits = usage.rateLimits
    hud.versions = versionsText((await $.session.version()).version, await snapshot($))
    if (hud.isFactoryShown) {
      const url = await output($, ['git', 'remote', 'get-url', 'origin'], e.cwd)
      hud.repo = url === undefined ? undefined : repoSlug(url)
      hud.isFactoryLoading = hud.repo !== undefined
    }
    await draw($)
    // Background work: a failure (the session ending under it) is dropped, never surfaced.
    $.clock.every(CLOCK_EVERY_MS, () => draw($).catch(() => undefined))
    if (hud.isFactoryShown && hud.repo) {
      void refreshFactory($, e.cwd).catch(() => undefined)
      $.clock.every(FACTORY_EVERY_MS, () => refreshFactory($, e.cwd).catch(() => undefined))
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    hud.context = e.context
    hud.limits = e.rateLimits
    await draw($)
    await alert($)

    return next(e)
  })

  // A /clear or /resume moves to another conversation in the same process, with no
  // session.start: the last one's context figure, toasts and /hud do not carry over.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      hud.context = undefined
      await update($, isHidden, () => false)
      await update($, alerted, () => [])
      await draw($)
    }

    return next(e)
  })

  // Answered with a toast, not command output, so nothing is added to the conversation.
  on('command.run', { command: 'hud' }, async $ => {
    const isNowHidden = await update($, isHidden, was => !was)
    await draw($)
    $.ui.toast(isNowHidden ? 'HUD hidden in this conversation' : 'HUD shown')

    return {}
  })
}
