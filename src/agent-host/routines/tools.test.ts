import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { AgentOptions, AgentStatus } from '@shared/agent-host'
import type { AgentId } from '@shared/agents'
import type {
  RoutineChanges,
  RoutineDraft,
  RoutineRun,
  RoutineView,
  Schedule,
} from '@shared/routines'
import type { RoutineChangeOutcome } from '@shared/thread'
import {
  CREATE_ROUTINE,
  DELETE_ROUTINE,
  LIST_ROUTINES,
  RoutineTools,
  RUN_ROUTINE,
  UPDATE_ROUTINE,
  type RoutineAnswer,
  type RoutineAsk,
} from './tools'

const CALLER = { sessionId: 's1', project: '/p' }
const WEEKDAYS: Schedule = { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }

function text(result: CallToolResult): string {
  return result.content.map((part) => ('text' in part ? part.text : '')).join('\n')
}

function agent(id: AgentId, name: string, more: Partial<AgentStatus> = {}): AgentStatus {
  return { id, name, registered: true, ...more } as AgentStatus
}

const AGENTS = [
  agent('claude-code', 'Claude Code'),
  agent('codex', 'Codex'),
  agent('pi', 'Pi'),
  agent('opencode', 'OpenCode'),
  agent('cline', 'Cline'),
  agent('codex~off', 'Codex (work)', { disabled: true }),
]

const CLAUDE_OPTIONS: AgentOptions = {
  agentId: 'claude-code',
  config: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      value: 'opus',
      choices: [
        { value: 'opus', name: 'Opus' },
        { value: 'sonnet', name: 'Sonnet' },
      ],
    },
  ],
  levels: {},
  remembered: { model: 'sonnet' },
  observedAt: 0,
}

function routine(overrides: Partial<RoutineView> = {}): RoutineView {
  return {
    id: 'r-0123456789ab',
    name: 'Weekly check',
    prompt: 'Check the dependencies',
    agentId: 'claude-code',
    projectPath: '/p',
    options: [{ id: 'model', value: 'opus' }],
    trigger: { kind: 'schedule', schedule: WEEKDAYS },
    scope: { level: 'read', web: false },
    timeLimitMinutes: 60,
    keptRunSessions: 100,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    checkedThrough: 0,
    state: 'on',
    nextRunAt: null,
    pause: null,
    activeRun: null,
    lastRun: null,
    unseen: { failed: 0, ended: 0 },
    runs: 4,
    sessions: 3,
    ...overrides,
  }
}

function harness(options: { sessionAgent?: AgentId; routines?: RoutineView[] } = {}) {
  const routines = new Map((options.routines ?? [routine()]).map((r) => [r.id, r]))
  const created: RoutineDraft[] = []
  const updated: [string, RoutineChanges][] = []
  const deleted: string[] = []
  const ran: string[] = []
  const asked: RoutineAsk[] = []
  const settled: RoutineChangeOutcome[] = []
  let answer: (given: RoutineAnswer) => void = () => {}
  const tools = new RoutineTools({
    list: async () => ({ routines: [...routines.values()], problem: null }),
    create: async (draft) => {
      created.push(draft)
      const made = routine({ ...draft, id: 'r-00000000000f', name: draft.name || 'Made' })
      routines.set(made.id, made)
      return made
    },
    update: async (routineId, changes) => {
      updated.push([routineId, changes])
      return routine({ ...routines.get(routineId), ...changes })
    },
    delete: async (routineId) => {
      deleted.push(routineId)
      routines.delete(routineId)
    },
    runNow: async (routineId) => {
      ran.push(routineId)
      return { id: 'run-1', routineId, status: 'starting' } as RoutineRun
    },
    agents: () => AGENTS,
    agentOptions: (agentId) => (agentId === 'claude-code' ? CLAUDE_OPTIONS : null),
    readOptions: async () => {},
    sessionAgent: () => options.sessionAgent ?? 'claude-code',
    sessionProject: () => '/p',
    project: async (path) => (path === '/p' || path === '/q' ? path : null),
    ask: (_, ask) => {
      asked.push(ask)
      return { entryId: 'e1', answer: new Promise((resolve) => (answer = resolve)) }
    },
    settle: (_, __, outcome) => settled.push(outcome),
  })
  const changed = () => [...created, ...updated, ...deleted, ...ran]
  return {
    tools,
    created,
    updated,
    deleted,
    ran,
    asked,
    settled,
    changed,
    answer: (given: RoutineAnswer) => answer(given),
  }
}

