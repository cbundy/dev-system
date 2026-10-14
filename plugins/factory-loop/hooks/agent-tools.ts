// The answer tools the loop's agents call (#548): the adjudicator's verdict, the designer's
// result and the implementer's or fixer's handoff, each a tool whose input schema is the
// contract its text lines carry (replies.ts), and whose errors the model reads and corrects in
// the same turn. The handler (act.ts agentToolAnswered) ties a call to its ledger entry by the
// caller's agentId. The registered tools are the intended answer channel; until a timer-spawned
// agent reaches them (#560), agents answer through the checked script bin/factory-answer instead
// (#561, config answerChannel). Both check an answer with contract.mjs, which takes nothing on
// trust from the engine's own schema check (the test kit makes none) and adds what a schema
// cannot say: the action the purpose allows, the fields that action takes, the finding ids a
// fix names, a brief on the designed issue. The text lines stay the fallback (SPEC 7.3), and the
// tools wait behind ToolSearch, as the wake answer tool does, so they cost the main conversation
// nothing.
import type { ToolSpec } from 'claude-code'

import { BUMPS, FLAGS, VERDICTS } from './contract.mjs'
import type { Check } from './contract.mjs'
import type { AgentType } from './types'

// The checks are the contract's, which the answer script shares (#561).
export { checkDesign, checkHandoff, checkVerdict } from './contract.mjs'

// The tool each agent answers with, by its full name.
export const VERDICT = 'mcp__factory-loop__verdict'
export const DESIGN = 'mcp__factory-loop__design'
export const HANDOFF = 'mcp__factory-loop__handoff'
export const TOOL_OF: Record<AgentType, string> = { adjudicator: VERDICT, designer: DESIGN, implementer: HANDOFF, fixer: HANDOFF }

const nullable = (type: string, description: string) => ({ type: [type, 'null'], description })

export const VERDICT_TOOL: ToolSpec = {
  name: 'verdict',
  description:
    "The factory loop's adjudicator answer, in place of verdict and ACTION lines: one call at the end of your judgement. " +
    'findings: one entry per finding you judged ([] for a clean review). action: exactly one; a gate or test-weakening review ' +
    'takes approve, fix, skip, fixer or escalate, a merge review merge, hold, fixer or escalate, and a merge review also gives ' +
    'summary, bump and flags. An error says what is wrong: correct the call and call it again; once it is recorded, end your turn.',
  inputSchema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: "the reviewer's finding id (review-1); a gap the reviewer missed takes an id of your own, missed-1 and on, and goes in action.addFinding, never action.findings",
            },
            verdict: { type: 'string', enum: [...VERDICTS] },
            reason: { type: 'string', description: 'one sentence with the evidence' },
          },
          required: ['id', 'verdict', 'reason'],
          additionalProperties: false,
        },
      },
      action: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['approve', 'fix', 'skip', 'fixer', 'escalate', 'merge', 'hold'] },
          reason: { type: 'string', description: 'approve: the evidence, optional; hold: why the owner must decide' },
          findings: { type: 'array', items: { type: 'string' }, description: "fix: ids of the reviewer's CORRECT or ENV findings above for the pipeline to fix" },
          instructions: { type: 'string', description: 'fix: what the pipeline should change; fixer: what the fixer agent should do' },
          addFinding: { type: 'object', description: 'fix: a finding the reviewer missed, as no-mistakes takes it' },
          why: { type: 'string', description: 'escalate: what the owner must decide' },
        },
        required: ['type'],
        additionalProperties: false,
      },
      summary: { type: 'string', description: 'merge review: what changes for users, one line' },
      bump: {
        type: 'object',
        properties: { level: { type: 'string', enum: [...BUMPS] }, reason: { type: 'string' } },
        required: ['level', 'reason'],
        additionalProperties: false,
        description: 'merge review: the release bump and why',
      },
      flags: { type: 'array', items: { type: 'string', enum: [...FLAGS] }, description: 'merge review: [] for none' },
    },
    required: ['findings', 'action'],
    additionalProperties: false,
  },
  isDeferred: true,
}

export const DESIGN_TOOL: ToolSpec = {
  name: 'design',
  description:
    "The factory loop's designer answer, in place of the RESULT line: one call once the brief is posted. brief: the brief " +
    "comment's URL on the designed issue, or null; created: the issues you created ([] for none); pendingDecision: true when " +
    'the brief waits on an owner decision. An error says what is wrong: correct the call and call it again; once it is recorded, end your turn.',
  inputSchema: {
    type: 'object',
    properties: {
      brief: nullable('string', "the brief comment's URL (https://github.com/<owner>/<repo>/issues/<N>#issuecomment-<id>), or null"),
      created: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'issue numbers you created; [] for none' },
      pendingDecision: { type: 'boolean' },
    },
    required: ['brief', 'created', 'pendingDecision'],
    additionalProperties: false,
  },
  isDeferred: true,
}

export const HANDOFF_TOOL: ToolSpec = {
  name: 'handoff',
  description:
    "The factory loop's handoff from an implementer or fixer, in place of the RESULT line: one call after the implement-issue " +
    'handoff. run and head: the pipeline run you started or drove and its head from `no-mistakes status`; commit: your latest ' +
    'commit, null when you committed nothing; gated: true only with a run, when its head equals your commit or you committed nothing; branch: ' +
    'the branch the work is on now; pr: the PR number, or null. An error says what is wrong: correct the call and call it again; ' +
    'once it is recorded, end your turn.',
  inputSchema: {
    type: 'object',
    properties: {
      run: nullable('string', 'the pipeline run id, or null'),
      head: nullable('string', "the run's head SHA, or null"),
      commit: nullable('string', 'your latest commit SHA, or null'),
      gated: { type: 'boolean' },
      branch: nullable('string', 'the branch the work is on now'),
      pr: nullable('integer', 'the PR number, or null'),
    },
    required: ['run', 'head', 'commit', 'gated', 'branch', 'pr'],
    additionalProperties: false,
  },
  isDeferred: true,
}

export const AGENT_TOOLS: readonly ToolSpec[] = [VERDICT_TOOL, DESIGN_TOOL, HANDOFF_TOOL]

// What a check gives: the outcome the text contract would, or every problem at once, so the
// model fixes them in one more call.
export type ToolCheck<O> = Check<O>
