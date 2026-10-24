// A JSON Schema subset, checked before a child starts and applied to its
// reply. Pure: no `$`, no eval, no RegExp from schema text. Every lookup keyed
// by schema or data text goes through Object.hasOwn (the sandbox treats
// `__proto__` as an ordinary key).

export type Issue = { path: string; message: string }
export type SchemaLimits = { maxBytes: number; maxDepth: number; maxNodes: number }

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const ANNOTATIONS = new Set([
  '$schema', '$comment', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
])
const NUMBER_KEYS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'])
const COUNT_KEYS = new Set(['minLength', 'maxLength', 'minItems', 'maxItems'])
const LIST_KEYS = new Set(['anyOf', 'oneOf', 'allOf'])
const DEF_KEYS = new Set(['$defs', 'definitions'])

/** Validation stops descending past this many nested applications. */
const MAX_APPLY_DEPTH = 256
/** At most this many issues are collected. */
const MAX_ISSUES = 50

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1')
}

function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}

export function utf8Length(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4
        i++
      } else n += 3
    } else n += 3
  }
  return n
}

function jsonDepth(v: unknown, depth = 1): number {
  if (Array.isArray(v)) return v.reduce<number>((m, x) => Math.max(m, jsonDepth(x, depth + 1)), depth)
  if (isObject(v)) return Object.keys(v).reduce<number>((m, k) => Math.max(m, jsonDepth(v[k], depth + 1)), depth)
  return depth
}

const isCount = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0

type Walk = { nodes: Map<string, unknown>; refs: { at: string; ref: string }[]; inPlace: Map<string, string[]>; issues: Issue[] }

function walk(schema: unknown, at: string, w: Walk) {
  w.nodes.set(at, schema)
  if (typeof schema === 'boolean') return
  if (!isObject(schema)) {
    w.issues.push({ path: at, message: 'a subschema must be an object or a boolean' })
    return
  }
  const inPlace: string[] = []
  for (const key of Object.keys(schema)) {
    const v = schema[key]
    const here = `${at}/${escapePointer(key)}`
    if (ANNOTATIONS.has(key)) continue
    if (key === 'type') {
      const list = Array.isArray(v) ? v : [v]
      if (list.length === 0 || !list.every(t => typeof t === 'string' && TYPES.has(t))) {
        w.issues.push({ path: here, message: `type must be one of ${[...TYPES].join(', ')}, or a list of them` })
      }
    } else if (key === 'properties' || DEF_KEYS.has(key)) {
      if (!isObject(v)) w.issues.push({ path: here, message: `${key} must be an object of schemas` })
      else for (const name of Object.keys(v)) walk(v[name], `${here}/${escapePointer(name)}`, w)
    } else if (key === 'required') {
      if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) w.issues.push({ path: here, message: 'required must be a list of property names' })
    } else if (key === 'additionalProperties') {
      walk(v, here, w)
    } else if (key === 'items') {
      if (Array.isArray(v)) w.issues.push({ path: here, message: 'items must be one schema; tuple items are not supported' })
      else walk(v, here, w)
    } else if (key === 'enum') {
      if (!Array.isArray(v) || v.length === 0) w.issues.push({ path: here, message: 'enum must be a non-empty list' })
    } else if (key === 'const') {
      // any JSON value
    } else if (NUMBER_KEYS.has(key)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) w.issues.push({ path: here, message: `${key} must be a number` })
    } else if (COUNT_KEYS.has(key)) {
      if (!isCount(v)) w.issues.push({ path: here, message: `${key} must be a non-negative integer` })
    } else if (LIST_KEYS.has(key)) {
      if (!Array.isArray(v) || v.length === 0) w.issues.push({ path: here, message: `${key} must be a non-empty list of schemas` })
      else
        v.forEach((sub, i) => {
          walk(sub, `${here}/${i}`, w)
          inPlace.push(`${here}/${i}`)
        })
    } else if (key === '$ref') {
      if (typeof v !== 'string' || !(v === '#' || v.startsWith('#/'))) {
        w.issues.push({ path: here, message: '$ref must point into this schema (#, #/$defs/name); remote references are not supported' })
      } else w.refs.push({ at: here, ref: v })
    } else {
      w.issues.push({ path: here, message: `keyword "${key}" is not supported by schema-tasks` })
    }
  }
  w.inPlace.set(at, inPlace)
}

