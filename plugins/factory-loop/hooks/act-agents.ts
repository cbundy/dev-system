// What the loop knows of the agents it started (SPEC 6.1, 7.3): the agent type each is spawned as,
// and whether the agent list shows one still at work. Its spawns and answers are v2's (v2/steps.ts).
import type { AgentStatus, AgentType } from './types'

// The agent type each agent is spawned as. The callum-flow adjudicator and designer list their
// tools, and an agent calls nothing its list leaves out, so they could never reach their answer
// tools (#548): the loop spawns its own copies of them (agents/*.md), the same definitions with
// ToolSearch and the answer tool added to `tools:`, which tests/factory-loop-agents.test.js keeps
// in step. The implementer and fixer list no tools, so they inherit every one.
export const SUBAGENT_OF: Record<AgentType, string> = {
  adjudicator: 'factory-loop:adjudicator',
  designer: 'factory-loop:designer',
  implementer: 'callum-flow:implementer',
  fixer: 'callum-flow:fixer',
}

// One row of the agent list as the at-work check reads it.
export type ListedLoop = { id: string; status: AgentStatus; parentId?: string }

const AT_WORK: readonly AgentStatus[] = ['pending', 'running', 'waiting']

// stillAtWork: the agent list shows the agent holding background work (`waiting`), or a
// sub-agent it started still at work. Its own `running` proves nothing at its turn.complete: an
// agent that just ended is listed so until the engine marks it idle or completed.
export function stillAtWork(agents: readonly ListedLoop[], id: string): boolean {
  return agents.some(a => (a.id === id && a.status === 'waiting') || (a.parentId === id && AT_WORK.includes(a.status)))
}
