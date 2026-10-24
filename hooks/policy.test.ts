import { describe, expect, test } from 'claude-code/testing'

import {
  INITIAL,
  MAX_CONTRACTS,
  TEACH,
  childPrompt,
  configFrom,
  feedback,
  isActive,
  judge,
  newContract,
  parseArgs,
  parseEnvelope,
  parseReply,
  resultFor,
  showText,
  statusText,
  transition,
} from './policy'
import type { Contract } from '../types'

const CONFIG = configFrom({})
const SCHEMA = { type: 'object', properties: { verdict: { enum: ['pass', 'fail'] } }, required: ['verdict'], additionalProperties: false }
const envelope = (over: Record<string, unknown> = {}) => JSON.stringify({ claudeSchemaTasks: 1, schema: SCHEMA, task: 'Judge it.', ...over })

const open = (over: Partial<Contract> = {}): Contract => ({
  ...newContract({ id: 'tu1', parentAgentId: null, description: 'judge', task: 'Judge it.', schema: SCHEMA, background: false }, CONFIG),
  ...over,
})
const running = (over: Partial<Contract> = {}) => open({ phase: 'running', agentId: 'a1', ...over })

describe('config and command', () => {
  test('options are clamped and defaulted', async () => {
    expect(configFrom({})).toEqual({ enabled: true, maxRepairs: 3, maxSchemaBytes: 32768, maxResultBytes: 262144 })
    expect(configFrom({ maxRepairs: 9, maxSchemaBytes: 1, maxResultBytes: 'x' })).toEqual({
      enabled: true, maxRepairs: 5, maxSchemaBytes: 256, maxResultBytes: 262144,
    })
    expect(configFrom({ maxRepairs: -2.5 }).maxRepairs).toBe(0)
  })

  test('a session override beats the enabled option', async () => {
    expect(isActive(configFrom({ enabled: false }), INITIAL)).toBe(false)
    expect(isActive(configFrom({ enabled: false }), { mode: 'on' })).toBe(true)
    expect(isActive(CONFIG, { mode: 'off' })).toBe(false)
  })

  test('parseArgs reads on, off, status, show and rejects the rest', async () => {
    expect(parseArgs('')).toEqual({ kind: 'status' })
    expect(parseArgs(' OFF ')).toEqual({ kind: 'set', mode: 'off' })
    expect(parseArgs('show tu1')).toEqual({ kind: 'show', id: 'tu1' })
    expect(parseArgs('show')).toEqual({ kind: 'help', error: 'show needs a contract id or agent id' })
    expect(parseArgs('bogus')).toEqual({ kind: 'help', error: 'Unknown argument: bogus' })
  })
})

describe('envelope', () => {
  test('an ordinary prompt is not an envelope', async () => {
    expect(parseEnvelope('Review the claudeSchemaTasks module', CONFIG)).toEqual({ kind: 'none' })
    expect(parseEnvelope('{"a": 1}', CONFIG)).toEqual({ kind: 'none' })
  })

  test('a good envelope yields its task and schema', async () => {
    expect(parseEnvelope(`  ${envelope()}\n`, CONFIG)).toEqual({ kind: 'ok', task: 'Judge it.', schema: SCHEMA })
  })

  test('malformed envelopes are refused with a reason', async () => {
    const bad = (p: string) => {
      const r = parseEnvelope(p, CONFIG)
      return r.kind === 'invalid' ? r.message : `not refused: ${r.kind}`
    }
    expect(bad('{"claudeSchemaTasks": 1, "task": ')).toContain('not valid JSON')
    expect(bad(envelope({ claudeSchemaTasks: 2 }))).toContain('version')
    expect(bad(envelope({ task: '  ' }))).toContain('task')
    expect(bad(envelope({ extra: true }))).toContain('extra')
    expect(bad(envelope({ schema: { type: 'string', format: 'email' } }))).toContain('schema')
    const r = parseEnvelope(envelope({ schema: { type: 'string', format: 'email' } }), CONFIG)
    expect(r.kind === 'invalid' ? r.issues.map(i => i.path) : []).toEqual(['/format'])
  })

  test('the schema byte limit comes from the options', async () => {
    const r = parseEnvelope(envelope(), { ...CONFIG, maxSchemaBytes: 256 })
    expect(r.kind).toBe('ok')
    const big = parseEnvelope(envelope({ schema: { description: 'x'.repeat(400) } }), { ...CONFIG, maxSchemaBytes: 256 })
    expect(big.kind).toBe('invalid')
  })

  test('the child prompt carries the task, the schema and the rule', async () => {
    const p = childPrompt(open())
    expect(p).toContain('Judge it.')
    expect(p).toContain(JSON.stringify(SCHEMA))
    expect(p).toContain('exactly one JSON value')
    expect(p).toContain('no code fences')
  })

  test('the teaching paragraph is short and names the envelope', async () => {
    expect(TEACH).toContain('"claudeSchemaTasks": 1')
    expect(TEACH).toContain('mcp__schema-tasks__schema_result')
    expect(TEACH.length).toBeLessThan(1000)
  })
})

