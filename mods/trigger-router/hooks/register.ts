import type { Register } from 'claude-code'

type Trigger = { id: string; name: string; re: RegExp; hint: string }

// From STATE-claude-playbook, TRIGGERS section (ratified 2026-07-19).
const TRIGGERS: Trigger[] = [
  { id: 'T1', name: 'PLAN-IT', re: /\bhow (can|do|would|should) i\b|\bhow would (i|we) approach\b/i,
    hint: 'a plan of concrete steps; numbered when ordered, bullets when not' },
  { id: 'T2', name: 'YOU-CALL-IT', re: /\b(not sure what'?s best|honestly not sure|you decide|i'?m open to ideas|what would you do)\b/i,
    hint: 'pick one, recommend with reasoning and name the tradeoff; do not return another fork' },
  { id: 'T3', name: 'BUILD-CHECK', re: /\b(should i build|i could just (make|build|write) a tool|what if i built)\b/i,
    hint: 'run the decision-register #13 build gate before any architecture' },
  { id: 'T4', name: 'WORTH-IT', re: /\b(is it worth \$?\d|should i (spend|buy)|talk me (into|out of))\b/i,
    hint: 'run the decision-register #8 spend gate' },
  { id: 'T5', name: 'WHERE-WERE-WE', re: /\b(pick this back up|where'?d we leave off|where were we|remind me (on|about|where))\b/i,
    hint: 'open with the parked next action (check /park and state), not a recap' },
  { id: 'T6', name: 'PARK-IT', re: /\b(gotta run|let'?s stop here|save my place|stopping for (now|tonight)|park (it|this))\b/i,
    hint: 'downhill-park: where we stopped, the exact next physical step, one open loop; offer /park stopped | next | loop' },
  { id: 'T7', name: 'CIRCLING', re: /\b(i keep going back and forth|going in circles|keep circling)\b/i,
    hint: 'name the loop plainly in behavioral terms, hand one default or a 2-minute starter; once' },
  { id: 'T8', name: 'TUNE-YOURSELF', re: /\b(reverse[- ]engineer|optimize your|make a shortcut for|find the pattern)\b/i,
    hint: 'build it, propose it for adjustment, persist on ratification' },
  { id: 'T9', name: 'SAVE-THIS', re: /\b(remember this|save this|where should this live)\b/i,
    hint: 'route storage (memory / Drive _STATE / Obsidian) and announce what saved where' },
  { id: 'T10', name: 'MAKE-A-SPOT', re: /\b(write a (promo|tease|vo)|this promo'?s not landing|cut a (promo|spot))\b/i,
    hint: 'promo stack: ewn-promo-workflow -> emotional-promo-marketing -> broadcast-copywriting' },
]

type Firing = { id: string; at: string; snippet: string }
const LOG = 'trigger-router:log'

function fire(text: string): Trigger[] {
  return TRIGGERS.filter(t => t.re.test(text)).slice(0, 2)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'triggers',
        description: 'Show playbook trigger firings (T1-T10) logged by trigger-router',
        argumentHint: '[clear]',
      })
    } catch {}
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer') return next(e)
    const hits = fire(e.text)
    if (hits.length === 0) return next(e)
    const at = new Date(await $.clock.now()).toISOString().slice(0, 16)
    const prior = (await $.store.get(LOG)) as Firing[] | undefined
    const log = [...(prior ?? []), ...hits.map(t => ({ id: t.id, at, snippet: e.text.slice(0, 60) }))].slice(-200)
    await $.store.set(LOG, log)
    const hint = hits.map(t => `trigger ${t.id} ${t.name} fired: ${t.hint}.`).join(' ')
    return next({ ...e, context: [...(e.context ?? []), hint] })
  })

  on('command.run', { command: 'triggers' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await $.store.delete(LOG)
      return { text: 'Trigger log cleared.' }
    }
    const log = ((await $.store.get(LOG)) as Firing[] | undefined) ?? []
    if (log.length === 0) return { text: 'No trigger firings logged yet.' }
    const counts = new Map<string, number>()
    for (const f of log) counts.set(f.id, (counts.get(f.id) ?? 0) + 1)
    const table = TRIGGERS.filter(t => counts.has(t.id))
      .map(t => `${t.id} ${t.name}: ${counts.get(t.id)}`)
      .join('\n')
    const recent = log.slice(-5).map(f => `${f.at} ${f.id} "${f.snippet}"`).join('\n')
    return { text: `Firings (${log.length}):\n${table}\n\nLast 5:\n${recent}` }
  })
}
