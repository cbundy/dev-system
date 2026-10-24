// The agents' answer contract (v2 SPEC 13.7.3a): what each v2 agent's answer must hold, checked
// field by field with every problem named at once, and the files of the answer script (#561). One
// plain-JS module with one reader of each answer: the loop imports it, and so does
// bin/factory-answer under plain node, so the script and the loop's own re-check of the script's
// file cannot drift.
// tests/answer-contract.test.ts (the loop) and tests/factory-loop-answer.test.js at the repo
// root (the script, run for real) hold both ends to one table of cases (tests/answer-cases.mjs).
// It uses ES2023 alone, nothing of Node or the engine. Its types are contract.d.mts's.
//
// The v2 rule layer's contracts (docs/factory-loop/v2/SPEC.md 5.2, 8.2, 8.7) live in
// v2/contracts-*.mjs, one module per area; this module imports them, so the answer script and the
// loop check a v2 answer alike, and a job's contract is one of their names.

import { CONTRACTS as REVIEW } from './v2/contracts-review.mjs'
import { CONTRACTS as TRIAGE } from './v2/contracts-triage.mjs'
import { CONTRACTS as WORK } from './v2/contracts-work.mjs'

// v2's contracts by name, each { check(input, job), summary(input) }.
export const V2_CONTRACTS = Object.freeze({ ...WORK, ...REVIEW, ...TRIAGE })
const CONTRACTS = Object.freeze(Object.keys(V2_CONTRACTS))

function record(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null
}

// clip: a value quoted in a problem as the model wrote it, cut to a readable length.
function clip(v) {
  const s = typeof v === 'string' ? JSON.stringify(v.length > 120 ? `${v.slice(0, 117)}...` : v) : (JSON.stringify(v) ?? String(v))
  return s.length > 124 ? `${s.slice(0, 121)}...` : s
}

// checkAnswer: an answer under its job: the contract, and what checking it needs (the repo and
// issue, the branch, the job's data). Every channel checks through this one call: the loop's
// re-check with the job the loop knows from its ledger, the script with the job file the loop wrote
// at the spawn.
export function checkAnswer(job, input) {
  const v2 = Object.hasOwn(V2_CONTRACTS, job.contract) ? V2_CONTRACTS[job.contract] : undefined
  if (v2 === undefined) return { ok: false, problems: [`the factory loop has no ${clip(job.contract)} contract`] }
  return v2.check(input, job)
}

// --- the answer script's files (#561) ------------------------------------------------------------

// An agent's answer file, at a path the loop names in its prompt, unique to the ledger entry and
// attempt, in <loop dir>/answers/; beside it the job file the loop writes before the spawn. The
// script writes the answer file alone, and only where a job file stands.
export const ANSWER_SUFFIX = '.answer.json'
export const JOB_SUFFIX = '.job.json'
export const ANSWER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.answer\.json$/
// The loop dir's own name: <owner>__<repo> (loopDirOf).
export const LOOP_DIR_NAME = /^[A-Za-z0-9._-]+__[A-Za-z0-9._-]+$/

// loopBaseOf: the factory loop's directory under a config dir (CLAUDE_CONFIG_DIR, else
// ~/.claude), a trailing / on it dropped: its config.json, its OFF file and every repo's loop dir.
export function loopBaseOf(configDir) {
  return `${configDir.replace(/\/+$/, '')}/factory-loop`
}

// loopDirOf: a repo's loop dir, <config dir>/factory-loop/<owner>__<repo>: where the loop keeps
// that repo's files (register.ts runtime), and whose answers/ directory is the only place the
// answer script writes, for a job of that repo.
export function loopDirOf(configDir, repo) {
  return `${loopBaseOf(configDir)}/${repo.replace('/', '__')}`
}
const FILE_VERSION = 1

// jobPathOf: the job file beside an answer file, or null for a path that names no answer file.
export function jobPathOf(answerPath) {
  const slash = answerPath.lastIndexOf('/')
  const name = answerPath.slice(slash + 1)
  return ANSWER_NAME.test(name) ? `${answerPath.slice(0, slash + 1)}${name.slice(0, -ANSWER_SUFFIX.length)}${JOB_SUFFIX}` : null
}

// jobText: the job file's body. A job's data (what its contract's check needs beside the
// answer) goes in only when it has some.
export function jobText(job) {
  const body = { v: FILE_VERSION, contract: job.contract, purpose: job.purpose, repo: job.repo, issue: job.issue, branch: job.branch }
  if (job.data !== undefined && job.data !== null) body.data = job.data
  return `${JSON.stringify(body, null, 2)}\n`
}

// parseJob: a job file's body as a job, or why it is none.
export function parseJob(body) {
  let v
  try {
    v = JSON.parse(body)
  } catch {
    return 'the job file is not JSON'
  }
  const o = record(v)
  if (o === null || o.v !== FILE_VERSION) return `the job file is not version ${FILE_VERSION} of the factory loop's job files`
  const contract = CONTRACTS.find(c => c === o.contract)
  const issue = o.issue === null || (Number.isInteger(o.issue) && o.issue > 0) ? o.issue : undefined
  const branch = o.branch === null || (typeof o.branch === 'string' && o.branch !== '') ? o.branch : undefined
  const data = o.data === undefined || o.data === null ? null : (record(o.data) ?? undefined)
  if (contract === undefined || o.purpose !== null || typeof o.repo !== 'string' || issue === undefined || branch === undefined || data === undefined) return 'the job file is not in the shape the factory loop writes'
  return data === null ? { contract, purpose: null, repo: o.repo, issue, branch } : { contract, purpose: null, repo: o.repo, issue, branch, data }
}

// answerSummary: a few words on an answer the script recorded, so the agent sees the loop will
// read what it meant.
export function answerSummary(contract, input) {
  return V2_CONTRACTS[contract].summary(input)
}

// answerText: the answer file's body for an input its job's contract takes, or the problems
// that keep it out. The input is kept as the agent gave it: the loop checks it again on reading.
export function answerText(job, input) {
  const check = checkAnswer(job, input)
  if (!check.ok) return check
  return { ok: true, outcome: `${JSON.stringify({ v: FILE_VERSION, contract: job.contract, answer: input }, null, 2)}\n` }
}

// parseAnswer: an answer file's body: the answer it carries, for this contract, still to be
// checked; or why it carries none.
export function parseAnswer(body, contract) {
  let v
  try {
    v = JSON.parse(body)
  } catch {
    return { ok: false, problems: ['the answer file is not JSON'] }
  }
  const o = record(v)
  if (o === null || o.v !== FILE_VERSION || !('answer' in o)) return { ok: false, problems: ['the answer file is not in the shape the answer script writes'] }
  if (o.contract !== contract) return { ok: false, problems: [`the answer file holds a ${clip(o.contract)} answer, and this agent answers with ${contract}`] }
  return { ok: true, outcome: o.answer }
}
