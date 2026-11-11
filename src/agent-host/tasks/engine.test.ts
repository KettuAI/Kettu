import { describe, expect, it } from 'vitest'
import type {
  HandIn,
  NodeRunView,
  Sop,
  SopNode,
  SopOutcome,
  TaskTier,
  TaskView,
} from '@shared/tasks'
import type { AgentId } from '@shared/thread'
import type { WorktreeRecord } from '../storage'
import type { OpenNodeSession, TaskAgent, TaskRecord, TaskRuntime, TasksFile } from './api'
import { createTaskEngine, type TaskEngine } from './engine'
import { emptyTasksFile, type TasksStore } from './store'

const to = (id: string, ...targets: string[]): SopOutcome => ({ id, name: `${id}!`, to: targets })
const end = (id: string, how: 'done' | 'dropped' = 'done'): SopOutcome => ({
  id,
  name: `${id}!`,
  to: [],
  end: how,
})

function node(
  id: string,
  outcomes: SopOutcome[],
  extra: { handIn?: HandIn; tier?: TaskTier; person?: boolean } = {},
): SopNode {
  return {
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    prompt: `Do the ${id} work.`,
    by: extra.person ? { kind: 'person' } : { kind: 'agent', tier: extra.tier ?? 'standard' },
    handIn: extra.handIn ?? (extra.person ? 'verdict' : 'note'),
    outcomes,
  }
}

function sop(nodes: SopNode[], rounds = 3): Sop {
  return {
    format: 1,
    id: 'test',
    name: 'Test flow',
    description: '',
    start: nodes[0]!.id,
    nodes,
    rounds,
  }
}

/** Plan, build, test; a failed test goes back to build. */
const linear = (rounds = 3): Sop =>
  sop(
    [
      node('plan', [to('done', 'build')], { handIn: 'document', tier: 'deep' }),
      node('build', [to('done', 'test')]),
      node('test', [end('pass'), to('fail', 'build')], { handIn: 'verdict', tier: 'fast' }),
    ],
    rounds,
  )

/** Design, then build and tests at once, joined at verify. */
const parallel = (): Sop =>
  sop([
    node('design', [to('done', 'build', 'tests')]),
    node('build', [to('done', 'verify'), to('redesign', 'design')]),
    node('tests', [to('done', 'verify')]),
    node('verify', [end('pass'), to('fail', 'build')], { handIn: 'verdict' }),
  ])

interface FakeSession {
  alive: boolean
  working: boolean
  sent: string[]
}

type Opened = Omit<OpenNodeSession, 'task' | 'run'> & {
  sessionId: string
  nodeId: string
  runId: string
}

function agent(agentId: AgentId, harness: string): TaskAgent {
  return { agentId, harness, enabled: true, canRunNodes: true }
}

const key = (into: WorktreeRecord, from: WorktreeRecord): string => `${into.path}<-${from.path}`

class FakeRuntime implements TaskRuntime {
  time = 1_000_000
  agentList: TaskAgent[] = [agent('claude-code', 'claude-code'), agent('codex', 'codex')]
  git = true
  sopValue: Sop = linear()
  sessions = new Map<string, FakeSession>()
  opened: Opened[] = []
  stopped: string[] = []
  notified: [string, string][] = []
  forks: { from: string; label: string; worktree: WorktreeRecord }[] = []
  merges: { into: string; from: string; leave: boolean }[] = []
  removed: { path: string; merged: boolean }[] = []
  /** Worktrees with uncommitted changes, by path. */
  dirty = new Set<string>()
  /** Branch worktrees that do not merge without conflicts, by path. */
  conflicts = new Set<string>()
  /** Worktrees with a merge left under way, by path. */
  merging = new Set<string>()
  mergedIn = new Set<string>()
  /** Worktrees whose branch was deleted, by path. */
  gone = new Set<string>()
  failWorktree: Error | null = null
  failFork: Error | null = null
  failMerge: Error | null = null
  failOpen: Error | null = null
  failSend: Error | null = null
  /** Called while a session opens, before the engine hears its id. */
  onOpen: ((sessionId: string) => void) | null = null
  private count = 0

  now(): number {
    return this.time++
  }
  agents(): TaskAgent[] {
    return this.agentList
  }
  async createWorktree(task: TaskRecord): Promise<WorktreeRecord | null> {
    if (this.failWorktree) throw this.failWorktree
    if (!this.git) return null
    return { path: `/wt/${task.id}`, branch: `task/${task.id}`, base: 'main', baseOid: 'a' }
  }
  async forkWorktree(_task: TaskRecord, from: WorktreeRecord, label: string) {
    if (this.failFork) throw this.failFork
    const name = `${label}-${this.forks.length + 1}`
    const worktree = {
      path: `/wt/${name}`,
      branch: `task/${name}`,
      base: from.branch,
      baseOid: 'b',
    }
    this.forks.push({ from: from.path, label, worktree })
    return worktree
  }
  async clean(worktree: WorktreeRecord) {
    return !this.dirty.has(worktree.path) && !this.merging.has(worktree.path)
  }
  async merge(into: WorktreeRecord, from: WorktreeRecord, leave: boolean) {
    if (this.failMerge) throw this.failMerge
    this.merges.push({ into: into.path, from: from.path, leave })
    if (this.conflicts.has(from.path)) {
      if (leave) this.merging.add(into.path)
      return 'conflict' as const
    }
    this.mergedIn.add(key(into, from))
    return 'merged' as const
  }
  async merged(into: WorktreeRecord, from: WorktreeRecord) {
    if (this.gone.has(from.path)) throw new Error(`no branch ${from.branch}`)
    return this.mergedIn.has(key(into, from))
  }
  async removeWorktree(_task: TaskRecord, worktree: WorktreeRecord, merged: boolean) {
    this.removed.push({ path: worktree.path, merged })
  }
  async openSession(params: OpenNodeSession) {
    if (this.failOpen) throw this.failOpen
    const sessionId = `s${++this.count}`
    this.sessions.set(sessionId, { alive: true, working: true, sent: [] })
    const { run, agentId, options, prompt, title, worktree } = params
    this.opened.push({
      agentId,
      options,
      prompt,
      title,
      worktree,
      sessionId,
      nodeId: run.nodeId,
      runId: run.id,
    })
    this.onOpen?.(sessionId)
    return { sessionId, model: `model-of-${params.agentId}` }
  }
  async send(sessionId: string, text: string) {
    if (this.failSend) throw this.failSend
    const session = this.sessions.get(sessionId)!
    session.sent.push(text)
    session.working = true
  }
  async stop(sessionId: string) {
    this.stopped.push(sessionId)
    const session = this.sessions.get(sessionId)
    if (session) session.working = false
  }
  alive(sessionId: string) {
    return this.sessions.get(sessionId)?.alive ?? false
  }
  working(sessionId: string) {
    return this.sessions.get(sessionId)?.working ?? false
  }
  notify(task: TaskView, kind: 'needs-you' | 'done') {
    this.notified.push([task.id, kind])
  }
  async sop() {
    return { sop: structuredClone(this.sopValue), hash: 'hash' }
  }

  /** The latest session opened for a node. */
  session(nodeId: string): Opened {
    const opened = this.opened.findLast((o) => o.nodeId === nodeId)
    if (!opened) throw new Error(`no session was opened for ${nodeId}`)
    return opened
  }
  /** The latest worktree forked for a node. */
  lane(label: string): WorktreeRecord {
    const fork = this.forks.findLast((f) => f.label === label)
    if (!fork) throw new Error(`no worktree was forked for ${label}`)
    return fork.worktree
  }
  /** The agent finishes a merge by hand. */
  resolve(into: string, from: string) {
    this.conflicts.delete(from)
    this.merging.delete(into)
    this.mergedIn.add(`${into}<-${from}`)
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
    saved: () => structuredClone(saved),
  }
  return store
}

