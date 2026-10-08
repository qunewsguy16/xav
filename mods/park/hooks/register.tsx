import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ParkBlock } from '../types'

const block = atom({ plugin: 'park', key: 'block' } as const, null)
const isSeen = atom({ plugin: 'park', key: 'isSeen' } as const, false)

function keyFor(cwd: string): string {
  return 'park:' + cwd
}

function parse(args: string): ParkBlock | null {
  const parts = args.split('|').map(s => s.trim())
  if (parts.length === 1) {
    const [next] = parts
    return next ? { stopped: '', next, loop: '', at: '' } : null
  }
  const [stopped = '', next = '', loop = ''] = parts
  return next ? { stopped, next, loop, at: '' } : null
}

function render(b: ParkBlock): string {
  const lines = ['Parked ' + b.at + ':']
  if (b.stopped) lines.push('  stopped: ' + b.stopped)
  lines.push('  next:    ' + b.next)
  if (b.loop) lines.push('  loop:    ' + b.loop)
  return lines.join('\n')
}

async function load($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  const saved = await $.store.get(keyFor(cwd))
  const b = saved && typeof saved === 'object' && 'next' in saved ? (saved as ParkBlock) : null
  await update($, block, () => b)
  await update($, isSeen, () => false)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await load($)
    try {
      await $.command.register({
        name: 'park',
        description: 'Save (or show) the park block for this project: stopped | next | loop',
        argumentHint: '[stopped | next physical action | open loop]',
      })
      await $.command.register({ name: 'unpark', description: 'Clear the park block for this project' })
    } catch {}
    return next(e)
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await load($)
    return next(e)
  })

  on('command.run', { command: 'park' }, async ($, e) => {
    const cwd = await $.session.cwd()
    const args = e.args.trim()
    if (!args) {
      const b = await read($, block)
      return { text: b ? render(b) : 'Nothing parked for ' + cwd + '. Use: /park stopped | next | loop' }
    }
    const parsed = parse(args)
    if (!parsed) return { text: 'Could not parse. Use: /park stopped | next physical action | open loop' }
    const b: ParkBlock = { ...parsed, at: new Date(await $.clock.now()).toISOString().slice(0, 16).replace('T', ' ') }
    await $.store.set(keyFor(cwd), b)
    await update($, block, () => b)
    await update($, isSeen, () => false)
    return { text: render(b) }
  })

  on('command.run', { command: 'unpark' }, async $ => {
    const cwd = await $.session.cwd()
    await $.store.delete(keyFor(cwd))
    await update($, block, () => null)
    return { text: 'Park block cleared for ' + cwd }
  })

  on('prompt.submit', async ($, e, next) => {
    const b = await read($, block)
    const seen = await read($, isSeen)
    if (!b || seen || e.origin.kind !== 'composer') return next(e)
    await update($, isSeen, () => true)
    const hint =
      'park: this project has a parked next action from ' + b.at + '. Re-entry first: open with it, not a recap. ' +
      'next: ' + b.next + (b.loop ? ' · open loop: ' + b.loop : '') + (b.stopped ? ' · stopped at: ' + b.stopped : '')
    return next({ ...e, context: [...(e.context ?? []), hint] })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, block)
    const seen = await read($, isSeen)
    if (e.props.hasSurvey || !b || seen) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text color="cyan" bold>
            ↩ next:
          </Text>
          <Text wrap="truncate-end">{b.next}</Text>
          <Button key="seen" label="ok" plain hotkey="k" onPress={() => update($, isSeen, () => true)} />
        </Box>
        {below}
      </Box>
    )
  })
}
