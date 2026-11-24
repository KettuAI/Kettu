import { describe, expect, it, vi } from 'vitest'
import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import type { RenderedTurn } from '../carried-context'
import { DAILY_LIMIT, WORKING_LIMIT, type ToolSession } from '../session-tools'
import { sessionCalls, type PluginSessionsDeps } from './sessions-api'

const CONTEXT = { pluginId: 'p0123456789ab', permissions: [] }

function summary(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    title: `Title of ${id}`,
    projectPath: '/repo',
    agentId: 'claude-code',
    status: 'ready',
    phase: null,
    parentId: null,
    origin: 'user',
    createdAt: 1,
    updatedAt: 2,
    archivedAt: null,
    ...extra,
  } as SessionSummary
}

function started(id: string, extra: Partial<ToolSession> = {}): ToolSession {
  return {
    id,
    title: id,
    agentId: 'claude-code',
    status: 'ready',
    updatedAt: 0,
    createdAt: Date.now(),
    parentId: null,
    startedBy: `plugin:${CONTEXT.pluginId}`,
    archived: false,
    projectPath: '/repo',
    ...extra,
  }
}

const AGENT = {
  id: 'claude-code',
  name: 'Claude Code',
  harnessId: 'claude-code',
  state: 'ready',
  hidden: false,
} as unknown as AgentStatus

function api(overrides: Partial<PluginSessionsDeps> = {}) {
  const deps = {
    list: vi.fn(() => [
      summary('a'),
      summary('archived', { archivedAt: 5 }),
      summary('scheduled', { origin: 'routine' } as Partial<SessionSummary>),
      summary('elsewhere', { projectPath: '/other' }),
    ]),
    turns: vi.fn(async (): Promise<RenderedTurn[]> =>
      [1, 2, 3].map((number) => ({
        number,
        agentId: 'claude-code' as AgentId,
        user: `question ${number}`,
        assistant: `answer ${number}`,
      })),
    ),
    info: vi.fn((id: string) => (id === 'a' ? started('a') : null)),
    summary: vi.fn((id: string) => summary(id)),
    startedBy: vi.fn((): ToolSession[] => []),
    agents: vi.fn(() => [AGENT]),
    defaultAgent: vi.fn((): AgentId | null => 'claude-code'),
    project: vi.fn((path: string) => {
      if (path !== '/repo') throw new Error(`${path} is not a project of the user's`)
      return path
    }),
    start: vi.fn(async () => 'new'),
    send: vi.fn(async () => ({ delivered: 'queued' as const })),
    now: () => Date.now(),
    ...overrides,
  }
  const calls = sessionCalls(deps as unknown as PluginSessionsDeps)
  const run = async (name: string, ...args: unknown[]) => calls[name]!.run(CONTEXT, args)
  return { deps, calls, run }
}

describe('sessions.list', () => {
  it('lists what the sidebar lists, and nothing that was said in it', async () => {
    const { run } = api()
    const { sessions } = (await run('sessions.list')) as { sessions: Record<string, unknown>[] }
    expect(sessions.map((item) => item.id)).toEqual(['a', 'elsewhere'])
    expect(Object.keys(sessions[0]!).sort()).toEqual([
      'agent',
      'archived',
      'createdAt',
      'doing',
      'id',
      'parentId',
      'project',
      'state',
      'title',
      'updatedAt',
    ])
  })

  it('takes a project, archived ones and a limit, and nothing else', async () => {
    const { run } = api()
    const ids = async (options: unknown) =>
      ((await run('sessions.list', options)) as { sessions: { id: string }[] }).sessions.map(
        (item) => item.id,
      )
    expect(await ids({ project: '/other' })).toEqual(['elsewhere'])
    expect(await ids({ includeArchived: true })).toEqual(['a', 'archived', 'elsewhere'])
    expect(await ids({ limit: 1 })).toEqual(['a'])
    for (const bad of [{ limit: 0 }, { limit: 'x' }, { includeArchived: 1 }, { text: 'q' }, []]) {
      await expect(run('sessions.list', bad)).rejects.toThrow()
    }
  })
})

