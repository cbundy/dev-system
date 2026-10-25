// The what-if cost of a task or tell wake (cbundy/dev-system#1336, v2 SPEC 13.7.4): the main
// session's requests whose time falls in the wake's window, priced at their own models. The window is
// attributed by time from the shared main transcript, so it can include other main-session turns in
// it (a judge wake, for example). Only the transcript's last WAKE_TAIL_BYTES are read, with `tail -c`.
// Reading never throws: a failure is a problem string and a null cost.
import type { RunInit, RunResult } from './exec'
import { locate } from './session-tokens'
import type { SessionSource } from './session-tokens'
import { priceOf } from './v2/prices'
import { turnsOf } from './v2/step-tokens'

type Cmd = (argv: string[], init: RunInit) => Promise<RunResult>

export const WAKE_TAIL_BYTES = 16 * 1024 * 1024
const TIMEOUT_MS = 5_000
const SAFE_ID = /^[A-Za-z0-9_-]+$/

export type WakeCost = { cost: number | null; problem: string | null }

const none = (problem: string): WakeCost => ({ cost: null, problem })

export async function readWakeCost(cmd: Cmd, src: SessionSource, fromMs: number, toMs: number): Promise<WakeCost> {
  try {
    if (src.session === '' || !SAFE_ID.test(src.session)) return none('session transcript not found (no session)')
    const at = await locate(cmd, src)
    if (at === null) return none('session transcript not found')
    const r = await cmd(['tail', '-c', String(WAKE_TAIL_BYTES), at.path], { timeoutMs: TIMEOUT_MS })
    if (r.exitCode !== 0) return none('session transcript unreadable (tail failed)')
    let text = r.stdout
    const cut = at.size > WAKE_TAIL_BYTES
    // a cut tail starts mid-line: drop the partial first line
    if (cut) {
      const nl = text.indexOf('\n')
      text = nl < 0 ? '' : text.slice(nl + 1)
    }
    const turns = [...turnsOf(text).values()]
    if (cut) {
      const times = turns.map(t => t.at).filter((n): n is number => n !== null)
      if (times.length === 0 || Math.min(...times) > fromMs) return none('wake window older than the read tail')
    }
    let cost = 0
    const unpriced = new Set<string>()
    for (const t of turns) {
      if (t.at === null || t.at < fromMs || t.at > toMs) continue
      if (t.model === null && t.input + t.output + t.cacheRead + t.cacheCreation === 0) continue
      const p = priceOf(t.model, t)
      if (p === null) unpriced.add(t.model ?? '(none)')
      else cost += p
    }
    if (unpriced.size > 0) return none(`unpriced model ${[...unpriced].join(', ')}`)
    return { cost: Math.round(cost * 1e6) / 1e6, problem: null }
  } catch (err) {
    return none(`session transcript unreadable: ${err instanceof Error ? err.message : String(err)}`)
  }
}
