// The entry actions of a record's seq (docs/factory-loop/v2/SPEC.md 4.5), which S3 plans until
// each is done: the seq's `transition` event first (after a close's `merged`); the old step
// stopped and the slot's processes killed when the old seq's step still ran, both best effort;
// the new state's label; the event the state logs on entry; a park's comment and tell; a close's
// label clear and its follow-ups by why. The ledger is the outbox (3.3): each is a keyed
// action of the new seq, so a crash after the record's store write leaves them planned on the next
// pass.
//
// - A seq whose transition entry the ledger no longer holds (a record rebuilt from events, or one
//   pruned after 7 days) has nothing left to do.
// - A seq's step starts only after its entry actions are done (tell excepted); a best-effort one
//   is done once it ended, however it ended.
// - An effect that used up its attempts holds its record (stalledOf): the skip line names it, the
//   owner hears once, and `/factory retry N` clears it (D-38).
//
// Pure.
import { gate, wake } from '../foundation'
import type { Action, LedgerEntry } from '../types'
import { entryKey, followKey, keyParts, lifeAt, lifeKey, lifeOf, seqKey, transitionKey } from './keys'
import { fixWhyOf, lifeEntries } from './rules-agent'
import { ENTRY_EVENTS, TABLE } from './table'
import { ALL_FACTORY_LABELS, labelOf, resumeStep } from './types'
import type { EmitState, IssueRecord, Lease, V2Ctx } from './types'

// One entry action: soft ones are best effort (a stop, a kill), and a tell never holds the step.
export type EntryItem = { action: Action; soft: boolean; tell: boolean }

const RULE = 'S3'
// the entry action and the slot op that end the old step's processes (10.8): a name, not a command
const KILL = 'kill' as const

function base(r: IssueRecord, key: string, reason: string) {
  return { key, class: 'free' as const, rule: RULE, reason, issue: r.issue }
}

// The transition entry of the record's current seq, and what it recorded. The entry carries the
// row, the state it left and the via code from its start (ledger.ts start), so a crash after the
// records store took the seq but before the entry was saved done (the entry is then lost) keeps
// them, and the seq's events and park comment are not lost (3.3, failures/F12, totality/T-05).
function transitionOf(ctx: V2Ctx, r: IssueRecord): { entry: LedgerEntry; row: string | null; from: IssueRecord['state'] | null; via: string | null } | null {
  const entry = ctx.byKey.get(transitionKey(r))
  if (entry === undefined) return null
  const o = entry.outcome?.kind === 'transition' ? entry.outcome : null
  return { entry, row: o?.row ?? null, from: o?.from ?? null, via: o?.via ?? null }
}

// oldSteps: the agent steps of this life an earlier seq started that still run (10.8), by time:
// anything started before this seq's transition belongs to an earlier seq, whatever its key's
// shape (a review key names the patch and round, not the seq, keys.ts reviewKey).
function oldSteps(ctx: V2Ctx, r: IssueRecord): LedgerEntry[] {
  return lifeEntries(ctx, r, 'agent-step').filter(e => e.status === 'running' && (e.startedAt < r.seqAt || (keyParts(e.key)?.seq ?? r.seq) < r.seq))
}

// stopKey: the entry action that stops one old step's agent, by that step's key within the life.
// The review step stops a reviewer of a patch the head no longer has under the same key
// (rules-review.ts), so this seq's entry actions then wait for that stop too.
export function stopKey(r: IssueRecord, step: string): string {
  return `${entryKey(r, 'stop')}/${step.slice(lifeKey(r).length + 1)}`
}

// stops: the seq's stop-agent actions: one for each old step whose agent still runs, and each one
// planned before, so the step waits until every one has ended (4.5).
function stops(ctx: V2Ctx, r: IssueRecord): Action[] {
  const out = new Map<string, Action>()
  const add = (key: string, agentId: string, entry: string) => {
    out.set(key, { ...base(r, key, 'the step of the seq before still runs'), kind: 'stop-agent', agentId, entry })
  }
  for (const e of oldSteps(ctx, r)) if (e.agentId !== undefined) add(stopKey(r, e.key), e.agentId, e.key)
  const prefix = `${entryKey(r, 'stop')}/`
  for (const e of ctx.state.ledger) {
    if (e.kind !== 'stop-agent' || !e.key.startsWith(prefix) || out.has(e.key)) continue
    const step = `${lifeKey(r)}/${e.key.slice(prefix.length)}`
    add(e.key, ctx.byKey.get(step)?.agentId ?? '', step)
  }
  return [...out.values()]
}

