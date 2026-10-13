// The owner's controls (SPEC 4.3; DECISIONS D-15, D-16, D-35, D-38): every `/factory` op and
// its bad forms, applyOp's new Control and effects (the input never changes), control.json and
// the workspace config file through a fake ActIo, the status answer, and the command and tool
// specs. One test feeds the written control.json to plan, so the shapes are the ones it reads.
import { describe, expect, test } from 'claude-code/testing'

import type { PassSummary } from '../types'
import { EMPTY_CONTROL, controlFrom } from '../hooks/config'
import {
  CONTROL_TOOL,
  FACTORY_COMMAND,
  OPS,
  USAGE,
  applyOp,
  configFilePath,
  controlPath,
  controlTool,
  directives,
  formatOp,
  loadControl,
  parseOp,
  retryText,
  runOp,
  statusText,
  withMode,
} from '../hooks/control'
import type { FileIo, Op } from '../hooks/control'
import { plan } from '../hooks/plan'
import type { Control } from '../hooks/types'
import { MIN, NOW, config, control, issue, keys, state } from './fixtures'

const HOUR = 60 * MIN
const LOOP_DIR = '/cfg/factory-loop/cbundy__dev-system'
const PATHS = { loopDir: LOOP_DIR, configDir: '/cfg' }
const CONTROL_FILE = `${LOOP_DIR}/control.json`
const CONFIG_FILE = '/cfg/factory-loop/config.json'

