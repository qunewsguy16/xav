import { expect, test } from 'claude-code/testing'

const spawn = (n: number) => ({
  tool_use_id: 'tu' + n, prompt: 'p', description: 'd', subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-test', background: false, fork: false,
} as const)

test('the 3rd spawn is refused with a cap of 2, and the cap resets per turn', async ($, on) => {
  const toasts: string[] = []
  on('store.get', () => ({ value: 2 }))
  on('store.set', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('agent.spawn', () => ({ model: 'claude-test', agentId: 'a1' }))
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect((await $.agent.spawn(spawn(1))).deny).toBeUndefined()
  expect((await $.agent.spawn(spawn(2))).deny).toBeUndefined()
  expect((await $.agent.spawn(spawn(3))).deny).toMatch(/already started 2 subagents/)
  expect(toasts.length).toBe(1)
  await $.turn.start({ text: 'again', turnId: 't2' })
  expect((await $.agent.spawn(spawn(4))).deny).toBeUndefined()
  const s = await $.command.run({ command: 'agent-cap', args: 'status', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(s.text).toBe('agent-cap: 2 subagents per turn (1 started this turn)')
})
