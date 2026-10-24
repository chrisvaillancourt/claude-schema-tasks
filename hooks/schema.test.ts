import { describe, expect, test } from 'claude-code/testing'

import { checkSchema, roundTrips, validate } from './schema'

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
    expect(validate(one, 2)[0]!.message).toContain('2 of')
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