function op(text: string): Op {
  const parsed = parseOp(text)
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error}`)
  return parsed.op
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

// files: a fake ActIo for the file calls, recording every write
function files(initial: Record<string, string> = {}, failWrites = false) {
  const map = new Map(Object.entries(initial))
  const writes: string[] = []
  const io: FileIo = {
    readFile: async path => map.get(path) ?? null,
    writeFile: async (path, text) => {
      if (failWrites) throw new Error('EROFS: read-only file system')
      writes.push(path)
      map.set(path, text)
    },
  }
  return { io, map, writes }
}

const PASS: PassSummary = {
  pass: 184,
  at: NOW - 90_000,
  mode: 'act',
  tier: 'slow',
  title: '🔄 dev-system (Q:3 - D:5 - M:9) · act · owner 1',
  actions: 3,
  owner: 1,
}

describe('parseOp', () => {
  test('every op in its good forms (SPEC 4.3)', () => {
    expect(op('')).toEqual({ op: 'status' })
    expect(op('status')).toEqual({ op: 'status' })
    expect(op('  STATUS ')).toEqual({ op: 'status' })
    expect(op('/factory status')).toEqual({ op: 'status' })
    for (const name of ['pause', 'unpause', 'skip', 'noskip', 'retry', 'drop'] as const) {
      expect(op(`${name} 12`)).toEqual({ op: name, issue: 12 })
      expect(op(`${name} #12`)).toEqual({ op: name, issue: 12 })
    }
    expect(op('Pause #522')).toEqual({ op: 'pause', issue: 522 })
    expect(op('priority 470 #471,472, 470')).toEqual({ op: 'priority', issues: [470, 471, 472] })
    expect(op('priority off')).toEqual({ op: 'priority', issues: [] })
    expect(op('only 522')).toEqual({ op: 'only', issues: [522] })
    expect(op('only #340 12')).toEqual({ op: 'only', issues: [340, 12] })
    expect(op('only OFF')).toEqual({ op: 'only', issues: [] })
    expect(op('serial on')).toEqual({ op: 'serial', on: true })
    expect(op('serial off')).toEqual({ op: 'serial', on: false })
    expect(op('new ON')).toEqual({ op: 'new', on: true })
    expect(op('new off')).toEqual({ op: 'new', on: false })
    expect(op('override 95 2')).toEqual({ op: 'override', until: { pct: 95, hours: 2 } })
    expect(op('override 97.5% 1.5h')).toEqual({ op: 'override', until: { pct: 97.5, hours: 1.5 } })
    expect(op('override off')).toEqual({ op: 'override', until: null })
    expect(op('resume 60')).toEqual({ op: 'resume', subject: 'issue:60' })
    expect(op('resume #60')).toEqual({ op: 'resume', subject: 'issue:60' })
    expect(op('resume issue:60')).toEqual({ op: 'resume', subject: 'issue:60' })
    expect(op('resume 01M4RQ0045AAAA')).toEqual({ op: 'resume', subject: 'run:01M4RQ0045AAAA' })
    expect(op('resume run:01M4RQ0045AAAA')).toEqual({ op: 'resume', subject: 'run:01M4RQ0045AAAA' })
    // a run id that is all digits needs its prefix: bare, it reads as an issue
    expect(op('resume run:12345')).toEqual({ op: 'resume', subject: 'run:12345' })
    expect(op('update')).toEqual({ op: 'update', reason: 'owner' })
    expect(op('update off')).toEqual({ op: 'update', reason: null })
    expect(op('update   base image  1.4.0')).toEqual({ op: 'update', reason: 'base image 1.4.0' })
    expect(op('note keep briefs short')).toEqual({ op: 'note', issue: null, text: 'keep briefs short' })
    expect(op('note #5 use the  existing parser')).toEqual({ op: 'note', issue: 5, text: 'use the existing parser' })
    expect(op('note 5 use it')).toEqual({ op: 'note', issue: 5, text: 'use it' })
    for (const mode of ['off', 'observe', 'act'] as const) expect(op(`mode ${mode}`)).toEqual({ op: 'mode', mode })
    expect(op('mode ACT')).toEqual({ op: 'mode', mode: 'act' })
  })

  test('bad input is a short usage error naming the op, never a partial change', () => {
    const bad: [string, keyof typeof USAGE][] = [
      ['status now', 'status'],
      ['pause', 'pause'],
      ['pause x', 'pause'],
      ['pause 12 13', 'pause'],
      ['pause 0', 'pause'],
      ['pause #', 'pause'],
      ['pause -3', 'pause'],
      ['pause 1.5', 'pause'],
      ['unpause abc', 'unpause'],
      ['skip', 'skip'],
      ['noskip 5x', 'noskip'],
      ['priority', 'priority'],
      ['priority 1 two', 'priority'],
      ['priority off 5', 'priority'],
      ['only', 'only'],
      ['only 5 #x', 'only'],
      ['serial', 'serial'],
      ['serial yes', 'serial'],
      ['serial on off', 'serial'],
      ['new', 'new'],
      ['new maybe', 'new'],
      ['override', 'override'],
      ['override 95', 'override'],
      ['override 95 2 3', 'override'],
      ['override x 2', 'override'],
      ['override 0 2', 'override'],
      ['override 101 2', 'override'],
      ['override 95 0', 'override'],
      ['override 95 169', 'override'],
      ['resume', 'resume'],
      ['resume 1 2', 'resume'],
      ['resume issue:abc', 'resume'],
      ['resume run:', 'resume'],
      ['resume a/b', 'resume'],
      ['retry', 'retry'],
      ['retry all', 'retry'],
      [`update ${'x'.repeat(301)}`, 'update'],
      ['drop', 'drop'],
      ['drop 9 10', 'drop'],
      ['note', 'note'],
      ['note #5', 'note'],
      [`note ${'y'.repeat(2001)}`, 'note'],
      ['mode', 'mode'],
      ['mode on', 'mode'],
      ['mode act now', 'mode'],
    ]
    for (const [text, name] of bad) {
      const parsed = parseOp(text)
      expect({ text, ok: parsed.ok }).toEqual({ text, ok: false })
      if (!parsed.ok) {
        expect(parsed.error.endsWith(`Usage: ${USAGE[name]}`)).toBe(true)
        expect(parsed.error.length).toBeLessThan(120)
      }
    }
    const pct = parseOp('override 101 2')
    expect(pct.ok ? '' : pct.error).toBe('override: the percentage is above 0 and at most 100. Usage: override <pct> <hours>|off')
  })

  test('an unknown op lists the ops; help lists them too', () => {
    const unknown = parseOp('frobnicate 5')
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) {
      expect(unknown.error.startsWith('Unknown op "frobnicate". Ops: status, pause <N>,')).toBe(true)
      for (const name of OPS) expect(unknown.error).toContain(USAGE[name])
    }
    const help = parseOp('help')
    expect(help.ok ? '' : help.error.startsWith('Ops: status, pause <N>')).toBe(true)
  })

  test('formatOp is canonical text that parses back to the same op', () => {
    const texts = [
      'status', 'pause #12', 'unpause 12', 'skip 3', 'noskip 3', 'priority 4,2', 'priority off', 'only 522', 'only off',
      'serial on', 'new off', 'override 95% 2h', 'override off', 'resume 60', 'resume 01M4RQ0045AAAA', 'resume run:42',
      'retry 5', 'update', 'update off', 'update base image', 'drop 9', 'note 5 keep it small', 'note be brief', 'mode act',
    ]
    for (const text of texts) expect(op(formatOp(op(text)))).toEqual(op(text))
    expect(formatOp(op('override 95% 2h'))).toBe('override 95 2')
    expect(formatOp(op('resume #60'))).toBe('resume issue:60')
  })
})

