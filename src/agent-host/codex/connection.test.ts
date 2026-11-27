// The Codex connection against a scripted app-server: the handshake, sessions and the settings
// each turn carries, streaming into the thread, approvals, steering, forks, hidden sessions,
// limits and sign-in.

import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccount } from '@shared/agent-host'
import type { MarketServer } from '@shared/marketplace'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
  type ConfigOption,
  type SideChatStep,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import type { ProgramOptions, ProgramRun } from '../adapter-install'
import {
  AgentRequestError,
  type ConnectionHooks,
  type PermissionAnswer,
  type PermissionRequest,
  type SessionTarget,
} from '../connection'
import { libraryServers, parseMarketKeys, type OwnServer } from '../marketplace/servers'
import { TextRing } from '../ring'
import { newTurnScope, type MapperEffect } from '../session-updates'
import {
  FAKE_MODELS,
  FakeAppServer,
  FakeRpcError,
  threadResponse,
  turn,
} from '../testing/fake-app-server'
import { SIDE_INSTRUCTIONS } from '../side-chat'
import { CodexConnection } from './connection'

const SPEC = {
  command: '/opt/codex/bin/codex',
  args: ['app-server'],
  env: { CODEX_MANAGED_BY_NPM: '1' },
  shell: false,
  display: { command: '/opt/codex/bin/codex', args: ['app-server'], env: {} },
}

const question = {
  id: 'q',
  header: 'Plan',
  question: 'Which one?',
  isOther: false,
  isSecret: false,
}

const choice = (label: string, description = '') => ({ label, description })

function hooks() {
  const accounts: AgentAccount[] = []
  const ignored: string[] = []
  const logs: string[] = []
  const value: ConnectionHooks = {
    traffic: () => {},
    account: (account) => accounts.push(account),
    ignored: (_id, what) => ignored.push(what),
    log: (_level, message) => logs.push(message),
  }
  return { value, accounts, ignored, logs }
}

async function connect(options: { run?: (o: ProgramOptions) => Promise<ProgramRun> } = {}) {
  const server = new FakeAppServer()
  const h = hooks()
  const connection = new CodexConnection(server.transport, h.value, {
    spec: SPEC,
    env: { HOME: '/home' },
    platform: 'darwin',
    ...(options.run ? { run: options.run } : {}),
  })
  const init = await connection.initialize('1.2.3')
  return { server, connection, init, ...h }
}

/** A session's view of its thread: the patches applied, the effects and the requests kept. */
function threadTarget(
  answer: (request: PermissionRequest) => PermissionAnswer | Promise<PermissionAnswer> = () =>
    'cancelled',
) {
  let thread: ThreadState = threadFromSnapshot({
    session: {
      id: 's',
      agentId: 'codex',
      projectPath: os.tmpdir(),
      acpSessionId: 'thread-1',
      status: 'running',
      title: null,
      config: [],
      commands: [],
      usage: null,
      error: null,
      turnStartedAt: null,
      turnStartUsed: null,
      createdAt: 0,
      updatedAt: 0,
      parentId: null,
      origin: 'user',
      subagent: null,
      routine: null,
      queue: [],
      queuePaused: false,
    },
    entries: [],
    seq: 0,
  })
  let n = 0
  const scope = newTurnScope()
  const effects: MapperEffect[] = []
  const requests: { request: PermissionRequest; signal: AbortSignal }[] = []
  const sent: string[] = []
  const approvals: string[] = []
  const sentNow: string[] = []
  const state = { replaying: false }
  const target: SessionTarget = {
    context: () => ({
      thread,
      replaying: state.replaying,
      cancelling: false,
      scope,
      now: 5_000,
      nextId: () => `e:${++n}`,
      sessionIdFor: () => null,
    }),
    apply: (output) => {
      thread = applyPatches(thread, output.patches)
      effects.push(...output.effects)
    },
    requestPermission: async (request, signal) => {
      requests.push({ request, signal })
      target.apply(request.output)
      return answer(request)
    },
    send: (text, options) => {
      sent.push(text)
      if (options?.approval) approvals.push(text)
      if (options?.now) sentNow.push(text)
    },
    startMode: () => null,
  }
  return {
    target,
    state,
    effects,
    requests,
    sent,
    approvals,
    sentNow,
    entries: (): ThreadEntry[] => threadEntries(thread),
    entry: (id: string) => thread.byId[id],
    thread: () => thread,
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await tick()
  if (!check()) throw new Error('timed out')
}

const usage = (total: number, input: number, cached: number, output: number) => ({
  totalTokens: total,
  inputTokens: input,
  cachedInputTokens: cached,
  cacheWriteInputTokens: 0,
  outputTokens: output,
  reasoningOutputTokens: 4,
})

describe('the handshake', () => {
  it('opens the experimental API, reads the version and offers codex login in a terminal', async () => {
    const { server, init, accounts } = await connect()
    expect(server.requests[0]).toEqual({
      method: 'initialize',
      params: {
        clientInfo: { name: 'Kettu', title: 'Kettu', version: '1.2.3' },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: ['turn/moderationMetadata'],
        },
      },
    })
    expect(server.requests[1]?.method).toBe('initialized')
    expect(init.version).toBe('0.166.0')
    expect(init.capabilities).toMatchObject({
      loadSession: true,
      resumeSession: true,
      forkSession: true,
      forkAtMessage: true,
      steering: true,
      ownTitles: null,
      logout: true,
      mcpHttp: true,
    })
    expect(init.authMethods.map((m) => [m.id, m.type, m.command, m.args])).toEqual([
      ['chat-gpt', 'terminal', SPEC.command, ['login']],
      ['chat-gpt-device-code', 'terminal', SPEC.command, ['login', '--device-auth']],
      ['api-key', 'terminal', SPEC.command, ['login', '--with-api-key']],
    ])
    await until(() => accounts.length > 0)
    expect(accounts[0]).toEqual({
      kind: 'account',
      label: 'ChatGPT Plus',
      email: 'developer@example.com',
    })
    // app-server's own sign-in is never used.
    expect(server.requests.some((r) => r.method.startsWith('account/login'))).toBe(false)
  })

  it('signs out with codex logout, run with the agent environment', async () => {
    const runs: ProgramOptions[] = []
    const { connection, server } = await connect({
      run: async (options) => {
        runs.push(options)
        return {
          code: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          output: new TextRing(64),
          stdout: '',
        }
      },
    })
    await connection.logout()
    expect(runs).toEqual([
      expect.objectContaining({
        program: SPEC.command,
        args: ['logout'],
        env: { HOME: '/home', CODEX_MANAGED_BY_NPM: '1' },
      }),
    ])
    expect(server.requests.some((r) => r.method.startsWith('account/logout'))).toBe(false)
  })
})

describe('context estimates', () => {
  it('estimates enabled skills and the tool catalogs of the thread’s MCP servers', async () => {
    const { server, connection } = await connect()
    server.skills = [
      { name: 'build', description: '构建', path: '/repo/build/SKILL.md', enabled: true },
      { name: 'hidden', description: 'Unused', path: '/repo/hidden/SKILL.md', enabled: false },
    ]
    const connected = { runtimeStatus: 'connected', toolsError: null, authStatus: 'unsupported' }
    server.on('mcpServerStatus/list', ({ cursor }) =>
      cursor === null
        ? {
            nextCursor: 'next',
            data: [
              {
                ...connected,
                name: 'files',
                tools: {
                  mcp__files__read: {
                    name: 'read',
                    description: 'Read a file',
                    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
                    _meta: { annotation: 'Only for clients' },
                  },
                },
              },
            ],
          }
        : {
            nextCursor: null,
            data: [
              { ...connected, name: 'empty', tools: {} },
              { ...connected, name: 'disabled', runtimeStatus: 'disabled', tools: {} },
              { ...connected, name: 'offline', toolsError: 'Discovery failed', tools: {} },
            ],
          },
    )
    const { sessionId } = await connection.newSession('/repo')

    expect(await connection.readContextEstimates(sessionId, '/repo')).toEqual({
      skills: [{ name: 'build', tokens: 12 }],
      mcpServers: [
        { name: 'files', tokens: 32 },
        { name: 'empty', tokens: 0 },
        { name: 'offline', tokens: null },
      ],
    })
    expect(server.sent('skills/list').at(-1)).toEqual({ cwds: ['/repo'] })
    expect(server.sent('mcpServerStatus/list')).toEqual([
      { cursor: null, detail: 'toolsAndAuthOnly', threadId: sessionId },
      { cursor: 'next', detail: 'toolsAndAuthOnly', threadId: sessionId },
    ])
    expect(server.sent('turn/start')).toEqual([])
  })

  it('keeps the skill estimate when the thread’s MCP catalog is unavailable', async () => {
    const { server, connection } = await connect()
    server.on('mcpServerStatus/list', () => {
      throw new FakeRpcError(-32002, 'Thread not loaded')
    })
    expect(await connection.readContextEstimates('thread-1', '/repo')).toEqual({
      skills: [],
      mcpServers: null,
    })
    expect(server.sent('mcpServerStatus/list')).toHaveLength(1)
  })
})

