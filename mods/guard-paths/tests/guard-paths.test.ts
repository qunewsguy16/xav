import { expect, test } from 'claude-code/testing'

test('protected paths are refused, others pass', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  const a = await $.tool.call({ tool: 'Edit', file_path: '/root/.claude/skills/manifest.json', old_string: 'a', new_string: 'b' })
  expect(a.deny).toMatch(/sync-owned/)
  const b = await $.tool.call({ tool: 'Write', file_path: '/home/user/app/.env.local', content: 'K=1' })
  expect(b.deny).toMatch(/secrets/)
  const c = await $.tool.call({ tool: 'Write', file_path: '/home/user/app/README.md', content: 'hi' })
  expect(c.deny).toBeUndefined()
  const d = await $.tool.call({ tool: 'Bash', command: 'sed -i "s/a/b/" ~/.claude/skills/manifest.json' })
  expect(d.deny).toMatch(/protected file/)
  const e2 = await $.tool.call({ tool: 'Bash', command: 'cat .env | wc -l' })
  expect(e2.deny).toBeUndefined()
})
