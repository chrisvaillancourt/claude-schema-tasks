import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { INITIAL, USAGE, configFrom, isActive, parseArgs, statusText } from './policy'
import type { Config } from '../types'

const NAME = 'schema-tasks'

// Change the shape tag when Session's fields change: a value an older version
// stored (it outlives a hot reload) then reads as INITIAL instead of breaking.
const sessionAtom = atom({ plugin: 'schema-tasks', key: 'session' } as const, INITIAL, { shape: 'session-1' })

// Module variables reset on a hot reload; register and session.start run
// again then. Anything that must persist goes in $.state or $.store.
let config: Config = configFrom({})

/** Best effort: reporting must never throw out of a hook or a timer. */
function log($: EngineInterface, text: string) {
  try {
    $.ui.log(`${NAME}: ${text}`)
  } catch {
    // nothing to do
  }
}

export const register: Register = (on, options) => {
  config = configFrom(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: NAME,
      description: 'Show or set whether schema-tasks is on for this session',
      argumentHint: '[on|off|status]',
    })
    return next(e)
  })

  on('command.run', { command: NAME }, async ($, e) => {
    const cmd = parseArgs(e.args)
    if (cmd.kind === 'help') return { text: cmd.error ? `${cmd.error}\n${USAGE}` : USAGE }
    if (cmd.kind === 'set') await update($, sessionAtom, s => ({ ...s, mode: cmd.mode }))
    return { text: statusText(config, await read($, sessionAtom)) }
  })

  on('turn.start', async ($, e, next) => {
    // Subagent loops carry agentId; this mod acts on the main conversation only.
    if (e.agentId !== undefined) return next(e)
    const session = await read($, sessionAtom)
    if (isActive(config, session)) {
      await update($, sessionAtom, s => ({ ...s, turns: s.turns + 1 }))
      log($, `main turn ${e.turnId} started`)
    }
    return next(e)
  })
}
