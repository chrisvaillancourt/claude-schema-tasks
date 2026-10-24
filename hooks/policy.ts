// Pure decisions: no `$`, no I/O. register.ts turns engine events into the
// events of `transition` and carries out the action it returns.
import { checkSchema, utf8Length, validate } from './schema'
import type { Config, Contract, Failure, FailureCode, Gate, Issue, Mode, Phase, Session } from '../types'

export const INITIAL: Session = { mode: null }

/** Contracts kept per session; the oldest finished ones are dropped first. */
export const MAX_CONTRACTS = 16
export const SCHEMA_LIMITS = { maxDepth: 32, maxNodes: 2000 }
/** Problems listed in feedback and denials. */
const MAX_LISTED = 20
const MAX_ISSUE_CHARS = 200

export const TOOL_NAME = 'schema_result'
export const TOOL_ID = 'mcp__schema-tasks__schema_result'

const FINAL: ReadonlySet<Phase> = new Set(['valid', 'failed', 'cancelled'])
export const isFinal = (c: Contract) => FINAL.has(c.phase)

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(hi, Math.max(lo, Math.trunc(v)))
}

export function configFrom(options: Record<string, unknown>): Config {
  return {
    enabled: options.enabled !== false,
    maxRepairs: clampInt(options.maxRepairs, 0, 5, 3),
    maxSchemaBytes: clampInt(options.maxSchemaBytes, 256, 262144, 32768),
    maxResultBytes: clampInt(options.maxResultBytes, 1024, 4194304, 262144),
  }
}

export function isActive(config: Config, session: Session): boolean {
  return session.mode === null ? config.enabled : session.mode === 'on'
}

// ---------------------------------------------------------------- command

export type Command =
  | { kind: 'set'; mode: Mode }
  | { kind: 'status' }
  | { kind: 'show'; id: string }
  | { kind: 'help'; error?: string }

export function parseArgs(args: string): Command {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const word = (words[0] ?? '').toLowerCase()
  if (word === '' || word === 'status') return { kind: 'status' }
  if (word === 'on' || word === 'off') return { kind: 'set', mode: word }
  if (word === 'help') return { kind: 'help' }
  if (word === 'show') {
    const id = words[1]
    return id === undefined ? { kind: 'help', error: 'show needs a contract id or agent id' } : { kind: 'show', id }
  }
  return { kind: 'help', error: `Unknown argument: ${args.trim()}` }
}

export const USAGE = 'Usage: /schema-tasks [on|off|status|show <id>]'

// ---------------------------------------------------------------- envelope

/** The paragraph appended to the Agent tool's description; fixed text. */
export const TEACH =
  '\n\nStructured results (schema-tasks): to get JSON back that is checked against a JSON Schema, make the whole prompt one JSON object: ' +
  '{"claudeSchemaTasks": 1, "schema": <JSON Schema object>, "task": "<the task>"}. The subagent must answer with one JSON value; ' +
  'an invalid answer is sent back to it with the problems, and you get either the validated JSON (in a note after the Agent result) or an explicit failure. ' +
  'Supported: type, properties, required, additionalProperties, items, enum, const, minimum, maximum, exclusiveMinimum, exclusiveMaximum, ' +
  'minLength, maxLength, minItems, maxItems, anyOf, oneOf, allOf, local $ref and $defs; anything else (pattern, format, ...) is refused. ' +
  `With run_in_background, call ${TOOL_ID}({"agent_id": "<id>"}) once it has finished. Any other prompt runs as usual.`

export type EnvelopeParse =
  | { kind: 'none' }
  | { kind: 'ok'; task: string; schema: unknown }
  | { kind: 'invalid'; message: string; issues: Issue[] }

const ENVELOPE_KEYS = new Set(['claudeSchemaTasks', 'schema', 'task'])

