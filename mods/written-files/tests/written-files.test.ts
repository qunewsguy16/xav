import { expect, test } from 'claude-code/testing'

test('edits are listed and the turn line names them', async ($, on) => {
  const logs: string[] = []
  on('session.cwd', () => ({ value: '/work' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', ($, e) => (e.tool === 'Write' && e.file_path.endsWith('bad.rs') ? { deny: 'no' } : { result: 'ok' }))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/src/a.rs', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/src/a.rs', old_string: 'b', new_string: 'c' })
  await $.tool.call({ tool: 'Write', file_path: '/work/src/bad.rs', content: 'x' })
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' })
  expect(logs).toEqual(['changed src/a.rs'])

  const out = await $.command.run({ command: 'written', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(out.text).toBe('Written this session (1):\n- src/a.rs (2 edits)')
})
