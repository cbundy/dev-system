// The records rebuilt from this device's `transition` events (docs/factory-loop/v2/SPEC.md 3.3):
// the newest per issue over REBUILD_DAYS, every record field read from it. Act mode rebuilds when
// the store holds no records; observe mode and the shadow read the store's, else this.
//
// STUB of build unit U1. U2 fills it (the query, in the event format of U4's events.ts, and
// recordsFromEvents); until then there is no rebuild query and nothing is rebuilt.
import type { FactoryEvent } from '../derive'
import type { IssueRecord } from './types'

export const REBUILD_DAYS = 90

// The dev-query SQL that reads the events a rebuild needs, with the variables repo, device, at and
// days; null: no rebuild yet.
export const REBUILD_SQL: string | null = null

export function recordsFromEvents(_events: readonly FactoryEvent[], _device: string): IssueRecord[] {
  return []
}
