import { describe, expect, it, vi } from 'vitest'
import type { ProgramOptions, ProgramRun } from '../adapter-install'
import { TextRing } from '../ring'
import { OpenCodeClient } from './client'

function run(stdout = '', code: number | null = 0, stderr = ''): ProgramRun {
  const output = new TextRing(4096)
  output.push(stderr)
  return { code, signal: null, timedOut: false, aborted: false, output, stdout }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function list(data: unknown[]): string {
  return JSON.stringify({ location: { directory: '/tmp' }, data })
}

interface Routes {
  integrations: unknown[]
  native?: ProgramRun
  credentials?: unknown[]
  import?: ProgramRun
}

function runner(routes: Routes): {
  run: (options: ProgramOptions) => Promise<ProgramRun>
  calls: ProgramOptions[]
} {
  const calls: ProgramOptions[] = []
  return {
    calls,
    run: async (options) => {
      calls.push(options)
      const [command, method, path] = options.args
      if (command === 'api' && method === 'get' && path === '/api/integration') {
        return run(list(routes.integrations))
      }
      if (command === 'api' && method === 'get' && path === '/api/experimental/usage/limits') {
        return routes.native ?? run('', 1, 'HTTP 404 Not Found\n')
      }
      if (command === 'api' && method === 'get' && path === '/api/credential') {
        if (!routes.credentials) return run('', 1, 'HTTP 500\n')
        return run(JSON.stringify({ data: routes.credentials }))
      }
      if (command === 'auth' && method === 'import') {
        return routes.import ?? run('', 0, 'Imported 1 credential\n')
      }
      if (command === 'api' && method === 'post' && path?.endsWith('/activate')) {
        return run()
      }
      throw new Error(`unexpected ${options.args.join(' ')}`)
    },
  }
}

type FetchRoute = (url: string, init: RequestInit) => Response | Promise<Response>

function fetcher(routes: Record<string, FetchRoute>): {
  fetch: typeof globalThis.fetch
  calls: { url: string; init: RequestInit }[]
} {
  const calls: { url: string; init: RequestInit }[] = []
  const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    for (const [prefix, answer] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return await answer(url, init ?? {})
    }
    throw new TypeError(`no route for ${url}`)
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const OAUTH = { id: 'device', type: 'oauth', label: 'OpenCode Console account' }
const KEY = { type: 'key' }
const ENV = (name: string): unknown => ({ type: 'env', names: [name] })

const OPENCODE = {
  id: 'opencode',
  name: 'OpenCode Console',
  methods: [OAUTH],
  connections: [{ type: 'credential', id: 'cred_oc', label: 'Personal', method: 'oauth' }],
}
const OPENCODE_GO = {
  id: 'opencode-go',
  name: 'OpenCode Go',
  methods: [KEY, ENV('OPENCODE_API_KEY')],
  connections: [{ type: 'env', name: 'OPENCODE_API_KEY' }],
}
const DEEPSEEK = {
  id: 'deepseek',
  name: 'DeepSeek',
  methods: [KEY, ENV('DEEPSEEK_API_KEY')],
  connections: [{ type: 'env', name: 'DEEPSEEK_API_KEY' }],
}
const OPENROUTER = {
  id: 'openrouter',
  name: 'OpenRouter',
  methods: [KEY],
  connections: [{ type: 'credential', id: 'cred_or', label: 'Work', method: 'key' }],
}

describe('OpenCodeClient.providers', () => {
  it('lists integrations with their methods and safe connections', async () => {
    const routes = runner({
      integrations: [
        OPENCODE,
        OPENCODE_GO,
        DEEPSEEK,
        {
          id: 'unknown',
          name: 'Unknown',
          methods: [ENV('UNKNOWN_KEY')],
          connections: [
            {
              type: 'env',
              name: 'UNKNOWN_KEY',
              status: { status: 'needs_auth', message: 'Sign in again' },
            },
          ],
        },
        { id: 'moonshotai', name: 'Moonshot AI', methods: [KEY], connections: [] },
      ],
      native: run(JSON.stringify({ location: { directory: '/tmp' }, data: null })),
    })
    const { fetch } = fetcher({
      'https://opencode.ai/zen/go/v1/usage': () =>
        json({
          usage: {
            rolling: { status: 'ok', percent: 10, resetsAt: '2026-11-03T12:00:00Z' },
            weekly: { status: 'ok', percent: 20, resetsAt: '2026-11-10T00:00:00Z' },
            monthly: { status: 'ok', percent: 30, resetsAt: '2026-12-01T00:00:00Z' },
          },
        }),
      'https://api.deepseek.com/user/balance': () =>
        json({ balance_infos: [{ currency: 'CNY', total_balance: 9.5 }] }),
    })
    const client = new OpenCodeClient({
      program: '/bin/opencode',
      env: { OPENCODE_API_KEY: 'go-secret', DEEPSEEK_API_KEY: 'deep-secret' },
      platform: 'darwin',
      runProgram: routes.run,
      fetch,
      now: () => 100,
    })
    const providers = await client.providers()
    expect(providers.map((provider) => provider.id)).toEqual([
      'opencode',
      'opencode-go',
      'deepseek',
      'unknown',
      'moonshotai',
    ])
    for (const provider of providers) expect(provider.loginCommand).toBe('')
    expect(providers[0]).toMatchObject({
      name: 'OpenCode Console',
      methods: [{ type: 'oauth', label: 'OpenCode Console account' }],
      accounts: [{ id: 'cred_oc', label: 'Personal', method: 'oauth', needsAuth: false }],
      usage: { state: 'unsupported', observedAt: 100, error: null },
    })
    expect(providers[1]?.methods).toEqual([
      { type: 'key', label: 'API key' },
      { type: 'env', label: 'OPENCODE_API_KEY' },
    ])
    expect(providers[1]?.accounts).toEqual([
      { id: null, label: 'OPENCODE_API_KEY', method: 'env', needsAuth: false },
    ])
    expect(providers[1]?.usage).toMatchObject({ state: 'ready', observedAt: 100 })
    expect(providers[2]?.usage).toEqual({
      state: 'ready',
      limits: [],
      balances: [{ label: 'Balance', amount: 9.5, currency: 'CNY' }],
      observedAt: 100,
      error: null,
    })
    expect(providers[3]?.accounts[0]?.needsAuth).toBe(true)
    expect(providers[3]?.usage).toEqual({
      state: 'unsupported',
      limits: [],
      balances: [],
      observedAt: 100,
      error: null,
    })
    expect(providers[4]?.usage).toBeNull()
    expect(JSON.stringify(providers)).not.toContain('go-secret')
    expect(JSON.stringify(providers)).not.toContain('deep-secret')
    expect(routes.calls.map((call) => call.args)).toContainEqual(['api', 'get', '/api/integration'])
    expect(routes.calls.map((call) => call.args)).toContainEqual([
      'api',
      'get',
      '/api/experimental/usage/limits',
    ])
    expect(routes.calls.map((call) => call.args)).not.toContainEqual([
      'api',
      'get',
      '/api/credential',
    ])
  })

  it('reads the active credential only when a provider endpoint needs it', async () => {
    const routes = runner({
      integrations: [OPENROUTER],
      credentials: [
        {
          id: 'cred_old',
          integrationID: 'openrouter',
          label: 'Old',
          active: false,
          value: { type: 'key', key: 'sk-old-secret' },
        },
        {
          id: 'cred_or',
          integrationID: 'openrouter',
          label: 'Work',
          active: true,
          value: { type: 'key', key: 'sk-active-secret' },
        },
      ],
    })
    const { fetch, calls } = fetcher({
      'https://openrouter.ai/api/v1/credits': () =>
        json({ data: { total_credits: 5, total_usage: 1 } }),
    })
    const client = new OpenCodeClient({
      program: '/bin/opencode',
      env: {},
      platform: 'darwin',
      runProgram: routes.run,
      fetch,
      now: () => 1,
    })
    const providers = await client.providers()
    expect(providers[0]?.usage).toMatchObject({
      state: 'ready',
      balances: [{ label: 'Balance', amount: 4, currency: 'USD' }],
    })
    expect(providers[0]?.accounts[0]).toEqual({
      id: 'cred_or',
      label: 'Work',
      method: 'key',
      needsAuth: false,
      active: true,
    })
    expect(calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer sk-active-secret' })
    expect(routes.calls.map((call) => call.args)).toContainEqual(['api', 'get', '/api/credential'])
    expect(JSON.stringify(providers)).not.toContain('sk-active-secret')
    expect(JSON.stringify(providers)).not.toContain('sk-old-secret')
  })

  it('reads no credential list when every connection is an environment variable', async () => {
    const routes = runner({ integrations: [DEEPSEEK] })
    const { fetch } = fetcher({
      'https://api.deepseek.com/user/balance': () =>
        json({ balance_infos: [{ currency: 'USD', total_balance: 1 }] }),
    })
    await new OpenCodeClient({
      program: '/bin/opencode',
      env: { DEEPSEEK_API_KEY: 'secret' },
      platform: 'darwin',
      runProgram: routes.run,
      fetch,
    }).providers()
    expect(routes.calls.map((call) => call.args)).not.toContainEqual([
      'api',
      'get',
      '/api/credential',
    ])
  })

  it('never sends a custom Console credential to the official Go endpoint', async () => {
    const routes = runner({
      integrations: [OPENCODE],
      credentials: [
        {
          id: 'cred_oc',
          integrationID: 'opencode',
          label: 'Custom',
          active: true,
          value: {
            type: 'key',
            key: 'sk-custom',
            metadata: { server: 'https://custom.example/console', orgID: 'org_1' },
          },
        },
      ],
    })
    const { fetch, calls } = fetcher({})
    const providers = await new OpenCodeClient({
      program: '/bin/opencode',
      env: {},
      platform: 'darwin',
      runProgram: routes.run,
      fetch,
      now: () => 82,
    }).providers()
    expect(providers[0]?.usage).toMatchObject({ state: 'unsupported' })
    expect(calls).toHaveLength(0)
  })

  it('reports the provider list failing, with nothing from the tool in the message', async () => {
    const runProgram = async (): Promise<ProgramRun> =>
      run('', 1, 'boom at /Users/someone/.config/opencode\n')
    const client = new OpenCodeClient({
      program: '/bin/opencode',
      env: {},
      platform: 'darwin',
      runProgram,
    })
    await expect(client.providers()).rejects.toThrow('OpenCode could not list its providers.')
  })
})

describe('OpenCodeClient.action', () => {
  const ANTHROPIC = {
    id: 'anthropic',
    name: 'Anthropic',
    methods: [KEY, ENV('ANTHROPIC_API_KEY')],
    connections: [
      { type: 'credential', id: 'cred_a', label: 'Personal', method: 'key' },
      { type: 'credential', id: 'cred_b', label: 'Work', method: 'key' },
    ],
  }

  it('refuses a credential from another provider before acting', async () => {
    const routes = runner({ integrations: [ANTHROPIC] })
    const client = new OpenCodeClient({
      program: '/bin/opencode',
      env: {},
      platform: 'darwin',
      runProgram: routes.run,
    })
    await expect(
      client.action({ providerId: 'anthropic', action: 'logout', credentialId: 'cred_other' }),
    ).rejects.toThrow('The credential does not belong to this provider.')
    expect(routes.calls.map((call) => call.args)).toEqual([['api', 'get', '/api/integration']])
  })

  it('saves a key through stdin and never in the arguments', async () => {
    const routes = runner({ integrations: [ANTHROPIC] })
    await new OpenCodeClient({
      program: '/bin/opencode',
      env: {},
      platform: 'darwin',
      runProgram: routes.run,
    }).action({ providerId: 'anthropic', action: 'set-key', key: 'sk-new-secret' })
    const imported = routes.calls.find((call) => call.args.join(' ') === 'auth import')
    expect(imported).toBeDefined()
    expect(imported?.input).toEqual(expect.any(String))
    expect(imported?.args.join(' ')).not.toContain('sk-new-secret')
    for (const call of routes.calls) {
      expect(call.args.join(' ')).not.toContain('sk-new-secret')
    }
    const entries = JSON.parse(imported!.input!) as unknown[]
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      integrationID: 'anthropic',
      label: 'Anthropic',
      active: true,
      value: { type: 'key', key: 'sk-new-secret' },
    })
    const id = (entries[0] as { id: string }).id
    expect(id).toMatch(/^cred_[0-9a-f]+$/)
    expect(routes.calls.map((call) => call.args)).toContainEqual([
      'api',
      'post',
      `/api/credential/${id}/activate`,
    ])
  })

  it('does not put the key in an error when the tool refuses it', async () => {
    const routes = runner({
      integrations: [ANTHROPIC],
      import: run('', 1, 'invalid key sk-new-secret\n'),
    })
    const client = new OpenCodeClient({
      program: '/bin/opencode',
      env: {},
      platform: 'darwin',
      runProgram: routes.run,
    })
    const failure = await client
      .action({ providerId: 'anthropic', action: 'set-key', key: 'sk-new-secret' })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('OpenCode could not save the key.')
    expect((failure as Error).message).not.toContain('sk-new-secret')
  })
})
