// Codex's slash commands against a scripted app-server: what a session offers, and each command
// running through app-server's own methods instead of going to the model as text.

import os from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import type { SessionTarget } from '../connection'
import { newTurnScope } from '../session-updates'
import { FakeAppServer, turn } from '../testing/fake-app-server'
import { commandList, parseCommand, statusMessage } from './commands'
import { CodexConnection } from './connection'
import { errorDetail, inlineCode, mcpStatusMessage } from './mcp-status'
import type { McpServerStatus, SkillMetadata } from './protocol'

const SPEC = {
  command: '/opt/codex/bin/codex',
  args: ['app-server'],
  env: {},
  shell: false,
  display: { command: '/opt/codex/bin/codex', args: ['app-server'], env: {} },
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await tick()
  if (!check()) throw new Error('timed out')
}

function sessionTarget() {
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
  const target: SessionTarget = {
    context: () => ({
      thread,
      replaying: false,
      cancelling: false,
      scope,
      now: 5_000,
      nextId: () => `e:${++n}`,
      sessionIdFor: () => null,
    }),
    apply: (output) => {
      thread = applyPatches(thread, output.patches)
    },
    requestPermission: async () => 'cancelled',
  }
  return {
    target,
    thread: () => thread,
    entries: (): ThreadEntry[] => threadEntries(thread),
    said: (): string[] =>
      threadEntries(thread).flatMap((entry) => (entry.kind === 'agent' ? [entry.markdown] : [])),
  }
}

/** A connection with one session open in /project and shown by a thread. */
async function open(setup: (server: FakeAppServer) => void = () => {}) {
  const server = new FakeAppServer()
  setup(server)
  const connection = new CodexConnection(
    server.transport,
    { traffic: () => {}, account: () => {}, ignored: () => {}, log: () => {} },
    { spec: SPEC, env: {}, platform: 'darwin' },
  )
  await connection.initialize('1.2.3')
  await connection.newSession('/project')
  const session = sessionTarget()
  connection.register('thread-1', session.target)
  await until(() => session.thread().session.commands.length > 0)
  const run = (text: string) => connection.prompt('thread-1', [{ type: 'text', text }])
  return { server, connection, session, run }
}

const SKILL: SkillMetadata = {
  name: 'deploy',
  description: 'Deploy the app to staging and production',
  shortDescription: 'Deploy the app',
  path: '/project/.codex/skills/deploy/SKILL.md',
  enabled: true,
}

function mcpServer(name: string, fields: Partial<McpServerStatus> = {}): McpServerStatus {
  return {
    name,
    runtimeStatus: 'connected',
    tools: { a: {}, b: {} },
    toolsError: null,
    authStatus: 'unsupported',
    ...fields,
  }
}

describe('the commands a session offers', () => {
  it('lists Codex’s commands and its skills, without the sign-out Settings has', async () => {
    const { session, server } = await open((s) => (s.skills = [SKILL]))
    expect(server.sent('skills/list')).toContainEqual({ cwds: ['/project'] })
    const commands = session.thread().session.commands
    expect(commands.map((command) => command.name)).toEqual([
      'plan',
      'mcp',
      'skills',
      'status',
      'review',
      'review-branch',
      'review-commit',
      'compact',
      'goal',
      'rename',
      '$deploy',
    ])
    expect(commands).toContainEqual({
      name: 'review-branch',
      description: 'Review changes relative to a base branch.',
      inputHint: 'branch name',
    })
    expect(commands).toContainEqual({ name: '$deploy', description: 'Deploy the app' })
  })

  it('lists the skills again when Codex says they changed', async () => {
    const { session, server } = await open()
    expect(session.thread().session.commands.some((c) => c.name === '$deploy')).toBe(false)
    server.skills = [SKILL]
    server.notify('skills/changed', {})
    await until(() => session.thread().session.commands.some((c) => c.name === '$deploy'))
  })

  it('sends no command as text to the model, and keeps one sent during a turn for later', async () => {
    const { connection, server, run } = await open()
    // `/logout` is no command of Kettu's: Settings signs out.
    const logout = run('/logout')
    await until(() => server.sent('turn/start').length === 1)
    expect(server.sent('turn/start')[0]?.input).toEqual([
      { type: 'text', text: '/logout', text_elements: [] },
    ])
    expect(await connection.steer('thread-1', [{ type: 'text', text: '/status' }])).toBe(
      'promptRequired',
    )
    expect(server.sent('turn/steer')).toEqual([])
    server.notify('turn/completed', { threadId: 'thread-1', turn: turn('turn-1', 'completed') })
    await logout
  })

  it('parses a command by its first word, in any case, and leaves a skill to the model', () => {
    expect(parseCommand([{ type: 'text', text: '  /Review-Branch  main ' }])).toEqual({
      name: 'review-branch',
      rest: 'main',
    })
    expect(parseCommand([{ type: 'text', text: '/$deploy now' }])).toBeNull()
    expect(parseCommand([{ type: 'text', text: 'please /compact' }])).toBeNull()
    expect(commandList([]).every((command) => !command.name.startsWith('$'))).toBe(true)
  })
})