async function setup(
  options: {
    runtime?: FakeRuntime
    store?: ReturnType<typeof memoryStore>
    sop?: Sop
    max?: number
  } = {},
) {
  const runtime = options.runtime ?? new FakeRuntime()
  if (options.sop) runtime.sopValue = options.sop
  const store = options.store ?? memoryStore()
  const events = { changed: [] as TaskView[], runs: [] as NodeRunView[], removed: [] as string[] }
  const engine = createTaskEngine({
    runtime,
    file: store,
    events: {
      changed: (task) => events.changed.push(task),
      removed: (taskId) => events.removed.push(taskId),
      run: (run) => events.runs.push(run),
    },
    log: () => {},
    maxSessions: options.max,
  })
  await engine.load()
  await engine.idle()
  return { engine, runtime, store, events }
}

const PROJECT = '/projects/app'

async function createTask(engine: TaskEngine, requirement = 'Add dark mode\n\nMore details') {
  const task = await engine.create(
    { requirement, projectPath: PROJECT, sop: { source: 'official', id: 'test' } },
    'user',
  )
  await engine.idle()
  return task
}

/** A report that must be taken. */
async function report(
  engine: TaskEngine,
  sessionId: string,
  outcome: string,
  extra: { note?: string; document?: string } = {},
) {
  const answer = await engine.report(sessionId, { outcome, note: `${outcome} note`, ...extra })
  expect(answer).toMatchObject({ ok: true })
  await engine.idle()
  return answer.ok ? answer.next : ''
}

/** A report that must be refused; gives what the agent is told. */
async function refused(engine: TaskEngine, sessionId: string, outcome: string, note = 'A note') {
  const answer = await engine.report(sessionId, { outcome, note })
  expect(answer.ok).toBe(false)
  return answer.ok ? '' : answer.error
}

async function endTurn(engine: TaskEngine, runtime: FakeRuntime, sessionId: string) {
  runtime.sessions.get(sessionId)!.working = false
  engine.turnEnded(sessionId)
  await engine.idle()
}

function runsOf(engine: TaskEngine, taskId: string, nodeId: string): NodeRunView[] {
  return engine.get(taskId).runs.filter((run) => run.nodeId === nodeId)
}

function lastRun(engine: TaskEngine, taskId: string, nodeId: string): NodeRunView {
  return runsOf(engine, taskId, nodeId).at(-1)!
}

describe('a task along its SOP', () => {
  it('runs a linear SOP end to end, each node in its own session', async () => {
    const { engine, runtime, store } = await setup()
    const task = await createTask(engine)
    expect(task.title).toBe('Add dark mode')
    expect(task.worktree?.path).toBe(`/wt/${task.id}`)
    expect(task.outline.nodes.map((n) => n.id)).toEqual(['plan', 'build', 'test'])
    expect(task.outline.nodes[0]).not.toHaveProperty('prompt')

    const plan = runtime.session('plan')
    expect(plan.agentId).toBe('claude-code')
    expect(plan.options).toEqual({ model: 'opus' })
    expect(plan.worktree?.path).toBe(task.worktree?.path)
    expect(plan.title).toBe('Add dark mode · Plan')
    expect(plan.prompt).toContain('Do the plan work.')
    expect(plan.prompt).toContain('More details')
    expect(plan.prompt).toContain('`report_sop_node` tool of the `kettu` MCP server')
    expect(plan.prompt).toContain('`done` (done!): goes on to "Build"')
    expect(plan.prompt).toContain('- document:')
    expect(engine.get(task.id).task.state).toBe('running')
    expect(engine.nodeOf(plan.sessionId)).toEqual({
      taskId: task.id,
      runId: plan.runId,
      nodeId: 'plan',
    })

    const next = await report(engine, plan.sessionId, 'done', { document: '# The plan\n\nTabs.' })
    expect(next).toContain('The task goes on to "Build".')
    expect(next).toContain('stop working in this session')
    expect(engine.nodeOf(plan.sessionId)).toBeNull()
    expect(engine.document(plan.runId)).toBe('# The plan\n\nTabs.')
    expect(lastRun(engine, task.id, 'plan')).toMatchObject({
      state: 'done',
      outcome: 'done',
      note: 'done note',
      hasDocument: true,
      model: 'model-of-claude-code',
      tier: 'deep',
      round: 1,
    })

    const build = runtime.session('build')
    expect(build.sessionId).not.toBe(plan.sessionId)
    expect(build.options).toEqual({})
    expect(build.prompt).toContain('### Plan: done!')
    expect(build.prompt).toContain('# The plan\n\nTabs.')
    expect(build.prompt).not.toContain('- document:')
    await report(engine, build.sessionId, 'done')

    const test = runtime.session('test')
    expect(test.options).toEqual({ model: 'haiku' })
    expect(test.prompt).toContain('`pass` (pass!): ends the task as done')
    expect(test.prompt).toContain('`fail` (fail!): sends the work back to "Build"')
    expect(await report(engine, test.sessionId, 'pass')).toContain('The task is done.')

    const done = engine.get(task.id)
    expect(done.task).toMatchObject({ state: 'done', needsYou: false, arrived: [] })
    expect(done.task.endedAt).not.toBeNull()
    expect(done.runs.map((run) => [run.nodeId, run.state])).toEqual([
      ['plan', 'done'],
      ['build', 'done'],
      ['test', 'done'],
    ])
    expect(runtime.notified).toEqual([[task.id, 'done']])
    expect(runtime.forks).toEqual([])
    expect(runtime.merges).toEqual([])
    expect(store.saved().tasks[0]!.tokens).toEqual([])
  })

  it('follows the outcome that was reported, whichever branch it is', async () => {
    const flow = sop([
      node('review', [to('worth-doing', 'build'), end('not-worth-doing', 'dropped')], {
        handIn: 'verdict',
      }),
      node('build', [end('done')]),
    ])
    const dropped = await setup({ sop: flow })
    const first = await createTask(dropped.engine)
    const next = await report(
      dropped.engine,
      dropped.runtime.session('review').sessionId,
      'not-worth-doing',
    )
    expect(next).toContain('dropped')
    expect(dropped.engine.get(first.id).task.state).toBe('dropped')
    expect(dropped.runtime.opened).toHaveLength(1)
    expect(dropped.runtime.notified).toEqual([[first.id, 'done']])

    const built = await setup({ sop: flow })
    const second = await createTask(built.engine)
    await report(built.engine, built.runtime.session('review').sessionId, 'worth-doing')
    expect(built.runtime.session('build').nodeId).toBe('build')
    expect(built.engine.get(second.id).task.state).toBe('running')
  })

  it('refuses a report that is not whole and keeps the node open', async () => {
    const { engine, runtime } = await setup()
    const task = await createTask(engine)
    const plan = runtime.session('plan').sessionId

    expect(await refused(engine, 'nobody', 'done')).toContain('nothing to report')
    const unknown = await refused(engine, plan, 'skip')
    expect(unknown).toContain('"skip" is not an outcome')
    expect(unknown).toContain('`done` (done!)')
    expect(await refused(engine, plan, 'done', '   ')).toContain('The note is empty')
    expect(await refused(engine, plan, 'done')).toContain('hands in a document')
    const blank = await engine.report(plan, { outcome: 'done', note: 'x', document: '  ' })
    expect(blank.ok).toBe(false)

    expect(lastRun(engine, task.id, 'plan')).toMatchObject({ state: 'running', outcome: null })
    expect(runtime.opened).toHaveLength(1)
    await report(engine, plan, 'done', { document: 'Plan' })
    // Once taken, the session has nothing more to report.
    expect(await refused(engine, plan, 'done')).toContain('nothing to report')
    expect(runsOf(engine, task.id, 'build')).toHaveLength(1)
  })

  it('takes a report that arrives before the engine has heard of the session', async () => {
    const runtime = new FakeRuntime()
    const { engine } = await setup({ runtime })
    let early: ReturnType<TaskEngine['report']> | null = null
    runtime.onOpen = (sessionId) => {
      runtime.onOpen = null
      early = engine.report(sessionId, { outcome: 'done', note: 'Quick.', document: 'Plan' })
    }
    const task = await createTask(engine)
    expect(await early).toMatchObject({ ok: true })
    await engine.idle()
    expect(lastRun(engine, task.id, 'plan')).toMatchObject({ state: 'done', sessionId: 's1' })
    expect(runtime.session('build').sessionId).toBe('s2')
  })

  it('rejects a draft it cannot start and stores nothing', async () => {
    const { engine, runtime, store } = await setup()
    const draft = { projectPath: PROJECT, sop: { source: 'official' as const, id: 'test' } }
    await expect(engine.create({ ...draft, requirement: '  ' }, 'user')).rejects.toThrow('empty')
    await expect(
      engine.create({ ...draft, requirement: 'x', projectPath: 'relative' }, 'user'),
    ).rejects.toThrow('absolute')
    runtime.failWorktree = new Error('no default branch')
    await expect(engine.create({ ...draft, requirement: 'x' }, 'user')).rejects.toThrow(
      'no default branch',
    )
    expect(engine.list()).toEqual([])
    expect(store.saved().tasks).toEqual([])
  })
})

