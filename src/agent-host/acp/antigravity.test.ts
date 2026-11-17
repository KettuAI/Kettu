// agy 1.5.9's ACP mode as Kettu reads it: what it takes without declaring, its plan, its titles,
// its tool calls and its hidden sessions, which may be opened and closed but never prompted.

import {
  agent,
  methods,
  type AgentContext,
  type SessionUpdate,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk/unstable'
import { describe, expect, it, vi } from 'vitest'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import {
  optionAnswer,
  type ConnectionHooks,
  type PermissionAnswer,
  type PermissionRequest,
  type SessionTarget,
} from '../connection'
import { newTurnScope } from '../session-updates'
import { AcpConnection, inProcessTransport } from './connection'
import { mapConfig } from './mapper'
import requests from './fixtures/agy-permissions.json'
import planned from './fixtures/agy-plan.json'
import turns from './fixtures/agy-plan-turns.json'
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
  const configs: { sessionId: string; configId: string; value: unknown }[] = []
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
    .onRequest(methods.agent.session.setConfigOption, (ctx) => {
      const { sessionId, configId, value } = ctx.params
      configs.push({ sessionId, configId, value })
      return { configOptions: [agyModes(String(value))] }
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
  return { connection, prompted, closed, accounts, signIns, configs }
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

/** agy's mode option as its `session/new` sends it, set to `mode`. */
function agyModes(mode: string) {
  return {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select' as const,
    currentValue: mode,
    options: [
      { value: 'default', name: 'Default', description: 'Ask before edits and commands.' },
      { value: 'accept-edits', name: 'Accept edits', description: 'Approve file edits.' },
      { value: 'auto', name: 'Auto', description: 'Approve edits and safe commands.' },
      { value: 'plan', name: 'Plan', description: 'Plan carefully before executing a task.' },
    ],
  }
}

type Recorded = { update: unknown } | { ask: { toolCall: unknown; options: unknown } }
const PLAN_TURNS = turns.turns as Recorded[][]

/**
 * agy in Plan mode playing the recorded turns in order, one a prompt: its plan, the plan it
 * rewrote after a note, then the build with its walkthrough. Each file it writes is kept as on disk.
 */
function planSession(version: string, mode: string, answer: PermissionAnswer, from = 0) {
  const files = new Map<string, string>()
  const events: string[] = []
  const queue = PLAN_TURNS.slice(from)
  const agy = connect(version, async (client, sessionId) => {
    for (const event of queue.shift() ?? []) {
      const value = JSON.parse(JSON.stringify(event).replaceAll(turns.sessionId, sessionId))
      if ('ask' in value) {
        await client.request(methods.client.session.requestPermission, {
          sessionId,
          toolCall: value.ask.toolCall,
          options: value.ask.options,
        })
        continue
      }
      const input = value.update.rawInput
      if (value.update.status === 'completed' && typeof input?.Content === 'string') {
        files.set(input.Path, input.Content)
      }
      await client.notify(methods.client.session.update, update(sessionId, value.update))
    }
  })
  const base = threadTarget()
  let thread: ThreadState = base.target.context().thread
  thread = applyPatches(thread, [
    { op: 'session.update', changes: { config: mapConfig([agyModes(mode)], null) } },
  ])
  const plans: PermissionRequest[] = []
  const target: SessionTarget = {
    ...base.target,
    context: () => ({ ...base.target.context(), thread }),
    apply: (output) => {
      thread = applyPatches(thread, output.patches)
    },
    requestPermission: async (request) => {
      target.apply(request.output)
      if (request.plan === undefined) return { optionId: 'allow' }
      plans.push(request)
      const picked = optionAnswer(answer)
      if (picked !== 'cancelled') {
        const kind = request.options.find((option) => option.id === picked.optionId)!.kind
        target.apply({
          patches: [
            {
              op: 'entry.update',
              id: request.toolEntryId,
              changes: { permissionResult: { optionId: picked.optionId, kind } },
            },
          ],
          effects: [],
        })
      }
      return answer
    },
    send: (text) => events.push(`send ${text}`),
    readAgentFile: async (file) => files.get(file) ?? null,
  }
  return {
    ...agy,
    target,
    plans,
    events,
    files,
    mode: () => thread.session.config.find((option) => option.id === 'mode')?.value,
    entries: () => threadEntries(thread),
  }
}

const PLAN_FILE = (sessionId: string) =>
  `/Users/me/.gemini/antigravity-cli/brain/${sessionId}/implementation_plan.md`

async function openPlanSession(session: ReturnType<typeof planSession>) {
  await session.connection.initialize('1.0.0')
  const { sessionId } = await session.connection.newSession('/tmp/agy-probe/plan')
  session.connection.register(sessionId, session.target)
  return sessionId
}

describe("agy's plans in Plan mode", () => {
  it('end a Plan mode turn in a plan card with the plan file agy wrote', async () => {
    const session = planSession('1.5.9', 'accept-edits', 'cancelled')
    const sessionId = await openPlanSession(session)
    // Entering Plan mode from Accept edits, which the card then builds in by default.
    await session.connection.setConfigOption(sessionId, 'mode', 'plan')
    session.target.apply({
      patches: [{ op: 'session.update', changes: { config: mapConfig([agyModes('plan')], null) } }],
      effects: [],
    })
    await session.connection.prompt(sessionId, [{ type: 'text', text: 'Add add(a, b)' }])

    await vi.waitFor(() => expect(session.plans).toHaveLength(1))
    const [request] = session.plans
    const markdown = session.files.get(PLAN_FILE(sessionId))!
    expect(markdown).toMatch(/^# Implementation Plan/)
    expect(request!.plan).toBe(markdown)
    expect(
      request!.options.map(({ id, kind, preferred, note }) => ({ id, kind, preferred, note })),
    ).toEqual([
      { id: 'exit-plan-default', kind: 'allow_once', preferred: undefined, note: undefined },
      { id: 'exit-plan-accept-edits', kind: 'allow_once', preferred: true, note: undefined },
      { id: 'exit-plan-auto', kind: 'allow_once', preferred: undefined, note: undefined },
      { id: 'keep_planning', kind: 'reject_once', preferred: undefined, note: true },
    ])
    expect(request!.options.slice(0, 3).map((option) => option.name)).toEqual([
      'Default',
      'Accept edits',
      'Auto',
    ])
    const entry = session.entries().find((e) => e.id === request!.toolEntryId)
    expect(entry).toMatchObject({
      kind: 'tool',
      planVersion: 1,
      content: [{ type: 'markdown', markdown }],
    })
    // The card follows agy's reply, which asks for the review.
    expect(session.entries().at(-1)?.id).toBe(request!.toolEntryId)
    session.connection.close()
  })

  it('gives no card outside Plan mode, for a file not marked for review or before 1.5.9', async () => {
    const outside = planSession('1.5.9', 'default', 'cancelled')
    const a = await openPlanSession(outside)
    await outside.connection.prompt(a, [{ type: 'text', text: 'go' }])

    const walkthrough = planSession('1.5.9', 'plan', 'cancelled', 2)
    const b = await openPlanSession(walkthrough)
    await walkthrough.connection.prompt(b, [{ type: 'text', text: 'go' }])

    const older = planSession('1.5.8', 'plan', 'cancelled')
    const c = await openPlanSession(older)
    await older.connection.prompt(c, [{ type: 'text', text: 'go' }])

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(walkthrough.files.size).toBe(1)
    for (const session of [outside, walkthrough, older]) {
      expect(session.plans).toEqual([])
      expect(session.entries().some((e) => e.kind === 'tool' && e.planVersion)).toBe(false)
      session.connection.close()
    }
  })

  it("builds in the chosen mode, then sends what agy's own terminal sends", async () => {
    const session = planSession('1.5.9', 'plan', { optionId: 'exit-plan-auto' })
    const sessionId = await openPlanSession(session)
    await session.connection.prompt(sessionId, [{ type: 'text', text: 'Add add(a, b)' }])

    await vi.waitFor(() => expect(session.events).toHaveLength(1))
    expect(session.configs).toEqual([{ sessionId, configId: 'mode', value: 'auto' }])
    expect(session.mode()).toBe('auto')
    expect(session.events).toEqual(['send [Approved] implementation_plan.md'])
    session.connection.close()
  })

  it('keeps planning in Plan mode with the note, and numbers the plan agy rewrites', async () => {
    const note = 'Name it plus instead of add, and add a JSDoc comment.'
    const session = planSession('1.5.9', 'plan', { optionId: 'keep_planning', note })
    const sessionId = await openPlanSession(session)
    await session.connection.prompt(sessionId, [{ type: 'text', text: 'Add add(a, b)' }])
    await vi.waitFor(() => expect(session.events).toEqual([`send ${note}`]))
    expect(session.configs).toEqual([])
    expect(session.mode()).toBe('plan')

    await session.connection.prompt(sessionId, [{ type: 'text', text: note }])
    await vi.waitFor(() => expect(session.plans).toHaveLength(2))
    const second = session.plans[1]!
    expect(second.plan).toBe(session.files.get(PLAN_FILE(sessionId)))
    expect(second.plan).toContain('plus')
    expect(second.toolEntryId).not.toBe(session.plans[0]!.toolEntryId)
    const entry = session.entries().find((e) => e.id === second.toolEntryId)
    expect(entry).toMatchObject({ kind: 'tool', planVersion: 2 })
    session.connection.close()
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