describe('commands with a turn', () => {
  it('compacts through thread/compact/start with the session’s settings, as a turn', async () => {
    const { server, session, run } = await open()
    const done = run('/compact')
    await until(() => server.sent('thread/compact/start').length === 1)
    expect(server.sent('thread/settings/update')[0]).toMatchObject({
      threadId: 'thread-1',
      model: 'gpt-6.1-sol',
      approvalPolicy: 'on-request',
    })
    expect(server.sent('thread/compact/start')).toEqual([{ threadId: 'thread-1' }])
    const at = { threadId: 'thread-1', turnId: 'turn-9' }
    server.notify('turn/started', { threadId: 'thread-1', turn: turn('turn-9') })
    server.notify('item/started', { ...at, item: { type: 'contextCompaction', id: 'cc-1' } })
    const report = (total: number) => ({
      totalTokens: total,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    })
    server.notify('thread/tokenUsage/updated', {
      ...at,
      tokenUsage: { total: report(900), last: report(300), modelContextWindow: 1000 },
    })
    server.notify('item/completed', { ...at, item: { type: 'contextCompaction', id: 'cc-1' } })
    server.notify('turn/completed', { threadId: 'thread-1', turn: turn('turn-9', 'completed') })
    // A compaction is no request of Kettu's to count.
    expect(await done).toEqual({ stopReason: 'end_turn', tokens: null, models: [] })
    expect(session.entries()).toEqual([
      expect.objectContaining({ kind: 'compaction', status: 'completed' }),
    ])
    expect(server.sent('turn/start')).toEqual([])
  })

  it('reviews through review/start with the target each command names', async () => {
    const { server, run } = await open()
    const reviews = [
      ['/review', { type: 'uncommittedChanges' }],
      ['/review the error paths', { type: 'custom', instructions: 'the error paths' }],
      ['/review-branch main', { type: 'baseBranch', branch: 'main' }],
      ['/review-commit 1a2b3c', { type: 'commit', sha: '1a2b3c', title: null }],
    ] as const
    server.on('review/start', (params) => ({
      turn: turn(`review-${server.sent('review/start').length}`),
      reviewThreadId: params.threadId,
    }))
    for (const [text, target] of reviews) {
      const done = run(text)
      const count = server.sent('review/start').length + 1
      await until(() => server.sent('review/start').length === count)
      expect(server.sent('review/start').at(-1)).toEqual({
        threadId: 'thread-1',
        target,
        delivery: 'inline',
      })
      server.notify('turn/completed', {
        threadId: 'thread-1',
        turn: turn(`review-${count}`, 'completed'),
      })
      await done
    }
  })

  it('streams a review into the thread like a turn, with its findings said once', async () => {
    const { server, session, run } = await open()
    server.on('review/start', () => ({ turn: turn('review-1'), reviewThreadId: 'thread-1' }))
    const done = run('/review')
    await until(() => server.sent('review/start').length === 1)
    const outer = { threadId: 'thread-1', turnId: 'review-1' }
    const inner = { threadId: 'thread-1', turnId: 'inner-1' }
    server.notify('item/completed', {
      ...outer,
      item: { type: 'enteredReviewMode', id: 'r-in', review: 'current changes' },
    })
    // The review runs in a turn of its own, inside the one review/start answered.
    server.notify('turn/started', {
      threadId: 'thread-1',
      turn: { ...turn('inner-1'), rootTurnId: 'review-1' },
    })
    server.notify('item/started', {
      ...inner,
      item: { type: 'agentMessage', id: 'msg_c', text: '', phase: 'commentary' },
    })
    const command = {
      type: 'commandExecution',
      id: 'exec-1',
      command: 'git diff',
      cwd: '/project',
      status: 'completed',
      commandActions: [{ type: 'unknown', command: 'git diff' }],
      aggregatedOutput: '+world\n',
      exitCode: 0,
    }
    server.notify('item/completed', { ...inner, item: command })
    const findings = 'No issues found in a.txt.'
    server.notify('item/completed', {
      ...outer,
      item: { type: 'exitedReviewMode', id: 'r-out', review: findings },
    })
    server.notify('item/completed', {
      ...outer,
      item: { type: 'agentMessage', id: 'msg_r', text: findings, phase: null },
    })
    server.notify('turn/completed', { threadId: 'thread-1', turn: turn('review-1', 'completed') })
    expect(await done).toMatchObject({ stopReason: 'end_turn' })
    expect(session.entries().map((entry) => entry.kind)).toEqual(['tool', 'agent'])
    expect(session.said()).toEqual([findings])
  })

  it('stops the turn review/start answered when the review is cancelled', async () => {
    const { server, connection, run } = await open()
    server.on('review/start', () => ({ turn: turn('review-1'), reviewThreadId: 'thread-1' }))
    const done = run('/review')
    await until(() => server.sent('review/start').length === 1)
    server.notify('turn/started', {
      threadId: 'thread-1',
      turn: { ...turn('inner-1'), rootTurnId: 'review-1' },
    })
    await tick()
    await connection.cancel('thread-1')
    expect(server.sent('turn/interrupt')).toEqual([{ threadId: 'thread-1', turnId: 'review-1' }])
    server.notify('turn/completed', { threadId: 'thread-1', turn: turn('review-1', 'interrupted') })
    expect(await done).toMatchObject({ stopReason: 'cancelled' })
  })

  it('sets a goal and follows the turn Codex starts for it', async () => {
    const { server, run } = await open()
    server.on('thread/goal/set', (params) => {
      setTimeout(() => {
        server.notify('thread/status/changed', {
          threadId: 'thread-1',
          status: { type: 'active', activeFlags: [] },
        })
        server.notify('turn/started', { threadId: 'thread-1', turn: turn('goal-turn') })
      }, 5)
      return { goal: { threadId: 'thread-1', objective: params.objective, status: 'active' } }
    })
    const done = run('/goal Ship the release')
    await until(() => server.sent('thread/goal/set').length === 1)
    expect(server.sent('thread/goal/set')[0]).toEqual({
      threadId: 'thread-1',
      objective: 'Ship the release',
      status: 'active',
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    server.notify('turn/completed', { threadId: 'thread-1', turn: turn('goal-turn', 'completed') })
    expect(await done).toMatchObject({ stopReason: 'end_turn' })
    expect(server.sent('turn/start')).toEqual([])
  })

  it('continues toward the goal with a turn of its own when Codex starts none', async () => {
    const { server, run } = await open()
    server.on('thread/goal/set', () => ({
      goal: { threadId: 'thread-1', objective: 'x', status: 'active' },
    }))
    const done = run('/goal resume')
    // Codex is given a second to start a turn of its own first.
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    await until(() => server.sent('turn/start').length === 1)
    expect(server.sent('thread/goal/set')).toEqual([{ threadId: 'thread-1', status: 'active' }])
    expect(server.sent('turn/start')[0]?.input).toEqual([
      { type: 'text', text: 'Continue working toward the active goal.', text_elements: [] },
    ])
    server.notify('turn/completed', { threadId: 'thread-1', turn: turn('turn-1', 'completed') })
    expect(await done).toMatchObject({ stopReason: 'end_turn' })
  })
})

describe('commands without a turn', () => {
  it('pauses and clears the goal, and answers a goal without text or with too much', async () => {
    const { server, session, run } = await open()
    server.on('thread/goal/set', (params) => ({
      goal: { threadId: 'thread-1', objective: 'x', status: params.status },
    }))
    server.on('thread/goal/clear', () => ({ cleared: true }))
    expect(await run('/goal pause')).toMatchObject({ stopReason: 'end_turn' })
    expect(await run('/goal clear')).toMatchObject({ stopReason: 'end_turn' })
    await run('/goal')
    await run(`/goal ${'x'.repeat(4001)}`)
    expect(server.sent('thread/goal/set')).toEqual([{ threadId: 'thread-1', status: 'paused' }])
    expect(server.sent('thread/goal/clear')).toEqual([{ threadId: 'thread-1' }])
    expect(session.said()).toEqual([
      'Command "/goal" requires [<objective>|clear|pause|resume].',
      'Command "/goal" requires goal text of at most 4000 characters.',
    ])
    expect(server.sent('turn/start')).toEqual([])
  })

  it('answers /status with the session’s settings, its tokens and the plan’s limits', async () => {
    const { server, session, run } = await open()
    server.notify('thread/tokenUsage/updated', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: {
        total: {
          totalTokens: 21_469,
          inputTokens: 21_464,
          cachedInputTokens: 11_264,
          cacheWriteInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: 21_469,
          inputTokens: 21_464,
          cachedInputTokens: 11_264,
          cacheWriteInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 258_400,
      },
    })
    await tick()
    expect(await run('/status')).toEqual({ stopReason: 'end_turn', tokens: null, models: [] })
    const [answer] = session.said()
    expect(answer?.split('  \n').slice(0, 9)).toEqual([
      '**Model:** gpt-6.1-sol[medium]',
      '**Directory:** /project',
      '**Approval:** on-request',
      '**Sandbox:** workspace-write',
      '**Account:** ChatGPT Plus (developer@example.com)',
      '**Session:** `thread-1`',
      '',
      '**Token usage:** 21.5K total  (10.2K input + 11.3K cached input, 5 output)',
      '**Context window:** 8% used (21.5K used / 258.4K)',
    ])
    expect(answer?.split('  \n').slice(9)).toEqual([
      expect.stringMatching(/^\*\*5-hour limit:\*\* 81% left \(resets \d\d:\d\d on .+\)$/),
      expect.stringMatching(/^\*\*Weekly limit:\*\* 68% left \(resets \d\d:\d\d on .+\)$/),
    ])
    expect(server.sent('account/rateLimits/read').length).toBeGreaterThan(0)
  })

  it('lists the skills for /skills', async () => {
    const lint: SkillMetadata = { name: 'lint', description: '', path: '/s/lint', enabled: true }
    const { session, run } = await open((s) => (s.skills = [SKILL, lint]))
    await run('/skills')
    expect(session.said()).toEqual(['Available skills:\n- deploy: Deploy the app\n- lint'])
  })

  it('answers /mcp with the servers’ status as the thread runs them', async () => {
    const { server, session, run } = await open((s) => {
      s.mcpServers = [
        mcpServer('kettu'),
        mcpServer('docs', {
          runtimeStatus: 'failed',
          tools: {},
          toolsError: 'Error: connect ECONNREFUSED',
        }),
        mcpServer('codex_app', { runtimeStatus: 'disabled', tools: {} }),
      ]
    })
    await run('/mcp')
    await run('/mcp now')
    expect(server.sent('mcpServerStatus/list')[0]).toEqual({
      cursor: null,
      detail: 'toolsAndAuthOnly',
      threadId: 'thread-1',
    })
    expect(session.said()).toEqual([
      [
        '**MCP servers:** 3 (1 connected, 1 failed, 1 disabled)',
        '',
        '**Failed**',
        '- `docs`: connect ECONNREFUSED',
        '',
        '**Connected**',
        '- `kettu`: 2 tools',
        '',
        '**Disabled:** `codex_app`',
        '',
        'Run `/mcp reconnect` to restart the servers that are not connected.',
      ].join('\n'),
      'Command "/mcp" accepts no arguments, or `reconnect`.',
    ])
  })

  it('reconnects the MCP servers and waits for them to start', async () => {
    const { server, session, run } = await open((s) => {
      s.mcpServers = [mcpServer('docs', { runtimeStatus: 'failed', tools: {} })]
    })
    server.on('config/mcpServer/reload', () => {
      setTimeout(() => {
        const update = { threadId: 'thread-1', name: 'docs', error: null, failureReason: null }
        server.notify('mcpServer/startupStatus/updated', { ...update, status: 'starting' })
        server.mcpServers = [
          mcpServer('docs', { runtimeStatus: 'authenticationRequired', tools: {} }),
        ]
        server.notify('mcpServer/startupStatus/updated', {
          ...update,
          status: 'failed',
          error: 'needs a sign-in',
          failureReason: 'reauthenticationRequired',
        })
      }, 5)
      return {}
    })
    await run('/mcp reconnect')
    expect(server.sent('config/mcpServer/reload')).toHaveLength(1)
    expect(session.said()).toEqual([
      [
        '**Reconnect:**',
        '- Reloaded the MCP configuration of all open sessions. Codex restarted the servers that failed, stopped, or changed. A connected server with unchanged settings keeps its connection.',
        '- MCP server `docs` needs authentication, but this client cannot open a sign-in page.',
        '',
        '**MCP servers:** 1 (1 needs authentication)',
        '',
        '**Needs authentication**',
        '- `docs`: not signed in',
        '',
        'Run `/mcp reconnect` to restart the servers that are not connected.',
      ].join('\n'),
    ])
  })

  it('stops waiting for the MCP servers when the reconnect is cancelled, and says nothing', async () => {
    const { server, connection, session, run } = await open((s) => {
      s.mcpServers = [mcpServer('docs', { runtimeStatus: 'failed', tools: {} })]
    })
    server.on('config/mcpServer/reload', () => ({}))
    const done = run('/mcp reconnect')
    await until(() => server.sent('mcpServerStatus/list').length === 2)
    await connection.cancel('thread-1')
    expect(await done).toMatchObject({ stopReason: 'cancelled' })
    expect(session.said()).toEqual([])
  })

  it('toggles plan mode with /plan, which the next turn then carries', async () => {
    const { server, connection, session, run } = await open()
    await run('/plan')
    const option = () => session.thread().session.config.find((o) => o.id === 'collaboration_mode')
    expect(option()?.value).toBe('plan')
    const next = connection.prompt('thread-1', [{ type: 'text', text: 'go' }])
    await until(() => server.sent('turn/start').length === 1)
    expect(server.sent('turn/start')[0]?.collaborationMode).toMatchObject({ mode: 'plan' })
    server.notify('turn/completed', { threadId: 'thread-1', turn: turn('turn-1', 'completed') })
    await next
    await run('/plan')
    expect(option()?.value).toBe('default')
    await run('/plan now')
    expect(session.said()).toEqual(['Command "/plan" requires no arguments.'])
  })

  it('renames the thread with /rename, whose new name Codex sends back', async () => {
    const { server, session, run } = await open()
    server.on('thread/name/set', (params) => {
      server.notify('thread/name/updated', { threadId: params.threadId, threadName: params.name })
      return {}
    })
    await run('/rename Release notes')
    await run('/rename')
    expect(server.sent('thread/name/set')).toEqual([
      { threadId: 'thread-1', name: 'Release notes' },
    ])
    await until(() => session.thread().session.title === 'Release notes')
    expect(session.said()).toEqual(['Command "/rename" requires new name.'])
  })
})

describe('the answers’ formats', () => {
  it('says what it does not know yet in /status', () => {
    const text = statusMessage({
      model: 'gpt-6.1-sol',
      effort: null,
      cwd: '/p',
      approval: 'never',
      sandbox: 'danger-full-access',
      account: { kind: 'none', label: 'Not signed in', email: null },
      sessionId: 't',
      usage: null,
      limits: null,
      now: 0,
    })
    expect(text.split('  \n')).toEqual([
      '**Model:** gpt-6.1-sol',
      '**Directory:** /p',
      '**Approval:** never',
      '**Sandbox:** danger-full-access',
      '**Account:** not logged in',
      '**Session:** `t`',
      '',
      '**Token usage:** data not available yet',
      '**Context window:** data not available yet',
      '**Limits:** data not available yet',
    ])
  })

  it('names the MCP servers safely, and cleans up their errors', () => {
    expect(inlineCode('a`b')).toBe('``a`b``')
    expect(inlineCode('')).toBe('(unnamed)')
    expect(
      errorDetail(
        'MCP startup failed: handshaking with MCP server failed: Bad *token*. Retry. Later.',
      ),
    ).toBe('Bad \\*token\\*. Retry.')
    expect(mcpStatusMessage([])).toBe('No MCP servers are configured.')
  })
})
