'use strict'
// Guard: a factory-loop test that takes the engine (`async ($` ...) must pass an options argument
// (ENGINE_TEST from plugins/factory-loop/tests/host.ts, or a larger named budget) between its title
// and its body. Without it the kit's 5 s wall-clock default applies, which a loaded machine passes
// because the engine loads the plugin afresh per test (issue 855).
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const DIR = path.join(__dirname, '..', 'plugins', 'factory-loop', 'tests')
const STR = String.raw`(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|` + '`(?:[^`\\\\]|\\\\.)*`)'
const NO_OPTIONS = new RegExp(String.raw`\btest\(\s*${STR}\s*,\s*async\s*\(\s*\$`, 'g')

// missingBudgets: file:line of every test that takes `$` with no options argument.
function missingBudgets(file, text) {
  const out = []
  for (const m of text.matchAll(NO_OPTIONS)) {
    const line = text.slice(0, m.index).split('\n').length
    out.push(`${file}:${line}`)
  }
  return out
}

test('the guard finds a test that takes the engine and has no options argument', () => {
  const bad = "x\n  test('a, b', async ($, on) => {\n  })\n  test(`c\nd`, async ($) => {})\n"
  assert.deepStrictEqual(missingBudgets('f.ts', bad), ['f.ts:2', 'f.ts:4'])
  const ok = "test('a', ENGINE_TEST, async ($, on) => {})\ntest('b', { timeoutMs: 9 }, async ($) => {})\n"
  assert.deepStrictEqual(missingBudgets('f.ts', ok), [])
})

test('every factory-loop test that takes the engine passes a time budget', () => {
  const found = []
  for (const f of fs.readdirSync(DIR).filter(n => n.endsWith('.test.ts')).sort()) {
    found.push(...missingBudgets(`plugins/factory-loop/tests/${f}`, fs.readFileSync(path.join(DIR, f), 'utf8')))
  }
  assert.deepStrictEqual(found, [], `tests without a time budget (pass ENGINE_TEST from tests/host.ts as the second argument):\n${found.join('\n')}`)
})
