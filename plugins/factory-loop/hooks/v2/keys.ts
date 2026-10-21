// The v2 ledger key families (docs/factory-loop/v2/SPEC.md appendix C), built here alone so every
// unit names a fact the same way. v2 keys are slash-separated and scoped to an issue's life, so
// they never collide with v1's colon-separated ones (2.3); the families v2 reuses from v1
// (heartbeat, sweep, tell, restart, the release task) keep v1's keys. A life is the claim's time
// in base-36 seconds (3.3): unique per life, and no counter that pruning could reset. Hashes
// (a patch id, a head, main's head) appear as their first seven characters. Pure.
import type { Ms } from '../types'
import type { AgentStep, RecordRef } from './types'

// lifeOf: the life a claim made at this time names, base-36 seconds.
export function lifeOf(at: Ms): string {
  return Math.floor(at / 1000).toString(36)
}

// lifeAt: when a life began (its claim's time, to the second), or null for no life.
export function lifeAt(life: string): Ms | null {
  if (!/^[0-9a-z]+$/.test(life)) return null
  const s = parseInt(life, 36)
  return Number.isSafeInteger(s) ? s * 1000 : null
}

// scratchOf: a step attempt's scratch folder, <loop dir>/scratch/<N>-<life>-s<seq>. The only TS source
// of the name; bin/factory-slot derives the same one and refuses a marker that names another.
export function scratchOf(loopDir: string, issue: number, life: string, seq: number): string {
  return `${loopDir}/scratch/${issue}-${life}-s${seq}`
}

// short: a hash as keys carry it.
export function short(sha: string): string {
  return sha.slice(0, 7)
}

type Life = Pick<RecordRef, 'issue' | 'life'>

// lifeKey: the prefix of every key of one life: i<N>/l<life>.
export function lifeKey(r: Life): string {
  return `i${r.issue}/l${r.life}`
}

// seqKey: the prefix of every key of one seq of a life: i<N>/l<life>/s<seq>.
export function seqKey(r: RecordRef): string {
  return `${lifeKey(r)}/s${r.seq}`
}

// gateRunKey: one stop gate run of a seq, by when it asked for its turn (ms since the epoch, base 36).
export function gateRunKey(r: RecordRef, startedAtMs: number): string {
  return `${seqKey(r)}/gate/${startedAtMs.toString(36)}`
}

// mainKey: a change in the state of the default branch, from the last state logged to this one
// (rules-main.ts): main/<last>/<current>, each a state key (`none` before the first).
export function mainKey(last: string, current: string): string {
  return `main/${last}/${current}`
}

// releasedKey: a release tag logged (rule O4): released:<repo>:<tag>. The tag is the third segment.
export function releasedKey(repo: string, tag: string): string {
  return `released:${repo}:${tag}`
}

// milestoneStateKey: a change in the milestone's reading (rule O5): milestone-state/<fingerprint of the
// reading>/<base-36 end of the newest done entry, or 0>, so the ledger makes each change once and a
// reading that comes back is logged again.
export function milestoneStateKey(fingerprint: string, lastEndedAt: number): string {
  return `milestone-state/${fingerprint}/${lastEndedAt.toString(36)}`
}

// claimKey: a life's claim, i<N>/claim/<life>; the life is the claim's own time.
export function claimKey(issue: number, life: string): string {
  return `i${issue}/claim/${life}`
}

// reclaimKey: a lapsed claim claimed again onto the record (4.1), at its own time.
export function reclaimKey(r: Life, at: string): string {
  return `${lifeKey(r)}/claim/${at}`
}

// transitionKey: the one transition of a seq (4.6).
export function transitionKey(r: RecordRef): string {
  return `${seqKey(r)}/t`
}

// The entry actions of a seq (4.5): its label, the old steps' stops (each keyed
// stop/<the old step's key within the life>) and the kill, the park's comment, its events by
// state, and its tell. A wait's links are keyed link/<blocker> (entryKey).
export type EntryAction = 'label' | 'stop' | 'kill' | 'comment' | 'tell' | `event/${string}`

export function entryKey(r: RecordRef, action: EntryAction | `link/${number}`): string {
  return `${seqKey(r)}/${action}`
}

// stepKey: one attempt of an agent step (a step key is one attempt; the table retries steps).
export function stepKey(r: RecordRef, step: AgentStep, attempt: number): string {
  return `${seqKey(r)}/${step}/a${attempt}`
}

// prepareKey: the slot's preparation for one attempt (10.2), part of the attempt.
export function prepareKey(r: RecordRef, attempt: number): string {
  return `${seqKey(r)}/prepare/a${attempt}`
}

// reviewKey: a review of one patch in one round (8.4), whatever the head or the seq.
export function reviewKey(r: Life, patch: string, round: number, attempt: number): string {
  return `${lifeKey(r)}/review/${short(patch)}/r${round}/a${attempt}`
}

// reviewPrepareKey: the slot's own preparation for a reviewer that is not its seq's first (a push
// changed the patch under review, 8.4): the seq's prepare was for the old head. It ends like
// prepareKey, so it is part of its attempt.
export function reviewPrepareKey(r: RecordRef, patch: string, round: number, k: number, attempt: number): string {
  return `${seqKey(r)}/review/${short(patch)}/r${round}/a${k}/prepare/a${attempt}`
}

