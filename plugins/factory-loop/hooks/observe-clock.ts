// The observe split (#1131): of the wall time of a pass's observe call, how much had at least one
// read in flight (the union of the reads' intervals, so reads that overlap are counted once) and
// how much was the loop's own work. Pure: the clock is a parameter, so tests use a fake one.
import type { Io } from './observe'

export type ObserveSplit = { ms: number; commandsMs: number; inProcessMs: number }

export type ObserveClock = {
  // io, with each run, readFile and sessionLimits counted while it is in flight
  io: Io
  // the split of the window start..end (both on `now`'s clock): the reads still in flight at end count up to it
  split: (start: number, end: number) => ObserveSplit
}

export function clocked(io: Io, now: () => number): ObserveClock {
  let inflight = 0
  let since = 0
  let busy = 0
  const track = async <T>(work: () => Promise<T>): Promise<T> => {
    if (inflight++ === 0) since = now()
    try {
      return await work()
    } finally {
      if (--inflight === 0) busy += now() - since
    }
  }
  return {
    io: {
      ...io,
      run: (argv, init) => track(() => io.run(argv, init)),
      readFile: path => track(() => io.readFile(path)),
      sessionLimits: () => track(() => io.sessionLimits()),
    },
    split: (start, end) => {
      const ms = Math.max(0, end - start)
      const commandsMs = Math.min(ms, busy + (inflight > 0 ? Math.max(0, end - since) : 0))
      return { ms, commandsMs, inProcessMs: Math.max(0, ms - commandsMs) }
    },
  }
}