describe('parallel work', () => {
  it('gives each branch its own worktree and joins them where they meet', async () => {
    const { engine, runtime, store } = await setup({ sop: parallel() })
    const task = await createTask(engine)
    const own = task.worktree!.path
    const design = runtime.session('design')
    expect(design.prompt).toContain('commit all your changes before you report `done`')

    runtime.dirty.add(own)
    expect(await refused(engine, design.sessionId, 'done')).toContain('Commit your changes first')
    expect(runtime.forks).toEqual([])
    runtime.dirty.delete(own)
    expect(await report(engine, design.sessionId, 'done')).toContain(
      '"Build" and "Tests" start at once.',
    )

    expect(runtime.forks.map((f) => [f.from, f.label])).toEqual([
      [own, 'build'],
      [own, 'tests'],
    ])
    const build = runtime.session('build')
    const tests = runtime.session('tests')
    const laneA = runtime.lane('build').path
    const laneB = runtime.lane('tests').path
    expect(build.worktree?.path).toBe(laneA)
    expect(tests.worktree?.path).toBe(laneB)
    expect(build.prompt).toContain('works in a branch of its own')
    expect(lastRun(engine, task.id, 'build').worktree?.path).toBe(laneA)

    // A branch's work is merged from its last commit, so it must be committed.
    runtime.dirty.add(laneA)
    expect(await refused(engine, build.sessionId, 'done')).toContain('branch of its own')
    runtime.dirty.delete(laneA)
    await report(engine, build.sessionId, 'done')

    // The join waits for the other branch.
    expect(engine.get(task.id).task).toMatchObject({ state: 'running', arrived: ['verify'] })
    expect(runsOf(engine, task.id, 'verify')).toEqual([])
    expect(runtime.merges).toEqual([])

    await report(engine, tests.sessionId, 'done')
    expect(engine.get(task.id).task.arrived).toEqual([])
    expect(runtime.merges).toEqual([
      { into: own, from: laneA, leave: true },
      { into: own, from: laneB, leave: true },
    ])
    const verify = runtime.session('verify')
    expect(verify.worktree?.path).toBe(own)
    expect(verify.prompt).not.toContain('Branches to merge')
    expect(verify.prompt).toContain('### Build: done!')
    expect(verify.prompt).toContain('### Tests: done!')
    expect(store.saved().tasks[0]!.spent.map((s) => [s.worktree.path, s.merged])).toEqual([
      [laneA, true],
      [laneB, true],
    ])
    expect(runtime.removed).toEqual([])

    // In the task's own worktree again, the end needs no commit.
    runtime.dirty.add(own)
    await report(engine, verify.sessionId, 'pass')
    expect(engine.get(task.id).task.state).toBe('done')
    expect(runtime.removed).toEqual([
      { path: laneA, merged: true },
      { path: laneB, merged: true },
    ])
    expect(store.saved().tasks[0]!.spent).toEqual([])
  })

  it('hands the branches that conflict to the joining node, which reports once they are in', async () => {
    const flow = sop([
      node('design', [to('done', 'api', 'web', 'docs')]),
      node('api', [to('done', 'verify')]),
      node('web', [to('done', 'verify')]),
      node('docs', [to('done', 'verify')]),
      node('verify', [end('pass')]),
    ])
    const { engine, runtime, store } = await setup({ sop: flow })
    const task = await createTask(engine)
    const own = task.worktree!.path
    await report(engine, runtime.session('design').sessionId, 'done')
    const [api, web, docs] = ['api', 'web', 'docs'].map((id) => runtime.lane(id))
    runtime.conflicts.add(web!.path)
    for (const id of ['api', 'web', 'docs']) {
      await report(engine, runtime.session(id).sessionId, 'done')
    }

    // The merges stop at the first conflict; that branch and the rest are the agent's.
    expect(runtime.merges.map((m) => m.from)).toEqual([api!.path, web!.path])
    const run = store.saved().runs.find((r) => r.nodeId === 'verify')!
    expect(run.toMerge.map((lane) => lane.path)).toEqual([web!.path, docs!.path])
    const verify = runtime.session('verify')
    expect(verify.prompt).toContain('## Branches to merge')
    expect(verify.prompt).toContain(`\`${web!.branch}\``)
    expect(verify.prompt).toContain(`\`${docs!.branch}\``)
    expect(verify.prompt).not.toContain(`\`${api!.branch}\``)

    expect(await refused(engine, verify.sessionId, 'pass')).toContain(
      `\`${web!.branch}\` is not merged`,
    )
    runtime.gone.add(web!.path)
    const unchecked = await refused(engine, verify.sessionId, 'pass')
    expect(unchecked).toContain(`could not check the branch \`${web!.branch}\``)
    expect(unchecked).toContain(`no branch ${web!.branch}`)
    runtime.gone.delete(web!.path)
    runtime.resolve(own, web!.path)
    expect(await refused(engine, verify.sessionId, 'pass')).toContain(
      `\`${docs!.branch}\` is not merged`,
    )
    runtime.resolve(own, docs!.path)
    runtime.dirty.add(own)
    expect(await refused(engine, verify.sessionId, 'pass')).toContain('merge is not finished')
    runtime.dirty.delete(own)
    expect(lastRun(engine, task.id, 'verify').state).toBe('running')

    await report(engine, verify.sessionId, 'pass')
    expect(engine.get(task.id).task.state).toBe('done')
    expect(runtime.removed.map((r) => [r.path, r.merged])).toEqual([
      [api!.path, true],
      [web!.path, true],
      [docs!.path, true],
    ])
  })

  it('never holds a join back for a branch that took another way', async () => {
    const flow = sop([
      node('start', [to('done', 'a', 'b')]),
      node('a', [to('done', 'join')]),
      node('b', [to('join', 'join'), to('aside', 'side')]),
      node('join', [to('done', 'final')]),
      node('side', [to('done', 'final')]),
      node('final', [end('done')]),
    ])
    const { engine, runtime } = await setup({ sop: flow })
    const task = await createTask(engine)
    const own = task.worktree!.path
    await report(engine, runtime.session('start').sessionId, 'done')
    const laneA = runtime.lane('a').path
    const laneB = runtime.lane('b').path

    await report(engine, runtime.session('a').sessionId, 'done')
    expect(engine.get(task.id).task.arrived).toEqual(['join'])

    // B can no longer reach the join, so it starts with A alone, in A's worktree.
    await report(engine, runtime.session('b').sessionId, 'aside')
    expect(engine.get(task.id).task.arrived).toEqual([])
    expect(runtime.session('join').worktree?.path).toBe(laneA)
    expect(runtime.session('side').worktree?.path).toBe(laneB)
    expect(runtime.merges).toEqual([])

    await report(engine, runtime.session('join').sessionId, 'done')
    expect(engine.get(task.id).task.arrived).toEqual(['final'])
    await report(engine, runtime.session('side').sessionId, 'done')
    expect(runtime.merges.map((m) => [m.into, m.from])).toEqual([
      [own, laneA],
      [own, laneB],
    ])
    expect(runtime.session('final').worktree?.path).toBe(own)
  })

  it('splits and joins in a project without git, with no worktrees or merges', async () => {
    const runtime = new FakeRuntime()
    runtime.git = false
    const { engine } = await setup({ runtime, sop: parallel() })
    const task = await createTask(engine)
    expect(task.worktree).toBeNull()
    runtime.dirty.add(PROJECT)
    const design = runtime.session('design')
    expect(design.worktree).toBeNull()
    expect(design.prompt).not.toContain('commit')
    await report(engine, design.sessionId, 'done')
    expect(runtime.session('build').worktree).toBeNull()
    await report(engine, runtime.session('build').sessionId, 'done')
    expect(engine.get(task.id).task.arrived).toEqual(['verify'])
    await report(engine, runtime.session('tests').sessionId, 'done')
    expect(lastRun(engine, task.id, 'verify')).toMatchObject({ state: 'running', worktree: null })
    await report(engine, runtime.session('verify').sessionId, 'pass')
    expect(engine.get(task.id).task.state).toBe('done')
    expect(runtime.forks).toEqual([])
    expect(runtime.merges).toEqual([])
    expect(runtime.removed).toEqual([])
  })

  it("merges a branch that ends the task into the task's own worktree", async () => {
    const flow = sop([
      node('start', [to('done', 'a', 'b')]),
      node('a', [end('done')]),
      node('b', [end('done')]),
    ])
    const { engine, runtime } = await setup({ sop: flow })
    const task = await createTask(engine)
    const own = task.worktree!.path
    await report(engine, runtime.session('start').sessionId, 'done')
    const laneA = runtime.lane('a').path
    const laneB = runtime.lane('b').path
    const a = runtime.session('a')
    const b = runtime.session('b')
    // A branch that was deleted by hand does not stop the cleanup.
    runtime.gone.add(laneB)

    await report(engine, a.sessionId, 'done')
    expect(runtime.merges).toEqual([{ into: own, from: laneA, leave: false }])
    const ended = engine.get(task.id)
    expect(ended.task.state).toBe('done')
    // The other branch is stopped and its worktree goes, its branch kept.
    expect(lastRun(engine, task.id, 'b')).toMatchObject({
      state: 'stopped',
      reason: 'The task ended',
    })
    expect(runtime.stopped).toEqual([b.sessionId])
    expect(runtime.removed).toEqual([
      { path: laneA, merged: true },
      { path: laneB, merged: false },
    ])
    expect(await refused(engine, b.sessionId, 'done')).toContain('nothing to report')
  })

  it('keeps the task open when the ending branch conflicts, until a retry merges it', async () => {
    const flow = sop([
      node('start', [to('done', 'a', 'b')]),
      node('a', [end('done')]),
      node('b', [end('done')]),
    ])
    const { engine, runtime } = await setup({ sop: flow })
    const task = await createTask(engine)
    const own = task.worktree!.path
    await report(engine, runtime.session('start').sessionId, 'done')
    const laneA = runtime.lane('a')
    runtime.conflicts.add(laneA.path)
    const a = runtime.session('a')

    const next = await report(engine, a.sessionId, 'done')
    expect(next).toContain('the person decides')
    const stuck = lastRun(engine, task.id, 'a')
    expect(stuck).toMatchObject({ state: 'waiting', waiting: 'stuck', outcome: 'done' })
    expect(stuck.reason).toContain(laneA.branch)
    expect(engine.get(task.id).task).toMatchObject({ state: 'running', needsYou: true })
    expect(lastRun(engine, task.id, 'b').state).toBe('running')
    expect(runtime.notified).toEqual([[task.id, 'needs-you']])
    expect(runtime.merging.has(own)).toBe(false)

    await engine.retry({ taskId: task.id, runId: stuck.id })
    await engine.idle()
    expect(lastRun(engine, task.id, 'a').waiting).toBe('stuck')

    runtime.conflicts.delete(laneA.path)
    const view = await engine.retry({ taskId: task.id, runId: stuck.id })
    expect(view.state).toBe('done')
    expect(lastRun(engine, task.id, 'a')).toMatchObject({ state: 'done', reason: null })
    expect(lastRun(engine, task.id, 'b').state).toBe('stopped')
  })

  it('leaves a run stuck when a worktree or a merge fails, and a retry goes on', async () => {
    const { engine, runtime, store } = await setup({ sop: parallel() })
    const task = await createTask(engine)
    const design = runtime.session('design')
    runtime.failFork = new Error('disk full')
    expect(await report(engine, design.sessionId, 'done')).toContain('The person decides')
    const stuck = lastRun(engine, task.id, 'design')
    expect(stuck).toMatchObject({ waiting: 'stuck', outcome: 'done' })
    expect(stuck.reason).toContain('disk full')
    expect(store.saved().tasks[0]!.tokens.map((token) => token.nodeId)).toEqual(['design'])

    runtime.failFork = null
    await engine.retry({ taskId: task.id, runId: stuck.id })
    await engine.idle()
    expect(lastRun(engine, task.id, 'design').state).toBe('done')
    await report(engine, runtime.session('build').sessionId, 'done')

    runtime.failMerge = new Error('index locked')
    await report(engine, runtime.session('tests').sessionId, 'done')
    const verify = lastRun(engine, task.id, 'verify')
    expect(verify).toMatchObject({ waiting: 'stuck', sessionId: null })
    expect(verify.reason).toContain('index locked')

    runtime.failMerge = null
    await engine.retry({ taskId: task.id, runId: verify.id })
    await engine.idle()
    expect(lastRun(engine, task.id, 'verify')).toMatchObject({ state: 'running', round: 1 })
    expect(runtime.session('verify').runId).toBe(verify.id)
    expect(runtime.merges).toHaveLength(2)
  })
})

