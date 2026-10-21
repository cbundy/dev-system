// The session title's one flight (v2 SPEC 13.9.1): every rename, the act title action's and the
// driver's own, goes through here. Wanting a title starts the rename and returns at once, so no
// pass awaits a rename. At most one rename is in flight; a title wanted meanwhile becomes the single
// pending one and replaces any earlier pending one. Driver-free, so a test can drive it with a fake
// clock and controllable promises.
import type { Ms } from './types'

// One settled rename: how long it took, when it ended, and why it failed.
export type TitleSettled = { title: string; ok: boolean; ms: Ms; endedAt: Ms; error?: string }

export type TitleFlight = {
  want: (title: string) => void
  current: () => { inFlight: string | null; pending: string | null }
}

export type TitleFlightOptions = {
  // one bounded rename; it may reject (a failure or its timeout)
  rename: (title: string) => Promise<void>
  now: () => Promise<Ms>
  // the title the session carries now, as the last successful rename left it
  title: () => string | null
  // once per rename, success or not; never awaited, and a throw from it is dropped
  settled: (done: TitleSettled) => void
}

export function newTitleFlight(opts: TitleFlightOptions): TitleFlight {
  let inFlight: string | null = null
  let pending: string | null = null

  const start = (title: string) => {
    inFlight = title
    const run = async () => {
      const t0 = await opts.now()
      let error: string | undefined
      try {
        await opts.rename(title)
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
      const endedAt = await opts.now()
      try {
        opts.settled({ title, ok: error === undefined, ms: endedAt - t0, endedAt, ...(error === undefined ? {} : { error }) })
      } catch {
        // a throwing observer must not stop the next rename
      }
    }
    void run()
      .catch(() => undefined)
      .then(() => {
        inFlight = null
        const next = pending
        pending = null
        if (next !== null && next !== opts.title()) start(next)
      })
  }

  return {
    want: title => {
      if (title === inFlight) {
        pending = null // the running rename already carries what is wanted
        return
      }
      if (inFlight !== null) {
        pending = title
        return
      }
      if (title === opts.title()) return
      start(title)
    },
    current: () => ({ inFlight, pending }),
  }
}
