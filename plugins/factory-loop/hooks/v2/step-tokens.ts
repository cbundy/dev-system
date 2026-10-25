// The token totals and model of an agent step (cbundy/dev-system#657, v2 SPEC 13.7.4): read from the
// step agent's own transcript on disk when its ledger entry ends, so the `loop_entry` event carries
// what the step cost. One response is streamed as several transcript lines with the same
// `requestId`, so usage is taken once per request, the last line's winning (the rule
// callum-flow-evaluate uses, docs/metrics.md "Token and wake definitions"). The totals add every
// agent nested under the step agent (its `.meta.json` names its `parentAgentId`); the model is the
// step agent's own. Reading never throws: a failure is a reason, and the fields stay null.
import type { ActIo, RunInit, RunResult } from '../exec'
import { priceOf } from './prices'

export type StepTokens = { input: number; output: number; cacheRead: number; cacheCreation: number; model: string | null }

// The six loop_entry fields, null when nothing was read.
export type TokenFields = {
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_creation_tokens: number | null
  model: string | null
  // the what-if cost at public API prices, null when a model is unpriced (#1334)
  cost_usd: number | null
}

export const NO_TOKENS: TokenFields = { input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null, model: null, cost_usd: null }

// A reading: the fields, and why they are null when they are.
export type TokenReading = { fields: TokenFields; problem: string | null }

const LOOKUP_TIMEOUT_MS = 5_000
const NESTED_DEPTH = 6
const SAFE_ID = /^[A-Za-z0-9_-]+$/

export function fieldsOf(t: StepTokens, sum: Omit<StepTokens, 'model'> = t, cost: number | null = null): TokenFields {
  return { input_tokens: sum.input, output_tokens: sum.output, cache_read_tokens: sum.cacheRead, cache_creation_tokens: sum.cacheCreation, model: t.model, cost_usd: cost }
}

// cacheWrite5m / cacheWrite1h split cacheCreation by cache lifetime for pricing.
export type Turn = { input: number; output: number; cacheRead: number; cacheCreation: number; cacheWrite5m: number; cacheWrite1h: number; model: string | null }

// turnsOf: a transcript's requests by requestId, the last line of a request winning (a line without
// a requestId is a request of its own, keyed with a NUL prefix). An unparsable line is skipped; the
// `<synthetic>` model of the harness's own notices is not a model.
export function turnsOf(text: string): Map<string, Turn> {
  const turns = new Map<string, Turn>()
  let anon = 0
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    let line: unknown
    try {
      line = JSON.parse(raw)
    } catch {
      continue
    }
    if (typeof line !== 'object' || line === null) continue
    const l = line as Record<string, unknown>
    if (l.type !== 'assistant') continue
    const msg = typeof l.message === 'object' && l.message !== null ? (l.message as Record<string, unknown>) : {}
    const key = typeof l.requestId === 'string' ? l.requestId : `\0anon${anon++}`
    let turn = turns.get(key)
    if (turn === undefined) {
      turn = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheWrite5m: 0, cacheWrite1h: 0, model: null }
      turns.set(key, turn)
    }
    if (typeof msg.model === 'string' && msg.model !== '' && msg.model !== '<synthetic>') turn.model = msg.model
    const u = msg.usage
    if (typeof u === 'object' && u !== null) {
      const n = (k: string) => {
        const v = (u as Record<string, unknown>)[k]
        return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
      }
      turn.input = n('input_tokens')
      turn.output = n('output_tokens')
      turn.cacheRead = n('cache_read_input_tokens')
      turn.cacheCreation = n('cache_creation_input_tokens')
      const cc = (u as Record<string, unknown>).cache_creation
      const split = typeof cc === 'object' && cc !== null ? (cc as Record<string, unknown>) : {}
      const m = (k: string) => {
        const v = split[k]
        return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
      }
      turn.cacheWrite1h = Math.min(m('ephemeral_1h_input_tokens'), turn.cacheCreation)
      // what the split does not account for counts at the 5m rate
      turn.cacheWrite5m = turn.cacheCreation - turn.cacheWrite1h
    }
  }
  return turns
}

// tokensOf: a transcript's usage once per distinct requestId, and the model of most requests (a tie
// goes to the one seen later).
export function tokensOf(text: string): StepTokens {
  const turns = turnsOf(text)
  const total: StepTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, model: null }
  const seen = new Map<string, { count: number; last: number }>()
  let i = 0
  for (const turn of turns.values()) {
    total.input += turn.input
    total.output += turn.output
    total.cacheRead += turn.cacheRead
    total.cacheCreation += turn.cacheCreation
    if (turn.model !== null) {
      const m = seen.get(turn.model) ?? { count: 0, last: 0 }
      seen.set(turn.model, { count: m.count + 1, last: i })
    }
    i++
  }
  let best: { model: string; count: number; last: number } | null = null
  for (const [model, m] of seen) if (best === null || m.count > best.count || (m.count === best.count && m.last > best.last)) best = { model, ...m }
  total.model = best === null ? null : best.model
  return total
}