describe('reply parsing', () => {
  test('strict: one JSON value, whitespace allowed', async () => {
    expect(parseReply(' {"verdict":"pass"}\n', 1000)).toEqual({ ok: true, value: { verdict: 'pass' } })
    expect(parseReply('false', 1000)).toEqual({ ok: true, value: false })
    expect(parseReply('null', 1000)).toEqual({ ok: true, value: null })
  })

  test('fences, prose, empty and oversized replies are refused', async () => {
    const why = (t: string, max = 1000) => {
      const r = parseReply(t, max)
      return r.ok ? 'accepted' : r.issues[0]!.message
    }
    expect(why('```json\n{"verdict":"pass"}\n```')).toContain('code fence')
    expect(why('Here it is: {"verdict":"pass"}')).toContain('one JSON value')
    expect(why('{"verdict":"pass"} done')).toContain('one JSON value')
    expect(why('   ')).toContain('empty')
    expect(why('"' + 'x'.repeat(50) + '"', 20)).toContain('bytes')
  })

  test('feedback is bounded and names paths', async () => {
    const issues = Array.from({ length: 40 }, (_, i) => ({ path: `/a/${i}`, message: 'm'.repeat(500) }))
    const text = feedback(issues, 'handback', 1, 3)
    expect(text).toContain('/a/0')
    expect(text).not.toContain('/a/20')
    expect(text).toContain('20 more')
    expect(text).toContain('SubagentHandback')
    expect(text.length).toBeLessThan(6000)
    expect(feedback([{ path: '', message: 'x' }], 'stop', 3, 3)).toContain('(root)')
  })
})

