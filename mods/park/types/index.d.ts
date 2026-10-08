export type ParkBlock = { stopped: string; next: string; loop: string; at: string }

declare module 'claude-code' {
  interface PluginState {
    park: { block: ParkBlock | null; isSeen: boolean }
  }
}