describe('sessions', () => {
  it('trusts the folder only once its own settings may load, and turns its servers off', async () => {
    const { server, connection } = await connect()
    const kettuDb = {
      type: 'http' as const,
      name: 'db-kettu',
      url: 'http://127.0.0.1:9/servers/db',
      headers: [],
      replaces: ['db'],
    }
    await connection.newSession('/project', { projectServers: ['db', 'shell'] })
    await connection.newSession('/project', {
      projectTrusted: true,
      projectServers: ['db', 'shell'],
      mcpServers: [kettuDb],
    })
    await connection.resumeSession('thread-7', '/project', { projectTrusted: true })
    const [held, trusted] = server.sent('thread/start')
    expect(held).toMatchObject({
      config: {
        projects: { '/project': { trust_level: 'untrusted' } },
        mcp_servers: { db: { enabled: false }, shell: { enabled: false } },
      },
    })
    expect(trusted).toMatchObject({
      config: {
        projects: { '/project': { trust_level: 'trusted' } },
        mcp_servers: {
          'db-kettu': { url: 'http://127.0.0.1:9/servers/db' },
          db: { enabled: false },
          shell: { enabled: false },
        },
      },
    })
    expect(server.sent('thread/resume')[0]).toMatchObject({
      config: { projects: { '/project': { trust_level: 'trusted' } } },
    })
  })

  it('starts a thread with the default mode, the folder untrusted and Kettu’s MCP server', async () => {
    const { server, connection } = await connect()
    const opened = await connection.newSession('/project', {
      mcpServers: [
        {
          type: 'http',
          name: 'kettu',
          url: 'http://127.0.0.1:9/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer t' }],
          autoAllow: ['set_plan'],
          prompt: 'Plan first.',
        },
      ],
    })
    expect(opened.sessionId).toBe('thread-1')
    expect(server.sent('thread/start')[0]).toEqual({
      cwd: '/project',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: 'workspace-write',
      config: {
        projects: { '/project': { trust_level: 'untrusted' } },
        features: { default_mode_request_user_input: true },
        suppress_unstable_features_warning: true,
        thread_unload_delay_secs: 0,
        mcp_servers: {
          kettu: {
            url: 'http://127.0.0.1:9/mcp',
            http_headers: { Authorization: 'Bearer t' },
            tools: { set_plan: { approval_mode: 'approve' } },
          },
        },
      },
      developerInstructions: 'Plan first.',
      ephemeral: false,
      experimentalRawEvents: false,
    })
    expect(opened.config.map((o) => [o.id, o.category, o.value])).toEqual([
      ['mode', 'mode', 'agent'],
      ['collaboration_mode', 'other', 'default'],
      ['model', 'model', 'gpt-6.1-sol'],
      ['reasoning_effort', 'thought_level', 'medium'],
      ['fast-mode', 'model_config', false],
    ])
    expect(opened.config[0]?.choices?.map((c) => c.value)).toEqual([
      'read-only',
      'workspace-write',
      'agent',
      'agent-full-access',
    ])
  })

  describe('models Codex lists while it runs', () => {
    const nova = { ...FAKE_MODELS[1]!, id: 'gpt-6.2-nova', displayName: 'gpt-6.2-nova' }
    const modelOption = (config: ConfigOption[]) => config.find((o) => o.id === 'model')
    const valuesOf = (config: ConfigOption[]) => modelOption(config)?.choices?.map((c) => c.value)

    afterEach(() => {
      vi.useRealTimers()
    })

    it('lists a model added since in a read of the options, and takes a pick of it', async () => {
      const { server, connection } = await connect()
      const listed = [...FAKE_MODELS]
      server.on('model/list', () => ({ data: listed, nextCursor: null }))
      const first = await connection.newSession('/project')
      expect(valuesOf(first.config)).toEqual(['gpt-6.1-sol', 'gpt-5.6-luna'])
      listed.push(nova)
      const read = await connection.newSession('/project', { hidden: 'options' })
      expect(valuesOf(read.config)).toContain('gpt-6.2-nova')
      const picked = await connection.setConfigOption(first.sessionId, 'model', 'gpt-6.2-nova')
      expect(modelOption(picked)?.value).toBe('gpt-6.2-nova')
    })

    it('keeps the models it listed when a read of the options fails', async () => {
      const { server, connection } = await connect()
      const first = await connection.newSession('/project')
      server.on('model/list', () => {
        throw new FakeRpcError(-32603, 'offline')
      })
      const read = await connection.newSession('/project', { hidden: 'options' })
      expect(valuesOf(read.config)).toEqual(valuesOf(first.config))
    })

    it('opens a thread without waiting for the list, and lists the new models after it', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const { server, connection } = await connect()
      const first = await connection.newSession('/project')
      let release = () => {}
      const gate = new Promise<void>((resolve) => (release = resolve))
      server.on('model/list', async () => {
        await gate
        return { data: [...FAKE_MODELS, nova], nextCursor: null }
      })
      vi.setSystemTime(Date.now() + 61_000)
      const second = await connection.newSession('/project')
      expect(valuesOf(second.config)).toEqual(valuesOf(first.config))
      expect(server.sent('model/list')).toHaveLength(2)
      release()
      await vi.waitFor(async () => {
        const next = await connection.newSession('/project')
        expect(valuesOf(next.config)).toContain('gpt-6.2-nova')
      })
    })
  })

  it('hands Kettu’s memory over as developer instructions and turns Codex’s own memories off', async () => {
    const { server, connection } = await connect()
    const kettu = {
      type: 'http' as const,
      name: 'kettu',
      url: 'http://127.0.0.1:9/mcp',
      headers: [],
      prompt: 'Plan first.',
    }
    const memory = { text: 'Memory index.' }
    const memoryOff = {
      features: { default_mode_request_user_input: true, memories: false },
      memories: { use_memories: false, generate_memories: false },
    }
    const opened = await connection.newSession('/project', { mcpServers: [kettu], memory })
    await connection.resumeSession('thread-7', '/project', { mcpServers: [kettu], memory })
    await connection.forkSession(opened.sessionId, '/project', { mcpServers: [kettu], memory })
    for (const method of ['thread/start', 'thread/resume', 'thread/fork']) {
      expect(server.sent(method)[0]).toMatchObject({
        config: { projects: { '/project': { trust_level: 'untrusted' } }, ...memoryOff },
        developerInstructions: 'Plan first.\n\nMemory index.',
      })
    }
    await connection.newSession('/project', { memory: { text: 'Only memory.' } })
    expect(server.sent('thread/start')[1]).toMatchObject({ developerInstructions: 'Only memory.' })

    await connection.newSession('/project', { mcpServers: [kettu] })
    const without = server.sent('thread/start')[2] as { config: Record<string, unknown> }
    expect(without).toMatchObject({ developerInstructions: 'Plan first.' })
    expect(without.config).toMatchObject({ features: { default_mode_request_user_input: true } })
    expect(without.config.features).not.toHaveProperty('memories')
    expect(without.config).not.toHaveProperty('memories')
    expect(connection.ownInstructions).toBe(true)
  })

  it('turns on the question tool in Default mode without its warning on every thread', async () => {
    const { server, connection } = await connect()
    const opened = await connection.newSession('/project')
    await connection.resumeSession('thread-7', '/project', {})
    await connection.forkSession(opened.sessionId, '/project', {})
    for (const method of ['thread/start', 'thread/resume', 'thread/fork']) {
      // The thread's own `features` table replaces the command line's, so the flag rides in it.
      expect(server.sent(method)[0]).toMatchObject({
        config: {
          features: { default_mode_request_user_input: true },
          suppress_unstable_features_warning: true,
        },
      })
    }
  })

  it('has every thread unloaded once Kettu lets go of it, which frees its writer lock', async () => {
    const { server, connection } = await connect()
    const opened = await connection.newSession('/project')
    await connection.resumeSession('thread-7', '/project', {})
    await connection.forkSession(opened.sessionId, '/project', {})
    for (const method of ['thread/start', 'thread/resume', 'thread/fork']) {
      expect(server.sent(method)[0]).toMatchObject({ config: { thread_unload_delay_secs: 0 } })
    }
  })

  it('opens a thread it just let go of again once app-server has closed it', async () => {
    const { server, connection } = await connect()
    let refused = false
    server.on('thread/resume', (params) => {
      const threadId = params.threadId as string
      if (refused) return threadResponse(threadId)
      refused = true
      setTimeout(() => server.notify('thread/closed', { threadId }), 0)
      // Codex 0.172.0's answer while it still unloads the thread.
      throw new FakeRpcError(
        -32600,
        `thread ${threadId} is closing; retry thread/resume after the thread is closed`,
      )
    })
    await connection.closeSession('thread-7')
    const setup = await connection.resumeSession('thread-7', '/project')
    expect(setup.config.find((o) => o.id === 'model')).toBeDefined()
    expect(server.sent('thread/resume')).toHaveLength(2)
  })

  it('sets the Marketplace’s skill folders on app-server before a thread starts, once while unchanged', async () => {
    const { server, connection } = await connect()
    server.on('skills/extraRoots/set', () => ({}))
    await connection.newSession('/project', { skillRoots: ['/kettu/skills/pdf-1'] })
    await connection.newSession('/project', { skillRoots: ['/kettu/skills/pdf-1'] })
    await connection.newSession('/project', { hidden: 'options' })
    await connection.newSession('/project', { skillRoots: [] })
    expect(server.sent('skills/extraRoots/set')).toEqual([
      { extraRoots: ['/kettu/skills/pdf-1'] },
      { extraRoots: [] },
    ])
    const methods = server.requests.map((request) => request.method)
    expect(methods.indexOf('skills/extraRoots/set')).toBeLessThan(methods.indexOf('thread/start'))
  })

  it('passes the Marketplace’s servers in the thread config, leaving out SSE, which Codex lacks', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project', {
      mcpServers: [
        {
          type: 'stdio',
          name: 'context7',
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp@4.6.0'],
          env: [{ name: 'CONTEXT7_API_KEY', value: 'c7-secret' }],
          secret: true,
        },
        {
          type: 'stdio',
          name: 'playwright',
          command: 'npx',
          args: ['-y', '@playwright/mcp@1'],
          env: [],
        },
        {
          type: 'http',
          name: 'github',
          url: 'https://api.githubcopilot.com/mcp/',
          headers: [{ name: 'Authorization', value: 'Bearer ghp_secret' }],
          secret: true,
        },
        { type: 'sse', name: 'notion', url: 'https://mcp.notion.com/sse', headers: [] },
      ],
    })
    const sent = server.sent('thread/start')[0] as { config: Record<string, unknown> }
    expect(sent.config.mcp_servers).toEqual({
      context7: {
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp@4.6.0'],
        env: { CONTEXT7_API_KEY: 'c7-secret' },
      },
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp@1'] },
      github: {
        url: 'https://api.githubcopilot.com/mcp/',
        http_headers: { Authorization: 'Bearer ghp_secret' },
      },
    })
    expect(sent).not.toHaveProperty('developerInstructions')
  })

  it("turns off the agent's own copy of a library server and hands Kettu's under a free name", async () => {
    const { server, connection, init } = await connect()
    const library = (name: string, spec: MarketServer['spec']): MarketServer => ({
      id: `manual:${name}`,
      name,
      title: name,
      source: 'manual',
      version: null,
      spec,
      agents: 'all',
      on: true,
    })
    const stdio = (...args: string[]) => ({ type: 'stdio' as const, command: 'node', args })
    const own: OwnServer[] = [
      { name: 'probe', endpoint: stdio('probe.js', 'own') },
      { name: 'remote', endpoint: { type: 'http', url: 'https://own.example.com/mcp' } },
      { name: 'remote-kettu', endpoint: { type: 'http', url: 'https://else.example.com/mcp' } },
      { name: 'mydocs', endpoint: stdio('docs.js') },
    ]
    const servers = libraryServers(
      [
        library('probe', { ...stdio('probe.js', 'kettu'), env: [] }),
        library('remote', {
          type: 'http',
          transport: 'streamable-http',
          url: 'https://kettu.example.com/mcp',
          headers: [],
        }),
        library('docs', { ...stdio('docs.js'), env: [] }),
      ],
      parseMarketKeys({})!,
      'codex',
      init.capabilities,
      {
        platform: 'darwin',
        own,
        router: { origin: 'http://127.0.0.1:4567', token: 'session-token', allow: () => {} },
      },
    )
    await connection.newSession('/project', { mcpServers: servers })
    const sent = server.sent('thread/start')[0] as {
      config: { mcp_servers: Record<string, Record<string, unknown>> }
    }
    const entries = sent.config.mcp_servers
    for (const name of ['probe', 'remote', 'mydocs'])
      expect(entries[name]).toEqual({ enabled: false })
    expect(entries).not.toHaveProperty('remote-kettu')
    const live = Object.entries(entries).filter(([, entry]) => entry.enabled !== false)
    expect(live.map(([name]) => name).sort()).toEqual(['docs', 'probe-kettu', 'remote-kettu-2'])
    for (const [name, entry] of live) {
      expect(own.map((item) => item.name)).not.toContain(name)
      expect(entry.url).toMatch(/^http:\/\/127\.0\.0\.1:4567\//)
    }
  })

  it('needs a sign-in before a session opens on an install that has none', async () => {
    const { server, connection } = await connect()
    server.on('account/read', () => ({ account: null, requiresOpenaiAuth: true }))
    await expect(connection.newSession('/project')).rejects.toMatchObject({ kind: 'auth_required' })
    expect(server.sent('thread/start')).toEqual([])
  })

  it('takes a thread that was never prompted, which has no rollout, as one Codex lacks', async () => {
    const { server, connection } = await connect()
    server.on('thread/resume', () => {
      throw new FakeRpcError(-32600, 'no rollout found for thread id thread-9')
    })
    const failure = await connection.resumeSession('thread-9', '/project').catch((e) => e)
    expect(failure).toBeInstanceOf(AgentRequestError)
    expect(failure).toMatchObject({ kind: 'agent_error', code: -32002 })
  })

  it('says a thread another Codex program holds is open there, not Codex’s own words', async () => {
    const { server, connection } = await connect()
    // Codex 0.172.0's answer while another process holds the thread's writer lock.
    server.on('thread/resume', () => {
      throw new FakeRpcError(-32600, 'thread thread-9 already has an active writer')
    })
    const failure = await connection.resumeSession('thread-9', '/project').catch((e) => e)
    expect(failure).toBeInstanceOf(AgentRequestError)
    // Not a thread Codex lacks: that would start a new one in its place.
    expect(failure).toMatchObject({ kind: 'agent_error', code: -32600 })
    expect(failure.message).toContain('open in another Codex program')
    expect(failure.message).not.toContain('active writer')
  })

  it('sends the session’s settings with every turn, after a resume as well', async () => {
    const { server, connection } = await connect()
    server.on('thread/resume', (params) =>
      threadResponse(params.threadId as string, {
        model: 'gpt-5.6-luna',
        reasoningEffort: 'low',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: { type: 'readOnly', networkAccess: false },
      }),
    )
    const setup = await connection.resumeSession('thread-7', '/project')
    expect(setup.config.find((o) => o.id === 'mode')?.value).toBe('read-only')
    expect(setup.config.find((o) => o.id === 'model')?.value).toBe('gpt-5.6-luna')
    await connection.setConfigOption('thread-7', 'mode', 'workspace-write')
    await connection.setConfigOption('thread-7', 'model', 'gpt-6.1-sol')
    await connection.setConfigOption('thread-7', 'reasoning_effort', 'high')
    await connection.setConfigOption('thread-7', 'fast-mode', true)
    await connection.setConfigOption('thread-7', 'collaboration_mode', 'plan')
    const { target } = threadTarget()
    connection.register('thread-7', target)
    const prompt = connection.prompt('thread-7', [{ type: 'text', text: 'hi' }])
    await until(() => server.sent('turn/start').length === 1)
    expect(server.sent('turn/start')[0]).toEqual({
      threadId: 'thread-7',
      input: [{ type: 'text', text: 'hi', text_elements: [] }],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      summary: 'auto',
      model: 'gpt-6.1-sol',
      effort: 'high',
      serviceTier: 'priority',
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'gpt-6.1-sol', reasoning_effort: 'high', developer_instructions: null },
      },
    })
    server.notify('turn/completed', { threadId: 'thread-7', turn: turn('turn-1', 'completed') })
    await prompt
  })

  it('refuses a value Codex does not have', async () => {
    const { connection } = await connect()
    await connection.newSession('/project')
    await expect(connection.setConfigOption('thread-1', 'mode', 'yolo')).rejects.toMatchObject({
      code: -32602,
    })
    await expect(
      connection.setConfigOption('thread-1', 'reasoning_effort', 'ultra'),
    ).rejects.toMatchObject({ code: -32602 })
  })

  it('lists the folder’s threads with their names, leaving out subagents', async () => {
    const { server, connection } = await connect()
    server.on('thread/list', () => ({
      data: [
        { ...threadResponse('a').thread, name: 'Fix the build', updatedAt: 1_800_000_000 },
        { ...threadResponse('b').thread, preview: '  Add\n tests ' },
        { ...threadResponse('c').thread, parentThreadId: 'a' },
      ],
      nextCursor: 'next',
    }))
    expect(await connection.listSessions('/project', null)).toEqual({
      sessions: [
        {
          sessionId: 'a',
          title: 'Fix the build',
          updatedAt: '2027-01-15T08:00:00.000Z',
          cwd: '/project',
        },
        {
          sessionId: 'b',
          title: 'Add tests',
          updatedAt: '2027-01-15T08:00:00.000Z',
          cwd: '/project',
        },
      ],
      nextCursor: 'next',
    })
    expect(server.sent('thread/list')[0]).toEqual({
      cwd: '/project',
      cursor: null,
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
    })
  })

  it('lists threads across all folders when cwd is null and preserves each original cwd', async () => {
    const { server, connection, init } = await connect()
    expect(init.capabilities.listAllSessions).toBe(true)
    server.on('thread/list', () => ({
      data: [
        {
          ...threadResponse('moved-1').thread,
          cwd: '/old/moved-repo',
          name: 'Legacy work',
          updatedAt: 1_800_000_000,
        },
        {
          ...threadResponse('wt-1').thread,
          cwd: '/worktrees/feat-auth',
          preview: 'Worktree session',
          updatedAt: 1_800_000_060,
        },
      ],
      nextCursor: null,
    }))
    expect(await connection.listSessions(null, null)).toEqual({
      sessions: [
        {
          sessionId: 'moved-1',
          title: 'Legacy work',
          updatedAt: '2027-01-15T08:00:00.000Z',
          cwd: '/old/moved-repo',
        },
        {
          sessionId: 'wt-1',
          title: 'Worktree session',
          updatedAt: '2027-01-15T08:01:00.000Z',
          cwd: '/worktrees/feat-auth',
        },
      ],
      nextCursor: null,
    })
    expect(server.sent('thread/list')[0]).toEqual({
      cwd: null,
      cursor: null,
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
    })
  })

  it('unsubscribes on close and deletes for good on delete', async () => {
    const { server, connection } = await connect()
    await connection.closeSession('thread-3')
    await connection.deleteSession('thread-3')
    expect(server.sent('thread/unsubscribe')).toEqual([{ threadId: 'thread-3' }])
    expect(server.sent('thread/delete')).toEqual([{ threadId: 'thread-3' }])
  })
})