describe('applyOp', () => {
  const BUSY: Control = {
    paused: [12],
    noNewWork: false,
    skip: [3],
    priority: [470],
    only: [],
    serial: false,
    usageOverride: null,
    updateDue: null,
    resumed: [{ subject: 'issue:60', at: NOW - HOUR }],
    dropped: [],
    notes: [],
  }

  test('the input is never changed, whatever the op', () => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify(BUSY)) as Control)
    const before = JSON.stringify(frozen)
    const all = [
      'status', 'pause 13', 'unpause 12', 'skip 4', 'noskip 3', 'priority 1 2', 'priority off', 'only 522', 'only off',
      'serial on', 'new off', 'override 95 2', 'override off', 'resume 60', 'resume R1', 'retry 5', 'update', 'update off',
      'drop 9', 'note 5 x', 'mode act',
    ]
    for (const text of all) {
      const applied = applyOp(frozen, op(text), NOW)
      expect(JSON.stringify(frozen)).toBe(before)
      if (applied.changed) expect(applied.control).not.toBe(frozen)
      else expect(applied.control).toBe(frozen)
    }
  })

  test('pause, unpause, skip and noskip add and remove one issue; a repeat changes nothing', () => {
    const paused = applyOp(BUSY, op('pause 13'), NOW)
    expect(paused).toMatchObject({ changed: true, effects: {}, control: { paused: [12, 13] } })
    expect(paused.text).toBe('Paused #13: no action on it until unpause; its claim still renews.')
    expect(applyOp(BUSY, op('pause 12'), NOW)).toMatchObject({ changed: false, text: '#12 is already paused.' })
    expect(applyOp(BUSY, op('unpause 12'), NOW)).toMatchObject({ changed: true, control: { paused: [] }, text: 'Unpaused #12.' })
    expect(applyOp(BUSY, op('unpause 99'), NOW)).toMatchObject({ changed: false, text: '#99 is not paused.' })
    expect(applyOp(BUSY, op('skip 4'), NOW)).toMatchObject({ changed: true, control: { skip: [3, 4] } })
    expect(applyOp(BUSY, op('skip 3'), NOW)).toMatchObject({ changed: false, text: '#3 is already skipped.' })
    expect(applyOp(BUSY, op('noskip 3'), NOW)).toMatchObject({ changed: true, control: { skip: [] }, text: '#3 can be claimed again.' })
    expect(applyOp(BUSY, op('noskip 4'), NOW)).toMatchObject({ changed: false, text: '#4 is not skipped.' })
  })

  test('priority and only replace their list; off clears it (D-35)', () => {
    expect(applyOp(BUSY, op('priority 2 1'), NOW)).toMatchObject({
      changed: true,
      control: { priority: [2, 1] },
      text: 'Priority: #2 #1 are claimed first, in this order.',
    })
    expect(applyOp(BUSY, op('priority 470'), NOW)).toMatchObject({ changed: false, text: 'Priority is already #470.' })
    expect(applyOp(BUSY, op('priority off'), NOW)).toMatchObject({ changed: true, control: { priority: [] }, text: 'Priority cleared.' })
    expect(applyOp(EMPTY_CONTROL, op('priority off'), NOW)).toMatchObject({ changed: false, text: 'No priority is set.' })
    const only = applyOp(BUSY, op('only 340 522'), NOW)
    expect(only).toMatchObject({ changed: true, control: { only: [340, 522], priority: [470] } })
    expect(only.text).toContain('Only #340 #522: claims only these, in this order')
    expect(applyOp(only.control, op('only off'), NOW)).toMatchObject({ changed: true, control: { only: [] } })
    expect(applyOp(BUSY, op('only off'), NOW)).toMatchObject({ changed: false, text: 'Only is already off.' })
  })

  test('serial and new set their switch; new off is noNewWork', () => {
    expect(applyOp(BUSY, op('serial on'), NOW)).toMatchObject({ changed: true, control: { serial: true } })
    expect(applyOp(BUSY, op('serial off'), NOW)).toMatchObject({ changed: false, text: 'Serial is already off.' })
    const off = applyOp(BUSY, op('new off'), NOW)
    expect(off).toMatchObject({ changed: true, control: { noNewWork: true } })
    expect(off.text).toBe('New work off: no new claims, designs or implementations; work in flight goes on.')
    expect(applyOp(off.control, op('new on'), NOW)).toMatchObject({ changed: true, control: { noNewWork: false }, text: 'New work on.' })
    expect(applyOp(BUSY, op('new on'), NOW)).toMatchObject({ changed: false, text: 'New work is already on.' })
  })

  test('override sets usageOverride { untilPct, expiresAt: now + hours }; off clears it (I-19)', () => {
    const set = applyOp(BUSY, op('override 95 2'), NOW)
    expect(set.control.usageOverride).toEqual({ untilPct: 95, expiresAt: NOW + 2 * HOUR })
    expect(set.text).toBe('Usage override: run past the usage tiers up to 95% until 05:00 UTC.')
    const late = applyOp(BUSY, op('override 97.5 23.5'), NOW)
    expect(late.control.usageOverride).toEqual({ untilPct: 97.5, expiresAt: NOW + 23.5 * HOUR })
    expect(late.text).toBe('Usage override: run past the usage tiers up to 97.5% until 2026-10-14 02:30 UTC.')
    expect(applyOp(set.control, op('override off'), NOW)).toMatchObject({ changed: true, control: { usageOverride: null }, text: 'Usage override cleared.' })
    expect(applyOp(set.control, op('override off'), NOW + 3 * HOUR)).toMatchObject({ changed: true, text: 'Expired usage override cleared.' })
    expect(applyOp(BUSY, op('override off'), NOW)).toMatchObject({ changed: false, text: 'No usage override is set.' })
  })

  test('resume appends issue:<N> or run:<id> at now, every time (plan counts resumes)', () => {
    const issueResumed = applyOp(BUSY, op('resume #60'), NOW)
    expect(issueResumed.control.resumed).toEqual([...BUSY.resumed, { subject: 'issue:60', at: NOW }])
    expect(issueResumed.text).toBe('Resumed issue #60: its hold is released.')
    const runResumed = applyOp(issueResumed.control, op('resume 01M4RQ0045AAAA'), NOW + 1)
    expect(runResumed.control.resumed.slice(-1)).toEqual([{ subject: 'run:01M4RQ0045AAAA', at: NOW + 1 }])
    expect(runResumed.text).toBe('Resumed run 01M4RQ0045AAAA: its hold is released.')
  })

  test('retry changes no control: the effect asks the driver for the ledger retry (D-38)', () => {
    const retry = applyOp(BUSY, op('retry #5'), NOW)
    expect(retry).toEqual({ control: BUSY, effects: { retryIssue: 5 }, changed: false, text: 'Retry #5: its exhausted actions are cleared.' })
    expect(retryText(5, [])).toBe('#5 has no exhausted actions: nothing to clear.')
    expect(retryText(5, ['claim:5:new'])).toBe('Retry #5: cleared 1 exhausted action (claim:5:new); its rules try again from the next pass.')
    expect(retryText(5, ['a', 'b', 'c', 'd', 'e'])).toBe('Retry #5: cleared 5 exhausted actions (a, b, c and 2 more); its rules try again from the next pass.')
  })

  test('update sets updateDue { reason, at: now }, owner by default; update off clears it (D-15)', () => {
    const due = applyOp(BUSY, op('update'), NOW)
    expect(due).toMatchObject({ changed: true, control: { updateDue: { reason: 'owner', at: NOW } } })
    expect(due.text).toBe('Update due (owner): the loop drains, then restarts this workspace once nothing is in flight.')
    expect(applyOp(BUSY, op('update base image 1.4.0'), NOW).control.updateDue).toEqual({ reason: 'base image 1.4.0', at: NOW })
    // asked again, the request is new: a failed restart (one attempt) gets a fresh key
    expect(applyOp(due.control, op('update'), NOW + MIN).control.updateDue).toEqual({ reason: 'owner', at: NOW + MIN })
    expect(applyOp(due.control, op('update off'), NOW)).toMatchObject({ changed: true, control: { updateDue: null } })
    expect(applyOp(BUSY, op('update off'), NOW)).toMatchObject({ changed: false, text: 'No update is due.' })
  })

  test('drop appends { issue, at } once; a paused issue is named as still paused (rule D6)', () => {
    const dropped = applyOp(BUSY, op('drop 9'), NOW)
    expect(dropped.control.dropped).toEqual([{ issue: 9, at: NOW }])
    expect(dropped.text).toBe('Dropped #9: the loop abandons it and stops its agents.')
    expect(applyOp(dropped.control, op('drop 9'), NOW + MIN)).toMatchObject({ changed: false, text: '#9 is already dropped.' })
    expect(applyOp(BUSY, op('drop 12'), NOW).text).toBe(
      'Dropped #12: the loop abandons it and stops its agents. It is paused: unpause it for the abandon to run.',
    )
  })

  test('note appends { issue, text, at } for one issue or all', () => {
    const one = applyOp(BUSY, op('note 5 keep the change small'), NOW)
    expect(one.control.notes).toEqual([{ issue: 5, text: 'keep the change small', at: NOW }])
    expect(one.text).toBe('Note added for #5: its next agent prompts carry it.')
    const all = applyOp(one.control, op('note no new dependencies'), NOW + 1)
    expect(all.control.notes).toEqual([...one.control.notes, { issue: null, text: 'no new dependencies', at: NOW + 1 }])
    expect(all.text).toBe('Note added for every issue: the next agent prompts carry it.')
  })

  test('mode changes no control: the effect is the mode to write', () => {
    expect(applyOp(BUSY, op('mode observe'), NOW)).toEqual({
      control: BUSY,
      effects: { mode: 'observe' },
      changed: false,
      text: 'Mode observe set in the workspace config file; it applies from the next pass.',
    })
  })

  test('status answers from the last pass and the control state', () => {
    expect(applyOp(BUSY, op('status'), NOW, PASS)).toEqual({ control: BUSY, effects: {}, changed: false, text: statusText(PASS, BUSY, NOW) })
  })

  test('the control state the ops write is the one plan reads (G4, D1, D-35)', () => {
    let c: Control = EMPTY_CONTROL
    for (const text of ['only 4 2', 'priority 1', 'skip 2']) c = applyOp(c, op(text), NOW).control
    const read = controlFrom(JSON.parse(JSON.stringify(c)))
    const s = state({ queue: [1, 2, 3, 4], issues: [issue(1), issue(2), issue(3), issue(4)] })
    expect(keys(plan({ ...s, control: read }, config()))).toEqual([`claim:4:${NOW - 30 * MIN}`])
    const wound = applyOp(read, op('new off'), NOW).control
    expect(keys(plan({ ...s, control: wound }, config()))).toEqual([])
    const back = applyOp(applyOp(wound, op('new on'), NOW).control, op('only off'), NOW).control
    expect(keys(plan({ ...s, control: back }, config()))).toEqual([`claim:1:${NOW - 30 * MIN}`, `claim:3:${NOW - 30 * MIN}`, `claim:4:${NOW - 30 * MIN}`])
  })
})

