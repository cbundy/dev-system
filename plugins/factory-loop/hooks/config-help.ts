// `/factory help config` (v2 SPEC 13.4.3): every setting `config set` accepts, with its default and
// a one-line meaning. The key list comes from the loader (DEFAULT_CONFIG, poolSize, minus what has
// an op of its own, is a runtime key or only the first loop read), the defaults are rendered from
// DEFAULT_CONFIG by defaultText, and SETTING_HELP holds the meaning per key. The tests hold the
// three together, and the SPEC's appendix A and the onboarding table to defaultText.
import { ATTEMPT_KEYS, DEFAULT_CONFIG, shortDuration } from './config'
import { DEFAULT_POOL_SIZE, OWN_OP, RUNTIME_KEYS } from './config-keys'

// Keys only the first loop read: a settings file may still carry them, they load and have no effect
// (v2 SPEC appendix A).
export const FIRST_LOOP_KEYS: readonly string[] = [
  'guardRecheckMs', 'guardTtlMs', 'respondSettleMs', 'updateBehindRetryMs', 'updateBehindRetries', 'ciStallRecheckMs', 'agentTimeoutMs',
]

// The map settings: set one entry as `<key>.<name>`.
const MAP_KEYS: readonly string[] = ['maxAttempts', 'rateCaps', 'queueScore', 'wakeTimeoutMs', 'stateTimeoutMs']

// settableKeys: the keys `config set` accepts, in the order DEFAULT_CONFIG gives them, poolSize last.
export function settableKeys(): string[] {
  const own = Object.keys(OWN_OP)
  const keys = [...Object.keys(DEFAULT_CONFIG), 'poolSize']
  return keys.filter(k => !own.includes(k) && !(RUNTIME_KEYS.includes(k) && k !== 'poolSize') && !FIRST_LOOP_KEYS.includes(k))
}

// typedKey: a key as the owner types it: the short spelling for a duration (`passEvery`).
export function typedKey(key: string): string {
  return key.endsWith('Ms') ? key.slice(0, -2) : key
}

function valueText(key: string, value: unknown): string {
  if (typeof value === 'number' && key.endsWith('Ms')) return shortDuration(value)
  if (value === null) return 'none'
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
}

// defaultText: a key's default as the docs and the help write it: a duration short (`5m`), null as
// `none`, a list as JSON, a map as `name value, ...`. Every Config key and poolSize.
export function defaultText(key: string): string {
  if (key === 'poolSize') return String(DEFAULT_POOL_SIZE)
  const value = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key]
  if (MAP_KEYS.includes(key) || key === 'agentTimeoutMs') {
    return Object.entries(value as Record<string, number>).map(([name, v]) => `${name} ${valueText(key, v)}`).join(', ')
  }
  return valueText(key, value)
}

