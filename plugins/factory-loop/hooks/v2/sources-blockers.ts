// The `blockers` source (docs/factory-loop/v2/SPEC.md 2.4): why a starved queue is stuck. While the
// queue has been starved for starvedNoticeAfterMs (V2State.starvedSince), the open `blocked by` links
// of the queue's blocked issues are walked with the single-issue reader (`callum-flow-issue-read
// --json N`, whose `blocked_by` lists each blocker): breadth first, this repo's open blockers only,
// at most MAX_READS reads and MAX_DEPTH levels. It runs once per (spell, 24 h period of it), reads
// nothing during a GitHub backoff and stops at a rate limit. A read that is refused (exit 3, an
// untrusted author) or failed ends its branch. Pure parsing and one loop of reads; the cache lives in
// observe.ts's V2Cache.
import type { Ms } from '../types'
import { parseIssueRead } from '../parse'
import { issueReadArgv } from './argv'
import type { SourceCtx } from './observe'
import type { BlockerNode, BlockerTree } from './types'

export const MAX_READS = 40
export const MAX_DEPTH = 8
const DAY = 86_400_000

// blockedByOf: the open blockers of the issue's read: this repo's (numbers) and others' (`owner/name#N`);
// null when the output has no `blocked_by` list.
export function blockedByOf(json: string, repo: string): { local: number[]; foreign: string[] } | null {
  try {
    const list: unknown = (JSON.parse(json) as { blocked_by?: unknown }).blocked_by
    if (!Array.isArray(list)) return null
    const local: number[] = []
    const foreign: string[] = []
    for (const raw of list) {
      const b = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      if (b.state !== 'open' || typeof b.number !== 'number' || !Number.isInteger(b.number)) continue
      const from = typeof b.repo === 'string' ? b.repo : repo
      if (from.toLowerCase() === repo.toLowerCase()) {
        if (!local.includes(b.number)) local.push(b.number)
      } else foreign.push(`${from}#${b.number}`)
    }
    return { local, foreign }
  } catch {
    return null
  }
}

// readBlockers: the tree for this spell and period. `kept` is the last pass's tree: it stands when it
// is for the same spell and period. `spell` is null with no spell or before the notice is due, and
// `blocked` is true during a GitHub backoff: nothing is read then, and the kept tree of the spell
// stands. Returns the tree to keep and hand to the plan (null: none for this spell).
export async function readBlockers(ctx: SourceCtx, kept: BlockerTree | null, spell: { since: Ms; afterMs: Ms } | null, blocked: boolean): Promise<BlockerTree | null> {
  if (spell === null || ctx.now - spell.since < spell.afterMs) return null
  const period = Math.floor((ctx.now - spell.since - spell.afterMs) / DAY)
  const same = kept !== null && kept.since === spell.since
  if (same && kept.period === period) return kept
  const start = ctx.state.queue.filter(n => (ctx.state.issues.find(i => i.number === n)?.blockedBy ?? 0) > 0)
  if (blocked || ctx.limited()) return same ? kept : null
  const nodes: Record<number, BlockerNode> = {}
  let reads = 0
  let truncated = false
  let level = [...new Set(start)]
  const queued = new Set(level)
  for (let depth = 0; level.length > 0; depth++) {
    const next: number[] = []
    for (const n of level) {
      // an issue the walk does not read has no node: the plan ends its branch there
      if (reads >= MAX_READS || depth >= MAX_DEPTH || ctx.limited()) {
        truncated = true
        continue
      }
      reads += 1
      const node = await readNode(ctx, n)
      nodes[n] = node
      for (const b of node.blockers) if (!queued.has(b)) {
          queued.add(b)
          next.push(b)
        }
    }
    level = next
  }
  const good = Object.values(nodes).filter(v => v.read !== 'failed').length
  const error = start.length > 0 && good === 0 ? 'every read failed' : null
  return { since: spell.since, period, readAt: ctx.now, nodes, truncated, error }
}

// readNode: one issue's read.
async function readNode(ctx: SourceCtx, n: number): Promise<BlockerNode> {
  const failed: BlockerNode = { open: true, labels: [], title: null, blockers: [], foreign: [], read: 'failed' }
  try {
    const r = await ctx.run(issueReadArgv(n))
    if (r.exitCode === 3) return { ...failed, read: 'refused' }
    if (r.exitCode !== 0) return failed
    const facts = parseIssueRead(r.stdout)
    const by = blockedByOf(r.stdout, ctx.rt.repo)
    if (facts === null || by === null) return failed
    return { open: facts.open, labels: facts.labels, title: facts.title === '' ? null : facts.title, blockers: by.local, foreign: by.foreign, read: 'ok' }
  } catch {
    return failed
  }
}
