// Pure decisions: no `$`, no I/O. Put the mod's rules here and unit-test them
// in policy.test.ts; register.ts only wires them to events.
import type { Config, Mode, Session } from '../types'

export const INITIAL: Session = { mode: null, turns: 0 }

export function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export function configFrom(options: Record<string, unknown>): Config {
  return { enabled: options.enabled !== false }
}

export function isActive(config: Config, session: Session): boolean {
  return session.mode === null ? config.enabled : session.mode === 'on'
}

export type Command = { kind: 'set'; mode: Mode } | { kind: 'status' } | { kind: 'help'; error?: string }

export function parseArgs(args: string): Command {
  const word = args.trim().toLowerCase()
  if (word === '' || word === 'status') return { kind: 'status' }
  if (word === 'on' || word === 'off') return { kind: 'set', mode: word }
  if (word === 'help') return { kind: 'help' }
  return { kind: 'help', error: `Unknown argument: ${args.trim()}` }
}

export const USAGE = 'Usage: /schema-tasks [on|off|status]'

export function statusText(config: Config, session: Session): string {
  const state = isActive(config, session) ? 'on' : 'off'
  const source = session.mode === null ? 'from the enabled option' : 'set for this session'
  return `${state} (${source}); ${session.turns} main turns seen.`
}