// mergedLogged: the factory already holds a `merged` event of this life for the PR: the issue's
// stage is merged since the life began (a `merged` event outranks a later `closed`,
// docs/factory-state.md "Source precedence"). Read only at the close, before the seq's own
// transition is planned, so that transition never shows as the merge (mergedItem).
function mergedLogged(ctx: V2Ctx, r: IssueRecord): boolean {
  const view = ctx.state.issues.find(i => i.number === r.issue)
  const since = view?.stageSince ?? null
  return view?.stage === 'merged' && since !== null && since >= (lifeAt(r.life) ?? 0)
}

// heldByOther: another device holds a live claim on the issue: its labels are the winner's, so a
// close clears none of them (3.4, callum-flow-claim).
function heldByOther(ctx: V2Ctx, r: IssueRecord): boolean {
  const holder = ctx.state.issues.find(i => i.number === r.issue)?.holder ?? null
  return holder !== null && holder !== ctx.state.device
}

// emitted: an event the seq logs beside `transition`, with the note today's queries read.
function emitted(ctx: V2Ctx, r: IssueRecord, state: EmitState): Action {
  const note = state === 'delegated' ? `brief ${r.brief ?? 'none'}` : state === 'fix_requested' ? (fixWhyOf(ctx.state, r) ?? 'review') : state === 'merge_ready' ? `round ${r.round}` : (r.notes[0] ?? state)
  return { ...base(r, entryKey(r, `event/${state}`), `log ${state}`), kind: 'event', event: { state, issue: r.issue, branch: r.branch, pr: r.pr, head: r.head, note } }
}

// parkText: the park's comment: the question, what parked it and how to resume (4.5, 11).
export function parkText(r: IssueRecord, from: IssueRecord['state'] | null, via: string | null): string {
  const where = from === null ? '' : ` from ${from}${via === null ? '' : ` (${via})`}`
  const resumes = r.resumeTo === null ? '' : ` A resume goes on with ${r.resumeTo}.`
  return [
    'The factory loop parked this issue: it waits on the owner.',
    '',
    `**Question:** ${r.question ?? 'none given'}`,
    '',
    `It parked${where}. To resume, ${resumeStep(r.issue)}.${resumes}`,
  ].join('\n')
}

// parkedTell: the park's tell, and each daily reminder (k >= 1, E6), an owner item.
export function parkedTell(r: IssueRecord, k: number): Action {
  const key = k === 0 ? entryKey(r, 'tell') : `${entryKey(r, 'tell')}/${k}`
  const lines = [`question: ${r.question ?? 'none given'}`, `resume: ${resumeStep(r.issue)}`]
  return wake('tell', 'parked', key, k === 0 ? RULE : 'S6', r.issue, { issue: r.issue, from: r.resumeTo ?? 'none', days: k }, lines)
}

