import type { EngineInterface, Register } from 'claude-code'

const CORRECTION =
  /^(no[,.!\s]|nope\b|wrong\b|that'?s (not|wrong)|not what i (asked|meant|said)|i meant\b|actually[,\s]|stop[,.\s]|don'?t do that|undo that|revert that|why did you|you (ignored|skipped|missed)|not that\b|wrong (file|branch|repo))/i

type Entry = { at: string; cwd: string; said: string; answered: string }
const KEY = 'correction-log:entries'

async function lastAnswer($: EngineInterface): Promise<string> {
  const rows = await $.session.messages()
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]
    if (row && row.role === 'assistant' && row.text.trim()) return row.text.trim().split('\n')[0]?.slice(0, 120) ?? ''
  }
  return ''
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'corrections',
        description: 'Show logged corrections (paste into STATE-trigger-observations); /corrections clear wipes them',
        argumentHint: '[n | clear]',
      })
    } catch {}
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' || !CORRECTION.test(e.text.trim())) return next(e)
    const at = new Date(await $.clock.now()).toISOString().slice(0, 16).replace('T', ' ')
    const cwd = await $.session.cwd()
    const answered = await lastAnswer($)
    const entry: Entry = { at, cwd, said: e.text.trim().slice(0, 160), answered }
    const prior = ((await $.store.get(KEY)) as Entry[] | undefined) ?? []
    const entries = [...prior, entry].slice(-300)
    await $.store.set(KEY, entries)
    $.ui.log('correction logged (#' + entries.length + ')')
    return next(e)
  })

  on('command.run', { command: 'corrections' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') {
      await $.store.delete(KEY)
      return { text: 'Correction log cleared.' }
    }
    const n = Number(arg) || 20
    const entries = ((await $.store.get(KEY)) as Entry[] | undefined) ?? []
    if (entries.length === 0) return { text: 'No corrections logged.' }
    const lines = entries
      .slice(-n)
      .map(x => `- ${x.at} · ${x.cwd.split('/').pop()} · said: "${x.said}" · answered: "${x.answered}"`)
    return { text: `Corrections (${entries.length} total, last ${Math.min(n, entries.length)}):\n` + lines.join('\n') }
  })
}
