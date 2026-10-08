import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const files = atom({ plugin: 'written-files', key: 'files' } as const, {})

function short(path: string, cwd: string): string {
  return path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path
}

export const register: Register = on => {
  let thisTurn = new Set<string>()

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'written', description: 'List the files Claude edited or wrote this session', argumentHint: '[clear]' })
    } catch {}
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    thisTurn = new Set()
    return next(e)
  })

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      thisTurn.add(e.file_path)
      await update($, files, map => ({ ...map, [e.file_path]: (map[e.file_path] ?? 0) + 1 }))
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && thisTurn.size > 0) {
      const cwd = await $.session.cwd()
      $.ui.log('changed ' + [...thisTurn].map(p => short(p, cwd)).join(', '))
    }
    return next(e)
  })

  on('command.run', { command: 'written' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, files, () => ({}))
      return { text: 'Cleared.' }
    }
    const map = await read($, files)
    const cwd = await $.session.cwd()
    const rows = Object.entries(map)
    if (rows.length === 0) return { text: 'No files written this session.' }
    return { text: `Written this session (${rows.length}):\n` + rows.map(([p, n]) => `- ${short(p, cwd)} (${n} edit${n === 1 ? '' : 's'})`).join('\n') }
  })
}
