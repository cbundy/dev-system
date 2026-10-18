// The loop's last pass, for `/factory status` and other plugins to read (v2 SPEC 13.12). The pass
// driver writes it at the end of every pass that ran.
export type PassSummary = {
  pass: number
  at: number
  mode: 'off' | 'observe' | 'act'
  // the pass ran its actions: act mode with every rail passed (absent: written by an observe-only
  // build)
  executed?: boolean
  // why act mode did not act this pass (the rails, an unreadable ledger); empty when it did
  rails?: string[]
  tier: 'normal' | 'slow' | 'stop-new' | 'stop-all'
  title: string
  actions: number
  owner: number
}

declare module 'claude-code' {
  interface PluginState {
    'factory-loop': { lastPass: PassSummary | null }
  }
}
