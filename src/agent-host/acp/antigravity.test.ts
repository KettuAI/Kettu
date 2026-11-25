// agy 1.5.9's ACP mode as Kettu reads it: what it takes without declaring, its plan, its titles,
// its tool calls and its hidden sessions, which may be opened and closed but never prompted.

import {
  agent,
  methods,
  RequestError,
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
import { newTurnScope, type MapperEffect } from '../session-updates'
import { AcpConnection, inProcessTransport } from './connection'
import { AgyContextEstimator } from './agy-context'
import { mapConfig } from './mapper'
import edit from './fixtures/agy-edit-request.json'
import requests from './fixtures/agy-permissions.json'
import compacted from './fixtures/agy-compact.json'
import planned from './fixtures/agy-plan.json'
import turns from './fixtures/agy-plan-turns.json'
import recorded from './fixtures/agy-tools.json'

const TIER = { name: 'Google AI Pro', id: 'g1-pro-tier', upgradeUri: 'https://example.com' }

function connect(
  version: string,
  turn?: (client: AgentContext, sessionId: string) => Promise<void>,
  tiers: (typeof TIER | null)[] = [],
  declared = true,
  stopReason: 'end_turn' | 'cancelled' = 'end_turn',
) {
  const prompted: string[] = []
  const opened: { method: string; meta: unknown }[] = []
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
        _meta: {
          antigravity: { tier: true, ...(declared ? { systemPrompt: { append: true } } : {}) },
        },
      },
      agentInfo: { name: 'Antigravity ACP Server', version },
      authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
    }))
    .onRequest(methods.agent.session.new, (ctx) => {
      opened.push({ method: 'new', meta: ctx.params._meta })
      const tier = tiers.length > 0 ? tiers.shift()! : TIER
      return { sessionId: `s-${++next}`, _meta: tier ? { antigravity: { tier } } : {} }
    })
    .onRequest(methods.agent.session.load, (ctx) => {
      opened.push({ method: 'load', meta: ctx.params._meta })
      return {}
    })
    .onRequest(methods.agent.session.resume, (ctx) => {
      opened.push({ method: 'resume', meta: ctx.params._meta })
      return {}
    })
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      prompted.push(ctx.params.sessionId)
      await turn?.(ctx.client, ctx.params.sessionId)
      return { stopReason }
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
  return { connection, prompted, closed, accounts, signIns, configs, opened }
}

/** A session's thread, with every permission request allowed once; `files` are the project's. */
function threadTarget(files: Record<string, string> = {}) {
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
    readProjectFile: async (file) => files[file] ?? null,
  }
  return {
    target,
    asked,
    entries: (): ThreadEntry[] => threadEntries(thread),
    usage: () => thread.session.usage,
  }
}

const update = (sessionId: string, value: unknown) => ({
  sessionId,
  update: value as SessionUpdate,
})

