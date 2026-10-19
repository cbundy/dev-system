// S1's starved notice (docs/factory-loop/v2/SPEC.md 14.1): a ready queue the factory cannot touch while
// nothing is in flight is an idle factory, and the owner hears which issues hold it up.
//
// - S1 (rules-claim.ts) says per pass whether the pass is starved (ctx.starved). The driver keeps
//   the spell's start (V2State.starvedSince); observe reads the blockers of the queue's blocked issues
//   once the spell is starvedNoticeAfterMs old, once per 24 h period of it (sources-blockers.ts).
// - starvedRules plans tell(starved) once per (spell, period), when the tree for that period is there:
//   it names each root blocker (an issue with no open blocker of its own) and why it is not moving.
//
// The walk is a pure function of a map of nodes, so any source of nodes can feed it. Pure: the time
// is state.now.
import { isoOf, skip, wake, want } from '../foundation'
import { followKey } from './keys'
import { decisionOf } from './park-text'
import { openOf, openText } from './rules-state'
import { FACTORY_LABELS, sameLabel } from './types'
import type { BlockerNode, BlockerTree, IssueRecord, V2Ctx } from './types'

const DAY = 86_400_000
const MAX_ROOT_LINES = 10

// A root's reason: a code (the tell's `why` field) and the words of its line.
export type RootWhy = { code: string; text: string }

// A root blocker: an issue of this repo (`n`) or a foreign ref, and the queue issues it holds up.
export type Root = { ref: string; issue: number | null; blocks: number[] }

// periodOf: the 24 h period of a spell the pass is in, counted from the notice threshold; negative
// before it.
export function periodOf(now: number, since: number, afterMs: number): number {
  return Math.floor((now - since - afterMs) / DAY)
}

// rootsOf: for each blocked queue issue, the open blockers it ends in, walking the nodes. A root is an
// issue with no open blocker of its own, a foreign blocker, or a member of a blocking cycle; an
// issue the walk never read (no node) is a root of its own, so a cap ends a branch.
// Returns the roots in order of most blocked queue issues first, then by number.
export function rootsOf(nodes: ReadonlyMap<number, BlockerNode>, blocked: readonly number[]): Root[] {
  const found = new Map<string, Root>()
  const add = (ref: string, issue: number | null, by: number): void => {
    const r = found.get(ref) ?? { ref, issue, blocks: [] }
    if (!r.blocks.includes(by)) r.blocks.push(by)
    found.set(ref, r)
  }
  for (const q of blocked) {
    const seen = new Set<number>()
    const path = new Set<number>()
    const walk = (n: number): void => {
      const node = nodes.get(n)
      if (node === undefined || node.read !== 'ok' || (node.blockers.length === 0 && node.foreign.length === 0)) {
        add(`#${n}`, n, q)
        return
      }
      seen.add(n)
      path.add(n)
      for (const f of node.foreign) add(f, null, q)
      for (const b of node.blockers) {
        if (path.has(b)) {
          // a cycle: no member of it is the end of a chain, so both ends of the back edge are roots
          add(`#${b}`, b, q)
          add(`#${n}`, n, q)
        } else if (!seen.has(b)) walk(b)
      }
      path.delete(n)
    }
    walk(q)
  }
  return [...found.values()].sort((a, b) => b.blocks.length - a.blocks.length || (a.issue ?? Infinity) - (b.issue ?? Infinity) || a.ref.localeCompare(b.ref))
}

// inCycle: whether the issue is in a blocking cycle of the nodes.
function inCycle(nodes: ReadonlyMap<number, BlockerNode>, n: number): boolean {
  const seen = new Set<number>()
  const stack = [...(nodes.get(n)?.blockers ?? [])]
  while (stack.length > 0) {
    const m = stack.pop() as number
    if (m === n) return true
    if (seen.has(m)) continue
    seen.add(m)
    stack.push(...(nodes.get(m)?.blockers ?? []))
  }
  return false
}

// mergedRecord: the issue's newest closed record that merged.
function mergedRecord(ctx: V2Ctx, n: number): IssueRecord | undefined {
  return ctx.v2.records
    .filter(r => r.issue === n && r.state === 'closed' && (r.why === 'merged' || r.why === 'merged-by-hand'))
    .sort((a, b) => b.since - a.since)[0]
}

