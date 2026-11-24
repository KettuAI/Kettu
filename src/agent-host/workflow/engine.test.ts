import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import {
  DEFAULT_WORKING_STEPS,
  MAX_TASK_STEPS,
  type StepPick,
  type TaskView,
} from '@shared/workflow'
import type { AgentId } from '@shared/thread'
import { TaskEngine, type TaskEngineDeps, type TaskStepStart } from './engine'
import type { MergeResult, TaskGit } from './git'
import { emptyWorkflowsFile, WorkflowLibrary } from './library'
import { taskRecordOf, type TaskRecord } from './model'
import type { RoleHint, WorkflowAgent } from './picks'
import { deliveryOf } from './views'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Split runs front and back at once; join reviews front and may send the work back once. */
const PARALLEL = `format: 1
name: Parallel
steps:
  - id: split
    name: Split
    prompt: Split it.
    outcomes:
      - name: Done
        to: [front, back]
  - id: front
    name: Front
    prompt: Front.
    outcomes:
      - name: Done
        to: join
  - id: back
    name: Back
    prompt: Back.
    outcomes:
      - name: Done
        to: join
  - id: join
    name: Join
    hand_in: outcome
    review_of: [front]
    prompt: Check it.
    outcomes:
      - name: Pass
        end: done
      - name: Fail
        to: split
        limit: 1
`

/** A designed document the user reviews, then a person decides. */
const REVIEWED = `format: 1
name: Reviewed
steps:
  - id: design
    name: Design
    hand_in: document
    you_review: true
    prompt: Design it.
    outcomes:
      - name: Done
        to: build
  - id: build
    name: Build
    prompt: Build it.
    outcomes:
      - name: Done
        to: ship
  - id: ship
    name: Ship it?
    by: you
    prompt: Ship it?
    outcomes:
      - name: Yes
        end: done
      - name: No
        end: dropped
`

/** One step that names the MCP server and Skill it works with. */
const TOOLS = `format: 1
name: Tools
steps:
  - id: research
    name: Research
    prompt: Look it up.
    tools:
      mcp: [docs]
      skills: [review-kit]
    outcomes:
      - name: Done
        end: done
`

/** A step whose session is given a role of Kettu's. */
const ROLES = `format: 1
name: Roles
steps:
  - id: build
    name: Build
    prompt: Build it.
    outcomes:
      - name: Done
        to: check
  - id: check
    name: Check
    prompt: Check it.
    role: reviewer
    outcomes:
      - name: Done
        end: done
`

/** Split runs four branches at once, more than one task may run together. */
const WIDE = `format: 1
name: Wide
steps:
  - id: split
    name: Split
    prompt: Split it.
    outcomes:
      - name: Done
        to: [a, b, c, d]
  - id: a
    name: A
    prompt: A.
    outcomes:
      - name: Done
        end: done
  - id: b
    name: B
    prompt: B.
    outcomes:
      - name: Done
        end: done
  - id: c
    name: C
    prompt: C.
    outcomes:
      - name: Done
        end: done
  - id: d
    name: D
    prompt: D.
    outcomes:
      - name: Done
        end: done
`

/** A person decides first, so no step has a session when the task needs them. */
const ASK_FIRST = `format: 1
name: Ask first
steps:
  - id: decide
    name: Decide
    by: you
    prompt: Go ahead?
    outcomes:
      - name: Yes
        to: build
      - name: No
        end: dropped
  - id: build
    name: Build
    prompt: Build it.
    outcomes:
      - name: Done
        end: done
`

function agent(id: AgentId, models: string[], extra: Partial<WorkflowAgent> = {}): WorkflowAgent {
  return {
    id,
    name: id,
    harness: id.startsWith('codex') ? 'codex' : 'claude-code',
    disabled: false,
    missing: false,
    account: { kind: 'account', label: 'Plan' },
    apiKey: false,
    kettu: true,
    models: models.map((value) => ({
      value,
      name: value,
      note: null,
      efforts: ['low', 'high'],
    })),
    efforts: null,
    limits: () => [],
    skills: new Set(),
    mcp: new Set(),
    ...extra,
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve))
}

