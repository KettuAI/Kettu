import { describe, expect, it } from 'vitest'
import type { TaskView, Workflow } from '@shared/tasks'
import type { AgentId } from '@shared/thread'
import type { OpenStageSession, StageSubmission, TaskAgent, TaskRuntime, TasksFile } from './api'
import { createTaskEngine, type TaskEngine } from './engine'
import { emptyTasksFile, type TasksStore } from './store'

function developmentWorkflow(): Workflow {
  return {
    format: 1,
    id: 'dev',
    name: 'Development',
    description: '',
    kind: 'development',
    version: '1',
    worktree: true,
    start: 'review',
    limits: { rounds: 3, stageMinutes: 60, budgetUsd: null },
    stages: [
      {
        kind: 'agent',
        id: 'review',
        name: 'Review',
        next: 'confirm',
        prompt: 'Review the requirement.',
        tier: 'deep',
        scope: { level: 'read', web: false },
        session: 'new',
        contract: [
          { name: 'size', type: 'size', required: true, description: 'S, M or L' },
          { name: 'risk', type: 'risk', required: true, description: 'risky' },
        ],
        evidence: ['no-file-changes'],
        gate: 'contract',
      },
      {
        kind: 'human',
        id: 'confirm',
        name: 'Confirm',
        next: 'build',
        prompt: 'Confirm the plan.',
        sendBack: ['review'],
        when: { size: ['L'], risk: true },
      },
      {
        kind: 'agent',
        id: 'build',
        name: 'Build',
        next: 'check',
        prompt: 'Build it.',
        tier: { S: 'fast', M: 'standard', L: 'deep', default: 'standard' },
        scope: { level: 'commands', web: false },
        session: 'resume',
        contract: [{ name: 'commands', type: 'list', required: true, description: 'commands run' }],
        evidence: ['changed-files', 'reported-commands-ran'],
        gate: 'contract',
      },
      {
        kind: 'agent',
        id: 'check',
        name: 'Check',
        next: 'accept',
        prompt: 'Review the change.',
        tier: 'deep',
        requires: { otherHarnessThan: 'build' },
        scope: { level: 'read', web: false },
        session: 'new',
        contract: [],
        evidence: ['no-file-changes'],
        gate: 'agent',
        rework: { to: 'build', rounds: 2 },
      },
      {
        kind: 'human',
        id: 'accept',
        name: 'Accept',
        next: 'pr',
        prompt: 'Accept the work.',
        sendBack: ['build'],
      },
      { kind: 'handover', id: 'pr', name: 'Pull request', next: null, action: 'pull-request' },
    ],
  }
}

interface FakeSession {
  agentId: AgentId
  turns: number
  alive: boolean
  sent: string[]
  commands: string[]
  changed: string[]
  cost: number
}

function agent(agentId: AgentId, harness: string): TaskAgent {
  return { agentId, harness, enabled: true, canRunStages: true, limits: [] }
}

class FakeRuntime implements TaskRuntime {
  time = 1_000_000
  agentList: TaskAgent[] = [agent('claude-code', 'claude-code'), agent('codex', 'codex')]
  sessions = new Map<string, FakeSession>()
  opened: (OpenStageSession & { sessionId: string })[] = []
  stopped: string[] = []
  notified: [string, string][] = []
  handovers = 0
  handoverError: Error | null = null
  worktrees = 0
  workflowValue = developmentWorkflow()
  private count = 0

