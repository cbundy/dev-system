import type { EngineInterface } from 'claude-code'

import type { Ms } from './types'

// within: the work, or a rejection once ms pass on $.clock.
export function within<T>($: EngineInterface, ms: Ms, work: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = $.clock.after(ms, () => reject(new Error(`${what}: no answer within ${ms / 1000} s`)))
    work.then(
      v => {
        t.cancel()
        resolve(v)
      },
      err => {
        t.cancel()
        reject(err)
      },
    )
  })
}