describe('status', () => {
  test('no pass yet and no directives', () => {
    expect(statusText(null, EMPTY_CONTROL, NOW)).toBe('Factory loop: no pass yet.\nDirectives: none.')
  })

  test('the last pass, its title and the directives in force, a few short lines', () => {
    const c = control({
      noNewWork: true,
      only: [522],
      paused: [12, 13],
      usageOverride: { untilPct: 95, expiresAt: NOW + 2 * HOUR },
      updateDue: { reason: 'owner', at: NOW - 30 * MIN },
      dropped: [{ issue: 9, at: NOW - HOUR }, { issue: 9, at: NOW }],
      notes: [{ issue: null, text: 'be brief', at: NOW }],
    })
    expect(statusText(PASS, c, NOW).split('\n')).toEqual([
      'Pass 184, 1m ago: act, tier slow, 3 actions, 1 for the owner.',
      '🔄 dev-system (Q:3 - D:5 - M:9) · act · owner 1',
      'Directives: no new work; update due since 02:30 UTC (owner); only #522; paused #12 #13; usage override to 95% until 05:00 UTC; dropped #9; 1 note.',
    ])
  })

  test('an expired override is left out; old times carry their date', () => {
    const c = control({ usageOverride: { untilPct: 95, expiresAt: NOW - 1 }, updateDue: { reason: '', at: NOW - 26 * HOUR } })
    expect(directives(c, NOW)).toEqual(['update due since 2026-10-12 01:00 UTC (no reason)'])
    const quiet = { ...PASS, at: NOW - 2 * HOUR - 5 * MIN, actions: 1, owner: 0 }
    expect(statusText(quiet, EMPTY_CONTROL, NOW).split('\n')[0]).toBe('Pass 184, 2h 5m ago: act, tier slow, 1 action, 0 for the owner.')
    expect(statusText({ ...PASS, at: NOW - 20_000 }, EMPTY_CONTROL, NOW).split('\n')[0]).toContain('20s ago')
  })
})