describe("agy's /compact", () => {
  // agy 1.5.9 says nothing of a compaction over ACP: its turn is a usage_update and end_turn.
  async function compactTurn(
    version: string,
    text: string,
    stopReason: 'end_turn' | 'cancelled' = 'end_turn',
  ) {
    const { connection } = connect(
      version,
      async (client, sessionId) => {
        for (const value of compacted.updates) {
          await client.notify(methods.client.session.update, update(sessionId, value))
        }
      },
      [],
      true,
      stopReason,
    )
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/tmp/agy-probe')
    const thread = threadTarget()
    connection.register(sessionId, thread.target)
    await connection.prompt(sessionId, [{ type: 'text', text }])
    return thread
  }
  const dividers = (entries: ThreadEntry[]) =>
    entries.filter((entry) => entry.kind === 'compaction')

  it('adds the divider every agent gets when the turn that sent it ends', async () => {
    const { entries, usage } = await compactTurn('1.5.9', compacted.prompt[0]!.text)
    expect(dividers(entries())).toEqual([
      { kind: 'compaction', id: expect.stringMatching(/^c:/), status: 'completed', summary: '' },
    ])
    // The ring follows agy's usage_update, as for any turn.
    expect(usage()).toMatchObject({ used: 31_366, size: 1_048_576 })
  })

  it('does so with summarization instructions, which agy takes after the command', async () => {
    const { entries } = await compactTurn('1.5.9', '/compact keep the open questions')
    expect(dividers(entries())).toHaveLength(1)
  })

  it('adds none for another message, a command that only starts like it, or a turn that did not end', async () => {
    for (const text of ['go on', 'run /compact now', '/compactor', '/plan']) {
      expect(dividers((await compactTurn('1.5.9', text)).entries()), text).toEqual([])
    }
    const stopped = await compactTurn('1.5.9', '/compact', 'cancelled')
    expect(dividers(stopped.entries())).toEqual([])
  })

  it('adds none on a version it was not checked on', async () => {
    const { entries } = await compactTurn('1.5.8', '/compact')
    expect(dividers(entries())).toEqual([])
  })
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
  const approvals: string[] = []
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
    send: (text, options) => {
      events.push(`send ${text}`)
      if (options?.approval) approvals.push(text)
    },
    readAgentFile: async (file) => files.get(file) ?? null,
  }
  return {
    ...agy,
    target,
    plans,
    events,
    approvals,
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
    expect(session.approvals).toEqual(['[Approved] implementation_plan.md'])
    session.connection.close()
  })

  it('keeps planning in Plan mode with the note, and numbers the plan agy rewrites', async () => {
    const note = 'Name it plus instead of add, and add a JSDoc comment.'
    const session = planSession('1.5.9', 'plan', { optionId: 'keep_planning', note })
    const sessionId = await openPlanSession(session)
    await session.connection.prompt(sessionId, [{ type: 'text', text: 'Add add(a, b)' }])
    await vi.waitFor(() => expect(session.events).toEqual([`send ${note}`]))
    expect(session.approvals).toEqual([])
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

  it('auto-allows reversible Kettu MCP tools and safe terminal_run in Auto mode while asking for irreversible ones', async () => {
    const OPTIONS = [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ]
    const directCall = (toolCallId: string, name: string, rawInput: Record<string, unknown>) => ({
      sessionUpdate: 'tool_call',
      toolCallId,
      name,
      args: rawInput,
      status: 'pending',
      kind: 'other',
      title: `Run ${name}`,
      rawInput,
    })

    const calls = [
      directCall('c-create', 'mcp_kettu_create_artifact', { title: 'Demo' }),
      gatewayCall('c-update', 'update_artifact', { id: 'a1', title: 'Demo 2' }),
      directCall('c-nav', 'mcp_kettu_browser_navigate', { url: 'http://localhost:5173' }),
      gatewayCall('c-tap', 'device_tap', { deviceId: 'ios-sim:1', ref: '@e1' }),
      gatewayCall('c-stop', 'terminal_stop', { terminalId: 't1' }),
      gatewayCall('c-safe-cmd', 'terminal_run', { command: 'pnpm dev' }),
      // 以下均为不可回滚或外部/高危操作，在 Auto 模式下仍必须询问用户。
      gatewayCall('c-delete', 'delete_artifact', { id: 'a1' }),
      gatewayCall('c-rm', 'terminal_run', { command: 'rm -rf /tmp/demo' }),
      gatewayCall('c-push', 'terminal_run', { command: 'git push origin main' }),
      gatewayCall('c-input', 'terminal_input', { terminalId: 't1', text: 'y', enter: true }),
      gatewayCall('c-click', 'computer_click', { pid: 1, window_id: 1, x: 10, y: 10 }),
      directCall('c-ext', 'mcp_github_push_files', { owner: 'a', repo: 'b' }),
    ]

    async function runInMode(mode: 'default' | 'auto') {
      const { connection } = connect('1.5.16', async (client, sessionId) => {
        for (const call of calls) {
          await client.notify(methods.client.session.update, update(sessionId, call))
          await client.request(methods.client.session.requestPermission, {
            sessionId,
            toolCall: call,
            options: OPTIONS,
          } as never)
          await client.notify(
            methods.client.session.update,
            update(sessionId, { ...call, sessionUpdate: 'tool_call_update', status: 'completed' }),
          )
        }
      })
      await connection.initialize('1.0.0')
      const { sessionId } = await connection.newSession('/tmp/agy-probe', {
        mcpServers: [
          {
            type: 'http',
            name: 'kettu',
            url: 'http://127.0.0.1:1/mcp',
            headers: [],
            autoAllow: ['set_plan', 'read_kettu_guide'],
            autoModeAllow: [
              'create_artifact',
              'update_artifact',
              'browser_navigate',
              'device_tap',
              'terminal_stop',
            ],
          },
          { type: 'http', name: 'github', url: 'http://127.0.0.1:2/mcp', headers: [] },
        ],
      })
      const { target, asked } = threadTarget()
      target.apply({
        patches: [{ op: 'session.update', changes: { config: mapConfig([agyModes(mode)], null) } }],
        effects: [],
      })
      connection.register(sessionId, target)
      await connection.prompt(sessionId, [{ type: 'text', text: 'go' }])
      connection.close()
      return asked
    }

    // Default 模式下所有写/执行/外部工具都应询问。
    expect(await runInMode('default')).toEqual(calls.map((call) => call.toolCallId))
    // Auto 模式下可回滚 Kettu 工具和安全 terminal_run 自动放行，不可逆与外部工具继续询问。
    expect(await runInMode('auto')).toEqual([
      'c-delete',
      'c-rm',
      'c-push',
      'c-input',
      'c-click',
      'c-ext',
    ])
  })
})

/** A call of Kettu's gateway as agy 1.5.14 sends it, every update repeating its name and input. */
function gatewayCall(toolCallId: string, tool: string, args?: Record<string, unknown>) {
  const rawInput = { tool, ...(args ? { arguments: args } : {}), toolSummary: `Use ${tool}` }
  return {
    sessionUpdate: 'tool_call',
    toolCallId,
    name: 'mcp_kettu_call_kettu_tool',
    args: rawInput,
    status: 'pending',
    kind: 'other',
    title: 'Run mcp_kettu_call_kettu_tool',
    rawInput,
  }
}

describe("agy's calls through Kettu's gateway", () => {
  const OPTIONS = [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  ]

  async function run(calls: ReturnType<typeof gatewayCall>[], autoAllow: string[]) {
    const answers: unknown[] = []
    const { connection } = connect('1.5.14', async (client, sessionId) => {
      for (const call of calls) {
        await client.notify(methods.client.session.update, update(sessionId, call))
        const params = { sessionId, toolCall: call, options: OPTIONS } as never
        answers.push(await client.request(methods.client.session.requestPermission, params))
        const done = { ...call, sessionUpdate: 'tool_call_update', status: 'completed' }
        await client.notify(methods.client.session.update, update(sessionId, done))
      }
    })
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/tmp/agy-probe', {
      mcpServers: [
        { type: 'http', name: 'kettu', url: 'http://127.0.0.1:1/mcp', headers: [], autoAllow },
      ],
    })
    const { target, asked, entries } = threadTarget()
    connection.register(sessionId, target)
    await connection.prompt(sessionId, [{ type: 'text', text: 'go' }])
    connection.close()
    return { answers, asked, entries: entries() }
  }

  // Allowing the gateway itself would run any tool behind it without the user.
  it('ask, show and hide as the tool they run, and a lookup runs without a card', async () => {
    const list = gatewayCall('c1', 'list_sessions', {})
    const terminal = gatewayCall('c2', 'terminal_run', { command: 'npm test' })
    const lookup = gatewayCall('c3', 'device_tap')
    const plan = gatewayCall('c4', 'set_plan', { steps: [{ content: 'A', status: 'pending' }] })
    const { answers, asked, entries } = await run(
      [list, terminal, lookup, plan],
      ['set_plan', 'list_sessions', 'read_kettu_guide'],
    )
    expect(answers).toEqual(Array(4).fill({ outcome: { outcome: 'selected', optionId: 'allow' } }))
    expect(asked).toEqual(['c2'])
    const rows = entries.map((entry) =>
      entry.kind === 'tool' ? { title: entry.title, input: entry.rawInput } : entry.kind,
    )
    // The plan shows in the top bar, as a direct call of it does.
    expect(rows).toEqual([
      { title: 'mcp__kettu__list_sessions', input: expect.not.stringContaining('"tool"') },
      { title: 'mcp__kettu__terminal_run', input: 'npm test' },
      { title: 'mcp__kettu__call_kettu_tool', input: expect.stringContaining('"device_tap"') },
    ])
  })

  it("ask for a lookup when Kettu's own server is not the session's", async () => {
    const { asked } = await run([gatewayCall('c1', 'device_tap')], [])
    expect(asked).toEqual(['c1'])
  })
})

