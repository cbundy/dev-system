// The dual-write source (v2 SPEC 2.4, 4.1): in act mode with the v2 planner, whether this image writes the
// new event log (`callum-flow-event --new-path`, exit 0 and the path; an older image exits 2) and,
// when it does, which transitions of this device and repo the log already holds. Read once per load.
import { readEvent } from './event-reader'
import type { SourceCtx } from './observe'
import type { DualWrite } from './types'

export type DualWriteRead = { dualWrite: DualWrite | null; error: string | null }

// seenIn: the "<issue>:<life>:<seq>" of each transition line of this device and repo; a line that
// does not parse or read is skipped.
export function seenIn(text: string, device: string, repo: string): Set<string> {
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const raw = JSON.parse(line) as { type?: unknown; device?: unknown; repo?: unknown; issue?: unknown }
      if (raw.type !== 'transition' || raw.device !== device || raw.repo !== repo) continue
      const e = readEvent(raw)
      seen.add(`${String(raw.issue)}:${String(e.data.life)}:${String(e.data.seq)}`)
    } catch {
      // skipped, never fatal
    }
  }
  return seen
}

export async function readDualWrite(ctx: SourceCtx): Promise<DualWriteRead> {
  const { rt, now } = ctx
  try {
    const p = await ctx.run(['callum-flow-event', '--new-only', '--new-path', '--repo', rt.repo])
    if (p.exitCode !== 0) return { dualWrite: null, error: null }
    const path = p.stdout.trim()
    if (path === '') return { dualWrite: null, error: 'the new log path was empty' }
    const text = await ctx.readFile(path)
    return { dualWrite: { readAt: now, seen: seenIn(text ?? '', rt.device, rt.repo) }, error: null }
  } catch (err) {
    return { dualWrite: null, error: `the dual-write read failed: ${String(err).slice(0, 200)}` }
  }
}
