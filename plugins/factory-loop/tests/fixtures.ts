// Builders for plan fixtures: a quiet factory at a fixed time, with helpers to add issues,
// runs and ledger entries. Each test then states what the skill says should happen.
import { DEFAULT_CONFIG, EMPTY_CONTROL } from '../hooks/config'
import type {
  Action,
  AdjudicatorAction,
  Config,
  Control,
  IssueView,
  LedgerEntry,
  MergeReport,
  Outcome,
  PlanResult,
  RunState,
  RunView,
  Slot,
  Source,
  SourceName,
  Stage,
  State,
} from '../hooks/types'
import type { IssueRecord } from '../hooks/v2/types'

// 2026-10-13T03:00:00Z
export const NOW = Date.UTC(2026, 9, 13, 3, 0)
export const MIN = 60_000
export const DEVICE = 'coder-dev-system-orchestrator'
export const OTHER = 'coder-plant-console-orchestrator'
// where the plugin is loaded from ($.plugin.root): the answer script is under it (#561)
export const PLUGIN_ROOT = '/plugins/factory-loop'

// the main checkout on its default branch with nothing changed: where agents may start (#544)
export const CLEAN = { branch: 'main', head: '5251b75ef45eef8d6c31556c1b5ac3d5dd34f3ff', defaultBranch: 'main', dirty: [] }

const SOURCES: SourceName[] = ['factory', 'facts', 'runs', 'queue', 'github', 'usage', 'pool', 'milestone']

// eventsSource is old: the tests exercise the old rebuild, and the shadow compare has its own tests
// (v2-sources-records.test.ts), which set it
export function config(over: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, eventsSource: 'old', ...over }
}

export function control(over: Partial<Control> = {}): Control {
  return { ...EMPTY_CONTROL, ...over }
}