/** An envelope is a prompt that starts with `{` and names "claudeSchemaTasks". */
export function parseEnvelope(prompt: string, config: Config): EnvelopeParse {
  const text = prompt.trim()
  if (!text.startsWith('{') || !text.includes('"claudeSchemaTasks"')) return { kind: 'none' }
  const invalid = (message: string, issues: Issue[] = []): EnvelopeParse => ({ kind: 'invalid', message, issues })
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return invalid('the prompt is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return invalid('the envelope must be a JSON object')
  const env = parsed as Record<string, unknown>
  const unknown = Object.keys(env).filter(k => !ENVELOPE_KEYS.has(k))
  if (unknown.length > 0) return invalid(`unknown envelope key(s): ${unknown.join(', ')} (allowed: claudeSchemaTasks, schema, task)`)
  if (env.claudeSchemaTasks !== 1) return invalid('unsupported envelope version: claudeSchemaTasks must be 1')
  if (typeof env.task !== 'string' || env.task.trim() === '') return invalid('the envelope needs a non-empty "task" string')
  if (!Object.hasOwn(env, 'schema')) return invalid('the envelope needs a "schema"')
  const issues = checkSchema(env.schema, { ...SCHEMA_LIMITS, maxBytes: config.maxSchemaBytes })
  if (issues.length > 0) return invalid('the schema is not usable', issues)
  return { kind: 'ok', task: env.task, schema: env.schema }
}

export function newContract(
  f: { id: string; parentAgentId: string | null; description: string; task: string; schema: unknown; background: boolean },
  config: Config,
): Contract {
  return {
    ...f,
    agentId: null,
    maxRepairs: config.maxRepairs,
    maxResultBytes: config.maxResultBytes,
    repairsUsed: 0,
    phase: 'starting',
    gate: null,
    gatePassed: false,
    hasData: false,
    data: null,
    failure: null,
    lastIssues: [],
  }
}

export function childPrompt(c: Contract): string {
  return [
    `[schema-tasks contract ${c.id}]`,
    c.task.trim(),
    '',
    '---',
    'How to finish: your final reply must be exactly one JSON value that validates against the JSON Schema below, ' +
      'with no code fences and no text before or after it. If you deliver your report through a hand-back tool, its message must be that JSON value alone. ' +
      `A reply that does not validate is sent back to you with the problems listed (at most ${c.maxRepairs} time${c.maxRepairs === 1 ? '' : 's'}); after that the task counts as failed.`,
    '',
    'JSON Schema:',
    JSON.stringify(c.schema),
  ].join('\n')
}

// ---------------------------------------------------------------- replies

export type Judged = { ok: true; value: unknown } | { ok: false; issues: Issue[] }

/** Strict: the whole reply, trimmed, is one JSON value. */
export function parseReply(text: string, maxBytes: number): Judged {
  const bytes = utf8Length(text)
  if (bytes > maxBytes) return { ok: false, issues: [{ path: '', message: `the reply is ${bytes} bytes; the limit is ${maxBytes} bytes` }] }
  const t = text.trim()
  if (t === '') return { ok: false, issues: [{ path: '', message: 'the reply is empty; it must be one JSON value' }] }
  if (t.startsWith('```')) return { ok: false, issues: [{ path: '', message: 'the reply is wrapped in a code fence; send the bare JSON value' }] }
  try {
    return { ok: true, value: JSON.parse(t) }
  } catch {
    return { ok: false, issues: [{ path: '', message: 'the reply is not exactly one JSON value (text before or after it, or a JSON syntax error)' }] }
  }
}

export function judge(c: Contract, text: string): Judged {
  const parsed = parseReply(text, c.maxResultBytes)
  if (!parsed.ok) return parsed
  const issues = validate(c.schema, parsed.value)
  return issues.length === 0 ? parsed : { ok: false, issues }
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3)}...` : s)

function listIssues(issues: Issue[]): string {
  const shown = issues.slice(0, MAX_LISTED).map(i => `- ${i.path === '' ? '(root)' : cut(i.path, MAX_ISSUE_CHARS)}: ${cut(i.message, MAX_ISSUE_CHARS)}`)
  if (issues.length > MAX_LISTED) shown.push(`- ...and ${issues.length - MAX_LISTED} more`)
  return shown.join('\n')
}

/** What a gate sends back to the child; bounded. */
export function feedback(issues: Issue[], gate: Gate, repair: number, maxRepairs: number): string {
  const how =
    gate === 'handback'
      ? 'Call SubagentHandback again with the corrected JSON value as the whole message.'
      : 'Reply again with only the corrected JSON value.'
  return [
    `schema-tasks: this reply is not a valid result (repair ${repair} of ${maxRepairs}). Problems:`,
    listIssues(issues),
    `It must be exactly one JSON value that validates against the schema in your task: no code fences, no text before or after it. ${how}`,
  ].join('\n')
}

// ---------------------------------------------------------------- state machine

export type ContractEvent =
  | { kind: 'open'; contract: Contract }
  | { kind: 'spawned'; id: string; agentId: string }
  | { kind: 'spawnRefused'; id: string; reason: string }
  | { kind: 'reply'; agentId: string; gate: Gate; text: string; enabled: boolean }
  | { kind: 'complete'; agentId: string; reason: 'answer' | 'aborted' | 'refusal' | 'error'; answer: string; enabled: boolean }
  | { kind: 'agentResult'; id: string; outcome: AgentOutcome }

export type AgentOutcome =
  | { kind: 'error' }
  | { kind: 'launched'; agentId: string }
  | { kind: 'completed'; agentId: string; text: string; handback?: 'send' | 'flagged' | 'withheld' }

export type Action =
  | { kind: 'pass' }
  | { kind: 'repair'; feedback: string }
  | { kind: 'deny'; text: string }
  | { kind: 'context'; text: string }

type Step = { contracts: Contract[]; action: Action }

const PASS: Action = { kind: 'pass' }

function fail(c: Contract, code: FailureCode, message: string, issues: Issue[] = []): Contract {
  const failure: Failure = { code, message, issues: issues.slice(0, MAX_LISTED) }
  return { ...c, phase: code === 'aborted' ? 'cancelled' : 'failed', hasData: false, data: null, failure, lastIssues: failure.issues }
}

function succeed(c: Contract, value: unknown): Contract {
  return { ...c, phase: 'valid', hasData: true, data: value, failure: null, lastIssues: [] }
}

function replace(list: Contract[], next: Contract): Contract[] {
  return list.map(c => (c.id === next.id ? next : c))
}

/** The open contract bound to this child. Final ones are never matched. */
function byAgent(list: Contract[], agentId: string): Contract | undefined {
  return list.find(c => c.agentId === agentId && !isFinal(c))
}

export function failureText(c: Contract): string {
  const f = c.failure
  const head = `schema-tasks: contract ${c.id} ${c.phase === 'cancelled' ? 'was cancelled' : 'failed'}${f ? ` (${f.code}): ${f.message}` : ''}.`
  const issues = f && f.issues.length > 0 ? `\nProblems:\n${listIssues(f.issues)}` : ''
  return `${head}${issues}\nThe subagent's report, including any copy delivered separately, is not a valid result; do not use it as one.`
}