const create = (tools: RoutineTools, args: Record<string, unknown> = {}) =>
  tools.call(CALLER, CREATE_ROUTINE, { prompt: 'Check the build', schedule: WEEKDAYS, ...args })

afterEach(() => {
  vi.useRealTimers()
})

describe('list_routines', () => {
  it('lists the Routines without asking', async () => {
    const { tools, asked } = harness()
    const result = await tools.call(CALLER, LIST_ROUTINES, {})
    expect(text(result)).toContain('r-0123456789ab "Weekly check"')
    expect(text(result)).toContain('weekdays at 09:00')
    expect(asked).toEqual([])
  })
})

// A Routine runs later on its own and spends the user's plan, so no mode lets these act unasked.
describe('the Routine tools that change something', () => {
  const calls: [
    string,
    string,
    Record<string, unknown>,
    (h: ReturnType<typeof harness>) => unknown,
  ][] = [
    ['create', CREATE_ROUTINE, { prompt: 'Check the build', schedule: WEEKDAYS }, (h) => h.created],
    ['update', UPDATE_ROUTINE, { routine: 'r-0123456789ab', enabled: false }, (h) => h.updated],
    ['delete', DELETE_ROUTINE, { routine: 'r-0123456789ab' }, (h) => h.deleted],
    ['run', RUN_ROUTINE, { routine: 'r-0123456789ab' }, (h) => h.ran],
  ]

  for (const [action, name, args, done] of calls) {
    it(`${action} waits for the user's card and acts only once it is approved`, async () => {
      const h = harness()
      const pending = h.tools.call(CALLER, name, args)
      await vi.waitFor(() => expect(h.asked).toHaveLength(1))
      expect(h.asked[0]!.action).toBe(action)
      expect(h.changed()).toEqual([])
      h.answer({ decision: 'confirm' })
      const result = await pending
      expect(result.isError).toBeUndefined()
      expect(done(h)).toHaveLength(1)
      expect(h.settled).toEqual([{ kind: 'done', routineId: expect.any(String) }])
    })

    it(`${action} does nothing when the user declines, does not answer or the turn ends`, async () => {
      for (const decision of ['decline', 'expired', 'ended'] as const) {
        const h = harness()
        const pending = h.tools.call(CALLER, name, args)
        await vi.waitFor(() => expect(h.asked).toHaveLength(1))
        h.answer({ decision })
        expect(text(await pending)).toMatch(/nothing was/i)
        expect(h.changed()).toEqual([])
        expect(h.settled).toEqual([])
      }
    })
  }

  it('creates with the Routines page defaults where the agent names none', async () => {
    const h = harness()
    const pending = create(h.tools)
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    expect(h.asked[0]!.routine).toMatchObject({
      agentId: 'claude-code',
      model: 'Sonnet',
      projectPath: '/p',
      scope: { level: 'read', web: false },
      timeLimitMinutes: 60,
      enabled: true,
    })
    h.answer({ decision: 'confirm' })
    await pending
    expect(h.created[0]).toMatchObject({
      agentId: 'claude-code',
      options: [{ id: 'model', value: 'sonnet' }],
      projectPath: '/p',
      scope: { level: 'read', web: false },
      timeLimitMinutes: 60,
    })
  })
})

