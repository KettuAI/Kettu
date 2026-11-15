import {
  agent,
  methods,
  RequestError,
  type AgentContext,
  type AuthenticateRequest,
  type ClientCapabilities,
  type CreateElicitationResponse,
} from '@agentclientprotocol/sdk/unstable'
import { describe, expect, it } from 'vitest'
import type { ConnectionHooks } from '../connection'
import { AcpConnection, inProcessTransport } from './connection'
import { delegatedSignInStart, requestUrlElicitation } from './sign-in'

// Mistral Vibe 3.0.1's answer to `authenticate` with `action: "start"`.
const VIBE_START = {
  _meta: {
    'browser-auth-delegated': {
      attemptId: 'proc_8f2c',
      expiresAt: '2026-11-15T12:10:00Z',
      signInUrl: 'https://console.mistral.ai/cli-auth?process=proc_8f2c',
    },
  },
}

// Factory Droid 0.251.0's elicitation for its `device-pairing` sign-in.
const DROID_ELICITATION = {
  mode: 'url',
  requestId: 3,
  elicitationId: 'el_42',
  message: 'Sign in to Factory to continue this Droid thread.',
  url: 'https://app.factory.ai/device?code=ABCD-EFGH',
}

describe('sign-in pages from agents', () => {
  it('reads the page and attempt of a delegated start', () => {
    expect(delegatedSignInStart(VIBE_START)).toEqual({
      url: 'https://console.mistral.ai/cli-auth?process=proc_8f2c',
      attemptId: 'proc_8f2c',
    })
    const page = (value: Record<string, unknown>) => ({
      _meta: { 'browser-auth-delegated': value },
    })
    expect(delegatedSignInStart(page({ attemptId: 'a', signInUrl: 'file:///etc/passwd' }))).toBe(
      null,
    )
    expect(delegatedSignInStart(page({ signInUrl: 'https://example.com' }))).toBe(null)
    expect(delegatedSignInStart({})).toBe(null)
    expect(delegatedSignInStart(null)).toBe(null)
  })

  it('takes only a URL elicitation tied to a request, and only a web page', () => {
    expect(requestUrlElicitation(DROID_ELICITATION)).toEqual({
      requestId: '3',
      url: 'https://app.factory.ai/device?code=ABCD-EFGH',
    })
    expect(requestUrlElicitation({ ...DROID_ELICITATION, requestId: 'r-1' })?.requestId).toBe('r-1')
    expect(
      requestUrlElicitation({ ...DROID_ELICITATION, requestId: undefined, sessionId: 's-1' }),
    ).toBe(null)
    expect(requestUrlElicitation({ ...DROID_ELICITATION, url: 'javascript:alert(1)' })).toBe(null)
    expect(
      requestUrlElicitation({ mode: 'form', requestId: 3, message: 'Key?', requestedSchema: {} }),
    ).toBe(null)
  })
})

interface Recorded {
  capabilities: ClientCapabilities
  authenticate: AuthenticateRequest[]
  elicitations: CreateElicitationResponse[]
  cancelled: boolean
}

/** An agent whose `authenticate` runs `signIn`, recording what the client sent it. */
function connect(
  signIn: (ctx: {
    params: AuthenticateRequest
    requestId: string | number | null
    signal: AbortSignal
    client: AgentContext
  }) => Promise<Record<string, unknown>>,
): { connection: AcpConnection; recorded: Recorded } {
  const recorded: Recorded = {
    capabilities: {},
    authenticate: [],
    elicitations: [],
    cancelled: false,
  }
  const app = agent({ name: 'sign-in-test' })
    .onRequest(methods.agent.initialize, (ctx) => {
      recorded.capabilities = ctx.params.clientCapabilities ?? {}
      return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
    })
    .onRequest(methods.agent.authenticate, async (ctx) => {
      recorded.authenticate.push(ctx.params)
      ctx.signal.addEventListener('abort', () => (recorded.cancelled = true), { once: true })
      return signIn({ ...ctx, client: ctx.client })
    })
  const hooks: ConnectionHooks = {
    traffic: () => {},
    account: () => {},
    ignored: () => {},
    log: () => {},
  }
  return { connection: AcpConnection.connect(inProcessTransport(app), hooks), recorded }
}