// entryItems: the entry actions of the record's current seq, in their order (4.5).
export function entryItems(ctx: V2Ctx, r: IssueRecord, slot: Lease | null): EntryItem[] {
  const t = transitionOf(ctx, r)
  if (t === null) return []
  const items: EntryItem[] = []
  const add = (action: Action, soft = false, tell = false) => items.push({ action, soft, tell })
  // a change of state (since moves only with the state, table.ts nextRecord)
  const changed = r.since === r.seqAt
  const row = t.row === null ? null : (TABLE.find(x => x.id === t.row) ?? null)
  // a merge's `merged` event, when the factory had none at the close, comes before the close's
  // transition (mergedItem)
  if (changed && r.state === 'closed') items.push(...mergedItem(ctx, r))
  // every new seq: its transition event, first
  add({ ...base(r, entryKey(r, 'event/transition'), `log seq ${r.seq}`), kind: 'event', event: { state: 'transition', record: r, row: t.row ?? 'recovered', from: t.from, via: t.via ?? 'recovered' } })
  // the old seq's steps, if they still run: each agent stopped, the slot's processes killed
  const kill = entryKey(r, KILL)
  const stopping = stops(ctx, r)
  for (const a of stopping) add(a, true)
  if (stopping.length > 0 && (slot !== null || ctx.byKey.has(kill))) {
    add({ ...base(r, kill, 'end the processes the old step left in the slot'), kind: 'slot', op: KILL, life: r.life, path: slot?.path ?? null, lease: slot?.lease ?? null, branch: null, marker: null, maxAttempts: 1 }, true)
  }
  // a change of state: its label, or every factory label off a closed record, unless another
  // device holds a live claim on the issue: its labels are the winner's (3.4)
  const label = labelOf(r.state)
  const labelKey = entryKey(r, 'label')
  if (changed && label !== null) add({ ...base(r, labelKey, `label ${label}`), kind: 'label', op: 'set', label })
  if (changed && r.state === 'closed' && (!heldByOther(ctx, r) || ctx.byKey.has(labelKey))) add({ ...base(r, labelKey, 'a closed record carries no factory label'), kind: 'label', op: 'clear', label: null })
  // the event of the state a row entered, a same-state entry (X2) included (a seq whose entry the
  // ledger rebuilt with no row logs none)
  const entered = row === null || row.next === 'same' ? undefined : ENTRY_EVENTS[r.state]
  if (entered !== undefined) add(emitted(ctx, r, entered))
  if (changed && r.state === 'parked') {
    add({ ...base(r, entryKey(r, 'comment'), 'the park\'s question on the issue'), kind: 'comment', on: 'issue', number: r.issue, body: parkText(r, t.from, t.via) })
    add(parkedTell(r, 0), false, true)
  }
  if (changed && r.state === 'closed') items.push(...closedItems(ctx, r))
  return items
}

// mergedItem: a merge's `merged` event when the factory had none at the close (a merge whose log
// was lost, T-05). Decided once, while the seq's transition event is not yet planned: a later view
// (the sweep's `closed`, the view's 24 h window) never logs the merge again (R3-F1). It is planned
// before that transition event, so its entry is saved first and keeps it planned until done.
function mergedItem(ctx: V2Ctx, r: IssueRecord): EntryItem[] {
  if (r.why !== 'merged' && r.why !== 'merged-by-hand') return []
  const merged = entryKey(r, 'event/merged')
  if (!ctx.byKey.has(merged) && (ctx.byKey.has(entryKey(r, 'event/transition')) || mergedLogged(ctx, r))) return []
  return [{ action: { ...base(r, merged, 'the merge has no merged event'), kind: 'event', event: { state: 'merged', issue: r.issue, branch: r.branch, pr: r.pr, head: r.head, note: r.why === 'merged' ? 'merged by the factory loop' : 'merged by hand' } }, soft: false, tell: false }]
}

// closedItems: a closed record's follow-ups by why (4.5): a drop's `abandoned`; a merge's rollout
// read, then a close for an epic base or a later milestone for a run-it or keep-open rollout
// (D-29); a split's parent released.
function closedItems(ctx: V2Ctx, r: IssueRecord): EntryItem[] {
  const items: EntryItem[] = []
  const add = (action: Action) => items.push({ action, soft: false, tell: false })
  if (r.why === 'dropped') add(emitted(ctx, r, 'abandoned'))
  if (r.why === 'merged' || r.why === 'merged-by-hand') {
    const rolloutKey = followKey(r, 'rollout')
    add({ ...base(r, rolloutKey, 'read the merged issue\'s rollout'), kind: 'rollout', pr: r.pr })
    const read = ctx.byKey.get(rolloutKey)
    const o = read?.status === 'done' && read.outcome?.kind === 'rollout' ? read.outcome : null
    if (o !== null && o.closeIssue !== null) add({ ...base(r, followKey(r, 'close-issue'), 'its PR targets an epic base'), issue: o.closeIssue, kind: 'close-issue' })
    if (o !== null && (o.rollout === 'run-it' || o.rollout === 'keep-open') && ctx.state.sources.milestone.ok && ctx.state.milestone !== null) {
      add({ ...base(r, followKey(r, 'milestone-later'), `${o.rollout} leaves the issue open`), kind: 'milestone-later' })
    }
  }
  if (r.why === 'split') {
    const created = lifeEntries(ctx, r, 'split').flatMap(e => (e.status === 'done' && e.outcome?.kind === 'split' ? [e.outcome.child] : []))
    add({ ...base(r, followKey(r, 'release-parent'), 'the parent is the split\'s tracker'), kind: 'release-parent', created: [...new Set(created)].sort((a, b) => a - b) })
  }
  return items
}

