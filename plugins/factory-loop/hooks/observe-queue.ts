// observe-queue: the queue read of observe.ts. GitHub's label listing sometimes answers an empty
// list while the issues still carry the label, so an empty read that the members' own per-issue
// reads contradict is a failed source and the last list stands (v2 SPEC 13.3.3).
import { parseQueue, parseQueueOnce } from './parse'
import type { GithubIssue } from './state'
import type { Source } from './types'

type Timed<T> = { at: number; value: T }
type Result = { exitCode: number; stdout: string; stderr: string }

// emptyContradicted: the members of the last list that their own cached reads show open, trusted
// and labelled, when this read is empty and the last list was not; [] otherwise.
export function emptyContradicted(prev: number[], read: number[], github: Map<number, Timed<GithubIssue>>, readyLabel: string): number[] {
  if (read.length > 0 || prev.length === 0) return []
  return prev.filter(n => {
    const c = github.get(n)?.value
    return c !== undefined && c.trusted && c.facts !== null && c.facts.open && c.facts.labels.includes(readyLabel)
  })
}

export type QueueIo = {
  // the argv to run and how to turn its result into a list; null: the read failed
  argv: string[]
  once: boolean
  cache: { queue?: Timed<number[]>; github: Map<number, Timed<GithubIssue>> }
  now: number
  readyLabel: string
  run: (argv: string[]) => Promise<Result>
  fail: (r: Result) => string
}

// readQueue: one queue read. Returns the list to hand on as the new `--known` list (null: none)
// and the source to mark. A good read writes cache.queue; a contradicted empty one and a failed
// one leave it as it was.
export async function readQueue(q: QueueIo): Promise<{ known: number[] | null; source: Source }> {
  const r = await q.run(q.argv)
  let list: number[] | null = null
  if (r.exitCode === 0) list = q.once ? (parseQueueOnce(r.stdout)?.now ?? null) : parseQueue(r.stdout)
  if (list === null) return { known: null, source: { ok: false, at: q.cache.queue?.at ?? null, error: q.fail(r) } }
  const bad = emptyContradicted(q.cache.queue?.value ?? [], list, q.cache.github, q.readyLabel)
  if (bad.length > 0) {
    const names = bad.map(n => `#${n}`).join(', ')
    return {
      known: null,
      source: { ok: false, at: q.cache.queue?.at ?? null, error: `the ready list came back empty while ${names} carry ${q.readyLabel} by their own reads; the last list stands` },
    }
  }
  q.cache.queue = { at: q.now, value: list }
  return { known: q.once ? list : null, source: { ok: true, at: q.now } }
}
