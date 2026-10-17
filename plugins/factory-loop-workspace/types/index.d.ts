// What the companion keeps for the session: each agent the factory loop started in a slot, and
// each child such an agent started, by agent id, so the guard and the stop gate find them after a
// reload of the module.
export type WorkspaceAgent = {
  // the id of the agent the loop started: this agent's own, or its parent's for a child
  root: string
  // the slot as the spawn named it, and its real path (symlinks resolved)
  slot: string
  real: string
  // the repository's roots: the slot and, when the slot is a worktree of one, the main checkout
  roots: string[]
  // the slot's own git dir, which holds the step marker and the gate's result
  gitDir: string
  // from the step marker (factory-step.json)
  repo: string
  issue: number
  life: string
  seq: number
  step: string
  role: 'writer' | 'reader'
  branch: string
  gateCommands: string[]
  gateTimeoutMs: number
  loopDir: string
  // from the step marker: the step attempt's scratch folder, exported as TMPDIR into the agent's
  // Bash calls; absent for an older marker
  scratch?: string
  // from the step marker; an older marker has none
  pr?: number | null
  // the spawn's subagentType, per agent (a child has its own)
  agentType?: string
  // the step attempt, from the agent's name (`a<k>`)
  attempt?: number
  // this agent's own transcript, learned from classic.SubagentStart
  transcript?: string
}

declare module 'claude-code' {
  interface PluginState {
    'factory-loop-workspace': { agents: StateFamily<WorkspaceAgent> }
  }
}