describe('a turn', () => {
  it('streams messages, thoughts, a command and an edit, and ends with the turn’s tokens', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    const t = threadTarget()
    connection.register('thread-1', t.target)
    const prompt = connection.prompt('thread-1', [{ type: 'text', text: 'go' }])
    await until(() => server.sent('turn/start').length === 1)
    const at = { threadId: 'thread-1', turnId: 'turn-1' }
    server.notify('turn/started', { threadId: 'thread-1', turn: turn('turn-1') })
    server.notify('item/started', { ...at, item: { type: 'userMessage', id: 'u1', content: [] } })
    server.notify('item/started', {
      ...at,
      item: { type: 'reasoning', id: 'rs_1', summary: [], content: [] },
    })
    server.notify('item/reasoning/summaryPartAdded', { ...at, itemId: 'rs_1', summaryIndex: 0 })
    server.notify('item/reasoning/summaryTextDelta', {
      ...at,
      itemId: 'rs_1',
      summaryIndex: 0,
      delta: '**Look**',
    })
    server.notify('item/reasoning/summaryPartAdded', { ...at, itemId: 'rs_1', summaryIndex: 1 })
    server.notify('item/reasoning/summaryTextDelta', {
      ...at,
      itemId: 'rs_1',
      summaryIndex: 1,
      delta: 'Then act',
    })
    server.notify('item/completed', {
      ...at,
      item: { type: 'reasoning', id: 'rs_1', summary: ['**Look**', 'Then act'], content: [] },
    })
    server.notify('item/started', {
      ...at,
      item: { type: 'agentMessage', id: 'msg_1', text: '', phase: 'commentary' },
    })
    server.notify('item/agentMessage/delta', { ...at, itemId: 'msg_1', delta: 'Running ' })
    server.notify('item/agentMessage/delta', { ...at, itemId: 'msg_1', delta: 'it' })
    const command = {
      type: 'commandExecution',
      id: 'exec-1',
      command: "/bin/zsh -lc 'ls -la'",
      cwd: '/project',
      status: 'inProgress',
      commandActions: [{ type: 'unknown', command: 'ls -la' }],
      aggregatedOutput: null,
      exitCode: null,
    }
    server.notify('item/started', { ...at, item: command })
    server.notify('item/commandExecution/outputDelta', { ...at, itemId: 'exec-1', delta: 'a\r\n' })
    server.notify('item/completed', {
      ...at,
      item: { ...command, status: 'completed', aggregatedOutput: 'a\nb\n', exitCode: 0 },
    })
    server.notify('item/completed', {
      ...at,
      item: {
        type: 'fileChange',
        id: 'patch-1',
        status: 'completed',
        changes: [
          {
            path: '/project/a.ts',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1,2 +1,2 @@\n x\n-old\n+new\n',
          },
          { path: '/project/b.ts', kind: { type: 'add' }, diff: 'hello\n' },
        ],
      },
    })
    server.notify('thread/tokenUsage/updated', {
      ...at,
      tokenUsage: {
        total: usage(120, 100, 40, 20),
        last: usage(120, 100, 40, 20),
        modelContextWindow: 400_000,
      },
    })
    server.notify('thread/tokenUsage/updated', {
      ...at,
      tokenUsage: {
        total: usage(250, 210, 140, 40),
        last: usage(130, 110, 100, 20),
        modelContextWindow: 400_000,
      },
    })
    server.notify('turn/completed', { threadId: 'thread-1', turn: turn('turn-1', 'completed') })
    const result = await prompt
    expect(result).toEqual({
      stopReason: 'end_turn',
      tokens: { total: 250, input: 70, output: 40, thought: 8, cacheRead: 140, cacheWrite: 0 },
      models: [
        {
          model: 'gpt-6.1-sol',
          tokens: { total: 250, input: 70, output: 40, thought: 8, cacheRead: 140, cacheWrite: 0 },
        },
      ],
    })
    const entries = t.entries()
    // The host adds the user's own entry.
    expect(entries.map((e) => e.id)).toEqual([
      'm:rs_1',
      'm:rs_1#part1',
      'm:msg_1',
      't:exec-1',
      't:patch-1',
    ])
    expect(t.entry('m:rs_1')).toMatchObject({
      kind: 'thought',
      markdown: '**Look**',
      streaming: false,
    })
    expect(t.entry('m:rs_1#part1')).toMatchObject({
      kind: 'thought',
      markdown: 'Then act',
      streaming: false,
    })
    expect(t.entry('m:msg_1')).toMatchObject({
      kind: 'agent',
      markdown: 'Running it',
      streaming: true,
    })
    expect(t.entry('t:exec-1')).toMatchObject({
      toolKind: 'execute',
      title: 'ls -la',
      rawInput: 'ls -la',
      status: 'completed',
      content: [{ type: 'markdown', markdown: '```\na\nb\n```' }],
    })
    expect(t.entry('t:patch-1')).toMatchObject({
      toolKind: 'edit',
      status: 'completed',
      content: [
        { type: 'diff', path: '/project/a.ts', oldText: 'x\nold', newText: 'x\nnew' },
        { type: 'diff', path: '/project/b.ts', oldText: null, newText: 'hello\n' },
      ],
    })
    expect(t.thread().session.usage).toMatchObject({ used: 130, size: 400_000 })
    expect(t.effects.filter((e) => e.kind === 'request')).toHaveLength(2)
    expect(
      t.effects.filter((e) => e.kind === 'tool').map((e) => e.kind === 'tool' && e.phase),
    ).toEqual(['started', 'ended', 'started', 'ended'])
  })

  it('fails a turn Codex failed, with what it said, and asks for a sign-in on an expired one', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    const failed = connection.prompt('thread-1', [{ type: 'text', text: 'go' }])
    await until(() => server.sent('turn/start').length === 1)
    server.notify('error', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: false,
      error: {
        message: 'Quota exceeded',
        codexErrorInfo: 'usageLimitExceeded',
        additionalDetails: null,
      },
    })
    server.notify('turn/completed', {
      threadId: 'thread-1',
      turn: turn('turn-1', 'failed', {
        message: 'Quota exceeded',
        codexErrorInfo: 'usageLimitExceeded',
        additionalDetails: 'Upgrade',
      }),
    })
    await expect(failed).rejects.toMatchObject({
      kind: 'agent_error',
      message: 'Upgrade',
      data: { codexErrorInfo: 'usageLimitExceeded', message: 'Quota exceeded' },
    })
    const expired = connection.prompt('thread-1', [{ type: 'text', text: 'again' }])
    await until(() => server.sent('turn/start').length === 2)
    server.notify('turn/completed', {
      threadId: 'thread-1',
      turn: turn('turn-2', 'failed', {
        message: 'Unauthorized',
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } },
        additionalDetails: null,
      }),
    })
    await expect(expired).rejects.toMatchObject({ kind: 'auth_required' })
  })

  it('interrupts the running turn, even one stopped before its id came', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    let release!: () => void
    server.on('turn/start', async () => {
      await new Promise<void>((resolve) => (release = resolve))
      return { turn: turn('turn-9') }
    })
    const prompt = connection.prompt('thread-1', [{ type: 'text', text: 'go' }])
    await until(() => server.sent('turn/start').length === 1)
    await connection.cancel('thread-1')
    expect(server.sent('turn/interrupt')).toEqual([])
    release()
    await until(() => server.sent('turn/interrupt').length === 1)
    expect(server.sent('turn/interrupt')[0]).toEqual({ threadId: 'thread-1', turnId: 'turn-9' })
    server.notify('turn/completed', { threadId: 'thread-1', turn: turn('turn-9', 'interrupted') })
    expect((await prompt).stopReason).toBe('cancelled')
  })

  it('rejects the turn of a connection that closed', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    const prompt = connection.prompt('thread-1', [{ type: 'text', text: 'go' }])
    await until(() => server.sent('turn/start').length === 1)
    server.close()
    await expect(prompt).rejects.toMatchObject({ kind: 'closed' })
    expect(connection.isClosed).toBe(true)
  })
})

describe('steering', () => {
  it('sends into the running turn by its id, and leaves the message without one', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    expect(await connection.steer('thread-1', [{ type: 'text', text: 'early' }])).toBe(
      'promptRequired',
    )
    const prompt = connection.prompt('thread-1', [{ type: 'text', text: 'go' }])
    await until(() => server.sent('turn/start').length === 1)
    server.notify('turn/started', { threadId: 'thread-1', turn: turn('turn-1') })
    await tick()
    expect(await connection.steer('thread-1', [{ type: 'text', text: 'also' }])).toBe('injected')
    expect(server.sent('turn/steer')).toEqual([
      {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'also', text_elements: [] }],
        expectedTurnId: 'turn-1',
      },
    ])
    // The turn ended on Codex's side before Kettu heard of it.
    server.on('turn/steer', () => {
      throw new FakeRpcError(-32600, 'no active turn to steer')
    })
    expect(await connection.steer('thread-1', [{ type: 'text', text: 'late' }])).toBe(
      'promptRequired',
    )
    server.notify('turn/completed', { threadId: 'thread-1', turn: turn('turn-1', 'completed') })
    await prompt
    expect(await connection.steer('thread-1', [{ type: 'text', text: 'after' }])).toBe(
      'promptRequired',
    )
  })
})

describe('history from an earlier agent', () => {
  it('appends it to the thread as Responses API messages', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    server.on('thread/inject_items', () => ({}))
    const injected = await connection.injectHistory('thread-1', [
      { role: 'user', text: 'Turn 1, the user' },
      { role: 'assistant', text: 'Turn 1, Claude Code' },
    ])
    expect(injected).toBe(true)
    expect(server.sent('thread/inject_items')).toEqual([
      {
        threadId: 'thread-1',
        items: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Turn 1, the user' }],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Turn 1, Claude Code' }],
          },
        ],
      },
    ])
  })

  it('answers false on a Codex without it, so the history goes with the prompt', async () => {
    const { connection } = await connect()
    await connection.newSession('/project')
    expect(await connection.injectHistory('thread-1', [{ role: 'user', text: 'x' }])).toBe(false)
  })
})

