export type Mode = 'on' | 'off'

/** The options in plugin.json's userConfig, parsed with defaults filled in. */
export type Config = {
  enabled: boolean
}

/** What the mod keeps for the session. Lives in $.state, so it survives a hot reload. */
export type Session = {
  /** A /schema-tasks on|off override for this session; null follows the `enabled` option. */
  mode: Mode | null
  /** Main-loop turns seen this session. */
  turns: number
}

declare module 'claude-code' {
  interface PluginState {
    'schema-tasks': { session: Shaped<Session> }
  }
}
