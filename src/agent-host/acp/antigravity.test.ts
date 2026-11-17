// agy 1.5.9's ACP mode as Kettu reads it: what it takes without declaring, its plan, its titles,
// its tool calls and its hidden sessions, which may be opened and closed but never prompted.

import {
  agent,
  methods,
  type AgentContext,
  type SessionUpdate,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk/unstable'
import { describe, expect, it } from 'vitest'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import type { ConnectionHooks, SessionTarget } from '../connection'
import { newTurnScope } from '../session-updates'
import { AcpConnection, inProcessTransport } from './connection'
import requests from './fixtures/agy-permissions.json'
import planned from './fixtures/agy-plan.json'
import recorded from './fixtures/agy-tools.json'

const TIER = { name: 'Google AI Pro', id: 'g1-pro-tier', upgradeUri: 'https://example.com' }

function connect(
  version: string,
  turn?: (client: AgentContext, sessionId: string) => Promise<void>,
  tiers: (typeof TIER | null)[] = [],
) {
  const prompted: string[] = []
  const closed: string[] = []
  const accounts: string[] = []
  const signIns: (string | null)[] = []
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
    .onRequest(methods.agent.session.new, () => {
      const tier = tiers.length > 0 ? tiers.shift()! : TIER
      return { sessionId: `s-${++next}`, _meta: tier ? { antigravity: { tier } } : {} }
    })
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      prompted.push(ctx.params.sessionId)
      await turn?.(ctx.client, ctx.params.sessionId)
      return { stopReason: 'end_turn' as const }
    })
    .onRequest(methods.agent.session.close, (ctx) => {
      closed.push(ctx.params.sessionId)
      return {}
    })
  const hooks: ConnectionHooks = {
    traffic: () => {},
    account: (account) => accounts.push(account.label ?? ''),
    signInShown: (method) => signIns.push(method),
    ignored: () => {},
    log: () => {},
  }
  const connection = AcpConnection.connect(inProcessTransport(app), {
    ...hooks,
    agentId: 'antigravity',
    name: 'Google Antigravity',
  })
  return { connection, prompted, closed, accounts, signIns }
}

/** A session's thread, with every permission request allowed once. */
function threadTarget() {
  let thread: ThreadState = threadFromSnapshot({
    session: {
      id: 's',
      agentId: 'antigravity',
      projectPath: '/tmp/agy-probe',
      acpSessionId: 's-1',
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
  const asked: string[] = []
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
    requestPermission: async (request) => {
      asked.push(request.toolCallId)
      target.apply(request.output)
      return { optionId: 'allow' }
    },
    send: () => {},
    startMode: () => null,
  }
  return { target, asked, entries: (): ThreadEntry[] => threadEntries(thread) }
}

const update = (sessionId: string, value: unknown) => ({
  sessionId,
  update: value as SessionUpdate,
})

describe("agy's tool calls", () => {
  it('show commands, their output, files and diffs, and hide what Kettu shows itself', async () => {
    const { connection } = connect('1.5.9', async (client, sessionId) => {
      for (const value of recorded) {
        await client.notify(methods.client.session.update, update(sessionId, value))
      }
    })
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/tmp/agy-probe')
    const { target, entries } = threadTarget()
    connection.register(sessionId, target)
    await connection.prompt(sessionId, [{ type: 'text', text: 'go' }])

    const rows = entries().map((entry) => {
      if (entry.kind !== 'tool') return entry.kind
      const { title, toolKind, status, content, locations, rawInput, description } = entry
      return { title, toolKind, status, content, locations, rawInput, description }
    })
    expect(rows).toEqual([
      {
        title: 'echo hi',
        toolKind: 'execute',
        status: 'completed',
        content: [{ type: 'markdown', markdown: '```\nhi\n```' }],
        locations: [],
        rawInput: 'echo hi',
        description: 'Echo hi',
      },
      {
        title: 'File README.md',
        toolKind: 'read',
        status: 'completed',
        content: [],
        locations: [{ path: '/tmp/agy-probe/ws4/README.md' }],
        rawInput: '{\n  "Path": "/tmp/agy-probe/ws4/README.md"\n}',
        description: undefined,
      },
      {
        title: 'grep -rn "hello" .',
        toolKind: 'execute',
        status: 'completed',
        content: [{ type: 'markdown', markdown: '```\n./README.md:2:hello world\n```' }],
        locations: [],
        rawInput: 'grep -rn "hello" .',
        description: 'Search for hello',
      },
      expect.objectContaining({
        title: 'File README.md',
        toolKind: 'edit',
        status: 'completed',
        content: [
          {
            type: 'diff',
            path: '/tmp/agy-probe/ws4/README.md',
            oldText: '# probe\nhello world\n',
            newText: '# probe\ngoodbye world\n',
          },
        ],
      }),
      // A command that exits non-zero fails, as Claude Code's and Codex's do.
      expect.objectContaining({
        title: 'ls /nonexistent-kettu',
        status: 'failed',
        content: [
          {
            type: 'markdown',
            markdown: '```\nls: /nonexistent-kettu: No such file or directory\n```',
          },
        ],
        rawInput: 'ls /nonexistent-kettu',
      }),
      expect.objectContaining({
        title: 'true',
        status: 'completed',
        content: [],
        rawInput: 'true',
      }),
      expect.objectContaining({ title: 'File .', toolKind: 'read', status: 'failed' }),
      expect.objectContaining({ title: 'File notes.txt', toolKind: 'edit', status: 'completed' }),
      // The plan shows in the top bar; a memory write that failed wrote nothing, so it keeps a row.
      // Kettu's tools take the names Claude Code gives them.
      expect.objectContaining({ title: 'mcp__kettu__remember', status: 'failed' }),
      expect.objectContaining({ title: 'mcp__kettu__list_sessions', status: 'completed' }),
    ])
    connection.close()
  })

  it('keep the row of a Kettu call that asked for permission', async () => {
    const call = recorded.find((value) => value.name === 'mcp_kettu_set_plan')!
    const { connection } = connect('1.5.9', async (client, sessionId) => {
      await client.notify(methods.client.session.update, update(sessionId, call))
      await client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: { ...call, status: 'pending' } as ToolCallUpdate,
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      })
      await client.notify(
        methods.client.session.update,
        update(sessionId, { ...call, sessionUpdate: 'tool_call_update', status: 'completed' }),
      )
    })
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/tmp/agy-probe')
    const { target, entries } = threadTarget()
    connection.register(sessionId, target)
    await connection.prompt(sessionId, [{ type: 'text', text: 'go' }])

    expect(entries()).toEqual([
      expect.objectContaining({
        kind: 'tool',
        title: 'mcp__kettu__set_plan',
        status: 'completed',
      }),
    ])
    connection.close()
  })
})

