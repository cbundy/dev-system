// Builders for plan fixtures: a quiet factory at a fixed time, with helpers to add issues,
// runs and ledger entries. Each test then states what the skill says should happen.
import { DEFAULT_CONFIG, EMPTY_CONTROL } from '../hooks/config'
import type {
  Action,
  Config,
  Control,
  IssueView,
  LedgerEntry,
  Outcome,
  PlanResult,
  RunState,
  RunView,
  Source,
  SourceName,
  Stage,
  State,
} from '../hooks/types'

// 2026-10-13T03:00:00Z
export const NOW = Date.UTC(2026, 9, 13, 3, 0)
export const MIN = 60_000
export const DEVICE = 'coder-dev-system-orchestrator'
export const OTHER = 'coder-plant-console-orchestrator'

const SOURCES: SourceName[] = ['factory', 'facts', 'runs', 'queue', 'github', 'usage', 'pool', 'milestone']

export function config(over: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...over }
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
    usage: { fiveHour: 40, sevenDay: 60, resetsAt: null, unavailable: false },
    issues: [],
    queue: [],
    runs: [],
    pool: { free: 10, total: 16, slots: [] },
    agents: [],
    milestone: null,
    ledger: [
      // a recent heartbeat and sweep, so housekeeping stays quiet unless a test says otherwise
      entry('heartbeat:0', 'heartbeat', { startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
      entry('sweep:0', 'sweep', { startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN }),
    ],
    control: control(),
    lastTitle: null,
    githubBackoffUntil: null,
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
    subIssues: 0,
    brief: null,
    delegatedBrief: null,
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

// keys: the planned actions' keys, title left out.
export function keys(result: PlanResult): string[] {
  return result.actions.filter(a => a.kind !== 'title').map(a => a.key)
}

export function find(result: PlanResult, key: string): Action | undefined {
  return result.actions.find(a => a.key === key)
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
  return { ...s, ledger: [...s.ledger.filter(e => !started.some(n => n.key === e.key)), ...started], lastTitle: result.title }
}