/** The pointer a local `$ref` names, or null when it is not a usable pointer. */
function refTarget(ref: string): string | null {
  if (ref === '#') return ''
  if (ref.includes('%')) return null
  return '/' + ref.slice(2).split('/').map(unescapePointer).map(escapePointer).join('/')
}

/**
 * Refuses a schema schema-tasks can't apply exactly: anything outside the
 * subset, an unresolved reference, an in-place loop, or one over the limits.
 * An empty list means the schema is usable.
 */
export function checkSchema(schema: unknown, limits: SchemaLimits): Issue[] {
  if (!isObject(schema)) return [{ path: '', message: 'the schema must be a JSON object' }]
  const bytes = utf8Length(JSON.stringify(schema))
  if (bytes > limits.maxBytes) return [{ path: '', message: `the schema is ${bytes} bytes; the limit is ${limits.maxBytes} bytes` }]
  if (jsonDepth(schema) > limits.maxDepth) return [{ path: '', message: `the schema is nested too deep (limit ${limits.maxDepth} levels)` }]

  const w: Walk = { nodes: new Map(), refs: [], inPlace: new Map(), issues: [] }
  walk(schema, '', w)
  if (w.nodes.size > limits.maxNodes) return [{ path: '', message: `the schema has ${w.nodes.size} subschemas; the limit is ${limits.maxNodes}` }]

  for (const { at, ref } of w.refs) {
    const target = refTarget(ref)
    if (target === null || !w.nodes.has(target)) {
      w.issues.push({ path: at, message: `$ref "${ref}" does not name a subschema of this schema` })
      continue
    }
    const owner = at.slice(0, at.lastIndexOf('/'))
    w.inPlace.get(owner)?.push(target)
  }
  if (w.issues.length > 0) return w.issues

  // An in-place edge ($ref, allOf/anyOf/oneOf) applies a schema to the same
  // value; a cycle of them would never finish.
  const state = new Map<string, 1 | 2>()
  const visit = (node: string): string | null => {
    state.set(node, 1)
    for (const next of w.inPlace.get(node) ?? []) {
      const s = state.get(next)
      if (s === 1) return next
      if (s === undefined) {
        const found = visit(next)
        if (found !== null) return found
      }
    }
    state.set(node, 2)
    return null
  }
  for (const node of w.nodes.keys()) {
    if (state.has(node)) continue
    const found = visit(node)
    if (found !== null) return [{ path: found, message: 'the schema has a $ref/allOf/anyOf/oneOf loop that never moves into the data' }]
  }
  return []
}

function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function hasType(v: unknown, t: string): boolean {
  switch (t) {
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v)
    case 'number':
      return typeof v === 'number'
    default:
      return typeOf(v) === t
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
  }
  return false
}

const show = (v: unknown) => {
  const s = JSON.stringify(v) ?? String(v)
  return s.length > 60 ? `${s.slice(0, 57)}...` : s
}

type Ctx = { root: unknown; issues: Issue[]; depth: number }

function resolve(root: unknown, ref: string): unknown {
  const target = refTarget(ref)
  if (target === null) return false
  let node: unknown = root
  for (const seg of target.split('/').slice(1).map(unescapePointer)) {
    if (Array.isArray(node)) node = node[Number(seg)]
    else if (isObject(node) && Object.hasOwn(node, seg)) node = node[seg]
    else return false
  }
  return node
}

