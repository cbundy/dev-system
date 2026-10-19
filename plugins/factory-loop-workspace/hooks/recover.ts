// Recovery of a stop gate the loop's restart cut (docs/factory-loop/v2/SPEC.md 10.6), pure: the reads
// and the choices. The companion writes `gate-start` as a gate begins, so a log whose newest line for
// an attempt is a start (or the wait after it) with no settling line, written by a process that is
// gone, is a gate the restart cut. register.ts supplies the effects (reading files, running the gate,
// writing the lines), as gate.ts does.
import type { Marker } from './marker'

// the log is read this far back
export const RECOVER_WINDOW_MS = 24 * 3_600_000

// the causes that end a gate attempt's open state: a settling line, a re-run or a given-up cut
const CLOSING = ['gate-pass', 'gate-fail', 'gate-unknown', 'gate-rerun', 'gate-cut']

// One line of the log that concerns a gate attempt, in file order.
export type GateEntry = {
  at: number
  issue: number
  life: string
  seq: number
  cause: string
  startedAt: string | null
  slot: string | null
  gitDir: string | null
  process: string | null
}

// A gate attempt still open: its newest line is a start or a wait.
export type OpenGate = {
  issue: number
  life: string
  seq: number
  // the time of the start line (of the wait line when no start was written: a companion before
  // `gate-start`), its startedAt, slot, git dir and process
  at: number
  startedAt: string | null
  slot: string | null
  gitDir: string | null
  process: string | null
}

const natural = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

// gateEntries: the log's gate lines within the window, in file order; a line that does not read, or names
// no issue, life and seq, is skipped.
export function gateEntries(log: string | null, now: number): GateEntry[] {
  const out: GateEntry[] = []
  for (const raw of (log ?? '').split('\n')) {
    if (raw.trim() === '') continue
    let o: Record<string, unknown>
    try {
      const v: unknown = JSON.parse(raw)
      if (v === null || typeof v !== 'object' || Array.isArray(v)) continue
      o = v as Record<string, unknown>
    } catch {
      continue
    }
    const at = typeof o.at === 'string' ? Date.parse(o.at) : typeof o.at === 'number' ? o.at : Number.NaN
    const issue = natural(o.issue)
    const seq = natural(o.seq)
    const cause = text(o.cause)
    if (!Number.isFinite(at) || now - at > RECOVER_WINDOW_MS || issue === null || issue === 0 || seq === null || cause === null) continue
    if (cause !== 'gate-start' && cause !== 'gate-wait' && !CLOSING.includes(cause)) continue
    if (typeof o.life !== 'string' || !/^[0-9a-z]+$/.test(o.life)) continue
    out.push({ at, issue, life: o.life, seq, cause, startedAt: text(o.startedAt), slot: text(o.slot), gitDir: text(o.gitDir), process: text(o.process) })
  }
  return out
}

// openGates: each (issue, life, seq) whose newest line is `gate-start` or `gate-wait`: no settling line,
// re-run or cut at or after the start. Its start is the newest `gate-start` of the attempt.
export function openGates(entries: readonly GateEntry[]): OpenGate[] {
  const newest = new Map<string, GateEntry>()
  const starts = new Map<string, GateEntry>()
  for (const e of entries) {
    const key = `${e.issue}/${e.life}/${e.seq}`
    newest.set(key, e)
    if (e.cause === 'gate-start') starts.set(key, e)
  }
  const out: OpenGate[] = []
  for (const [key, last] of newest) {
    if (last.cause !== 'gate-start' && last.cause !== 'gate-wait') continue
    const s = starts.get(key) ?? last
    out.push({ issue: s.issue, life: s.life, seq: s.seq, at: s.at, startedAt: s.startedAt, slot: s.slot, gitDir: s.gitDir, process: s.process })
  }
  return out
}

// bootMs: the machine's boot time from /proc/stat's `btime` line (seconds), or null.
export function bootMs(procStat: string | null): number | null {
  const m = /^btime (\d+)$/m.exec(procStat ?? '')
  return m === null ? null : Number(m[1]) * 1000
}

// startMs: when the process /proc/<pid>/stat describes started, from its field 22 (clock ticks since
// boot, 100 a second) and the boot time; null when either does not read.
export function startMs(stat: string | null, boot: number | null): number | null {
  const start = stat?.slice(stat.lastIndexOf(') ') + 2).split(' ')[19] ?? ''
  return boot !== null && /^\d+$/.test(start) ? boot + Number(start) * 10 : null
}

// isDead: whether the process that wrote an open gate's start is gone. `current` is the id
// (`pid:start`) /proc/<pid>/stat gives now for its pid (undefined: no such process), so a pid given to
// a later process is dead too. A line with no process (a companion before it) is dead only when it was
// written before this process started (`ownStart`; null when not known: not dead).
export function isDead(open: Pick<OpenGate, 'at' | 'process'>, current: string | undefined, ownStart: number | null): boolean {
  if (open.process === null) return ownStart !== null && open.at < ownStart
  return current !== open.process
}

// pidOf: the pid of a process id, or null when it is not `pid:start`.
export function pidOf(process: string | null): string | null {
  const m = /^(\d+):\d+$/.exec(process ?? '')
  return m === null ? null : (m[1] as string)
}

export type Verdict = { rerun: true } | { rerun: false; why: string }

// judge: whether a dead open gate is run again. Only when the slot's marker still names its issue, life and
// seq as a writer with gate commands; the why says what else it found.
export function judge(open: OpenGate, marker: Marker | null): Verdict {
  if (open.slot === null || open.gitDir === null || !open.slot.startsWith('/') || !open.gitDir.startsWith('/')) return { rerun: false, why: 'its start line names no slot and git dir (a companion before gate-start)' }
  if (marker === null) return { rerun: false, why: 'the slot has no readable step marker any more' }
  if (marker.issue !== open.issue || marker.life !== open.life || marker.seq !== open.seq) return { rerun: false, why: `the slot's marker names #${marker.issue} life ${marker.life} seq ${marker.seq}, not this attempt` }
  if (marker.role !== 'writer') return { rerun: false, why: `the slot's marker names a ${marker.role}, not a writer` }
  if (marker.gateCommands.length === 0) return { rerun: false, why: "the slot's marker has no gate commands" }
  return { rerun: true }
}

// leaseHeld: whether the act lock's text is a lease of this session that has not expired.
export function leaseHeld(lock: string | null, session: string, now: number): boolean {
  if (lock === null) return false
  try {
    const v: unknown = JSON.parse(lock)
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
    const o = v as Record<string, unknown>
    return o.session === session && typeof o.expiresAt === 'number' && o.expiresAt > now
  } catch {
    return false
  }
}
