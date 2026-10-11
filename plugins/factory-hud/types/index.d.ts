// The alerts the HUD can raise, by key: context at 85%, a usage window at 90%.
export type AlertKey = string

declare module 'claude-code' {
  interface PluginState {
    // isHidden: the HUD is hidden in this conversation (/hud). alerted: the toasts already shown.
    'factory-hud': { isHidden: boolean; alerted: AlertKey[] }
  }
}
