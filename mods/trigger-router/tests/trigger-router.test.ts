import { expect, test } from 'claude-code/testing'

test('a T2 phrasing gets a routing hint and is logged', async ($, on) => {
  const saved = new Map<string, unknown>()
  on('clock.now', () => ({ value: 1760000000000 }))
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  let ctx: readonly string[] | undefined
  on('prompt.submit', ($, e) => {
    ctx = e.context
    return { text: e.text }
  })

  await $.prompt.submit({ text: "honestly not sure which encoder preset, you decide", wait: false, origin: { kind: 'composer' } })
  expect(ctx?.[0]).toMatch(/^trigger T2 YOU-CALL-IT fired/)

  ctx = undefined
  await $.prompt.submit({ text: 'list the files here', wait: false, origin: { kind: 'composer' } })
  expect(ctx).toBeUndefined()

  const out = await $.command.run({ command: 'triggers', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(out.text).toContain('T2 YOU-CALL-IT: 1')
})
