// The orchestrator's own token counts for the minute summary (cbundy/dev-system#1302, v2 SPEC 13.7.4):
// what the loop's main Claude session spent, read from its own transcript. The transcript of a
// long-running session is large, so only the bytes added since the last read are read (by offset),
// and each requestId is counted once, even when its lines straddle two reads. Step agents keep their
// transcripts under `<session>/subagents/` (v2/step-tokens.ts) and are not counted here. Reading never
// throws: a failure is a problem string and null counts.
import type { RunInit, RunResult } from './exec'
import { byteLength } from './trace'
import { priceOf } from './v2/prices'
import type { Turn } from './v2/step-tokens'
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

// cutoffMs: requests at or after it belong to this process; a baseline read counts only those. It starts
// at the process load time (seeded by the caller) and every read moves it to the time of that read.
export type SessionTokenHolder = { state: SessionTokenState | null; cutoffMs: number }

export function newSessionTokenState(cutoffMs = 0): SessionTokenHolder {
  return { state: null, cutoffMs }
}

type Totals = { tokens: SessionTokens; cost: number | null; unpriced: string[] }

function price(turns: Iterable<Turn>): Totals {
  const tokens: SessionTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  let cost = 0
  const unpriced = new Set<string>()
  for (const t of turns) {
    tokens.input += t.input
    tokens.output += t.output
    tokens.cacheRead += t.cacheRead
    tokens.cacheCreation += t.cacheCreation
    if (t.model === null && t.input + t.output + t.cacheRead + t.cacheCreation === 0) continue
    const p = priceOf(t.model, t)
    if (p === null) unpriced.add(t.model ?? '(none)')
    else cost += p
  }
  return { tokens, cost: Math.round(cost * 1e6) / 1e6, unpriced: [...unpriced] }
}

const reading = (t: Totals): SessionTokenReading => (t.unpriced.length > 0 ? { tokens: t.tokens, cost: null, problem: null, unpriced: t.unpriced } : { tokens: t.tokens, cost: t.cost, problem: null })

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
// The holder keeps the offset between reads. The first read of a session (a baseline read) reads the
// transcript's tail window and counts the requests at or after the holder's cutoff, so a new session
// counts everything so far and a resumed one only what came after the loop started. Every read then
// moves the cutoff to `nowMs`, so a later baseline read never counts a request twice.
export async function readSessionTokens(cmd: Cmd, holder: SessionTokenHolder, src: SessionSource, nowMs: number = Date.now()): Promise<SessionTokenReading> {
  const cutoff = holder.cutoffMs
  holder.cutoffMs = nowMs
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
    if (prev === null || prev.path !== at.path) return await baseline(cmd, holder, src, at, cutoff)
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
    const recent = [...prev.recent]
    const fresh: Turn[] = []
    for (const [id, t] of turnsOf(consumed)) {
      if (!id.startsWith('\0')) {
        if (seen.has(id)) continue
        seen.add(id)
        recent.push(id)
      }
      fresh.push(t)
    }
    holder.state = { ...prev, offset: prev.offset + byteLength(consumed), recent: recent.slice(-RECENT_MAX) }
    return reading(price(fresh))
  } catch (err) {
    holder.state = null
    return none(`session transcript unreadable: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// baseline: the first read of a session in this process, or the first after a reset
async function baseline(cmd: Cmd, holder: SessionTokenHolder, src: SessionSource, at: { path: string; size: number }, cutoff: number): Promise<SessionTokenReading> {
  const start = Math.max(0, at.size - CHUNK_BYTES)
  const reset = (offset: number, recent: string[] = []) => void (holder.state = { session: src.session, path: at.path, offset, recent })
  if (at.size === start) {
    reset(at.size)
    return reading(price([]))
  }
  const r = await cmd(['dd', `if=${at.path}`, 'iflag=skip_bytes,count_bytes', `skip=${start}`, `count=${at.size - start}`, 'status=none'], { timeoutMs: TIMEOUT_MS })
  if (r.exitCode !== 0) {
    reset(at.size)
    return none('session transcript unreadable (dd failed)')
  }
  const head = start > 0 ? r.stdout.indexOf('\n') + 1 : 0
  const nl = r.stdout.lastIndexOf('\n')
  if (nl < head || (start > 0 && head === 0)) {
    reset(at.size)
    return start > 0 ? none('session transcript chunk has no newline') : reading(price([]))
  }
  const consumed = r.stdout.slice(head, nl + 1)
  const turns = turnsOf(consumed)
  const recent: string[] = []
  const counted: Turn[] = []
  let first: number | null = null
  for (const [id, t] of turns) {
    if (!id.startsWith('\0')) recent.push(id)
    if (t.at === null) continue
    if (first === null) first = t.at
    if (t.at >= cutoff) counted.push(t)
  }
  // a window start inside a multi-byte character decodes each leading stray byte as one U+FFFD (3 bytes re-encoded): count them as the 1 byte they were
  let stray = 0
  while (stray < head && r.stdout[stray] === '\uFFFD') stray++
  reset(start + byteLength(r.stdout.slice(0, nl + 1)) - 2 * stray, recent.slice(-RECENT_MAX))
  if (start > 0 && first !== null && first >= cutoff) return none(`no baseline: over ${CHUNK_BYTES / 1024 / 1024} MiB since ${new Date(cutoff).toISOString()}`)
  return reading(price(counted))
}
