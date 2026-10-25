// The merge train's vocabulary (docs/factory-loop/v2/SPEC.md 9.8): the action and outcome types
// v2/types.ts imports, kept here so that file stays under its line cap, and the closed lists they
// use. Types and constants only.
import type { ActionBase, Ms, Source } from '../types'
import type { CheckRun } from './sources-prs'

// Why a train is dropped (9.8): the reasons callum-flow-merge records on the `merged` event
// (`--train-dropped`, `train_reason`), in this order.
export const TRAIN_DROPS = ['head-moved', 'outside-merge', 'conflict', 'train-red', 'left-queue', 'tree-mismatch', 'refused'] as const
export type TrainDrop = (typeof TRAIN_DROPS)[number]

// How a train ends: dropped for a reason, or merged (the record behind the head merged on it).
export type TrainEnd = TrainDrop | 'merged'

// The branch prefix of every train branch on origin: nothing else lives under it, so the sweep may
// delete whatever it finds there that no live train names.
export const TRAIN_PREFIX = 'factory-train/'

// What a train build asks of its executor (act-train.ts): the record behind the head (issue, pr, its
// branch and head `rider`) rides on the head (headIssue, headPr, headBranch, the head H' = `head`)
// and main as the plan read them. `at`: the commit's date is fixed (see act-train.ts), not this.
export type TrainBuild = {
  op: 'build'
  pr: number
  branch: string
  rider: string
  headIssue: number
  headPr: number
  headBranch: string
  head: string
  main: string
}

// delete: the train branch of a train that ended, with how it ended; sweep: every train branch on
// origin but the ones `keep` names, planned each window and for the stale refs a crash left.
export type TrainDelete = { op: 'delete'; branch: string; end: TrainEnd }
export type TrainSweep = { op: 'sweep'; keep: string[] }

export type TrainAction = ActionBase & { kind: 'queue-train' } & (TrainBuild | TrainDelete | TrainSweep)

// What the executor records. build: the tree T of merge-tree(head, rider), the train commit's sha and
// branch, and the three shas it was built from; `drop` instead of a train when it could not be built
// (head-moved: a branch is no longer at the sha the plan read; conflict: merge-tree found one).
// delete and sweep: the branches removed and, for a sweep, those kept.
export type TrainOutcome =
  | { kind: 'train'; op: 'build'; tree: string | null; train: string | null; branch: string | null; headIssue: number; head: string; rider: string; main: string; drop: TrainDrop | null }
  | { kind: 'train'; op: 'delete'; branch: string; end: TrainEnd }
  | { kind: 'train'; op: 'sweep'; removed: string[]; kept: string[] }

// The train source's reading (sources-train.ts), kept only while a train is live: the checks of each
// train commit (null: not read) and the tree of each commit the rules compare (a commit's tree
// never changes, so one read stands), and when it was read.
export type TrainRead = { checks: Record<string, CheckRun[] | null>; trees: Record<string, string | null>; at: Ms | null; source: Source }
export const EMPTY_TRAIN: TrainRead = { checks: {}, trees: {}, at: null, source: { ok: true, at: null } }