describe("agy's edit requests", () => {
  const file = edit.toolCall.content[0]!.path

  /** The content of the card for agy's `edit_file` request, with `files` as the project's. */
  async function cardDiff(files: Record<string, string>, toolCall: object = edit.toolCall) {
    const { connection } = connect('1.5.9', async (client, sessionId) => {
      const params = { sessionId, toolCall, options: edit.options } as never
      await client.request(methods.client.session.requestPermission, params)
    })
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/tmp/agy-probe/ws4')
    const { target, entries } = threadTarget(files)
    connection.register(sessionId, target)
    await connection.prompt(sessionId, [{ type: 'text', text: 'go' }])
    connection.close()
    const entry = entries().find((e) => e.kind === 'tool')
    return entry?.kind === 'tool' ? entry.content : null
  }

  it('draw the whole file, as the finished call does, not the snippet it replaces', async () => {
    expect(await cardDiff({ [file]: edit.file })).toEqual([edit.finished])
  })

  it('draw the snippet when the file cannot be read, or lacks the target or has it twice', async () => {
    const snippet = edit.toolCall.content
    expect(await cardDiff({})).toEqual(snippet)
    expect(await cardDiff({ [file]: 'line one\nline 3\n' })).toEqual(snippet)
    expect(await cardDiff({ [file]: 'line three\nand line three\n' })).toEqual(snippet)
  })

  it('put the replacement in as written, whatever characters it holds', async () => {
    const toolCall = {
      ...edit.toolCall,
      rawInput: { ...edit.toolCall.rawInput, Replacement: "$& $' $$ line three" },
    }
    const [diff] = (await cardDiff({ [file]: edit.file }, toolCall)) as { newText: string }[]
    expect(diff!.newText).toBe(
      "line one\nline two\n$& $' $$ line three\nline four\nline five\nline six\n",
    )
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

/**
 * agy behind the session router, which names the session flag it found in `agy acp --help`: each
 * `session/resume` starts the session's process again, at agy's own model and in Default, as agy
 * 1.5.9 does. `turn` holds a prompt open until the test lets it end.
 */
function flaggedAgy(version: string, flag: string | null, refusesFlag = false) {
  const sent: { method: string; params: Record<string, unknown> }[] = []
  let turn: Promise<void> = Promise.resolve()
  let during: ((client: AgentContext, sessionId: string) => Promise<void>) | null = null
  let resuming: ((client: AgentContext, sessionId: string) => Promise<void>) | null = null
  let stopReason: 'end_turn' | 'cancelled' = 'end_turn'
  const values = { model: 'gemini', thought_level: 'high', mode: 'default' }
  const options = () => [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select' as const,
      currentValue: values.model,
      options: [
        { value: 'gemini', name: 'Gemini' },
        { value: 'claude', name: 'Claude' },
      ],
    },
    {
      id: 'thought_level',
      name: 'Thinking',
      category: 'thought_level',
      type: 'select' as const,
      currentValue: values.thought_level,
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
    agyModes(values.mode),
  ]
  const app = agent({ name: 'agy-test' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
      agentInfo: { name: 'Antigravity ACP Server', version },
      authMethods: [],
      ...(flag ? { _meta: { 'sh.kettu/session-flag': flag } } : {}),
    }))
    .onRequest(methods.agent.session.new, (ctx) => {
      sent.push({ method: 'new', params: ctx.params as never })
      const meta = ctx.params._meta as Record<string, unknown> | undefined
      if (refusesFlag && meta?.['sh.kettu/session-flag']) {
        throw new RequestError(-32603, 'agy exited')
      }
      return { sessionId: 's-1', configOptions: options() }
    })
    .onRequest(methods.agent.session.resume, async (ctx) => {
      sent.push({ method: 'resume', params: ctx.params as never })
      const meta = ctx.params._meta as Record<string, unknown> | undefined
      if (refusesFlag && meta?.['sh.kettu/session-flag']) {
        throw new RequestError(-32603, 'agy exited')
      }
      Object.assign(values, { model: 'gemini', thought_level: 'high', mode: 'default' })
      await resuming?.(ctx.client, ctx.params.sessionId)
      return { configOptions: options() }
    })
    .onRequest(methods.agent.session.setConfigOption, (ctx) => {
      const { configId, value } = ctx.params as { configId: keyof typeof values; value: string }
      sent.push({ method: `set ${configId}=${value}`, params: ctx.params as never })
      values[configId] = value
      return { configOptions: options() }
    })
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      sent.push({ method: 'prompt', params: ctx.params as never })
      await during?.(ctx.client, ctx.params.sessionId)
      await turn
      return { stopReason }
    })
  const connection = AcpConnection.connect(inProcessTransport(app), {
    traffic: () => {},
    account: () => {},
    ignored: () => {},
    log: () => {},
    agentId: 'antigravity',
    name: 'Google Antigravity',
  })
  const hold = () => {
    let release!: () => void
    turn = new Promise((resolve) => (release = resolve))
    return release
  }
  const send = (run: (client: AgentContext, sessionId: string) => Promise<void>) => {
    during = run
  }
  const onResume = (run: (client: AgentContext, sessionId: string) => Promise<void>) => {
    resuming = run
  }
  const setStopReason = (reason: 'end_turn' | 'cancelled') => {
    stopReason = reason
  }
  return {
    connection,
    sent,
    hold,
    send,
    onResume,
    setStopReason,
    methods: () => sent.map((item) => item.method),
  }
}

const FULL = 'dangerously-skip-permissions'
const MCP = [{ type: 'http' as const, name: 'kettu', url: 'http://127.0.0.1:1/mcp', headers: [] }]

const valueOf = (config: { id: string; value: unknown }[], id: string) =>
  config.find((option) => option.id === id)?.value

describe("agy's full access", () => {
  it("lists Full access after agy's modes only from 1.5.9 with the flag the router found", async () => {
    for (const [version, flag, listed] of [
      ['1.5.9', '--dangerously-skip-permissions', true],
      ['1.5.9', null, false],
      ['1.5.8', '--dangerously-skip-permissions', false],
    ] as const) {
      const { connection } = flaggedAgy(version, flag)
      await connection.initialize('1.0.0')
      const { config } = await connection.newSession('/repo')
      const mode = config.find((option) => option.id === 'mode')!
      const choices = mode.choices!.map((choice) => choice.value)
      expect(choices).toEqual(
        listed
          ? ['default', 'accept-edits', 'auto', 'plan', FULL]
          : ['default', 'accept-edits', 'auto', 'plan'],
      )
      if (listed) expect(mode.choices!.at(-1)!.name).toBe('Full access')
      connection.close()
    }
  })

  it("restarts the session's agy with the flag and back, keeping its values, in Default", async () => {
    const agy = flaggedAgy('1.5.9', '--dangerously-skip-permissions')
    const { connection, sent } = agy
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/repo', { mcpServers: MCP })
    await connection.setConfigOption(sessionId, 'model', 'claude')
    await connection.setConfigOption(sessionId, 'thought_level', 'low')
    await connection.setConfigOption(sessionId, 'mode', 'plan')
    sent.length = 0

    const full = await connection.setConfigOption(sessionId, 'mode', FULL)
    // Entering it leaves Plan mode: agy comes back in Default, which full access holds.
    expect(agy.methods()).toEqual(['resume', 'set model=claude', 'set thought_level=low'])
    const resume = sent[0]!.params
    expect(resume).toMatchObject({ sessionId, cwd: '/repo' })
    expect((resume.mcpServers as { name: string }[]).map((server) => server.name)).toEqual([
      'kettu',
    ])
    expect((resume._meta as Record<string, unknown>)['sh.kettu/session-flag']).toBe(true)
    expect([valueOf(full, 'model'), valueOf(full, 'thought_level'), valueOf(full, 'mode')]).toEqual(
      ['claude', 'low', FULL],
    )
    sent.length = 0

    const auto = await connection.setConfigOption(sessionId, 'mode', 'auto')
    expect(agy.methods()).toEqual([
      'resume',
      'set model=claude',
      'set thought_level=low',
      'set mode=auto',
    ])
    expect(
      (sent[0]!.params._meta as Record<string, unknown> | undefined)?.['sh.kettu/session-flag'],
    ).toBeUndefined()
    expect(valueOf(auto, 'mode')).toBe('auto')
    expect(auto.find((option) => option.id === 'mode')!.choices!.at(-1)!.value).toBe(FULL)
    connection.close()
  })

  it('opens a session asked for in full access with the flag, without a restart', async () => {
    const agy = flaggedAgy('1.5.9', '--dangerously-skip-permissions')
    const { connection, sent } = agy
    await connection.initialize('1.0.0')
    const { sessionId, config } = await connection.newSession('/repo', { fullAccess: true })
    expect(agy.methods()).toEqual(['new'])
    expect((sent[0]!.params._meta as Record<string, unknown>)['sh.kettu/session-flag']).toBe(true)
    expect(valueOf(config, 'mode')).toBe(FULL)
    sent.length = 0

    await connection.setConfigOption(sessionId, 'mode', FULL)
    expect(agy.methods()).toEqual([])
    const auto = await connection.setConfigOption(sessionId, 'mode', 'auto')
    expect(agy.methods()).toEqual(['resume', 'set mode=auto'])
    expect(valueOf(auto, 'mode')).toBe('auto')
    connection.close()
  })

  it('opens without the flag when agy will not start with it, or the router found none', async () => {
    const refused = flaggedAgy('1.5.9', '--dangerously-skip-permissions', true)
    await refused.connection.initialize('1.0.0')
    const opened = await refused.connection.newSession('/repo', { fullAccess: true })
    expect(refused.methods()).toEqual(['new', 'new'])
    expect(refused.sent[1]!.params._meta).toBeUndefined()
    expect(valueOf(opened.config, 'mode')).toBe('default')
    refused.connection.close()

    const unlisted = flaggedAgy('1.5.9', null)
    await unlisted.connection.initialize('1.0.0')
    await unlisted.connection.newSession('/repo', { fullAccess: true })
    expect(unlisted.sent[0]!.params._meta).toBeUndefined()
    unlisted.connection.close()
  })

  it('switches only once the running turn ends, and a later choice replaces it', async () => {
    const agy = flaggedAgy('1.5.9', '--dangerously-skip-permissions')
    const { connection, sent } = agy
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/repo')
    const { target } = threadTarget()
    let config = await connection.setConfigOption(sessionId, 'mode', 'default')
    target.apply({ patches: [{ op: 'session.update', changes: { config } }], effects: [] })
    connection.register(sessionId, target)
    sent.length = 0

    let release = agy.hold()
    let turn = connection.prompt(sessionId, [{ type: 'text', text: 'go' }])
    await vi.waitFor(() => expect(agy.methods()).toEqual(['prompt']))
    config = await connection.setConfigOption(sessionId, 'mode', FULL)
    expect(valueOf(config, 'mode')).toBe('default')
    expect(config.find((option) => option.id === 'mode')?.pending).toEqual({
      value: FULL,
      wait: 'turn',
    })
    expect(agy.methods()).toEqual(['prompt'])
    release()
    await turn
    // The restart came before the turn's end reached the session.
    expect(agy.methods()).toEqual(['prompt', 'resume'])
    const settled = target.context().thread.session.config.find((option) => option.id === 'mode')!
    expect(settled.value).toBe(FULL)
    expect(settled.pending).toBeUndefined()
    sent.length = 0

    release = agy.hold()
    turn = connection.prompt(sessionId, [{ type: 'text', text: 'go on' }])
    await vi.waitFor(() => expect(agy.methods()).toEqual(['prompt']))
    const leaving = await connection.setConfigOption(sessionId, 'mode', 'accept-edits')
    expect(leaving.find((option) => option.id === 'mode')?.pending).toEqual({
      value: 'accept-edits',
      wait: 'turn',
    })
    const cancelled = await connection.setConfigOption(sessionId, 'mode', FULL)
    expect(cancelled.find((option) => option.id === 'mode')?.pending).toBeUndefined()
    release()
    await turn
    // Back to where it was: nothing restarts.
    expect(agy.methods()).toEqual(['prompt'])
    expect(valueOf(target.context().thread.session.config, 'mode')).toBe(FULL)
    connection.close()
  })

  it('cancels a pending full access switch without resending the current mode', async () => {
    const agy = flaggedAgy('1.5.9', '--dangerously-skip-permissions')
    const { connection, sent } = agy
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/repo')
    await connection.setConfigOption(sessionId, 'mode', 'auto')
    sent.length = 0

    const release = agy.hold()
    const turn = connection.prompt(sessionId, [{ type: 'text', text: 'work' }])
    await vi.waitFor(() => expect(agy.methods()).toEqual(['prompt']))

    const queued = await connection.setConfigOption(sessionId, 'mode', FULL)
    expect(queued.find((option) => option.id === 'mode')?.pending).toEqual({
      value: FULL,
      wait: 'turn',
    })
    const undone = await connection.setConfigOption(sessionId, 'mode', 'auto')
    expect(undone.find((option) => option.id === 'mode')?.value).toBe('auto')
    expect(undone.find((option) => option.id === 'mode')?.pending).toBeUndefined()
    expect(agy.methods()).toEqual(['prompt'])

    release()
    await turn
    expect(agy.methods()).toEqual(['prompt'])
    connection.close()
  })

  it('resumes a session directly with full access when requested', async () => {
    const agy = flaggedAgy('1.5.9', '--dangerously-skip-permissions')
    const { connection, sent } = agy
    await connection.initialize('1.0.0')
    const { config } = await connection.resumeSession('s-1', '/repo', { fullAccess: true })
    expect(agy.methods()).toEqual(['resume'])
    expect((sent[0]!.params._meta as Record<string, unknown>)['sh.kettu/session-flag']).toBe(true)
    expect(valueOf(config, 'mode')).toBe(FULL)
    connection.close()
  })

  it('keeps the previous mode with restarting state while agy pushes default during resume', async () => {
    const agy = flaggedAgy('1.5.9', '--dangerously-skip-permissions')
    const { connection } = agy
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/repo')
    const thread = recording()
    const auto = await connection.setConfigOption(sessionId, 'mode', 'auto')
    thread.target.apply({
      patches: [{ op: 'session.update', changes: { config: auto } }],
      effects: [],
    })
    connection.register(sessionId, thread.target)

    const seenDuringResume: { value: unknown; pending: unknown }[] = []
    const origApply = thread.target.apply
    thread.target.apply = (output) => {
      origApply(output)
      const mode = thread.target
        .context()
        .thread.session.config.find((option) => option.id === 'mode')
      if (mode) seenDuringResume.push({ value: mode.value, pending: mode.pending })
    }
    agy.onResume(async (client, id) => {
      // 复现 agy 1.5.16 真实行为：session/resume 返回前会推送一次临时的 default 模式更新。
      await client.notify(
        methods.client.session.update,
        update(id, { sessionUpdate: 'config_option_update', configOptions: [agyModes('default')] }),
      )
    })

    const switched = await connection.setConfigOption(sessionId, 'mode', FULL)
    expect(valueOf(switched, 'mode')).toBe(FULL)
    expect(switched.find((option) => option.id === 'mode')?.pending).toBeUndefined()
    // 整个重启过程中既向 UI 推送了 restarting，又没有被临时 default 覆盖掉原模式 auto。
    expect(seenDuringResume).toEqual([
      { value: 'auto', pending: { value: FULL, wait: 'restarting' } },
      { value: 'auto', pending: { value: FULL, wait: 'restarting' } },
    ])
    connection.close()
  })

  it('clears pending state and rolls back cleanly when restarting for full access fails', async () => {
    const agy = flaggedAgy('1.5.9', '--dangerously-skip-permissions', true)
    const { connection } = agy
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/repo')
    const { target } = threadTarget()
    const auto = await connection.setConfigOption(sessionId, 'mode', 'auto')
    target.apply({ patches: [{ op: 'session.update', changes: { config: auto } }], effects: [] })
    connection.register(sessionId, target)

    await expect(connection.setConfigOption(sessionId, 'mode', FULL)).rejects.toThrow(/agy exited/)
    const mode = target.context().thread.session.config.find((option) => option.id === 'mode')!
    expect(mode.value).toBe('auto')
    expect(mode.pending).toBeUndefined()
    connection.close()
  })

  it('does not block full access switch on a non-daemon command left open by a cancelled turn', async () => {
    const agy = flaggedAgy('1.5.9', '--dangerously-skip-permissions')
    const { connection, sent } = agy
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/repo')
    const { target } = threadTarget()
    const auto = await connection.setConfigOption(sessionId, 'mode', 'auto')
    target.apply({ patches: [{ op: 'session.update', changes: { config: auto } }], effects: [] })
    connection.register(sessionId, target)
    agy.setStopReason('cancelled')
    agy.send(async (client, id) => {
      // 普通非 IsDaemon 命令在回合被取消前仍为 in_progress。
      await client.notify(
        methods.client.session.update,
        update(id, {
          ...daemon('in_progress'),
          toolCallId: 'call-normal',
          rawInput: { CommandLine: 'sleep 30', WaitMsBeforeAsync: 5000, toolSummary: 'Sleep' },
        }),
      )
    })

    await connection.prompt(sessionId, text('run something'))
    sent.length = 0

    // 取消后的回合结束不应再被该普通命令当成常驻后台任务阻塞，直接进入 Full access。
    const switched = await connection.setConfigOption(sessionId, 'mode', FULL)
    expect(valueOf(switched, 'mode')).toBe(FULL)
    expect(switched.find((option) => option.id === 'mode')?.pending).toBeUndefined()
    expect(agy.methods()).toEqual(['resume'])
    connection.close()
  })

  it('keeps showing full access when agy reports its own mode', async () => {
    const agy = flaggedAgy('1.5.9', '--dangerously-skip-permissions')
    const { connection } = agy
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/repo')
    const { target } = threadTarget()
    const config = await connection.setConfigOption(sessionId, 'mode', FULL)
    target.apply({ patches: [{ op: 'session.update', changes: { config } }], effects: [] })
    connection.register(sessionId, target)
    // What agy says of its mode while its process runs with the flag changes nothing shown.
    agy.send(async (client, id) => {
      await client.notify(
        methods.client.session.update,
        update(id, { sessionUpdate: 'current_mode_update', currentModeId: 'plan' }),
      )
      await client.notify(
        methods.client.session.update,
        update(id, { sessionUpdate: 'config_option_update', configOptions: [agyModes('default')] }),
      )
    })
    await connection.prompt(sessionId, [{ type: 'text', text: 'go' }])
    const mode = target.context().thread.session.config.find((option) => option.id === 'mode')!
    expect(mode.value).toBe(FULL)
    expect(mode.choices!.at(-1)!.value).toBe(FULL)
    connection.close()
  })
})

describe("agy's system prompt", () => {
  const GUIDE = '<kettu-guide>\nYou are working in Kettu.\n</kettu-guide>'

  it('takes the guide and memory in its new session, not ahead of a prompt', async () => {
    const { connection, opened } = connect('1.5.9')
    await connection.initialize('1.0.0')
    expect(connection.systemPromptAppend).toBe(true)
    await connection.newSession('/repo', { systemPromptAppend: GUIDE })
    expect(opened).toEqual([
      { method: 'new', meta: { antigravity: { systemPrompt: { append: GUIDE } } } },
    ])
    connection.close()
  })

  it('sends nothing when the host has no text, and keeps the session as it is on load and resume', async () => {
    const { connection, opened } = connect('1.5.9')
    await connection.initialize('1.0.0')
    await connection.newSession('/repo')
    // agy stores it with the session, so the session's later opens pass it no more.
    await connection.loadSession('s-1', '/repo', { systemPromptAppend: GUIDE })
    await connection.resumeSession('s-1', '/repo', { systemPromptAppend: GUIDE })
    expect(opened).toEqual([
      { method: 'new', meta: undefined },
      { method: 'load', meta: undefined },
      { method: 'resume', meta: undefined },
    ])
    connection.close()
  })

  it('stays unused before 1.5.9 and where agy does not declare it', async () => {
    for (const [version, declared] of [
      ['1.5.8', true],
      ['1.5.9', false],
    ] as const) {
      const { connection, opened } = connect(version, undefined, [], declared)
      await connection.initialize('1.0.0')
      expect(connection.systemPromptAppend).toBe(false)
      await connection.newSession('/repo', { systemPromptAppend: GUIDE })
      expect(opened).toEqual([{ method: 'new', meta: undefined }])
      connection.close()
    }
  })
})

const WAITING = 'the running prompt is waiting for a permission or question answer'
const USAGE = { inputTokens: 10, outputTokens: 2, totalTokens: 12 }

/**
 * agy 1.5.15 as measured: a prompt sent while one runs ends that one with `end_turn` and is
 * answered itself, one sent while a card waits for the user is refused, and a cancel ends the
 * prompt that runs. A prompt runs until the test ends it, or a later prompt or a cancel does.
 */
function steeringAgy(version = '1.5.15') {
  const prompts: string[] = []
  const state = { asking: false }
  let running: ((reason: 'end_turn' | 'cancelled') => void) | null = null
  let client: AgentContext | null = null
  const app = agent({ name: 'agy-test' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
      agentInfo: { name: 'Antigravity ACP Server', version },
      authMethods: [],
    }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: 's-1' }))
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      if (state.asking) throw new RequestError(-32603, `${WAITING}; answer it first`)
      const [block] = ctx.params.prompt
      prompts.push(block?.type === 'text' ? block.text : '')
      client = ctx.client
      running?.('end_turn')
      const stopReason = await new Promise<'end_turn' | 'cancelled'>((resolve) => {
        running = resolve
      })
      return { stopReason, usage: USAGE }
    })
    .onNotification(methods.agent.session.cancel, () => {
      running?.('cancelled')
      running = null
    })
  const connection = AcpConnection.connect(inProcessTransport(app), {
    traffic: () => {},
    account: () => {},
    ignored: () => {},
    log: () => {},
    agentId: 'antigravity',
    name: 'Google Antigravity',
  })
  return {
    connection,
    prompts,
    state,
    say: (text: string) =>
      client!.notify(
        methods.client.session.update,
        update('s-1', {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        }),
      ),
    end: () => {
      running?.('end_turn')
      running = null
    },
  }
}

