import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Figures, LastTurn } from '../types'

const figures = atom({ plugin: 'limits-band', key: 'figures' } as const, null)
const lastTurn = atom({ plugin: 'limits-band', key: 'lastTurn' } as const, null)
const isHidden = atom({ plugin: 'limits-band', key: 'isHidden' } as const, false)

const WARN_AT = [85, 95]

function limit(list: SessionRateLimit[], kind: string): number | null {
  const found = list.find(l => l.kind === kind)
  return found ? found.percentUsed : null
}

function toFigures(u: { context: { percent?: number }; rateLimits: SessionRateLimit[]; cost?: { usd: number } }): Figures {
  return {
    contextPct: u.context.percent ?? null,
    fiveHour: limit(u.rateLimits, 'five_hour'),
    sevenDay: limit(u.rateLimits, 'seven_day'),
    usd: u.cost ? u.cost.usd : null,
  }
}

function pct(n: number | null): string {
  return n === null ? '–' : Math.round(n) + '%'
}

function colorFor(n: number | null): string {
  if (n === null) return 'gray'
  return n >= 90 ? 'red' : n >= 70 ? 'yellow' : 'green'
}

async function refresh($: EngineInterface): Promise<void> {
  const u = await $.session.usage()
  await update($, figures, () => toFigures(u))
}

export const register: Register = on => {
  let startedAt = 0
  let tools = 0
  let agents = 0
  const warned = new Map<string, number>()

  on('session.start', async ($, e, next) => {
    try {
      await refresh($)
    } catch {}
    try {
      await $.command.register({ name: 'limits', description: 'Show or hide the limits band above the prompt' })
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'limits' }, async $ => {
    const hidden = await read($, isHidden)
    await update($, isHidden, () => !hidden)
    const f = await read($, figures)
    return { text: (hidden ? 'limits band shown' : 'limits band hidden') + (f ? ` · ctx ${pct(f.contextPct)} · 5h ${pct(f.fiveHour)} · 7d ${pct(f.sevenDay)}` : '') }
  })

  on('session.measure', async ($, e, next) => {
    const f = toFigures(e)
    await update($, figures, () => f)
    for (const [kind, value] of [['5h', f.fiveHour], ['7d', f.sevenDay], ['context', f.contextPct]] as const) {
      if (value === null) continue
      const level = WARN_AT.filter(w => value >= w).pop()
      if (level !== undefined && (warned.get(kind) ?? 0) < level) {
        warned.set(kind, level)
        $.ui.toast(`${kind} at ${Math.round(value)}%`, { timeoutMs: 8000 })
      }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    startedAt = await $.clock.now()
    tools = 0
    agents = 0
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!e.agentId) tools += 1
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    agents += 1
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      const seconds = Math.round(((await $.clock.now()) - startedAt) / 1000)
      const turn: LastTurn = { seconds, tools, agents }
      await update($, lastTurn, () => turn)
      try {
        await refresh($)
      } catch {}
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const f = await read($, figures)
    const t = await read($, lastTurn)
    const hidden = await read($, isHidden)
    if (e.props.hasSurvey || hidden || f === null) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const below = await next(e)
    const canCompact = (f.contextPct ?? 0) >= 70 && !e.props.isWorking
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Text dimColor>ctx</Text>
          <Text color={colorFor(f.contextPct)}>{pct(f.contextPct)}</Text>
          <Text dimColor>5h</Text>
          <Text color={colorFor(f.fiveHour)}>{pct(f.fiveHour)}</Text>
          <Text dimColor>7d</Text>
          <Text color={colorFor(f.sevenDay)}>{pct(f.sevenDay)}</Text>
          {f.usd !== null && <Text dimColor>${f.usd.toFixed(2)}</Text>}
          {t && (
            <Text dimColor>
              last {t.seconds}s · {t.tools} tools{t.agents > 0 ? ` · ${t.agents} agents` : ''}
            </Text>
          )}
          {canCompact && (
            <Button
              key="compact"
              label="Compact"
              hotkey="c"
              plain
              onPress={async () => {
                await $.session.compact()
              }}
            />
          )}
        </Box>
        {below}
      </Box>
    )
  })
}
