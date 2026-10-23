// The connection's routing of session updates, against the fake agent in-process.

import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { loadFakeAgent } from '../testing/harness'
import { AgentConnection, inProcessTransport, type SessionTarget } from './connection'

describe('AgentConnection', () => {
  it('drops the buffered updates of a session it unregisters before any target took them', async () => {
    const module = await loadFakeAgent()
    const app = module.createFakeAgent({ env: { FAKE_AGENT_DELAY_SCALE: '0' } })
    const connection = AgentConnection.connect(inProcessTransport(app), {
      traffic: () => {},
      account: () => {},
      ignored: () => {},
      log: () => {},
    })
    await connection.initialize('0.0.0-test')
    const { acpSessionId } = await connection.newSession(os.tmpdir())
    // The agent announces its commands right after it answers, before anyone registers.
    await new Promise((resolve) => setTimeout(resolve, 50))
    connection.unregister(acpSessionId)
    const applied: unknown[] = []
    const target: SessionTarget = {
      context: () => {
        throw new Error('no update should reach the target')
      },
      apply: (output) => applied.push(output),
      requestPermission: () => Promise.resolve('cancelled'),
    }
    connection.register(acpSessionId, target)
    expect(applied).toEqual([])
    connection.close()
  })
})
