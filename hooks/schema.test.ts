import { describe, expect, test } from 'claude-code/testing'

import { checkSchema, codePointLength, evaluate, roundTrips, validate } from './schema'

const LIMITS = { maxBytes: 32768, maxDepth: 32, maxNodes: 2000 }
const ok = (s: unknown) => checkSchema(s, LIMITS)
const paths = (issues: { path: string }[]) => issues.map(i => i.path)

const VERDICT = {
  type: 'object',
  properties: { verdict: { enum: ['pass', 'fail'] }, score: { type: 'integer', minimum: 0, maximum: 10 } },
  required: ['verdict'],
  additionalProperties: false,
}

describe('checkSchema', () => {
  test('accepts the supported subset with annotations', async () => {
    expect(ok(VERDICT)).toEqual([])
    expect(ok({ $schema: 'x', title: 't', description: 'd', type: ['string', 'null'], minLength: 1, maxLength: 3 })).toEqual([])
    expect(ok({ $defs: { n: { type: 'number' } }, type: 'array', items: { $ref: '#/$defs/n' }, minItems: 1, maxItems: 2 })).toEqual([])
    expect(ok({ anyOf: [{ type: 'string' }, { const: 3 }], oneOf: [true, { type: 'number' }], allOf: [{}] })).toEqual([])
    expect(ok({ type: 'object', properties: { next: { $ref: '#' } } })).toEqual([])
  })

  test('refuses unsupported keywords instead of ignoring them', async () => {
    const issues = ok({ type: 'object', properties: { a: { type: 'string', pattern: '^x' } }, uniqueItems: true })
    expect(paths(issues)).toEqual(['/properties/a/pattern', '/uniqueItems'])
    expect(issues[0]!.message).toContain('not supported')
  })

  test('refuses bad keyword values', async () => {
    expect(paths(ok({ type: 'text' }))).toEqual(['/type'])
    expect(paths(ok({ required: 'a' }))).toEqual(['/required'])
    expect(paths(ok({ items: [{}] }))).toEqual(['/items'])
    expect(paths(ok({ minLength: -1 }))).toEqual(['/minLength'])
    expect(paths(ok({ enum: [] }))).toEqual(['/enum'])
    expect(paths(ok({ anyOf: [] }))).toEqual(['/anyOf'])
  })

  test('the root must be an object schema', async () => {
    expect(ok(true).length).toBe(1)
    expect(ok(false).length).toBe(1)
    expect(ok([]).length).toBe(1)
  })

  test('refuses remote, unresolved and non-schema references', async () => {
    expect(paths(ok({ $ref: 'https://example.com/s.json' }))).toEqual(['/$ref'])
    expect(paths(ok({ $ref: '#/$defs/missing' }))).toEqual(['/$ref'])
    expect(paths(ok({ required: ['a'], properties: { a: { $ref: '#/required' } } }))).toEqual(['/properties/a/$ref'])
  })

  test('refuses a reference loop that never moves into the data', async () => {
    const loop = ok({ $defs: { a: { $ref: '#/$defs/b' }, b: { allOf: [{ $ref: '#/$defs/a' }] } }, $ref: '#/$defs/a' })
    expect(loop.length).toBe(1)
    expect(loop[0]!.message).toContain('loop')
  })

  test('refuses schemas over the size, depth or node limits', async () => {
    expect(checkSchema({ description: 'x'.repeat(100) }, { ...LIMITS, maxBytes: 50 })[0]!.message).toContain('bytes')
    let deep: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 40; i++) deep = { type: 'array', items: deep }
    expect(ok(deep)[0]!.message).toContain('deep')
    expect(checkSchema({ anyOf: [{}, {}, {}, {}] }, { ...LIMITS, maxNodes: 3 })[0]!.message).toContain('subschemas')
  })

  test('a property named __proto__ is an ordinary property', async () => {
    const s = { type: 'object', properties: { __proto__: { type: 'string' } }, required: ['__proto__'] }
    const parsed = JSON.parse(JSON.stringify(s).replace('"properties":{}', '"properties":{"__proto__":{"type":"string"}}'))
    expect(ok(parsed)).toEqual([])
    expect(paths(validate(parsed, JSON.parse('{"__proto__": 1}')))).toEqual(['/__proto__'])
  })
})