describe('arrows back', () => {
  it('counts the rounds of an arrow back and leaves the next one to the person', async () => {
    const { engine, runtime, store } = await setup({ sop: linear(2) })
    const task = await createTask(engine)
    await report(engine, runtime.session('plan').sessionId, 'done', { document: 'Plan' })
    const build = runtime.session('build').sessionId
    await report(engine, build, 'done')
    const test = runtime.session('test').sessionId

    for (const round of [1, 2]) {
      const next = await report(engine, test, 'fail', { note: `Broken ${round}` })
      expect(next).toContain('The task goes back to "Build".')
      expect(lastRun(engine, task.id, 'build')).toMatchObject({
        round: round + 1,
        sentBack: { from: 'test', note: `Broken ${round}` },
      })
      await report(engine, build, 'done')
    }
    expect(store.saved().tasks[0]!.rounds).toEqual({ 'test/fail': 2 })

    const next = await report(engine, test, 'fail', { note: 'Broken 3' })
    expect(next).toContain('the person decides whether it goes back again')
    const stuck = lastRun(engine, task.id, 'test')
    expect(stuck).toMatchObject({ state: 'waiting', waiting: 'stuck', outcome: 'fail', round: 3 })
    expect(stuck.reason).toContain('2 times')
    expect(engine.get(task.id).task).toMatchObject({ state: 'waiting', needsYou: true })
    expect(runtime.notified).toEqual([[task.id, 'needs-you']])
    expect(runsOf(engine, task.id, 'build')).toHaveLength(3)
    expect(engine.nodeOf(test)).toBeNull()
    expect(await refused(engine, test, 'pass')).toContain('nothing to report')

    // The person lets it go back once more.
    await engine.retry({ taskId: task.id, runId: stuck.id, note: 'Last time.' })
    await engine.idle()
    expect(lastRun(engine, task.id, 'test').state).toBe('done')
    expect(lastRun(engine, task.id, 'build')).toMatchObject({ round: 4, state: 'running' })
    expect(lastRun(engine, task.id, 'build').sentBack?.note).toBe(
      'Broken 3\n\nFrom the person: Last time.',
    )
    expect(store.saved().tasks[0]!.rounds).toEqual({ 'test/fail': 3 })
    expect(engine.get(task.id).task.needsYou).toBe(false)

    await report(engine, build, 'done')
    await report(engine, test, 'fail')
    expect(lastRun(engine, task.id, 'test').waiting).toBe('stuck')
  })

  it("takes an outcome's own limit before the SOP's", async () => {
    const flow = linear(5)
    flow.nodes[2]!.outcomes[1]!.rounds = 1
    const { engine, runtime } = await setup({ sop: flow })
    const task = await createTask(engine)
    await report(engine, runtime.session('plan').sessionId, 'done', { document: 'Plan' })
    await report(engine, runtime.session('build').sessionId, 'done')
    const test = runtime.session('test').sessionId
    await report(engine, test, 'fail')
    await report(engine, runtime.session('build').sessionId, 'done')
    await report(engine, test, 'fail')
    expect(lastRun(engine, task.id, 'test').waiting).toBe('stuck')
  })

  it('goes back to the session of the earlier round when it is alive in the same worktree', async () => {
    const { engine, runtime } = await setup()
    const task = await createTask(engine)
    await report(engine, runtime.session('plan').sessionId, 'done', { document: 'Plan' })
    const build = runtime.session('build').sessionId
    await report(engine, build, 'done')
    const test = runtime.session('test').sessionId
    await endTurn(engine, runtime, build)

    await report(engine, test, 'fail', { note: 'The toggle does nothing.' })
    expect(runtime.opened).toHaveLength(3)
    const back = runtime.sessions.get(build)!.sent
    expect(back).toHaveLength(1)
    expect(back[0]).toContain('came back to the "Build" node (round 2)')
    expect(back[0]).toContain('"Test" sent the work back')
    expect(back[0]).toContain('The toggle does nothing.')
    expect(back[0]).toContain('report_sop_node')
    expect(back[0]).not.toContain('## Requirement')
    expect(lastRun(engine, task.id, 'build')).toMatchObject({
      round: 2,
      sessionId: build,
      agentId: 'claude-code',
      state: 'running',
    })
    await endTurn(engine, runtime, test)

    // The test's own session hears what the build handed over.
    await report(engine, build, 'done', { note: 'Wired the toggle.' })
    const again = runtime.sessions.get(test)!.sent
    expect(again).toHaveLength(1)
    expect(again[0]).toContain('reached the "Test" node again (round 2)')
    expect(again[0]).toContain('Wired the toggle.')

    // A session that is gone is replaced by a new one, told everything.
    runtime.sessions.get(build)!.alive = false
    await report(engine, test, 'fail', { note: 'Still broken.' })
    expect(runtime.opened).toHaveLength(4)
    const fresh = runtime.session('build')
    expect(fresh.sessionId).not.toBe(build)
    expect(fresh.prompt).toContain('(round 3)')
    expect(fresh.prompt).toContain('## Sent back')
    expect(fresh.prompt).toContain('Still broken.')
    expect(fresh.prompt).toContain('## Requirement')
  })

  it('does not take the end of the turn that reported for the next round of the same session', async () => {
    const flow = sop([node('polish', [to('again', 'polish'), end('done')])], 5)
    const { engine, runtime } = await setup({ sop: flow })
    const task = await createTask(engine)
    const session = runtime.session('polish').sessionId
    await report(engine, session, 'again')
    expect(runtime.sessions.get(session)!.sent).toHaveLength(1)
    expect(lastRun(engine, task.id, 'polish')).toMatchObject({ round: 2, sessionId: session })

    // The turn that reported ends: the new round has not had its turn yet.
    await endTurn(engine, runtime, session)
    expect(runtime.sessions.get(session)!.sent).toHaveLength(1)
    runtime.sessions.get(session)!.working = true
    await endTurn(engine, runtime, session)
    expect(runtime.sessions.get(session)!.sent).toHaveLength(2)
    expect(runtime.sessions.get(session)!.sent[1]).toContain('ended without a report')
  })

  it('gives up the work after the node it goes back to', async () => {
    const { engine, runtime, store } = await setup({ sop: parallel() })
    const task = await createTask(engine)
    const own = task.worktree!.path
    const design = runtime.session('design').sessionId
    await report(engine, design, 'done')
    const laneA = runtime.lane('build').path
    const laneB = runtime.lane('tests').path
    const tests = runtime.session('tests')

    const next = await report(engine, runtime.session('build').sessionId, 'redesign')
    expect(next).toContain('The task goes back to "Design".')
    expect(lastRun(engine, task.id, 'tests')).toMatchObject({
      state: 'stopped',
      reason: 'The work went back to "Design"',
    })
    expect(runtime.stopped).toEqual([tests.sessionId])
    expect(store.saved().tasks[0]!.spent).toEqual([
      { worktree: expect.objectContaining({ path: laneB }), merged: false },
    ])
    expect(await refused(engine, tests.sessionId, 'done')).toContain('nothing to report')

    // The design is done again where the build was, in a new session for that worktree.
    const redesign = runtime.session('design')
    expect(redesign.sessionId).not.toBe(design)
    expect(redesign.worktree?.path).toBe(laneA)
    expect(lastRun(engine, task.id, 'design')).toMatchObject({
      round: 2,
      sentBack: { from: 'build', note: 'redesign note' },
    })
    expect(store.saved().tasks[0]!.tokens.map((token) => token.nodeId)).toEqual(['design'])

    await report(engine, redesign.sessionId, 'done')
    expect(runtime.forks.slice(2).map((f) => f.from)).toEqual([laneA, laneA])
    const laneA1 = runtime.lane('build').path
    const laneA2 = runtime.lane('tests').path
    await report(engine, runtime.session('build').sessionId, 'done')
    await report(engine, runtime.session('tests').sessionId, 'done')
    const verify = runtime.session('verify')
    expect(verify.worktree?.path).toBe(laneA)
    expect(runtime.merges).toEqual([
      { into: laneA, from: laneA1, leave: true },
      { into: laneA, from: laneA2, leave: true },
    ])

    // Verify works in a branch, which the end merges into the task's own worktree.
    await report(engine, verify.sessionId, 'pass')
    expect(runtime.merges.at(-1)).toEqual({ into: own, from: laneA, leave: false })
    expect(engine.get(task.id).task.state).toBe('done')
    expect(runtime.removed).toEqual([
      { path: laneB, merged: false },
      { path: laneA1, merged: true },
      { path: laneA2, merged: true },
      { path: laneA, merged: true },
    ])
  })

  it('counts an outcome with several targets once and splits whatever their direction', async () => {
    const flow = sop([
      node('plan', [to('done', 'front', 'back')]),
      node('front', [to('done', 'check')]),
      node('back', [to('done', 'check')]),
      node('check', [end('pass'), to('fail', 'front', 'back')], { handIn: 'verdict' }),
    ])
    const { engine, runtime, store } = await setup({ sop: flow })
    const task = await createTask(engine)
    const own = task.worktree!.path
    await report(engine, runtime.session('plan').sessionId, 'done')
    await report(engine, runtime.session('front').sessionId, 'done')
    await report(engine, runtime.session('back').sessionId, 'done')
    const check = runtime.session('check').sessionId
    expect(await report(engine, check, 'fail')).toContain('"Front" and "Back" start at once.')

    expect(store.saved().tasks[0]!.rounds).toEqual({ 'check/fail': 1 })
    expect(runtime.forks.slice(2).map((f) => [f.from, f.label])).toEqual([
      [own, 'front'],
      [own, 'back'],
    ])
    for (const id of ['front', 'back']) {
      expect(lastRun(engine, task.id, id)).toMatchObject({
        round: 2,
        state: 'running',
        sentBack: { from: 'check', note: 'fail note' },
      })
    }
    await report(engine, runtime.session('front').sessionId, 'done')
    expect(engine.get(task.id).task.arrived).toEqual(['check'])
    await report(engine, runtime.session('back').sessionId, 'done')
    expect(lastRun(engine, task.id, 'check')).toMatchObject({ round: 2, sessionId: check })
  })
})