const text = (value: string) => [{ type: 'text' as const, text: value }]

describe("agy's steering", () => {
  it('takes a message into the running turn, which ends with the last prompt and both their tokens', async () => {
    const agy = steeringAgy()
    const { connection } = agy
    expect((await connection.initialize('1.0.0')).capabilities.steering).toBe(true)
    const { sessionId } = await connection.newSession('/repo')
    const thread = threadTarget()
    connection.register(sessionId, thread.target)
    let ended = false
    const turn = connection.prompt(sessionId, text('go')).finally(() => (ended = true))
    await vi.waitFor(() => expect(agy.prompts).toEqual(['go']))

    await expect(connection.steer(sessionId, text('and this'))).resolves.toBe('injected')
    expect(agy.prompts).toEqual(['go', 'and this'])
    await agy.say('Both done.')
    // agy answered the first prompt as it took the second; the turn is the second's too.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ended).toBe(false)
    agy.end()
    const result = await turn
    expect(result.stopReason).toBe('end_turn')
    expect(result.tokens).toMatchObject({ total: 24, output: 4 })
    const replies = thread.entries().filter((entry) => entry.kind === 'agent')
    expect(replies.map((entry) => entry.kind === 'agent' && entry.markdown)).toEqual(['Both done.'])
    connection.close()
  })

  it('leaves the message out with no turn running, or while a card waits for the user', async () => {
    const agy = steeringAgy()
    const { connection } = agy
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/repo')
    connection.register(sessionId, threadTarget().target)
    await expect(connection.steer(sessionId, text('early'))).resolves.toBe('promptRequired')
    expect(agy.prompts).toEqual([])

    const turn = connection.prompt(sessionId, text('go'))
    await vi.waitFor(() => expect(agy.prompts).toEqual(['go']))
    agy.state.asking = true
    await expect(connection.steer(sessionId, text('meanwhile'))).resolves.toBe('promptRequired')
    agy.state.asking = false
    agy.end()
    const result = await turn
    expect(result).toMatchObject({ stopReason: 'end_turn', tokens: { total: 12 } })
    expect(agy.prompts).toEqual(['go'])
    await expect(connection.steer(sessionId, text('late'))).resolves.toBe('promptRequired')
    connection.close()
  })

  it('cancels the turn in the prompt steered into it', async () => {
    const agy = steeringAgy()
    const { connection } = agy
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/repo')
    connection.register(sessionId, threadTarget().target)
    const turn = connection.prompt(sessionId, text('go'))
    await vi.waitFor(() => expect(agy.prompts).toEqual(['go']))
    await expect(connection.steer(sessionId, text('more'))).resolves.toBe('injected')
    await connection.cancel(sessionId)
    expect((await turn).stopReason).toBe('cancelled')
    connection.close()
  })

  it('is not offered before 1.5.15', async () => {
    const { connection } = steeringAgy('1.5.14')
    expect((await connection.initialize('1.0.0')).capabilities.steering).toBe(false)
    connection.close()
  })
})