  now(): number {
    return this.time
  }
  agents(): TaskAgent[] {
    return this.agentList
  }
  async createWorktree(task: { id: string }) {
    this.worktrees++
    return {
      path: `/wt/${task.id}`,
      branch: `task/${task.id}`,
      base: 'main',
      baseOid: 'a'.repeat(40),
    }
  }
  async openSession(params: OpenStageSession) {
    const sessionId = `s${++this.count}`
    this.sessions.set(sessionId, {
      agentId: params.agentId,
      turns: 1,
      alive: true,
      sent: [],
      commands: [],
      changed: [],
      cost: 0,
    })
    this.opened.push({ ...params, sessionId })
    return { sessionId, model: `model-of-${params.agentId}` }
  }
  async send(sessionId: string, text: string) {
    const session = this.sessions.get(sessionId)!
    session.sent.push(text)
    session.turns++
  }
  async stop(sessionId: string) {
    this.stopped.push(sessionId)
  }
  alive(sessionId: string) {
    return this.sessions.get(sessionId)?.alive ?? false
  }
  async evidence(sessionId: string) {
    const s = this.sessions.get(sessionId)!
    return {
      commands: [...s.commands],
      changedFiles: [...s.changed],
      turns: s.turns,
      costUsd: s.cost,
    }
  }
  turns(sessionId: string) {
    return this.sessions.get(sessionId)?.turns ?? 0
  }
  costSince(sessionId: string) {
    return this.sessions.get(sessionId)?.cost ?? 0
  }
  async handover() {
    this.handovers++
    if (this.handoverError) throw this.handoverError
    return 'https://github.com/o/r/pull/1'
  }
  notify(task: TaskView, kind: 'needs-you' | 'done' | 'blocked') {
    this.notified.push([task.id, kind])
  }
  async workflow() {
    return { workflow: structuredClone(this.workflowValue), hash: 'hash' }
  }
  async workflows() {
    return []
  }
  /** What the session does during the round: commands run and files changed. */
  act(sessionId: string, commands: string[], changed: string[]) {
    const s = this.sessions.get(sessionId)!
    s.commands = commands
    s.changed = changed
  }
}

function memoryStore(initial: TasksFile = emptyTasksFile()) {
  let saved = structuredClone(initial)
  const store: TasksStore & { saved(): TasksFile } = {
    load: async () => structuredClone(saved),
    save: (data) => {
      saved = structuredClone(data)
    },
    flush: async () => {},
    saved: () => saved,
  }
  return store
}

async function setup(
  options: { runtime?: FakeRuntime; store?: ReturnType<typeof memoryStore>; max?: number } = {},
) {
  const runtime = options.runtime ?? new FakeRuntime()
  const store = options.store ?? memoryStore()
  const timers = { setTimeout: () => 0, clearTimeout: () => {} }
  const engine = createTaskEngine({
    runtime,
    file: store,
    events: { changed: () => {}, removed: () => {}, run: () => {} },
    log: () => {},
    timers,
    maxSessions: options.max,
  })
  await engine.load()
  return { engine, runtime, store }
}

const PROJECT = '/projects/app'

async function createTask(
  engine: TaskEngine,
  extra: Partial<Parameters<TaskEngine['create']>[0]> = {},
) {
  const task = await engine.create(
    {
      requirement: 'Add dark mode\n\nMore details',
      projectPath: PROJECT,
      workflow: { source: 'official', id: 'dev' },
      start: true,
      ...extra,
    },
    'user',
  )
  await engine.idle()
  return task
}

function last<T>(list: T[]): T {
  return list[list.length - 1]!
}

const pass = (fields: StageSubmission['fields'] = {}): StageSubmission => ({
  verdict: 'pass',
  summary: 'Done.',
  fields,
})

/** Runs the review stage to a pass with the given size and risk. */
async function passReview(engine: TaskEngine, runtime: FakeRuntime, size = 'S', risk = false) {
  const review = last(runtime.opened)
  expect(review.run.stageId).toBe('review')
  const answer = await engine.submit(review.sessionId, pass({ size, risk }))
  expect(answer.ok).toBe(true)
  await engine.idle()
}

async function passBuild(engine: TaskEngine, runtime: FakeRuntime, sessionId?: string) {
  const id = sessionId ?? last(runtime.opened.filter((o) => o.run.stageId === 'build')).sessionId
  runtime.act(id, ['pnpm test --run'], ['src/a.ts'])
  const answer = await engine.submit(id, pass({ commands: ['pnpm test'] }))
  expect(answer).toMatchObject({ ok: true })
  await engine.idle()
  return id
}

