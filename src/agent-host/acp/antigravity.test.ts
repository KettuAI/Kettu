// agy 1.5.9's ACP mode as Kettu reads it: what it takes without declaring, its plan, its titles and
// its hidden sessions, which may be opened and closed but never prompted.

import { agent, methods } from '@agentclientprotocol/sdk/unstable'
import { describe, expect, it } from 'vitest'
import type { ConnectionHooks } from '../connection'
import { AcpConnection, inProcessTransport } from './connection'

const TIER = { name: 'Google AI Pro', id: 'g1-pro-tier', upgradeUri: 'https://example.com' }

function connect(version: string) {
  const prompted: string[] = []
  const closed: string[] = []
  const accounts: string[] = []
  let next = 0
  const app = agent({ name: 'agy-test' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} },
        auth: { logout: {} },
        _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
      },
      agentInfo: { name: 'Antigravity ACP Server', version },
      authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
    }))
    .onRequest(methods.agent.session.new, () => ({
      sessionId: `s-${++next}`,
      _meta: { antigravity: { tier: TIER } },
    }))
    .onRequest(methods.agent.session.prompt, (ctx) => {
      prompted.push(ctx.params.sessionId)
      return { stopReason: 'end_turn' as const }
    })
    .onRequest(methods.agent.session.close, (ctx) => {
      closed.push(ctx.params.sessionId)
      return {}
    })
  const hooks: ConnectionHooks = {
    traffic: () => {},
    account: (account) => accounts.push(account.label ?? ''),
    ignored: () => {},
    log: () => {},
  }
  const connection = AcpConnection.connect(inProcessTransport(app), {
    ...hooks,
    agentId: 'antigravity',
    name: 'Google Antigravity',
  })
  return { connection, prompted, closed, accounts }
}

describe("agy's ACP mode", () => {
  it('takes HTTP MCP servers, titles its sessions and names its plan from 1.5.9', async () => {
    const { connection, accounts } = connect('1.5.9')
    const init = await connection.initialize('1.0.0')
    expect(init.capabilities.mcpHttp).toBe(true)
    expect(init.capabilities.ownTitles).toBe('sent')
    await connection.newSession('/repo')
    expect(accounts).toEqual(['Google AI Pro'])
    connection.close()
  })

  it('reads none of it on an earlier version', async () => {
    const { connection, accounts } = connect('1.4.3')
    const init = await connection.initialize('1.0.0')
    expect(init.capabilities.mcpHttp).toBe(false)
    expect(init.capabilities.ownTitles).toBeNull()
    expect(connection.unpromptedSessions).toBe(false)
    await connection.newSession('/repo')
    expect(accounts).toEqual([])
    connection.close()
  })

  it('opens and closes hidden sessions to read, and refuses to prompt one', async () => {
    const { connection, prompted, closed } = connect('1.5.9')
    await connection.initialize('1.0.0')
    expect(connection.unpromptedSessions).toBe(true)
    // No hidden session that is prompted: reports, titles and summaries skip it.
    expect(connection.hiddenSessions).toBe(false)

    const hidden = await connection.newSession('/tmp', { hidden: 'options' })
    await expect(
      connection.prompt(hidden.sessionId, [{ type: 'text', text: 'hi' }]),
    ).rejects.toThrow(/never prompted/)
    await expect(connection.collect(hidden.sessionId, '/usage')).rejects.toThrow(/never prompted/)
    expect(prompted).toEqual([])
    await connection.removeHidden(hidden.sessionId, () => {})
    expect(closed).toEqual([hidden.sessionId])

    // A session the user sees is prompted as usual.
    const shown = await connection.newSession('/repo')
    await connection.prompt(shown.sessionId, [{ type: 'text', text: 'hi' }])
    expect(prompted).toEqual([shown.sessionId])
    connection.close()
  })
})