describe('what a Routine may run', () => {
  it('takes only Claude Code, Codex and Pi agents on this computer that are turned on', async () => {
    for (const args of [
      { agent: 'opencode' },
      { agent: 'cline' },
      { agent: 'claude-code~gone' },
      { agent: 'codex~off' },
    ]) {
      const h = harness()
      const result = await create(h.tools, args)
      expect(result.isError).toBe(true)
      expect(h.asked).toEqual([])
    }
    const own = harness({ sessionAgent: 'opencode' })
    const result = await create(own.tools)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('codex (Codex)')
    expect(text(result)).toContain('pi (Pi)')
    expect(own.asked).toEqual([])

    const forPi = harness()
    const pending = create(forPi.tools, { agent: 'pi' })
    await vi.waitFor(() => expect(forPi.asked).toHaveLength(1))
    expect(forPi.asked[0]!.routine.agentId).toBe('pi')
    forPi.answer({ decision: 'decline' })
    await pending
  })

  it('rejects Pi builds older than 1.0.0 that cannot run Kettu permission enforcement', async () => {
    const oldPi = new RoutineTools({
      list: async () => ({ routines: [], problem: null }),
      create: async () => routine(),
      update: async () => routine(),
      delete: async () => {},
      runNow: async () =>
        ({ id: 'run-1', routineId: 'r-0123456789ab', status: 'starting' }) as RoutineRun,
      agents: () => [
        agent('pi', 'Pi', {
          capabilities: {
            loadSession: true,
            listSessions: true,
            resumeSession: true,
            closeSession: true,
            deleteSession: true,
            forkSession: true,
            forkAtMessage: true,
            steering: false,
            reports: false,
            context: false,
            liveContext: false,
            account: false,
            mcpHttp: false,
            prompt: { image: true, audio: false, embeddedContext: true },
          },
        }),
      ],
      agentOptions: () => null,
      readOptions: async () => {},
      sessionAgent: () => 'pi',
      sessionProject: () => '/p',
      project: async (p) => (p === '/p' ? p : null),
      ask: () => null,
      settle: () => {},
    })
    const result = await create(oldPi, { agent: 'pi' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Pi 1.0.0 or later')
  })

  it('takes a project of Kettu’s only, or null for its own folder', async () => {
    const h = harness()
    expect((await create(h.tools, { project: '/elsewhere' })).isError).toBe(true)
    expect(h.asked).toEqual([])
    const pending = create(h.tools, { project: null })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    expect(h.asked[0]!.routine.projectPath).toBeNull()
    h.answer({ decision: 'decline' })
    await pending
  })

  it('refuses a schedule that cannot run, with the reason', async () => {
    for (const schedule of [
      { kind: 'once', at: '2001-01-01T09:00' },
      { kind: 'cron', expression: '* * * * *' },
      { kind: 'weekly', days: [], time: '09:00' },
      { kind: 'every', minutes: 2 },
      { kind: 'daily', time: '09:00' },
    ]) {
      const h = harness()
      const result = await create(h.tools, { schedule })
      expect(result.isError).toBe(true)
      expect(h.asked).toEqual([])
    }
  })

  it('refuses to run a Routine that already has a run going', async () => {
    const busy = routine({ activeRun: { id: 'run-0', status: 'running' } as RoutineRun })
    const h = harness({ routines: [busy] })
    const result = await h.tools.call(CALLER, RUN_ROUTINE, { routine: busy.id })
    expect(result.isError).toBe(true)
    expect(h.asked).toEqual([])
  })

  it('says on a deletion’s card how many run sessions go with it', async () => {
    const h = harness()
    const pending = h.tools.call(CALLER, DELETE_ROUTINE, { routine: 'r-0123456789ab' })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    expect(h.asked[0]!.sessions).toBe(3)
    h.answer({ decision: 'decline' })
    await pending
  })

  it('changes only what differs, and asks nothing when nothing does', async () => {
    const h = harness()
    const same = await h.tools.call(CALLER, UPDATE_ROUTINE, {
      routine: 'r-0123456789ab',
      schedule: WEEKDAYS,
      scope: 'read',
    })
    expect(text(same)).toContain('Nothing to change')
    expect(h.asked).toEqual([])
    const pending = h.tools.call(CALLER, UPDATE_ROUTINE, {
      routine: 'r-0123456789ab',
      scope: 'edit',
      model: 'sonnet',
    })
    await vi.waitFor(() => expect(h.asked).toHaveLength(1))
    expect(h.asked[0]!.before).toMatchObject({ scope: { level: 'read' }, model: 'Opus' })
    expect(h.asked[0]!.routine).toMatchObject({ scope: { level: 'edit' }, model: 'Sonnet' })
    h.answer({ decision: 'confirm' })
    await pending
    expect(h.updated).toEqual([
      [
        'r-0123456789ab',
        { options: [{ id: 'model', value: 'sonnet' }], scope: { level: 'edit', web: false } },
      ],
    ])
  })
})

describe('a call repeated while its card waits', () => {
  it('returns within a minute, and the same call again opens no second card or Routine', async () => {
    vi.useFakeTimers()
    const h = harness()
    const first = create(h.tools)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(text(await first)).toContain('has not answered')
    const second = create(h.tools)
    await vi.advanceTimersByTimeAsync(0)
    h.answer({ decision: 'confirm' })
    expect(text(await second)).toContain('is created')
    expect(h.asked).toHaveLength(1)
    expect(h.created).toHaveLength(1)
  })
})