describe('sessions.read', () => {
  it('reads the latest turns first and says where the earlier ones are', async () => {
    const { run } = api()
    expect(await run('sessions.read', { id: 'a', limit: 2 })).toEqual({
      total: 3,
      turns: [
        { number: 2, agent: 'claude-code', user: 'question 2', assistant: 'answer 2' },
        { number: 3, agent: 'claude-code', user: 'question 3', assistant: 'answer 3' },
      ],
      moreBefore: 2,
    })
  })

  it('refuses a session Kettu does not list', async () => {
    const { run, deps } = api()
    await expect(run('sessions.read', { id: 'ghost' })).rejects.toThrow('No session ghost')
    expect(deps.turns).not.toHaveBeenCalled()
  })
})

describe('sessions.start', () => {
  it('starts through the host as the plugin, in a project the user has', async () => {
    const { run, deps } = api()
    const result = await run('sessions.start', {
      prompt: 'Review it',
      project: '/repo',
      mode: 'auto',
      title: 'Review',
    })
    expect(deps.start).toHaveBeenCalledWith(CONTEXT.pluginId, {
      prompt: 'Review it',
      projectPath: '/repo',
      agentId: 'claude-code',
      mode: 'auto',
      title: 'Review',
    })
    expect(result).toMatchObject({ id: 'new' })
  })

  it('refuses a mode wider than Auto, a plan and a mode the agent lacks', async () => {
    const { run, deps } = api()
    for (const mode of ['bypassPermissions', 'plan', 'agent-full-access', '', 5, 'nonsense']) {
      await expect(run('sessions.start', { prompt: 'x', mode }), String(mode)).rejects.toThrow()
    }
    expect(deps.start).not.toHaveBeenCalled()
  })

  it('refuses a folder that is not a project of the user, before starting anything', async () => {
    const { run, deps } = api()
    await expect(run('sessions.start', { prompt: 'x', project: '/etc' })).rejects.toThrow(
      "not a project of the user's",
    )
    expect(deps.start).not.toHaveBeenCalled()
  })

  it('refuses an agent that cannot start, and a start with no agent to use', async () => {
    const { run, deps } = api({
      agents: vi.fn(() => [{ ...AGENT, state: 'not-installed' } as unknown as AgentStatus]),
    })
    await expect(run('sessions.start', { prompt: 'x' })).rejects.toThrow('not installed')
    await expect(run('sessions.start', { prompt: 'x', agent: 'nope' })).rejects.toThrow()
    expect(deps.start).not.toHaveBeenCalled()
    const none = api({ defaultAgent: vi.fn(() => null) })
    await expect(none.run('sessions.start', { prompt: 'x' })).rejects.toThrow('default agent')
  })

  it('stops at the limits an agent has, counted for the plugin alone', async () => {
    const busy = api({
      startedBy: vi.fn(() =>
        Array.from({ length: WORKING_LIMIT }, (_, index) =>
          started(`w${index}`, { status: 'running' }),
        ),
      ),
    })
    await expect(busy.run('sessions.start', { prompt: 'x' })).rejects.toThrow('sessions working')
    const tired = api({
      startedBy: vi.fn(() =>
        Array.from({ length: DAILY_LIMIT }, (_, index) => started(`d${index}`)),
      ),
    })
    await expect(tired.run('sessions.start', { prompt: 'x' })).rejects.toThrow('in a local day')
    for (const { deps } of [busy, tired]) {
      expect(deps.startedBy).toHaveBeenCalledWith(`plugin:${CONTEXT.pluginId}`)
      expect(deps.start).not.toHaveBeenCalled()
    }
  })

  it('takes no option it does not know and no blank prompt', async () => {
    const { run, deps } = api()
    for (const bad of [
      {},
      { prompt: ' ' },
      { prompt: 'x', model: 'm' },
      { prompt: 'x', title: '' },
    ]) {
      await expect(run('sessions.start', bad)).rejects.toThrow()
    }
    expect(deps.start).not.toHaveBeenCalled()
  })
})

describe('sessions.send', () => {
  it('sends as the plugin, which the host holds to the sessions it started', async () => {
    const { run, deps } = api()
    expect(await run('sessions.send', { id: 'a', text: 'go on' })).toEqual({
      id: 'a',
      delivered: 'queued',
    })
    expect(deps.send).toHaveBeenCalledWith(CONTEXT.pluginId, 'a', 'go on')
    await expect(run('sessions.send', { id: 'a' })).rejects.toThrow()
    await expect(run('sessions.send', { id: 'a', text: 'x', now: true })).rejects.toThrow()
  })
})