const DAEMON = {
  CommandLine: 'python3 -m http.server 8765',
  IsDaemon: true,
  WaitMsBeforeAsync: 1000,
  toolSummary: 'Start HTTP server',
}

/** agy's `run_command` call of the server as 1.5.15 reports it, with `result` as its content. */
function daemon(status: 'in_progress' | 'completed' | 'failed', result?: string) {
  return {
    sessionUpdate: status === 'in_progress' ? 'tool_call' : 'tool_call_update',
    toolCallId: 'call-1',
    name: 'run_command',
    kind: 'execute',
    title: DAEMON.CommandLine,
    rawInput: DAEMON,
    status,
    ...(result === undefined
      ? {}
      : { content: [{ type: 'content', content: { type: 'text', text: result } }] }),
  }
}

/** A thread target that also keeps the effects applied to it. */
function recording() {
  const thread = threadTarget()
  const effects: MapperEffect[] = []
  const apply = thread.target.apply
  thread.target.apply = (output) => {
    effects.push(...output.effects)
    apply(output)
  }
  const last = <K extends MapperEffect['kind']>(kind: K) =>
    effects.findLast((effect): effect is Extract<MapperEffect, { kind: K }> => effect.kind === kind)
  const row = () => thread.entries().find((entry) => entry.id === 't:call-1')
  return { ...thread, effects, last, row }
}