function validText(c: Contract): string {
  return `schema-tasks: contract ${c.id} passed. The subagent's result validates against the schema. Validated JSON:\n${JSON.stringify(c.data)}`
}

function pendingText(c: Contract): string {
  return `schema-tasks: contract ${c.id} is pending. When agent ${c.agentId} has finished, call ${TOOL_ID}({"agent_id": "${c.agentId}"}) for the validated result; its own completion notice is not checked.`
}

/** Applies one event; `action` says what the hook does with the engine event. */
export function transition(list: Contract[], ev: ContractEvent): Step {
  switch (ev.kind) {
    case 'open': {
      let next = list.filter(c => c.id !== ev.contract.id)
      while (next.length >= MAX_CONTRACTS) {
        const i = next.findIndex(isFinal)
        if (i < 0) return { contracts: list, action: { kind: 'deny', text: `schema-tasks: ${MAX_CONTRACTS} structured delegations are already open; wait for one to finish.` } }
        next = next.filter((_, j) => j !== i)
      }
      return { contracts: [...next, ev.contract], action: PASS }
    }
    case 'spawned': {
      const c = list.find(x => x.id === ev.id)
      if (!c || c.phase !== 'starting') return { contracts: list, action: PASS }
      return { contracts: replace(list, { ...c, agentId: ev.agentId, phase: 'running' }), action: PASS }
    }
    case 'spawnRefused': {
      const c = list.find(x => x.id === ev.id)
      if (!c || isFinal(c)) return { contracts: list, action: PASS }
      return { contracts: replace(list, fail(c, 'spawn-refused', ev.reason)), action: PASS }
    }
    case 'reply': {
      const c = byAgent(list, ev.agentId)
      if (!c) return { contracts: list, action: PASS }
      if (!ev.enabled) return { contracts: replace(list, fail(c, 'disabled', 'schema-tasks was turned off while the subagent ran')), action: PASS }
      // A child that reports through the hand-back tool is gated there; its
      // stop afterwards carries no report to judge.
      if (ev.gate === 'stop' && c.gate === 'handback') return { contracts: list, action: PASS }
      const j = judge(c, ev.text)
      if (j.ok) return { contracts: replace(list, { ...c, gate: ev.gate, gatePassed: true, lastIssues: [] }), action: PASS }
      if (c.repairsUsed >= c.maxRepairs) {
        const failed = fail({ ...c, gate: ev.gate }, 'repairs-exhausted', `the reply was still invalid after ${c.maxRepairs} repair${c.maxRepairs === 1 ? '' : 's'}`, j.issues)
        return { contracts: replace(list, failed), action: PASS }
      }
      const repairsUsed = c.repairsUsed + 1
      return {
        contracts: replace(list, { ...c, gate: ev.gate, gatePassed: false, repairsUsed, lastIssues: j.issues.slice(0, MAX_LISTED) }),
        action: { kind: 'repair', feedback: feedback(j.issues, ev.gate, repairsUsed, c.maxRepairs) },
      }
    }
    case 'complete': {
      const c = byAgent(list, ev.agentId)
      if (!c) return { contracts: list, action: PASS }
      if (ev.reason === 'aborted') return { contracts: replace(list, fail(c, 'aborted', 'the subagent was interrupted')), action: PASS }
      if (ev.reason === 'refusal') return { contracts: replace(list, fail(c, 'refusal', 'the model refused the task')), action: PASS }
      if (ev.reason === 'error') return { contracts: replace(list, fail(c, 'error', 'an API error ended the subagent')), action: PASS }
      if (!ev.enabled) return { contracts: replace(list, fail(c, 'disabled', 'schema-tasks was turned off while the subagent ran')), action: PASS }
      const j = judge(c, ev.answer)
      const next = j.ok ? succeed(c, j.value) : fail(c, 'final-invalid', 'the answer the subagent delivered does not validate', j.issues)
      return { contracts: replace(list, next), action: PASS }
    }
    case 'agentResult': {
      const found = list.find(x => x.id === ev.id)
      if (!found) return { contracts: list, action: { kind: 'deny', text: `schema-tasks: contract ${ev.id} was lost (too many delegations, or a /clear); its result is not checked and must not be used.` } }
      const o = ev.outcome
      if (o.kind === 'error') {
        return { contracts: isFinal(found) ? list : replace(list, fail(found, 'agent-error', 'the Agent call failed')), action: PASS }
      }
      const c = found.agentId === null ? { ...found, agentId: o.agentId, phase: found.phase === 'starting' ? ('running' as const) : found.phase } : found
      if (o.kind === 'launched') {
        const bg = { ...c, background: true }
        const action: Action = isFinal(bg) ? (bg.phase === 'valid' ? { kind: 'context', text: validText(bg) } : { kind: 'context', text: failureText(bg) }) : { kind: 'context', text: pendingText(bg) }
        return { contracts: replace(list, bg), action }
      }
      let done = c
      if (!isFinal(c)) {
        if (o.handback === 'flagged' || o.handback === 'withheld') {
          done = fail(c, 'handback-withheld', `the hand-back was ${o.handback} by a security review`)
        } else {
          const j = judge(c, o.text)
          done = j.ok ? succeed(c, j.value) : fail(c, 'final-invalid', 'the Agent result does not validate (no checked answer was seen)', j.issues)
        }
      }
      const action: Action = done.phase === 'valid' ? { kind: 'context', text: validText(done) } : { kind: 'deny', text: failureText(done) }
      return { contracts: replace(list, done), action }
    }
  }
}

