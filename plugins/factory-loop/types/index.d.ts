// The loop's last pass, for /loop status and other plugins to read (SPEC 12). Written by the
// pass driver from phase 3 on.
export type PassSummary = {
  pass: number
  at: number
  mode: 'off' | 'observe' | 'act'
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