describe("the person's part", () => {
  const accepted = (): Sop =>
    sop([
      node('build', [to('done', 'accept')]),
      node('accept', [end('ok'), to('redo', 'build')], { person: true }),
    ])

  it('waits at a node of the person for their decision', async () => {
    const { engine, runtime } = await setup({ sop: accepted(), max: 1 })
    const task = await createTask(engine)
    const build = runtime.session('build').sessionId
    expect(await report(engine, build, 'done')).toContain('The task goes on to "Accept".')

    const accept = lastRun(engine, task.id, 'accept')
    expect(accept).toMatchObject({
      by: 'person',
      state: 'waiting',
      waiting: 'person',
      sessionId: null,
      tier: null,
    })
    expect(engine.get(task.id).task).toMatchObject({ state: 'waiting', needsYou: true })
    expect(runtime.notified).toEqual([[task.id, 'needs-you']])
    expect(runtime.opened).toHaveLength(1)

    const decision = { taskId: task.id, runId: accept.id }
    await expect(engine.decide({ ...decision, outcome: 'maybe' })).rejects.toThrow('no outcome')
    await expect(
      engine.decide({
        taskId: task.id,
        runId: lastRun(engine, task.id, 'build').id,
        outcome: 'ok',
      }),
    ).rejects.toThrow('not waiting for a decision')
    await expect(engine.retry(decision)).rejects.toThrow('not stuck')

    const back = await engine.decide({ ...decision, outcome: 'redo', note: 'Use tabs.' })
    await engine.idle()
    expect(back).toMatchObject({ state: 'running', needsYou: false })
    expect(lastRun(engine, task.id, 'accept')).toMatchObject({
      state: 'done',
      outcome: 'redo',
      note: 'Use tabs.',
    })
    expect(lastRun(engine, task.id, 'build').sentBack).toEqual({
      from: 'accept',
      note: 'Use tabs.',
    })
    expect(runtime.sessions.get(build)!.sent[0]).toContain('Use tabs.')

    await report(engine, build, 'done')
    const again = lastRun(engine, task.id, 'accept')
    expect(again.round).toBe(2)
    expect(runtime.notified).toHaveLength(2)
    const done = await engine.decide({ taskId: task.id, runId: again.id, outcome: 'ok' })
    expect(done.state).toBe('done')
    expect(runtime.notified.at(-1)).toEqual([task.id, 'done'])
    await expect(engine.decide({ ...decision, outcome: 'ok' })).rejects.toThrow()
  })

  it('asks for a commit before the person starts several nodes at once', async () => {
    const flow = sop([
      node('design', [to('done', 'approve')]),
      node('approve', [to('go', 'a', 'b')], { person: true }),
      node('a', [end('done')]),
      node('b', [end('done')]),
    ])
    const { engine, runtime } = await setup({ sop: flow })
    const task = await createTask(engine)
    // One arrow in the task's own worktree needs no commit, so the design may leave changes.
    runtime.dirty.add(task.worktree!.path)
    await report(engine, runtime.session('design').sessionId, 'done')
    const decision = {
      taskId: task.id,
      runId: lastRun(engine, task.id, 'approve').id,
      outcome: 'go',
    }
    await expect(engine.decide(decision)).rejects.toThrow('Commit the changes')
    expect(lastRun(engine, task.id, 'approve')).toMatchObject({ waiting: 'person', outcome: null })
    runtime.dirty.clear()
    await engine.decide(decision)
    await engine.idle()
    expect(runtime.forks.map((f) => f.label)).toEqual(['a', 'b'])
    expect(lastRun(engine, task.id, 'a').state).toBe('running')
  })

  it('reminds an agent once when its turn ends without a report, then leaves it to the person', async () => {
    const { engine, runtime } = await setup()
    const task = await createTask(engine)
    const plan = runtime.session('plan').sessionId

    await endTurn(engine, runtime, plan)
    const sent = runtime.sessions.get(plan)!.sent
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('ended without a report')
    expect(sent[0]).toContain('report_sop_node')
    expect(lastRun(engine, task.id, 'plan').state).toBe('running')
    expect(engine.get(task.id).task.needsYou).toBe(false)

    await endTurn(engine, runtime, plan)
    expect(sent).toHaveLength(1)
    const stuck = lastRun(engine, task.id, 'plan')
    expect(stuck).toMatchObject({ state: 'waiting', waiting: 'stuck', outcome: null })
    expect(stuck.reason).toContain('stopped twice without reporting')
    expect(engine.get(task.id).task).toMatchObject({ state: 'waiting', needsYou: true })
    expect(runtime.notified).toEqual([[task.id, 'needs-you']])
    // A later turn of the stuck session changes nothing.
    await endTurn(engine, runtime, plan)
    expect(sent).toHaveLength(1)

    // The person lets it go on, in its own session.
    await engine.retry({ taskId: task.id, runId: stuck.id, note: 'Keep it short.' })
    await engine.idle()
    expect(sent).toHaveLength(2)
    expect(sent[1]).toContain('The person asks you to go on')
    expect(sent[1]).toContain('Keep it short.')
    expect(lastRun(engine, task.id, 'plan')).toMatchObject({
      id: stuck.id,
      state: 'running',
      reason: null,
    })
    expect(runtime.opened).toHaveLength(1)

    // It is reminded once more before it is stuck again, and a late report is still taken.
    await endTurn(engine, runtime, plan)
    expect(sent).toHaveLength(3)
    await endTurn(engine, runtime, plan)
    expect(lastRun(engine, task.id, 'plan').waiting).toBe('stuck')
    expect(engine.nodeOf(plan)).not.toBeNull()
    await report(engine, plan, 'done', { document: 'Plan' })
    expect(lastRun(engine, task.id, 'plan')).toMatchObject({ state: 'done', reason: null })
    expect(runtime.session('build').nodeId).toBe('build')
  })

  it('shows a request that waits in a node session, and when it is answered', async () => {
    const { engine, runtime } = await setup({ max: 1 })
    const task = await createTask(engine)
    const second = await createTask(engine, 'Another')
    const plan = runtime.session('plan').sessionId

    engine.waiting(plan, true)
    expect(lastRun(engine, task.id, 'plan')).toMatchObject({ state: 'waiting', waiting: 'request' })
    expect(engine.get(task.id).task).toMatchObject({ state: 'waiting', needsYou: true })
    expect(runtime.notified).toEqual([[task.id, 'needs-you']])
    expect(engine.nodeOf(plan)).not.toBeNull()
    // The session still holds its slot, whatever else asks for one.
    const third = await createTask(engine, 'A third')
    expect(lastRun(engine, second.id, 'plan').state).toBe('queued')
    expect(lastRun(engine, third.id, 'plan').state).toBe('queued')

    engine.waiting(plan, true)
    engine.waiting(plan, false)
    expect(lastRun(engine, task.id, 'plan')).toMatchObject({ state: 'running', waiting: null })
    expect(engine.get(task.id).task).toMatchObject({ state: 'running', needsYou: false })
    engine.waiting(plan, false)
    engine.waiting('nobody', true)
    expect(runtime.notified).toHaveLength(1)
  })

  it('leaves a node whose session is gone to the person, and a retry opens a new one', async () => {
    const { engine, runtime } = await setup()
    const task = await createTask(engine)
    const plan = runtime.session('plan').sessionId
    runtime.sessions.get(plan)!.alive = false
    engine.sessionGone(plan)
    await engine.idle()
    const stuck = lastRun(engine, task.id, 'plan')
    expect(stuck).toMatchObject({ waiting: 'stuck', reason: 'The session of "Plan" was closed.' })

    await engine.retry({ taskId: task.id, runId: stuck.id, note: 'Go on.' })
    await engine.idle()
    const fresh = runtime.session('plan')
    expect(fresh.sessionId).not.toBe(plan)
    expect(fresh.runId).toBe(stuck.id)
    expect(fresh.prompt).toContain('## From the person\n\nGo on.')
    expect(lastRun(engine, task.id, 'plan')).toMatchObject({
      state: 'running',
      sessionId: fresh.sessionId,
    })
  })

  it('cancels a task: everything stops and the worktrees stay', async () => {
    const { engine, runtime, store } = await setup({ sop: parallel(), max: 2 })
    const task = await createTask(engine)
    await report(engine, runtime.session('design').sessionId, 'done')
    const build = runtime.session('build').sessionId
    const tests = runtime.session('tests').sessionId
    const other = await createTask(engine, 'Another')
    expect(lastRun(engine, other.id, 'design').state).toBe('queued')

    const cancelled = await engine.cancel(task.id)
    await engine.idle()
    expect(cancelled).toMatchObject({ state: 'cancelled', needsYou: false, arrived: [] })
    expect(cancelled.endedAt).not.toBeNull()
    expect(engine.get(task.id).runs.map((run) => [run.nodeId, run.state, run.reason])).toEqual([
      ['design', 'done', null],
      ['build', 'stopped', 'Cancelled'],
      ['tests', 'stopped', 'Cancelled'],
    ])
    expect(runtime.stopped.sort()).toEqual([build, tests].sort())
    expect(runtime.removed).toEqual([])
    expect(store.saved().tasks[0]!.tokens).toEqual([])
    expect(runtime.notified).toEqual([])
    expect(await refused(engine, build, 'done')).toContain('nothing to report')
    expect(engine.nodeOf(build)).toBeNull()
    // The slots it held go to the task that waited.
    expect(lastRun(engine, other.id, 'design').state).toBe('running')
    expect((await engine.cancel(task.id)).state).toBe('cancelled')
  })

  it('removes only a task that ended', async () => {
    const { engine, runtime, store, events } = await setup()
    const task = await createTask(engine)
    const plan = runtime.session('plan')
    await expect(engine.remove(task.id)).rejects.toThrow('ended')
    await engine.cancel(task.id)
    await engine.remove(task.id)
    expect(events.removed).toEqual([task.id])
    expect(engine.list()).toEqual([])
    expect(store.saved()).toMatchObject({ tasks: [], runs: [] })
    expect(engine.document(plan.runId)).toBeNull()
    expect(() => engine.get(task.id)).toThrow()
    await expect(engine.remove(task.id)).rejects.toThrow()
  })

  it('waits for the person to settle branches that do not merge at their own node', async () => {
    const flow = sop([
      node('start', [to('done', 'a', 'b')]),
      node('a', [to('done', 'accept')]),
      node('b', [to('done', 'accept')]),
      node('accept', [end('ok')], { person: true }),
    ])
    const { engine, runtime } = await setup({ sop: flow })
    const task = await createTask(engine)
    const own = task.worktree!.path
    await report(engine, runtime.session('start').sessionId, 'done')
    const laneB = runtime.lane('b')
    runtime.conflicts.add(laneB.path)
    await report(engine, runtime.session('a').sessionId, 'done')
    await report(engine, runtime.session('b').sessionId, 'done')

    const accept = lastRun(engine, task.id, 'accept')
    expect(accept).toMatchObject({ by: 'person', waiting: 'stuck' })
    expect(accept.reason).toContain(laneB.branch)
    const decision = { taskId: task.id, runId: accept.id, outcome: 'ok' }
    await expect(engine.decide(decision)).rejects.toThrow('not waiting for a decision')

    runtime.resolve(own, laneB.path)
    await engine.retry({ taskId: task.id, runId: accept.id })
    expect(lastRun(engine, task.id, 'accept')).toMatchObject({ waiting: 'person', reason: null })
    expect((await engine.decide(decision)).state).toBe('done')
  })
})