describe('transition', () => {
  test('open, spawn, valid handback, valid answer: valid with data', async () => {
    let s = transition([], { kind: 'open', contract: open() }).contracts
    s = transition(s, { kind: 'spawned', id: 'tu1', agentId: 'a1' }).contracts
    expect(s[0]!.phase).toBe('running')
    const gate = transition(s, { kind: 'reply', agentId: 'a1', gate: 'handback', text: '{"verdict":"pass"}', enabled: true })
    expect(gate.action).toEqual({ kind: 'pass' })
    expect(gate.contracts[0]!.gatePassed).toBe(true)
    expect(gate.contracts[0]!.phase).toBe('running')
    const done = transition(gate.contracts, { kind: 'complete', agentId: 'a1', reason: 'answer', answer: '{"verdict":"pass"}', enabled: true })
    expect(done.contracts[0]!).toMatchObject({ phase: 'valid', hasData: true, data: { verdict: 'pass' } })
  })

  test('an invalid reply is sent back until repairs run out, then the contract fails', async () => {
    let s = [running({ maxRepairs: 2 })]
    const bad = { kind: 'reply' as const, agentId: 'a1', gate: 'stop' as const, text: '{"verdict":"maybe"}', enabled: true }
    let r = transition(s, bad)
    expect(r.action.kind).toBe('repair')
    expect(r.action.kind === 'repair' ? r.action.feedback : '').toContain('/verdict')
    r = transition(r.contracts, bad)
    expect(r.action.kind).toBe('repair')
    expect(r.contracts[0]!.repairsUsed).toBe(2)
    r = transition(r.contracts, bad)
    expect(r.action).toEqual({ kind: 'pass' })
    expect(r.contracts[0]!.phase).toBe('failed')
    expect(r.contracts[0]!.failure!.code).toBe('repairs-exhausted')
    // final: a valid answer afterwards does not revive it
    s = transition(r.contracts, { kind: 'complete', agentId: 'a1', reason: 'answer', answer: '{"verdict":"pass"}', enabled: true }).contracts
    expect(s[0]!.phase).toBe('failed')
  })

  test('maxRepairs 0 fails on the first invalid reply', async () => {
    const r = transition([running({ maxRepairs: 0 })], { kind: 'reply', agentId: 'a1', gate: 'stop', text: 'nope', enabled: true })
    expect(r.action).toEqual({ kind: 'pass' })
    expect(r.contracts[0]!.phase).toBe('failed')
  })

  test('once a child has used the hand-back gate, its stop is not judged again', async () => {
    const s = transition([running()], { kind: 'reply', agentId: 'a1', gate: 'handback', text: '{"verdict":"pass"}', enabled: true }).contracts
    const r = transition(s, { kind: 'reply', agentId: 'a1', gate: 'stop', text: '', enabled: true })
    expect(r.action).toEqual({ kind: 'pass' })
    expect(r.contracts[0]!.repairsUsed).toBe(0)
  })

  test('replies from untracked agents pass untouched', async () => {
    const s = [running()]
    const r = transition(s, { kind: 'reply', agentId: 'other', gate: 'stop', text: 'prose', enabled: true })
    expect(r).toEqual({ contracts: s, action: { kind: 'pass' } })
  })

  test('the final check is independent of the gates', async () => {
    const passed = [running({ gatePassed: true })]
    const r = transition(passed, { kind: 'complete', agentId: 'a1', reason: 'answer', answer: 'SECURITY WARNING\n{"verdict":"pass"}', enabled: true })
    expect(r.contracts[0]!).toMatchObject({ phase: 'failed', hasData: false })
    expect(r.contracts[0]!.failure!.code).toBe('final-invalid')
    // a child no gate ever saw is judged here
    const never = transition([running()], { kind: 'complete', agentId: 'a1', reason: 'answer', answer: 'all good!', enabled: true })
    expect(never.contracts[0]!.phase).toBe('failed')
  })

  test('aborted, refusal and error endings', async () => {
    const end = (reason: 'aborted' | 'refusal' | 'error') =>
      transition([running()], { kind: 'complete', agentId: 'a1', reason, answer: '{"verdict":"pass"}', enabled: true }).contracts[0]!
    expect(end('aborted').phase).toBe('cancelled')
    expect(end('refusal').failure!.code).toBe('refusal')
    expect(end('error').failure!.code).toBe('error')
  })

  test('off: gates let the child go and the contract fails as disabled', async () => {
    const r = transition([running()], { kind: 'reply', agentId: 'a1', gate: 'handback', text: 'prose', enabled: false })
    expect(r.action).toEqual({ kind: 'pass' })
    expect(r.contracts[0]!.failure!.code).toBe('disabled')
  })

  test('agent result: valid contract adds the JSON as context', async () => {
    const s = [running({ phase: 'valid', hasData: true, data: { verdict: 'pass' } })]
    const r = transition(s, { kind: 'agentResult', id: 'tu1', outcome: { kind: 'completed', agentId: 'a1', text: 'pointer', handback: 'send' } })
    expect(r.action.kind).toBe('context')
    expect(r.action.kind === 'context' ? r.action.text : '').toContain('{"verdict":"pass"}')
  })

  test('agent result: failed contract denies with the code and issues', async () => {
    const s = [running({ phase: 'failed', failure: { code: 'repairs-exhausted', message: 'still invalid', issues: [{ path: '/verdict', message: 'bad' }] } })]
    const r = transition(s, { kind: 'agentResult', id: 'tu1', outcome: { kind: 'completed', agentId: 'a1', text: '{}' } })
    expect(r.action.kind).toBe('deny')
    const text = r.action.kind === 'deny' ? r.action.text : ''
    expect(text).toContain('repairs-exhausted')
    expect(text).toContain('/verdict')
    expect(text).toContain('not a valid result')
  })

  test('agent result before turn.complete: the result text is judged, pointers fail closed', async () => {
    const good = transition([running()], { kind: 'agentResult', id: 'tu1', outcome: { kind: 'completed', agentId: 'a1', text: '{"verdict":"fail"}' } })
    expect(good.action.kind).toBe('context')
    expect(good.contracts[0]!.phase).toBe('valid')
    const pointer = transition([running()], { kind: 'agentResult', id: 'tu1', outcome: { kind: 'completed', agentId: 'a1', text: 'report delivered as a message' } })
    expect(pointer.action.kind).toBe('deny')
    const flagged = transition([running()], { kind: 'agentResult', id: 'tu1', outcome: { kind: 'completed', agentId: 'a1', text: '{"verdict":"fail"}', handback: 'flagged' } })
    expect(flagged.action.kind).toBe('deny')
    expect(flagged.contracts[0]!.failure!.code).toBe('handback-withheld')
  })

  test('agent result: background launch binds the child and stays pending', async () => {
    const r = transition([open()], { kind: 'agentResult', id: 'tu1', outcome: { kind: 'launched', agentId: 'a9' } })
    expect(r.contracts[0]!).toMatchObject({ agentId: 'a9', background: true })
    expect(r.action.kind === 'context' ? r.action.text : '').toContain('schema_result')
  })

  test('agent result: an errored call fails the contract and passes the error on', async () => {
    const r = transition([running()], { kind: 'agentResult', id: 'tu1', outcome: { kind: 'error' } })
    expect(r.action).toEqual({ kind: 'pass' })
    expect(r.contracts[0]!.failure!.code).toBe('agent-error')
  })

  test('a lost contract fails closed', async () => {
    const r = transition([], { kind: 'agentResult', id: 'gone', outcome: { kind: 'completed', agentId: 'a1', text: '{"verdict":"pass"}' } })
    expect(r.action.kind).toBe('deny')
  })

  test('the list stays bounded, dropping the oldest finished contract', async () => {
    let s: Contract[] = []
    for (let i = 0; i < MAX_CONTRACTS; i++) s = transition(s, { kind: 'open', contract: open({ id: `t${i}`, phase: i === 3 ? 'valid' : 'starting' }) }).contracts
    const r = transition(s, { kind: 'open', contract: open({ id: 'new' }) })
    expect(r.contracts.length).toBe(MAX_CONTRACTS)
    expect(r.contracts.some(c => c.id === 't3')).toBe(false)
    expect(r.action).toEqual({ kind: 'pass' })
    const full = r.contracts.map(c => ({ ...c, phase: 'running' as const }))
    expect(transition(full, { kind: 'open', contract: open({ id: 'more' }) }).action.kind).toBe('deny')
  })

  test('two children never read each other\'s contract', async () => {
    let s = [running(), running({ id: 'tu2', agentId: 'a2', schema: { type: 'object', required: ['n'] } })]
    s = transition(s, { kind: 'complete', agentId: 'a2', reason: 'answer', answer: '{"n":1}', enabled: true }).contracts
    s = transition(s, { kind: 'complete', agentId: 'a1', reason: 'answer', answer: '{"n":1}', enabled: true }).contracts
    expect(s.map(c => c.phase)).toEqual(['failed', 'valid'])
  })
})

