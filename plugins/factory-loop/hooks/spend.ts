// spend: the loop's brake on dollar spend in API-key mode (v2 SPEC 13.5.2 G3, 13.13). A local tally of the
// session's cost against a monthly dollar budget, pure functions only: observe reads the session's cost and
// the stored tally, calls tallyStep, and a pass that acts stores the tally it returns.
import type { Ms, Usage } from './types'

// ApiKeySettings: the three workspace settings of API-key mode as the container's environment gives them
// (DEV_CLAUDE_BUDGET_USD, DEV_CLAUDE_BUDGET_RESET_DAY), unparsed. budgetOf checks them.
export type ApiKeySettings = { budgetUsd: string; resetDay: string }

// Counter: the last reading of the process-wide cost counter and who took it.
export type Counter = { process: string; session: string; lastUsd: number }

// Tally: what `spend:<repo>` holds in $.store.
export type Tally = { v: 1; periodStart: Ms; spentUsd: number; counter: Counter | null; at: Ms }

// the $.store key of a repo's tally
export const spendKey = (repo: string) => `spend:${repo}`

export type Reading = { costUsd: number | null; process: string; session: string }


const clamped = (year: number, month: number, day: number) => {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return Date.UTC(year, month, Math.min(day, last))
}

// periodOf: the budget period `now` falls in. It starts at 00:00 UTC on the reset day (a day past the
// month's end means its last day) and resetsAt is the next such instant.
export function periodOf(resetDay: number, now: Ms): { start: Ms; resetsAt: Ms } {
  const d = new Date(now)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  const here = clamped(y, m, resetDay)
  if (now >= here) return { start: here, resetsAt: clamped(y, m + 1, resetDay) }
  return { start: clamped(y, m - 1, resetDay), resetsAt: here }
}

// budgetOf: the budget and reset day, or the reason code that stops new work.
export function budgetOf(s: ApiKeySettings): { budgetUsd: number; resetDay: number } | { reason: string } {
  const budgetUsd = s.budgetUsd.trim() === '' ? NaN : Number(s.budgetUsd)
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return { reason: 'spend:no-budget' }
  const resetDay = s.resetDay.trim() === '' ? NaN : Number(s.resetDay)
  if (!Number.isInteger(resetDay) || resetDay < 1 || resetDay > 31) return { reason: 'spend:bad-reset-day' }
  return { budgetUsd, resetDay }
}

// spendPct: whole percent of the budget, rounded up so a gate never reads 89.5 as under 90.
export const spendPct = (usd: number, budgetUsd: number) => Math.ceil((100 * usd) / budgetUsd)

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

// tallyOf: the stored record as a Tally; null when it does not parse.
function tallyOf(raw: unknown): Tally | null {
  if (typeof raw !== 'object' || raw === null) return null
  const t = raw as Record<string, unknown>
  const c = t.counter
  const counter = c === null ? null : typeof c === 'object' && c !== undefined && c !== null && typeof (c as Counter).process === 'string' && typeof (c as Counter).session === 'string' && num((c as Counter).lastUsd) ? (c as Counter) : undefined
  if (t.v !== 1 || !num(t.periodStart) || !num(t.spentUsd) || counter === undefined || !num(t.at)) return null
  return { v: 1, periodStart: t.periodStart, spentUsd: t.spentUsd, counter: counter === null ? null : { process: counter.process, session: counter.session, lastUsd: counter.lastUsd }, at: t.at }
}

export const unavailableSpend = (reason: string): Usage => ({
  fiveHour: null, sevenDay: null, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: true, auth: 'api-key', spend: null, reason,
})

// tallyStep: one reading folded into the tally. `prev` is what the store held (undefined or null: none).
// Returns the usage the loop acts on and the tally to store (null: leave the store as it is). A reading
// that cannot be had gives an unavailable usage with its reason, which tierOf holds at stop-new.
export function tallyStep(prev: unknown, reading: Reading, now: Ms, settings: ApiKeySettings): { tally: Tally | null; usage: Usage } {
  const budget = budgetOf(settings)
  if ('reason' in budget) return { tally: null, usage: unavailableSpend(budget.reason) }
  const c = reading.costUsd
  if (c === null || !num(c)) return { tally: null, usage: unavailableSpend('spend:no-session-cost') }
  const period = periodOf(budget.resetDay, now)
  const stored = prev === undefined || prev === null ? null : tallyOf(prev)
  const bad = prev !== undefined && prev !== null && stored === null
  const before: Tally = stored ?? { v: 1, periodStart: period.start, spentUsd: 0, counter: null, at: now }
  const rolled = period.start > before.periodStart
  const last = before.counter
  const sameProcess = last !== null && last.process === reading.process
  const restored = last !== null && !sameProcess && last.session === reading.session
  const add = last !== null && (sameProcess || restored) && c >= last.lastUsd ? c - last.lastUsd : c
  const tally: Tally = {
    v: 1,
    periodStart: rolled ? period.start : before.periodStart,
    spentUsd: (rolled ? 0 : before.spentUsd) + add,
    counter: { process: reading.process, session: reading.session, lastUsd: c },
    at: now,
  }
  if (bad) return { tally, usage: unavailableSpend('spend:bad-tally') }
  return {
    tally,
    usage: { fiveHour: null, sevenDay: null, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: false, auth: 'api-key', spend: { usd: tally.spentUsd, budgetUsd: budget.budgetUsd, resetsAt: period.resetsAt } },
  }
}

// spendEventData: the usage event's data object (usage.v1) for a reading or an unavailable reason.
export function spendEventData(usage: Usage): Record<string, unknown> {
  const none = { five_hour_pct: null, five_hour_resets_at: null, seven_day_pct: null, seven_day_resets_at: null }
  if (usage.spend == null) {
    return { available: false, ...none, source: null, auth: 'api-key', reasons: [usage.reason ?? 'spend:unavailable'] }
  }
  return {
    available: true, ...none, source: 'spend', auth: 'api-key',
    spend_usd: Math.round(usage.spend.usd * 1e6) / 1e6, budget_usd: usage.spend.budgetUsd,
    budget_resets_at: new Date(usage.spend.resetsAt).toISOString(), reasons: [],
  }
}

