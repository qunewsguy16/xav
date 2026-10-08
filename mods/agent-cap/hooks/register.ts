import type { Register } from 'claude-code'

const KEY = 'agent-cap:limit'
const DEFAULT = 6

export const register: Register = on => {
  let limit: number | null = DEFAULT
  let started = 0
  let hasToasted = false

  on('session.start', async ($, e, next) => {
    const saved = await $.store.get(KEY)
    if (saved === null || typeof saved === 'number') limit = saved
    try {
      await $.command.register({ name: 'agent-cap', description: 'Max subagents per turn (agent-cap)', argumentHint: '[n | off | status]' })
    } catch {}
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    started = 0
    hasToasted = false
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    started += 1
    if (limit !== null && started > limit) {
      if (!hasToasted) {
        hasToasted = true
        $.ui.toast(`agent-cap: refused subagent #${started} (cap ${limit}). /agent-cap <n> raises it.`)
      }
      return {
        deny: `agent-cap: this turn already started ${limit} subagents, the cap. Finish with what you have, or ask the user to raise it with /agent-cap <n>.`,
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'agent-cap' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off') {
      limit = null
      await $.store.set(KEY, null)
    } else if (/^\d+$/.test(arg)) {
      limit = Number(arg)
      await $.store.set(KEY, limit)
    }
    return { text: limit === null ? 'agent-cap: off (no limit)' : `agent-cap: ${limit} subagents per turn (${started} started this turn)` }
  })
}
