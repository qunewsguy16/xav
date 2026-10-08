import { expect, test } from 'claude-code/testing'

test('a correction is logged with the prior answer, a plain prompt is not', async ($, on) => {
  const saved = new Map<string, unknown>()
  const logs: string[] = []
  on('clock.now', () => ({ value: 1760000000000 }))
  on('session.cwd', () => ({ value: '/home/user/xav' }))
  on('session.messages', () => ({ value: [
    { role: 'user', text: 'fix the build', toolUses: [] },
    { role: 'assistant', text: 'I changed build.sh to use clang.\nDone.', toolUses: [] },
  ] }))
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => { saved.set(e.key, e.value); return { value: undefined } })
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('prompt.submit', ($, e) => ({ text: e.text }))

  await $.prompt.submit({ text: 'No, I meant the Vship build, not FFmpeg', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'now run the tests', wait: false, origin: { kind: 'composer' } })
  expect(logs).toEqual(['correction logged (#1)'])

  const out = await $.command.run({ command: 'corrections', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(out.text).toContain('xav · said: "No, I meant the Vship build, not FFmpeg" · answered: "I changed build.sh to use clang."')
})
