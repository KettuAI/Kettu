import { describe, expect, it, vi } from 'vitest'
import type { AgentOptions, AgentStatus, KettuRole, RunningWork } from '@shared/agent-host'
import type { ConfigOption } from '@shared/thread'
import type { Caller } from './artifacts/tools'
import {
  SessionTools,
  type SessionToolsDeps,
  type ToolDelivery,
  type ToolMode,
  type ToolSession,
} from './session-tools'
import type { ModeRank } from './started-mode'

const caller: Caller = { sessionId: 'starter', project: '/repo' }

function session(id: string, startedBy: string | null): ToolSession {
  return {
    id,
    title: id,
    agentId: 'codex',
    status: 'running',
    updatedAt: 0,
    createdAt: 0,
    parentId: startedBy,
    startedBy,
    archived: false,
    projectPath: '/repo',
  }
}

function tools(delivery: ToolDelivery = { delivered: 'queued' }) {
  const sessions = [session('starter', null), session('started', 'starter'), session('other', null)]
  const send = vi.fn<SessionToolsDeps['send']>(async () => delivery)
  const deps = {
    info: (id: string) => sessions.find((item) => item.id === id) ?? null,
    name: () => 'Starter',
    send,
  } as unknown as SessionToolsDeps
  return { tools: new SessionTools(deps), send }
}