describe('agents and slots', () => {
  it('works at most so many node sessions at once, the oldest first', async () => {
    const { engine, runtime } = await setup({ max: 1 })
    const first = await createTask(engine, 'First')
    const second = await createTask(engine, 'Second')
    expect(runtime.opened).toHaveLength(1)
    expect(lastRun(engine, second.id, 'plan')).toMatchObject({ state: 'queued', sessionId: null })
    expect(engine.get(second.id).task).toMatchObject({ state: 'running', needsYou: false })

    await report(engine, runtime.session('plan').sessionId, 'done', { document: 'Plan' })
    // The second task's plan was queued before the first task's build.
    expect(runtime.opened.map((o) => [o.title, o.nodeId])).toEqual([
      ['First · Plan', 'plan'],
      ['Second · Plan', 'plan'],
    ])
    expect(lastRun(engine, first.id, 'build').state).toBe('queued')
    expect(lastRun(engine, second.id, 'plan').state).toBe('running')

    // A stuck run frees its slot.
    await endTurn(engine, runtime, runtime.session('plan').sessionId)
    await endTurn(engine, runtime, runtime.session('plan').sessionId)
    expect(lastRun(engine, second.id, 'plan').waiting).toBe('stuck')
    expect(lastRun(engine, first.id, 'build').state).toBe('running')
  })

  it("takes the user's agent for a tier, or the host's pick when none is set", async () => {
    const { engine, runtime } = await setup()
    expect(engine.tiers()).toEqual({
      settings: { deep: null, standard: null, fast: null },
      agents: {
        deep: { agentId: 'claude-code', model: 'opus' },
        standard: { agentId: 'claude-code', model: null },
        fast: { agentId: 'claude-code', model: 'haiku' },
      },
    })
    expect(() => engine.setTiers({ deep: 'x' } as never)).toThrow()

    const state = engine.setTiers({
      deep: null,
      standard: { agentId: 'codex', options: [{ id: 'model', value: 'gpt-x' }] },
      fast: { agentId: 'claude-code~work', options: [] },
    })
    expect(state.agents).toEqual({
      deep: { agentId: 'claude-code', model: 'opus' },
      standard: { agentId: 'codex', model: 'gpt-x' },
      // A chosen agent that is not installed is not replaced.
      fast: null,
    })

    const task = await createTask(engine)
    await report(engine, runtime.session('plan').sessionId, 'done', { document: 'Plan' })
    const build = runtime.session('build')
    expect(build.agentId).toBe('codex')
    expect(build.options).toEqual({ model: 'gpt-x' })
    expect(lastRun(engine, task.id, 'build')).toMatchObject({ agentId: 'codex', tier: 'standard' })

    await report(engine, build.sessionId, 'done')
    const test = lastRun(engine, task.id, 'test')
    expect(test).toMatchObject({ waiting: 'stuck', sessionId: null })
    expect(test.reason).toContain('fast tier')
    expect(runtime.opened).toHaveLength(2)

    engine.setTiers({ deep: null, standard: null, fast: null })
    await engine.retry({ taskId: task.id, runId: test.id })
    await engine.idle()
    expect(runtime.session('test')).toMatchObject({ agentId: 'claude-code', runId: test.id })
  })

  it('picks only an enabled agent that may run nodes, and is stuck without one', async () => {
    const runtime = new FakeRuntime()
    runtime.agentList = [
      { ...agent('claude-code', 'claude-code'), enabled: false },
      { ...agent('opencode', 'opencode'), canRunNodes: false },
      agent('codex', 'codex'),
    ]
    const { engine } = await setup({ runtime })
    const task = await createTask(engine)
    expect(runtime.session('plan')).toMatchObject({
      agentId: 'codex',
      options: { reasoning_effort: 'high' },
    })

    runtime.agentList = runtime.agentList.slice(0, 2)
    expect(engine.tiers().agents.standard).toBeNull()
    await report(engine, runtime.session('plan').sessionId, 'done', { document: 'Plan' })
    const build = lastRun(engine, task.id, 'build')
    expect(build.waiting).toBe('stuck')
    expect(build.reason).toContain('No agent can do "Build"')
    expect(engine.get(task.id).task.needsYou).toBe(true)
  })

  it('leaves a node stuck when its session does not open, and a retry opens it', async () => {
    const runtime = new FakeRuntime()
    runtime.failOpen = new Error('not signed in')
    const { engine } = await setup({ runtime })
    const task = await createTask(engine)
    const stuck = lastRun(engine, task.id, 'plan')
    expect(stuck).toMatchObject({ waiting: 'stuck', sessionId: null })
    expect(stuck.reason).toBe('Could not open the session of "Plan": not signed in')

    runtime.failOpen = null
    await engine.retry({ taskId: task.id, runId: stuck.id })
    await engine.idle()
    expect(lastRun(engine, task.id, 'plan')).toMatchObject({ state: 'running', id: stuck.id })
    expect(runtime.session('plan').runId).toBe(stuck.id)
  })

  it('tells clients of every change and marks a task seen', async () => {
    const { engine, runtime, events } = await setup()
    const task = await createTask(engine)
    expect(events.changed.at(-1)).toMatchObject({ id: task.id, state: 'running' })
    expect(events.runs.at(-1)).toMatchObject({ nodeId: 'plan', state: 'running', sessionId: 's1' })
    await report(engine, runtime.session('plan').sessionId, 'done', { document: 'Plan' })
    expect(events.runs.some((run) => run.nodeId === 'plan' && run.state === 'done')).toBe(true)
    expect(events.runs.at(-1)).toMatchObject({ nodeId: 'build', state: 'running' })

    expect(engine.list()[0]!.lastViewedAt).toBeNull()
    engine.markSeen(task.id)
    expect(engine.list()[0]!.lastViewedAt).not.toBeNull()
    expect(events.changed.at(-1)!.lastViewedAt).not.toBeNull()
    expect(() => engine.markSeen('t-000000000000')).toThrow()
  })
})

