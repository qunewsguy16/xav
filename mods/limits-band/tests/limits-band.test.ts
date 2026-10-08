import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'limits-band',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 120, rows: 30 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('the band shows the figures, warns at 85%, and offers Compact past 70% context', async ($, on) => {
  const toasts: string[] = []
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }))
  const clock = mock.clock(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 150000, percent: 75 }, rateLimits: [{ kind: 'five_hour', percentUsed: 86 }, { kind: 'seven_day', percentUsed: 12 }], cost: { usd: 1.5 } } }))

  await $.session.measure({ context: { window: 200000, tokens: 150000, percent: 75 }, rateLimits: [{ kind: 'five_hour', percentUsed: 86 }, { kind: 'seven_day', percentUsed: 12 }], cost: { usd: 1.5 }, changed: ['context', 'rateLimits', 'cost'] })
  expect(toasts).toEqual(['5h at 86%'])

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(5000)
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 5000, isAborted: false, reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '75%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '86%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /last 5s · 1 tools/ })).toBeDefined()
    expect(await ui.find({ key: 'compact' })).toBeDefined()
    await ui.unmount()
  }
})

test('/limits hides the band', async ($, on) => {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  const out = await $.command.run({ command: 'limits', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(out.text).toBe('limits band hidden')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ctx' })).toBeUndefined()
  await ui.unmount()
})
