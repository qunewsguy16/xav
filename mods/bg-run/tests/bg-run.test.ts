import { expect, mock, test } from 'claude-code/testing'
import { splitArgs } from '../hooks/register'

test('splitArgs keeps quoted words together', () => {
  expect(splitArgs('cargo build --release --features "vship cuda"')).toEqual(['cargo', 'build', '--release', '--features', 'vship cuda'])
})

test('/bg runs the job, keeps its tail, and toasts on exit', async ($, on) => {
  const clock = mock.clock(on)
  const status: (string | undefined)[] = []
  const toasts: string[] = []
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('process.spawn', async function* ($, e) {
    expect(e.argv).toEqual(['cargo', 'build'])
    yield { stream: 'stdout', text: 'Compiling a\nCompiling b\n' }
    yield { stream: 'stderr', text: 'warning: x' }
    return { value: { code: 0, signal: null } }
  })

  const started = await $.command.run({ command: 'bg', args: 'cargo build', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(started.text).toBe('bg: started cargo build')
  await clock.settle()
  expect(toasts[0]).toMatch(/^bg: cargo build exited 0 after 0s/)
  expect(status).toEqual(['bg: running cargo build', undefined])
  const log = await $.command.run({ command: 'bg-log', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(log.text).toBe('bg: cargo build — exited 0\nCompiling a\nCompiling b\nwarning: x')
})
