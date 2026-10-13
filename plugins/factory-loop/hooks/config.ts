// Default settings (SPEC 4.2). The repo-local .claude/factory-loop.json overrides any of
// them; the plugin ships no repo-specific values.
import type { Config, Control } from './types'

const MIN = 60_000

export const DEFAULT_CONFIG: Config = {
  mode: 'observe',
  shadowDevice: null,
  readyLabel: 'ready',
  inDevLabel: 'In development',
  skipLabels: [],
  trackerTitle: '^(Epic|Tracker)\\b',
  usageSlowPct: 85,
  usageStopNewPct: 90,
  usageStopAllPct: 95,
  heartbeatEveryMs: 20 * MIN,
  sweepEveryMs: 30 * MIN,
  slowGapMs: 10 * MIN,
  maxStartsPerPass: 4,
  maxInFlightIssues: null,
  worktreeReserve: 2,
  reviewFixCap: 3,
  guardRecheckMs: 3 * MIN,
  guardTtlMs: 30 * MIN,
  respondSettleMs: 15 * MIN,
  updateBehindRetryMs: 5 * MIN,
  updateBehindRetries: 3,
  ciStallRecheckMs: 15 * MIN,
  blindNoticeAfterMs: 15 * MIN,
  agentTimeoutMs: { designer: 60 * MIN, implementer: 120 * MIN, adjudicator: 30 * MIN, fixer: 120 * MIN },
  maxAttempts: {
    claim: 3,
    designer: 2,
    implementer: 2,
    adjudicator: 2,
    fixer: 2,
    respond: 2,
    merge: 2,
    'fix-linkage': 2,
    guard: 3,
    heartbeat: 3,
    sweep: 3,
    // a wake is asked once (with one reminder inside the attempt); then its fallback holds
    judge: 1,
    task: 1,
    tell: 1,
  },
  retryBackoffMs: 2 * MIN,
  rateCaps: { start: 30, spawn: 40, merge: 10, wake: 20, perIssueKind: 6 },
}

export const EMPTY_CONTROL: Control = {
  paused: [],
  noNewWork: false,
  skip: [],
  priority: [],
  only: [],
  serial: false,
  usageOverride: null,
  resumed: [],
  dropped: [],
  notes: [],
}
