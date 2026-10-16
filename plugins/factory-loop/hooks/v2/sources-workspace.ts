// The workspace rail's read (docs/factory-loop/v2/SPEC.md 10.9): the companion plugin's handshake
// for this session, and whether it shows the companion runs now, in this process. The companion
// writes it again every minute (plugins/factory-loop-workspace/hooks/register.ts handshake); a
// missing, foreign or stale one fails the rail, and v2's planner holds every agent step
// (workspace.ts). observe.ts calls readWorkspace each pass.
import { isoMs } from '../parse'
import type { Ms } from '../types'
import { handshakePath } from './workspace'
import type { WorkspaceRead } from './workspace'

// The companion writes its handshake every minute. One older than three beats says it no longer
// runs in this process (a plugin list reloaded without it, a beat that stopped), so it reads as
// missing.
export const HANDSHAKE_STALE_MS = 3 * 60_000

// workspaceRead: the handshake's text (null: no file) for the session, judged at now for this
// process, whose id the companion keeps in its environment (undefined: no companion ran in it).
// Only a handshake that names this process passes: after a restart without the companion, the old
// process's file names the old process.
export function workspaceRead(text: string | null, session: string, processId: string | undefined, now: Ms): WorkspaceRead {
  const missing = `the companion plugin factory-loop-workspace is not loaded in this session (${session}): no handshake`
  if (text === null) return { session, ok: false, why: missing }
  let o: Record<string, unknown>
  try {
    const v: unknown = JSON.parse(text)
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return { session, ok: false, why: `${missing} that reads` }
    o = v as Record<string, unknown>
  } catch {
    return { session, ok: false, why: `${missing} that reads` }
  }
  if (o.session !== session) return { session, ok: false, why: `the companion's handshake names session ${String(o.session)}, not this one (${session})` }
  if (!processId || o.process !== processId) return { session, ok: false, why: `the companion plugin factory-loop-workspace is not running in this process: this session's (${session}) handshake was written by another one` }
  const at = isoMs(o.at)
  const stale = `the companion plugin factory-loop-workspace is not running in this session (${session}): its handshake is stale`
  if (at === null) return { session, ok: false, why: `${stale}, with no time` }
  if (now - at > HANDSHAKE_STALE_MS) return { session, ok: false, why: `${stale}, written ${new Date(at).toISOString()}, ${Math.round((now - at) / 60_000)} minutes ago (it writes one every minute)` }
  return { session, ok: true, version: typeof o.version === 'string' ? o.version : null }
}

// readWorkspace: the companion plugin's handshake for this session, under the loop's base directory
// (the loop dir's parent), judged for this process at now. v2's planner holds every agent step
// while it fails (workspace.ts); a read that fails reads as no handshake, so the rail fails safe.
export async function readWorkspace(io: { readFile: (path: string) => Promise<string> }, loopDir: string, session: string, processId: string | undefined, now: Ms): Promise<WorkspaceRead> {
  const text = await io.readFile(handshakePath(loopDir.replace(/\/[^/]+\/?$/, ''), session)).catch(() => null)
  return workspaceRead(text, session, processId, now)
}
