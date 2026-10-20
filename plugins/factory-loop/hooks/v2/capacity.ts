// The memory ceiling on the issues the loop holds at once (docs/factory-loop/v2/SPEC.md 13.4.2):
// the container's memory less a reserve, over the memory one slot is estimated to use, bounds
// `maxInFlightIssues`. Pure: the container's memory is read once per process (config.ts
// gateLimits, which parses it) and the estimate comes from the companion's gate lines.
import { want, wake } from '../foundation'
import type { Config } from '../types'
import type { GateLine } from './sources-interventions'
import type { V2Ctx } from './types'

const MIB = 1024 * 1024
const GIB = 1024 * MIB

// The memory one slot is assumed to use until enough gate runs are measured: the agent session plus
// one full stop gate. 3 GiB is the plant-console figure: a 12.9 GB container held 3 slots at a time
// without an OOM kill.
export const DEFAULT_SLOT_MEMORY_MIB = 3072
// the measured runs `auto` needs before it trusts them over the default
export const MIN_MEASURED_RUNS = 3

export type EstimateSource = 'setting' | 'measured' | 'default'

// What bounds the cap now: the setting (maxInFlightIssues), the memory ceiling, or neither.
export type CapBound = 'setting' | 'memory' | null

export type CapInfo = {
  effective: number | null
  configured: number | null
  ceiling: number | null
  memoryBytes: number | null
  estimateBytes: number
  estimateSource: EstimateSource
  bound: CapBound
}

// slotEstimate: the bytes one slot is assumed to use and where that came from. A set number wins;
// `auto` is the p90 (nearest rank) of memPeakBytes - memStartBytes over the gate runs that carry
// both, each run once (issue, life, seq, startedAt), once MIN_MEASURED_RUNS exist.
export function slotEstimate(setting: 'auto' | number, gates: readonly GateLine[] | undefined): { bytes: number; source: EstimateSource } {
  if (setting !== 'auto') return { bytes: setting * MIB, source: 'setting' }
  const runs = new Map<string, number>()
  for (const g of gates ?? []) {
    if (g.memStartBytes === null || g.memPeakBytes === null) continue
    const added = g.memPeakBytes - g.memStartBytes
    // a run that added no memory measures nothing
    if (added <= 0) continue
    runs.set(`${g.issue}/${g.life}/${g.seq}/${g.startedAt ?? ''}`, added)
  }
  if (runs.size < MIN_MEASURED_RUNS) return { bytes: DEFAULT_SLOT_MEMORY_MIB * MIB, source: 'default' }
  const sorted = [...runs.values()].sort((a, b) => a - b)
  return { bytes: sorted[Math.ceil(0.9 * sorted.length) - 1] ?? DEFAULT_SLOT_MEMORY_MIB * MIB, source: 'measured' }
}

// memoryCeiling: how many slots fit: max(1, floor((memory - reserve) / estimate)); null: no memory read.
export function memoryCeiling(memoryBytes: number | null, reserveBytes: number, estimateBytes: number): number | null {
  if (memoryBytes === null) return null
  return Math.max(1, Math.floor((memoryBytes - reserveBytes) / estimateBytes))
}

// effectiveCap: min(maxInFlightIssues, ceiling), a null on either side dropping that side. A
// configured 0 stays 0.
export function effectiveCap(config: Pick<Config, 'maxInFlightIssues' | 'slotMemoryMiB' | 'memoryReserveMiB'>, memoryBytes: number | null, gates: readonly GateLine[] | undefined): CapInfo {
  const est = slotEstimate(config.slotMemoryMiB, gates)
  const configured = config.maxInFlightIssues
  const ceiling = memoryCeiling(memoryBytes, config.memoryReserveMiB * MIB, est.bytes)
  const effective = configured === null ? ceiling : ceiling === null ? configured : Math.min(configured, ceiling)
  const bound: CapBound = effective === null ? null : configured !== null && effective === configured ? 'setting' : 'memory'
  return { effective, configured, ceiling, memoryBytes, estimateBytes: est.bytes, estimateSource: est.source, bound }
}

// capOf: the pass's cap, worked out once from the container's memory and the companion's gate lines.
export function capOf(ctx: V2Ctx): CapInfo {
  ctx.cap ??= effectiveCap(ctx.config, ctx.v2.memoryBytes ?? null, ctx.v2.interventions.gates)
  return ctx.cap
}

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`

// capText: what the skip reason of a held claim or lease says: `capacity: 3 of 3 queued or in
// flight`, and when the memory ceiling is the bound, why.
export function capText(cap: CapInfo, counted: number, what: 'queued or in flight' | 'in flight'): string {
  const head = `capacity: ${counted} of ${cap.effective} ${what}`
  if (cap.bound !== 'memory' || cap.memoryBytes === null) return head
  return `${head} (memory ceiling: ${gib(cap.memoryBytes)}, ${gib(cap.estimateBytes)} per slot, ${cap.estimateSource})`
}

// capacityTell: the owner told once per (configured, ceiling) pair that maxInFlightIssues is above
// what the container's memory holds. Not an owner item: the loop runs at the lower cap by itself.
export function capacityTell(ctx: V2Ctx): void {
  const cap = capOf(ctx)
  if (cap.configured === null || cap.ceiling === null || cap.memoryBytes === null || cap.configured <= cap.ceiling) return
  const reserve = ctx.config.memoryReserveMiB * MIB
  want(
    ctx,
    wake('tell', 'capacity', `tell:capacity:${cap.configured}:${cap.ceiling}`, 'S1', null, { configured: cap.configured, ceiling: cap.ceiling, effective: cap.effective }, [
      `maxInFlightIssues is ${cap.configured}, but the container's memory (${gib(cap.memoryBytes)}) less the ${gib(reserve)} reserve holds ${cap.ceiling} at ${gib(cap.estimateBytes)} per slot (${cap.estimateSource}).`,
      `The loop holds at most ${cap.effective} issues at once. Raise the container's memory, or set slotMemoryMiB or memoryReserveMiB, to change that.`,
    ]),
  )
}
