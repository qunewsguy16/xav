import type { Register } from 'claude-code'

type Rule = { re: RegExp; lint: string; fix: string }

// Patterns that match lints Cargo.toml sets to "deny" (xav's [lints.clippy]).
const RULES: Rule[] = [
  { re: /\.unwrap\(\)/, lint: 'clippy::unwrap_used', fix: 'use ?, match, or let-else' },
  { re: /\.expect\(/, lint: 'clippy::expect_used', fix: 'use ? with a typed error' },
  { re: /\bpanic!\(/, lint: 'clippy::panic', fix: 'return an Err' },
  { re: /\bunreachable!\(/, lint: 'clippy::unreachable', fix: 'return an Err or restructure the match' },
  { re: /\bdbg!\(/, lint: 'clippy::dbg_macro', fix: 'remove it' },
  { re: /\beprint(ln)?!\(/, lint: 'clippy::print_stderr', fix: 'route through the crate\'s own logging' },
  { re: /"(?:[^"\\]|\\.)*"\.to_string\(\)/, lint: 'clippy::str_to_string', fix: 'use .to_owned() or String::from' },
  { re: /\bas _\b/, lint: 'clippy::as_underscore', fix: 'name the target type' },
  { re: /\bmem::forget\(/, lint: 'clippy::mem_forget', fix: 'use ManuallyDrop' },
]

export function findViolations(text: string): string[] {
  const out: string[] = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const code = line.split('//')[0] ?? ''
    for (const r of RULES) {
      if (r.re.test(code)) out.push(`line ${i + 1}: ${r.lint} (${r.fix}): ${line.trim().slice(0, 80)}`)
    }
  })
  return out
}

let isActive = false
let isForced: boolean | null = null

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isActive = false
    try {
      const cwd = await $.session.cwd()
      const path = cwd + '/Cargo.toml'
      if (await $.fs.exists(path)) {
        const toml = await $.fs.read(path)
        isActive = /unwrap_used\s*=\s*"deny"/.test(toml)
      }
    } catch {}
    try {
      await $.command.register({
        name: 'deny-guard',
        description: 'rust-deny-guard: status, on, or off for this session',
        argumentHint: '[on|off|status]',
      })
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'deny-guard' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'on') isForced = true
    else if (arg === 'off') isForced = false
    else if (arg === 'auto') isForced = null
    const isOn = isForced ?? isActive
    return { text: `rust-deny-guard is ${isOn ? 'ON' : 'OFF'} (${isForced === null ? 'auto: Cargo.toml ' + (isActive ? 'denies' : 'does not deny') + ' unwrap_used' : 'forced'})` }
  })

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    if (!(isForced ?? isActive) || !e.file_path.endsWith('.rs')) return next(e)
    const text = e.tool === 'Edit' ? e.new_string : e.content
    const found = findViolations(text)
    if (found.length === 0) return next(e)
    return {
      deny:
        `rust-deny-guard: ${e.file_path} would fail this crate's deny-level lints (warnings = "deny", so the build fails):\n` +
        found.slice(0, 8).join('\n') +
        (found.length > 8 ? `\n...and ${found.length - 8} more` : '') +
        '\nRewrite without them and retry. If a line is genuinely needed, the user can run /deny-guard off.',
    }
  }).catch(($, e, next) => next(e))
}