describe('schema_result and status', () => {
  test('answers only the loop that opened the contract', async () => {
    const s = [running({ phase: 'valid', hasData: true, data: { verdict: 'pass' } }), running({ id: 'tu2', agentId: 'a2', parentAgentId: 'p1' })]
    expect(resultFor(s, 'a1', null)).toEqual({ status: 'ok', data: { verdict: 'pass' } })
    expect(resultFor(s, 'a1', 'p1')).toBeNull()
    expect(resultFor(s, 'a2', 'p1')).toEqual({ status: 'pending' })
    expect(resultFor(s, 'a2', null)).toBeNull()
  })

  test('status lists contracts; show gives the problems', async () => {
    const s = [running({ repairsUsed: 1, lastIssues: [{ path: '/verdict', message: 'must be one of "pass", "fail"' }] })]
    const text = statusText(CONFIG, INITIAL, s)
    expect(text).toContain('on (from the enabled option)')
    expect(text).toContain('tu1')
    expect(text).toContain('running')
    expect(text).toContain('1/3')
    expect(showText(s, 'a1')).toContain('/verdict')
    expect(showText(s, 'zzz')).toContain('No contract')
  })
})

describe('numbers JSON cannot hold (R1-1)', () => {
  const NUM = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }

  test('an overflowing number in a reply is refused, typed or not', async () => {
    for (const text of ['{"n":1e400}', '{"n":-1e400}', '{"n":1,"extra":[2,1e999]}']) {
      const r = judge(running({ schema: NUM }), text)
      expect(r.ok).toBe(false)
      expect(r.ok ? '' : r.issues[0]!.message).toContain('out of range')
    }
    const open = judge(running({ schema: { type: 'object' } }), '{"x":{"y":1e400}}')
    expect(open.ok ? [] : open.issues.map(i => i.path)).toEqual(['/x/y'])
  })

  test('an overflowing reply never becomes a valid contract with null data', async () => {
    const done = transition([running({ schema: NUM })], { kind: 'complete', agentId: 'a1', reason: 'answer', answer: '{"n":1e400}', enabled: true })
    expect(done.contracts[0]!).toMatchObject({ phase: 'failed', hasData: false })
    const late = transition([running({ schema: NUM })], { kind: 'agentResult', id: 'tu1', outcome: { kind: 'completed', agentId: 'a1', text: '{"n":1e400}' } })
    expect(late.action.kind).toBe('deny')
  })

  test('an overflowing number in a schema is refused before the child starts', async () => {
    const text = '{"claudeSchemaTasks":1,"task":"x","schema":{"type":"object","properties":{"n":{"const":1e400}}}}'
    const r = parseEnvelope(text, CONFIG)
    expect(r.kind).toBe('invalid')
    expect(r.kind === 'invalid' ? r.issues.map(i => i.path) : []).toEqual(['/properties/n/const'])
  })

  test('what is published is what was validated', async () => {
    const r = judge(running({ schema: NUM }), '{"n":1e-400}')
    expect(r).toEqual({ ok: true, value: { n: 0 } })
    expect(JSON.parse(JSON.stringify(r.ok ? r.value : null))).toEqual({ n: 0 })
  })
})

