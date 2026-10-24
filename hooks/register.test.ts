import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
const ENGINE = { plugin: 'engine', tier: 'core' } as const
const SCHEMA = { type: 'object', properties: { verdict: { enum: ['pass', 'fail'] } }, required: ['verdict'], additionalProperties: false }
const ENVELOPE = JSON.stringify({ claudeSchemaTasks: 1, schema: SCHEMA, task: 'Judge it.' })
const TOOL = 'mcp__schema-tasks__schema_result'

/** What one fake child does inside the Agent call. */
type Script = (T: any, agentId: string) => Promise<{ answer: string; reason?: 'answer' | 'aborted' } | null>

type World = {
  spawnPrompts: string[]
  handbacks: string[]
  agentCalls: number
  script: Script
  background: boolean
  pointer: boolean
}

/** The engine beneath the plugin. The Agent tool spawns a child and runs `script` as that child. */
function world(on: On, T: any, w: World) {
  let n = 0
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__schema-tasks__${e.name}` } }))
  on('tool.describe', ($, e) => ({ description: e.description }))
  on('agent.spawn', ($, e) => {
    w.spawnPrompts.push(e.prompt)
    n++
    return { model: 'claude-haiku-5-5', agentId: `a${n}` }
  })
  on('classic.SubagentStop', () => ({}))
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', async ($, e) => {
    if (String(e.tool) === 'SubagentHandback') {
      w.handbacks.push(String((e as any).message))
      return { result: { success: true } } as any
    }
    if (e.tool !== 'Agent') throw new Error(`unexpected tool ${String(e.tool)}`)
    w.agentCalls++
    const spawned = await T.agent.spawn({
      tool_use_id: e.tool_use_id, prompt: e.prompt, description: e.description, subagentType: e.subagent_type ?? 'general-purpose',
      provider: ENGINE, parentModel: 'claude-haiku-5-5', background: w.background, fork: false,
      ...(e.agentId !== undefined ? { parentAgentId: e.agentId } : {}),
    })
    if (spawned.deny !== undefined) return { result: { error: spawned.deny }, isError: true, text: spawned.deny } as any
    const agentId = spawned.agentId as string
    if (w.background) return { result: { status: 'async_launched', agentId, description: e.description, prompt: e.prompt, outputFile: '/x' } } as any
    const end = await w.script(T, agentId)
    if (end !== null) {
      await T.turn.complete({ agentId, turnId: `turn-${agentId}`, reason: end.reason ?? 'answer', answer: end.answer, durationMs: 1, isAborted: end.reason === 'aborted' })
    }
    const text = w.pointer ? 'This agent\'s report was delivered to you as a message.' : (end?.answer ?? '')
    return {
      result: { status: 'completed', agentId, content: [{ type: 'text', text }], totalToolUseCount: 0, totalDurationMs: 1, totalTokens: 1, prompt: e.prompt, usage: {} },
      text,
    } as any
  })
}

function fresh(script: Script, over: Partial<World> = {}): World {
  return { spawnPrompts: [], handbacks: [], agentCalls: 0, script, background: false, pointer: false, ...over }
}

const start = ($: any) => $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: false })
const agent = ($: any, prompt: string, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'Agent', description: 'judge', prompt, subagent_type: 'general-purpose', ...extra })
const handback = (T: any, agentId: string, message: string) => T.tool.call({ tool: 'SubagentHandback', message, agentId })
const stop = (T: any, agentId: string, last: string) =>
  T.classic.SubagentStop({ agent_id: agentId, agent_type: 'general-purpose', agent_transcript_path: '', stop_hook_active: false, last_assistant_message: last })
const status = ($: any, args = '') => $.command.run({ command: 'schema-tasks', args, ...COMMAND })

describe('schema-tasks', () => {
  test('an ordinary Agent prompt passes untouched', async ($, on) => {
    const w = fresh(async () => ({ answer: 'plain prose' }))
    world(on, $, w)
    await start($)
    const r = await agent($, 'Summarize the repo.')
    expect(w.spawnPrompts).toEqual(['Summarize the repo.'])
    expect(r.text).toBe('plain prose')
    expect(r.context).toBeUndefined()
    expect((await status($)).text).toContain('0 contracts')
  })

  test('hand-back path: an invalid report is refused with its problems, then the valid one is delivered as JSON', async ($, on) => {
    const seen: string[] = []
    const w = fresh(
      async (T, id) => {
        const first = await handback(T, id, '```json\n{"verdict":"pass"}\n```')
        seen.push(first.deny ?? first.text ?? '')
        const second = await handback(T, id, '{"verdict":"maybe"}')
        seen.push(second.deny ?? second.text ?? '')
        await handback(T, id, '{"verdict":"pass"}')
        return { answer: '{"verdict":"pass"}' }
      },
      { pointer: true },
    )
    world(on, $, w)
    await start($)
    const r = await agent($, ENVELOPE)
    expect(w.spawnPrompts[0]).toContain('Judge it.')
    expect(w.spawnPrompts[0]).toContain('exactly one JSON value')
    expect(seen[0]).toContain('code fence')
    expect(seen[1]).toContain('/verdict')
    expect(w.handbacks).toEqual(['{"verdict":"pass"}'])
    expect(r.deny).toBeUndefined()
    expect(r.context?.join('\n')).toContain('Validated JSON:\n{"verdict":"pass"}')
    expect((await status($)).text).toContain('valid, repairs 2/3')
  })

  test('stop path: an invalid last reply is blocked, a valid one ends the child', async ($, on) => {
    const blocks: unknown[] = []
    const w = fresh(async (T, id) => {
      blocks.push(await stop(T, id, 'The verdict is pass.'))
      blocks.push(await stop(T, id, '{"verdict":"pass"}'))
      return { answer: '{"verdict":"pass"}' }
    })
    world(on, $, w)
    await start($)
    const r = await agent($, ENVELOPE)
    expect((blocks[0] as any).block).toContain('not exactly one JSON value')
    expect((blocks[1] as any).block).toBeUndefined()
    expect(r.context?.join('\n')).toContain('{"verdict":"pass"}')
  })

  test('repairs run out: the child is let go and the parent gets an explicit failure', async ($, on) => {
    const answers: unknown[] = []
    const w = fresh(async (T, id) => {
      for (let i = 0; i < 4; i++) answers.push(await handback(T, id, 'not json'))
      return { answer: 'not json' }
    }, { pointer: true })
    world(on, $, w)
    await start($)
    const r = await agent($, ENVELOPE)
    expect(answers.map((a: any) => a.deny !== undefined || a.isError === true)).toEqual([true, true, true, false])
    expect(w.handbacks).toEqual(['not json'])
    expect(r.deny).toContain('repairs-exhausted')
    expect(r.deny).toContain('not a valid result')
  }, )

  test('a child that ends without passing any gate is a failure', async ($, on) => {
    const w = fresh(async () => ({ answer: 'Done! Verdict: pass.' }))
    world(on, $, w)
    await start($)
    const r = await agent($, ENVELOPE)
    expect(r.deny).toContain('final-invalid')
  })

  test('a valid answer at turn.complete with no gate seen is accepted', async ($, on) => {
    const w = fresh(async () => ({ answer: '{"verdict":"fail"}' }))
    world(on, $, w)
    await start($)
    const r = await agent($, ENVELOPE)
    expect(r.context?.join('\n')).toContain('{"verdict":"fail"}')
  })

  test('without turn.complete the hand-back pointer fails closed', async ($, on) => {
    const w = fresh(async (T, id) => {
      await handback(T, id, '{"verdict":"pass"}')
      return null
    }, { pointer: true })
    world(on, $, w)
    await start($)
    const r = await agent($, ENVELOPE)
    expect(r.deny).toContain('final-invalid')
  })

  test('an interrupted child is cancelled', async ($, on) => {
    const w = fresh(async () => ({ answer: '', reason: 'aborted' }))
    world(on, $, w)
    await start($)
    const r = await agent($, ENVELOPE)
    expect(r.deny).toContain('was cancelled')
  })

  test('malformed envelopes and unsupported schemas start nothing', async ($, on) => {
    const w = fresh(async () => ({ answer: '{}' }))
    world(on, $, w)
    await start($)
    const bad = await agent($, '{"claudeSchemaTasks": 1, "task": "x", "schema": ')
    expect(bad.deny).toContain('not valid JSON')
    const unsupported = await agent($, JSON.stringify({ claudeSchemaTasks: 1, task: 'x', schema: { type: 'string', pattern: 'a+' } }))
    expect(unsupported.deny).toContain('/pattern')
    const remote = await agent($, ENVELOPE, { isolation: 'remote' })
    expect(remote.deny).toContain('remote')
    expect(w.agentCalls).toBe(0)
  })

  test('off refuses envelopes and leaves ordinary prompts alone', async ($, on) => {
    const w = fresh(async () => ({ answer: 'ok' }))
    world(on, $, w)
    await start($)
    expect((await status($, 'off')).text).toContain('off (set for this session)')
    const r = await agent($, ENVELOPE)
    expect(r.deny).toContain('off')
    expect((await agent($, 'hello')).text).toBe('ok')
    expect(w.agentCalls).toBe(1)
  })

  test('turning off mid-run lets the child go and fails the contract as disabled', async ($, on) => {
    const answers: unknown[] = []
    const w = fresh(async (T, id) => {
      await status(T, 'off')
      answers.push(await handback(T, id, 'prose'))
      return { answer: 'prose' }
    }, { pointer: true })
    world(on, $, w)
    await start($)
    const r = await agent($, ENVELOPE)
    expect((answers[0] as any).deny).toBeUndefined()
    expect(r.deny).toContain('disabled')
  })

  test('background: pending until the child ends, then schema_result answers only its parent', async ($, on) => {
    const w = fresh(async () => null, { background: true })
    world(on, $, w)
    await start($)
    const r = await agent($, ENVELOPE)
    expect(r.context?.join('\n')).toContain('schema_result')
    const pending = await $.tool.call({ tool: TOOL, agent_id: 'a1' } as any)
    expect(typeof pending.result).toBe('string')
    expect(JSON.parse(pending.result as string)).toEqual({ status: 'pending' })
    await $.turn.complete({ agentId: 'a1', turnId: 't', reason: 'answer', answer: '{"verdict":"pass"}', durationMs: 1, isAborted: false })
    const done = await $.tool.call({ tool: TOOL, agent_id: 'a1' } as any)
    expect(JSON.parse(done.result as string)).toEqual({ status: 'ok', data: { verdict: 'pass' } })
    const other = await $.tool.call({ tool: TOOL, agent_id: 'a1', agentId: 'intruder' } as any)
    expect(String(other.deny ?? other.text)).toContain('No contract')
  })

  test('nested: a subagent\'s envelope is its own contract', async ($, on) => {
    const w = fresh(async (T, id) => {
      await handback(T, id, '{"verdict":"fail"}')
      return { answer: '{"verdict":"fail"}' }
    }, { pointer: true })
    world(on, $, w)
    await start($)
    const r = await agent($, ENVELOPE, { agentId: 'p1' })
    expect(r.context?.join('\n')).toContain('{"verdict":"fail"}')
    const shown = await status($, 'show a1')
    expect(shown.text).toContain('valid')
    expect(shown.text).toContain('gate: handback (passed)')
  })

  test('the Agent description teaches the envelope', async ($, on) => {
    const w = fresh(async () => null)
    world(on, $, w)
    await start($)
    const d = await $.tool.describe({ tool: 'Agent', description: 'Launch an agent.', provider: ENGINE })
    expect(d.description.startsWith('Launch an agent.')).toBe(true)
    expect(d.description).toContain('"claudeSchemaTasks": 1')
    const bash = await $.tool.describe({ tool: 'Bash', description: 'Run.', provider: ENGINE })
    expect(bash.description).toBe('Run.')
  })

  test('an unknown argument answers with usage', async ($, on) => {
    world(on, $, fresh(async () => null))
    await start($)
    const res = await status($, 'bogus')
    expect(res.text).toContain('Usage: /schema-tasks')
  })
})
