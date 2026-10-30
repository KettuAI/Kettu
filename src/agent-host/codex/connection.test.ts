// The Codex connection against a scripted app-server: the handshake, sessions and the settings
// each turn carries, streaming into the thread, approvals, steering, forks, hidden sessions,
// limits and sign-in.

import os from 'node:os'
import { describe, expect, it } from 'vitest'
import type { AgentAccount } from '@shared/agent-host'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
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
import { TextRing } from '../ring'
import { newTurnScope, type MapperEffect } from '../session-updates'
import { FakeAppServer, FakeRpcError, threadResponse, turn } from '../testing/fake-app-server'
import { CodexConnection } from './connection'

const SPEC = {
  command: '/opt/codex/bin/codex',
  args: ['app-server'],
  env: { CODEX_MANAGED_BY_NPM: '1' },
  shell: false,
  display: { command: '/opt/codex/bin/codex', args: ['app-server'], env: {} },
}

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
  const state = { replaying: false }
  const target: SessionTarget = {
    context: () => ({
      thread,
      replaying: state.replaying,
      thoughtParts: false,
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
  }
  return {
    target,
    state,
    effects,
    requests,
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

describe('sessions', () => {
  it('starts a thread with the default mode, trusting the folder and passing Kettu’s MCP server', async () => {
    const { server, connection } = await connect()
    const opened = await connection.newSession('/project', {
      mcpServers: [
        {
          type: 'http',
          name: 'kettu',
          url: 'http://127.0.0.1:9/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer t' }],
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
        projects: { '/project': { trust_level: 'trusted' } },
        mcp_servers: {
          kettu: { url: 'http://127.0.0.1:9/mcp', http_headers: { Authorization: 'Bearer t' } },
        },
      },
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
    expect(entries.map((e) => e.id)).toEqual(['m:rs_1', 'm:msg_1', 't:exec-1', 't:patch-1'])
    expect(t.entry('m:rs_1')).toMatchObject({
      kind: 'thought',
      markdown: '**Look**\n\nThen act',
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
      { id: 'allow_once', name: 'Yes', kind: 'allow_once' },
      {
        id: 'accept_execpolicy_amendment',
        name: "Yes, and don't ask again for `touch`",
        kind: 'allow_always',
      },
      { id: 'cancel', name: 'No, and stop', kind: 'reject_once' },
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
      ['decline', 'reject_once'],
      ['cancel', 'reject_once'],
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

  it('asks a question with choices, and answers others it cannot ask with none', async () => {
    const { server, connection } = await connect()
    await connection.newSession('/project')
    const t = threadTarget((request) => ({ optionId: request.options[1]!.id }))
    connection.register('thread-1', t.target)
    const question = {
      id: 'q',
      header: 'Plan',
      question: 'Which one?',
      isOther: false,
      isSecret: false,
    }
    const asked = server.request('item/tool/requestUserInput', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'ask-1',
      questions: [
        {
          ...question,
          options: [
            { label: 'A', description: '' },
            { label: 'B', description: '' },
          ],
        },
      ],
    })
    expect(await asked.answer).toEqual({ answers: { q: { answers: ['B'] } } })
    expect(t.entry('t:ask-1')).toMatchObject({ toolKind: 'other', title: 'Plan' })
    const free = server.request('item/tool/requestUserInput', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'ask-2',
      questions: [{ ...question, options: null }],
    })
    expect(await free.answer).toEqual({ answers: {} })
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

describe('limits and subagents', () => {
  it('reads the plan limits, and passes on the ones Codex pushes', async () => {
    const { server, connection } = await connect()
    expect(await connection.readLimits()).toEqual([
      expect.objectContaining({
        window: 'five_hour',
        label: '5-hour',
        usedPercent: 19,
        resetsAt: 1_800_018_000_000,
      }),
      expect.objectContaining({ window: 'seven_day', label: 'Weekly', usedPercent: 32 }),
    ])
    await connection.newSession('/project')
    const t = threadTarget()
    connection.register('thread-1', t.target)
    server.notify('account/rateLimits/updated', {
      rateLimits: {
        limitId: 'codex_spark',
        limitName: 'GPT-5.3-Codex-Spark',
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null },
        secondary: null,
      },
    })
    await until(() => t.effects.length > 0)
    expect(t.effects).toEqual([
      {
        kind: 'limit',
        limit: expect.objectContaining({
          window: 'gpt_5_3_codex_spark_five_hour',
          label: '5-hour · GPT-5.3-Codex-Spark',
          state: 'reached',
        }),
      },
    ])
  })

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
