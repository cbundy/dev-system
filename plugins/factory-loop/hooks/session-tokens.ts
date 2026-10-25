// The orchestrator's own token counts for the minute summary (cbundy/dev-system#1302, v2 SPEC 13.7.4):
// what the loop's main Claude session spent, read from its own transcript. The transcript of a
// long-running session is large, so only the bytes added since the last read are read (by offset),
// and each requestId is counted once, even when its lines straddle two reads. Step agents keep their
// transcripts under `<session>/subagents/` (v2/step-tokens.ts) and are not counted here. Reading never
// throws: a failure is a problem string and null counts.
import type { RunInit, RunResult } from './exec'
import { byteLength } from './trace'
import { priceOf } from './v2/prices'
import { turnsOf } from './v2/step-tokens'

type Cmd = (argv: string[], init: RunInit) => Promise<RunResult>

export type SessionTokens = { input: number; output: number; cacheRead: number; cacheCreation: number }

export type SessionTokenState = {
  session: string
  path: string
  offset: number
  // the most recent request ids counted, oldest first
  recent: string[]
}

// cost: the what-if cost of the same requests the tokens count (each at its own model's price), null
// when the tokens are null or a counted request's model is unpriced (named in `unpriced`)
export type SessionTokenReading = { tokens: SessionTokens | null; cost: number | null; problem: string | null; unpriced?: string[] }

export type SessionSource = { configDir: string; sessionCwd: string; session: string }

export const CHUNK_BYTES = 4 * 1024 * 1024
export const RECENT_MAX = 2_000
const TIMEOUT_MS = 5_000
const SAFE_ID = /^[A-Za-z0-9_-]+$/

export function newSessionTokenState(): { state: SessionTokenState | null } {
  return { state: null }
}

const none = (problem: string): SessionTokenReading => ({ tokens: null, cost: null, problem })

async function sizeOf(cmd: Cmd, path: string): Promise<number | null> {
  const r = await cmd(['stat', '-c', '%s', path], { timeoutMs: TIMEOUT_MS })
  if (r.exitCode !== 0) return null
  const n = Number(r.stdout.trim())
  return Number.isInteger(n) && n >= 0 ? n : null
}

export async function locate(cmd: Cmd, src: SessionSource): Promise<{ path: string; size: number } | null> {
  const expected = `${src.configDir}/projects/${src.sessionCwd.replace(/[^A-Za-z0-9]/g, '-')}/${src.session}.jsonl`
  const size = await sizeOf(cmd, expected)
  if (size !== null) return { path: expected, size }
  const r = await cmd(['find', `${src.configDir}/projects`, '-maxdepth', '2', '-name', `${src.session}.jsonl`], { timeoutMs: TIMEOUT_MS })
  const found = r.exitCode === 0 ? r.stdout.split('\n').find(l => l.trim() !== '')?.trim() : undefined
  if (found === undefined) return null
  const s = await sizeOf(cmd, found)
  return s === null ? null : { path: found, size: s }
}

// readSessionTokens: the tokens of the requests first found in the transcript since the last read.
// The holder keeps the offset between reads; the first read of a session sets it and reports null.
export async function readSessionTokens(cmd: Cmd, holder: { state: SessionTokenState | null }, src: SessionSource): Promise<SessionTokenReading> {
  try {
    if (src.session === '' || !SAFE_ID.test(src.session)) {
      holder.state = null
      return none('session transcript not found (no session)')
    }
    const prev = holder.state !== null && holder.state.session === src.session ? holder.state : null
    const at = await locate(cmd, src)
    if (at === null) {
      holder.state = null
      return none('session transcript not found')
    }
    if (prev === null || prev.path !== at.path) {
      holder.state = { session: src.session, path: at.path, offset: at.size, recent: [] }
      return none('no baseline')
    }
    if (at.size < prev.offset) {
      holder.state = { ...prev, offset: at.size, recent: [] }
      return none('session transcript shrank')
    }
    if (at.size === prev.offset) return { tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, cost: 0, problem: null }
    const count = Math.min(CHUNK_BYTES, at.size - prev.offset)
    const r = await cmd(['dd', `if=${at.path}`, 'iflag=skip_bytes,count_bytes', `skip=${prev.offset}`, `count=${count}`, 'status=none'], { timeoutMs: TIMEOUT_MS })
    if (r.exitCode !== 0) {
      holder.state = { ...prev, offset: at.size, recent: [] }
      return none('session transcript unreadable (dd failed)')
    }
    const nl = r.stdout.lastIndexOf('\n')
    if (nl < 0) {
      if (count < CHUNK_BYTES) return { tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, cost: 0, problem: null }
      holder.state = { ...prev, offset: at.size, recent: [] }
      return none('session transcript chunk has no newline')
    }
    const consumed = r.stdout.slice(0, nl + 1)
    const seen = new Set(prev.recent)
    const total: SessionTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
    const recent = [...prev.recent]
    let cost = 0
    const unpriced = new Set<string>()
    for (const [id, t] of turnsOf(consumed)) {
      if (!id.startsWith('\0')) {
        if (seen.has(id)) continue
        seen.add(id)
        recent.push(id)
      }
      total.input += t.input
      total.output += t.output
      total.cacheRead += t.cacheRead
      total.cacheCreation += t.cacheCreation
      if (t.model === null && t.input + t.output + t.cacheRead + t.cacheCreation === 0) continue
      const p = priceOf(t.model, t)
      if (p === null) unpriced.add(t.model ?? '(none)')
      else cost += p
    }
    holder.state = { ...prev, offset: prev.offset + byteLength(consumed), recent: recent.slice(-RECENT_MAX) }
    if (unpriced.size > 0) return { tokens: total, cost: null, problem: null, unpriced: [...unpriced] }
    return { tokens: total, cost: Math.round(cost * 1e6) / 1e6, problem: null }
  } catch (err) {
    holder.state = null
    return none(`session transcript unreadable: ${err instanceof Error ? err.message : String(err)}`)
  }
}