describe('the files', () => {
  test('control.json: a missing or empty file is no directive; a missing field takes its empty value', () => {
    expect(loadControl(null)).toEqual({ control: EMPTY_CONTROL, error: null })
    expect(loadControl('  \n')).toEqual({ control: EMPTY_CONTROL, error: null })
    expect(loadControl('{"paused":[5]}')).toEqual({ control: { ...EMPTY_CONTROL, paused: [5] }, error: null })
    expect(loadControl('{oops').error).toBe('control.json is not valid JSON')
    expect(loadControl('[1]').error).toBe('control.json is not a JSON object')
    expect(controlPath(LOOP_DIR)).toBe(CONTROL_FILE)
    expect(configFilePath('/cfg')).toBe(CONFIG_FILE)
  })

  test('an op writes the whole control.json, every field, and observe reads back what it wrote', async () => {
    const { io, map, writes } = files({ [CONTROL_FILE]: JSON.stringify({ skip: [3], serial: true }) })
    const reply = await runOp(io, PATHS, 'pause #12', NOW)
    expect(reply).toMatchObject({ ok: true, ping: true, retryIssue: null, mode: null, logged: 'pause 12' })
    expect(writes).toEqual([CONTROL_FILE])
    const written = JSON.parse(map.get(CONTROL_FILE) ?? '')
    expect(Object.keys(written).sort()).toEqual(Object.keys(EMPTY_CONTROL).sort())
    expect(written).toEqual({ ...EMPTY_CONTROL, skip: [3], serial: true, paused: [12] })
    expect(controlFrom(written)).toEqual(reply.control)
    // a missing file is created
    const fresh = files()
    expect((await runOp(fresh.io, PATHS, 'only 522', NOW)).ok).toBe(true)
    expect(JSON.parse(fresh.map.get(CONTROL_FILE) ?? '')).toEqual({ ...EMPTY_CONTROL, only: [522] })
  })

  test('an op that changes nothing, a bad op, or status writes nothing and does not ping', async () => {
    const { io, writes } = files({ [CONTROL_FILE]: JSON.stringify({ paused: [12] }) })
    expect(await runOp(io, PATHS, 'pause 12', NOW)).toMatchObject({ ok: true, ping: false, logged: null, text: '#12 is already paused.' })
    expect(await runOp(io, PATHS, 'pause twelve', NOW)).toMatchObject({ ok: false, ping: false, op: null, text: 'pause: takes one issue number. Usage: pause <N>' })
    const status = await runOp(io, PATHS, 'status', NOW, { last: PASS })
    expect(status).toMatchObject({ ok: true, ping: false })
    expect(status.text).toContain('Directives: paused #12.')
    expect(writes).toEqual([])
  })

  test('an unreadable control.json is never overwritten; status still answers and says so', async () => {
    const { io, map, writes } = files({ [CONTROL_FILE]: '{"paused": [12],' })
    const reply = await runOp(io, PATHS, 'skip 3', NOW)
    expect(reply).toMatchObject({ ok: false, ping: false, text: 'Not changed: control.json is not valid JSON; fix or remove it.' })
    expect(writes).toEqual([])
    expect(map.get(CONTROL_FILE)).toBe('{"paused": [12],')
    const status = await runOp(io, PATHS, '', NOW)
    expect(status.ok).toBe(true)
    expect(status.text.split('\n').slice(-1)).toEqual(['control.json is not valid JSON: fix or remove it.'])
  })

  test('mode writes the workspace config file, keeping its other keys, and not control.json', async () => {
    const before = { repo: 'cbundy/dev-system', mode: 'observe', shadowDevice: 'coder-x', checkout: '/persist/loop', poolSize: 16 }
    const { io, map, writes } = files({ [CONFIG_FILE]: JSON.stringify(before) })
    const reply = await runOp(io, PATHS, 'mode act', NOW)
    expect(reply).toMatchObject({ ok: true, ping: true, mode: 'act', logged: 'mode act' })
    expect(writes).toEqual([CONFIG_FILE])
    const after = JSON.parse(map.get(CONFIG_FILE) ?? '')
    expect(after).toEqual({ ...before, mode: 'act' })
    // the key keeps its place
    expect(Object.keys(after)).toEqual(Object.keys(before))
    expect(withMode(null, 'off')).toEqual({ ok: true, text: '{\n  "mode": "off"\n}\n' })
    expect(withMode('{"repo":"a/b"}', 'off')).toEqual({ ok: true, text: '{\n  "repo": "a/b",\n  "mode": "off"\n}\n' })
  })

  test('a workspace config file that is not a JSON object is left alone', async () => {
    const { io, map, writes } = files({ [CONFIG_FILE]: 'mode=act' })
    expect(await runOp(io, PATHS, 'mode off', NOW)).toMatchObject({
      ok: false,
      ping: false,
      text: 'Not changed: the workspace config file is not valid JSON.',
    })
    expect(withMode('"act"', 'off')).toEqual({ ok: false, error: 'the workspace config file is not a JSON object' })
    expect(writes).toEqual([])
    expect(map.get(CONFIG_FILE)).toBe('mode=act')
  })

  test('retry writes nothing and hands the issue to the driver', async () => {
    const { io, writes } = files()
    expect(await runOp(io, PATHS, 'retry #5', NOW)).toMatchObject({ ok: true, ping: true, retryIssue: 5, logged: 'retry 5' })
    expect(writes).toEqual([])
  })

  test('a failed write is reported, not swallowed', async () => {
    const { io } = files({}, true)
    const reply = await runOp(io, PATHS, 'new off', NOW)
    expect(reply.ok).toBe(false)
    expect(reply.text).toContain('Not changed: the write failed (Error: EROFS')
  })
})