function apply(schema: unknown, value: unknown, path: string, ctx: Ctx) {
  const add = (message: string, at = path) => {
    if (ctx.issues.length < MAX_ISSUES) ctx.issues.push({ path: at, message })
  }
  if (schema === true) return
  if (schema === false) return add('no value is allowed here')
  if (!isObject(schema)) return add('schema error: subschema is not an object')
  if (ctx.depth > MAX_APPLY_DEPTH) return add('the value is nested too deep to check')
  ctx.depth++
  try {
    const has = (k: string) => Object.hasOwn(schema, k)
    if (has('$ref')) apply(resolve(ctx.root, String(schema.$ref)), value, path, ctx)
    if (has('type')) {
      const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[]
      if (!types.some(t => hasType(value, t))) add(`must be ${types.join(' or ')}, got ${typeOf(value)}`)
    }
    if (has('enum') && !(schema.enum as unknown[]).some(x => deepEqual(x, value))) {
      add(`must be one of ${(schema.enum as unknown[]).map(show).join(', ')}`)
    }
    if (has('const') && !deepEqual(schema.const, value)) add(`must be ${show(schema.const)}`)

    if (typeof value === 'number') {
      if (has('minimum') && value < (schema.minimum as number)) add(`must be >= ${schema.minimum}`)
      if (has('maximum') && value > (schema.maximum as number)) add(`must be <= ${schema.maximum}`)
      if (has('exclusiveMinimum') && value <= (schema.exclusiveMinimum as number)) add(`must be > ${schema.exclusiveMinimum}`)
      if (has('exclusiveMaximum') && value >= (schema.exclusiveMaximum as number)) add(`must be < ${schema.exclusiveMaximum}`)
    }
    if (typeof value === 'string') {
      if (has('minLength') && value.length < (schema.minLength as number)) add(`must be at least ${schema.minLength} characters`)
      if (has('maxLength') && value.length > (schema.maxLength as number)) add(`must be at most ${schema.maxLength} characters`)
    }
    if (Array.isArray(value)) {
      if (has('minItems') && value.length < (schema.minItems as number)) add(`must have at least ${schema.minItems} items`)
      if (has('maxItems') && value.length > (schema.maxItems as number)) add(`must have at most ${schema.maxItems} items`)
      if (has('items')) value.forEach((item, i) => apply(schema.items, item, `${path}/${i}`, ctx))
    }
    if (isObject(value)) {
      const props = has('properties') ? (schema.properties as Record<string, unknown>) : {}
      if (has('required')) {
        for (const name of schema.required as string[]) {
          if (!Object.hasOwn(value, name)) add(`missing required property "${name}"`)
        }
      }
      for (const key of Object.keys(value)) {
        const at = `${path}/${escapePointer(key)}`
        if (Object.hasOwn(props, key)) apply(props[key], value[key], at, ctx)
        else if (has('additionalProperties')) {
          if (schema.additionalProperties === false) add(`property "${key}" is not allowed`, at)
          else apply(schema.additionalProperties, value[key], at, ctx)
        }
      }
    }
    if (has('allOf')) for (const sub of schema.allOf as unknown[]) apply(sub, value, path, ctx)
    if (has('anyOf') || has('oneOf')) {
      const matches = (list: unknown[]) =>
        list.filter(sub => {
          const probe: Ctx = { root: ctx.root, issues: [], depth: ctx.depth }
          apply(sub, value, path, probe)
          return probe.issues.length === 0
        }).length
      if (has('anyOf') && matches(schema.anyOf as unknown[]) === 0) {
        add(`must match at least one of the ${(schema.anyOf as unknown[]).length} anyOf options`)
      }
      if (has('oneOf')) {
        const n = matches(schema.oneOf as unknown[])
        if (n !== 1) add(`must match exactly one oneOf option; matches ${n} of ${(schema.oneOf as unknown[]).length}`)
      }
    }
  } finally {
    ctx.depth--
  }
}

/**
 * Every way `value` breaks `schema` (at most 50), each with a JSON Pointer
 * path; empty when it validates. Assumes `checkSchema` passed.
 */
export function validate(schema: unknown, value: unknown): Issue[] {
  const ctx: Ctx = { root: schema, issues: [], depth: 0 }
  apply(schema, value, '', ctx)
  return ctx.issues
}
