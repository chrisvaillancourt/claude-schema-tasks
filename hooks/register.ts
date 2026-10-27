import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  INITIAL,
  TEACH,

  TOOL_NAME,
  USAGE,
  childPrompt,
  configFrom,
  deliveryNote,
  isActive,
  newContract,
  parseArgs,
  parseEnvelope,
  resultFor,
  showText,
  statusText,
  transition,
} from './policy'
import type { Action, AgentOutcome, ContractEvent, EnvelopeParse } from './policy'
import type { Config, Contract } from '../types'

const NAME = 'schema-tasks'

// Change a shape tag when its stored type changes: a value an older version
// stored (it outlives a hot reload) then reads as the initial value.
const sessionAtom = atom({ plugin: 'schema-tasks', key: 'session' } as const, INITIAL, { shape: 'session-2' })
const contractsAtom = atom({ plugin: 'schema-tasks', key: 'contracts' } as const, [] as Contract[], { shape: 'contracts-1' })

// Module variables reset on a hot reload; only the parsed options live here.
let config: Config = configFrom({})

/** Best effort: reporting must never throw out of a hook. */
function log($: EngineInterface, text: string) {
  try {
    $.ui.log(text) // the engine prefixes the plugin name
  } catch {
    // nothing to do
  }
}

/** Applies one event in one versioned update; the action is the one from the run that landed. */
async function step($: EngineInterface, ev: ContractEvent): Promise<Action> {
  let action: Action = { kind: 'pass' }
  await update($, contractsAtom, list => {
    const r = transition(list, ev)
    action = r.action
    return r.contracts
  })
  return action
}

async function isOn($: EngineInterface): Promise<boolean> {
  return isActive(config, await read($, sessionAtom))
}

function envelopeOf(prompt: unknown): EnvelopeParse {
  return typeof prompt === 'string' ? parseEnvelope(prompt, config) : { kind: 'none' }
}

function deniedEnvelope(env: Extract<EnvelopeParse, { kind: 'invalid' }>): string {
  const issues = env.issues.slice(0, 20).map(i => `- ${i.path === '' ? '(root)' : i.path}: ${i.message}`)
  return [
    `schema-tasks: this Agent call was not run: ${env.message}.`,
    ...(issues.length > 0 ? ['Problems:', ...issues] : []),
    'Fix the envelope and call Agent again, or send a plain prompt to run the task without a schema.',
  ].join('\n')
}

type AgentRecord = { status?: string; agentId?: string; content?: { type: string; text?: string }[]; handback?: 'send' | 'flagged' | 'withheld' }