describe('approvals', () => {
  it('asks with the decisions the request lists, and sends the one picked', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    const t = threadTarget((request) => ({
      optionId: request.options.find((o) => o.kind === 'allow_always')!.id,
    }))
    connection.register('thread-1', t.target)
    const { answer } = server.request('item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'exec-1',
      reason: 'Write a file',
      command: "/bin/zsh -lc 'touch a'",
      cwd: '/project',
      commandActions: [{ type: 'unknown', command: 'touch a' }],
      availableDecisions: [
        'accept',
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch'] } },
        'cancel',
      ],
    })
    expect(await answer).toEqual({
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch'] } },
    })
    const request = t.requests[0]!.request
    expect(request.toolEntryId).toBe('t:exec-1')
    expect(request.options).toEqual([
      { id: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      {
        id: 'accept_execpolicy_amendment',
        name: 'Always allow `touch`',
        kind: 'allow_always',
      },
      { id: 'cancel', name: 'Deny, and say what to do instead', kind: 'reject_once' },
    ])
    expect(t.entry('t:exec-1')).toMatchObject({
      toolKind: 'execute',
      rawInput: 'touch a',
      status: 'pending',
      description: 'Write a file',
    })
  })

  it('offers the usual decisions when the request lists none, and cancels an unanswered one', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    const t = threadTarget(() => 'cancelled')
    connection.register('thread-1', t.target)
    const { answer } = server.request('item/fileChange/requestApproval', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'patch-1',
    })
    expect(await answer).toEqual({ decision: 'cancel' })
    expect(t.requests[0]!.request.options.map((o) => [o.id, o.kind])).toEqual([
      ['allow_once', 'allow_once'],
      ['allow_for_session', 'allow_always'],
      ['cancel', 'reject_once'],
      ['decline', 'reject_once'],
    ])
    expect(t.entry('t:patch-1')).toMatchObject({ toolKind: 'edit' })
  })

  it('withdraws a request app-server resolved elsewhere', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    const t = threadTarget(
      (request) =>
        new Promise<PermissionAnswer>((_, reject) => {
          const { signal } = t.requests.find((r) => r.request === request)!
          signal.addEventListener('abort', () => reject(signal.reason as Error))
        }),
    )
    connection.register('thread-1', t.target)
    const { id } = server.request('item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'exec-1',
      command: 'ls',
    })
    await until(() => t.requests.length === 1)
    server.notify('serverRequest/resolved', { threadId: 'thread-1', requestId: id })
    await until(() => t.requests[0]!.signal.aborted)
  })

  it('never approves for a session Kettu does not have', async () => {
    const { server } = await connect()
    const { answer } = server.request('item/commandExecution/requestApproval', {
      threadId: 'elsewhere',
      turnId: 'turn-1',
      itemId: 'exec-1',
    })
    expect(await answer).toEqual({ decision: 'decline' })
  })

  it('asks a question with choices and Something else', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    const t = threadTarget((request) => ({ optionId: request.options[1]!.id }))
    connection.register('thread-1', t.target)
    const asked = server.request('item/tool/requestUserInput', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'ask-1',
      questions: [{ ...question, options: [choice('A'), choice('B', 'The second way')] }],
    })
    expect(await asked.answer).toEqual({ answers: { q: { answers: ['B'] } } })
    expect(t.requests[0]!.request.options).toEqual([
      { id: 'answer:0', name: 'A', kind: 'allow_once' },
      { id: 'answer:1', name: 'B', kind: 'allow_once', description: 'The second way' },
      { id: 'other', name: 'Something else…', kind: 'reject_once' },
    ])
    expect(t.entry('t:ask-1')).toMatchObject({
      toolKind: 'other',
      title: 'Plan',
      question: 'Which one?',
    })
  })

  it('asks every question of one ask in one request and answers them together', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    const t = threadTarget(() => ({
      answers: [
        { question: 0, choices: [1] },
        { question: 2, choices: [], text: 'Because' },
      ],
    }))
    connection.register('thread-1', t.target)
    const asked = server.request('item/tool/requestUserInput', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'ask-1',
      questions: [
        { ...question, options: [choice('A'), choice('B')] },
        {
          ...question,
          id: 'r',
          header: 'Reply',
          question: 'Which reply?',
          isOther: true,
          options: [choice('X')],
        },
        { ...question, id: 'why', header: 'Why', question: 'Why?', options: null },
      ],
    })
    expect(await asked.answer).toEqual({
      answers: { q: { answers: ['B'] }, why: { answers: ['Because'] } },
    })
    expect(t.requests).toHaveLength(1)
    expect(t.requests[0]!.request.questions?.map((q) => [q.question, q.allowsText])).toEqual([
      ['Which one?', false],
      ['Which reply?', true],
      ['Why?', true],
    ])
    expect(t.entry('t:ask-1')).toMatchObject({ title: 'Plan', question: 'Which one?' })
  })

  it('answers none when every question was skipped or the ask was cancelled', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    let reply: PermissionAnswer = { answers: [] }
    const t = threadTarget(() => reply)
    connection.register('thread-1', t.target)
    const ask = (itemId: string) =>
      server.request('item/tool/requestUserInput', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId,
        questions: [
          { ...question, options: [choice('A'), choice('B')] },
          { ...question, id: 'r', options: null },
        ],
      })
    expect(await ask('ask-1').answer).toEqual({ answers: {} })
    reply = 'cancelled'
    expect(await ask('ask-2').answer).toEqual({ answers: {} })
  })

  it('answers the first question alone to a client that sends an option id', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    const t = threadTarget(() => ({ optionId: 'answer:0' }))
    connection.register('thread-1', t.target)
    const asked = server.request('item/tool/requestUserInput', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'ask-1',
      questions: [
        { ...question, options: [choice('A'), choice('B')] },
        { ...question, id: 'r', options: [choice('X')] },
      ],
    })
    expect(await asked.answer).toEqual({ answers: { q: { answers: ['A'] } } })
  })

  it('gives Codex a secret answer without it reaching a log or the thread', async () => {
    const { server, connection, logs, ignored } = await connect()
    await connection.newSession('/project')
    const t = threadTarget(() => ({ answers: [{ question: 0, choices: [], text: 'hunter2' }] }))
    connection.register('thread-1', t.target)
    const asked = server.request('item/tool/requestUserInput', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'ask-1',
      questions: [
        { ...question, id: 'token', question: 'Your token?', isSecret: true, options: null },
      ],
    })
    expect(await asked.answer).toEqual({ answers: { token: { answers: ['hunter2'] } } })
    expect(t.requests[0]!.request.questions).toEqual([
      expect.objectContaining({ allowsText: true, secret: true, options: [] }),
    ])
    const kept = JSON.stringify([logs, ignored, t.entry('t:ask-1')])
    expect(kept).not.toContain('hunter2')
  })

  it('asks nothing when the ask holds no question', async () => {
    const { server, connection, ignored } = await connect()
    await connection.newSession('/project')
    const t = threadTarget()
    connection.register('thread-1', t.target)
    const asked = server.request('item/tool/requestUserInput', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'ask-1',
      questions: [],
    })
    expect(await asked.answer).toEqual({ answers: {} })
    expect(t.requests).toHaveLength(0)
    expect(ignored).toHaveLength(1)
  })

  it('grants more permissions for the turn, never through a routine’s scope', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    const t = threadTarget((request) => ({ optionId: request.options[0]!.id }))
    connection.register('thread-1', t.target)
    const permissions = { network: { enabled: true } }
    const { answer } = server.request('item/permissions/requestApproval', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'perm-1',
      cwd: '/project',
      reason: null,
      permissions,
    })
    expect(await answer).toEqual({ permissions, scope: 'turn' })
    expect(t.entry('t:perm-1')).toMatchObject({ toolKind: 'other' })
  })
})

describe('a question Codex asks without waiting', () => {
  const asyncMessage = (id: string, questions: unknown) => ({
    type: 'agentMessage',
    id,
    text: 'Which one?',
    phase: 'final_answer',
    delivery: 'async',
    questions,
  })
  const at = { threadId: 'thread-1', turnId: 'turn-1' }

  it('asks it in the question card and answers it into the running turn', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    const t = threadTarget(() => ({ answers: [{ question: 0, choices: [1] }] }))
    connection.register('thread-1', t.target)
    server.notify('item/completed', {
      ...at,
      item: asyncMessage('call_1', [{ title: 'Which one?', options: ['A', 'B'] }]),
    })
    await until(() => t.sent.length > 0)
    expect(t.requests).toHaveLength(1)
    expect(t.requests[0]!.request).toMatchObject({
      toolEntryId: 't:call_1',
      nonBlocking: true,
      questions: [
        {
          question: 'Which one?',
          multiSelect: false,
          allowsText: true,
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    })
    expect(t.entry('t:call_1')).toMatchObject({
      kind: 'tool',
      status: 'completed',
      question: 'Which one?',
    })
    expect(t.entries().some((entry) => entry.kind === 'agent')).toBe(false)
    expect(t.sentNow).toEqual(t.approvals)
    expect(t.sent).toEqual([
      '<send_user_message_question_reply>\n' +
        '[{"questionItemId":"[\\"request_user_input_async\\",\\"call_1\\",0]","question":"Which one?","answer":"B"}]\n' +
        '</send_user_message_question_reply>',
    ])
  })

  it('sends the words the user wrote for a question without choices', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    const t = threadTarget(() => ({ answers: [{ question: 0, choices: [], text: 'Soon' }] }))
    connection.register('thread-1', t.target)
    server.notify('item/completed', {
      ...at,
      item: asyncMessage('call_2', [{ title: 'When?', options: null }]),
    })
    await until(() => t.sent.length > 0)
    expect(t.requests[0]!.request.questions?.[0]).toMatchObject({ options: [], allowsText: true })
    expect(JSON.parse(t.sent[0]!.split('\n')[1]!)).toEqual([
      {
        questionItemId: '["request_user_input_async","call_2",0]',
        question: 'When?',
        answer: 'Soon',
      },
    ])
  })

  it('answers only the questions the user answered', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    const t = threadTarget(() => ({ answers: [{ question: 1, choices: [0] }] }))
    connection.register('thread-1', t.target)
    server.notify('item/completed', {
      ...at,
      item: asyncMessage('call_3', [
        { title: 'First?', options: ['x'] },
        { title: 'Second?', options: ['y', 'z'] },
      ]),
    })
    await until(() => t.sent.length > 0)
    expect(JSON.parse(t.sent[0]!.split('\n')[1]!)).toEqual([
      {
        questionItemId: '["request_user_input_async","call_3",1]',
        question: 'Second?',
        answer: 'y',
      },
    ])
  })

  it('asks once for an item that starts and completes, and sends nothing when skipped', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    const t = threadTarget(() => 'cancelled')
    connection.register('thread-1', t.target)
    const item = asyncMessage('call_4', [{ title: 'Which one?', options: ['A'] }])
    server.notify('item/started', { ...at, item })
    server.notify('item/completed', { ...at, item })
    await until(() => t.requests.length > 0)
    await tick()
    expect(t.requests).toHaveLength(1)
    expect(t.sent).toEqual([])
  })

  it('shows an asynchronous message with no question as a message', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    const t = threadTarget()
    connection.register('thread-1', t.target)
    server.notify('item/completed', { ...at, item: asyncMessage('call_5', null) })
    await tick()
    expect(t.requests).toHaveLength(0)
    expect(t.entries().find((entry) => entry.kind === 'agent')).toMatchObject({
      markdown: 'Which one?',
    })
  })
})

describe('a plan', () => {
  /** A turn in plan mode that proposes `markdown`, ending normally. */
  async function planTurn(
    answer: (request: PermissionRequest) => PermissionAnswer | Promise<PermissionAnswer>,
  ) {
    const c = await connect()
    await c.connection.newSession('/project')
    await c.connection.setConfigOption('thread-1', 'collaboration_mode', 'plan')
    const t = threadTarget(answer)
    c.connection.register('thread-1', t.target)
    const prompt = c.connection.prompt('thread-1', [{ type: 'text', text: 'Plan it' }])
    await until(() => c.server.sent('turn/start').length === 1)
    const at = { threadId: 'thread-1', turnId: 'turn-1' }
    c.server.notify('turn/started', { threadId: 'thread-1', turn: turn('turn-1') })
    c.server.notify('item/started', { ...at, item: { type: 'plan', id: 'plan-1', text: '' } })
    c.server.notify('item/plan/delta', { ...at, itemId: 'plan-1', delta: '# Plan\n' })
    c.server.notify('item/plan/delta', { ...at, itemId: 'plan-1', delta: '1. Edit' })
    c.server.notify('item/completed', {
      ...at,
      item: { type: 'plan', id: 'plan-1', text: '# Plan\n1. Edit\n' },
    })
    c.server.notify('turn/completed', { threadId: 'thread-1', turn: turn('turn-1', 'completed') })
    expect(await prompt).toMatchObject({ stopReason: 'end_turn' })
    return { ...c, t }
  }

  it('shows the plan as a plan to approve, and asks once the turn has ended', async () => {
    const { t } = await planTurn(() => 'cancelled')
    await until(() => t.requests.length === 1)
    expect(t.entry('t:plan-1')).toMatchObject({
      kind: 'tool',
      title: 'Plan',
      toolKind: 'switch_mode',
      status: 'completed',
      content: [{ type: 'markdown', markdown: '# Plan\n1. Edit\n' }],
      planVersion: 1,
    })
    expect(t.entries().some((entry) => entry.kind === 'agent')).toBe(false)
    const { request } = t.requests[0]!
    expect(request).toMatchObject({ toolEntryId: 't:plan-1', plan: '# Plan\n1. Edit\n' })
    expect(request.options).toEqual([
      {
        id: 'implement',
        name: 'Yes, implement this plan',
        description: 'Leaves Plan mode; Codex keeps its permission mode, Auto review',
        kind: 'allow_once',
        preferred: true,
      },
      { id: 'keep_planning', name: 'No, keep planning', kind: 'reject_once', note: true },
    ])
    expect(t.sent).toEqual([])
  })

  it('implements the plan in default mode, in a turn of its own', async () => {
    const { t, connection, server } = await planTurn(() => ({ optionId: 'implement' }))
    await until(() => t.sent.length === 1)
    expect(t.sent).toEqual(['Implement the plan.'])
    expect(t.approvals).toEqual(['Implement the plan.'])
    const prompt = connection.prompt('thread-1', [{ type: 'text', text: t.sent[0]! }])
    await until(() => server.sent('turn/start').length === 2)
    expect(server.sent('turn/start')[1]).toMatchObject({
      input: [{ type: 'text', text: 'Implement the plan.', text_elements: [] }],
      collaborationMode: { mode: 'default' },
    })
    server.notify('turn/completed', { threadId: 'thread-1', turn: turn('turn-2', 'completed') })
    await prompt
  })

  it('keeps planning with the note as the next message, or waits for one', async () => {
    const withNote = await planTurn(() => ({ optionId: 'keep_planning', note: 'Add tests' }))
    await until(() => withNote.t.sent.length === 1)
    expect(withNote.t.sent).toEqual(['Add tests'])
    expect(withNote.t.approvals).toEqual([])
    const prompt = withNote.connection.prompt('thread-1', [{ type: 'text', text: 'Add tests' }])
    await until(() => withNote.server.sent('turn/start').length === 2)
    expect(withNote.server.sent('turn/start')[1]).toMatchObject({
      collaborationMode: { mode: 'plan' },
    })
    withNote.server.notify('turn/completed', {
      threadId: 'thread-1',
      turn: turn('turn-2', 'completed'),
    })
    await prompt
    const without = await planTurn(() => ({ optionId: 'keep_planning' }))
    await until(() => without.t.requests.length === 1)
    await tick()
    expect(without.t.sent).toEqual([])
  })

  it('asks nothing for a plan a replay brings back', async () => {
    const { server, connection } = await connect()
    server.history.set('thread-old', [
      { turnId: 'turn-1', item: { type: 'plan', id: 'plan-1', text: 'Old plan' } },
    ])
    const t = threadTarget()
    t.state.replaying = true
    connection.register('thread-old', t.target)
    await connection.loadSession('thread-old', '/project')
    await tick()
    expect(t.entry('t:plan-1')).toMatchObject({ planVersion: 1, status: 'completed' })
    expect(t.requests).toHaveLength(0)
  })
})

