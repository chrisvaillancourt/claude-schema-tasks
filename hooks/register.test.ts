import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

/** The engine beneath the plugin: what each event answers when the plugin calls next. */
const world = (on: On) => {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
}

const start = ($: any) => $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })

describe('schema-tasks', () => {
  test('counts main-loop turns and ignores subagent turns', async ($, on) => {
    world(on)
    await start($)
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.start({ text: 'sub', turnId: 's1', agentId: 'a1' })

    const status = await $.command.run({ command: 'schema-tasks', args: 'status', ...COMMAND })
    expect(status.text).toContain('1 main turns seen')
  })

  test('/schema-tasks off stops counting for the session', async ($, on) => {
    world(on)
    await start($)
    const off = await $.command.run({ command: 'schema-tasks', args: 'off', ...COMMAND })
    expect(off.text).toContain('off (set for this session)')

    await $.turn.start({ text: 'hi', turnId: 't1' })
    const status = await $.command.run({ command: 'schema-tasks', args: '', ...COMMAND })
    expect(status.text).toContain('0 main turns seen')
  })

  test('an unknown argument answers with usage', async ($, on) => {
    world(on)
    await start($)
    const res = await $.command.run({ command: 'schema-tasks', args: 'bogus', ...COMMAND })
    expect(res.text).toContain('Usage: /schema-tasks')
  })
})