describe('validate', () => {
  test('accepts valid values, falsy ones included', async () => {
    expect(validate(VERDICT, { verdict: 'pass' })).toEqual([])
    expect(validate(VERDICT, { verdict: 'fail', score: 0 })).toEqual([])
    expect(validate({ type: 'boolean' }, false)).toEqual([])
    expect(validate({ type: 'string' }, '')).toEqual([])
    expect(validate({ type: 'null' }, null)).toEqual([])
    expect(validate({ type: 'number' }, 2)).toEqual([])
  })

  test('reports every issue with its path', async () => {
    const issues = validate(VERDICT, { score: 11.5, extra: 1 })
    expect(paths(issues)).toEqual(['', '/score', '/score', '/extra'])
    expect(issues[0]!.message).toContain('"verdict"')
  })

  test('type, enum and const', async () => {
    expect(paths(validate({ type: 'integer' }, 1.5))).toEqual([''])
    expect(validate({ type: ['string', 'null'] }, null)).toEqual([])
    expect(paths(validate({ type: 'object' }, []))).toEqual([''])
    expect(paths(validate({ type: 'array' }, {}))).toEqual([''])
    expect(validate({ enum: [{ a: [1] }] }, { a: [1] })).toEqual([])
    expect(paths(validate({ enum: [{ a: [1] }] }, { a: [2] }))).toEqual([''])
    expect(paths(validate({ const: 0 }, false))).toEqual([''])
  })

  test('bounds on numbers, strings and arrays', async () => {
    expect(paths(validate({ exclusiveMinimum: 0, exclusiveMaximum: 1 }, 1))).toEqual([''])
    expect(paths(validate({ minLength: 2 }, 'a'))).toEqual([''])
    expect(paths(validate({ maxLength: 1 }, 'ab'))).toEqual([''])
    expect(paths(validate({ items: { type: 'string' }, maxItems: 2 }, ['a', 1, 'c']))).toEqual(['', '/1'])
    expect(paths(validate({ minItems: 1 }, []))).toEqual([''])
    expect(validate({ minLength: 5 }, 3)).toEqual([])
  })

  test('additionalProperties as a schema, and pointer escaping', async () => {
    const s = { properties: { a: {} }, additionalProperties: { type: 'number' } }
    expect(paths(validate(s, { a: 'x', 'b/c~d': 'y', e: 1 }))).toEqual(['/b~1c~0d'])
  })

  test('anyOf, oneOf, allOf and false', async () => {
    const any = { anyOf: [{ type: 'string' }, { type: 'number' }] }
    expect(validate(any, 1)).toEqual([])
    expect(paths(validate(any, true))).toEqual([''])
    const one = { oneOf: [{ type: 'number' }, { type: 'integer' }] }
    expect(validate(one, 1.5)).toEqual([])
    expect(validate(one, 2)[0]!.message).toContain('more than one of 2')
    expect(paths(validate({ allOf: [{ type: 'number' }, { minimum: 3 }] }, 2))).toEqual([''])
    expect(paths(validate({ properties: { a: false } }, { a: 1 }))).toEqual(['/a'])
  })

  test('recursive references follow the data', async () => {
    const tree = { type: 'object', properties: { v: { type: 'number' }, kids: { type: 'array', items: { $ref: '#' } } }, required: ['v'] }
    expect(validate(tree, { v: 1, kids: [{ v: 2, kids: [] }] })).toEqual([])
    expect(paths(validate(tree, { v: 1, kids: [{ kids: [{ v: 'x' }] }] }))).toEqual(['/kids/0', '/kids/0/kids/0/v'])
  })
})

describe('round trip (R1-1)', () => {
  test('a value survives JSON only when every number is finite', async () => {
    expect(roundTrips({ a: [1, 'x', null, { b: false }] })).toBe(true)
    expect(roundTrips({ n: Infinity })).toBe(false)
    expect(roundTrips([NaN])).toBe(false)
    expect(roundTrips({ u: undefined })).toBe(false)
  })
})

describe('resource limits (R1-2)', () => {
  // Both oneOf options accept any array, so oneOf must reject: a branch that
  // runs out of depth is "couldn't check", never "doesn't match".
  const LIST = { oneOf: [true, { $ref: '#/$defs/list' }], $defs: { list: { type: 'array', items: { $ref: '#/$defs/list' } } } }
  const nested = (n: number) => JSON.parse('['.repeat(n) + ']'.repeat(n))

  test('depth exhaustion inside oneOf is a limit, not a match decision', async () => {
    expect(ok(LIST)).toEqual([])
    expect(evaluate(LIST, nested(3)).kind).toBe('invalid')
    const deep = evaluate(LIST, nested(300))
    expect(deep.kind).toBe('limit')
    expect(validate(LIST, nested(300)).length).toBeGreaterThan(0)
  })

  test('the reviewer\'s $ref chain is refused before the child starts, and is a limit at run time', async () => {
    const defs: Record<string, unknown> = { n260: {} }
    for (let i = 259; i >= 0; i--) defs[`n${i}`] = { $ref: `#/$defs/n${i + 1}` }
    const chain = { oneOf: [true, { $ref: '#/$defs/n0' }], $defs: defs }
    const pre = ok(chain)
    expect(pre.length).toBe(1)
    expect(pre[0]!.message).toContain('chain')
    expect(evaluate(chain, 42).kind).toBe('limit')
  })
})