describe('the command and the tool', () => {
  test('the tool takes { op }; only the main conversation sets a directive', async () => {
    const { io, writes } = files()
    for (const input of [null, {}, { op: 5 }, ['pause 5'], 'pause 5']) {
      const reply = await controlTool(io, PATHS, input, NOW)
      expect(reply.ok).toBe(false)
      expect(reply.text.startsWith('Not changed: op is required, as text.')).toBe(true)
    }
    expect(await controlTool(io, PATHS, { op: 'pause 5' }, NOW, { agentId: 'a1' })).toMatchObject({
      ok: false,
      text: 'Not changed: only the main conversation sets owner directives.',
    })
    expect(writes).toEqual([])
    expect((await controlTool(io, PATHS, { op: 'status' }, NOW, { agentId: 'a1' })).ok).toBe(true)
    expect(await controlTool(io, PATHS, { op: 'pause 5' }, NOW)).toMatchObject({ ok: true, text: 'Paused #5: no action on it until unpause; its claim still renews.' })
    expect(writes).toEqual([CONTROL_FILE])
  })

  test('the specs: /factory runs at once, and the tool lists every op', () => {
    expect(FACTORY_COMMAND).toMatchObject({ name: 'factory', argumentHint: '<op>', immediate: true })
    for (const name of OPS) expect(FACTORY_COMMAND.description).toContain(name)
    expect(CONTROL_TOOL.name).toBe('control')
    expect(CONTROL_TOOL.inputSchema).toEqual({
      type: 'object',
      properties: { op: { type: 'string', description: 'one op as /factory takes it, e.g. "only 522" or "new off"' } },
      required: ['op'],
      additionalProperties: false,
    })
    for (const name of OPS) expect(CONTROL_TOOL.description).toContain(USAGE[name])
    // the repo's text rule: no em dash
    expect((CONTROL_TOOL.description + FACTORY_COMMAND.description).includes(String.fromCharCode(0x2014))).toBe(false)
  })
})
