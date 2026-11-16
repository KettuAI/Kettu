// Gemini CLI 0.66.0 on a personal Google account, which Google moved to Antigravity: its refusal
// is no sign-in to ask for again, and Kettu names the way out instead.

import { agent, methods, RequestError } from '@agentclientprotocol/sdk/unstable'
import { describe, expect, it } from 'vitest'
import { GEMINI } from '../agents/gemini'
import { AgentRequestError, type ConnectionHooks } from '../connection'
import { AcpConnection, inProcessTransport } from './connection'
import recorded from './fixtures/gemini-moved-account.json'

function connect(moved: boolean) {
  const refuse = (answer: { code: number; message: string }) => {
    throw new RequestError(answer.code, answer.message)
  }
  const app = agent({ name: 'gemini-test' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: 'gemini-cli', version: '0.66.0' },
      authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
    }))
    .onRequest(methods.agent.authenticate, () => refuse(recorded.authenticate.error))
    .onRequest(methods.agent.session.new, () => refuse(recorded['session/new'].error))
  let refusals = 0
  const hooks: ConnectionHooks = {
    traffic: () => {},
    account: () => {},
    ignored: () => {},
    log: () => {},
    accountRefused: () => refusals++,
  }
  const connection = AcpConnection.connect(inProcessTransport(app), {
    ...hooks,
    agentId: 'gemini',
    name: 'Gemini CLI',
    ...(moved ? { movedAccounts: GEMINI.movedAccounts } : {}),
  })
  return { connection, refusals: () => refusals }
}

async function failure(run: () => Promise<unknown>): Promise<AgentRequestError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRequestError)
    return error as AgentRequestError
  }
  throw new Error('expected the request to fail')
}

describe('Gemini CLI on a moved personal account', () => {
  it('turns the refusal of a sign-in and of a session into the way to Antigravity', async () => {
    const { connection, refusals } = connect(true)
    await connection.initialize('1.0.0')

    for (const run of [
      () => connection.authenticate('oauth-personal'),
      () => connection.newSession('/tmp/gemini', { mcpServers: [] }),
    ]) {
      const error = await failure(run)
      // Not auth_required, which would ask for the same sign-in again.
      expect(error.kind).toBe('agent_error')
      expect(error.code).toBe(-32000)
      expect(error.message).toMatch(/Google Antigravity/)
      expect(error.data).toEqual({
        movedTo: 'antigravity',
        refusal: recorded.authenticate.error.message,
      })
    }
    expect(refusals()).toBe(2)
    connection.close()
  })

  it('keeps an agent without moved accounts asking for its sign-in', async () => {
    const { connection, refusals } = connect(false)
    await connection.initialize('1.0.0')
    const error = await failure(() => connection.authenticate('oauth-personal'))
    expect(error.kind).toBe('auth_required')
    expect(error.message).toBe(recorded.authenticate.error.message)
    expect(refusals()).toBe(0)
    connection.close()
  })

  it('leaves other sign-in failures alone', async () => {
    expect(GEMINI.movedAccounts?.refusal.test('Failed to login. Message: invalid_grant')).toBe(
      false,
    )
  })
})
