// The stop gate's turns (docs/factory-loop/v2/SPEC.md 10.6), pure: a FIFO semaphore that lets at most
// `capacity` holders run at once. register.ts keeps one for the whole process, so every slot's writer
// shares it. No I/O: the clock and the timer are injected (the strict lib has no setTimeout, so the
// timer wraps $.clock.after).

export type TurnIo = {
  now: () => number | Promise<number>
  // a timer that calls fn after ms; cancel stops it
  after: (ms: number, fn: () => void) => { cancel: () => void }
  // the longest a waiter waits for a turn
  maxWaitMs: number
  // optional: one slice of waiting that holds a host call, so the engine's handler budget (which host
  // calls pause and clock ops do not) does not run while queued. The wait calls it again as each
  // slice ends; a rejection ends the calls and the wait goes on with the grant alone. Absent: the
  // wait is the grant and the cap timer only.
  idle?: () => Promise<unknown>
}

// A turn taken (release gives it back, once: a second call does nothing), or the wait ran past its
// cap and the waiter left the queue for good. queuedBehind: how many held a turn or waited ahead when it
// asked, in both cases.
export type Turn = { ok: true; waitMs: number; queuedBehind: number; release: () => void } | { ok: false; waitMs: number; queuedBehind: number }

type Waiter = { capacity: number; grant: () => void }

export type Turns = {
  acquire: (capacity: number, io: TurnIo) => Promise<Turn>
  // for a test: the turns held and the waiters queued
  state: () => { held: number; waiting: number }
}

export function createTurns(): Turns {
  let held = 0
  const queue: Waiter[] = []

  // admit: hands turns to the queue's head while it fits under its own capacity, in order
  const admit = () => {
    for (let w = queue[0]; w !== undefined && held < w.capacity; w = queue[0]) {
      queue.shift()
      held++
      w.grant()
    }
  }

  const releaser = () => {
    let done = false
    return () => {
      if (done) return
      done = true
      held--
      admit()
    }
  }

  return {
    state: () => ({ held, waiting: queue.length }),
    async acquire(capacity, io) {
      // the decision is made before anything is awaited, so arrivals keep their order
      if (queue.length === 0 && held < capacity) {
        held++
        return { ok: true, waitMs: 0, queuedBehind: 0, release: releaser() }
      }
      const queuedBehind = held + queue.length
      const t0 = Promise.resolve(io.now())
      let settle: (granted: boolean) => void = () => undefined
      const outcome = new Promise<boolean>(resolve => {
        settle = resolve
      })
      const waiter: Waiter = { capacity, grant: () => settle(true) }
      queue.push(waiter)
      const timer = io.after(io.maxWaitMs, () => {
        const at = queue.indexOf(waiter)
        // already granted: its turn is held, the cap no longer applies
        if (at < 0) return
        queue.splice(at, 1)
        settle(false)
      })
      let idle = io.idle
      if (idle !== undefined) {
        let over = false
        const done = outcome.then(() => {
          over = true
        })
        while (!over && idle !== undefined) {
          try {
            await Promise.race([done, idle()])
          } catch {
            // a failing slice must not spin: the rest of the wait is the grant alone
            idle = undefined
          }
        }
      }
      const granted = await outcome
      timer.cancel()
      // a granted turn is held already: if reading the clock fails it goes back, never leaks
      const release = granted ? releaser() : () => undefined
      try {
        const waitMs = Math.max(0, (await io.now()) - (await t0))
        return granted ? { ok: true, waitMs, queuedBehind, release } : { ok: false, waitMs, queuedBehind }
      } catch (err) {
        release()
        throw err
      }
    },
  }
}