// The meaning of each setting, one line (v2 SPEC appendix A has the long form).
export const SETTING_HELP: Record<string, string> = {
  readyLabel: 'the label that hands the loop an issue (ignores case)',
  priorityLabel: 'the label that scores an issue higher; order only, never a filter',
  inDevLabel: 'the label the loop puts on an issue it works on (ignores case)',
  skipLabels: 'labels that keep an issue from being claimed',
  trackerTitle: 'a title (regular expression) that marks a tracker issue',
  usageSlowPct: 'usage percent at which the loop slows its claims',
  usageStopNewPct: 'usage percent at which it claims and starts nothing new',
  usageStopAllPct: 'usage percent at which it stops all work',
  passEveryMs: 'the timer: how often a pass runs',
  titleEveryMs: 'the session title is renamed at most this often',
  reportEveryMs: 'the factory report is built at most this often',
  queueEveryMs: 'how often the queue is read',
  githubEveryMs: 'how often GitHub is read',
  usageEveryMs: 'how often usage is read',
  milestoneEveryMs: 'how often milestones are read',
  usageStaleMs: 'an older usage reading counts as unavailable',
  heartbeatEveryMs: 'how often the heartbeat runs',
  sweepEveryMs: 'how often the sweep runs',
  checkoutEveryMs: 'how often the main-checkout tripwire reads the checkout',
  slowGapMs: 'in Slow, the least time between two claims',
  maxStartsPerPass: 'claims per pass in Normal',
  maxInFlightIssues: 'a cap on this device\'s live issues (also bounded by the memory ceiling)',
  worktreeReserve: 'free slots kept for the steps of issues already in flight',
  reviewFixCap: 'review fix rounds per issue',
  conflictFixCap: 'fix rounds per life for conflicts and red CI in the merge queue',
  blindNoticeAfterMs: 'blind this long tells the owner',
  starvedNoticeAfterMs: 'a starved queue this long tells the owner',
  wakeTimeoutMs: 'how long a wake runs, per kind (judge, task, tell); a wake already running keeps its timeout',
  maxAttempts: 'attempts per action kind or agent type before the owner hears of it; any other kind is 3',
  retryBackoffMs: 'wait before a retry, doubled per attempt',
  rateCaps: 'runaway protection per rolling hour (start, spawn, wake) and per issue and kind (perIssueKind)',
  queueScore: 'the weights of the claim score: whole numbers of at least 0, penalties as magnitudes',
  allowActOutsideOrchestrator: 'act mode without DEV_ROLE=orchestrator, for a testbed',
  traceMaxBytes: 'the trace files\' total size in bytes; the oldest go first',
  answerChannel: 'how agents are asked to answer: script, tool or text',
  eventsSource: 'where the loop reads factory events: old, new or shadow',
  stateTimeoutMs: 'how long a record may stay in a state, per state',
  ciStartMs: 'how long CI may take to start',
  ciRunMs: 'how long CI may take to finish',
  prEveryMs: 'how long a PR\'s read stands before it is read again',
  mainEveryMs: 'how often the default branch is read (act mode)',
  maxTriages: 'triages per issue',
  windDownMinutes: 'minutes a requested wind-down may take; 0 turns wind-down off',
  minimumReleaseCadenceMs: 'the repo\'s minimum release cadence, at least 1h',
  releaseBranchPrefix: 'head-branch prefix of a release\'s bump PR; none turns the release hold off',
  releaseHoldMs: 'the longest the merge queue holds per head of a bump PR; 0 turns the hold off',
  releaseInProgressMs: 'after a release task is done, no release review is planned for this long; 0 turns it off',
  flakeWindowDays: 'days back a test\'s flakes count toward a flake bug',
  flakeBugMin: 'flakes of one test in the window that file a flake bug',
  flakeBugReadyCap: 'a new flake bug is readied only while fewer than this many are ready or in flight',
  flakeEpic: 'the issue a flake bug is linked under; none links none',
  maxLives: 'a release at this life rejects the issue instead of requeueing it',
  triageModel: 'the triage agent\'s model',
  regime: 'factory_loop_v2 or testbed: the regime every event the loop writes carries',
  intakeStamp: 'on or off: the intake stamp reader',
  intakeModel: 'the intake agent\'s model, never larger than triageModel',
  intakeAreas: 'the area names a stamp may name; must hold factory and product',
  reviewer: 'the reviewer implementation',
  reviewerModel: 'the reviewer\'s model',
  gateCommands: 'the stop gate\'s commands, run in order in the worktree',
  gateTimeoutMs: 'the budget for all gate commands together',
  gateConcurrency: 'stop gates run at once: auto, or a whole number',
  gateWaitTimeoutMs: 'how long a gate waits for its turn',
  slotMemoryMiB: 'memory one slot is assumed to use in MiB; auto measures it',
  memoryReserveMiB: 'the container\'s memory kept free of slots, in MiB',
  poolSize: 'worktrees in the pool; the workspace file only, not the repo\'s',
}

export type SettingRow = { key: string; typed: string; defaults: string; meaning: string; entries: string[] | null }

// configHelpRows: one row per settable key, in settableKeys' order.
export function configHelpRows(): SettingRow[] {
  return settableKeys().map(key => {
    const map = MAP_KEYS.includes(key)
    const entries = !map ? null : key === 'maxAttempts' ? [...(ATTEMPT_KEYS as readonly string[])] : Object.keys((DEFAULT_CONFIG as unknown as Record<string, object>)[key] ?? {})
    return { key, typed: typedKey(key), defaults: defaultText(key), meaning: SETTING_HELP[key] ?? '', entries }
  })
}

// configHelpText: `/factory help config`.
export function configHelpText(): string {
  const rows = configHelpRows()
  const name = (r: SettingRow) => (r.entries === null ? r.typed : `${r.typed}.<name>`)
  const width = Math.max(...rows.map(r => name(r).length)) + 2
  const lines = rows.flatMap(r => {
    const head = `  ${name(r).padEnd(width)}${r.meaning} (default: ${r.defaults})`
    return r.key === 'maxAttempts' && r.entries !== null ? [head, `  ${' '.repeat(width)}names: ${r.entries.join(', ')}`] : [head]
  })
  return [
    'Settings: /factory config set <key> <value> saves one in the workspace config file, /factory config unset <key> removes it.',
    'A duration takes 60s, 5m or 2h under its key without "Ms". A map takes one entry, as <key>.<name>.',
    '',
    ...lines,
    '',
    `Own ops: ${Object.keys(OWN_OP).map(o => `/factory ${o}`).join(', ')} (not set through config).`,
    `Accepted without effect (only the first loop read them): ${FIRST_LOOP_KEYS.join(', ')}.`,
  ].join('\n')
}
