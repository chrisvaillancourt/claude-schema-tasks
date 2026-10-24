export type Mode = 'on' | 'off'

/** The options in plugin.json's userConfig, parsed with defaults filled in and clamped. */
export type Config = {
  enabled: boolean
  /** Times an invalid reply is sent back, 0 to 5. */
  maxRepairs: number
  /** Largest schema accepted, as JSON text, in UTF-8 bytes. */
  maxSchemaBytes: number
  /** Largest reply accepted, in UTF-8 bytes. */
  maxResultBytes: number
}

/** What the mod keeps for the session. Lives in $.state, so it survives a hot reload. */
export type Session = {
  /** A /schema-tasks on|off override for this session; null follows the `enabled` option. */
  mode: Mode | null
}

/** One problem with a schema or a reply, at a JSON Pointer path ('' is the root). */
export type Issue = { path: string; message: string }

/** Where a contract stands; `valid`, `failed` and `cancelled` are final. */
export type Phase = 'starting' | 'running' | 'valid' | 'failed' | 'cancelled'

export type FailureCode =
  | 'repairs-exhausted'
  | 'final-invalid'
  /** The validator hit a depth or work limit: the answer could not be checked. */
  | 'validation-limit'
  | 'handback-withheld'
  | 'aborted'
  | 'refusal'
  | 'error'
  | 'agent-error'
  | 'spawn-refused'
  | 'disabled'

export type Failure = { code: FailureCode; message: string; issues: Issue[] }

/** Which repair gate saw the child's reply last. */
export type Gate = 'handback' | 'stop'

/** One structured delegation: an Agent call whose prompt was an envelope. JSON only. */
export type Contract = {
  /** The Agent call's tool_use_id. */
  id: string
  /** The loop that made the Agent call; null for the main loop. */
  parentAgentId: string | null
  /** The child's agent id once its spawn resolved. */
  agentId: string | null
  description: string
  task: string
  schema: unknown
  /** Limits frozen when the contract opened. */
  maxRepairs: number
  maxResultBytes: number
  repairsUsed: number
  phase: Phase
  background: boolean
  /** The gate that last checked a reply, null while none has. */
  gate: Gate | null
  /** True once a gate saw a valid reply (recorded, not final). */
  gatePassed: boolean
  /** The validated JSON, set only in phase `valid`. */
  hasData: boolean
  data: unknown
  failure: Failure | null
  /** Problems from the last check that failed. */
  lastIssues: Issue[]
}

declare module 'claude-code' {
  interface PluginState {
    'schema-tasks': { session: Shaped<Session>; contracts: Shaped<Contract[]> }
  }
}
