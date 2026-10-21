// Vocabulary that v2/types.ts re-exports (kept apart so that file stays under the size guard): the
// default branch's reading (sources-main.ts, the schema main_state.v1) and the interventions' who and
// cause families (v2 SPEC 7.2). Types and constants only.

// --- interventions (v2 SPEC 7.2) ---------------------------------------------------------------------

export type InterventionWho = 'person' | 'loop' | 'judge'

// The cause families; `op:<name>`, `unknown:<why>`, `free:<cause>`, `fix:<what>`, `queue:<what>`
// and `guard:<what>` take their suffix from the lists above or the op's name.
export const PERSON_CAUSES = ['op', 'unpark', 'push', 'hand-merge', 'pr-closed', 'issue-closed', 'control-file', 'config-file', 'restart', 'reconcile', 'unreject', 'rescue', 'hold'] as const
export const LOOP_CAUSES = [
  'triage', 'unknown', 'free', 'park', 'fix', 'ci-rerun', 'queue', 'guard', 'gate-unknown', 'prompt-denied', 'tripwire', 'breaker', 'stalled', 'workspace', 'reconcile', 'rejected', 'reclaim', 'wake',
] as const

// The newest completed run of a workflow on the default branch (sources-main.ts).
export type MainRun = { id: number; attempt: number; head: string; event: string; conclusion: string }
// One active workflow as the main read showed it: its newest completed run (null: none) and whether
// a newer run is queued or in progress.
export type MainWorkflow = { id: number; name: string; run: MainRun | null; running: boolean }
// The newest deployment of an environment at the head, and its newest status (null: none).
export type MainDeployment = { environment: string; id: number; state: string | null }
// What one read of the default branch showed (sources-main.ts, the schema main_state.v1): when (ISO, 3 ms digits), the
// branch and its head, the merged PR the head came from, the workflows and the deployments.
export type MainReading = { observedAt: string; branch: string; head: string; pr: number | null; workflows: MainWorkflow[]; deployments: MainDeployment[] }
