export type Figures = { contextPct: number | null; fiveHour: number | null; sevenDay: number | null; usd: number | null }
export type LastTurn = { seconds: number; tools: number; agents: number }

declare module 'claude-code' {
  interface PluginState {
    'limits-band': { figures: Figures | null; lastTurn: LastTurn | null; isHidden: boolean }
  }
}