describe('after a restart', () => {
  it('carries on from the stored tokens and runs', async () => {
    const before = await setup({ sop: parallel(), max: 2 })
    const task = await createTask(before.engine)
    await report(before.engine, before.runtime.session('design').sessionId, 'done')
    const other = await createTask(before.engine, 'Another')
    const build = before.runtime.session('build').sessionId
    const tests = before.runtime.session('tests').sessionId
    expect(lastRun(before.engine, other.id, 'design').state).toBe('queued')

    // Kettu quit: no session is in a turn, and one of them is gone.
    const runtime = before.runtime
    runtime.sessions.get(build)!.working = false
    runtime.sessions.get(tests)!.alive = false
    const { engine } = await setup({ runtime, store: memoryStore(before.store.saved()), max: 2 })

    expect(runtime.sessions.get(build)!.sent).toHaveLength(1)
    expect(runtime.sessions.get(build)!.sent[0]).toContain('ended without a report')
    expect(lastRun(engine, task.id, 'build')).toMatchObject({ state: 'running', sessionId: build })
    expect(lastRun(engine, task.id, 'tests')).toMatchObject({
      waiting: 'stuck',
      reason: 'The session of "Tests" was closed.',
    })
    expect(runtime.notified).toEqual([[task.id, 'needs-you']])
    // The stuck run freed a slot for the run that was queued.
    expect(lastRun(engine, other.id, 'design').state).toBe('running')
    expect(runtime.session('design').title).toBe('Another · Design')

    await report(engine, build, 'done')
    expect(engine.get(task.id).task.arrived).toEqual(['verify'])
    await engine.retry({ taskId: task.id, runId: lastRun(engine, task.id, 'tests').id })
    await engine.idle()
    await report(engine, runtime.session('tests').sessionId, 'done')
    expect(lastRun(engine, task.id, 'verify').state).toBe('running')
    expect(runtime.merges).toHaveLength(2)
  })

  it('starts again what was cut off between two steps', async () => {
    const before = await setup({ max: 2 })
    const task = await createTask(before.engine)
    const plan = before.runtime.session('plan').sessionId
    const second = await createTask(before.engine, 'Second')
    const third = await createTask(before.engine, 'Third')
    const saved = before.store.saved()

    // The first task's report was taken, but Kettu quit before it moved on.
    const taken = saved.runs.find((run) => run.taskId === task.id)!
    Object.assign(taken, { outcome: 'done', note: 'Planned.', document: 'Plan' })
    // The second task's session was never heard of.
    const opening = saved.runs.find((run) => run.taskId === second.id)!
    Object.assign(opening, { sessionId: null, agentId: null, model: null })
    // The third task's run was waiting for an answer in its session.
    const asking = saved.runs.find((run) => run.taskId === third.id)!
    expect(asking.state).toBe('queued')
    Object.assign(asking, { state: 'waiting', waiting: 'request', sessionId: plan })

    const runtime = before.runtime
    runtime.sessions.get(plan)!.working = false
    const { engine } = await setup({ runtime, store: memoryStore(saved), max: 3 })

    expect(lastRun(engine, task.id, 'plan')).toMatchObject({ state: 'done', outcome: 'done' })
    expect(lastRun(engine, task.id, 'build').state).toBe('running')
    expect(lastRun(engine, second.id, 'plan')).toMatchObject({ state: 'running' })
    expect(lastRun(engine, second.id, 'plan').sessionId).not.toBeNull()
    expect(runtime.opened.filter((o) => o.title === 'Second · Plan')).toHaveLength(2)
    expect(lastRun(engine, third.id, 'plan')).toMatchObject({ state: 'running', waiting: null })
    expect(runtime.sessions.get(plan)!.sent.at(-1)).toContain('ended without a report')
  })

  it('heals tokens and runs that lost each other, and clears the worktrees of an ended task', async () => {
    const before = await setup({ sop: parallel() })
    const task = await createTask(before.engine)
    await report(before.engine, before.runtime.session('design').sessionId, 'done')
    const saved = before.store.saved()
    const stored = saved.tasks[0]!
    // The build's token no longer names its run; the tests' run has no token.
    stored.tokens = [{ ...stored.tokens.find((token) => token.nodeId === 'build')!, runId: null }]
    const ended: TaskRecord = {
      ...structuredClone(stored),
      id: 't-00000000beef',
      state: 'done',
      endedAt: 5,
      tokens: [],
      spent: [
        { worktree: { path: '/wt/old', branch: 'old', base: 'x', baseOid: 'c' }, merged: true },
      ],
    }
    saved.tasks.push(ended)

    const runtime = before.runtime
    const { engine } = await setup({ runtime, store: memoryStore(saved) })
    expect(engine.get(task.id).runs.map((run) => [run.nodeId, run.round, run.state])).toEqual([
      ['design', 1, 'done'],
      ['build', 1, 'stopped'],
      ['tests', 1, 'stopped'],
      ['build', 2, 'running'],
    ])
    expect(engine.get(task.id).task.arrived).toEqual([])
    expect(runtime.removed).toEqual([{ path: '/wt/old', merged: true }])
    expect(engine.get(ended.id).task.state).toBe('done')
  })
})
