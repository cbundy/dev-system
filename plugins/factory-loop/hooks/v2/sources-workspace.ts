// The workspace rail's read (docs/factory-loop/v2/SPEC.md 10.9): the companion plugin's handshake
// for this session, and whether it shows the companion runs now. The companion writes it again
// every minute (plugins/factory-loop-workspace/hooks/register.ts handshake); a missing, foreign or
// stale one fails the rail, and v2's planner holds every agent step (workspace.ts). observe.ts
// calls readWorkspace each pass.
import { isoMs } from '../parse'
import type { Ms } from '../types'
import { handshakePath } from './workspace'
import type { WorkspaceRead } from './workspace'

// The companion writes its handshake every minute. One older than three beats says it no longer
// runs (a session resumed under the same id without it, a plugin list rolled back, a module that
// failed to load), so it reads as missing.
export const HANDSHAKE_STALE_MS = 3 * 60_000

// A handshake written this long before the loop's module loaded is from before this process: a
// live companion writes again within a beat of its start, so the old file never passes the first
// pass after a restart. The grace is one beat and a half.
export const HANDSHAKE_LOAD_GRACE_MS = 90_000

// workspaceRead: the handshake's text (null: no file) for the session, judged at now for a loop
// module loaded at loadedAt.
export function workspaceRead(text: string | null, session: string, now: Ms, loadedAt: Ms): WorkspaceRead {
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
  const at = isoMs(o.at)
  const stale = `the companion plugin factory-loop-workspace is not running in this session (${session}): its handshake is stale`
  if (at === null) return { session, ok: false, why: `${stale}, with no time` }
  const written = new Date(at).toISOString()
  if (now - at > HANDSHAKE_STALE_MS) return { session, ok: false, why: `${stale}, written ${written}, ${Math.round((now - at) / 60_000)} minutes ago (it writes one every minute)` }
  if (at < loadedAt - HANDSHAKE_LOAD_GRACE_MS) return { session, ok: false, why: `${stale}, written ${written}, before the loop loaded at ${new Date(loadedAt).toISOString()}` }
  return { session, ok: true, version: typeof o.version === 'string' ? o.version : null }
}

// readWorkspace: the companion plugin's handshake for this session, under the loop's base directory
// (the loop dir's parent), judged fresh at now for a module loaded at loadedAt. v2's planner holds
// every agent step while it fails (workspace.ts); a read that fails reads as no handshake, so
// the rail fails safe.
export async function readWorkspace(io: { readFile: (path: string) => Promise<string> }, loopDir: string, session: string, now: Ms, loadedAt: Ms): Promise<WorkspaceRead> {
  const text = await io.readFile(handshakePath(loopDir.replace(/\/[^/]+\/?$/, ''), session)).catch(() => null)
  return workspaceRead(text, session, now, loadedAt)
}
