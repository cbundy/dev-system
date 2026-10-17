// The owner's controls (SPEC 4.3; DECISIONS D-15, D-16, D-35, D-38): every `/factory` op and
// its bad forms, applyOp's new Control and effects (the input never changes), control.json and
// the workspace config file through a fake ActIo, the status answer, and the command and tool
// specs. One test feeds the written control.json to plan, so the shapes are the ones it reads.
import { describe, expect, test } from 'claude-code/testing'

import type { PassSummary } from '../types'
import { EMPTY_CONTROL, controlFrom, loadConfig } from '../hooks/config'
import { effectText } from '../hooks/config-keys'
import { sourceOf } from '../hooks/config-view'
import {
  CONTROL_TOOL,
  FACTORY_COMMAND,
  MEANING,
  OPS,
  USAGE,
  applyOp,
  configFilePath,
  controlPath,
  controlTool,
  directives,
  formatOp,
  helpText,
  hintText,
  issuesOf,
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

  test('help reads like a command\'s --help: usage, every op with its arguments and meaning, in one aligned column', () => {
    const lines = helpText().split('\n')
    expect(lines[0]).toBe('Usage: /factory <op> [arguments]')
    const rows = lines.filter(l => l.startsWith('  '))
    expect(rows).toHaveLength(OPS.length + 1)
    for (const name of OPS) expect(rows.some(r => r.startsWith(`  ${USAGE[name]} `) && r.endsWith(MEANING[name]))).toBe(true)
    // every meaning starts in the same column
    const meanings = [...OPS.map(name => MEANING[name]), 'this list']
    expect(new Set(rows.map((r, i) => r.indexOf(meanings[i] ?? ''))).size).toBe(1)
    expect(helpText()).not.toContain('\u2014')
  })

  test('an unknown op lists the ops; help lists them too', () => {
    const unknown = parseOp('frobnicate 5')
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) {
      expect(unknown.error.startsWith('Unknown op "frobnicate". Ops: status, pause <N>,')).toBe(true)
      for (const name of OPS) expect(unknown.error).toContain(USAGE[name])
    }
    for (const name of OPS) expect(helpText()).toContain(USAGE[name])
    expect(parseOp('help')).toEqual({ ok: true, op: { op: 'help' } })
    expect(parseOp('--help')).toEqual(parseOp('help'))
    expect(parseOp('-h')).toEqual(parseOp('help'))
  })

  test('help, --help and -h answer ok with the help page and touch nothing', async () => {
    const { io, writes } = files({})
    for (const input of ['help', '--help', '-h', '/factory help']) {
      expect(await runOp(io, PATHS, input, NOW)).toEqual({
        ok: true, text: helpText(), op: null, control: null, ping: false, retryIssue: null, mode: null, logged: null,
      })
    }
    expect(writes).toEqual([])
  })

  test('the typeahead hint is one short bracketed line of ops parseOp accepts', () => {
    const hint = hintText()
    expect(hint.startsWith('[') && hint.endsWith(']')).toBe(true)
    expect(hint).not.toContain('\n')
    expect(hint.length).toBeLessThanOrEqual(200)
    const alternatives = hint.slice(1, -1).split(' | ')
    expect(alternatives).toContain('help')
    for (const alt of alternatives) {
      const name = alt.split(/[ |]/)[0] as string
      if (name !== 'help') expect(OPS as readonly string[]).toContain(name)
      const sample = alt.replace('update|off', 'update').replace('<N...>|off', '5').replace('<N...>', '5').replace('<N>', '5').replace('[5] ', '').replace('<text>', 'hi').replace('on|off', 'on').replace('off|observe|act', 'act')
      expect(parseOp(sample).ok).toBe(true)
    }
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
    expect(FACTORY_COMMAND).toMatchObject({ name: 'factory', argumentHint: hintText(), immediate: true })
    expect(FACTORY_COMMAND.description.endsWith('see /factory help')).toBe(true)
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

// --- v2's ops (v2 SPEC appendix E, 2.3, 11) ----------------------------------------------------------

function opV2(text: string): Op {
  const parsed = parseOp(text, 'v2')
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error}`)
  return parsed.op
}

describe('the v2 ops (v2 SPEC appendix E)', () => {
  test('planner v1|v2 writes the workspace config file, keeping its other keys, and pings the loop', async () => {
    expect(op('planner v2')).toEqual({ op: 'planner', planner: 'v2' })
    expect(op('PLANNER V1')).toEqual({ op: 'planner', planner: 'v1' })
    for (const bad of ['planner', 'planner v3', 'planner v1 v2']) expect(parseOp(bad)).toEqual({ ok: false, error: 'Usage: planner v1|v2' })
    const before = { repo: 'cbundy/dev-system', mode: 'act', planner: 'v1' }
    const { io, map, writes } = files({ [CONFIG_FILE]: JSON.stringify(before) })
    const reply = await runOp(io, PATHS, 'planner v2', NOW)
    expect(reply).toMatchObject({ ok: true, ping: true, logged: 'planner v2', text: 'Planner v2 set in the workspace config file; it plans and acts from the next pass.' })
    expect(writes).toEqual([CONFIG_FILE])
    expect(JSON.parse(map.get(CONFIG_FILE) ?? '')).toEqual({ ...before, planner: 'v2' })
    expect(formatOp(op('planner v2'))).toBe('planner v2')
  })

  test('under planner v2, resume takes issue numbers and an optional note in double quotes, and no run id', () => {
    expect(opV2('resume 60')).toEqual({ op: 'unpark', issues: [60], note: null })
    expect(opV2('resume #60 61,62 60')).toEqual({ op: 'unpark', issues: [60, 61, 62], note: null })
    expect(opV2('resume 60 "use the old parser, not the new one"')).toEqual({ op: 'unpark', issues: [60], note: 'use the old parser, not the new one' })
    expect(opV2('resume 60 61 ""')).toEqual({ op: 'unpark', issues: [60, 61], note: null })
    const usage = 'resume: under planner v2, takes issue numbers and an optional note in double quotes. Usage: resume <N...> ["note"]|<run id>'
    for (const bad of ['resume', 'resume 01M4RQ0045AAAA', 'resume run:42', 'resume 60 note without quotes', 'resume "only a note"']) {
      expect({ bad, parsed: parseOp(bad, 'v2') }).toEqual({ bad, parsed: { ok: false, error: usage } })
    }
    expect(parseOp(`resume 60 "${'x'.repeat(2001)}"`, 'v2')).toEqual({ ok: false, error: 'resume: the note is at most 2000 characters. Usage: resume <N...> ["note"]|<run id>' })
    // v1 reads it as before: one issue or a run
    expect(op('resume 60')).toEqual({ op: 'resume', subject: 'issue:60' })
    expect(parseOp('resume 60 61').ok).toBe(false)
    // canonical text parses back
    for (const text of ['resume 60', 'resume 60 61 "a note"']) expect(opV2(formatOp(opV2(text)))).toEqual(opV2(text))
  })

  test('a v2 resume appends issue:<N> with its note for each issue, every time; the note is read back from control.json', async () => {
    const applied = applyOp(EMPTY_CONTROL, opV2('resume 60 61 "the answer is yes"'), NOW, null, 'v2')
    expect(applied.control.resumed).toEqual([
      { subject: 'issue:60', at: NOW, note: 'the answer is yes' },
      { subject: 'issue:61', at: NOW, note: 'the answer is yes' },
    ])
    expect(applied.text).toBe('Resumed #60 #61: back to queued, then on from where it parked, with your note for its next step.')
    expect(applyOp(EMPTY_CONTROL, opV2('resume 60'), NOW, null, 'v2').control.resumed).toEqual([{ subject: 'issue:60', at: NOW }])
    const { io, map } = files()
    expect(await runOp(io, PATHS, 'resume 60 "go"', NOW, { planner: 'v2' })).toMatchObject({ ok: true, ping: true, logged: 'resume 60 "go"' })
    expect(controlFrom(JSON.parse(map.get(CONTROL_FILE) ?? '')).resumed).toEqual([{ subject: 'issue:60', at: NOW, note: 'go' }])
  })

  test('a v2 resume of an issue that is not parked changes nothing for it and says to use note', async () => {
    const { io, writes, map } = files()
    expect(await runOp(io, PATHS, 'resume 60', NOW, { planner: 'v2', parked: [61] })).toMatchObject({
      ok: false,
      ping: false,
      text: 'Not changed: #60 is not parked; use /factory note 60.',
    })
    expect(writes).toEqual([])
    const some = await runOp(io, PATHS, 'resume 60 61', NOW, { planner: 'v2', parked: [61] })
    expect(some).toMatchObject({ ok: true, text: 'Resumed #61: back to queued, then on from where it parked. #60 is not parked; use /factory note 60.' })
    expect(controlFrom(JSON.parse(map.get(CONTROL_FILE) ?? '')).resumed).toEqual([{ subject: 'issue:61', at: NOW }])
    // not known (no records read yet): every issue named is resumed, and plan's rows decide
    expect((await runOp(io, PATHS, 'resume 62', NOW, { planner: 'v2', parked: null })).ok).toBe(true)
  })

  test('a v2 drop applies to the life it closes: dropping again, after the issue came back, records it again', () => {
    const dropped = applyOp(EMPTY_CONTROL, op('drop 9'), NOW, null, 'v2')
    expect(dropped).toMatchObject({ changed: true, text: 'Dropped #9: its record closes and its factory labels go; the issue stays open, and adding ready brings it back.' })
    expect(dropped.control.dropped).toEqual([{ issue: 9, at: NOW }])
    const again = applyOp(dropped.control, op('drop 9'), NOW + HOUR, null, 'v2')
    expect(again.changed).toBe(true)
    expect(again.control.dropped).toEqual([{ issue: 9, at: NOW + HOUR }])
    // v1's drop is as it was
    expect(applyOp(dropped.control, op('drop 9'), NOW + HOUR)).toMatchObject({ changed: false, text: '#9 is already dropped.' })
  })

  test('the issues each op names, which its intervention attaches to; a fleet-level op names none', () => {
    const cases: [Op, number[]][] = [
      [op('pause 12'), [12]],
      [op('priority 4 2'), [4, 2]],
      [op('note 5 x'), [5]],
      [op('note x'), []],
      [op('resume 60'), [60]],
      [op('resume R1'), []],
      [opV2('resume 60 61 "x"'), [60, 61]],
      [op('mode act'), []],
      [op('planner v2'), []],
      [op('new off'), []],
    ]
    for (const [o, issues] of cases) expect({ op: formatOp(o), issues: issuesOf(o) }).toEqual({ op: formatOp(o), issues })
  })

  test('status names the planner, and the v2 shadow beside v1; a pass from before the switch names neither', () => {
    const line = (p: Partial<PassSummary>) => statusText({ ...PASS, ...p }, EMPTY_CONTROL, NOW).split('\n')[0]
    expect(line({ planner: 'v2' })).toBe('Pass 184, 1m ago: act, planner v2, tier slow, 3 actions, 1 for the owner.')
    expect(line({ planner: 'v1', shadow: 'v2' })).toBe('Pass 184, 1m ago: act, planner v1 with the v2 shadow, tier slow, 3 actions, 1 for the owner.')
    expect(line({ planner: 'v1', shadow: 'off' })).toBe('Pass 184, 1m ago: act, planner v1, tier slow, 3 actions, 1 for the owner.')
    expect(line({})).toBe('Pass 184, 1m ago: act, tier slow, 3 actions, 1 for the owner.')
  })
})

describe('config set and unset', () => {
  const view = (repo: Record<string, unknown> = {}, workspace: Record<string, unknown> = {}) => {
    const loaded = loadConfig(repo, workspace)
    return { config: loaded.config, device: 'd', poolSize: 16, repoRaw: repo, workspaceRaw: workspace, problems: loaded.problems, modeFrom: 'plugin' as const, deviceFrom: 'env' as const, pluginVersion: '1' }
  }
  const run = (io: FileIo, text: string, from: Parameters<typeof runOp>[4] = {}) => runOp(io, PATHS, text, NOW, from)
  const file = (f: ReturnType<typeof files>) => JSON.parse(f.map.get(CONFIG_FILE) ?? 'null') as unknown

  test('set keeps the other keys, names old, new and when it applies', async () => {
    const f = files({ [CONFIG_FILE]: JSON.stringify({ binDir: '/x', trace: true }) })
    const reply = await run(f.io, 'config set maxInFlightIssues 3', { view: view({ maxInFlightIssues: 5 }) })
    expect(reply).toMatchObject({ ok: true, ping: true, logged: 'config set maxInFlightIssues 3' })
    expect(reply.text).toBe('Set maxInFlightIssues: was 5, now 3; from the next pass.')
    expect(file(f)).toEqual({ binDir: '/x', trace: true, maxInFlightIssues: 3 })
  })

  test('an Ms key writes the spelling typed and drops the other', async () => {
    const f = files({ [CONFIG_FILE]: JSON.stringify({ passEveryMs: 30000, mode: 'act' }) })
    const reply = await run(f.io, 'config set passEvery 90s', { view: view() })
    expect(reply.text).toBe('Set passEvery: was 1m, now 90s; from the next pass.')
    expect(file(f)).toEqual({ mode: 'act', passEvery: '90s' })
  })

  test('a map entry merges into the object, and a list round-trips', async () => {
    const f = files({ [CONFIG_FILE]: JSON.stringify({ stateTimeout: { build: '2h' } }) })
    expect((await run(f.io, 'config set stateTimeout.design 2h', { view: view() })).ok).toBe(true)
    expect((await run(f.io, 'config set gateCommands ["npm test", "npm run lint"]')).ok).toBe(true)
    expect(file(f)).toEqual({ stateTimeout: { build: '2h', design: '2h' }, gateCommands: ['npm test', 'npm run lint'] })
    expect((await run(f.io, 'config set poolSize 4')).ok).toBe(true)
    expect(loadConfig(file(f)).config.gateCommands).toEqual(['npm test', 'npm run lint'])
    expect(loadConfig(file(f)).config.stateTimeoutMs.design).toBe(2 * HOUR)
  })

  test('a timeout says it applies to new work, and a restart key says so', async () => {
    const f = files()
    expect((await run(f.io, 'config set agentTimeout.designer 2h', { view: view() })).text).toContain('from the next pass, to new work')
    expect(effectText('maxLives', { maxLives: 'restart' })).toBe("after the loop's process restarts")
    expect(effectText('maxLives', { maxLives: 'next-pass' })).toBe('from the next pass')
  })

  test('every bad set or unset is refused and the file is untouched', async () => {
    for (const text of [
    'config set maxInFlightIssues lots',
    'config set maxInFlightIssues -1',
    'config set passEvery 6x',
    'config set reviewFixCap "three"',
    'config set nosuchKey 1',
    'config set stateTimeout.nosuch 1h',
    'config set stateTimeout 1h',
    'config set poolSize 0',
    'config set mode act',
    'config set planner v2',
    'config set trace true',
    'config set binDir /x',
    'config unset nosuchKey',
    'config unset mode',
    ]) {
    const body = JSON.stringify({ maxLives: 2 }, null, 1)
    const f = files({ [CONFIG_FILE]: body })
    const reply = await run(f.io, text, { view: view() })
    expect(reply).toMatchObject({ ok: false, ping: false, logged: null })
    expect(reply.text).toContain('Not changed.')
    expect(f.map.get(CONFIG_FILE)).toBe(body)
    expect(f.writes).toEqual([])
    const none = files()
    expect((await run(none.io, text)).ok).toBe(false)
    expect(none.map.has(CONFIG_FILE)).toBe(false)
    }
  })

  test('the loader\'s text and the own-op pointers', async () => {
    const f = files()
    expect((await run(f.io, 'config set maxInFlightIssues lots')).text).toBe('maxInFlightIssues: "lots" is not a whole number or null. Not changed.')
    expect((await run(f.io, 'config set mode act')).text).toContain('/factory mode off|observe|act')
    expect((await run(f.io, 'config set planner v2')).text).toContain('/factory planner v1|v2')
  })

  test('an invalid or non-object workspace file is refused and left alone', async () => {
    for (const body of ['{not json', '[1]']) {
      const f = files({ [CONFIG_FILE]: body })
      const reply = await run(f.io, 'config set maxLives 2')
      expect(reply.ok).toBe(false)
      expect(f.map.get(CONFIG_FILE)).toBe(body)
    }
  })

  test('unset removes both spellings or one entry, and the lower layer applies again', async () => {
    const repo = { maxLives: 4 }
    const f = files({ [CONFIG_FILE]: JSON.stringify({ maxLives: 2, passEveryMs: 1000, passEvery: '5m', stateTimeout: { design: '2h' } }) })
    expect(loadConfig(repo, file(f)).config.maxLives).toBe(2)
    const reply = await run(f.io, 'config unset maxLives', { view: view(repo, file(f) as Record<string, unknown>) })
    expect(reply.text).toBe('Unset maxLives: was 2, now 4; from the next pass.')
    expect(loadConfig(repo, file(f)).config.maxLives).toBe(4)
    expect(loadConfig({}, file(f)).config.maxLives).toBe(3)
    const src = (r: Record<string, unknown>, w: Record<string, unknown>) => sourceOf('maxLives', r, w)
    expect(src(repo, { maxLives: 2 })).toBe('workspace')
    expect(src(repo, file(f) as Record<string, unknown>)).toBe('repo')
    expect(src({}, file(f) as Record<string, unknown>)).toBe('default')
    await run(f.io, 'config unset passEvery')
    await run(f.io, 'config unset stateTimeout.design')
    expect(file(f)).toEqual({})
  })

  test('unset under planner v2 names the v2 default now in force', async () => {
    const f = files({ [CONFIG_FILE]: JSON.stringify({ planner: 'v2', maxInFlightIssues: 5 }) })
    const reply = await run(f.io, 'config unset maxInFlightIssues', { view: view({}, file(f) as Record<string, unknown>) })
    expect(reply.text).toBe('Unset maxInFlightIssues: was 5, now 3; from the next pass.')
    expect(file(f)).toEqual({ planner: 'v2' })
  })

  test('a set that moves a short-spelling map to Ms turns its durations into numbers', async () => {
    const f = files({ [CONFIG_FILE]: JSON.stringify({ stateTimeout: { design: '2h' } }) })
    expect((await run(f.io, 'config set stateTimeoutMs.build 100', { view: view() })).ok).toBe(true)
    expect(file(f)).toEqual({ stateTimeoutMs: { design: 2 * HOUR, build: 100 } })
    expect(loadConfig(file(f)).problems).toEqual([])
  })

  test('unset of a key the file does not set changes nothing', async () => {
    const f = files({ [CONFIG_FILE]: '{"maxLives":2}' })
    const reply = await run(f.io, 'config unset maxTriages')
    expect(reply).toMatchObject({ ok: true, ping: false, logged: null })
    expect(reply.text).toContain('nothing changed')
    expect(f.writes).toEqual([])
    expect((await run(f.io, 'config unset stateTimeout.design')).text).toContain('nothing changed')
  })

  test('an agent may read config but not set or unset it', async () => {
    const f = files()
    const v = view()
    expect((await run(f.io, 'config', { agentId: 'a1', view: v })).ok).toBe(true)
    for (const text of ['config set maxLives 2', 'config unset maxLives']) {
      expect(await run(f.io, text, { agentId: 'a1', view: v })).toMatchObject({ ok: false, ping: false })
    }
    expect(f.writes).toEqual([])
  })

  test('forms parse, format and parse back; any other word is the usage', () => {
    for (const text of ['config set maxInFlightIssues 3', 'config set gateCommands ["npm test"]', 'config set passEvery "6h"', 'config set maxInFlightIssues null', 'config unset stateTimeout.design']) {
      const parsed = op(text)
      expect(formatOp(parsed)).toBe(text)
      expect(op(formatOp(parsed))).toEqual(parsed)
    }
    expect(op('config set reviewer adjudicator')).toEqual({ op: 'config', change: { key: 'reviewer', value: 'adjudicator' } })
    expect(op('config set passEvery 6h')).toEqual({ op: 'config', change: { key: 'passEvery', value: '6h' } })
    for (const text of ['config foo', 'config set', 'config set key', 'config unset', 'config unset a b']) {
      expect(parseOp(text)).toEqual({ ok: false, error: 'Usage: config [set <key> <value>|unset <key>]' })
    }
  })

  test('help, hint and the tool name both forms', () => {
    for (const text of [helpText(), hintText(), CONTROL_TOOL.description ?? '']) {
      expect(text).toContain('config set')
      expect(text).toContain('config unset')
    }
  })
})
