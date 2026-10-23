// Integration tests: what the hidden sessions send, through the host and its port, against the
// fake agent running in-process. The fake agent stands in for Claude Code.

import { afterEach, describe, expect, it } from 'vitest'
import { hiddenSessionMeta } from './reports'
import { startTestHost, type TestHost } from './testing/harness'

let current: TestHost | null = null

afterEach(async () => {
  await current?.stop()
  current = null
})

async function setup() {
  current = await startTestHost()
  const port = current.connect()
  return { t: current, port }
}

/** The `_meta` of every request of `method` the host sent the fake agent, in order. */
function sent(t: TestHost, method: string): unknown[] {
  return t.host.diagnostics
    .agentRecords('fake-agent')
    .traffic.filter((r) => r.direction === 'out' && r.method === method)
    .map((r) => (r.message as { params: { _meta?: unknown } }).params._meta)
}

const HIDDEN = {
  claudeCode: { options: { persistSession: false, settings: { disableAllHooks: true } } },
}

describe('hidden sessions', () => {
  it("read the options without the user's hooks or a transcript", async () => {
    const { t, port } = await setup()
    await port.request('agents.start', { agentId: 'fake-agent' })
    expect(sent(t, 'session/new')).toEqual([HIDDEN])
  })

  it("read the plan limits without the user's hooks or a transcript", async () => {
    const { t, port } = await setup()
    await port.request('agents.refreshLimits', { agentId: 'fake-agent' })
    expect(sent(t, 'session/new')).toEqual([HIDDEN])
  })

  it("fork for /context with the session's settings but without its hooks", async () => {
    const { t, port } = await setup()
    const summary = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
      options: { __ultracode: true },
    })
    await port.open(summary.id)
    await port.request('sessions.prompt', {
      sessionId: summary.id,
      content: [{ type: 'text', text: 'Fix the flaky login test' }],
    })
    await port.untilStatus(summary.id, 'ready')
    expect(await port.request('sessions.context', { sessionId: summary.id })).not.toBeNull()

    const own = { claudeCode: { options: { settings: { ultracode: true } } } }
    expect(sent(t, 'session/new').at(-1)).toEqual(own)
    expect(sent(t, 'session/fork')).toEqual([
      {
        claudeCode: {
          options: { persistSession: false, settings: { ultracode: true, disableAllHooks: true } },
        },
      },
    ])
  })

  it('leave the meta of agents other than Claude Code as it was', () => {
    expect(hiddenSessionMeta('codex')).toBeUndefined()
    expect(hiddenSessionMeta('opencode', { other: 1 })).toEqual({ other: 1 })
  })
})