describe('task engine', () => {
  it('runs a development task end to end', async () => {
    const { engine, runtime } = await setup()
    const created = await createTask(engine)
    expect(created.title).toBe('Add dark mode')
    expect(runtime.opened).toHaveLength(1)
    const review = runtime.opened[0]!
    expect(review.agentId).toBe('claude-code')
    expect(review.options).toEqual({ model: 'opus' })
    expect(review.prompt).toContain('Review the requirement.')
    expect(review.prompt).toContain('submit_stage')
    expect(engine.get(created.id).task.state).toBe('running')

    await passReview(engine, runtime)
    // Confirm is skipped (S, no risk); build runs at the fast tier for S.
    const runs = engine.get(created.id).runs
    expect(runs.find((r) => r.stageId === 'confirm')?.state).toBe('skipped')
    const build = last(runtime.opened)
    expect(build.run.stageId).toBe('build')
    expect(build.options).toEqual({ model: 'haiku' })
    expect(build.prompt).toContain('### Review')

    await passBuild(engine, runtime)
    // The check goes to another harness than the build's.
    const check = last(runtime.opened)
    expect(check.run.stageId).toBe('check')
    expect(check.agentId).toBe('codex')
    expect(check.options).toEqual({ reasoning_effort: 'high' })

    expect(await engine.submit(check.sessionId, pass())).toMatchObject({ ok: true })
    await engine.idle()
    let task = engine.get(created.id).task
    expect(task.state).toBe('waiting')
    expect(task.stageId).toBe('accept')
    expect(runtime.handovers).toBe(0)
    expect(runtime.notified).toContainEqual([created.id, 'needs-you'])

    await engine.decide({ taskId: created.id, decision: 'approve' })
    await engine.idle()
    task = engine.get(created.id).task
    expect(runtime.handovers).toBe(1)
    expect(task.state).toBe('done')
    expect(task.pullRequest).toBe('https://github.com/o/r/pull/1')
    expect(task.size).toBe('S')
    expect(runtime.worktrees).toBe(1)
    expect(runtime.notified).toContainEqual([created.id, 'done'])
  })

  it('refuses a result that misses its contract and keeps the round open', async () => {
    const { engine, runtime } = await setup()
    const task = await createTask(engine)
    const review = runtime.opened[0]!
    const refused = await engine.submit(review.sessionId, pass({ size: 'S' }))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toContain('"risk" is missing')
    const wrong = await engine.submit(review.sessionId, pass({ size: 'XL', risk: false }))
    expect(wrong.ok).toBe(false)
    expect(engine.get(task.id).runs[0]!.state).toBe('running')
    expect(engine.get(task.id).task.stageId).toBe('review')
    expect((await engine.submit(review.sessionId, pass({ size: 'S', risk: false }))).ok).toBe(true)
  })

  it('checks evidence from the session, not the words', async () => {
    const { engine, runtime } = await setup()
    await createTask(engine)
    const review = runtime.opened[0]!
    runtime.act(review.sessionId, [], ['src/x.ts'])
    const changed = await engine.submit(review.sessionId, pass({ size: 'S', risk: false }))
    expect(changed).toMatchObject({ ok: false })
    runtime.act(review.sessionId, [], [])
    await passReview(engine, runtime)

    const build = last(runtime.opened).sessionId
    runtime.act(build, ['pnpm lint'], ['src/a.ts'])
    const notRun = await engine.submit(build, pass({ commands: ['pnpm test'] }))
    expect(notRun.ok).toBe(false)
    if (!notRun.ok) expect(notRun.error).toContain('"pnpm test"')
    runtime.act(build, ['pnpm   test'], [])
    const noFiles = await engine.submit(build, pass({ commands: ['pnpm test'] }))
    expect(noFiles.ok).toBe(false)
    runtime.act(build, ['cd app && pnpm   test --run'], ['src/a.ts'])
    expect((await engine.submit(build, pass({ commands: ['pnpm test'] }))).ok).toBe(true)
  })

  it('sends work back to the stage it came from, in the same session', async () => {
    const { engine, runtime } = await setup()
    const task = await createTask(engine)
    await passReview(engine, runtime)
    const build = await passBuild(engine, runtime)
    const check = last(runtime.opened)
    const opened = runtime.opened.length
    const answer = await engine.submit(check.sessionId, {
      verdict: 'changes',
      summary: 'Rename the helper.',
      fields: {},
    })
    expect(answer).toMatchObject({ ok: true })
    await engine.idle()
    expect(runtime.opened).toHaveLength(opened)
    const session = runtime.sessions.get(build)!
    expect(session.sent).toHaveLength(1)
    expect(session.sent[0]).toContain('Rename the helper.')
    const view = engine.get(task.id)
    expect(view.task.stageId).toBe('build')
    const builds = view.runs.filter((r) => r.stageId === 'build')
    expect(builds.map((r) => r.round)).toEqual([1, 2])
    expect(last(builds).sessionId).toBe(build)
    expect(last(builds).state).toBe('running')
  })

  it('blocks once the rework rounds are used up', async () => {
    const { engine, runtime } = await setup()
    const task = await createTask(engine)
    await passReview(engine, runtime)
    let build = await passBuild(engine, runtime)
    for (let round = 0; round < 3; round++) {
      const check = last(runtime.opened.filter((o) => o.run.stageId === 'check'))
      await engine.submit(check.sessionId, { verdict: 'changes', summary: 'Again.', fields: {} })
      await engine.idle()
      if (round < 2) build = await passBuild(engine, runtime, build)
    }
    const view = engine.get(task.id).task
    expect(view.state).toBe('blocked')
    expect(view.reason).toContain('rework limit')
    expect(runtime.notified).toContainEqual([task.id, 'blocked'])
  })

  it('lets the person approve or send back at a human stage', async () => {
    const { engine, runtime } = await setup()
    const task = await createTask(engine)
    await passReview(engine, runtime)
    const build = await passBuild(engine, runtime)
    await engine.submit(last(runtime.opened).sessionId, pass())
    await engine.idle()
    await expect(
      engine.decide({ taskId: task.id, decision: 'send-back', to: 'review' }),
    ).rejects.toThrow()
    await engine.decide({ taskId: task.id, decision: 'send-back', to: 'build', note: 'Use tabs.' })
    await engine.idle()
    expect(engine.get(task.id).task.stageId).toBe('build')
    expect(last(runtime.sessions.get(build)!.sent)).toContain('Use tabs.')
    expect(runtime.handovers).toBe(0)
  })

  it('runs a conditional stage when any of its keys matches', async () => {
    const { engine, runtime } = await setup()
    const task = await createTask(engine)
    await passReview(engine, runtime, 'S', true)
    const view = engine.get(task.id)
    expect(view.task.state).toBe('waiting')
    expect(view.task.stageId).toBe('confirm')
    expect(view.runs.find((r) => r.stageId === 'confirm')?.state).toBe('waiting')
  })

  it('steps up a tier for each failed round and on request', async () => {
    const runtime = new FakeRuntime()
    const build = runtime.workflowValue.stages.find((s) => s.id === 'build')!
    if (build.kind === 'agent') build.session = 'new'
    const { engine } = await setup({ runtime })
    await createTask(engine)
    await passReview(engine, runtime)
    await passBuild(engine, runtime)
    await engine.submit(last(runtime.opened).sessionId, {
      verdict: 'changes',
      summary: 'Nope.',
      fields: {},
    })
    await engine.idle()
    // S is fast; one earlier round steps it up to standard.
    expect(last(runtime.opened).run.stageId).toBe('build')
    expect(last(runtime.opened).options).toEqual({})
    await passBuild(engine, runtime)
    await engine.submit(last(runtime.opened).sessionId, {
      verdict: 'changes',
      summary: 'Nope again.',
      fields: {},
      escalate: true,
    })
    await engine.idle()
    expect(last(runtime.opened).options).toEqual({ model: 'opus' })
  })

  it('prefers another harness, and falls back to the same one when none is free', async () => {
    const runtime = new FakeRuntime()
    runtime.agentList[1]!.enabled = false
    const { engine } = await setup({ runtime })
    await createTask(engine)
    await passReview(engine, runtime)
    await passBuild(engine, runtime)
    const check = last(runtime.opened)
    expect(check.run.stageId).toBe('check')
    expect(check.agentId).toBe('claude-code')
  })

  it('skips agents near a plan limit and pauses when none is left', async () => {
    const runtime = new FakeRuntime()
    const near = {
      window: 'five_hour',
      label: '5-hour',
      usedPercent: 95,
      resetsAt: runtime.time + 3_600_000,
      state: 'warning' as const,
      observedAt: runtime.time,
    }
    runtime.agentList[0]!.limits = [near]
    const { engine } = await setup({ runtime })
    const first = await createTask(engine)
    expect(runtime.opened[0]!.agentId).toBe('codex')

    runtime.agentList[1]!.limits = [{ ...near, state: 'reached', usedPercent: 100 }]
    const second = await createTask(engine)
    expect(runtime.opened).toHaveLength(1)
    let view = engine.get(second.id).task
    expect(view.state).toBe('paused')
    expect(view.reason).toContain('deep')

    runtime.agentList[0]!.limits = []
    engine.limitsChanged()
    await engine.idle()
    view = engine.get(second.id).task
    expect(view.state).toBe('running')
    expect(last(runtime.opened).agentId).toBe('claude-code')
    expect(engine.get(first.id).task.state).toBe('running')
  })

  it('blocks when no agent can ever run the tier', async () => {
    const runtime = new FakeRuntime()
    runtime.agentList = [{ ...agent('opencode', 'opencode'), canRunStages: false }]
    const { engine } = await setup({ runtime })
    const task = await createTask(engine)
    expect(engine.get(task.id).task.state).toBe('blocked')
    expect(runtime.opened).toHaveLength(0)
  })

  it('reminds once after a turn without a result, then blocks as stalled', async () => {
    const { engine, runtime } = await setup()
    const task = await createTask(engine)
    const review = runtime.opened[0]!
    engine.turnEnded(review.sessionId)
    await engine.idle()
    const session = runtime.sessions.get(review.sessionId)!
    expect(session.sent).toHaveLength(1)
    expect(session.sent[0]).toContain('submit_stage')
    expect(engine.get(task.id).task.state).toBe('running')
    engine.turnEnded(review.sessionId)
    await engine.idle()
    const view = engine.get(task.id)
    expect(view.task.state).toBe('blocked')
    expect(view.task.reason).toContain('stalled')
    expect(view.runs[0]!.state).toBe('blocked')
  })

  it('ignores the late end of a turn from before the round', async () => {
    const { engine, runtime } = await setup()
    const task = await createTask(engine)
    await passReview(engine, runtime)
    const build = await passBuild(engine, runtime)
    await engine.submit(last(runtime.opened).sessionId, {
      verdict: 'changes',
      summary: 'Fix.',
      fields: {},
    })
    await engine.idle()
    // The rework message is queued behind the build's first turn, whose end arrives now.
    runtime.sessions.get(build)!.turns--
    engine.turnEnded(build)
    await engine.idle()
    expect(runtime.sessions.get(build)!.sent).toHaveLength(1)
    expect(engine.get(task.id).task.state).toBe('running')
  })

  it('carries an interrupted round on after a restart, and blocks a second cut', async () => {
    const store = memoryStore()
    const runtime = new FakeRuntime()
    const first = await setup({ runtime, store })
    const task = await createTask(first.engine)
    await passReview(first.engine, runtime)
    const build = last(runtime.opened).sessionId
    first.engine.dispose()

    const second = await setup({ runtime, store })
    await second.engine.idle()
    const runs = second.engine.get(task.id).runs.filter((r) => r.stageId === 'build')
    expect(runs.map((r) => r.state)).toEqual(['interrupted', 'running'])
    expect(runs.map((r) => r.round)).toEqual([1, 1])
    expect(last(runs).sessionId).toBe(build)
    expect(runtime.sessions.get(build)!.sent[0]).toContain('interrupted')
    second.engine.dispose()

    const third = await setup({ runtime, store })
    await third.engine.idle()
    const view = third.engine.get(task.id).task
    expect(view.state).toBe('blocked')
    expect(view.reason).toContain('interrupted twice')
  })

  it('keeps to the session limit and orders by priority', async () => {
    const { engine, runtime } = await setup({ max: 2 })
    await createTask(engine, { priority: 'low' })
    await createTask(engine, { priority: 'low' })
    const low = await createTask(engine, { priority: 'low' })
    const high = await createTask(engine, { priority: 'high' })
    expect(runtime.opened).toHaveLength(2)
    expect(engine.get(low.id).task.state).toBe('queued')
    expect(engine.get(high.id).task.state).toBe('queued')
    await engine.submit(runtime.opened[0]!.sessionId, pass({ size: 'S', risk: false }))
    await engine.idle()
    // The first task's build goes first, being in progress; then nothing is free.
    expect(runtime.opened).toHaveLength(3)
    expect(last(runtime.opened).run.stageId).toBe('build')
    await engine.cancel(engine.list()[0]!.id)
    await engine.idle()
    expect(last(runtime.opened).task.id).toBe(high.id)
    expect(engine.get(low.id).task.state).toBe('queued')
  })

  it('waits for the tasks it comes after', async () => {
    const { engine, runtime } = await setup()
    const first = await createTask(engine, { start: false })
    const second = await createTask(engine, { after: [first.id] })
    expect(runtime.opened).toHaveLength(0)
    expect(engine.get(second.id).task.state).toBe('queued')
    engine.start(first.id)
    await engine.idle()
    expect(runtime.opened.map((o) => o.task.id)).toEqual([first.id])
  })

  it('keeps an agent-made task in the backlog', async () => {
    const { engine, runtime } = await setup()
    const task = await engine.create(
      {
        requirement: 'x',
        projectPath: PROJECT,
        workflow: { source: 'official', id: 'dev' },
        start: true,
      },
      'agent',
    )
    await engine.idle()
    expect(task.state).toBe('backlog')
    expect(runtime.opened).toHaveLength(0)
  })

  it('stops a stage at its time limit, not counting time spent waiting', async () => {
    const { engine, runtime } = await setup()
    const task = await createTask(engine)
    const review = runtime.opened[0]!.sessionId
    engine.waiting(review, true)
    expect(engine.get(task.id).task.state).toBe('waiting')
    runtime.time += 61 * 60_000
    engine.tick()
    await engine.idle()
    expect(engine.get(task.id).task.state).toBe('waiting')
    engine.waiting(review, false)
    runtime.time += 59 * 60_000
    engine.tick()
    await engine.idle()
    expect(engine.get(task.id).task.state).toBe('running')
    runtime.time += 2 * 60_000
    engine.tick()
    await engine.idle()
    expect(engine.get(task.id).task.state).toBe('blocked')
    expect(runtime.stopped).toContain(review)
  })

  it('blocks a task over its budget', async () => {
    const runtime = new FakeRuntime()
    runtime.workflowValue.limits.budgetUsd = 1
    const { engine } = await setup({ runtime })
    const task = await createTask(engine)
    const review = runtime.opened[0]!.sessionId
    runtime.sessions.get(review)!.cost = 1.5
    engine.turnEnded(review)
    await engine.idle()
    const view = engine.get(task.id).task
    expect(view.state).toBe('blocked')
    expect(view.costUsd).toBe(1.5)
    expect(view.reason).toContain('budget')
  })

  it('counts the cost of the turn a stage submitted in, once that turn ends', async () => {
    const { engine, runtime } = await setup()
    const task = await createTask(engine)
    const review = runtime.opened[0]!.sessionId
    await passReview(engine, runtime)
    runtime.sessions.get(review)!.cost = 0.4
    engine.costChanged(review)
    await engine.idle()
    const { task: view, runs } = engine.get(task.id)
    expect(runs.find((run) => run.stageId === 'review')!.costUsd).toBe(0.4)
    expect(view.costUsd).toBe(0.4)
  })

  it('pauses and resumes, carrying the round on in its session', async () => {
    const { engine, runtime } = await setup()
    const task = await createTask(engine)
    const review = runtime.opened[0]!.sessionId
    engine.pause(task.id)
    await engine.idle()
    expect(runtime.stopped).toContain(review)
    expect(engine.get(task.id).task.state).toBe('paused')
    engine.resume(task.id)
    await engine.idle()
    expect(engine.get(task.id).task.state).toBe('running')
    expect(runtime.opened).toHaveLength(1)
    expect(runtime.sessions.get(review)!.sent).toHaveLength(1)
  })

  it('cancels a working stage and refuses its later result', async () => {
    const { engine, runtime } = await setup()
    const task = await createTask(engine)
    const review = runtime.opened[0]!.sessionId
    await engine.cancel(task.id)
    expect(runtime.stopped).toContain(review)
    expect(engine.get(task.id).task.state).toBe('cancelled')
    expect((await engine.submit(review, pass({ size: 'S', risk: false }))).ok).toBe(false)
  })

  it('blocks when the pull request cannot be opened, and retries on approve', async () => {
    const { engine, runtime } = await setup()
    const task = await createTask(engine)
    await passReview(engine, runtime)
    await passBuild(engine, runtime)
    await engine.submit(last(runtime.opened).sessionId, pass())
    await engine.idle()
    runtime.handoverError = new Error('push rejected')
    await engine.decide({ taskId: task.id, decision: 'approve' })
    await engine.idle()
    expect(engine.get(task.id).task.state).toBe('blocked')
    expect(engine.get(task.id).task.reason).toContain('push rejected')
    runtime.handoverError = null
    await engine.decide({ taskId: task.id, decision: 'approve' })
    await engine.idle()
    expect(engine.get(task.id).task.state).toBe('done')
  })
})
