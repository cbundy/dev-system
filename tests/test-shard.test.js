'use strict'
// scripts/test.sh shard mode (TEST_SHARD=K/N) and list mode (--list).
// Runs inside `npm test`, so it hands the child the env a standalone run would see.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')

function cleanEnv(extra = {}) {
  const env = { ...process.env }
  for (const k of ['FACTORY_TEST_PG_ADMIN_URL', 'CALLUM_EVENTS_DIR', 'NO_MISTAKES_HOME', 'NM_PUSH_STATE_DIR',
    'AGENTSVIEW_DATA_DIR', 'TEST_SANDBOX', 'TEST_RESULTS_DIR', 'TEST_NODE_FILES', 'TEST_JOB_FAILED', 'TEST_REQUIRE_POSTGRES',
    'NODE_TEST_CONTEXT', 'TEST_SHARD']) delete env[k]
  return { ...env, ...extra }
}

function run(args, extra = {}) {
  return spawnSync('sh', ['scripts/test.sh', ...args], { cwd: root, encoding: 'utf8', env: cleanEnv(extra) })
}

function list(shard) {
  const r = run(['--list'], shard ? { TEST_SHARD: shard } : {})
  assert.strictEqual(r.status, 0, r.stderr)
  return r.stdout.split('\n').filter(Boolean)
}

function globbed(dir) {
  const d = path.join(root, dir)
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.test.sh')).sort().map((f) => `${dir}/${f}`) : []
}

const SLOW_FIRST = ['node', 'features/test/callum-tools/watchers.test.sh', 'features/test/callum-tools/orchestrator-watch.test.sh']

const full = list()

test('--list prints node, every suite and every mod, slow-first entries first', () => {
  const suites = [...globbed('features/test/callum-tools'), ...globbed('coder/test'), ...globbed('images/base/test')]
  const expected = new Set(['node', ...suites])
  const hasClaude = spawnSync('sh', ['-c', 'command -v claude']).status === 0
  if (hasClaude) {
    for (const p of fs.readdirSync(path.join(root, 'plugins'))) {
      const hooks = path.join(root, 'plugins', p, 'hooks', 'hooks.json')
      if (fs.existsSync(hooks) && fs.readFileSync(hooks, 'utf8').includes('"modules"')) expected.add(`plugins/${p}`)
    }
  }
  assert.deepStrictEqual(new Set(full), expected)
  assert.strictEqual(full.length, expected.size)
  const present = SLOW_FIRST.filter((id) => expected.has(id))
  assert.deepStrictEqual(full.slice(0, present.length), present)
})

test('every shard of N covers the unsharded list exactly once, round robin', () => {
  for (const n of [1, 2, 3, 4, full.length + 3]) {
    const seen = []
    for (let k = 1; k <= n; k++) {
      const part = list(`${k}/${n}`)
      assert.deepStrictEqual(part, full.filter((_, i) => i % n === k - 1), `shard ${k}/${n}`)
      seen.push(...part)
    }
    assert.strictEqual(seen.length, full.length, `N=${n}`)
    assert.deepStrictEqual(new Set(seen), new Set(full), `N=${n}`)
  }
})

test('with N = 3 the slow-first jobs land in three different shards', () => {
  const present = SLOW_FIRST.filter((id) => full.includes(id))
  const shards = present.map((id) => [1, 2, 3].find((k) => list(`${k}/3`).includes(id)))
  assert.strictEqual(new Set(shards).size, present.length)
})

for (const bad of ['0/3', '4/3', '3', 'a/b', '1/0', '01/3', '1/03', '-1/3', '1/2/3', ' 1/2']) {
  test(`TEST_SHARD='${bad}' exits 2 with one error line before any setup`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-tmp-'))
    try {
      const t0 = Date.now()
      const r = run([], { TEST_SHARD: bad, TMPDIR: tmp })
      assert.strictEqual(r.status, 2)
      assert.strictEqual(r.stdout, '')
      const lines = r.stderr.trim().split('\n')
      assert.strictEqual(lines.length, 1)
      assert.match(lines[0], /invalid TEST_SHARD.*K\/N/)
      assert.ok(Date.now() - t0 < 10000)
      assert.deepStrictEqual(fs.readdirSync(tmp), [])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
}

test('TEST_SHARD together with an id exits 2 with one error line', () => {
  const r = run(['node'], { TEST_SHARD: '1/2' })
  assert.strictEqual(r.status, 2)
  assert.strictEqual(r.stdout, '')
  assert.strictEqual(r.stderr.trim().split('\n').length, 1)
  assert.match(r.stderr, /TEST_SHARD cannot be combined with ids/)
})

test('one real shard runs only its job and says it is not the gate', () => {
  const id = 'features/test/callum-tools/test-sandbox.test.sh'
  const pos = full.indexOf(id)
  assert.ok(pos >= 0)
  const n = full.length
  const r = run([], { TEST_SHARD: `${pos + 1}/${n}` })
  assert.strictEqual(r.status, 0, r.stdout + r.stderr)
  const last = r.stdout.trim().split('\n').pop()
  assert.ok(last.startsWith(`test: shard ${pos + 1}/${n} ok: 0 node tests, 1 shell suites, 0 mods - one shard of the gate`), last)
})