describe('send_message now', () => {
  it('queues by default', async () => {
    const { tools: t, send } = tools()
    const out = await t.call(caller, 'send_message', { id: 'started', text: 'hi' })
    expect(out.isError).toBeUndefined()
    expect(send).toHaveBeenCalledWith('started', 'hi', expect.anything(), false)
  })

  it('passes now to the host and reports how it went in', async () => {
    const { tools: t, send } = tools({ delivered: 'steered' })
    const out = await t.call(caller, 'send_message', { id: 'started', text: 'stop', now: true })
    expect(send).toHaveBeenCalledWith('started', 'stop', expect.anything(), true)
    expect(out.structuredContent).toEqual({ id: 'started', delivered: 'steered' })
  })

  it('says why a message asked to go now was queued', async () => {
    const { tools: t } = tools({ delivered: 'queued', reason: 'its turn was ending' })
    const out = await t.call(caller, 'send_message', { id: 'started', text: 'x', now: true })
    expect(out.structuredContent).toEqual({
      id: 'started',
      delivered: 'queued',
      reason: 'its turn was ending',
    })
  })

  it('rejects a now that is not a boolean', async () => {
    const { tools: t, send } = tools()
    const out = await t.call(caller, 'send_message', { id: 'started', text: 'x', now: 'yes' })
    expect(out.isError).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  it('never sends now to a session the caller did not start', async () => {
    const { tools: t, send } = tools()
    const out = await t.call(caller, 'send_message', { id: 'other', text: 'x', now: true })
    expect(out.isError).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })
})

function work(sessionId: string, running: Partial<RunningWork> = {}): RunningWork {
  return {
    sessionId,
    agentId: 'claude-code',
    title: sessionId,
    turn: false,
    waiting: 0,
    commands: [],
    tasks: [],
    subagents: [],
    scheduled: 0,
    unnamed: false,
    ...running,
  }
}

function archiving(running: Record<string, RunningWork[]>, startedStatus = 'ready') {
  const sessions = [
    { ...session('starter', null), status: 'running' as const },
    { ...session('started', 'starter'), status: startedStatus as ToolSession['status'] },
  ]
  const archiveAfterTurn = vi.fn<SessionToolsDeps['archiveAfterTurn']>()
  const archiveNow = vi.fn<SessionToolsDeps['archiveNow']>(async () => {})
  const deps = {
    info: (id: string) => sessions.find((item) => item.id === id) ?? null,
    agentName: () => 'Claude Code',
    work: (id: string) => running[id] ?? [],
    archiveAfterTurn,
    archiveNow,
  } as unknown as SessionToolsDeps
  return { tools: new SessionTools(deps), archiveAfterTurn, archiveNow }
}

function text(out: Awaited<ReturnType<SessionTools['call']>>): string {
  return out.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

describe('archive_session', () => {
  it('archives the caller once its turn ends when only the turn runs', async () => {
    const { tools: t, archiveAfterTurn } = archiving({
      starter: [work('starter', { turn: true, waiting: 1 })],
    })
    const out = await t.call(caller, 'archive_session', {})
    expect(out.isError).toBeUndefined()
    expect(archiveAfterTurn).toHaveBeenCalledWith('starter', 'Claude Code')
  })

  it('refuses to archive the caller while its background work runs, and names it', async () => {
    const { tools: t, archiveAfterTurn } = archiving({
      starter: [
        work('starter', {
          turn: true,
          commands: ['sleep 300'],
          subagents: ['Explore the repo'],
          scheduled: 2,
        }),
      ],
    })
    const out = await t.call(caller, 'archive_session', {})
    expect(out.isError).toBe(true)
    expect(text(out)).toContain('background command "sleep 300"')
    expect(text(out)).toContain('subagent "Explore the repo"')
    expect(text(out)).toContain('2 scheduled jobs')
    expect(text(out)).not.toContain('turn')
    expect(archiveAfterTurn).not.toHaveBeenCalled()
  })

  it('refuses to archive the caller while a sub-session of it works', async () => {
    const { tools: t, archiveAfterTurn } = archiving({
      starter: [work('starter', { turn: true }), work('child', { title: 'Child', turn: true })],
    })
    const out = await t.call(caller, 'archive_session', {})
    expect(out.isError).toBe(true)
    expect(text(out)).toContain('"Child"')
    expect(archiveAfterTurn).not.toHaveBeenCalled()
  })

  it('refuses to archive a started session that runs background work between turns', async () => {
    const { tools: t, archiveNow } = archiving({
      started: [work('started', { tasks: ['Watch the build'] })],
    })
    const out = await t.call(caller, 'archive_session', { id: 'started' })
    expect(out.isError).toBe(true)
    expect(text(out)).toContain('background task "Watch the build"')
    expect(archiveNow).not.toHaveBeenCalled()
  })

  it('refuses to archive a started session while its turn runs, and says so', async () => {
    const { tools: t, archiveNow } = archiving(
      { started: [work('started', { turn: true })] },
      'running',
    )
    const out = await t.call(caller, 'archive_session', { id: 'started' })
    expect(out.isError).toBe(true)
    expect(text(out)).toContain('its turn')
    expect(archiveNow).not.toHaveBeenCalled()
  })

  it('archives a started session at once when nothing runs', async () => {
    const { tools: t, archiveNow } = archiving({})
    const out = await t.call(caller, 'archive_session', { id: 'started' })
    expect(out.isError).toBeUndefined()
    expect(archiveNow).toHaveBeenCalledWith('started', 'Claude Code')
  })
})

function select(
  id: string,
  category: ConfigOption['category'],
  value: string,
  values: string[],
): ConfigOption {
  return {
    id,
    name: id,
    category,
    type: 'select',
    value,
    choices: values.map((v) => ({ value: v, name: v.toUpperCase() })),
  }
}

const CODEX_OPTIONS: AgentOptions = {
  agentId: 'codex',
  config: [
    select('model', 'model', 'gpt-big', ['gpt-big', 'gpt-mini']),
    select('effort', 'thought_level', 'medium', ['low', 'medium', 'high', 'xhigh']),
  ],
  levels: {
    'gpt-big': select('effort', 'thought_level', 'medium', ['low', 'medium', 'high', 'xhigh']),
    'gpt-mini': select('effort', 'thought_level', 'medium', ['low', 'medium']),
  },
  remembered: {},
  observedAt: 0,
}

function starting(
  opts: {
    cached?: AgentOptions | null
    read?: AgentOptions | null
    carried?: Record<string, string | boolean>
    held?: boolean
    agent?: { id: string; name: string }
    startMode?: string
    starterRank?: ModeRank | null
    mode?: ToolMode
    roles?: KettuRole[]
    others?: { id: string; name: string }[]
  } = {},
) {
  const sessions = [
    { ...session('starter', null), status: 'running' as const },
    { ...session('started', 'starter'), status: 'running' as const },
  ]
  let cache = opts.cached === undefined ? CODEX_OPTIONS : opts.cached
  const start = vi.fn<SessionToolsDeps['start']>(async () => 'started')
  const readOptions = vi.fn<SessionToolsDeps['readOptions']>(async () => {
    if (opts.read !== undefined) cache = opts.read
  })
  const status = {
    id: opts.agent?.id ?? 'codex',
    name: opts.agent?.name ?? 'Codex',
    harnessName: opts.agent?.name ?? 'Codex',
    state: 'ready',
    signIn: 'signed-in',
  } as unknown as AgentStatus
  const others = (opts.others ?? []).map(
    (other) =>
      ({
        ...status,
        id: other.id,
        name: other.name,
        harnessName: other.name,
      }) as unknown as AgentStatus,
  )
  const deps = {
    info: (id: string) => sessions.find((item) => item.id === id) ?? null,
    started: () => [],
    agents: () => [status, ...others],
    roles: async () => opts.roles ?? [],
    role: async (ref: string) => (opts.roles ?? []).find((role) => role.ref === ref) ?? null,
    startMode: () => opts.startMode,
    starterRank: () => (opts.starterRank === undefined ? 3 : opts.starterRank),
    carried: () => ({ ...(opts.carried ?? {}) }),
    agentOptions: () => cache,
    readOptions,
    start,
    mode: async () => opts.mode ?? null,
    choices: async () => ({
      model: { id: 'gpt-mini', name: 'GPT-MINI' },
      effort: { id: 'low', name: 'LOW' },
    }),
    held: () => opts.held === true,
  } as unknown as SessionToolsDeps
  return { tools: new SessionTools(deps), start, readOptions }
}

describe('start_session model and effort', () => {
  it('starts with the carried values when neither is named', async () => {
    const { tools: t, start, readOptions } = starting({ carried: { model: 'gpt-big' } })
    const out = await t.call(caller, 'start_session', { prompt: 'Review it' })
    expect(out.isError).toBeUndefined()
    expect(start.mock.calls[0]![1].options).toEqual({ model: 'gpt-big' })
    expect(readOptions).not.toHaveBeenCalled()
  })

  it('sets the model and effort named over the carried ones', async () => {
    const { tools: t, start } = starting({ carried: { model: 'gpt-big', effort: 'xhigh' } })
    const out = await t.call(caller, 'start_session', {
      prompt: 'Review it',
      model: 'gpt-mini',
      effort: 'low',
    })
    expect(out.isError).toBeUndefined()
    expect(start.mock.calls[0]![1].options).toEqual({ model: 'gpt-mini', effort: 'low' })
    expect(out.structuredContent).toMatchObject({
      model: { id: 'gpt-mini' },
      effort: { id: 'low' },
    })
  })

  it('refuses a model the agent does not offer, naming the ones it does', async () => {
    const { tools: t, start } = starting()
    const out = await t.call(caller, 'start_session', { prompt: 'x', model: 'gpt-huge' })
    expect(out.isError).toBe(true)
    expect(text(out)).toContain('gpt-big, gpt-mini')
    expect(start).not.toHaveBeenCalled()
  })

  it("refuses an effort the named model does not offer, though the agent's other model does", async () => {
    const { tools: t, start } = starting()
    const out = await t.call(caller, 'start_session', {
      prompt: 'x',
      model: 'gpt-mini',
      effort: 'xhigh',
    })
    expect(out.isError).toBe(true)
    expect(text(out)).toContain('low, medium')
    expect(start).not.toHaveBeenCalled()
  })

  it('checks an effort alone against the carried model', async () => {
    const { tools: t, start } = starting({ carried: { model: 'gpt-mini' } })
    const out = await t.call(caller, 'start_session', { prompt: 'x', effort: 'high' })
    expect(out.isError).toBe(true)
    expect(start).not.toHaveBeenCalled()
  })

  it('drops a carried effort the named model lacks, so its first message is not held', async () => {
    const { tools: t, start } = starting({ carried: { model: 'gpt-big', effort: 'xhigh' } })
    await t.call(caller, 'start_session', { prompt: 'x', model: 'gpt-mini' })
    expect(start.mock.calls[0]![1].options).toEqual({ model: 'gpt-mini' })
  })

  it('keeps a carried effort the named model offers', async () => {
    const { tools: t, start } = starting({ carried: { model: 'gpt-big', effort: 'low' } })
    await t.call(caller, 'start_session', { prompt: 'x', model: 'gpt-mini' })
    expect(start.mock.calls[0]![1].options).toEqual({ model: 'gpt-mini', effort: 'low' })
  })

  it("reads an agent's options before checking a pick when none are cached", async () => {
    const { tools: t, start, readOptions } = starting({ cached: null, read: CODEX_OPTIONS })
    const out = await t.call(caller, 'start_session', { prompt: 'x', model: 'gpt-mini' })
    expect(readOptions).toHaveBeenCalledWith('codex')
    expect(out.isError).toBeUndefined()
    expect(start).toHaveBeenCalled()
  })

  it('refuses a pick when the options still cannot be read', async () => {
    const { tools: t, start } = starting({ cached: null, read: null })
    const out = await t.call(caller, 'start_session', { prompt: 'x', model: 'gpt-mini' })
    expect(out.isError).toBe(true)
    expect(start).not.toHaveBeenCalled()
  })

  it('says when the first message waits for the user', async () => {
    const { tools: t } = starting({ held: true })
    const out = await t.call(caller, 'start_session', { prompt: 'x' })
    expect(out.structuredContent).toMatchObject({ held: true })
    expect(text(out)).toContain('waits for the user')
  })

  it('rejects a model that is not text', async () => {
    const { tools: t, start } = starting()
    const out = await t.call(caller, 'start_session', { prompt: 'x', model: 5 })
    expect(out.isError).toBe(true)
    expect(start).not.toHaveBeenCalled()
  })
})

describe('start_session mode', () => {
  it("names the caller's own mode when it lowered the mode asked for", async () => {
    const { tools: t } = starting({
      starterRank: 1,
      mode: { id: 'read-only', name: 'Read-only' },
    })
    const out = await t.call(caller, 'start_session', { prompt: 'x', mode: 'agent' })
    expect(out.structuredContent).toMatchObject({ mode_lowered: true })
    expect(text(out)).toContain('narrower than asked: your own mode allows no wider.')
  })

  it("names the agent's mode for new sessions when the user set it", async () => {
    const { tools: t } = starting({
      startMode: 'read-only',
      mode: { id: 'read-only', name: 'Read-only' },
    })
    const out = await t.call(caller, 'start_session', { prompt: 'x', mode: 'agent' })
    expect(text(out)).toContain(
      "narrower than asked: the user set Codex's new sessions to start in Read-only",
    )
    expect(text(out)).not.toContain('your own mode')
  })

  it("names an agent's own start when no mode for its new sessions is set", async () => {
    const { tools: t } = starting({
      agent: { id: 'antigravity', name: 'Google Antigravity' },
      mode: { id: 'default', name: 'Default' },
    })
    const out = await t.call(caller, 'start_session', {
      prompt: 'x',
      agent: 'antigravity',
      mode: 'auto',
    })
    expect(text(out)).toContain(
      'narrower than asked: Google Antigravity starts its sessions in Default, and the user ' +
        'set no mode for its new sessions in Settings > Agents.',
    )
  })
})

describe('list_agents models', () => {
  it("lists each model's efforts", async () => {
    const { tools: t } = starting()
    const out = await t.call(caller, 'list_agents', {})
    const agents = (out.structuredContent as { agents: unknown[] }).agents
    expect(agents[0]).toMatchObject({
      models: [
        { id: 'gpt-big', efforts: ['low', 'medium', 'high', 'xhigh'] },
        { id: 'gpt-mini', efforts: ['low', 'medium'] },
      ],
      efforts: null,
    })
  })

  it('reads an agent asked about by name when Kettu has none of its options', async () => {
    const { tools: t, readOptions } = starting({ cached: null, read: CODEX_OPTIONS })
    const out = await t.call(caller, 'list_agents', { agent: 'codex' })
    expect(readOptions).toHaveBeenCalledWith('codex')
    const agents = (out.structuredContent as { agents: { models: unknown[] }[] }).agents
    expect(agents[0]!.models).toHaveLength(2)
  })

  it('refuses an agent that cannot be started here', async () => {
    const { tools: t } = starting()
    const out = await t.call(caller, 'list_agents', { agent: 'gemini' })
    expect(out.isError).toBe(true)
  })
})

function role(ref: string, suggests: KettuRole['suggests'] = {}): KettuRole {
  return { ref, title: `Role ${ref}`, description: '', suggests, origin: { kind: 'user' } }
}

describe('start_session role', () => {
  it('hands the role to the new session and applies what it suggests', async () => {
    const { tools: t, start } = starting({
      roles: [role('reviewer', { model: 'GPT-MINI', effort: 'low' })],
    })
    const out = await t.call(caller, 'start_session', { prompt: 'x', role: 'reviewer' })
    expect(out.isError).toBeUndefined()
    expect(start.mock.calls[0]![1]).toMatchObject({
      role: 'reviewer',
      options: { model: 'gpt-mini', effort: 'low' },
    })
    expect(text(out)).toContain('The role Role reviewer set the model GPT-MINI and the effort low.')
    expect(out.structuredContent).toMatchObject({ role: 'Role reviewer' })
  })

  it('starts on the agent the role suggests when the caller names none', async () => {
    const { tools: t, start } = starting({
      others: [{ id: 'claude-code', name: 'Claude Code' }],
      roles: [role('reviewer', { agent: 'claude-code' })],
    })
    await t.call(caller, 'start_session', { prompt: 'x', role: 'reviewer' })
    expect(start.mock.calls[0]![1]).toMatchObject({ agentId: 'claude-code', role: 'reviewer' })
  })

  it("keeps the caller's own agent, model and effort over the role's", async () => {
    const { tools: t, start } = starting({
      others: [{ id: 'claude-code', name: 'Claude Code' }],
      roles: [role('reviewer', { agent: 'claude-code', model: 'gpt-mini', effort: 'low' })],
    })
    const out = await t.call(caller, 'start_session', {
      prompt: 'x',
      role: 'reviewer',
      agent: 'codex',
      model: 'gpt-big',
    })
    expect(out.isError).toBeUndefined()
    const params = start.mock.calls[0]![1]
    expect(params.agentId).toBe('codex')
    expect(params.options).toEqual({ model: 'gpt-big' })
  })

  it('leaves out what the agent cannot take and says so', async () => {
    const { tools: t, start } = starting({
      roles: [role('reviewer', { agent: 'missing-agent', model: 'gpt-huge' })],
    })
    const out = await t.call(caller, 'start_session', { prompt: 'x', role: 'reviewer' })
    expect(out.isError).toBeUndefined()
    const params = start.mock.calls[0]![1]
    expect(params.agentId).toBeUndefined()
    expect(params.options).toEqual({})
    expect(text(out)).toContain('suggested the agent missing-agent')
  })

  it('refuses a role that does not exist', async () => {
    const { tools: t, start } = starting()
    const out = await t.call(caller, 'start_session', { prompt: 'x', role: 'nobody' })
    expect(out.isError).toBe(true)
    expect(text(out)).toContain('No role nobody')
    expect(start).not.toHaveBeenCalled()
  })

  it('lists the roles beside the agents', async () => {
    const { tools: t } = starting({ roles: [role('reviewer', { agent: 'codex' })] })
    const out = await t.call(caller, 'list_agents', {})
    expect(out.structuredContent).toMatchObject({
      roles: [{ id: 'reviewer', name: 'Role reviewer', agent: 'codex' }],
    })
  })
})