describe("agy's commands that outlive their turn", () => {
  it("keep a server's call running past its turn on the board, until agy reports its end", async () => {
    let client!: AgentContext
    const { connection } = connect('1.5.15', async (agent, sessionId) => {
      client = agent
      await agent.notify(methods.client.session.update, update(sessionId, daemon('in_progress')))
      // A command that ends in its turn is no task.
      const echo = {
        ...daemon('in_progress'),
        toolCallId: 'call-2',
        rawInput: { CommandLine: 'echo hi' },
      }
      await agent.notify(methods.client.session.update, update(sessionId, echo))
      await agent.notify(
        methods.client.session.update,
        update(sessionId, { ...echo, sessionUpdate: 'tool_call_update', status: 'completed' }),
      )
    })
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/repo')
    const thread = recording()
    connection.register(sessionId, thread.target)
    await connection.prompt(sessionId, text('serve it'))

    expect(thread.row()).toMatchObject({ status: 'in_progress' })
    expect(thread.last('tasks')?.tasks).toEqual([
      {
        id: 'call-1',
        kind: 'shell',
        title: 'Start HTTP server',
        command: 'python3 -m http.server 8765',
        status: 'running',
        startedAt: expect.any(Number),
        endedAt: null,
        summary: null,
        entryId: 't:call-1',
      },
    ])
    expect(thread.last('backgroundRunning')).toMatchObject({ running: true, listed: false })

    // The server stops between turns, and agy says so on the call that started it.
    const output = 'Serving HTTP on :: port 8765 (http://[::]:8765/) ...\r\n'
    await client.notify(
      methods.client.session.update,
      update(
        sessionId,
        daemon(
          'failed',
          `Command was terminated by signal or canceled.\n\nCommand output:\n${output}`,
        ),
      ),
    )
    await vi.waitFor(() => expect(thread.row()).toMatchObject({ status: 'failed' }))
    expect(thread.row()).toMatchObject({
      content: [
        {
          type: 'markdown',
          markdown: '```\nServing HTTP on :: port 8765 (http://[::]:8765/) ...\n```',
        },
      ],
    })
    expect(thread.last('tasks')?.tasks).toMatchObject([
      {
        id: 'call-1',
        status: 'failed',
        endedAt: expect.any(Number),
        summary: 'Command was terminated by signal or canceled.',
      },
    ])
    expect(thread.last('backgroundRunning')).toMatchObject({ running: false })
    connection.close()
  })

  it('end in a later turn, on the call that started them', async () => {
    let turns = 0
    const { connection } = connect('1.5.15', async (agent, sessionId) => {
      const value =
        ++turns === 1
          ? daemon('in_progress')
          : daemon('completed', 'Command exited with code 0.\n\nCommand output:\nfinished-bg\r\n')
      await agent.notify(methods.client.session.update, update(sessionId, value))
    })
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/repo')
    const thread = recording()
    connection.register(sessionId, thread.target)
    await connection.prompt(sessionId, text('start it'))
    expect(thread.last('backgroundRunning')).toMatchObject({ running: true })

    await connection.prompt(sessionId, text('anything else?'))
    expect(thread.row()).toMatchObject({
      status: 'completed',
      content: [{ type: 'markdown', markdown: '```\nfinished-bg\n```' }],
    })
    expect(thread.last('tasks')?.tasks).toMatchObject([
      { id: 'call-1', status: 'completed', summary: 'Command exited with code 0.' },
    ])
    expect(thread.last('backgroundRunning')).toMatchObject({ running: false })
    connection.close()
  })

  it('hold a switch of full access until they end, since the restart would stop them', async () => {
    const agy = flaggedAgy('1.5.9', '--dangerously-skip-permissions')
    const { connection, sent } = agy
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/repo')
    const { target } = threadTarget()
    let config = await connection.setConfigOption(sessionId, 'mode', 'default')
    target.apply({ patches: [{ op: 'session.update', changes: { config } }], effects: [] })
    connection.register(sessionId, target)
    let client!: AgentContext
    agy.send(async (agent, id) => {
      client = agent
      await agent.notify(methods.client.session.update, update(id, daemon('in_progress')))
    })
    await connection.prompt(sessionId, text('serve it'))
    sent.length = 0

    config = await connection.setConfigOption(sessionId, 'mode', FULL)
    expect(valueOf(config, 'mode')).toBe('default')
    expect(config.find((option) => option.id === 'mode')?.pending).toEqual({
      value: FULL,
      wait: 'background',
    })
    expect(agy.methods()).toEqual([])
    await client.notify(methods.client.session.update, update(sessionId, daemon('failed')))
    await vi.waitFor(() =>
      expect(valueOf(target.context().thread.session.config, 'mode')).toBe(FULL),
    )
    expect(
      target.context().thread.session.config.find((option) => option.id === 'mode')?.pending,
    ).toBeUndefined()
    expect(agy.methods()).toEqual(['resume'])
    connection.close()
  })

  it('updates pending reason from turn to background when a daemon outlives the turn', async () => {
    const agy = flaggedAgy('1.5.9', '--dangerously-skip-permissions')
    const { connection } = agy
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/repo')
    const { target } = threadTarget()
    let config = await connection.setConfigOption(sessionId, 'mode', 'auto')
    target.apply({ patches: [{ op: 'session.update', changes: { config } }], effects: [] })
    connection.register(sessionId, target)
    let client!: AgentContext
    agy.send(async (agent, id) => {
      client = agent
      await agent.notify(methods.client.session.update, update(id, daemon('in_progress')))
    })

    const release = agy.hold()
    const turn = connection.prompt(sessionId, text('serve it'))
    await vi.waitFor(() => expect(client).toBeDefined())

    config = await connection.setConfigOption(sessionId, 'mode', FULL)
    expect(config.find((option) => option.id === 'mode')?.pending).toEqual({
      value: FULL,
      wait: 'turn',
    })

    release()
    await turn
    // 回合已结束但常驻后台命令仍在跑，等待原因自动从 turn 更新为 background。
    expect(
      target.context().thread.session.config.find((option) => option.id === 'mode')?.pending,
    ).toEqual({ value: FULL, wait: 'background' })

    await client.notify(methods.client.session.update, update(sessionId, daemon('failed')))
    await vi.waitFor(() =>
      expect(valueOf(target.context().thread.session.config, 'mode')).toBe(FULL),
    )
    connection.close()
  })
})