function outcomeOf(r: { deny?: string; isError?: true; result?: unknown }): AgentOutcome {
  if (r.deny !== undefined || r.isError === true) return { kind: 'error' }
  const rec = (r.result ?? {}) as AgentRecord
  const agentId = typeof rec.agentId === 'string' ? rec.agentId : ''
  if (rec.status === 'async_launched' && agentId !== '') return { kind: 'launched', agentId }
  if (rec.status === 'completed' && agentId !== '') {
    const text = (rec.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('')
    return { kind: 'completed', agentId, text, ...(rec.handback !== undefined ? { handback: rec.handback } : {}) }
  }
  return { kind: 'error' }
}

export const register: Register = (on, options) => {
  config = configFrom(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: NAME,
      description: 'Show schema-tasks contracts, one contract\'s problems, or turn the mod on or off for this session',
      argumentHint: '[on|off|status|show <id>]',
    })
    await $.tool.register({
      name: TOOL_NAME,
      description:
        'Result of a schema-tasks structured delegation that ran in the background: pass the subagent\'s agent id as agent_id. ' +
        'Answers {status: "pending"}, {status: "ok", data} with the validated JSON, or {status: "failed" | "cancelled", code, message, issues}.',
      inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: ['agent_id'], additionalProperties: false },
    })
    return next(e)
  })

  on('command.run', { command: NAME }, async ($, e) => {
    const cmd = parseArgs(e.args)
    if (cmd.kind === 'help') return { text: cmd.error ? `${cmd.error}\n${USAGE}` : USAGE }
    if (cmd.kind === 'set') await update($, sessionAtom, s => ({ ...s, mode: cmd.mode }))
    const list = await read($, contractsAtom)
    if (cmd.kind === 'show') return { text: showText(list, cmd.id) }
    return { text: statusText(config, await read($, sessionAtom), list) }
  })

  // Teach the envelope: fixed text, added once per session where enabled.
  on('tool.describe', { tool: 'Agent' }, async ($, e, next) => {
    const r = await next(e)
    return config.enabled ? { ...r, description: r.description + TEACH } : r
  })

  // The parent's Agent call: open the contract, run the native call, check its result.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const env = envelopeOf(e.prompt)
    if (env.kind === 'none') return next(e)
    if (!(await isOn($))) return { deny: 'schema-tasks is off for this session (/schema-tasks on); this structured Agent call was not run.' }
    if (env.kind === 'invalid') return { deny: deniedEnvelope(env) }
    if (e.isolation === 'remote') return { deny: 'schema-tasks: structured delegation does not support isolation "remote"; this Agent call was not run.' }
    if (e.subagent_type === 'fork') return { deny: 'schema-tasks: structured delegation does not support forks; this Agent call was not run.' }

    const contract = newContract(
      { id: e.tool_use_id, parentAgentId: e.agentId ?? null, description: e.description, task: env.task, schema: env.schema, background: false },
      config,
    )
    const opened = await step($, { kind: 'open', contract })
    if (opened.kind === 'deny') return { deny: opened.text }

    const r = await next(e)
    const act = await step($, { kind: 'agentResult', id: e.tool_use_id, outcome: outcomeOf(r) })
    if (act.kind === 'deny') return { deny: act.text }
    if (act.kind === 'context' && r.deny === undefined) return { ...r, context: [...(r.context ?? []), act.text] }
    return r
  }).catch(($, e, next) => {
    // Fail closed for envelopes, before and after the native call: an
    // unchecked result is never replayed as a structured one.
    let env: EnvelopeParse
    try {
      env = envelopeOf(e.prompt)
    } catch {
      env = { kind: 'invalid', message: 'unreadable', issues: [] }
    }
    if (env.kind === 'none') return next(e)
    return { deny: 'schema-tasks: checking this structured Agent call failed, so its result is not validated and must not be used.' }
  })

  // The child's spawn: rewrite its prompt and bind its agent id.
  on('agent.spawn', async ($, e, next) => {
    if (e.workflow !== undefined || e.resume !== undefined) return next(e)
    const parent = e.parentAgentId ?? null
    const list = await read($, contractsAtom)
    const c = list.find(x => x.id === e.tool_use_id && x.phase === 'starting' && x.parentAgentId === parent)
    if (!c) return next(e)
    if (e.isTeammate === true || e.fork) {
      const reason = e.isTeammate === true ? 'a teammate' : 'a fork'
      await step($, { kind: 'spawnRefused', id: c.id, reason: `structured delegation does not support ${reason}` })
      return { deny: `schema-tasks: structured delegation does not support ${reason}.` }
    }
    const r = await next({ ...e, prompt: childPrompt(c) })
    if (r.deny !== undefined) await step($, { kind: 'spawnRefused', id: c.id, reason: r.deny })
    else if (typeof r.agentId === 'string') await step($, { kind: 'spawned', id: c.id, agentId: r.agentId })
    return r
  }).catch(async ($, e, next) => {
    if (next.called) return next(e)
    const list = await read($, contractsAtom)
    const mine = list.some(x => x.id === e.tool_use_id && x.phase === 'starting')
    return mine ? { deny: 'schema-tasks: preparing the structured subagent failed.' } : next(e)
  })

  // Repair gate 1: a child that reports through the hand-back tool.
  on('tool.call', async ($, e, next) => {
    if (String(e.tool) !== 'SubagentHandback' || e.agentId === undefined) return next(e)
    const message = (e as { message?: unknown }).message
    if (typeof message !== 'string') return next(e)
    const act = await step($, { kind: 'reply', agentId: e.agentId, gate: 'handback', text: message, enabled: await isOn($) })
    if (act.kind === 'repair') {
      log($, `refused a hand-back from ${e.agentId}`)
      return { deny: act.feedback }
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // fail open: the final check still judges the answer

  // Repair gate 2: the child's stop, where this event reaches the mod.
  on('classic.SubagentStop', async ($, e, next) => {
    const act = await step($, { kind: 'reply', agentId: e.agent_id, gate: 'stop', text: e.last_assistant_message ?? '', enabled: await isOn($) })
    if (act.kind === 'repair') {
      log($, `blocked the stop of ${e.agent_id}`)
      return { block: act.feedback }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The independent final check of the delivered answer.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      try {
        await step($, { kind: 'complete', agentId: e.agentId, reason: e.reason, answer: e.answer, enabled: await isOn($) })
      } catch {
        log($, `could not record the end of ${e.agentId}`)
      }
    }
    return next(e)
  })

  // A background child's report and completion notice reach its parent as
  // rows of their own; each gets the contract's status, so the raw report
  // never stands alone as a result.
  on('session.append', async ($, e, next) => {
    if (e.door === 'queue') return next(e)
    const m = e.message
    if (m.type !== 'user' && m.type !== 'attachment') return next(e)
    const last = m.content.findLastIndex(b => b.type === 'text')
    const block = m.content[last]
    const text = block?.type === 'text' ? (block as { text?: unknown }).text : undefined
    if (typeof text !== 'string') return next(e)
    if (!text.includes('<task-notification>') && !text.includes('<agent-message from=')) return next(e)
    const note = deliveryNote(await read($, contractsAtom), text, e.agentId ?? null)
    if (note === null) return next(e)
    const content = m.content.map((b, i) => (i === last ? { ...b, text: `${text}\n\n${note}` } : b))
    return next({ ...e, message: { ...m, content } })
  }).catch(($, e, next) => next(e)) // fail open: schema_result stays authoritative

  on('tool.call', { tool: 'mcp__schema-tasks__schema_result' }, async ($, e) => {
    const agentId = (e as { agent_id?: unknown }).agent_id
    if (typeof agentId !== 'string') return { deny: 'schema_result needs agent_id, the subagent\'s agent id.' }
    const answer = resultFor(await read($, contractsAtom), agentId, e.agentId ?? null)
    if (answer === null) return { deny: `No schema-tasks contract for agent ${agentId} is on record in this session: either it was not started here, or its record was lost (a /clear, the contract limit, or Claude Code restarting the session in a new process). Its report is unvalidated and must not be used as a schema-checked result.` }
    return { result: JSON.stringify(answer) }
  }).catch(() => ({ deny: 'schema_result failed; no result is available.' }))
}