describe('work budget (R1-3)', () => {
  // The reviewer's 1,562-byte schema: each level is anyOf of two references
  // to the level below, so a value that fails every branch costs 2^24 checks.
  const dag = () => {
    const $defs: Record<string, unknown> = { n0: { type: 'number' } }
    for (let i = 1; i <= 24; i++) $defs[`n${i}`] = { anyOf: [{ $ref: `#/$defs/n${i - 1}` }, { $ref: `#/$defs/n${i - 1}` }] }
    return { $ref: '#/$defs/n24', $defs }
  }

  test('a schema that expands too far per value is refused before the child starts', async () => {
    const s = dag()
    expect(JSON.stringify(s).length).toBe(1562)
    const pre = ok(s)
    expect(pre.length).toBe(1)
    expect(pre[0]!.message).toContain('expands')
  })

  test('at run time the budget ends the check as a limit; anyOf stops at its first match', async () => {
    const s = dag()
    expect(evaluate(s, 1)).toEqual({ kind: 'valid' })
    expect(evaluate(s, 'x').kind).toBe('limit')
  })

  test('the budget counts every application, across the whole value', async () => {
    const s = { type: 'array', items: {} }
    expect(evaluate(s, Array(100).fill(0), { maxWork: 50 }).kind).toBe('limit')
    expect(evaluate(s, Array(100).fill(0), { maxWork: 1000 }).kind).toBe('valid')
    expect(evaluate({ anyOf: [{}, { allOf: [{}, {}, {}, {}] }] }, 1, { maxWork: 3 }).kind).toBe('valid')
    expect(evaluate({ oneOf: [{}, {}, { allOf: [{}, {}, {}, {}] }] }, 1, { maxWork: 4 }).kind).toBe('invalid')
  })
})

describe('the budget covers comparisons and messages (R2-2)', () => {
  test('a 6,000-value enum against 70,000 invalid items finishes fast with capped issues', async () => {
    const schema = { type: 'array', items: { enum: Array.from({ length: 6000 }, (_, i) => i) } }
    const reply = JSON.stringify(Array(70000).fill(-1))
    expect(JSON.stringify(schema).length).toBe(28925)
    expect(reply.length).toBe(210001)
    expect(ok(schema)).toEqual([])
    const t0 = Date.now()
    const r = evaluate(schema, JSON.parse(reply))
    const ms = Date.now() - t0
    expect(r.kind).toBe('invalid')
    if (r.kind === 'invalid') {
      expect(r.issues.length).toBe(50)
      expect(r.issues[0]!.message.length).toBeLessThan(200)
    }
    expect(ms).toBeLessThan(250)
  })

  test('deep equality is charged per value compared', async () => {
    const big = Array(100).fill(0)
    const copy = (): unknown[] => Array(100).fill(0)
    expect(evaluate({ const: big }, copy(), { maxWork: 50 }).kind).toBe('limit')
    expect(evaluate({ const: big }, copy(), { maxWork: 1000 }).kind).toBe('valid')
    expect(evaluate({ enum: [big] }, copy(), { maxWork: 50 }).kind).toBe('limit')
    expect(evaluate({ enum: [1, big] }, copy(), { maxWork: 1000 }).kind).toBe('valid')
  })

  test('scalar enum members are found without comparing each one', async () => {
    const e = { enum: Array.from({ length: 6000 }, (_, i) => i) }
    // Once the members are indexed, each lookup costs one unit, not 6,000.
    expect(evaluate({ type: 'array', items: e }, Array(1000).fill(5999), { maxWork: 10_000 }).kind).toBe('valid')
    expect(validate(e, '5999').length).toBe(1)
    expect(validate({ enum: [1, true, null, 'a'] }, 1)).toEqual([])
    expect(validate({ enum: [1] }, true).length).toBe(1)
    expect(validate({ enum: [0] }, -0)).toEqual([])
  })

  test('required names are charged', async () => {
    const required = Array.from({ length: 100 }, (_, i) => `p${i}`)
    expect(evaluate({ required }, {}, { maxWork: 50 }).kind).toBe('limit')
    expect(evaluate({ required }, {}, { maxWork: 1000 }).kind).toBe('invalid')
  })
})

describe('string length counts code points (R1-5)', () => {
  test('an astral character is one character', async () => {
    const face = '\u{1F600}'
    expect(face.length).toBe(2)
    expect(paths(validate({ type: 'string', minLength: 2 }, face))).toEqual([''])
    expect(validate({ type: 'string', maxLength: 1 }, face)).toEqual([])
    expect(validate({ minLength: 2, maxLength: 2 }, `a${face}`)).toEqual([])
    expect(paths(validate({ maxLength: 2 }, `${face}${face}x`))).toEqual([''])
    expect(validate({ maxLength: 3 }, `${face}${face}x`)).toEqual([])
  })

  test('a lone surrogate counts as one character', async () => {
    expect(codePointLength('\uD83D')).toBe(1)
    expect(codePointLength('\uDE00\uD83D')).toBe(2)
    expect(codePointLength('a\u{1F600}b')).toBe(3)
    expect(codePointLength('')).toBe(0)
  })
})