describe("agy's metrics and context estimates", () => {
  it('在每次模型调用后写入 lastRequest，并为 Antigravity 暴露 readContextEstimates', async () => {
    const app = agent({ name: 'agy-test' })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
        agentInfo: { name: 'Antigravity ACP Server', version: '1.5.16' },
        authMethods: [],
      }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: 's-metrics' }))
      .onRequest(methods.agent.session.prompt, async (ctx) => {
        await ctx.client.notify(
          methods.client.session.update,
          update(ctx.params.sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Done.' },
          }),
        )
        await ctx.client.notify(
          methods.client.session.update,
          update(ctx.params.sessionId, {
            sessionUpdate: 'usage_update',
            used: 44_636,
            size: 1_048_576,
          }),
        )
        return { stopReason: 'end_turn' as const }
      })

    const receivedServers: string[] = []
    const estimator = {
      read: async (cwd: string, servers: readonly { name: string }[] = []) => {
        receivedServers.push(`${cwd}:${servers.map((s) => s.name).join(',')}`)
        return {
          skills: [{ name: 'frontend-design', tokens: 64 }],
          mcpServers: servers.map((s) => ({ name: s.name, tokens: 120 })),
        }
      },
    } as unknown as AgyContextEstimator

    const connection = AcpConnection.connect(inProcessTransport(app), {
      traffic: () => {},
      account: () => {},
      ignored: () => {},
      log: () => {},
      agentId: 'antigravity',
      name: 'Google Antigravity',
      agyStepReader: async () => ({
        stepIndex: 1,
        model: 'gemini-4-neon-xhigh',
        createdAt: 1_000,
        input: 5_683,
        cacheRead: 38_953,
        cacheWrite: null,
        output: 679,
      }),
      agyContext: estimator,
    })

    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/repo', { mcpServers: MCP })
    const thread = threadTarget()
    connection.register(sessionId, thread.target)
    await connection.prompt(sessionId, text('go'))

    await vi.waitFor(() =>
      expect(thread.target.context().thread.session.lastRequest).toMatchObject({
        input: 5_683,
        cacheRead: 38_953,
        output: 679,
      }),
    )

    expect(connection.readContextEstimates).toBeDefined()
    const estimates = await connection.readContextEstimates!(sessionId, '/repo')
    expect(estimates).toEqual({
      skills: [{ name: 'frontend-design', tokens: 64 }],
      mcpServers: [{ name: 'kettu', tokens: 120 }],
    })
    expect(receivedServers).toEqual(['/repo:kettu'])
    connection.close()

    // 非 Antigravity 的 ACP 连接不挂载 readContextEstimates。
    const other = AcpConnection.connect(inProcessTransport(app), {
      traffic: () => {},
      account: () => {},
      ignored: () => {},
      log: () => {},
      agentId: 'gemini',
      name: 'Gemini CLI',
    })
    expect(other.readContextEstimates).toBeUndefined()
    other.close()
  })
})
