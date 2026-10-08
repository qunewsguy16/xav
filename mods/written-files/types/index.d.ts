declare module 'claude-code' {
  interface PluginState {
    'written-files': { files: Record<string, number> }
  }
}
