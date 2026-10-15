// The release of an issue that shows as active with no live step (docs/factory-loop/v2/SPEC.md
// 6.4), shared by R1 (reconcile.ts) and the one-shot migration (bin/factory-reconcile): stop any
// agent of the loop on it, remove its factory labels (the migration also `In development`), free
// its slot, then log `reclaimed` (labelled ready) or `abandoned`, last, with the release's
// fields. Its keys are i<N>/reconcile/<claim time>/<op> (keys.ts).
//
// STUB of build unit U1. U3 fills it; until then a release plans nothing.
import type { Action } from '../types'

export type ReleaseInput = {
  issue: number
  // the claim's time, base-36 seconds (keys.ts lifeOf): what the release's keys are scoped to
  claim: string
  // still labelled ready: back to the queue (reclaimed); else it leaves the factory (abandoned)
  ready: boolean
  stage: string
  // what was checked, for the event's reason: `no live step in <stage>: <checked>`
  checked: string
  branch: string | null
  pr: number | null
  // the loop's agents still listed on it, and the loop slot leased for it
  agents: string[]
  slot: { path: string; lease: string } | null
}

export function releaseActions(_input: ReleaseInput): Action[] {
  return []
}