// whyOf: why a root is not moving, the first that matches: a live record of this device, a closed
// merged record whose rollout leaves it open, the issue's factory labels, no `ready` label, a queue
// issue's own claim filter; an issue the walk could not read says so.
export function whyOf(ctx: V2Ctx, nodes: ReadonlyMap<number, BlockerNode>, root: Root, skips: ReadonlyMap<number, string>): RootWhy {
  const n = root.issue
  if (n === null) return { code: 'foreign', text: 'in another repo, not read' }
  const live = ctx.v2.records.find(r => r.issue === n && r.state !== 'closed')
  if (live !== undefined) {
    if (live.state === 'parked') return { code: 'parked', text: `parked on the owner: ${decisionOf(live.question ?? 'none given')}` }
    if (live.state === 'waiting') {
      const open = openOf(ctx, live)
      return { code: open.some(c => c.kind === 'tag-contains') ? 'release' : 'waiting', text: `waiting on ${open.length === 0 ? 'its clear' : openText(ctx, open)}` }
    }
    return { code: 'in-factory', text: `in the factory as ${live.state}` }
  }
  const closed = mergedRecord(ctx, n)
  const read = closed === undefined ? undefined : ctx.byKey.get(followKey(closed, 'rollout'))
  const rollout = read?.status === 'done' && read.outcome?.kind === 'rollout' ? read.outcome.rollout : null
  if (closed !== undefined && rollout === 'run-it') {
    const release = ctx.state.release
    if (release === null) return { code: 'run-it', text: 'waiting on its Run it, release state unknown' }
    if (release.oldest !== null && closed.since >= release.oldest) return { code: 'run-it-unreleased', text: 'waiting on its Run it, and its merge is in no release yet' }
    return { code: 'run-it', text: 'waiting on its Run it' }
  }
  if (closed !== undefined && rollout === 'keep-open') return { code: 'keep-open', text: 'kept open by its rollout (keep-open): only a person closes it' }
  const node = nodes.get(n)
  if (node === undefined) return { code: 'cap', text: 'the walk stopped here (cap)' }
  if (node.read === 'refused') return { code: 'unread', text: 'untrusted author, not read' }
  if (node.read === 'failed') return { code: 'unread', text: 'its read failed' }
  if (inCycle(nodes, n)) return { code: 'skipped', text: 'in a blocking cycle' }
  const has = (name: string) => node.labels.some(l => sameLabel(l, name))
  if (has(FACTORY_LABELS.parked.name)) return { code: 'parked', text: 'parked on the owner' }
  if (has(FACTORY_LABELS.waiting.name)) return { code: 'waiting', text: 'waiting on a condition' }
  if (node.labels.some(l => l.toLowerCase().startsWith('factory:') && !sameLabel(l, 'factory:rejected'))) return { code: 'other-device', text: 'held by another device' }
  if (!has(ctx.config.readyLabel)) return { code: 'not-ready', text: 'not ready' }
  return { code: 'skipped', text: skips.get(n) ?? 'ready, but not in the ready queue' }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

// starvedRules: tell(starved) while the pass is starved, the spell is starvedNoticeAfterMs old and
// the blocker tree for its current period is read; the key holds the spell and the period, so a
// spell tells once and then once more a day while it lasts, and a new spell tells again.
export function starvedRules(ctx: V2Ctx): void {
  const verdict = ctx.starved
  const since = ctx.v2.starvedSince
  if (verdict === undefined || verdict.starved !== true || since === undefined) return
  const { now } = ctx.state
  const after = ctx.config.starvedNoticeAfterMs
  if (now - since < after) return
  const k = periodOf(now, since, after)
  const tree: BlockerTree | undefined = ctx.v2.blockers
  if (tree === undefined || tree.since !== since || tree.period !== k) {
    skip(ctx, 'S1', null, `starved since ${isoOf(since)}: blockers not read yet`)
    return
  }
  const nodes = new Map<number, BlockerNode>(Object.entries(tree.nodes).map(([n, v]) => [Number(n), v]))
  const queue = ctx.state.queue
  const issueOf = (n: number) => ctx.state.issues.find(i => i.number === n)
  const lines: string[] = []
  const failed = tree.error !== null
  let roots: Root[] = []
  const whys: string[] = []
  if (failed) {
    lines.push(`roots: not read (${tree.error})`)
    for (const n of verdict.blocked) lines.push(`#${n}: blocked by ${plural(issueOf(n)?.blockedBy ?? 0, 'open issue', 'open issues')}`)
  } else {
    roots = rootsOf(nodes, verdict.blocked)
    roots.forEach((root, i) => {
      const why = whyOf(ctx, nodes, root, verdict.skips)
      whys.push(`${root.ref.replace(/^#/, '')}=${why.code}`)
      if (i >= MAX_ROOT_LINES) return
      const title = root.issue === null ? null : nodes.get(root.issue)?.title
      const name = root.issue === null ? root.ref : `${root.ref} ${title === null || title === undefined || title === '' ? 'untitled' : title}`
      lines.push(`${name}: ${why.text} - blocks ${plural(root.blocks.length, 'ready issue', 'ready issues')} (${[...root.blocks].sort((a, b) => a - b).map(n => `#${n}`).join(' ')})`)
    })
    if (roots.length > MAX_ROOT_LINES) lines.push(`and ${roots.length - MAX_ROOT_LINES} more`)
  }
  for (const n of queue) {
    const why = verdict.skips.get(n)
    if (why !== undefined && !verdict.blocked.includes(n)) lines.push(`#${n}: ${why}`)
  }
  const fields = {
    since: isoOf(since),
    minutes: Math.floor((now - since) / 60_000),
    period: k,
    queue: queue.length,
    blocked: verdict.blocked.length,
    roots: failed ? 'unread' : roots.length === 0 ? null : roots.map(r => r.ref.replace(/^#/, '')).join(','),
    why: whys.length === 0 ? null : whys.join(','),
    truncated: tree.truncated ? 'yes' : null,
  }
  want(ctx, wake('tell', 'starved', `tell:starved:${since}:${k}`, 'S1', null, fields, lines))
}