async function harness(
  options: {
    workflows?: Record<string, string>
    agents?: WorkflowAgent[]
    stored?: TaskRecord[]
    titleTask?: TaskEngineDeps['titleTask']
    createWorktree?: NonNullable<TaskEngineDeps['worktrees']>['create']
    merge?: (branch: string) => MergeResult
    /** The MCP servers and Skills the host knows, which a workflow may name. */
    known?: { mcp: string[]; skills: string[] }
    /** Sessions there before the engine loads. */
    live?: string[]
    /** Holds a step's session start after it exists, until it settles. */
    starting?: () => Promise<void>
    comments?: string[]
    workingLimit?: () => number
    /** The files there on the host, for what a report hands over. */
    files?: string[]
    /** The pull requests of each session. */
    pullRequests?: Record<string, string[]>
    /** What each role suggests, by its reference. */
    roles?: Record<string, RoleHint>
  } = {},
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kettu-tasks-'))
  dirs.push(dir)
  const data = emptyWorkflowsFile()
  const library = new WorkflowLibrary({
    dir,
    file: { load: async () => data, save: () => {}, flush: async () => {} },
    knownTools: () => ({
      mcp: new Set(options.known?.mcp ?? []),
      skills: new Set(options.known?.skills ?? []),
    }),
    log: () => {},
  })
  await library.load()
  const workflowIds: Record<string, string> = {}
  for (const [name, text] of Object.entries(options.workflows ?? {})) {
    const entry = await library.add({ kind: 'file', name: `${name}.yaml`, text })
    await library.approve(entry.id, entry.hash)
    workflowIds[name] = entry.id
  }
  const store = new Map<string, TaskRecord>(
    (options.stored ?? []).map((task) => [task.id, structuredClone(task)]),
  )
  const created: TaskStepStart[] = []
  const sent: { sessionId: string; text: string; due?: () => boolean }[] = []
  const cancelled: string[] = []
  const sessions = new Set<string>(options.live ?? [])
  const merges: { cwd: string; branch: string }[] = []
  const uncommitted = new Map<string, string[]>()
  const documents = new Set<string>()
  const events: {
    changed: TaskView[]
    attention: string[]
    ended: { view: TaskView; written: boolean }[]
  } = { changed: [], attention: [], ended: [] }
  const files = new Set(options.files ?? [])
  let n = 0
  let ids = 0
  const git: TaskGit = {
    isRepo: async () => true,
    head: async () => 'c0ffee',
    uncommitted: async (cwd) => uncommitted.get(cwd) ?? [],
    merging: async () => false,
    conflicts: async () => [],
    merge: async (cwd, branch) => {
      merges.push({ cwd, branch })
      return options.merge?.(branch) ?? { merged: true, conflicts: [], error: null }
    },
    contains: async () => false,
  }
  const deps: TaskEngineDeps = {
    store: {
      put: async (task) => {
        store.set(task.id, structuredClone(task))
        return null
      },
      all: async () => [...store.values()].map((task) => structuredClone(task)),
      remove: async (taskId) => {
        store.delete(taskId)
        return null
      },
    },
    library,
    sessions: {
      createStep: async (params) => {
        created.push(params)
        const id = `s${++n}`
        sessions.add(id)
        // As the session manager does, before the session starts.
        engine.sessionCreated(id, params.task)
        await options.starting?.()
        return { id } as SessionSummary
      },
      send: async (sessionId, text, due) => {
        sent.push({ sessionId, text, due })
      },
      cancel: async (sessionId) => {
        cancelled.push(sessionId)
      },
      delete: async (sessionId) => {
        sessions.delete(sessionId)
      },
      has: (sessionId) => sessions.has(sessionId),
    },
    worktrees: {
      create:
        options.createWorktree ??
        (async (_project, request) => ({
          path: `/wt/${request.branch ?? 'task'}`,
          branch: request.branch ?? 'kettu/task',
          base: request.base,
          baseOid: 'c0ffee',
        })),
      remove: async () => {},
    },
    titleTask: options.titleTask ?? (async () => null),
    git,
    documents: {
      written: async (artifactId) =>
        documents.has(artifactId)
          ? { ok: true, version: 1, title: 'Design' }
          : { ok: false, why: 'not_written' },
      openComments: async () => options.comments ?? ['Say how it is undone'],
    },
    resolveProject: async (value) => value,
    agents: () =>
      options.agents ?? [agent('claude-code', ['opus', 'sonnet']), agent('codex', ['gpt'])],
    optionsOf: (pick): Record<string, string> => (pick.model ? { model: pick.model } : {}),
    pickOf: (agentId, values) => ({
      agentId,
      model: typeof values.model === 'string' ? values.model : 'sonnet',
      effort: null,
    }),
    events: {
      changed: (view) => events.changed.push(view),
      removed: () => {},
      attention: (task, kind) => events.attention.push(`${task.title}:${kind}`),
      ended: (view, written) => events.ended.push({ view, written }),
    },
    ...(options.workingLimit ? { workingLimit: options.workingLimit } : {}),
    roleHint: async (ref) => options.roles?.[ref] ?? null,
    exists: async (file) => files.has(file),
    pullRequests: (ids) => ids.flatMap((id) => options.pullRequests?.[id] ?? []),
    log: () => {},
    now: () => 1_000,
    random: () => (++ids).toString(16).padStart(12, '0'),
  }
  const engine = new TaskEngine(deps)
  await engine.load()
  const start = async (
    workflow: string,
    values: Record<string, string> = { model: 'opus' },
    from?: { sessionId: string },
  ) => {
    const view = await engine.start(
      {
        projectPath: '/repo',
        workflowId: workflowIds[workflow] ?? workflow,
        text: 'Add an export button',
        pace: 'balanced',
        agentId: 'claude-code',
        options: values,
      },
      from,
    )
    await settle()
    return view
  }
  const sessionOf = (taskId: string, stepId: string): string => {
    const round = engine.get(taskId).rounds.findLast((r) => r.stepId === stepId)
    if (!round?.sessionId) throw new Error(`No session for ${stepId}`)
    return round.sessionId
  }
  const pick = (
    step: string,
    agentId: AgentId,
    model: string | null,
  ): StepPick & { step: string } => ({
    step,
    agentId,
    model,
    effort: null,
  })
  return {
    engine,
    library,
    store,
    created,
    sent,
    cancelled,
    sessions,
    merges,
    uncommitted,
    documents,
    events,
    start,
    sessionOf,
    pick,
    settle,
  }
}

const done = { outcome: null, note: 'Did it and ran the checks.', artifactId: null }

/** A design handed in as a document, then a build that ends the task. */
const SHIP = `format: 1
name: Ship
steps:
  - id: design
    name: Design
    hand_in: document
    prompt: Design it.
    outcomes:
      - name: Done
        to: build
  - id: build
    name: Build
    prompt: Build it.
    outcomes:
      - name: Done
        end: done
`