describe("an MCP server's request", () => {
  const form = {
    threadId: 'thread-1',
    turnId: 'turn-1',
    serverName: 'linear',
    mode: 'form',
    _meta: null,
    message: 'Pick a team',
    requestedSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', title: 'Team', oneOf: [{ const: 'eng', title: 'Engineering' }] },
        notify: { type: 'boolean' },
      },
      required: ['team'],
    },
  }

  it('asks with the form, and sends the values submitted', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    const t = threadTarget(() => ({ values: { team: 'eng', notify: true } }))
    connection.register('thread-1', t.target)
    const { answer, id } = server.request('mcpServer/elicitation/request', form)
    expect(await answer).toEqual({
      action: 'accept',
      content: { team: 'eng', notify: true },
      _meta: null,
    })
    const { request } = t.requests[0]!
    expect(request.elicitation).toEqual({
      kind: 'form',
      server: 'linear',
      message: 'Pick a team',
      fields: [
        {
          key: 'team',
          title: 'Team',
          required: true,
          type: 'choice',
          choices: [{ value: 'eng', label: 'Engineering' }],
        },
        { key: 'notify', title: 'notify', required: false, type: 'boolean' },
      ],
    })
    expect(request.options.map((o) => [o.id, o.kind])).toEqual([
      ['accept', 'allow_once'],
      ['decline', 'reject_once'],
    ])
    expect(t.entry(`t:elicitation:${id}`)).toMatchObject({
      title: 'linear needs some details',
      status: 'completed',
      elicitation: { server: 'linear', kind: 'form' },
    })
  })

  it('declines or cancels a form as the user answered', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    let reply: PermissionAnswer = { optionId: 'decline' }
    const t = threadTarget(() => reply)
    connection.register('thread-1', t.target)
    expect(await server.request('mcpServer/elicitation/request', form).answer).toEqual({
      action: 'decline',
      content: null,
      _meta: null,
    })
    reply = 'cancelled'
    expect(await server.request('mcpServer/elicitation/request', form).answer).toEqual({
      action: 'cancel',
      content: null,
      _meta: null,
    })
  })

  it('offers to open a web page, and declines any other address unasked', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    const t = threadTarget(() => ({ optionId: 'accept' }))
    connection.register('thread-1', t.target)
    const page = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      serverName: 'linear',
      mode: 'url',
      _meta: null,
      message: 'Sign in',
      url: 'https://linear.app/oauth',
      elicitationId: 'el-1',
    }
    expect(await server.request('mcpServer/elicitation/request', page).answer).toEqual({
      action: 'accept',
      content: null,
      _meta: null,
    })
    expect(t.requests[0]!.request.elicitation).toEqual({
      kind: 'url',
      server: 'linear',
      message: 'Sign in',
      url: 'https://linear.app/oauth',
    })
    expect(
      await server.request('mcpServer/elicitation/request', { ...page, url: 'file:///etc/hosts' })
        .answer,
    ).toEqual({ action: 'decline', content: null, _meta: null })
    expect(t.requests).toHaveLength(1)
  })
})

describe('forks', () => {
  const items = [
    {
      turnId: 'turn-1',
      item: {
        type: 'userMessage',
        id: 'u1',
        content: [{ type: 'text', text: 'one', text_elements: [] }],
      },
    },
    {
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'msg_a', text: 'Done', phase: 'final_answer' },
    },
    {
      turnId: 'turn-2',
      item: {
        type: 'userMessage',
        id: 'u2',
        content: [{ type: 'text', text: 'two', text_elements: [] }],
      },
    },
    {
      turnId: 'turn-2',
      item: { type: 'agentMessage', id: 'msg_b', text: 'Done', phase: 'final_answer' },
    },
    {
      turnId: 'turn-3',
      item: { type: 'agentMessage', id: 'msg_c', text: 'Last', phase: 'final_answer' },
    },
  ] as const

  it('forks through the turn of the message, keeping the source’s settings for its turns', async () => {
    const { server, connection } = await connect()
    server.history.set('thread-src', items as never)
    server.on('thread/resume', (params) =>
      threadResponse(params.threadId as string, { model: 'gpt-5.6-luna', reasoningEffort: 'low' }),
    )
    await connection.resumeSession('thread-src', '/project')
    await connection.setConfigOption('thread-src', 'mode', 'read-only')
    const fork = await connection.forkSession(
      'thread-src',
      '/project',
      {},
      {
        messageId: 'msg_a',
        text: 'Done',
        occurrence: 1,
      },
    )
    expect(server.sent('thread/fork')[0]).toMatchObject({
      threadId: 'thread-src',
      lastTurnId: 'turn-1',
      model: 'gpt-5.6-luna',
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      ephemeral: false,
    })
    expect(fork.config.find((o) => o.id === 'model')?.value).toBe('gpt-5.6-luna')
    expect(fork.config.find((o) => o.id === 'mode')?.value).toBe('read-only')
    const prompt = connection.prompt(fork.sessionId, [{ type: 'text', text: 'more' }])
    await until(() => server.sent('turn/start').length === 1)
    expect(server.sent('turn/start')[0]).toMatchObject({
      threadId: fork.sessionId,
      model: 'gpt-5.6-luna',
      effort: 'low',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    })
    server.notify('turn/completed', { threadId: fork.sessionId, turn: turn('turn-1', 'completed') })
    await prompt
  })

  it('finds a message Codex does not know by its text and how often it came', async () => {
    const { server, connection } = await connect()
    server.history.set('thread-src', items as never)
    await connection.forkSession(
      'thread-src',
      '/project',
      {},
      {
        messageId: 'adapter-message',
        text: 'Done',
        occurrence: 2,
      },
    )
    expect(server.sent('thread/fork')[0]).toMatchObject({ lastTurnId: 'turn-2' })
    await expect(
      connection.forkSession(
        'thread-src',
        '/project',
        {},
        { messageId: 'x', text: 'Nope', occurrence: 1 },
      ),
    ).rejects.toBeInstanceOf(AgentRequestError)
  })
})

describe('a replay', () => {
  it('replays the history with attachments back as Kettu sent them', async () => {
    const { server, connection } = await connect()
    const png = 'iVBORw0KGgo='
    server.history.set('thread-old', [
      {
        turnId: 'turn-1',
        item: {
          type: 'userMessage',
          id: 'u1',
          content: [
            { type: 'text', text: 'Look at this', text_elements: [] },
            { type: 'text', text: '[@a.ts](file:///project/a.ts)', text_elements: [] },
            { type: 'image', url: `data:image/png;base64,${png}` },
          ],
        },
      },
      { turnId: 'turn-1', item: { type: 'reasoning', id: 'rs_1', summary: ['Hm'], content: [] } },
      {
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'msg_1', text: 'Seen', phase: 'final_answer' },
      },
    ])
    const t = threadTarget()
    t.state.replaying = true
    connection.register('thread-old', t.target)
    await connection.loadSession('thread-old', '/project')
    const [user, thought, agent] = t.entries()
    expect(user).toMatchObject({ kind: 'user', id: 'm:u1' })
    expect(
      user?.kind === 'user' && user.content.map((c) => (c.type === 'text' ? c.text : c.ref.kind)),
    ).toEqual(['Look at this', 'attachment', 'attachment'])
    expect(thought).toMatchObject({ kind: 'thought', markdown: 'Hm', streaming: false })
    expect(agent).toMatchObject({ kind: 'agent', markdown: 'Seen', streaming: false })
    expect(t.effects).toContainEqual(
      expect.objectContaining({
        kind: 'replayImage',
        entryId: 'm:u1',
        mimeType: 'image/png',
        data: png,
      }),
    )
    expect(server.sent('thread/resume')[0]).toMatchObject({
      threadId: 'thread-old',
      excludeTurns: true,
    })
  })

  it('replays legacy rollouts via thread/read when resuming a moved thread into a target project', async () => {
    const { server, connection } = await connect()
    server.on('thread/resume', (params) => {
      const { threadId, cwd } = params as { threadId: string; cwd: string }
      const base = threadResponse(threadId)
      return {
        ...base,
        cwd,
        thread: { ...base.thread, cwd, historyMode: 'legacy' },
      }
    })
    server.on('thread/items/list', () => {
      throw new FakeRpcError(-32601, 'thread/items/list is not supported yet')
    })
    server.on('thread/read', () => ({
      thread: {
        ...threadResponse('thread-moved').thread,
        cwd: '/new/target-project',
        historyMode: 'legacy',
        turns: [
          {
            id: 'turn-1',
            status: 'completed',
            error: null,
            items: [
              {
                type: 'userMessage',
                id: 'u1',
                content: [{ type: 'text', text: 'Inspect moved repo', text_elements: [] }],
              },
              {
                type: 'agentMessage',
                id: 'a1',
                text: 'History preserved.',
                phase: 'final_answer',
              },
            ],
          },
        ],
      },
    }))

    const t = threadTarget()
    t.state.replaying = true
    connection.register('thread-moved', t.target)
    await connection.loadSession('thread-moved', '/new/target-project')

    expect(server.sent('thread/resume')[0]).toMatchObject({
      threadId: 'thread-moved',
      cwd: '/new/target-project',
    })
    expect(server.sent('thread/read')[0]).toEqual({
      threadId: 'thread-moved',
      includeTurns: true,
    })
    const [user, agent] = t.entries()
    expect(user).toMatchObject({ kind: 'user', id: 'm:u1' })
    expect(agent).toMatchObject({ kind: 'agent', markdown: 'History preserved.', streaming: false })
  })
})

describe('hidden sessions', () => {
  it('opens them as ephemeral threads and only unsubscribes from them', async () => {
    const { server, connection } = await connect()
    expect(connection.hiddenSessions).toBe(true)
    const hidden = await connection.newSession('/project', { hidden: 'options' })
    expect(server.sent('thread/start')[0]).toMatchObject({ ephemeral: true })
    const logged: string[] = []
    await connection.removeHidden(hidden.sessionId, (m) => logged.push(m))
    expect(server.sent('thread/unsubscribe')).toEqual([{ threadId: hidden.sessionId }])
    expect(server.sent('thread/delete')).toEqual([])
    expect(logged).toEqual([])
  })

  it('deletes a prepared session that was prompted, and leaves one from an earlier run alone', async () => {
    const { server, connection } = await connect()
    const prepared = await connection.newSession('/project')
    const prompt = connection.prompt(prepared.sessionId, [{ type: 'text', text: 'go' }])
    await until(() => server.sent('turn/start').length === 1)
    server.notify('turn/completed', {
      threadId: prepared.sessionId,
      turn: turn('turn-1', 'completed'),
    })
    await prompt
    await connection.removeHidden(prepared.sessionId, () => {})
    expect(server.sent('thread/delete')).toEqual([{ threadId: prepared.sessionId }])
    await connection.removeHidden('thread-from-before', () => {})
    expect(server.sent('thread/unsubscribe')).toEqual([])
  })

  it('collects a hidden session’s replies', async () => {
    const { server, connection } = await connect()
    const hidden = await connection.newSession('/project', { hidden: 'titles' })
    const collected = connection.collect(hidden.sessionId, 'Title this')
    await until(() => server.sent('turn/start').length === 1)
    const at = { threadId: hidden.sessionId, turnId: 'turn-1' }
    server.notify('item/completed', {
      ...at,
      item: { type: 'agentMessage', id: 'm', text: 'A title', phase: null },
    })
    server.notify('turn/completed', {
      threadId: hidden.sessionId,
      turn: turn('turn-1', 'completed'),
    })
    expect(await collected).toEqual(['A title'])
  })
})

