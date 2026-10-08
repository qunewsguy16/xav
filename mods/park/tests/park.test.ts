import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'park',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 100, rows: 30 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('/park saves a block and the first prompt gets it as context', async ($, on) => {
  const saved = new Map<string, unknown>()
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: '/work' }))
  on('clock.now', () => ({ value: 1760000000000 }))
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  let entered: readonly string[] | undefined
  on('prompt.submit', ($, e) => {
    entered = e.context
    return { text: e.text }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out = await $.command.run({ command: 'park', args: 'clones done | open build.sh and read clone_phase | vship gate', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(out.text).toContain('next:    open build.sh and read clone_phase')
  expect((saved.get('park:/work') as { next: string }).next).toBe('open build.sh and read clone_phase')

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /open build.sh/ })).toBeDefined()
  await ui.unmount()

  await $.prompt.submit({ text: 'what now', wait: false, origin: { kind: 'composer' } })
  expect(entered?.[0]).toMatch(/Re-entry first/)
  await $.prompt.submit({ text: 'again', wait: false, origin: { kind: 'composer' } })
  expect(entered).toBeUndefined()
})

test('/unpark clears it', async ($, on) => {
  on('session.cwd', () => ({ value: '/work' }))
  on('store.delete', () => ({ value: undefined }))
  const out = await $.command.run({ command: 'unpark', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(out.text).toBe('Park block cleared for /work')
})