describe("agy's Plan mode", () => {
  it('shows no row for the files agy keeps in its own folder, such as its plan', async () => {
    const { connection } = connect('1.5.9', async (client, sessionId) => {
      for (const value of planned) {
        await client.notify(methods.client.session.update, update(sessionId, value))
      }
    })
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/tmp/agy-probe/plan')
    const { target, entries } = threadTarget()
    connection.register(sessionId, target)
    await connection.prompt(sessionId, [{ type: 'text', text: 'go' }])

    expect(entries().map((entry) => (entry.kind === 'tool' ? entry.title : entry.kind))).toEqual([
      'mcp__kettu__list_sessions',
      'ls -la',
      'File README.md',
      'git status && git log -n 5',
    ])
    connection.close()
  })
})

describe("agy's permission requests", () => {
  it("allow Kettu's pre-approved tools once without a card, and ask for any other", async () => {
    const [plan, remember, list] = requests
    const command = recorded[0]!
    const answers: unknown[] = []
    const { connection } = connect('1.5.9', async (client, sessionId) => {
      const ask = async (toolCall: { toolCallId: string }, options: unknown[]) => {
        const progress = { ...toolCall, status: 'in_progress' }
        await client.notify(methods.client.session.update, update(sessionId, progress))
        const params = { sessionId, toolCall, options } as never
        answers.push(await client.request(methods.client.session.requestPermission, params))
        const done = { ...toolCall, sessionUpdate: 'tool_call_update', status: 'completed' }
        await client.notify(methods.client.session.update, update(sessionId, done))
      }
      await ask(plan!.toolCall, plan!.options)
      await ask(list!.toolCall, list!.options)
      await ask(remember!.toolCall, remember!.options)
      await ask(command, plan!.options)
    })
    await connection.initialize('1.0.0')
    // The set Claude Code and Codex are given for Kettu's service; here without the memory write.
    const { sessionId } = await connection.newSession('/tmp/agy-probe', {
      mcpServers: [
        {
          type: 'http',
          name: 'kettu',
          url: 'http://127.0.0.1:1/mcp',
          headers: [],
          autoAllow: ['set_plan', 'list_sessions'],
        },
        { type: 'http', name: 'other', url: 'http://127.0.0.1:2/mcp', headers: [], autoAllow: [] },
      ],
    })
    const { target, asked, entries } = threadTarget()
    connection.register(sessionId, target)
    await connection.prompt(sessionId, [{ type: 'text', text: 'go' }])

    expect(answers).toEqual([
      { outcome: { outcome: 'selected', optionId: 'allow' } },
      { outcome: { outcome: 'selected', optionId: 'allow' } },
      { outcome: { outcome: 'selected', optionId: 'allow' } },
      { outcome: { outcome: 'selected', optionId: 'allow' } },
    ])
    // Only the memory write outside the set and the command waited for the user.
    expect(asked).toEqual([remember!.toolCall.toolCallId, command.toolCallId])
    expect(entries().map((entry) => (entry.kind === 'tool' ? entry.title : entry.kind))).toEqual([
      'mcp__kettu__list_sessions',
      'mcp__kettu__remember',
      'echo hi',
    ])
    connection.close()
  })
})

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

  it('shows the sign-in by the plan its answers name, whatever its auth state file says', async () => {
    const { connection, signIns } = connect('1.5.9', undefined, [
      TIER,
      { ...TIER, name: 'Gemini Enterprise Standard', id: 'gcp-ge-standard-tier' },
      null,
    ])
    await connection.initialize('1.0.0')
    await connection.newSession('/repo')
    await connection.newSession('/repo')
    // An API key or a cloud project has no plan: the answer shows no sign-in of Google's.
    await connection.newSession('/repo')
    expect(signIns).toEqual(['oauth-personal', 'oauth-business', null])
    connection.close()
  })

  it('reads none of it on an earlier version', async () => {
    const { connection, accounts, signIns } = connect('1.4.3')
    const init = await connection.initialize('1.0.0')
    expect(init.capabilities.mcpHttp).toBe(false)
    expect(init.capabilities.ownTitles).toBeNull()
    expect(connection.unpromptedSessions).toBe(false)
    await connection.newSession('/repo')
    expect(accounts).toEqual([])
    expect(signIns).toEqual([])
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
