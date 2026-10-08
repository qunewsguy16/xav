import type { Register } from 'claude-code'

const PROTECTED: { re: RegExp; why: string }[] = [
  { re: /\.claude\/skills\/.*manifest\.json$/, why: 'skills manifest.json is sync-owned; never hand-edit it (playbook R1)' },
  { re: /(^|\/)\.env(\.[^/]*)?$/, why: '.env files hold secrets' },
  { re: /(^|\/)\.credentials\.json$/, why: 'credentials file' },
]

const BASH_WRITE = /\b(sed\s+-i|tee|>>?|rm|mv|cp|truncate|python[23]?\s+-c|echo)\b[^|;&]*?(manifest\.json|\.credentials\.json|(^|[\s/'"])\.env\b)/

export function protectedReason(path: string): string | undefined {
  return PROTECTED.find(p => p.re.test(path))?.why
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'guard-paths', description: 'List the paths guard-paths refuses to edit' })
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'guard-paths' }, async () => ({
    text: 'Protected:\n' + PROTECTED.map(p => `- ${p.re.source}  (${p.why})`).join('\n'),
  }))

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const why = protectedReason(e.file_path)
    return why ? { deny: `guard-paths: ${e.file_path} is protected: ${why}. Tell the user what you wanted to change instead.` } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'guard-paths: its guard failed, so the edit was refused.' }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    return BASH_WRITE.test(e.command)
      ? { deny: 'guard-paths: this command looks like it writes a protected file (manifest.json, .env, .credentials.json). Use a read-only command or tell the user.' }
      : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'guard-paths: its guard failed, so the command was refused.' }))
}