// prKey: the PR's ensure, once per seq, or a body re-render, once per queue attempt (8.1).
export function prKey(r: RecordRef, op: 'ensure' | 'body', attempt = 1): string {
  return op === 'ensure' ? `${seqKey(r)}/pr/ensure` : `${seqKey(r)}/pr/body/a${attempt}`
}

// childKey: one child of a split (8.7), by the designer's key for it.
export function childKey(r: RecordRef, child: string): string {
  return `${seqKey(r)}/child/${child}`
}

// rerunKey: the one re-run of a failed check per round (8.5), by its run id.
export function rerunKey(r: Life, round: number, runId: string): string {
  return `${lifeKey(r)}/rerun/r${round}/${runId}`
}

// refusedProbeKey and refusedGoKey: the re-runs of a run GitHub refused to start (rules-refused.ts, 8.5): the
// probe of period k of a refusal spell, and the one re-run once Actions runs again. Neither matches
// the round's rerunKey, which stays free for a real failure afterwards.
export function refusedProbeKey(r: Life, runId: string, k: number): string {
  return `${lifeKey(r)}/refused/${runId}/p${k}`
}

export function refusedGoKey(r: Life, runId: string): string {
  return `${lifeKey(r)}/refused/${runId}/go`
}

// refusedKeyOf: 'probe' or 'go' for the rest of a refused run's key (after the life), else null.
export function refusedKeyOf(rest: string): 'probe' | 'go' | null {
  const m = /^refused\/\d+\/(p\d+|go)$/.exec(rest)
  return m === null ? null : m[1] === 'go' ? 'go' : 'probe'
}

// queueKey: Q1's update, by main's head at plan time, or Q2's merge, by the PR's head (9.2, 9.3).
export function queueKey(r: Life, op: 'update' | 'merge', sha: string): string {
  return `${lifeKey(r)}/queue/${op}/${short(sha)}`
}

// leaseKey: the life's n-th lease (W1); freeKey: a lease's free (W2), whoever held it.
export function leaseKey(r: Life, n: number): string {
  return `${lifeKey(r)}/lease/${n}`
}

export function freeKey(lease: string): string {
  return `slot/${lease}/free`
}

// followKey: a closed record's follow-up (4.5): rollout, close-issue, milestone-later,
// release-parent, merged.
export function followKey(r: Life, name: string): string {
  return `${lifeKey(r)}/follow/${name}`
}

// reconcileKey: one action of a release (6.4), scoped to the claim it releases.
export function reconcileKey(issue: number, claim: string, op: string): string {
  return `i${issue}/reconcile/${claim}/${op}`
}

// interventionKey: the intervention of the fact under this key, logged once (7.2).
export function interventionKey(fact: string): string {
  return `iv/${fact}`
}

// factKey: the key of a fact with no key of its own: <cause>/<subject>/<at>, as in push/i571/ss3b0c.
export function factKey(cause: string, subject: string, at: string): string {
  return `${cause}/${subject}/${at}`
}

// keyParts: the issue, life and seq a life-scoped key names, and the rest; null for any other key.
export function keyParts(key: string): { issue: number; life: string; seq: number | null; rest: string } | null {
  const m = /^i([1-9]\d*)\/l([0-9a-z]+)(?:\/s(\d+))?(?:\/(.*))?$/.exec(key)
  if (m === null || m[1] === undefined || m[2] === undefined) return null
  return { issue: Number(m[1]), life: m[2], seq: m[3] === undefined ? null : Number(m[3]), rest: m[4] ?? '' }
}

// hiddenKey: the marker a comment carries, by which a retry finds it, and by which the unpark
// finds the park's comment (park-text.ts).
export function hiddenKey(key: string): string {
  return `<!-- factory-loop:${key} -->`
}

// --- flake bugs (rules-flake-bugs.ts, appendix C) ----------------------------------------------------------

// flakeBugKey: the bug filed for a test, by the first flake of the test in the window.
export function flakeBugKey(hash: string, firstFlake: string): string {
  return `flake-bug/${hash}/${firstFlake}`
}

// flakeCommentKey: the comment (and the body's hidden marker) for one flake of a test on its bug.
export function flakeCommentKey(hash: string, flake: string): string {
  return `flake-bug/${hash}/c/${flake}`
}

// flakeMarker: the marker a flake bug's body carries, which finds it again by the test's hash: the
// hidden key of `flake:<hash>`.
export function flakeMarker(hash: string): string {
  return hiddenKey(`flake:${hash}`)
}

// The intake stamp's keys (I1): one run per issue and body version, and the one settle of a run that
// never ended. Neither names a life: a stamp belongs to the body, not to a claim.
export function intakeKey(issue: number, version: string): string {
  return `intake/${issue}/${version}`
}

export function intakeSettleKey(issue: number, version: string): string {
  return `${intakeKey(issue, version)}/settle`
}

// intakeRunOf: the issue and version a run's key names (not a settle's); null for any other key.
export function intakeRunOf(key: string): { issue: number; version: string } | null {
  const m = /^intake\/([1-9][0-9]*)\/([0-9a-f]{16})$/.exec(key)
  return m === null ? null : { issue: Number(m[1]), version: m[2] ?? '' }
}