describe('side questions', () => {
  it('forks the thread as it stands, read only, with its tools but none auto-allowed', async () => {
    const { server, connection } = await connect()
    const opened = await connection.newSession('/project')
    const texts: string[] = []
    const steps: SideChatStep[] = []
    const asking = connection.sideQuestion!(
      opened.sessionId,
      {
        question: 'Why?',
        history: [{ question: 'What?', answer: 'That.' }],
        options: {
          mcpServers: [
            {
              type: 'http',
              name: 'kettu',
              url: 'http://127.0.0.1:1/mcp',
              headers: [],
              autoAllow: ['set_plan'],
              prompt: 'Kettu tools.',
            },
          ],
        },
      },
      { text: (answer) => texts.push(answer), step: (step) => steps.push(step) },
      new AbortController().signal,
    )
    await until(() => server.sent('turn/start').length === 1)
    const fork = server.sent('thread/fork')[0] as {
      config: { mcp_servers: Record<string, Record<string, unknown>> }
      developerInstructions: string
    }
    expect(fork).toMatchObject({
      threadId: opened.sessionId,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
    })
    // Without a last turn Codex forks the history as it stands, a running turn's done parts too.
    expect(fork).not.toHaveProperty('lastTurnId')
    expect(server.sent('thread/turns/list')).toEqual([])
    expect(fork.config.mcp_servers.kettu).not.toHaveProperty('tools')
    expect(fork.developerInstructions).toBe(`Kettu tools.\n\n${SIDE_INSTRUCTIONS}`)
    const start = server.sent('turn/start')[0] as { threadId: string }
    expect(JSON.stringify(start)).toContain('Q: What?')
    const at = { threadId: start.threadId, turnId: 'turn-1' }
    server.notify('item/started', {
      ...at,
      item: {
        type: 'commandExecution',
        id: 'c',
        command: 'rg cleanup',
        cwd: '/project',
        status: 'inProgress',
        commandActions: [{ type: 'search', command: 'rg cleanup', query: 'cleanup', path: null }],
        aggregatedOutput: null,
        exitCode: null,
      },
    })
    server.notify('item/agentMessage/delta', { ...at, itemId: 'm', delta: 'Be' })
    server.notify('item/agentMessage/delta', { ...at, itemId: 'm', delta: 'cause.' })
    server.notify('item/completed', {
      ...at,
      item: { type: 'agentMessage', id: 'm', text: 'Because.', phase: null },
    })
    server.notify('turn/completed', { threadId: start.threadId, turn: turn('turn-1', 'completed') })
    expect(await asking).toMatchObject({ text: 'Because.', synthetic: false })
    expect(texts).toEqual(['Be', 'Because.', 'Because.'])
    expect(steps).toEqual([{ kind: 'search', title: 'cleanup' }])
    expect(server.sent('thread/unsubscribe')).toContainEqual({ threadId: start.threadId })
  })

  it('forks a thread whose first turn still runs, with no last turn named', async () => {
    const { server, connection } = await connect()
    const opened = await connection.newSession('/project')
    void connection.prompt(opened.sessionId, [{ type: 'text', text: 'go' }]).catch(() => {})
    await until(() => server.sent('turn/start').length === 1)
    const asking = connection.sideQuestion!(
      opened.sessionId,
      { question: 'Why?', history: [] },
      { text: () => {}, step: () => {} },
      new AbortController().signal,
    )
    await until(() => server.sent('turn/start').length === 2)
    expect(server.sent('thread/fork')).toHaveLength(1)
    expect(server.sent('thread/fork')[0]).not.toHaveProperty('lastTurnId')
    const start = server.sent('turn/start')[1] as { threadId: string }
    expect(start.threadId).not.toBe(opened.sessionId)
    server.notify('item/completed', {
      threadId: start.threadId,
      turnId: 'turn-2',
      item: { type: 'agentMessage', id: 'm', text: 'Because.', phase: null },
    })
    server.notify('turn/completed', { threadId: start.threadId, turn: turn('turn-2', 'completed') })
    expect(await asking).toMatchObject({ text: 'Because.', synthetic: false })
  })
})

describe('limits and subagents', () => {
  it('reports a subagent thread to its parent, with its turns, and stops it on its own', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    const parent = threadTarget()
    connection.register('thread-1', parent.target)
    server.notify('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'collabAgentToolCall',
        id: 'call-1',
        tool: 'spawnAgent',
        status: 'inProgress',
        senderThreadId: 'thread-1',
        receiverThreadIds: ['child-1'],
        prompt: 'Look around',
        agentsStates: {},
      },
    })
    server.notify('thread/started', {
      thread: {
        ...threadResponse('child-1').thread,
        parentThreadId: 'thread-1',
        agentNickname: 'Scout',
      },
    })
    server.notify('turn/started', { threadId: 'child-1', turn: turn('child-turn') })
    server.notify('thread/tokenUsage/updated', {
      threadId: 'child-1',
      turnId: 'child-turn',
      tokenUsage: { total: usage(10, 8, 0, 2), last: usage(10, 8, 0, 2), modelContextWindow: 1000 },
    })
    await until(() => parent.effects.filter((e) => e.kind === 'subagent').length >= 3)
    expect(connection.rootOf('child-1')).toBe('thread-1')
    await connection.cancel('child-1')
    expect(server.sent('turn/interrupt')).toEqual([{ threadId: 'child-1', turnId: 'child-turn' }])
    server.notify('turn/completed', {
      threadId: 'child-1',
      turn: turn('child-turn', 'interrupted'),
    })
    await until(() => parent.effects.filter((e) => e.kind === 'subagent').length >= 4)
    expect(parent.effects.filter((e) => e.kind === 'subagent')).toEqual([
      { kind: 'subagent', sessionId: 'child-1', canCancel: true, description: 'Look around' },
      { kind: 'subagent', sessionId: 'child-1', canCancel: true, title: 'Scout' },
      { kind: 'subagent', sessionId: 'child-1', state: { kind: 'running' } },
      {
        kind: 'subagent',
        sessionId: 'child-1',
        state: {
          kind: 'idle',
          stopReason: 'cancelled',
          error: null,
          tokens: { total: 10, input: 8, output: 2, thought: 4, cacheRead: 0, cacheWrite: 0 },
        },
      },
    ])
    expect(parent.entry('t:call-1')).toMatchObject({ title: 'Start subagent', toolKind: 'other' })
  })

  it('reports what it does not use', async () => {
    const { server, connection, ignored } = await connect()
    await connection.newSession('/project')
    connection.register('thread-1', threadTarget().target)
    server.notify('item/someNewThing', { threadId: 'thread-1' })
    server.notify('turn/diff/updated', { threadId: 'thread-1', turnId: 't', diff: '' })
    await until(() => ignored.length > 0)
    expect(ignored).toEqual(['notification item/someNewThing'])
  })
})

describe('fast mode', () => {
  it('omits serviceTier on turns and settings updates when the model advertises no fast tier', async () => {
    const { server, connection } = await connect()
    server.on('model/list', () => ({
      data: [
        ...FAKE_MODELS,
        {
          id: 'custom-gateway-model',
          displayName: 'custom-gateway-model',
          description: 'Custom model without serviceTiers',
          supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
          defaultReasoningEffort: 'medium',
          isDefault: false,
        },
      ],
      nextCursor: null,
    }))
    server.on('thread/start', () =>
      threadResponse('thread-custom', {
        model: 'custom-gateway-model',
        reasoningEffort: 'medium',
        serviceTier: 'fast',
      }),
    )
    const opened = await connection.newSession('/project')
    // Do not force-show the Fast mode toggle when model/list advertises no fast tier.
    expect(opened.config.find((o) => o.id === 'fast-mode')).toBeUndefined()

    const prompt = connection.prompt(opened.sessionId, [{ type: 'text', text: 'hello' }])
    await until(() => server.sent('turn/start').length === 1)
    expect(server.sent('turn/start')[0]).not.toHaveProperty('serviceTier')
    server.notify('turn/completed', {
      threadId: opened.sessionId,
      turn: turn('turn-1', 'completed'),
    })
    await prompt

    const compact = connection.prompt(opened.sessionId, [{ type: 'text', text: '/compact' }])
    await until(() => server.sent('thread/settings/update').length === 1)
    expect(server.sent('thread/settings/update')[0]).not.toHaveProperty('serviceTier')
    server.notify('turn/started', { threadId: opened.sessionId, turn: turn('turn-2') })
    server.notify('turn/completed', {
      threadId: opened.sessionId,
      turn: turn('turn-2', 'completed'),
    })
    await compact
  })

  it('omits serviceTier when switching to a model without fast support and restores it when switching back', async () => {
    const { server, connection } = await connect()
    const opened = await connection.newSession('/project')
    await connection.setConfigOption(opened.sessionId, 'fast-mode', true)

    const switched = await connection.setConfigOption(opened.sessionId, 'model', 'gpt-5.6-luna')
    expect(switched.find((o) => o.id === 'fast-mode')).toBeUndefined()

    const first = connection.prompt(opened.sessionId, [{ type: 'text', text: 'on luna' }])
    await until(() => server.sent('turn/start').length === 1)
    expect(server.sent('turn/start')[0]).not.toHaveProperty('serviceTier')
    server.notify('turn/completed', {
      threadId: opened.sessionId,
      turn: turn('turn-1', 'completed'),
    })
    await first

    const back = await connection.setConfigOption(opened.sessionId, 'model', 'gpt-6.1-sol')
    expect(back.find((o) => o.id === 'fast-mode')?.value).toBe(true)

    const second = connection.prompt(opened.sessionId, [{ type: 'text', text: 'on sol' }])
    await until(() => server.sent('turn/start').length === 2)
    expect(server.sent('turn/start')[1]).toMatchObject({ serviceTier: 'priority' })
    server.notify('turn/completed', {
      threadId: opened.sessionId,
      turn: turn('turn-2', 'completed'),
    })
    await second
  })

  it('treats fast and priority as aliases when reading initial and resumed serviceTier', async () => {
    const { server, connection } = await connect()
    // Model advertises serviceTiers id 'priority', while thread/start reports 'fast'.
    server.on('thread/start', () => threadResponse('thread-fast-alias', { serviceTier: 'fast' }))
    const opened = await connection.newSession('/project')
    expect(opened.config.find((o) => o.id === 'fast-mode')?.value).toBe(true)
    const p1 = connection.prompt(opened.sessionId, [{ type: 'text', text: 'go' }])
    await until(() => server.sent('turn/start').length === 1)
    expect(server.sent('turn/start')[0]).toMatchObject({ serviceTier: 'priority' })
    server.notify('turn/completed', {
      threadId: opened.sessionId,
      turn: turn('turn-1', 'completed'),
    })
    await p1

    // Model advertises additionalSpeedTiers ['fast'], while thread/resume reports 'priority'.
    server.on('model/list', () => ({
      data: [
        {
          id: 'gpt-speed-only',
          displayName: 'gpt-speed-only',
          description: 'Legacy speed tier model',
          supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
          defaultReasoningEffort: 'medium',
          additionalSpeedTiers: ['fast'],
          isDefault: true,
        },
      ],
      nextCursor: null,
    }))
    await connection.newSession('/project', { hidden: 'options' })
    server.on('thread/resume', (params) =>
      threadResponse(params.threadId as string, {
        model: 'gpt-speed-only',
        serviceTier: 'priority',
      }),
    )
    const resumed = await connection.resumeSession('thread-priority-alias', '/project')
    expect(resumed.config.find((o) => o.id === 'fast-mode')?.value).toBe(true)
    const p2 = connection.prompt('thread-priority-alias', [{ type: 'text', text: 'resume go' }])
    await until(() => server.sent('turn/start').length === 2)
    expect(server.sent('turn/start')[1]).toMatchObject({ serviceTier: 'fast' })
    server.notify('turn/completed', {
      threadId: 'thread-priority-alias',
      turn: turn('turn-2', 'completed'),
    })
    await p2

    // Default or null serviceTier stays false.
    server.on('thread/resume', (params) =>
      threadResponse(params.threadId as string, {
        model: 'gpt-speed-only',
        serviceTier: null,
      }),
    )
    const resumedNull = await connection.resumeSession('thread-null-tier', '/project')
    expect(resumedNull.config.find((o) => o.id === 'fast-mode')?.value).toBe(false)
  })

  it('toggles fast mode with /fast, updates session config, and applies serviceTier on next turn', async () => {
    const { server, connection } = await connect()
    const opened = await connection.newSession('/project')
    const t = threadTarget()
    t.target.apply({
      patches: [{ op: 'session.update', changes: { config: opened.config } }],
      effects: [],
    })
    connection.register(opened.sessionId, t.target)
    await until(() => t.thread().session.commands.some((c) => c.name === 'fast'))
    expect(t.thread().session.commands.find((c) => c.name === 'fast')).toMatchObject({
      name: 'fast',
      inputHint: expect.any(String),
    })

    // /fast toggles off -> on
    const toggledOn = await connection.prompt(opened.sessionId, [{ type: 'text', text: '/fast' }])
    expect(toggledOn.stopReason).toBe('end_turn')
    expect(server.sent('turn/start')).toEqual([])
    expect(t.thread().session.config.find((o) => o.id === 'fast-mode')?.value).toBe(true)
    expect(t.entries().at(-1)).toMatchObject({ kind: 'agent' })

    // Next turn carries the advertised fast tier
    const turnOn = connection.prompt(opened.sessionId, [{ type: 'text', text: 'fast turn' }])
    await until(() => server.sent('turn/start').length === 1)
    expect(server.sent('turn/start')[0]).toMatchObject({ serviceTier: 'priority' })
    // While running, steering with /fast queues it as its own command instead of steering text.
    server.notify('turn/started', { threadId: opened.sessionId, turn: turn('turn-1') })
    await tick()
    expect(await connection.steer(opened.sessionId, [{ type: 'text', text: '/fast off' }])).toBe(
      'promptRequired',
    )
    server.notify('turn/completed', {
      threadId: opened.sessionId,
      turn: turn('turn-1', 'completed'),
    })
    await turnOn

    // /fast status reports status without changing it
    const beforeStatus = t.entries().length
    await connection.prompt(opened.sessionId, [{ type: 'text', text: '/fast status' }])
    expect(t.thread().session.config.find((o) => o.id === 'fast-mode')?.value).toBe(true)
    expect(t.entries().length).toBe(beforeStatus + 1)

    // /fast off turns it off and next turn sends default
    await connection.prompt(opened.sessionId, [{ type: 'text', text: '/fast off' }])
    expect(t.thread().session.config.find((o) => o.id === 'fast-mode')?.value).toBe(false)
    const turnOff = connection.prompt(opened.sessionId, [{ type: 'text', text: 'normal turn' }])
    await until(() => server.sent('turn/start').length === 2)
    expect(server.sent('turn/start')[1]).toMatchObject({ serviceTier: 'default' })
    server.notify('turn/completed', {
      threadId: opened.sessionId,
      turn: turn('turn-2', 'completed'),
    })
    await turnOff

    // /fast on turns it on explicitly, /fast toggles it back off, and invalid argument replies
    // with usage without changing state.
    await connection.prompt(opened.sessionId, [{ type: 'text', text: '/fast on' }])
    expect(t.thread().session.config.find((o) => o.id === 'fast-mode')?.value).toBe(true)
    const beforeInvalid = t.entries().length
    await connection.prompt(opened.sessionId, [{ type: 'text', text: '/fast turbo' }])
    expect(t.thread().session.config.find((o) => o.id === 'fast-mode')?.value).toBe(true)
    expect(t.entries().length).toBe(beforeInvalid + 1)
    await connection.prompt(opened.sessionId, [{ type: 'text', text: '/fast' }])
    expect(t.thread().session.config.find((o) => o.id === 'fast-mode')?.value).toBe(false)
    expect(server.sent('turn/start')).toHaveLength(2)
  })

  it('replies cleanly for /fast on a model without fast support without sending it to the model', async () => {
    const { server, connection } = await connect()
    server.on('thread/start', () =>
      threadResponse('thread-luna', { model: 'gpt-5.6-luna', reasoningEffort: 'low' }),
    )
    const opened = await connection.newSession('/project')
    const t = threadTarget()
    t.target.apply({
      patches: [{ op: 'session.update', changes: { config: opened.config } }],
      effects: [],
    })
    connection.register(opened.sessionId, t.target)

    const result = await connection.prompt(opened.sessionId, [{ type: 'text', text: '/fast on' }])
    expect(result.stopReason).toBe('end_turn')
    expect(server.sent('turn/start')).toEqual([])
    expect(t.thread().session.config.find((o) => o.id === 'fast-mode')).toBeUndefined()
    const reply = t.entries().at(-1)
    expect(reply).toMatchObject({ kind: 'agent' })
    expect(reply?.kind === 'agent' && reply.markdown).toContain('gpt-5.6-luna')
  })
})

