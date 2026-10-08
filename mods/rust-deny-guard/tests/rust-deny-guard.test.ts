import { expect, test } from 'claude-code/testing'
import { findViolations } from '../hooks/register'

test('findViolations names the lint and skips comments', () => {
  const v = findViolations('let x = y.unwrap();\n// ok.unwrap() in a comment\nlet s = "a".to_string();\nlet n = m as _;')
  expect(v.length).toBe(3)
  expect(v[0]).toMatch(/line 1: clippy::unwrap_used/)
  expect(v[1]).toMatch(/line 3: clippy::str_to_string/)
  expect(v[2]).toMatch(/line 4: clippy::as_underscore/)
})

test('an Edit with .unwrap() is refused in a crate that denies it; a clean one passes', async ($, on) => {
  on('session.start', () => ({ cwd: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: '[lints.clippy]\nunwrap_used = "deny"\n' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const refused = await $.tool.call({ tool: 'Edit', file_path: '/work/src/a.rs', old_string: 'x', new_string: 'let v = r.unwrap();' })
  expect(refused.deny).toMatch(/clippy::unwrap_used/)

  const ok = await $.tool.call({ tool: 'Write', file_path: '/work/src/b.rs', content: 'let v = r?;' })
  expect(ok.deny).toBeUndefined()

  const other = await $.tool.call({ tool: 'Write', file_path: '/work/notes.md', content: 'x.unwrap()' })
  expect(other.deny).toBeUndefined()
})

test('nothing is refused when Cargo.toml does not deny unwrap_used', async ($, on) => {
  on('session.start', () => ({ cwd: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: '[package]\nname = "x"\n' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await $.tool.call({ tool: 'Edit', file_path: '/work/src/a.rs', old_string: 'x', new_string: 'let v = r.unwrap();' })
  expect(r.deny).toBeUndefined()
})