describe('the task engine', () => {
  it('starts the first step in its own worktree with the agent and model of the tray', async () => {
    const h = await harness({ workflows: { parallel: PARALLEL } })
    const task = await h.start('parallel')
    expect(task.worktreePath).toBe('/wt/task')
    expect(h.created).toHaveLength(1)
    expect(h.created[0]).toMatchObject({
      agentId: 'claude-code',
      options: { model: 'opus' },
      worktree: { path: '/wt/task' },
      prepare: true,
      task: { taskId: task.id, stepId: 'split' },
    })
    expect(h.created[0]!.prompt).toContain('Add an export button')
    expect(h.created[0]!.prompt).toContain('report_step')
    const view = h.engine.get(task.id)
    expect(view.rounds[0]).toMatchObject({ state: 'working', pickedBy: { kind: 'first' } })
    expect(view.steps.map((s) => s.state)).toEqual([
      'running',
      'not_reached',
      'not_reached',
      'not_reached',
    ])
  })

  it('stores the written title and branch for an untitled task from a session', async () => {
    const h = await harness({
      workflows: { reviewed: REVIEWED },
      titleTask: async (sessionId, text) => {
        expect(sessionId).toBe('source-session')
        expect(text).toBe('Add an export button')
        return 'Export button'
      },
      createWorktree: async (project, request, first) => {
        expect(project).toBe('/repo')
        expect(request.text).toBe('Add an export button')
        expect(first).toEqual({ agentId: 'claude-code', options: { model: 'opus' } })
        return {
          path: '/wt/temporary',
          branch: 'kettu/add-export',
          base: 'HEAD',
          baseOid: 'c0ffee',
        }
      },
    })
    const task = await h.start('reviewed', undefined, { sessionId: 'source-session' })

    expect(h.store.get(task.id)).toMatchObject({
      title: 'Export button',
      text: 'Add an export button',
      lanes: [{ id: 'main', worktree: { path: '/wt/temporary', branch: 'kettu/add-export' } }],
    })
    expect(h.created[0]?.prompt).toContain('on the branch `kettu/add-export`')
  })

  it('uses the workflow name when a suggested task has no title to use', async () => {
    const h = await harness({ workflows: { reviewed: REVIEWED } })
    const task = await h.start('reviewed', undefined, { sessionId: 'source-session' })

    expect(h.store.get(task.id)?.title).toBe('Reviewed')
  })

  it('refuses a report that is not complete, and says what is missing', async () => {
    const h = await harness({ workflows: { parallel: PARALLEL } })
    const task = await h.start('parallel')
    const session = h.sessionOf(task.id, 'split')
    const noNote = await h.engine.report(session, { outcome: null, note: null, artifactId: null })
    expect(noNote.accepted).toBe(false)
    expect(noNote.checks.find((c) => c.check === 'note')?.ok).toBe(false)
    h.uncommitted.set('/wt/task', ['src/a.ts'])
    const dirty = await h.engine.report(session, done)
    expect(dirty.accepted).toBe(false)
    expect(dirty.checks.find((c) => c.check === 'committed')).toMatchObject({ ok: false })
    expect(h.engine.get(task.id).rounds[0]!.state).toBe('working')
    await expect(h.engine.report('not-a-step', done)).rejects.toMatchObject({ code: 'restricted' })
  })

  it('has the reporting agent pick for the next steps, and checks only that each pick holds', async () => {
    const h = await harness({ workflows: { parallel: PARALLEL } })
    const task = await h.start('parallel')
    const session = h.sessionOf(task.id, 'split')
    const report = await h.engine.report(session, done)
    expect(report).toMatchObject({
      accepted: true,
      next: { kind: 'pick', steps: ['front', 'back'] },
    })
    expect(report.facts?.agents.map((a) => a.id)).toEqual(['claude-code', 'codex'])
    expect(report.facts?.task.pace).toBe('balanced')

    const bad = await h.engine.pick(session, [
      { step: 'front', agent: 'opencode', model: null, effort: null, reason: 'fast' },
      { step: 'back', agent: 'codex', model: 'gpt-9', effort: null, reason: 'fast' },
    ])
    expect(bad.accepted).toBe(false)
    expect(bad.checks[0]!.lines.find((l) => !l.ok)?.check).toBe('agent')
    expect(bad.checks[1]!.lines.find((l) => !l.ok)?.check).toBe('model')

    const good = await h.engine.pick(session, [
      { step: 'front', agent: 'claude-code', model: 'sonnet', effort: 'high', reason: 'UI work' },
      { step: 'back', agent: 'codex', model: 'gpt', effort: 'low', reason: 'Small API' },
    ])
    expect(good).toMatchObject({ accepted: true, next: { kind: 'start' } })
    await h.settle()
    const view = h.engine.get(task.id)
    const front = view.rounds.find((r) => r.stepId === 'front')!
    expect(front).toMatchObject({
      by: { agentId: 'claude-code', model: 'sonnet', effort: 'high' },
      pickedBy: { kind: 'agent', stepId: 'split' },
      reason: 'UI work',
      state: 'working',
    })
    // Each parallel branch works in a worktree of its own, cut from the split's commit.
    expect(h.created.slice(1).map((c) => c.worktree?.branch)).toEqual([
      'kettu/task-front',
      'kettu/task-back',
    ])
  })

  it('stops the task for the user after three refused picks in a row', async () => {
    const h = await harness({ workflows: { parallel: PARALLEL } })
    const task = await h.start('parallel')
    const session = h.sessionOf(task.id, 'split')
    await h.engine.report(session, done)
    const wrong = [{ step: 'front', agent: 'nobody', model: null, effort: null, reason: 'x' }]
    await h.engine.pick(session, wrong)
    await h.engine.pick(session, wrong)
    const third = await h.engine.pick(session, wrong)
    expect(third.next).toEqual({ kind: 'stuck' })
    const view = h.engine.get(task.id)
    expect(view.rounds[0]!.stuck?.reason).toBe('picks_refused')
    expect(view.needs).toEqual([
      expect.objectContaining({ kind: 'stuck', reason: 'picks_refused' }),
    ])
    expect(view.needsYou).toBe(true)
    expect(h.events.attention).toContain('Add an export button:needs-you')
  })

  it('starts a join only once every branch arrived, merging them in order, and the last picks', async () => {
    const h = await harness({ workflows: { parallel: PARALLEL } })
    const task = await h.start('parallel')
    const split = h.sessionOf(task.id, 'split')
    await h.engine.report(split, done)
    await h.engine.pick(split, [
      { step: 'front', agent: 'claude-code', model: 'sonnet', effort: null, reason: 'a' },
      { step: 'back', agent: 'codex', model: 'gpt', effort: null, reason: 'b' },
    ])
    await h.settle()
    const front = h.sessionOf(task.id, 'front')
    const first = await h.engine.report(front, done)
    expect(first.next).toEqual({ kind: 'wait', steps: ['join'] })
    expect(h.engine.get(task.id).rounds.some((r) => r.stepId === 'join')).toBe(false)

    const back = h.sessionOf(task.id, 'back')
    const last = await h.engine.report(back, done)
    expect(last.next).toEqual({ kind: 'pick', steps: ['join'] })
    // The review may not be done by the agent and model that built what it reviews.
    const same = await h.engine.pick(back, [
      { step: 'join', agent: 'claude-code', model: 'sonnet', effort: null, reason: 'c' },
    ])
    expect(same.checks[0]!.lines.find((l) => !l.ok)?.check).toBe('review')
    await h.engine.pick(back, [
      { step: 'join', agent: 'claude-code', model: 'opus', effort: null, reason: 'c' },
    ])
    await h.settle()
    expect(h.merges).toEqual([
      { cwd: '/wt/task', branch: 'kettu/task-front' },
      { cwd: '/wt/task', branch: 'kettu/task-back' },
    ])
    const join = h.engine.get(task.id).rounds.find((r) => r.stepId === 'join')!
    expect(join).toMatchObject({ state: 'working', branch: 'kettu/task' })
  })

  it('sends work back along a drawn arrow, then stops when that arrow is used up', async () => {
    const h = await harness({ workflows: { parallel: PARALLEL } })
    const task = await h.start('parallel')
    const run = async (step: string, picks?: Parameters<TaskEngine['pick']>[1]) => {
      const session = h.sessionOf(task.id, step)
      const result = await h.engine.report(session, done)
      if (result.next.kind === 'pick' && picks) await h.engine.pick(session, picks)
      await h.settle()
      return session
    }
    const picks = [
      { step: 'front', agent: 'claude-code', model: 'sonnet', effort: null, reason: 'a' },
      { step: 'back', agent: 'codex', model: 'gpt', effort: null, reason: 'b' },
    ]
    await run('split', picks)
    await run('front')
    await run('back', [{ step: 'join', agent: 'codex', model: 'gpt', effort: null, reason: 'c' }])
    const join = h.sessionOf(task.id, 'join')
    const fail = await h.engine.report(join, {
      outcome: 'fail',
      note: 'Tests break',
      artifactId: null,
    })
    expect(fail.next).toEqual({ kind: 'start', steps: ['split'] })
    await h.settle()
    const again = h.engine.get(task.id)
    const split2 = again.rounds.filter((r) => r.stepId === 'split')
    expect(split2).toHaveLength(2)
    // The step sent back keeps its person and works on in its own session.
    expect(split2[1]).toMatchObject({
      n: 2,
      pickedBy: { kind: 'previous' },
      sessionId: split2[0]!.sessionId,
      sentBack: { stepId: 'join', outcome: 'Fail', note: 'Tests break', count: 1, limit: 1 },
    })
    expect(h.sent.at(-1)?.text).toContain('Tests break')

    await run('split')
    await run('front')
    await run('back')
    const join2 = h.sessionOf(task.id, 'join')
    const limited = await h.engine.report(join2, {
      outcome: 'Fail',
      note: 'Still',
      artifactId: null,
    })
    expect(limited.next).toEqual({ kind: 'stuck' })
    const stuck = h.engine.get(task.id)
    expect(stuck.needs).toEqual([
      expect.objectContaining({ kind: 'stuck', stepId: 'join', reason: 'send_back_limit' }),
    ])
    expect(stuck.arrows.find((a) => a.from === 'join' && a.back)).toMatchObject({
      taken: 1,
      limit: 1,
    })

    // Retry lets the arrow be taken once more.
    await h.engine.retry(task.id, 'join', 'One more try')
    await h.settle()
    expect(h.engine.get(task.id).rounds.filter((r) => r.stepId === 'split')).toHaveLength(3)
  })

  it('waits for the user to review a document, and sends it back with their comments', async () => {
    const h = await harness({ workflows: { reviewed: REVIEWED } })
    const task = await h.start('reviewed')
    const design = h.sessionOf(task.id, 'design')
    const missing = await h.engine.report(design, {
      outcome: null,
      note: null,
      artifactId: 'art_x',
    })
    expect(missing.checks.find((c) => c.check === 'document')?.ok).toBe(false)
    h.documents.add('art_x')
    const report = await h.engine.report(design, { outcome: null, note: null, artifactId: 'art_x' })
    // The design's agent picks ahead for the build, which starts once the user approves.
    expect(report.next).toEqual({ kind: 'pick', steps: ['build'] })
    const picked = await h.engine.pick(design, [
      { step: 'build', agent: 'codex', model: 'gpt', effort: null, reason: 'Plain work' },
    ])
    expect(picked.next).toEqual({ kind: 'review' })
    let view = h.engine.get(task.id)
    const round = view.rounds[0]!
    expect(view.needs).toEqual([{ kind: 'review', stepId: 'design', roundId: round.id }])

    view = await h.engine.review(task.id, round.id, false, 'Cover undo')
    await h.settle()
    const redo = view.rounds.find((r) => r.stepId === 'design' && r.n === 2)!
    expect(redo.sentBack).toMatchObject({
      by: 'person',
      note: 'Cover undo',
      comments: ['Say how it is undone'],
    })
    // The pick made ahead is void once the user sends the step back.
    expect(view.waiting).toEqual([])
    expect(h.engine.get(task.id).rounds.some((r) => r.stepId === 'build')).toBe(false)

    await h.engine.report(design, { outcome: null, note: null, artifactId: 'art_x' })
    await h.engine.pick(design, [
      { step: 'build', agent: 'codex', model: 'gpt', effort: null, reason: 'Plain work' },
    ])
    const reviewing = h.engine.get(task.id).rounds.findLast((r) => r.stepId === 'design')!
    await h.engine.review(task.id, reviewing.id, true, null)
    await h.settle()
    const build = h.engine.get(task.id).rounds.find((r) => r.stepId === 'build')!
    expect(build).toMatchObject({ state: 'working', by: { agentId: 'codex', model: 'gpt' } })

    const ship = await h.engine.report(h.sessionOf(task.id, 'build'), done)
    expect(ship.next).toEqual({ kind: 'person', steps: ['ship'] })
    const person = h.engine.get(task.id).rounds.find((r) => r.stepId === 'ship')!
    await expect(h.engine.answer(task.id, person.id, 'Maybe', null)).rejects.toThrow()
    const ended = await h.engine.answer(task.id, person.id, 'Yes', null)
    expect(ended).toMatchObject({ status: 'done', end: 'done' })
    expect(h.events.attention).toContain('Add an export button:ended')
  })

  it('uses a pin over Auto and holds a step whose pinned agent cannot run', async () => {
    const h = await harness({
      workflows: { reviewed: REVIEWED },
      agents: [agent('claude-code', ['opus']), agent('codex', ['gpt'], { disabled: true })],
    })
    const task = await h.start('reviewed')
    await h.engine.pinStep(task.id, 'build', { agentId: 'codex', model: 'gpt', effort: null })
    const design = h.sessionOf(task.id, 'design')
    h.documents.add('art_x')
    const report = await h.engine.report(design, { outcome: null, note: null, artifactId: 'art_x' })
    expect(report.next).toEqual({ kind: 'review' })
    const round = h.engine.get(task.id).rounds[0]!
    const view = await h.engine.review(task.id, round.id, true, null)
    expect(view.waiting).toEqual([
      expect.objectContaining({
        stepId: 'build',
        blocked: { kind: 'unusable', agentId: 'codex', why: 'disabled' },
      }),
    ])
    expect(view.needs).toEqual([expect.objectContaining({ kind: 'blocked', stepId: 'build' })])
    const pinned = await h.engine.pinStep(task.id, 'build', {
      agentId: 'claude-code',
      model: 'opus',
      effort: null,
    })
    expect(pinned.rounds.find((r) => r.stepId === 'build')?.pickedBy).toEqual({ kind: 'task_pin' })
  })

  it(`works at most ${DEFAULT_WORKING_STEPS} step sessions at once across tasks`, async () => {
    const h = await harness({ workflows: { parallel: PARALLEL } })
    for (let i = 0; i < DEFAULT_WORKING_STEPS + 1; i++) await h.start('parallel')
    const states = h.engine.list().map((t) => h.engine.get(t.id).rounds[0]!.state)
    expect(states.filter((s) => s === 'working')).toHaveLength(DEFAULT_WORKING_STEPS)
    expect(states.filter((s) => s === 'queued')).toHaveLength(1)
    const busy = h.engine.list().find((t) => h.engine.get(t.id).rounds[0]!.state === 'working')!
    await h.engine.cancel(busy.id)
    await h.settle()
    expect(h.engine.list().every((t) => h.engine.get(t.id).rounds[0]!.state !== 'queued')).toBe(
      true,
    )
  })

  it('reminds a step that ends its turn without a report once, then waits for the user', async () => {
    const h = await harness({ workflows: { parallel: PARALLEL } })
    const task = await h.start('parallel')
    const session = h.sessionOf(task.id, 'split')
    h.engine.turnEnded(session, { byUser: false })
    await h.settle()
    expect(h.sent.at(-1)).toMatchObject({ sessionId: session })
    expect(h.sent.at(-1)!.text).toContain('report_step')
    h.engine.turnEnded(session, { byUser: false })
    await h.settle()
    expect(h.engine.get(task.id).rounds[0]!.stuck?.reason).toBe('no_report')
    expect(h.engine.working(session)).toBe(false)
    await h.engine.retry(task.id, 'split', 'Please finish')
    expect(h.engine.get(task.id).rounds[0]!.state).toBe('working')
    expect(h.sent.at(-1)!.text).toContain('Please finish')
  })

  it('drops a reminder still queued once its step reported or picked', async () => {
    const h = await harness({ workflows: { parallel: PARALLEL } })
    const task = await h.start('parallel')
    const session = h.sessionOf(task.id, 'split')
    h.engine.turnEnded(session, { byUser: false })
    await h.settle()
    const report = h.sent.at(-1)!
    expect(report.text).toContain('report_step')
    // Queued behind the user's message, it goes out only while the step still owes its report.
    expect(report.due?.()).toBe(true)
    await h.engine.report(session, done)
    expect(report.due?.()).toBe(false)

    h.engine.turnEnded(session, { byUser: false })
    await h.settle()
    const pick = h.sent.at(-1)!
    expect(pick.text).toContain('pick_step_agents')
    expect(pick.due?.()).toBe(true)
    await h.engine.pick(session, [
      { step: 'front', agent: 'claude-code', model: 'sonnet', effort: null, reason: 'UI' },
      { step: 'back', agent: 'codex', model: 'gpt', effort: null, reason: 'API' },
    ])
    expect(pick.due?.()).toBe(false)
    expect(report.due?.()).toBe(false)
  })

  it('drops a reminder still queued once its task is cancelled', async () => {
    const h = await harness({ workflows: { parallel: PARALLEL } })
    const task = await h.start('parallel')
    const session = h.sessionOf(task.id, 'split')
    h.engine.turnEnded(session, { byUser: false })
    await h.settle()
    const reminder = h.sent.at(-1)!
    expect(reminder.due?.()).toBe(true)
    await h.engine.cancel(task.id)
    expect(reminder.due?.()).toBe(false)
  })

  it('carries on after a restart from the stored task', async () => {
    const first = await harness({ workflows: { parallel: PARALLEL } })
    const task = await first.start('parallel')
    const stored = [...first.store.values()]
    expect(stored).toHaveLength(1)
    const second = await harness({ workflows: { parallel: PARALLEL }, stored })
    expect(second.engine.get(task.id).rounds[0]!.state).toBe('working')
    second.sessions.add(second.engine.get(task.id).rounds[0]!.sessionId!)
    // The step that was working is told to finish and report.
    expect(second.sent.at(-1)?.text).toContain('restarted')
    const report = await second.engine.report(
      second.engine.get(task.id).rounds[0]!.sessionId!,
      done,
    )
    expect(report.accepted).toBe(true)
  })

  it('hands a step its tools whoever does it, and holds it only for a tool the host lacks', async () => {
    const lacking = agent('claude-code', ['opus', 'sonnet'])
    const h = await harness({
      workflows: { tools: TOOLS },
      known: { mcp: ['docs'], skills: ['review-kit'] },
      agents: [lacking],
    })
    const task = await h.start('tools')
    const view = h.engine.get(task.id)
    expect(h.created).toHaveLength(0)
    expect(view.waiting).toEqual([
      expect.objectContaining({
        stepId: 'research',
        blocked: { kind: 'tools', missing: ['docs', 'review-kit'] },
      }),
    ])
    expect(view.needs).toEqual([expect.objectContaining({ kind: 'blocked', stepId: 'research' })])

    // Installed and on, they go to the step's session even though the agent's own list has neither.
    lacking.mcp = new Set(['docs'])
    lacking.skills = new Set(['review-kit'])
    h.engine.recheck()
    await h.settle()
    expect(h.created).toHaveLength(1)
    const round = h.engine.get(task.id).rounds[0]!
    expect(round.state).toBe('working')
    expect(h.engine.toolsOf({ taskId: task.id, stepId: 'research', roundId: round.id })).toEqual({
      mcp: ['docs'],
      skills: ['review-kit'],
    })
  })

  it('hands a step its role, and gives whoever picks for it the role’s suggestions as a hint only', async () => {
    const h = await harness({
      workflows: { roles: ROLES },
      roles: { reviewer: { name: 'Reviewer', suggests: { agent: 'codex', model: 'gpt-5' } } },
    })
    const task = await h.start('roles')
    expect(h.created).toHaveLength(1)
    expect(h.created[0]!.role).toBeUndefined()
    const report = await h.engine.report(h.sessionOf(task.id, 'build'), done)
    expect(report.facts?.steps).toEqual([
      expect.objectContaining({
        id: 'check',
        role: { name: 'Reviewer', suggests: { agent: 'codex', model: 'gpt-5' } },
      }),
    ])
    // The pick is the agent's own: the suggestion pins nothing.
    const picked = await h.engine.pick(h.sessionOf(task.id, 'build'), [
      { step: 'check', agent: 'claude-code', model: 'opus', effort: null, reason: 'cheap' },
    ])
    expect(picked.accepted).toBe(true)
    await h.settle()
    expect(h.created[1]).toMatchObject({ agentId: 'claude-code', role: 'reviewer' })
  })

  it('never stops a step for a turn that answered the user', async () => {
    const h = await harness({ workflows: { parallel: PARALLEL } })
    const task = await h.start('parallel')
    const session = h.sessionOf(task.id, 'split')
    const before = h.sent.length
    h.engine.turnEnded(session, { byUser: true })
    h.engine.turnEnded(session, { byUser: true })
    h.engine.turnEnded(session, { byUser: true })
    await h.settle()
    expect(h.sent).toHaveLength(before)
    expect(h.engine.get(task.id).rounds[0]).toMatchObject({ state: 'working', stuck: null })
    // The agent's own turn still owes the report.
    h.engine.turnEnded(session, { byUser: false })
    await h.settle()
    expect(h.sent.at(-1)!.text).toContain('report_step')
    expect(h.engine.get(task.id).rounds[0]!.state).toBe('working')
  })

  it('tells a step that was picking after a restart to pick, not to report', async () => {
    const first = await harness({ workflows: { parallel: PARALLEL } })
    const task = await first.start('parallel')
    const session = first.sessionOf(task.id, 'split')
    await first.engine.report(session, done)
    await first.settle()
    const second = await harness({
      workflows: { parallel: PARALLEL },
      stored: [...first.store.values()],
    })
    await second.settle()
    const resume = second.sent.find((m) => m.sessionId === session)!.text
    expect(resume).toContain('pick_step_agents')
    expect(resume).toContain('"front"')
    expect(resume).toContain('"back"')
    expect(resume).not.toContain('call `report_step`')
  })

  it('refuses a workflow whose outcome neither goes on nor ends', async () => {
    const h = await harness()
    const entry = await h.library.add({
      kind: 'file',
      name: 'nowhere.yaml',
      text: `format: 1
name: Nowhere
steps:
  - id: build
    name: Build
    prompt: Build it.
    outcomes:
      - name: Done
        end: done
      - name: Lost
        end: null
`,
    })
    expect(entry.problems).toEqual([
      expect.objectContaining({
        at: 'steps[0].outcomes[1]',
        message: expect.stringContaining('needs to'),
      }),
    ])
    await expect(h.start(entry.id)).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('stops a step session that was still starting when the task was cancelled', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const h = await harness({ workflows: { parallel: PARALLEL }, starting: () => gate })
    const task = await h.start('parallel')
    expect(h.engine.get(task.id).rounds[0]!.state).toBe('starting')
    await h.engine.cancel(task.id)
    // A cancel before the session has a turn stops nothing; it must come once its prompt went.
    const early = h.cancelled.length
    release()
    await h.settle()
    const round = h.engine.get(task.id).rounds[0]!
    expect(round.state).toBe('stopped')
    expect(h.cancelled.slice(early)).toEqual([round.sessionId])
  })

  it('gives a step whose session was made before a restart the whole task again', async () => {
    const first = await harness({ workflows: { parallel: PARALLEL } })
    const task = await first.start('parallel')
    const stored = structuredClone([...first.store.values()])
    const round = stored[0]!.rounds[0]!
    // The host stopped after the step's session was made, before it was marked working.
    round.state = 'starting'
    const session = round.sessionId!
    const second = await harness({
      workflows: { parallel: PARALLEL },
      stored,
      live: [session],
    })
    await second.settle()
    expect(second.created).toHaveLength(0)
    const sent = second.sent.filter((m) => m.sessionId === session).map((m) => m.text)
    expect(sent.at(-1)).toContain('## The task\n\nAdd an export button')
    expect(second.engine.get(task.id).rounds[0]!.state).toBe('working')
  })

  it('notifies from the task itself: once as it needs the user, and when it is cancelled', async () => {
    const h = await harness({ workflows: { ask: ASK_FIRST, parallel: PARALLEL } })
    const asked = await h.start('ask')
    // No step has a session yet; the task still notifies.
    expect(h.engine.get(asked.id).needs).toEqual([expect.objectContaining({ kind: 'person' })])
    expect(h.events.attention).toEqual(['Add an export button:needs-you'])

    h.events.attention.length = 0
    const task = await h.start('parallel')
    const session = h.sessionOf(task.id, 'split')
    // A step's session asking notifies by itself, however often it asks.
    h.engine.waiting(session, true)
    h.engine.waiting(session, false)
    h.engine.waiting(session, true)
    await h.settle()
    expect(h.engine.get(task.id).needs).toEqual([expect.objectContaining({ kind: 'asking' })])
    expect(h.events.attention).toEqual([])

    await h.engine.cancel(task.id)
    expect(h.events.attention).toEqual(['Add an export button:ended'])
  })

  it('sends a review back only with a note or an open comment', async () => {
    const h = await harness({ workflows: { reviewed: REVIEWED }, comments: [] })
    const task = await h.start('reviewed')
    const design = h.sessionOf(task.id, 'design')
    h.documents.add('art_x')
    await h.engine.report(design, { outcome: null, note: null, artifactId: 'art_x' })
    await h.engine.pick(design, [
      { step: 'build', agent: 'codex', model: 'gpt', effort: null, reason: 'Plain work' },
    ])
    const round = h.engine.get(task.id).rounds[0]!
    await expect(h.engine.review(task.id, round.id, false, '  ')).rejects.toMatchObject({
      code: 'invalid_params',
    })
    expect(h.engine.get(task.id).rounds[0]!.state).toBe('reviewing')
    expect(h.engine.get(task.id).arrows.find((a) => a.from === 'design')?.taken).toBe(0)
    const view = await h.engine.review(task.id, round.id, false, 'Cover undo')
    expect(view.rounds.find((r) => r.n === 2)?.sentBack).toMatchObject({ note: 'Cover undo' })
  })

  it(`runs at most ${MAX_TASK_STEPS} steps of one task at once, and the host's total across tasks`, async () => {
    let limit = DEFAULT_WORKING_STEPS
    const h = await harness({ workflows: { wide: WIDE }, workingLimit: () => limit })
    const task = await h.start('wide')
    const split = h.sessionOf(task.id, 'split')
    await h.engine.report(split, done)
    await h.engine.pick(
      split,
      ['a', 'b', 'c', 'd'].map((step) => ({
        step,
        agent: 'claude-code',
        model: 'sonnet',
        effort: null,
        reason: 'x',
      })),
    )
    await h.settle()
    const branches = () =>
      h.engine
        .get(task.id)
        .rounds.filter((r) => r.stepId !== 'split')
        .map((r) => r.state)
    expect(branches().filter((s) => s === 'working')).toHaveLength(MAX_TASK_STEPS)
    expect(branches().filter((s) => s === 'queued')).toHaveLength(1)

    // Another task still starts beside it.
    const other = await h.start('wide')
    expect(h.engine.get(other.id).rounds[0]!.state).toBe('working')

    // The host's total holds the rest back, and a higher one lets them go.
    limit = 4
    const third = await h.start('wide')
    expect(h.engine.get(third.id).rounds[0]!.state).toBe('queued')
    limit = 5
    h.engine.limitChanged()
    await h.settle()
    expect(h.engine.get(third.id).rounds[0]!.state).toBe('working')
    expect(branches().filter((s) => s === 'queued')).toHaveLength(1)
  })

  it('keeps what steps hand over and the conversation a task started from, and tells it at the end', async () => {
    const h = await harness({
      workflows: { ship: SHIP },
      files: ['/wt/task/dist/app.dmg'],
      pullRequests: { s2: ['https://github.com/acme/app/pull/7'] },
    })
    const task = await h.start('ship', { model: 'opus' }, { sessionId: 'chat' })
    expect(h.engine.list()[0]).toMatchObject({ id: task.id, from: { sessionId: 'chat' } })
    expect(h.store.get(task.id)!.from).toEqual({ sessionId: 'chat' })

    const design = h.sessionOf(task.id, 'design')
    h.documents.add('art_d')
    const reported = await h.engine.report(design, {
      outcome: null,
      note: null,
      artifactId: 'art_d',
      deliverables: [
        { kind: 'link', title: 'Spec', detail: null, url: 'https://example.com/spec' },
      ],
    })
    expect(reported.accepted).toBe(true)
    await h.engine.pick(design, [
      { step: 'build', agent: 'codex', model: 'gpt', effort: null, reason: 'Plain work' },
    ])
    await h.settle()

    const build = h.sessionOf(task.id, 'build')
    const installer = {
      kind: 'file' as const,
      title: 'Installer',
      detail: 'macOS',
      path: 'dist/app.dmg',
    }
    const refused = await h.engine.report(build, {
      ...done,
      deliverables: [installer, { kind: 'file', title: 'Logs', detail: null, path: 'logs.zip' }],
    })
    expect(refused.accepted).toBe(false)
    expect(refused.checks.find((c) => c.check === 'deliverables')).toMatchObject({
      ok: false,
      detail: expect.stringContaining('logs.zip'),
    })
    const ended = await h.engine.report(build, { ...done, deliverables: [installer] })
    expect(ended.next).toEqual({ kind: 'end', end: 'done' })

    const delivered = [
      { kind: 'pull_request', url: 'https://github.com/acme/app/pull/7' },
      { kind: 'link', title: 'Spec', detail: null, url: 'https://example.com/spec' },
      { ...installer, path: '/wt/task/dist/app.dmg' },
      { kind: 'document', artifactId: 'art_d', version: 1, title: 'Design' },
    ]
    expect(h.engine.get(task.id).deliverables).toEqual(delivered)
    expect(h.events.ended).toHaveLength(1)
    const { view, written } = h.events.ended[0]!
    expect(written).toBe(false)
    expect(view).toMatchObject({ status: 'done', from: { sessionId: 'chat' } })
    expect(deliveryOf(view, null, 5_000)).toEqual({
      taskId: task.id,
      title: 'Ship',
      status: 'done',
      steps: 2,
      durationMs: 0,
      deliverables: delivered,
      written: null,
    })

    // What the host stored reads back, and so does a round stored before deliverables.
    const stored = h.store.get(task.id)!
    expect(taskRecordOf(stored)?.rounds[1]!.deliverables).toEqual([
      { ...installer, path: '/wt/task/dist/app.dmg' },
    ])
    const older = structuredClone(stored)
    for (const round of older.rounds) delete round.deliverables
    expect(taskRecordOf(older)).not.toBeNull()
    const bad = structuredClone(stored)
    bad.rounds[0]!.deliverables = [{ kind: 'link', title: 'x', detail: null, url: 'file:///etc' }]
    expect(taskRecordOf(bad)).toBeNull()
  })

  it('tells only a task that started from a conversation when it is cancelled', async () => {
    const h = await harness({ workflows: { ship: SHIP } })
    const plain = await h.start('ship')
    await h.engine.cancel(plain.id)
    expect(h.events.ended).toEqual([])
    const fromCard = await h.start('ship', { model: 'opus' }, { sessionId: 'chat' })
    await h.engine.cancel(fromCard.id)
    expect(h.events.ended.map((e) => e.view.status)).toEqual(['cancelled'])
    expect(deliveryOf(h.events.ended[0]!.view, 'claude-code', 9_000)).toMatchObject({
      status: 'cancelled',
      steps: 1,
      written: null,
    })
  })

  it('keeps a task only once it is not running, and deletes its step sessions with it', async () => {
    const h = await harness({ workflows: { parallel: PARALLEL } })
    const task = await h.start('parallel')
    await expect(h.engine.delete(task.id)).rejects.toMatchObject({ code: 'conflict' })
    await h.engine.cancel(task.id)
    expect(h.cancelled).toEqual([h.created.length > 0 ? 's1' : ''])
    await h.engine.delete(task.id)
    expect(h.store.has(task.id)).toBe(false)
    expect(h.sessions.has('s1')).toBe(false)
  })
})
