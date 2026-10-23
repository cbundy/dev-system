// `/factory help config` (v2 SPEC 13.4.3): the list of every setting `config set` accepts. The key set
// is derived from the loader, so a key added to DEFAULT_CONFIG without a SETTING_HELP line fails here.
import { describe, expect, test } from 'claude-code/testing'

import { ATTEMPT_KEYS, DEFAULT_CONFIG } from '../hooks/config'
import { FIRST_LOOP_KEYS, SETTING_HELP, configHelpRows, configHelpText, defaultText, settableKeys, typedKey } from '../hooks/config-help'
import { DEFAULT_POOL_SIZE, OWN_OP, RUNTIME_KEYS, checkKey } from '../hooks/config-keys'

const text = configHelpText()
const keyLines = text.split('\n').filter(l => l.startsWith('  ') && !l.trimStart().startsWith('names:'))

describe('help config', () => {
  test('SETTING_HELP holds exactly the settable keys the loader derives', () => {
    const derived = [...Object.keys(DEFAULT_CONFIG), 'poolSize'].filter(
      k => !(k in OWN_OP) && !(RUNTIME_KEYS.includes(k) && k !== 'poolSize') && !FIRST_LOOP_KEYS.includes(k),
    )
    expect(Object.keys(SETTING_HELP).sort()).toEqual([...derived].sort())
    expect(settableKeys().sort()).toEqual([...derived].sort())
    for (const key of derived) expect(SETTING_HELP[key]?.length ?? 0).toBeGreaterThan(0)
  })

  test('every settable key is listed with its default, and every key passes checkKey', () => {
    expect(configHelpRows().map(r => r.key)).toEqual(settableKeys())
    for (const row of configHelpRows()) {
      expect(keyLines.some(l => l.startsWith(`  ${row.entries === null ? row.typed : `${row.typed}.<name>`} `) && l.includes(`(default: ${defaultText(row.key)})`))).toBe(true)
      if (row.entries === null) {
        expect(checkKey(row.typed)).toMatchObject({ ok: true })
      } else {
        for (const entry of row.entries) {
          expect(text).toContain(entry)
          expect(checkKey(`${row.typed}.${entry}`)).toMatchObject({ ok: true })
        }
      }
    }
  })

  test('durations show their short spelling, maps their entries, poolSize its default', () => {
    expect(keyLines.some(l => l.startsWith('  passEvery ') && l.includes('(default: 1m)'))).toBe(true)
    expect(text).not.toContain('passEveryMs')
    expect(defaultText('poolSize')).toBe(String(DEFAULT_POOL_SIZE))
    expect(defaultText('releaseBranchPrefix')).toBe('none')
    expect(defaultText('gateCommands')).toBe('[]')
    expect(defaultText('intakeAreas')).toBe('["factory","product"]')
    expect(defaultText('wakeTimeoutMs')).toBe('judge 30m, task 6h, tell 30m')
    expect(defaultText('rateCaps')).toBe('start 30, spawn 120, wake 20, perIssueKind 6')
    const attempts = text.split('\n').find(l => l.includes('maxAttempts.<name>')) ?? ''
    expect(attempts).toContain('any other kind is 3')
    expect(attempts).toContain('claim 3')
    for (const kind of ATTEMPT_KEYS) expect(text).toContain(kind)
  })

  test('mode, trace, the runtime keys and retired keys are not listed; the first-loop keys share one line', () => {
    for (const key of ['mode', 'trace', 'shadowDevice', 'runSource', 'toolsDir', 'planner', 'shadow', 'answerTools']) {
      expect(keyLines.some(l => l.startsWith(`  ${key} `) || l.startsWith(`  ${typedKey(key)} `))).toBe(false)
    }
    expect(text).toContain('/factory mode')
    expect(text).toContain('/factory trace')
    const line = text.split('\n').filter(l => FIRST_LOOP_KEYS.some(k => l.includes(k)))
    expect(line).toHaveLength(1)
    for (const key of FIRST_LOOP_KEYS) {
      expect(line[0]).toContain(key)
      expect(keyLines.some(l => l.startsWith(`  ${key} `))).toBe(false)
    }
    expect(text).not.toContain('—')
  })
})