// ---------------------------------------------------------------- reading

export type ResultAnswer =
  | { status: 'pending' }
  | { status: 'ok'; data: unknown }
  | { status: 'failed' | 'cancelled'; code: FailureCode | null; message: string; issues: Issue[] }

/** `schema_result`'s answer, or null when no contract of this caller has that agent. */
export function resultFor(list: Contract[], agentId: string, callerAgentId: string | null): ResultAnswer | null {
  const c = [...list].reverse().find(x => x.agentId === agentId)
  if (!c || c.parentAgentId !== callerAgentId) return null
  if (c.phase === 'valid') return { status: 'ok', data: c.data }
  if (c.phase === 'failed' || c.phase === 'cancelled') {
    return { status: c.phase, code: c.failure?.code ?? null, message: c.failure?.message ?? '', issues: c.failure?.issues ?? [] }
  }
  return { status: 'pending' }
}

function row(c: Contract): string {
  const code = c.failure ? ` ${c.failure.code}` : ''
  return `- ${c.id} ${c.phase}${code}, repairs ${c.repairsUsed}/${c.maxRepairs}, agent ${c.agentId ?? '-'}${c.background ? ' (background)' : ''}: ${cut(c.description, 60)}`
}

export function statusText(config: Config, session: Session, list: Contract[]): string {
  const state = isActive(config, session) ? 'on' : 'off'
  const source = session.mode === null ? 'from the enabled option' : 'set for this session'
  const head = `${state} (${source}); ${list.length} contract${list.length === 1 ? '' : 's'} this session.`
  return list.length === 0 ? head : [head, ...list.map(row)].join('\n')
}

export function showText(list: Contract[], id: string): string {
  const c = [...list].reverse().find(x => x.id === id || x.agentId === id)
  if (!c) return `No contract with id or agent id ${id}.`
  const lines = [row(c), `gate: ${c.gate ?? 'none yet'}${c.gatePassed ? ' (passed)' : ''}`]
  if (c.failure) lines.push(`failure: ${c.failure.code}: ${c.failure.message}`)
  if (c.lastIssues.length > 0) lines.push('problems:', listIssues(c.lastIssues))
  if (c.phase === 'valid') lines.push(`data: ${cut(JSON.stringify(c.data), 2000)}`)
  lines.push(`schema: ${cut(JSON.stringify(c.schema), 2000)}`)
  return lines.join('\n')
}