// costOf: a transcript's what-if cost, each request at its own model's rates. A request with no
// tokens and no model (a synthetic notice) adds nothing; a request with tokens at an unknown or
// missing model makes the cost null and names the model in `unpriced`.
export function costOf(text: string, unpriced: Set<string>): number {
  let cost = 0
  for (const t of turnsOf(text).values()) {
    if (t.model === null && t.input + t.output + t.cacheRead + t.cacheCreation === 0) continue
    const p = priceOf(t.model, t)
    if (p === null) unpriced.add(t.model ?? '(none)')
    else cost += p
  }
  return cost
}

// transcriptPath: where the session that spawned the agent keeps its transcript.
export function transcriptPath(configDir: string, sessionCwd: string, session: string, agentId: string): string {
  return `${configDir}/projects/${sessionCwd.replace(/[^A-Za-z0-9]/g, '-')}/${session}/subagents/agent-${agentId}.jsonl`
}

export type TokenSource = {
  configDir: string
  // the cwd of the session that spawned the agent: it names the project folder
  sessionCwd: string
  session: string
  agentId: string
}

type Cmd = (argv: string[], init: RunInit) => Promise<RunResult>

// readStepTokens: the step agent's fields, or null fields and the reason. The file at the expected
// path first; when it is absent, one bounded find over the config dir's projects (the session may have
// run from another cwd). Nested agents are the `.meta.json` files beside it that name an agent as
// their parent, found with grep (no shell), the children's own children after them.
export async function readStepTokens(io: Pick<ActIo, 'readFile'>, cmd: Cmd, src: TokenSource): Promise<TokenReading> {
  const none = (problem: string): TokenReading => ({ fields: NO_TOKENS, problem })
  if (src.session === '' || !SAFE_ID.test(src.session) || !SAFE_ID.test(src.agentId)) return none('transcript not found (no session)')
  try {
    let path: string | null = transcriptPath(src.configDir, src.sessionCwd, src.session, src.agentId)
    let text = await io.readFile(path)
    if (text === null) {
      const r = await cmd(['find', `${src.configDir}/projects`, '-maxdepth', '4', '-path', `*/${src.session}/subagents/agent-${src.agentId}.jsonl`], { timeoutMs: LOOKUP_TIMEOUT_MS })
      const found = r.exitCode === 0 ? r.stdout.split('\n').find(l => l.trim() !== '') : undefined
      if (found !== undefined) {
        path = found.trim()
        text = await io.readFile(path)
      }
    }
    if (text === null || path === null) return none('transcript not found')
    const own = tokensOf(text)
    const unpriced = new Set<string>()
    let cost = costOf(text, unpriced)
    const sum = { input: own.input, output: own.output, cacheRead: own.cacheRead, cacheCreation: own.cacheCreation }
    const dir = path.slice(0, path.lastIndexOf('/'))
    const visited = new Set<string>([src.agentId])
    let level = [src.agentId]
    for (let depth = 0; depth < NESTED_DEPTH && level.length > 0; depth++) {
      const next: string[] = []
      for (const parent of level) {
        for (const child of await childrenOf(io, cmd, dir, parent)) {
          if (visited.has(child)) continue
          visited.add(child)
          next.push(child)
          const t = await io.readFile(`${dir}/agent-${child}.jsonl`)
          if (t === null) continue
          const c = tokensOf(t)
          cost += costOf(t, unpriced)
          sum.input += c.input
          sum.output += c.output
          sum.cacheRead += c.cacheRead
          sum.cacheCreation += c.cacheCreation
        }
      }
      level = next
    }
    if (unpriced.size > 0) return { fields: fieldsOf(own, sum, null), problem: `unpriced model ${[...unpriced].join(', ')}` }
    return { fields: fieldsOf(own, sum, Math.round(cost * 1e6) / 1e6), problem: null }
  } catch (err) {
    return none(`transcript unreadable: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// childrenOf: the agents whose meta file names `parent` as their parentAgentId. A meta file that is
// not JSON, or does not name it after all, is skipped; grep exits 1 for no match.
async function childrenOf(io: Pick<ActIo, 'readFile'>, cmd: Cmd, dir: string, parent: string): Promise<string[]> {
  const r = await cmd(['grep', '-rlF', '--include=*.meta.json', `"parentAgentId":"${parent}"`, dir], { timeoutMs: LOOKUP_TIMEOUT_MS })
  if (r.exitCode !== 0) return []
  const out: string[] = []
  for (const file of r.stdout.split('\n')) {
    const m = /\/agent-([A-Za-z0-9_-]+)\.meta\.json$/.exec(file.trim())
    if (m === null) continue
    const raw = await io.readFile(file.trim())
    if (raw === null) continue
    try {
      const meta = JSON.parse(raw) as Record<string, unknown>
      if (meta.parentAgentId === parent) out.push(m[1] as string)
    } catch {
      continue
    }
  }
  return out
}
