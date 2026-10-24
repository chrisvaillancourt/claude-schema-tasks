import { describe, expect, test } from 'claude-code/testing'

import { INITIAL, configFrom, isActive, parseArgs, statusText } from './policy'

describe('policy', () => {
  test('parseArgs reads on, off, status and rejects the rest', async () => {
    expect(parseArgs('')).toEqual({ kind: 'status' })
    expect(parseArgs(' ON ')).toEqual({ kind: 'set', mode: 'on' })
    expect(parseArgs('off')).toEqual({ kind: 'set', mode: 'off' })
    expect(parseArgs('bogus')).toEqual({ kind: 'help', error: 'Unknown argument: bogus' })
  })

  test('a session override beats the enabled option', async () => {
    expect(isActive(configFrom({}), INITIAL)).toBe(true)
    expect(isActive(configFrom({ enabled: false }), INITIAL)).toBe(false)
    expect(isActive(configFrom({ enabled: false }), { ...INITIAL, mode: 'on' })).toBe(true)
    expect(isActive(configFrom({}), { ...INITIAL, mode: 'off' })).toBe(false)
  })

  test('statusText says where the state comes from', async () => {
    expect(statusText(configFrom({}), INITIAL)).toContain('from the enabled option')
    expect(statusText(configFrom({}), { mode: 'off', turns: 2 })).toBe('off (set for this session); 2 main turns seen.')
  })
})