describe('speed tiers (Fast and Ultrafast)', () => {
  const ULTRA_MODEL = {
    id: 'gpt-6.3-ultra',
    displayName: 'gpt-6.3-ultra',
    description: 'Model advertising both Fast and Ultrafast service tiers',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Quick' },
      { reasoningEffort: 'medium', description: 'Balanced' },
      { reasoningEffort: 'high', description: 'Deep' },
    ],
    defaultReasoningEffort: 'medium',
    serviceTiers: [
      { id: 'priority', name: 'Fast', description: '2x speed, increased usage' },
      { id: 'ultrafast', name: 'Ultrafast', description: 'Fastest available responses' },
    ],
    isDefault: true,
  }

  const MULTI_MODELS = [ULTRA_MODEL, ...FAKE_MODELS]

  it('switches Standard -> Fast -> Ultrafast -> Standard via service-tier option and sends exact serviceTier', async () => {
    const { server, connection } = await connect()
    server.on('model/list', () => ({ data: MULTI_MODELS, nextCursor: null }))
    server.on('thread/start', () =>
      threadResponse('thread-ultra-1', { model: ULTRA_MODEL.id, serviceTier: 'default' }),
    )

    const opened = await connection.newSession('/project')
    expect(opened.config.find((o) => o.id === 'fast-mode')).toBeUndefined()
    const initialSpeed = opened.config.find((o) => o.id === 'service-tier')
    expect(initialSpeed).toMatchObject({
      id: 'service-tier',
      category: 'model_config',
      type: 'select',
      value: 'default',
    })
    expect(initialSpeed?.choices?.map((c) => c.value)).toEqual(['default', 'priority', 'ultrafast'])

    // Standard -> Fast
    const fastConfig = await connection.setConfigOption(
      opened.sessionId,
      'service-tier',
      'priority',
    )
    expect(fastConfig.find((o) => o.id === 'service-tier')?.value).toBe('priority')
    const turnFast = connection.prompt(opened.sessionId, [{ type: 'text', text: 'fast turn' }])
    await until(() => server.sent('turn/start').length === 1)
    expect(server.sent('turn/start')[0]).toMatchObject({ serviceTier: 'priority' })
    server.notify('turn/completed', {
      threadId: opened.sessionId,
      turn: turn('turn-1', 'completed'),
    })
    await turnFast

    // Fast -> Ultrafast
    const ultraConfig = await connection.setConfigOption(
      opened.sessionId,
      'service-tier',
      'ultrafast',
    )
    expect(ultraConfig.find((o) => o.id === 'service-tier')?.value).toBe('ultrafast')
    const turnUltra = connection.prompt(opened.sessionId, [{ type: 'text', text: 'ultra turn' }])
    await until(() => server.sent('turn/start').length === 2)
    expect(server.sent('turn/start')[1]).toMatchObject({ serviceTier: 'ultrafast' })
    server.notify('turn/completed', {
      threadId: opened.sessionId,
      turn: turn('turn-2', 'completed'),
    })
    await turnUltra

    // Command turns (e.g. /compact) carry ultrafast in thread/settings/update
    const compact = connection.prompt(opened.sessionId, [{ type: 'text', text: '/compact' }])
    await until(() => server.sent('thread/settings/update').length === 1)
    expect(server.sent('thread/settings/update')[0]).toMatchObject({ serviceTier: 'ultrafast' })
    server.notify('turn/started', { threadId: opened.sessionId, turn: turn('turn-compact') })
    server.notify('turn/completed', {
      threadId: opened.sessionId,
      turn: turn('turn-compact', 'completed'),
    })
    await compact

    // Ultrafast -> Standard
    const standardConfig = await connection.setConfigOption(
      opened.sessionId,
      'service-tier',
      'default',
    )
    expect(standardConfig.find((o) => o.id === 'service-tier')?.value).toBe('default')
    const turnStd = connection.prompt(opened.sessionId, [{ type: 'text', text: 'std turn' }])
    await until(() => server.sent('turn/start').length === 3)
    expect(server.sent('turn/start')[2]).toMatchObject({ serviceTier: 'default' })
    server.notify('turn/completed', {
      threadId: opened.sessionId,
      turn: turn('turn-3', 'completed'),
    })
    await turnStd
  })

  it('supports /ultrafast alongside /fast and switches cleanly between them', async () => {
    const { server, connection } = await connect()
    server.on('model/list', () => ({ data: MULTI_MODELS, nextCursor: null }))
    server.on('thread/start', () =>
      threadResponse('thread-ultra-cmd', { model: ULTRA_MODEL.id, serviceTier: 'default' }),
    )

    const opened = await connection.newSession('/project')
    const t = threadTarget()
    t.target.apply({
      patches: [{ op: 'session.update', changes: { config: opened.config } }],
      effects: [],
    })
    connection.register(opened.sessionId, t.target)
    await until(() => t.thread().session.commands.some((c) => c.name === 'ultrafast'))
    expect(t.thread().session.commands.find((c) => c.name === 'ultrafast')).toMatchObject({
      name: 'ultrafast',
      inputHint: expect.any(String),
    })

    // Standard -> /ultrafast -> Ultrafast
    const onUltra = await connection.prompt(opened.sessionId, [
      { type: 'text', text: '/ultrafast' },
    ])
    expect(onUltra.stopReason).toBe('end_turn')
    expect(server.sent('turn/start')).toEqual([])
    expect(t.thread().session.config.find((o) => o.id === 'service-tier')?.value).toBe('ultrafast')

    // Next turn uses ultrafast; steering /ultrafast off queues as command
    const p1 = connection.prompt(opened.sessionId, [{ type: 'text', text: 'go ultra' }])
    await until(() => server.sent('turn/start').length === 1)
    expect(server.sent('turn/start')[0]).toMatchObject({ serviceTier: 'ultrafast' })
    server.notify('turn/started', { threadId: opened.sessionId, turn: turn('turn-1') })
    await tick()
    expect(
      await connection.steer(opened.sessionId, [{ type: 'text', text: '/ultrafast off' }]),
    ).toBe('promptRequired')
    server.notify('turn/completed', {
      threadId: opened.sessionId,
      turn: turn('turn-1', 'completed'),
    })
    await p1

    // Ultrafast -> /fast switches from Ultrafast to Fast
    await connection.prompt(opened.sessionId, [{ type: 'text', text: '/fast' }])
    expect(t.thread().session.config.find((o) => o.id === 'service-tier')?.value).toBe('priority')

    // Fast -> /ultrafast switches from Fast to Ultrafast
    await connection.prompt(opened.sessionId, [{ type: 'text', text: '/ultrafast' }])
    expect(t.thread().session.config.find((o) => o.id === 'service-tier')?.value).toBe('ultrafast')

    // /ultrafast status & invalid argument keep state
    await connection.prompt(opened.sessionId, [{ type: 'text', text: '/ultrafast status' }])
    expect(t.thread().session.config.find((o) => o.id === 'service-tier')?.value).toBe('ultrafast')
    await connection.prompt(opened.sessionId, [{ type: 'text', text: '/ultrafast bogus' }])
    expect(t.thread().session.config.find((o) => o.id === 'service-tier')?.value).toBe('ultrafast')

    // /ultrafast toggles back to Standard
    await connection.prompt(opened.sessionId, [{ type: 'text', text: '/ultrafast' }])
    expect(t.thread().session.config.find((o) => o.id === 'service-tier')?.value).toBe('default')

    // /ultrafast on & /ultrafast off explicitly
    await connection.prompt(opened.sessionId, [{ type: 'text', text: '/ultrafast on' }])
    expect(t.thread().session.config.find((o) => o.id === 'service-tier')?.value).toBe('ultrafast')
    await connection.prompt(opened.sessionId, [{ type: 'text', text: '/ultrafast off' }])
    expect(t.thread().session.config.find((o) => o.id === 'service-tier')?.value).toBe('default')
  })

  it('replies cleanly for /ultrafast on a model that only supports Fast or no speed tiers', async () => {
    const { server, connection } = await connect()
    const opened = await connection.newSession('/project')
    const t = threadTarget()
    t.target.apply({
      patches: [{ op: 'session.update', changes: { config: opened.config } }],
      effects: [],
    })
    connection.register(opened.sessionId, t.target)

    const result = await connection.prompt(opened.sessionId, [{ type: 'text', text: '/ultrafast' }])
    expect(result.stopReason).toBe('end_turn')
    expect(server.sent('turn/start')).toEqual([])
    expect(t.thread().session.config.find((o) => o.id === 'fast-mode')?.value).toBe(false)
    const reply = t.entries().at(-1)
    expect(reply).toMatchObject({ kind: 'agent' })
    expect(reply?.kind === 'agent' && reply.markdown).toContain('gpt-6.1-sol')

    // Also verify manual /ultrafast on a model with no speed tiers at all.
    await connection.setConfigOption(opened.sessionId, 'model', 'gpt-5.6-luna')
    const noSpeedResult = await connection.prompt(opened.sessionId, [
      { type: 'text', text: '/ultrafast on' },
    ])
    expect(noSpeedResult.stopReason).toBe('end_turn')
    expect(server.sent('turn/start')).toEqual([])
    const lunaReply = t.entries().at(-1)
    expect(lunaReply).toMatchObject({ kind: 'agent' })
    expect(lunaReply?.kind === 'agent' && lunaReply.markdown).toContain('gpt-5.6-luna')
  })

  it('aligns /fast and /ultrafast command visibility with active model serviceTiers on open, resume, and model switch', async () => {
    const { server, connection } = await connect()
    server.skills = [
      {
        name: 'build',
        description: 'Run build',
        path: '/project/.codex/skills/build/SKILL.md',
        enabled: true,
      },
    ]
    server.on('model/list', () => ({ data: MULTI_MODELS, nextCursor: null }))

    // 1. Model with no speed tiers -> neither /fast nor /ultrafast in emitted commands.
    server.on('thread/start', () =>
      threadResponse('thread-cmd-none', { model: 'gpt-5.6-luna', reasoningEffort: 'low' }),
    )
    const openedNone = await connection.newSession('/project')
    const noneTarget = threadTarget()
    connection.register(openedNone.sessionId, noneTarget.target)
    await until(() => noneTarget.thread().session.commands.some((c) => c.name === 'compact'))
    expect(noneTarget.thread().session.commands.map((c) => c.name)).not.toContain('fast')
    expect(noneTarget.thread().session.commands.map((c) => c.name)).not.toContain('ultrafast')
    expect(noneTarget.thread().session.commands.map((c) => c.name)).toContain('$build')

    // 2. Switch to Fast-only model -> /fast appears, /ultrafast stays absent, skills preserved.
    await connection.setConfigOption(openedNone.sessionId, 'model', 'gpt-6.1-sol')
    expect(noneTarget.thread().session.commands.map((c) => c.name)).toContain('fast')
    expect(noneTarget.thread().session.commands.map((c) => c.name)).not.toContain('ultrafast')
    expect(noneTarget.thread().session.commands.map((c) => c.name)).toContain('$build')

    // 3. Switch to Fast + Ultrafast model -> both /fast and /ultrafast appear.
    await connection.setConfigOption(openedNone.sessionId, 'model', ULTRA_MODEL.id)
    expect(noneTarget.thread().session.commands.map((c) => c.name)).toContain('fast')
    expect(noneTarget.thread().session.commands.map((c) => c.name)).toContain('ultrafast')
    expect(noneTarget.thread().session.commands.map((c) => c.name)).toContain('$build')

    // 4. Switch back to no-speed model -> both /fast and /ultrafast are removed.
    await connection.setConfigOption(openedNone.sessionId, 'model', 'gpt-5.6-luna')
    expect(noneTarget.thread().session.commands.map((c) => c.name)).not.toContain('fast')
    expect(noneTarget.thread().session.commands.map((c) => c.name)).not.toContain('ultrafast')
    expect(noneTarget.thread().session.commands.map((c) => c.name)).toContain('$build')

    // 5. Resume a session on a Fast-only model -> /fast present, /ultrafast absent.
    server.on('thread/resume', (params) =>
      threadResponse(params.threadId as string, { model: 'gpt-6.1-sol', serviceTier: 'default' }),
    )
    await connection.resumeSession('thread-cmd-resume', '/project')
    const resumeTarget = threadTarget()
    connection.register('thread-cmd-resume', resumeTarget.target)
    await until(() => resumeTarget.thread().session.commands.some((c) => c.name === 'compact'))
    expect(resumeTarget.thread().session.commands.map((c) => c.name)).toContain('fast')
    expect(resumeTarget.thread().session.commands.map((c) => c.name)).not.toContain('ultrafast')
  })

  it('refreshes active session commands when model/list updates advertised serviceTiers', async () => {
    const { server, connection } = await connect()
    const dynamicModel = {
      ...ULTRA_MODEL,
      serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed' }],
    }
    server.on('model/list', () => ({ data: [dynamicModel], nextCursor: null }))
    server.on('thread/start', () =>
      threadResponse('thread-cmd-refresh', { model: dynamicModel.id, serviceTier: 'default' }),
    )

    const opened = await connection.newSession('/project')
    const t = threadTarget()
    connection.register(opened.sessionId, t.target)
    await until(() => t.thread().session.commands.some((c) => c.name === 'fast'))
    expect(t.thread().session.commands.map((c) => c.name)).not.toContain('ultrafast')

    // Catalog later advertises ultrafast for the same model; refreshing options updates commands.
    server.on('model/list', () => ({ data: [ULTRA_MODEL], nextCursor: null }))
    server.on('thread/start', () =>
      threadResponse('thread-hidden-options', { model: ULTRA_MODEL.id, serviceTier: 'default' }),
    )
    await connection.newSession('/project', { hidden: 'options' })
    expect(t.thread().session.commands.map((c) => c.name)).toContain('fast')
    expect(t.thread().session.commands.map((c) => c.name)).toContain('ultrafast')
  })

  it('emits commands for the newly selected model even when model changes while skills/list is in flight', async () => {
    const { server, connection } = await connect()
    server.on('model/list', () => ({ data: MULTI_MODELS, nextCursor: null }))
    server.on('thread/start', () =>
      threadResponse('thread-cmd-race', { model: 'gpt-6.1-sol', serviceTier: 'default' }),
    )
    let releaseSkills: (() => void) | null = null
    let skillsCalls = 0
    server.on('skills/list', async () => {
      skillsCalls++
      if (skillsCalls === 2) {
        await new Promise<void>((resolve) => {
          releaseSkills = resolve
        })
      }
      return {
        data: [
          {
            cwd: '/project',
            skills: [
              {
                name: 'deploy',
                description: 'Deploy app',
                path: '/project/.codex/skills/deploy/SKILL.md',
                enabled: true,
              },
            ],
            errors: [],
          },
        ],
      }
    })

    const opened = await connection.newSession('/project')
    const t = threadTarget()
    connection.register(opened.sessionId, t.target)
    await until(() => releaseSkills !== null)

    // Switch to Ultrafast model before the register's skills/list call resolves.
    await connection.setConfigOption(opened.sessionId, 'model', ULTRA_MODEL.id)
    releaseSkills!()
    await until(() => t.thread().session.commands.some((c) => c.name === 'ultrafast'))
    expect(t.thread().session.commands.map((c) => c.name)).toContain('fast')
    expect(t.thread().session.commands.map((c) => c.name)).toContain('ultrafast')
    expect(t.thread().session.commands.map((c) => c.name)).toContain('$deploy')
  })

  it('reads initial and resumed ultrafast serviceTier including legacy additionalSpeedTiers', async () => {
    const { server, connection } = await connect()
    const legacyUltra = {
      id: 'gpt-legacy-ultra',
      displayName: 'gpt-legacy-ultra',
      description: 'Legacy speed tiers',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
      defaultReasoningEffort: 'medium',
      additionalSpeedTiers: ['fast', 'ultrafast'],
      isDefault: false,
    }
    server.on('model/list', () => ({ data: [ULTRA_MODEL, legacyUltra], nextCursor: null }))
    server.on('thread/start', () =>
      threadResponse('thread-init-ultra', { model: ULTRA_MODEL.id, serviceTier: 'ultrafast' }),
    )
    const opened = await connection.newSession('/project')
    expect(opened.config.find((o) => o.id === 'service-tier')?.value).toBe('ultrafast')
    const p1 = connection.prompt(opened.sessionId, [{ type: 'text', text: 'first' }])
    await until(() => server.sent('turn/start').length === 1)
    expect(server.sent('turn/start')[0]).toMatchObject({ serviceTier: 'ultrafast' })
    server.notify('turn/completed', {
      threadId: opened.sessionId,
      turn: turn('turn-1', 'completed'),
    })
    await p1

    server.on('thread/resume', (params) =>
      threadResponse(params.threadId as string, {
        model: legacyUltra.id,
        serviceTier: 'ultra_fast',
      }),
    )
    const resumed = await connection.resumeSession('thread-resume-ultra', '/project')
    expect(resumed.config.find((o) => o.id === 'service-tier')?.value).toBe('ultrafast')
    const p2 = connection.prompt('thread-resume-ultra', [{ type: 'text', text: 'resumed' }])
    await until(() => server.sent('turn/start').length === 2)
    expect(server.sent('turn/start')[1]).toMatchObject({ serviceTier: 'ultrafast' })
    server.notify('turn/completed', {
      threadId: 'thread-resume-ultra',
      turn: turn('turn-2', 'completed'),
    })
    await p2
  })

  it('omits unsupported ultrafast tier when switching models and restores it when switching back', async () => {
    const { server, connection } = await connect()
    server.on('model/list', () => ({ data: MULTI_MODELS, nextCursor: null }))
    server.on('thread/start', () =>
      threadResponse('thread-switch-ultra', { model: ULTRA_MODEL.id, serviceTier: 'default' }),
    )

    const opened = await connection.newSession('/project')
    await connection.setConfigOption(opened.sessionId, 'service-tier', 'ultrafast')

    // Switch to Fast-only model: ultrafast is unsupported, so fast-mode shows false and turn omits serviceTier.
    const onFastOnly = await connection.setConfigOption(opened.sessionId, 'model', 'gpt-6.1-sol')
    expect(onFastOnly.find((o) => o.id === 'service-tier')).toBeUndefined()
    expect(onFastOnly.find((o) => o.id === 'fast-mode')?.value).toBe(false)
    const p1 = connection.prompt(opened.sessionId, [{ type: 'text', text: 'on sol' }])
    await until(() => server.sent('turn/start').length === 1)
    expect(server.sent('turn/start')[0]).not.toHaveProperty('serviceTier')
    server.notify('turn/completed', {
      threadId: opened.sessionId,
      turn: turn('turn-1', 'completed'),
    })
    await p1

    // Switch to model with no speed tiers at all.
    const onNone = await connection.setConfigOption(opened.sessionId, 'model', 'gpt-5.6-luna')
    expect(onNone.find((o) => o.id === 'service-tier')).toBeUndefined()
    expect(onNone.find((o) => o.id === 'fast-mode')).toBeUndefined()
    const p2 = connection.prompt(opened.sessionId, [{ type: 'text', text: 'on luna' }])
    await until(() => server.sent('turn/start').length === 2)
    expect(server.sent('turn/start')[1]).not.toHaveProperty('serviceTier')
    server.notify('turn/completed', {
      threadId: opened.sessionId,
      turn: turn('turn-2', 'completed'),
    })
    await p2

    // Switch back to Ultrafast-capable model: ultrafast is restored.
    const back = await connection.setConfigOption(opened.sessionId, 'model', ULTRA_MODEL.id)
    expect(back.find((o) => o.id === 'service-tier')?.value).toBe('ultrafast')
    const p3 = connection.prompt(opened.sessionId, [{ type: 'text', text: 'back on ultra' }])
    await until(() => server.sent('turn/start').length === 3)
    expect(server.sent('turn/start')[2]).toMatchObject({ serviceTier: 'ultrafast' })
    server.notify('turn/completed', {
      threadId: opened.sessionId,
      turn: turn('turn-3', 'completed'),
    })
    await p3
  })

  it('stays backward-compatible with legacy fast-mode preference on multi-tier models', async () => {
    const { server, connection } = await connect()
    server.on('model/list', () => ({ data: MULTI_MODELS, nextCursor: null }))
    server.on('thread/start', () =>
      threadResponse('thread-compat', { model: ULTRA_MODEL.id, serviceTier: 'default' }),
    )

    const opened = await connection.newSession('/project')
    const afterOn = await connection.setConfigOption(opened.sessionId, 'fast-mode', true)
    expect(afterOn.find((o) => o.id === 'service-tier')?.value).toBe('priority')

    const afterOff = await connection.setConfigOption(opened.sessionId, 'fast-mode', 'off')
    expect(afterOff.find((o) => o.id === 'service-tier')?.value).toBe('default')
  })

  it('enriches per-thread warnings with matching process-level configWarning metadata and codexHome layer', async () => {
    const { server, connection } = await connect()
    const summary = '`[features].multi_agent` is deprecated. It still controls the V1 fallback.'
    server.notify('configWarning', {
      summary,
      details: 'Migrate to [agents] settings.',
      path: '/home/.codex/config.toml',
      range: { start: { line: 5, column: 1 }, end: { line: 5, column: 18 } },
    })
    await until(() => true)

    const opened = await connection.newSession('/project')
    const target = threadTarget()
    connection.register(opened.sessionId, target.target)
    // Codex repeats the same warning on the thread as a `warning` notification; it should dedupe
    // and retain the structured path/range metadata from `configWarning`.
    server.notify('warning', { threadId: opened.sessionId, message: summary })
    await until(() => target.entries().some((entry) => entry.kind === 'notice'))

    const notices = target.entries().filter((entry) => entry.kind === 'notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      kind: 'notice',
      severity: 'warning',
      title: 'Codex configuration warning',
      description: `${summary}\nMigrate to [agents] settings.`,
      configWarning: {
        agent: 'codex',
        impact: 'deprecated',
        sources: [{ layer: 'user', path: '/home/.codex/config.toml', line: 5, column: 1 }],
        details: 'Migrate to [agents] settings.',
        docsUrl: 'https://developers.openai.com/codex/config-reference',
      },
    })
  })

  it('surfaces startup parse configWarning notifications with path and range on new user sessions', async () => {
    const { server, connection } = await connect()
    server.notify('configWarning', {
      summary: 'Invalid configuration; using defaults.',
      details: '/home/.codex/config.toml:1:22: unclosed array, expected `]`',
      path: '/home/.codex/config.toml',
      range: { start: { line: 1, column: 22 }, end: { line: 1, column: 22 } },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    const opened = await connection.newSession('/project')
    const target = threadTarget()
    connection.register(opened.sessionId, target.target)

    const notices = target.entries().filter((entry) => entry.kind === 'notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      kind: 'notice',
      severity: 'warning',
      title: 'Codex configuration warning',
      configWarning: {
        agent: 'codex',
        impact: 'invalid',
        sources: [{ layer: 'user', path: '/home/.codex/config.toml', line: 1, column: 22 }],
      },
    })
  })

  it('routes thread-scoped configWarning notifications directly without duplicating ignored settings', async () => {
    const { server, connection } = await connect()
    const opened = await connection.newSession('/project')
    const target = threadTarget()
    connection.register(opened.sessionId, target.target)

    const summary =
      'Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.\n' +
      '  user (/home/.codex/config.toml): `disable_response_storage` is ignored.'
    server.notify('configWarning', {
      threadId: opened.sessionId,
      summary,
      details: null,
    })
    await until(() => target.entries().some((entry) => entry.kind === 'notice'))

    const notices = target.entries().filter((entry) => entry.kind === 'notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      kind: 'notice',
      severity: 'warning',
      title: 'Codex configuration warning',
      description: summary,
      configWarning: {
        agent: 'codex',
        impact: 'ignored',
        sources: [{ layer: 'user', path: '/home/.codex/config.toml' }],
      },
    })
  })
})
