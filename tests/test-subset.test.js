'use strict'
// scripts/test.sh subset mode (`npm test -- <id>...`) and scripts/test-job.sh's TEST_NODE_FILES.
// Runs inside `npm test`, so it hands the child the env a standalone run would see: no sandbox
// or PostgreSQL variables from the outer run, so the child makes its own and cleans them.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')

function cleanEnv(extra = {}) {
  const env = { ...process.env }
  for (const k of ['FACTORY_TEST_PG_ADMIN_URL', 'CALLUM_EVENTS_DIR',
    'AGENTSVIEW_DATA_DIR', 'TEST_SANDBOX', 'TEST_RESULTS_DIR', 'TEST_NODE_FILES', 'TEST_JOB_FAILED', 'TEST_REQUIRE_POSTGRES', 'TEST_REQUIRE_TAGS', 'NODE_TEST_CONTEXT']) delete env[k]
  return { ...env, ...extra }
}

test('an unknown id exits 2 with one error line, before any setup', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subset-tmp-'))
  try {
    const t0 = Date.now()
    const r = spawnSync('sh', ['scripts/test.sh', 'no/such.test.sh'], { cwd: root, encoding: 'utf8', env: cleanEnv({ TMPDIR: tmp }) })
    assert.strictEqual(r.status, 2)
    assert.strictEqual(r.stdout, '')
    const lines = r.stderr.trim().split('\n')
    assert.strictEqual(lines.length, 1)
    assert.match(lines[0], /unknown id 'no\/such\.test\.sh'.*node.*tests\/<name>\.test\.js.*\*\.test\.sh.*mod directory/)
    assert.ok(Date.now() - t0 < 10000, 'fails fast, with no PostgreSQL start')
    // nothing left behind in TMPDIR: no sandbox, no private cluster, no results dir
    assert.deepStrictEqual(fs.readdirSync(tmp), [])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('an inherited TMPDIR under /persist is never written to and the sandbox stays outside it', () => {
  const tmp = `/persist/npm-test-826-${process.pid}-${Date.now()}`
  const r = spawnSync('sh', ['scripts/test.sh', 'features/test/callum-tools/test-sandbox.test.sh'], { cwd: root, encoding: 'utf8', env: cleanEnv({ TMPDIR: `${tmp}/tmp` }) })
  assert.strictEqual(r.status, 0, r.stdout + r.stderr)
  assert.ok(!fs.existsSync(tmp), 'the inherited TMPDIR was created')
})

test('named node files run as one subset job and the last line says it is not the gate', () => {
  const r = spawnSync('sh', ['scripts/test.sh', 'tests/forbid-git-stash.test.js'], { cwd: root, encoding: 'utf8', env: cleanEnv() })
  assert.strictEqual(r.status, 0, r.stdout + r.stderr)
  const last = r.stdout.trim().split('\n').pop()
  const m = last.match(/^test: subset of 1 jobs ok \((\d+) node tests\) - not the gate; run npm test/)
  assert.ok(m, last)
  assert.ok(Number(m[1]) > 0)
})

test('a failing node file in TEST_NODE_FILES prints the reporter failure and exits 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subset-fail-'))
  try {
    const file = path.join(dir, 'broken.test.js')
    fs.writeFileSync(file, "const t = require('node:test'); t('boom', () => { throw new Error('subset-fixture-failure') })\n")
    const failed = path.join(dir, 'failed')
    const r = spawnSync('sh', ['scripts/test-job.sh', 'node'], {
      cwd: root, encoding: 'utf8', env: cleanEnv({ TEST_NODE_FILES: file, TEST_JOB_FAILED: failed }),
    })
    assert.strictEqual(r.status, 1)
    assert.match(r.stdout, /boom/)
    assert.match(r.stdout, /subset-fixture-failure/)
    assert.strictEqual(fs.readFileSync(failed, 'utf8').trim(), '1')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