// entryDone: every entry action of the seq is done, a tell excepted and a best-effort one once it
// ended (4.5): the step may start.
export function entryDone(ctx: V2Ctx, items: readonly EntryItem[]): boolean {
  return items.every(i => {
    if (i.tell) return true
    const e = ctx.byKey.get(i.action.key)
    if (e === undefined) return false
    return e.status === 'done' || (i.soft && e.status !== 'running')
  })
}

// transitionLogged: the seq's `transition` event is logged, or the ledger no longer holds its
// transition: the next transition waits for it, so the trail has no gaps (3.3).
export function transitionLogged(ctx: V2Ctx, r: IssueRecord): boolean {
  if (!ctx.byKey.has(transitionKey(r))) return true
  return ctx.byKey.get(entryKey(r, 'event/transition'))?.status === 'done'
}

// The keys of an attempt and the best-effort ones: no stall of their own (a step's own failure
// is its unknown).
const NOT_EFFECTS: readonly string[] = ['agent-step', 'stop-agent', 'judge', 'task', 'tell', 'title']
const ATTEMPT_PART = /\/(prepare\/a\d+|kill)$/

// stalledOf: an effect of the record's current seq, or of its life's lease and follow-ups, that
// used up its attempts (4.5): the key and its last error; null when none.
export function stalledOf(ctx: V2Ctx, r: IssueRecord): { key: string; error: string; at: number } | null {
  const own = [`${seqKey(r)}/`, `${lifeKey(r)}/follow/`, `${lifeKey(r)}/lease/`]
  for (const e of ctx.state.ledger) {
    if (NOT_EFFECTS.includes(e.kind) || ATTEMPT_PART.test(e.key) || !own.some(p => e.key.startsWith(p))) continue
    if (gate(ctx, e.key, e.kind, e.maxAttempts) === 'exhausted') return { key: e.key, error: e.summary ?? e.status, at: e.endedAt ?? e.startedAt }
  }
  return null
}

// stalledTell: the owner hears once of an effect that holds its record, per time it ran out.
export function stalledTell(r: IssueRecord, key: string, error: string, at: number): Action {
  return wake('tell', 'stalled', `tell:stalled:${key}:${at}`, RULE, r.issue, { issue: r.issue, key }, [`error: ${error}`, `retry: /factory retry ${r.issue} once the cause is fixed`])
}

// ensureActions: the seven factory labels made or updated once per module load, and again after a
// label write failed for a missing label (3.4). Planned before the first label write of a pass.
export function ensureActions(ctx: V2Ctx): Action[] {
  const keys = [`label/ensure/${lifeOf(ctx.state.loadedAt)}`]
  for (const e of ctx.state.ledger) {
    const detail = e.outcome?.kind === 'cli' ? (e.outcome.detail ?? '') : (e.summary ?? '')
    if (e.kind === 'label' && e.status === 'failed' && /not found/i.test(detail)) keys.push(`label/ensure/${e.key}/a${e.attempts}`)
  }
  return keys.map(key => ({ kind: 'label', op: 'ensure', label: null, key, class: 'free', rule: RULE, reason: `the ${ALL_FACTORY_LABELS.length} factory labels exist`, issue: null }))
}