describe('validation limits are failures of their own (R1-2)', () => {
  const LIST = { oneOf: [true, { $ref: '#/$defs/list' }], $defs: { list: { type: 'array', items: { $ref: '#/$defs/list' } } } }
  const deep = '['.repeat(300) + ']'.repeat(300)

  test('the final check fails with validation-limit', async () => {
    const r = transition([running({ schema: LIST })], { kind: 'complete', agentId: 'a1', reason: 'answer', answer: deep, enabled: true })
    expect(r.contracts[0]!).toMatchObject({ phase: 'failed', hasData: false })
    expect(r.contracts[0]!.failure!.code).toBe('validation-limit')
  })

  test('a gate fails the contract at once instead of asking for a repair', async () => {
    const r = transition([running({ schema: LIST })], { kind: 'reply', agentId: 'a1', gate: 'handback', text: deep, enabled: true })
    expect(r.action).toEqual({ kind: 'pass' })
    expect(r.contracts[0]!.failure!.code).toBe('validation-limit')
  })
})

describe('a reply too big to check is a validation limit (R1-3)', () => {
  test('past the work budget the contract fails as validation-limit', async () => {
    const schema = { type: 'array', items: { allOf: [{}, {}] } }
    const answer = JSON.stringify(Array(400000).fill(0))
    const r = transition([running({ schema, maxResultBytes: 4194304 })], { kind: 'complete', agentId: 'a1', reason: 'answer', answer, enabled: true })
    expect(r.contracts[0]!.failure?.code).toBe('validation-limit')
  })
})
