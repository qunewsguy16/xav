import type { EngineInterface, Register } from 'claude-code'

type Job = { argv: string[]; startedAt: number; lines: string[]; code: number | null | 'running'; endedAt: number | null }

const KEEP = 60

export function splitArgs(s: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3] ?? '')
  return out
}

let job: Job | null = null

async function run($: EngineInterface, argv: string[]): Promise<void> {
  const startedAt = await $.clock.now()
  job = { argv, startedAt, lines: [], code: 'running', endedAt: null }
  const label = argv.join(' ').slice(0, 40)
  $.ui.status('bg: running ' + label)
  let code: number | null = null
  try {
    const stream = $.process.spawn({ argv })
    let tail = ''
    for await (const chunk of stream) {
      tail += chunk.text
      const parts = tail.split('\n')
      tail = parts.pop() ?? ''
      if (job) job.lines = [...job.lines, ...parts].slice(-KEEP)
    }
    if (tail && job) job.lines = [...job.lines, tail].slice(-KEEP)
    code = (await stream.result).code
  } catch (err) {
    if (job) job.lines = [...job.lines, 'bg-run: ' + String(err)].slice(-KEEP)
    code = -1
  }
  const endedAt = await $.clock.now()
  if (job) {
    job.code = code
    job.endedAt = endedAt
  }
  const seconds = Math.round((endedAt - startedAt) / 1000)
  $.ui.status(undefined)
  $.ui.toast(`bg: ${label} exited ${code} after ${seconds}s (/bg-log)`, { timeoutMs: 10000 })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'bg', description: 'Run a command in the background (no Claude turn)', argumentHint: '<command and args>', immediate: true })
      await $.command.register({ name: 'bg-log', description: 'Show the last output lines of the /bg job', immediate: true })
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'bg' }, async ($, e) => {
    const argv = splitArgs(e.args.trim())
    if (argv.length === 0) return { text: 'Usage: /bg <command> [args]   e.g. /bg cargo build --release' }
    if (job && job.code === 'running') return { text: 'bg: a job is already running: ' + job.argv.join(' ') }
    $.clock.after(0, () => run($, argv))
    return { text: 'bg: started ' + argv.join(' ') }
  })

  on('command.run', { command: 'bg-log' }, async () => {
    if (!job) return { text: 'bg: no job yet. /bg <command> starts one.' }
    const head = `bg: ${job.argv.join(' ')} — ${job.code === 'running' ? 'running' : 'exited ' + job.code}`
    return { text: head + (job.lines.length ? '\n' + job.lines.join('\n') : '\n(no output)') }
  })
}
