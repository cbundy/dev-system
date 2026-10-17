// The factory report (#712, epic #684): a pure view of the v2 records as two markdown tables, the
// issues in flight and the last merges, and a digest that changes when the picture does and not
// when only time passes. Nothing here reads a clock, a store or GitHub; delivery comes later. It
// lives in hooks/, not hooks/v2/, so it stays out of the planner's import closure.
import type { Ms } from './types'
import { lifeAt } from './v2/keys'
import { SLOT_STATES } from './v2/types'
import type { IssueRecord, IssueState } from './v2/types'

export const MERGED_SHOWN = 5
export const WHAT_MAX = 40

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

// duration: Xs under a minute, Xm under an hour, XhYm under a day, XdYh from a day up.
export function duration(ms: Ms): string {
  const t = Math.max(0, ms)
  if (t < MIN) return `${Math.floor(t / SEC)}s`
  if (t < HOUR) return `${Math.floor(t / MIN)}m`
  if (t < DAY) return `${Math.floor(t / HOUR)}h${Math.floor((t % HOUR) / MIN)}m`
  return `${Math.floor(t / DAY)}d${Math.floor((t % DAY) / HOUR)}h`
}

// The state in words (the one table); a detail, where one helps, comes from stageOf.
const STAGE_WORDS: Readonly<Record<IssueState, string>> = {
  queued: 'queued',
  designing: 'designing',
  building: 'building',
  reviewing: 'reviewing',
  fixing: 'fixing',
  'merge-queue': 'merge queue',
  parked: 'parked',
  closed: 'closed',
}

export function stageOf(r: IssueRecord): string {
  const word = STAGE_WORDS[r.state]
  if (r.state === 'reviewing' && r.approvedPatch !== null) return `${word} (approved, heading to merge)`
  if (r.state === 'parked' && r.question) return `${word} (owner question)`
  return word
}

// whatOf: a title shortened: the prefix up to the first ": " dropped, the rest cut at a word
// boundary to at most WHAT_MAX characters, "|" escaped. No title gives an empty string.
export function whatOf(title: string | undefined): string {
  if (!title) return ''
  const i = title.indexOf(': ')
  let s = (i >= 0 ? title.slice(i + 2) : title).trim().replace(/\s+/g, ' ')
  if (s.length > WHAT_MAX) {
    const cut = s.slice(0, WHAT_MAX + 1)
    const space = cut.lastIndexOf(' ')
    s = space > 0 ? cut.slice(0, space) : cut.slice(0, WHAT_MAX)
  }
  return s.trim().replace(/\|/g, '\\|')
}

const isMerged = (r: IssueRecord) => r.state === 'closed' && (r.why === 'merged' || r.why === 'merged-by-hand')
const isInFlight = (r: IssueRecord) => SLOT_STATES.includes(r.state) || r.state === 'parked'

const claimAt = (r: IssueRecord): Ms | null => lifeAt(r.life)

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => ' --- ').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n')
}

export type Report = { text: string | null; digest: string }

export function reportOf(records: readonly IssueRecord[], titles: Readonly<Record<number, string>> | ReadonlyMap<number, string>, now: Ms, repo: string): Report {
  const title = (n: number) => (titles instanceof Map ? titles.get(n) : (titles as Readonly<Record<number, string>>)[n])
  const link = (n: number) => `[#${n}](https://github.com/${repo}/issues/${n})`

  const flight = records.filter(isInFlight).sort((a, b) => {
    const x = claimAt(a)
    const y = claimAt(b)
    if (x === null || y === null) return x === y ? a.issue - b.issue : x === null ? 1 : -1
    return x - y || a.issue - b.issue
  })
  const merged = records.filter(isMerged).sort((a, b) => b.since - a.since || a.issue - b.issue)

  const digest = [
    flight.map(r => `${r.issue}:${r.life}:${r.state}:${r.seq}`).join(','),
    merged.map(r => `${r.issue}:${r.life}`).sort().join(','),
  ].join('|')
  if (flight.length === 0 && merged.length === 0) return { text: null, digest }

  const flightRows = flight.map(r => {
    const at = claimAt(r)
    return [link(r.issue), whatOf(title(r.issue)), stageOf(r), duration(now - r.since), at === null ? '' : duration(now - at)]
  })
  const mergedRows = merged.slice(0, MERGED_SHOWN).map(r => {
    const at = claimAt(r)
    return [link(r.issue), whatOf(title(r.issue)), at === null ? '' : duration(r.since - at), String(r.fixes)]
  })
  const text = [
    `### In flight (${flight.length})`,
    flightRows.length > 0 ? table(['Issue', 'What', 'Stage', 'In stage', 'Since claim'], flightRows) : 'Nothing in flight.',
    '',
    '### Merged',
    mergedRows.length > 0 ? table(['Issue', 'What', 'Claim to merge', 'Fix rounds'], mergedRows) : 'Nothing merged yet.',
  ].join('\n')
  return { text, digest }
}

// titleBook: the title book after a pass: the known titles, with every title the pass's issue
// reads carry, and only for issues that have a v2 record. It makes no GitHub call.
export function titleBook(prev: unknown, reads: ReadonlyMap<number, { facts: { title: string } | null }>, records: readonly Pick<IssueRecord, 'issue'>[]): Record<number, string> {
  const known: Record<number, string> = {}
  if (prev !== null && typeof prev === 'object' && !Array.isArray(prev)) {
    for (const [k, v] of Object.entries(prev)) if (typeof v === 'string' && /^\d+$/.test(k)) known[Number(k)] = v
  }
  for (const [n, g] of reads ?? []) if (g.facts && g.facts.title) known[n] = g.facts.title
  const out: Record<number, string> = {}
  for (const r of records) if (known[r.issue] !== undefined) out[r.issue] = known[r.issue]
  return out
}

// keepTitles: the title book in the store, written only when it changed. A store that cannot be
// read or written is a problem line, never a throw.
export async function keepTitles(
  io: { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<unknown> },
  key: string,
  reads: ReadonlyMap<number, { facts: { title: string } | null }>,
  records: readonly Pick<IssueRecord, 'issue'>[],
  problems: string[],
): Promise<void> {
  try {
    const prev = await io.get(key)
    const next = titleBook(prev, reads, records)
    if (JSON.stringify(next) !== JSON.stringify(prev)) await io.set(key, next)
  } catch (err) {
    problems.push(`store: ${key} not saved: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`)
  }
}
