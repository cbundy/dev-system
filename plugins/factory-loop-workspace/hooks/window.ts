// The session's context window size (docs/metrics.md, images/base/heartbeat-state): one file per
// session id in DEV_CONTEXT_WINDOW_DIR (else /tmp/dev-context-window), which the worker heartbeat
// pushes with the session's liveness as sessions[].context_window. The factory-hud mod writes the
// same file in the same format; a loop workspace always has this plugin, so it records it too.
import type { EngineInterface } from 'claude-code'

// windowText: the file's text for a window, or undefined when it is not a positive integer.
export function windowText(window: unknown): string | undefined {
  return typeof window === 'number' && Number.isInteger(window) && window > 0 ? `${window}\n` : undefined
}

let recorded = ''

// recordWindow: written only when the session id or the window changes; a failed read or write is
// dropped, so a missing window stays a gap in the fleet data.
export async function recordWindow($: EngineInterface): Promise<void> {
  try {
    const text = windowText((await $.session.usage()).context?.window)
    if (text === undefined) return
    const id = await $.session.id()
    if (recorded === `${id}=${text}`) return
    const dir = (await $.env.get('DEV_CONTEXT_WINDOW_DIR')) || '/tmp/dev-context-window'
    await $.fs.write(`${dir}/${id}`, text)
    recorded = `${id}=${text}`
  } catch {
    // dropped
  }
}
