import { describe, expect, it, vi } from 'vitest'
import type { ProgramOptions, ProgramRun } from '../adapter-install'
import { TextRing } from '../ring'
import { OpenCodeClient } from './client'
import { USAGE_ERROR } from './provider-usage'

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
  activate?: ProgramRun
  remove?: ProgramRun
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
        return routes.activate ?? run()
      }
      if (command === 'api' && method === 'delete') {
        return routes.remove ?? run()
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

  it('uses the native usage limits for the OpenCode console account', async () => {
    const routes = runner({
      integrations: [OPENCODE],
      native: run(
        JSON.stringify({
          location: { directory: '/tmp' },
          data: {
            workspace: { id: 'ws', usageURL: 'https://opencode.ai/usage' },
            go: {
              rolling: { percent: 5, limited: false, resetsAt: 1_800_000_000_000 },
              weekly: { percent: 6, limited: false, resetsAt: 1_800_100_000_000 },
              monthly: { percent: 7, limited: false, resetsAt: 1_800_200_000_000 },
            },
            budgets: [],
          },
        }),
      ),
    })
    const { fetch, calls } = fetcher({})
    const providers = await new OpenCodeClient({
      program: '/bin/opencode',
      env: {},
      platform: 'darwin',
      runProgram: routes.run,
      fetch,
      now: () => 50,
    }).providers()
    expect(providers[0]?.usage).toMatchObject({
      state: 'ready',
      limits: [
        { window: 'rolling', usedPercent: 5 },
        { window: 'weekly', usedPercent: 6 },
        { window: 'monthly', usedPercent: 7 },
      ],
      observedAt: 50,
    })
    expect(calls).toHaveLength(0)
    expect(routes.calls.map((call) => call.args)).not.toContainEqual([
      'api',
      'get',
      '/api/credential',
    ])
  })

  it('keeps one provider failure from touching the others', async () => {
    const routes = runner({
      integrations: [DEEPSEEK, OPENCODE_GO],
    })
    const { fetch } = fetcher({
      'https://api.deepseek.com/user/balance': () => json({ error: 'bad key deep-secret' }, 500),
      'https://opencode.ai/zen/go/v1/usage': () =>
        json({
          usage: { rolling: { status: 'ok', percent: 1, resetsAt: '2026-11-03T12:00:00Z' } },
        }),
    })
    const providers = await new OpenCodeClient({
      program: '/bin/opencode',
      env: { DEEPSEEK_API_KEY: 'deep-secret', OPENCODE_API_KEY: 'go-secret' },
      platform: 'darwin',
      runProgram: routes.run,
      fetch,
      now: () => 60,
    }).providers()
    expect(providers[0]?.usage).toEqual({
      state: 'error',
      limits: [],
      balances: [],
      observedAt: 60,
      error: USAGE_ERROR,
    })
    expect(providers[1]?.usage).toMatchObject({ state: 'ready', observedAt: 60 })
    expect(JSON.stringify(providers)).not.toContain('deep-secret')
    expect(JSON.stringify(providers)).not.toContain('go-secret')
  })

  it('still reads an environment key when the credential list is unavailable', async () => {
    const routes = runner({ integrations: [OPENROUTER, DEEPSEEK] })
    const { fetch } = fetcher({
      'https://api.deepseek.com/user/balance': () =>
        json({ balance_infos: [{ currency: 'USD', total_balance: 2 }] }),
    })
    const providers = await new OpenCodeClient({
      program: '/bin/opencode',
      env: { DEEPSEEK_API_KEY: 'secret' },
      platform: 'darwin',
      runProgram: routes.run,
      fetch,
      now: () => 70,
    }).providers()
    expect(providers[0]?.usage).toEqual({
      state: 'error',
      limits: [],
      balances: [],
      observedAt: 70,
      error: USAGE_ERROR,
    })
    expect(providers[1]?.usage).toMatchObject({
      state: 'ready',
      balances: [{ label: 'Balance', amount: 2, currency: 'USD' }],
    })
  })

  it('falls back to the official Go usage for an OpenCode Console credential', async () => {
    const routes = runner({
      integrations: [OPENCODE],
      credentials: [
        {
          id: 'cred_oc',
          integrationID: 'opencode',
          label: 'Personal',
          active: true,
          value: {
            type: 'oauth',
            methodID: 'device',
            refresh: 'refresh-secret',
            access: 'console-access',
            expires: 0,
            metadata: { server: 'https://opencode.ai/console', orgID: 'wrk_1' },
          },
        },
      ],
    })
    const { fetch, calls } = fetcher({
      'https://opencode.ai/zen/go/v1/usage': () =>
        json({
          usage: {
            rolling: { status: 'ok', percent: 10, resetsAt: '2026-11-03T12:00:00Z' },
            weekly: { status: 'ok', percent: 20, resetsAt: '2026-11-10T00:00:00Z' },
            monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-12-01T00:00:00Z' },
          },
        }),
    })
    const providers = await new OpenCodeClient({
      program: '/bin/opencode',
      env: {},
      platform: 'darwin',
      runProgram: routes.run,
      fetch,
      now: () => 80,
    }).providers()
    expect(providers[0]?.usage).toMatchObject({
      state: 'ready',
      limits: [
        { window: 'rolling', usedPercent: 10 },
        { window: 'weekly', usedPercent: 20 },
        { window: 'monthly', usedPercent: 100, state: 'reached' },
      ],
      observedAt: 80,
    })
    expect(calls[0]?.url).toBe('https://opencode.ai/zen/go/v1/usage')
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: 'Bearer console-access',
      'x-opencode-org-id': 'wrk_1',
    })
    expect(JSON.stringify(providers)).not.toContain('console-access')
    expect(JSON.stringify(providers)).not.toContain('refresh-secret')
  })

  it('falls back with a Console service-account key too', async () => {
    const routes = runner({
      integrations: [OPENCODE],
      credentials: [
        {
          id: 'cred_oc',
          integrationID: 'opencode',
          label: 'Service',
          active: true,
          value: {
            type: 'key',
            key: 'sk-console',
            metadata: { server: 'https://opencode.ai/console', orgID: 'org_1' },
          },
        },
      ],
    })
    const { fetch, calls } = fetcher({
      'https://opencode.ai/zen/go/v1/usage': () =>
        json({
          usage: { rolling: { status: 'ok', percent: 1, resetsAt: '2026-11-03T12:00:00Z' } },
        }),
    })
    const providers = await new OpenCodeClient({
      program: '/bin/opencode',
      env: {},
      platform: 'darwin',
      runProgram: routes.run,
      fetch,
      now: () => 81,
    }).providers()
    expect(providers[0]?.usage).toMatchObject({ state: 'ready' })
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: 'Bearer sk-console',
      'x-opencode-org-id': 'org_1',
    })
  })

  it('uses the first Console connection when no active flag is reported', async () => {
    const routes = runner({
      integrations: [
        {
          ...OPENCODE,
          connections: [
            { type: 'credential', id: 'cred_first', label: 'First', method: 'key' },
            { type: 'credential', id: 'cred_second', label: 'Second', method: 'key' },
          ],
        },
      ],
      credentials: [
        {
          id: 'cred_first',
          integrationID: 'opencode',
          label: 'First',
          active: false,
          value: {
            type: 'key',
            key: 'sk-first',
            metadata: { server: 'https://opencode.ai/console', orgID: 'org_1' },
          },
        },
        {
          id: 'cred_second',
          integrationID: 'opencode',
          label: 'Second',
          active: false,
          value: {
            type: 'key',
            key: 'sk-second',
            metadata: { server: 'https://opencode.ai/console', orgID: 'org_2' },
          },
        },
      ],
    })
    const { fetch, calls } = fetcher({
      'https://opencode.ai/zen/go/v1/usage': () =>
        json({
          usage: { rolling: { status: 'ok', percent: 1, resetsAt: '2026-11-03T12:00:00Z' } },
        }),
    })
    await new OpenCodeClient({
      program: '/bin/opencode',
      env: {},
      platform: 'darwin',
      runProgram: routes.run,
      fetch,
    }).providers()
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: 'Bearer sk-first',
      'x-opencode-org-id': 'org_1',
    })
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

  it('needs the Console workspace before asking the Go endpoint', async () => {
    const routes = runner({
      integrations: [OPENCODE],
      credentials: [
        {
          id: 'cred_oc',
          integrationID: 'opencode',
          label: 'Personal',
          active: true,
          value: {
            type: 'oauth',
            methodID: 'device',
            refresh: 'r',
            access: 'console-access',
            expires: 0,
            metadata: { server: 'https://opencode.ai/console' },
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
      now: () => 83,
    }).providers()
    expect(providers[0]?.usage).toMatchObject({ state: 'unsupported' })
    expect(calls).toHaveLength(0)
  })

  it('treats a Go 403 as no plan and a 401 as a failure', async () => {
    const credential = {
      id: 'cred_oc',
      integrationID: 'opencode',
      label: 'Personal',
      active: true,
      value: {
        type: 'oauth',
        methodID: 'device',
        refresh: 'r',
        access: 'console-access',
        expires: 0,
        metadata: { server: 'https://opencode.ai/console', orgID: 'wrk_1' },
      },
    }
    const denied = runner({ integrations: [OPENCODE], credentials: [credential] })
    const noGo = await new OpenCodeClient({
      program: '/bin/opencode',
      env: {},
      platform: 'darwin',
      runProgram: denied.run,
      fetch: fetcher({ 'https://opencode.ai/zen/go/v1/usage': () => json({}, 403) }).fetch,
      now: () => 84,
    }).providers()
    expect(noGo[0]?.usage).toMatchObject({ state: 'unsupported' })

    const unauthorized = runner({ integrations: [OPENCODE], credentials: [credential] })
    const bad = await new OpenCodeClient({
      program: '/bin/opencode',
      env: {},
      platform: 'darwin',
      runProgram: unauthorized.run,
      fetch: fetcher({ 'https://opencode.ai/zen/go/v1/usage': () => json({}, 401) }).fetch,
      now: () => 85,
    }).providers()
    expect(bad[0]?.usage).toEqual({
      state: 'error',
      limits: [],
      balances: [],
      observedAt: 85,
      error: USAGE_ERROR,
    })
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
  const OAUTH_ONLY = {
    id: 'oauth-only',
    name: 'OAuth Only',
    methods: [OAUTH],
    connections: [],
  }

  it('logs out a credential that belongs to the provider', async () => {
    const routes = runner({ integrations: [ANTHROPIC] })
    await new OpenCodeClient({
      program: '/bin/opencode',
      env: {},
      platform: 'darwin',
      runProgram: routes.run,
    }).action({ providerId: 'anthropic', action: 'logout', credentialId: 'cred_b' })
    expect(routes.calls.map((call) => call.args)).toContainEqual([
      'api',
      'delete',
      '/api/credential/cred_b',
    ])
  })

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

  it('refuses a provider OpenCode does not know', async () => {
    const routes = runner({ integrations: [ANTHROPIC] })
    const client = new OpenCodeClient({
      program: '/bin/opencode',
      env: {},
      platform: 'darwin',
      runProgram: routes.run,
    })
    await expect(
      client.action({ providerId: '../other', action: 'activate', credentialId: 'cred_a' }),
    ).rejects.toThrow('OpenCode does not know this provider.')
  })

  it('activates a credential that belongs to the provider', async () => {
    const routes = runner({ integrations: [ANTHROPIC] })
    await new OpenCodeClient({
      program: '/bin/opencode',
      env: {},
      platform: 'darwin',
      runProgram: routes.run,
    }).action({ providerId: 'anthropic', action: 'activate', credentialId: 'cred_a' })
    expect(routes.calls.map((call) => call.args)).toContainEqual([
      'api',
      'post',
      '/api/credential/cred_a/activate',
    ])
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

  it('refuses a provider without a key method', async () => {
    const routes = runner({ integrations: [OAUTH_ONLY] })
    const client = new OpenCodeClient({
      program: '/bin/opencode',
      env: {},
      platform: 'darwin',
      runProgram: routes.run,
    })
    await expect(
      client.action({ providerId: 'oauth-only', action: 'set-key', key: 'sk' }),
    ).rejects.toThrow('This provider has no key sign-in.')
    expect(routes.calls.map((call) => call.args)).not.toContainEqual(['auth', 'import'])
  })

  it('refuses an empty key', async () => {
    const routes = runner({ integrations: [ANTHROPIC] })
    const client = new OpenCodeClient({
      program: '/bin/opencode',
      env: {},
      platform: 'darwin',
      runProgram: routes.run,
    })
    await expect(
      client.action({ providerId: 'anthropic', action: 'set-key', key: ' ' }),
    ).rejects.toThrow('A key is required.')
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

  it('says the key was saved when only activating it failed', async () => {
    const routes = runner({
      integrations: [ANTHROPIC],
      import: run('', 0, 'Imported 1 credential\n'),
      activate: run('', 1, 'HTTP 500\n'),
    })
    const client = new OpenCodeClient({
      program: '/bin/opencode',
      env: {},
      platform: 'darwin',
      runProgram: routes.run,
    })
    await expect(
      client.action({ providerId: 'anthropic', action: 'set-key', key: 'sk-new-secret' }),
    ).rejects.toThrow('The key was saved, but OpenCode could not activate the account.')
  })
})
