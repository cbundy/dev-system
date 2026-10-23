// The memory a stop gate adds, sampled from the container's cgroup (v2 SPEC 10.6; gate_run.v1
// mem_* fields). A measurement only: nothing here throws, and a reading that fails counts no
// sample. memory.peak is not used: it holds the container's lifetime peak, not this run's.

// the cgroup directory unless FACTORY_GATE_CGROUP_DIR (a test hook, like heartbeat-loop's
// HEARTBEAT_CGROUP_DIR) names another
export const DEFAULT_CGROUP_DIR = '/sys/fs/cgroup'
export const SAMPLE_EVERY_MS = 5_000

// parseCurrent: memory.current's bytes, or null for anything that is not a non-negative safe integer.
export function parseCurrent(text: string | null): number | null {
  if (text === null) return null
  const t = text.trim()
  if (!/^[0-9]+$/.test(t)) return null
  const n = Number(t)
  return Number.isSafeInteger(n) ? n : null
}

// parseMax: memory.max's bytes; null for "max" (no limit) and for a missing or bad file.
export const parseMax = parseCurrent

export type MemReading = { current: string | null; max: string | null }
export type MemFields = { memStartBytes: number | null; memPeakBytes: number | null; memLimitBytes: number | null; memSamples: number }

export type MemoryIo = {
  read: () => Promise<MemReading>
  every: (ms: number, fn: () => void) => { cancel: () => void }
}

// startMemorySampler: reads once now, then every SAMPLE_EVERY_MS until stop(), which cancels the
// timer, reads once more and returns the start, the peak, the limit and the sample count.
export async function startMemorySampler(io: MemoryIo): Promise<{ stop: () => Promise<MemFields> }> {
  let start: number | null = null
  let peak: number | null = null
  let limit: number | null = null
  let samples = 0
  let stopped = false
  const sample = async (): Promise<void> => {
    let r: MemReading | null
    try {
      // the engine bounds a host read itself; a throw is a reading that failed
      r = await io.read()
    } catch {
      r = null
    }
    if (r === null) return
    const cur = parseCurrent(r.current)
    if (cur === null) return
    samples++
    if (start === null) start = cur
    if (peak === null || cur > peak) peak = cur
    limit = parseMax(r.max) ?? limit
  }
  await sample()
  let timer: { cancel: () => void } | null = null
  try {
    timer = io.every(SAMPLE_EVERY_MS, () => {
      if (!stopped) void sample()
    })
  } catch {
    timer = null
  }
  let result: MemFields | null = null
  return {
    stop: async () => {
      if (result !== null) return result
      stopped = true
      try {
        timer?.cancel()
      } catch {
        // a timer that will not cancel must not fail the gate
      }
      await sample()
      result = { memStartBytes: start, memPeakBytes: peak, memLimitBytes: limit, memSamples: samples }
      return result
    },
  }
}