const until = (done: () => boolean): Promise<void> =>
  new Promise((resolve) => {
    const check = () => (done() ? resolve() : setTimeout(check, 1))
    check()
  })

describe('signing in through the client', () => {
  it('declares the delegated sign-in and URL elicitation', async () => {
    const { connection, recorded } = connect(async () => ({}))
    await connection.initialize('1.0.0')
    expect(recorded.capabilities._meta?.['browser-auth-delegated']).toBe(true)
    expect(recorded.capabilities.elicitation?.url).toEqual({})
    expect(recorded.capabilities.elicitation?.form).toBeUndefined()
    connection.close()
  })

  it('starts a delegated sign-in, hands its page over, then completes it', async () => {
    const opened: string[] = []
    const { connection, recorded } = connect(async ({ params }) => {
      const action = (params._meta as { action?: string }).action
      if (action === 'start') return VIBE_START
      expect(opened).toEqual(['https://console.mistral.ai/cli-auth?process=proc_8f2c'])
      return {
        _meta: { 'browser-auth-delegated': { attemptId: 'proc_8f2c', status: 'completed' } },
      }
    })
    await connection.initialize('1.0.0')
    await connection.authenticate('browser-auth-delegated', {
      openLink: (url) => opened.push(url),
      signal: new AbortController().signal,
    })
    expect(recorded.authenticate).toEqual([
      { methodId: 'browser-auth-delegated', _meta: { action: 'start' } },
      {
        methodId: 'browser-auth-delegated',
        _meta: { action: 'complete', attemptId: 'proc_8f2c' },
      },
    ])
    connection.close()
  })

  it('fails a delegated start that names no page, without opening one', async () => {
    const opened: string[] = []
    const { connection, recorded } = connect(async () => ({ _meta: {} }))
    await connection.initialize('1.0.0')
    await expect(
      connection.authenticate('browser-auth-delegated', {
        openLink: (url) => opened.push(url),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('no sign-in page')
    expect(opened).toEqual([])
    expect(recorded.authenticate).toHaveLength(1)
    connection.close()
  })

  it('cancels the sign-in that waits for the browser', async () => {
    const { connection, recorded } = connect(async ({ params, signal }) => {
      if ((params._meta as { action?: string }).action === 'start') return VIBE_START
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      throw RequestError.requestCancelled()
    })
    await connection.initialize('1.0.0')
    const abort = new AbortController()
    const signIn = connection.authenticate('browser-auth-delegated', {
      openLink: () => abort.abort(),
      signal: abort.signal,
    })
    await expect(signIn).rejects.toThrow()
    await until(() => recorded.cancelled)
    expect(recorded.authenticate.at(-1)?._meta).toEqual({
      action: 'complete',
      attemptId: 'proc_8f2c',
    })
    connection.close()
  })

  it("opens a URL elicitation tied to the sign-in's request and accepts it", async () => {
    const opened: string[] = []
    const { connection, recorded } = connect(async ({ requestId, client }) => {
      const answer = await client.request(methods.client.elicitation.create, {
        ...DROID_ELICITATION,
        requestId,
      })
      recorded.elicitations.push(answer)
      return {}
    })
    await connection.initialize('1.0.0')
    await connection.authenticate('device-pairing', {
      openLink: (url) => opened.push(url),
      signal: new AbortController().signal,
    })
    expect(opened).toEqual(['https://app.factory.ai/device?code=ABCD-EFGH'])
    expect(recorded.elicitations).toEqual([{ action: 'accept' }])
    connection.close()
  })

  it('declines a URL elicitation tied to no sign-in', async () => {
    const opened: string[] = []
    const { connection, recorded } = connect(async ({ client }) => {
      const { mode, elicitationId, message, url } = DROID_ELICITATION
      for (const scope of [{ requestId: 'another-request' }, { sessionId: 'session-1' }]) {
        recorded.elicitations.push(
          await client.request(methods.client.elicitation.create, {
            mode,
            elicitationId,
            message,
            url,
            ...scope,
          }),
        )
      }
      return {}
    })
    await connection.initialize('1.0.0')
    await connection.authenticate('device-pairing', {
      openLink: (url) => opened.push(url),
      signal: new AbortController().signal,
    })
    expect(opened).toEqual([])
    expect(recorded.elicitations).toEqual([{ action: 'decline' }, { action: 'decline' }])
    connection.close()
  })
})
