// The labels an ok intake stamp sets (docs/factory-loop/v2/SPEC.md 13.4, epic #995): `area:<area>`, and
// `needs-decision` when the reader says the issue needs the owner. The owner wins, group by group (area,
// needs-decision). A group is the owner's, and the loop never touches it again on that issue, when
//
//  1. the issue's labels in the group differ from the ones the loop last stored for it (the owner added,
//     removed or changed one), or
//  2. on the first stamp, the issue already carries a label of the group.
//
// The loop removes only a label it set itself (an area that changed on a new body version, or
// needs_owner turning false). Pure; the executor runs the commands (act-intake.ts).
import type { LabelGroup, Stamp } from './stamps'

export const AREA_PREFIX = 'area:'
export const NEEDS_DECISION = 'needs-decision'

// What a label the loop makes looks like, when the repo lacks it.
export const AREA_LABEL = { color: 'c5def5', description: 'Factory loop: the area the intake reader put the issue in' }
export const NEEDS_DECISION_LABEL = { color: 'fbca04', description: 'Factory loop: the intake reader found the issue waits on an owner decision' }

export const labelAreaOf = (area: string) => `${AREA_PREFIX}${area}`
const lower = (l: string) => l.toLowerCase()
const inGroup = (group: LabelGroup, label: string) => (group === 'area' ? lower(label).startsWith(AREA_PREFIX) : lower(label) === NEEDS_DECISION)
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(x => b.some(y => lower(x) === lower(y)))
const has = (list: readonly string[], label: string) => list.some(l => lower(l) === lower(label))

export type LabelInput = {
  // the issue's labels now
  current: readonly string[]
  // the stamp before this one, null on the first
  prev: Stamp | null
  // the groups the owner already holds
  owned: readonly LabelGroup[]
  area: string
  needsOwner: boolean
}

export type LabelPlan = {
  // to put on, to take off (only labels the loop set), what the new stamp records as the loop's, the
  // owner's labels left alone, and the groups owned now (all of them, those held before included)
  add: string[]
  remove: string[]
  stored: string[]
  kept: string[]
  owned: LabelGroup[]
}

export function planLabels(i: LabelInput): LabelPlan {
  const plan: LabelPlan = { add: [], remove: [], stored: [], kept: [], owned: [] }
  for (const group of ['area', 'needs-decision'] as const) {
    const present = i.current.filter(l => inGroup(group, l))
    const before = (i.prev?.labels ?? []).filter(l => inGroup(group, l))
    const desired = group === 'area' ? [labelAreaOf(i.area)] : i.needsOwner ? [NEEDS_DECISION] : []
    const theirs = i.owned.includes(group) || (i.prev === null ? present.length > 0 : !sameSet(present, before))
    if (theirs) {
      plan.owned.push(group)
      plan.kept.push(...present)
      continue
    }
    plan.add.push(...desired.filter(l => !has(present, l)))
    plan.remove.push(...before.filter(l => !has(desired, l) && has(present, l)))
    plan.stored.push(...desired)
  }
  return plan
}
