// The job and test names a failed run's log names (docs/factory-loop/v2/SPEC.md 8.5): pure. Each
// line of `gh run view <id> --log-failed` is `<job>\t<step>\t<timestamp> <text>`. The test rules
// are the stop gate parser's (factory-loop-workspace), kept in step here: this plugin has its own copy.

// the intervention schema's bounds (docs/factory-events/schemas/intervention.v1.json)
const NAMES_MAX = 20
const NAME_MAX = 200

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/

function testOf(text: string): string | null {
  const line = text.replace(ANSI, '').replace(STAMP, '').trim()
  const fail = /^FAIL (.+)$/.exec(line)
  if (fail?.[1] !== undefined) {
    const name = fail[1].trim()
    // the wrapper line of a failed suite, not a test
    return name.endsWith('(claude plugin validate / test)') || name === '' ? null : name
  }
  const bun = /^\(fail\) (.+)$/.exec(line)
  return bun?.[1] !== undefined && bun[1].trim() !== '' ? bun[1].trim() : null
}

function bounded(names: string[]): string[] | null {
  const out = [...new Set(names.map(n => n.slice(0, NAME_MAX)))].slice(0, NAMES_MAX)
  return out.length === 0 ? null : out
}

export function logFailedNames(stdout: string): { failedJobs: string[] | null; failedTests: string[] | null } {
  const jobs: string[] = []
  const tests: string[] = []
  for (const row of stdout.split('\n')) {
    const cols = row.replace(/\r$/, '').split('\t')
    const job = cols[0]?.trim()
    if (job === undefined || job === '' || cols.length < 3) continue
    jobs.push(job)
    const test = testOf(cols.slice(2).join('\t'))
    if (test !== null) tests.push(test)
  }
  return { failedJobs: bounded(jobs), failedTests: bounded(tests) }
}