export function state(over: Partial<State> = {}): State {
  const sources = Object.fromEntries(SOURCES.map(name => [name, { ok: true, at: NOW } as Source])) as Record<
    SourceName,
    Source
  >
  return {
    now: NOW,
    repo: 'cbundy/dev-system',
    device: DEVICE,
    loadedAt: NOW - 120 * MIN,
    sources,
    usage: { fiveHour: 40, sevenDay: 60, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: false },
    issues: [],
    queue: [],
    runs: [],
    pool: { free: 10, total: 16, slots: [] },
    agents: [],
    milestone: null,
    release: null,
    ledger: [
      // a recent heartbeat, sweep and checkout update, so housekeeping stays quiet unless a test
      // says otherwise
      entry('heartbeat:0', 'heartbeat', { startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('sweep:0', 'sweep', { startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('update-checkout:0', 'update-checkout', { startedAt: NOW - 2 * MIN, endedAt: NOW - 2 * MIN, outcome: { kind: 'update-checkout', result: 'current', line: `CURRENT ${CLEAN.head}` } }),
    ],
    control: control(),
    lastTitle: null,
    lastTitleAt: null,
    githubBackoffUntil: null,
    checkout: CLEAN,
    ...over,
  }
}

// withLedger: the state with these entries added to its ledger (the quiet housekeeping kept).
export function withLedger(s: State, extra: LedgerEntry[]): State {
  return { ...s, ledger: [...s.ledger, ...extra] }
}

export function failing(s: State, name: SourceName, since: number | null): State {
  return { ...s, sources: { ...s.sources, [name]: { ok: false, at: since, error: 'test' } } }
}

export function issue(n: number, over: Partial<IssueView> = {}): IssueView {
  return {
    number: n,
    stage: 'queued',
    stageSince: NOW - 30 * MIN,
    holder: null,
    run: null,
    pr: null,
    stuck: null,
    open: true,
    trusted: true,
    labels: ['enhancement', 'ready'],
    blockedBy: 0,
    blocking: 0,
    subIssues: 0,
    epic: false,
    subIssueList: null,
    brief: null,
    delegatedBrief: null,
    claimLapsedAt: null,
    reclaimedAt: null,
    ...over,
  }
}

// mine: an issue this device holds, in the given stage.
export function mine(n: number, stage: Stage, over: Partial<IssueView> = {}): IssueView {
  return issue(n, { stage, holder: DEVICE, labels: ['enhancement', 'In development'], ...over })
}

export function brief(n: number) {
  return `https://github.com/cbundy/dev-system/issues/${n}#issuecomment-${1000 + n}`
}

export function run(n: number, state: RunState, over: Partial<RunView> = {}): RunView {
  return {
    branch: `feat/issue-${n}-work`,
    issue: n,
    run: `01M4RQ${String(n).padStart(4, '0')}AAAA`,
    state,
    head: `head${n}`,
    step: state === 'parked' || state === 'failed' ? 'review' : null,
    detail: null,
    pr: 500 + n,
    since: NOW - 5 * MIN,
    reviewFixRounds: 0,
    verdicts: [],
    superseded: false,
    ...over,
  }
}

// slot: a leased pool slot on a branch, as observe leaves it (#563): a detached one has branch
// null and the lease's branch from its reflog, and its tree is not read (dirty null) unless a
// test says so, as observe reads it only for a finished issue.
export function slot(path: string, branch: string | null, over: Partial<Slot> = {}): Slot {
  return { path, branch, state: 'leased', dirty: null, busy: false, lease: `lease${path}`, leasedAt: NOW - 60 * MIN, leaseBranch: branch, ...over }
}

export function entry(key: string, kind: LedgerEntry['kind'], over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    key,
    kind,
    class: 'free',
    rule: 'test',
    issue: null,
    run: null,
    pr: null,
    head: null,
    status: 'done',
    attempts: 1,
    startedAt: NOW - 10 * MIN,
    endedAt: NOW - 9 * MIN,
    ...over,
  }
}

export function wakeAnswer(decision: string, over: Partial<Extract<Outcome, { kind: 'wake' }>> = {}): Outcome {
  return { kind: 'wake', decision, reason: null, instructions: null, bump: null, bumpReason: null, fields: {}, ...over }
}

// review: an adjudicator outcome; a merge review carries its report (the retired v1 adjudicator reply).
export function review(action: AdjudicatorAction, report: Partial<MergeReport> | null = null, verdicts: string[] = []): Outcome {
  return {
    kind: 'adjudicator',
    verdicts,
    action,
    report: report === null ? null : { summary: 'a change for users', bump: 'patch', bumpReason: 'a fix', flags: [], ...report },
  }
}

// keys: the planned actions' keys, title left out.
export function keys(result: PlanResult): string[] {
  return result.actions.filter(a => a.kind !== 'title').map(a => a.key)
}

export function find(result: PlanResult, key: string): Action | undefined {
  return result.actions.find(a => a.key === key)
}

// titled: the title fields once a plan ran, as the driver sets them: only a planned title action
// renames, and it stamps the time.
export function titled(s: State, result: PlanResult): Pick<State, 'lastTitle' | 'lastTitleAt'> {
  return result.actions.some(a => a.kind === 'title') ? { lastTitle: result.title, lastTitleAt: s.now } : { lastTitle: s.lastTitle, lastTitleAt: s.lastTitleAt }
}

// running: the ledger after every planned action started, for the idempotence property.
export function running(s: State, result: PlanResult): State {
  const started: LedgerEntry[] = result.actions
    .filter(a => a.kind !== 'title')
    .map(a => ({
      key: a.key,
      kind: a.kind,
      class: a.class,
      rule: a.rule,
      issue: a.issue,
      run: 'run' in a && typeof a.run === 'string' ? a.run : null,
      pr: 'pr' in a && typeof a.pr === 'number' ? a.pr : null,
      head: 'head' in a && typeof a.head === 'string' ? a.head : null,
      agent: a.kind === 'spawn' ? a.agent : a.kind === 'delegate' ? 'implementer' : undefined,
      wake: a.kind === 'judge' || a.kind === 'task' || a.kind === 'tell' ? a.wake : undefined,
      status: 'running' as const,
      attempts: 1,
      startedAt: s.now,
      endedAt: null,
    }))
  return { ...s, ledger: [...s.ledger.filter(e => !started.some(n => n.key === e.key)), ...started], ...titled(s, result) }
}

// transitionRow: the row NEW_REBUILD_SQL returns (as dev-query --csv prints it) for a transition of the record
// at `ts`: the envelope columns and the payload as transition.v1 JSON.
export function transitionRow(r: IssueRecord, ts: number, over: Record<string, string> = {}, id = `ev-${r.issue}-${r.life}-${r.seq}`): Record<string, string> {
  const data = {
    life: r.life,
    seq: r.seq,
    table_row: 'T1',
    from_state: null,
    to_state: r.state,
    via: 't1',
    seq_at: new Date(r.seqAt).toISOString(),
    state_since: new Date(r.since).toISOString(),
    resume_to: r.resumeTo,
    branch: r.branch,
    pr: r.pr,
    head: r.head,
    approved_patch: r.approvedPatch,
    brief_url: r.brief,
    step: r.step,
    attempt: r.attempt,
    cut: r.cut,
    triages: r.triages,
    fixes: r.fixes,
    round: r.round,
    question: r.question,
    ...(r.wait === null ? {} : { wait: r.wait }),
    why: r.why,
    notes: r.notes,
    pr_closed_at: r.prClosedAt,
    lives: r.lives,
  }
  return {
    envelope: '1',
    event_id: id,
    ts: new Date(ts).toISOString(),
    type: 'transition',
    type_version: '1',
    repo: 'cbundy/dev-system',
    device: DEVICE,
    actor: 'factory-loop',
    session_id: '',
    issue: String(r.issue),
    base_image: '',
    dev_image: '',
    template_version: '',
    plugin_version: '',
    device_seq: String(r.seq),
    data: JSON.stringify(data),
    ...over,
  }
}

// The columns of the facts' new-store read (NEW_EVENTS_SQL), and eventRow: one row of it, as dev-query
// --csv prints it, for an event of `type` with payload `data` at `ts`.
export const EVENT_HEADER = ['envelope', 'event_id', 'ts', 'type', 'type_version', 'repo', 'device', 'actor', 'session_id', 'issue', 'base_image', 'dev_image', 'template_version', 'plugin_version', 'device_seq', 'data']
let eventRows = 0
export function eventRow(type: string, data: Record<string, unknown>, ts: number, over: Record<string, string> = {}): Record<string, string> {
  eventRows += 1
  return {
    envelope: '1',
    event_id: `00000000-0000-4000-8000-${String(eventRows).padStart(12, '0')}`,
    ts: new Date(ts).toISOString(),
    type,
    type_version: '1',
    repo: 'cbundy/dev-system',
    device: DEVICE,
    actor: 'agent',
    session_id: '',
    issue: '',
    base_image: '',
    dev_image: '',
    template_version: '',
    plugin_version: '',
    device_seq: String(eventRows),
    data: JSON.stringify(data),
    ...over,
  }
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
// eventsCsv: rows as dev-query --csv prints them, in the given columns
export const eventsCsv = (rows: Record<string, string>[], header: string[] = EVENT_HEADER): string => [header.join(','), ...rows.map(r => header.map(h => csvCell(r[h] ?? '')).join(','))].join('\n') + '\n'
