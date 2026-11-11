import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Sop } from '@shared/tasks'
import type { WorktreeRecord } from '../storage'
import type { NodeRunRecord, TaskRecord, TasksFile } from './api'
import { parseTasksFile, tasksFile } from './store'

const snapshot: Sop = {
  format: 1,
  id: 'dev',
  name: 'Development',
  description: 'Build and accept.',
  start: 'build',
  rounds: 3,
  nodes: [
    {
      id: 'build',
      name: 'Build',
      prompt: 'Build it.',
      by: { kind: 'agent', tier: 'standard' },
      handIn: 'document',
      outcomes: [{ id: 'done', name: 'Done', to: ['accept', 'docs'] }],
    },
    {
      id: 'docs',
      name: 'Docs',
      prompt: 'Write the docs.',
      by: { kind: 'agent', tier: 'fast' },
      handIn: 'note',
      outcomes: [{ id: 'done', name: 'Done', to: ['accept'] }],
    },
    {
      id: 'accept',
      name: 'Accept',
      prompt: 'Good?',
      by: { kind: 'person' },
      handIn: 'verdict',
      outcomes: [
        { id: 'ok', name: 'OK', to: [], end: 'done' },
        { id: 'no', name: 'No', to: [], end: 'dropped' },
        { id: 'redo', name: 'Redo', to: ['build'], rounds: 2 },
      ],
    },
  ],
}

const worktree = (name: string): WorktreeRecord => ({
  path: `/wt/${name}`,
  branch: `task/${name}`,
  base: 'main',
  baseOid: 'a'.repeat(40),
})

function task(id: string): TaskRecord {
  return {
    id,
    title: 'Dark mode',
    requirement: 'Add dark mode',
    projectPath: '/projects/app',
    sop: { source: 'library', id: 'dev', name: 'Development', hash: 'abc' },
    snapshot,
    state: 'running',
    worktree: worktree('x'),
    tokens: [
      {
        id: 'tk-000000000001',
        nodeId: 'docs',
        runId: 'nr-000000000001',
        lanes: [worktree('x'), worktree('docs')],
        from: { nodeId: 'build', outcome: 'done', note: 'Built.', back: false },
      },
      { id: 'tk-000000000002', nodeId: 'accept', runId: null, lanes: [worktree('x')], from: null },
    ],
    rounds: { 'accept/redo': 1 },
    spent: [{ worktree: worktree('old'), merged: true }],
    createdBy: 'user',
    createdAt: 1,
    updatedAt: 2,
    endedAt: null,
    lastViewedAt: null,
  }
}

function run(id: string, taskId: string): NodeRunRecord {
  return {
    id,
    taskId,
    nodeId: 'docs',
    round: 2,
    by: 'agent',
    state: 'waiting',
    waiting: 'stuck',
    reason: 'The session of "Docs" was closed.',
    sessionId: 's1',
    agentId: 'claude-code',
    model: 'haiku',
    tier: 'fast',
    outcome: null,
    note: null,
    sentBack: { from: 'accept', note: 'Shorter.' },
    startedAt: 2,
    endedAt: null,
    document: '# Docs',
    worktree: worktree('docs'),
    reminded: true,
    toMerge: [worktree('other')],
  }
}

const T1 = 't-000000000001'
const T2 = 't-000000000002'
const NO_TIERS = { deep: null, standard: null, fast: null }

describe('tasks file', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'kettu-tasks-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function write(raw: unknown): Promise<string> {
    await mkdir(path.join(dir, 'state'), { recursive: true })
    const target = path.join(dir, 'state', 'tasks.json')
    await writeFile(target, typeof raw === 'string' ? raw : JSON.stringify(raw))
    return target
  }

  it('round-trips tasks with their tokens, runs and tiers', async () => {
    const data: TasksFile = {
      version: 2,
      tasks: [task(T1)],
      runs: [run('nr-000000000001', T1)],
      tiers: {
        deep: { agentId: 'claude-code', options: [{ id: 'model', value: 'opus' }] },
        standard: null,
        fast: { agentId: 'codex', options: [{ id: 'fast_mode', value: true }] },
      },
    }
    const file = tasksFile(dir, () => {})
    file.save(data)
    await file.flush()
    expect(await readFile(path.join(dir, 'state', 'tasks.json'), 'utf8')).toContain(T1)
    const loaded = await tasksFile(dir, () => {}).load()
    expect(loaded).toEqual(data)
  })

  it('drops a malformed task and its runs without failing the file', async () => {
    const raw = {
      version: 2,
      tasks: [
        task(T1),
        { ...task(T2), state: 'flying' },
        { ...task('t-000000000003'), snapshot: { ...snapshot, start: 'nowhere' } },
        { ...task('t-000000000004'), tokens: [{ ...task(T1).tokens[0], nodeId: 'nowhere' }] },
        { ...task('t-000000000005'), spent: [{ worktree: { path: 1 }, merged: true }] },
        task(T1),
      ],
      runs: [
        run('nr-000000000001', T1),
        run('nr-000000000002', T2),
        { ...run('nr-000000000003', T1), round: 0 },
        { ...run('nr-000000000004', T1), state: 'running' },
        { ...run('nr-000000000005', T1), toMerge: 'none' },
        run('sr-000000000006', T1),
      ],
      tiers: { deep: 'nope' },
    }
    await write(raw)
    const warnings: string[] = []
    const file = tasksFile(dir, (_level, message) => warnings.push(message))
    const loaded = await file.load()
    expect(file.status).toBe('ok')
    expect(loaded.tasks.map((t) => t.id)).toEqual([T1])
    expect(loaded.runs.map((r) => r.id)).toEqual(['nr-000000000001'])
    expect(loaded.tiers).toEqual(NO_TIERS)
    expect(warnings.length).toBe(11)
  })

  it('reads the file of the earlier, unreleased model as empty', async () => {
    const target = await write({
      version: 1,
      tasks: [{ id: T1, workflow: { id: 'dev' }, stageId: 'build' }],
      runs: [{ id: 'sr-000000000001', taskId: T1 }],
      tiers: { deep: [], standard: [], fast: [] },
    })
    const file = tasksFile(dir, () => {})
    expect(await file.load()).toEqual({ version: 2, tasks: [], runs: [], tiers: NO_TIERS })
    expect(file.status).toBe('migrated')
    await file.flush()
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({
      version: 2,
      tasks: [],
      runs: [],
      tiers: NO_TIERS,
    })
  })

  it('reads a malformed file as empty and sets it aside', async () => {
    for (const raw of ['{ not json', { version: 2, runs: [] }, { tasks: [], runs: [] }]) {
      await write(raw)
      const file = tasksFile(dir, () => {})
      expect(await file.load()).toEqual({ version: 2, tasks: [], runs: [], tiers: NO_TIERS })
      expect(file.status).toBe('corrupt')
    }
  })

  it('leaves a file from a newer app untouched', async () => {
    const target = await write({ version: 3, tasks: [], runs: [], tiers: null })
    const file = tasksFile(dir, () => {})
    expect((await file.load()).tasks).toEqual([])
    expect(file.readOnly).toBe(true)
    file.save({ version: 2, tasks: [task(T1)], runs: [], tiers: NO_TIERS })
    await file.flush()
    expect(JSON.parse(await readFile(target, 'utf8')).version).toBe(3)
  })

  it('keeps a run only in a state its waiting agrees with', () => {
    const parsed = parseTasksFile({
      version: 2,
      tasks: [task(T1)],
      runs: [
        { ...run('nr-000000000001', T1), state: 'done', waiting: null },
        { ...run('nr-000000000002', T1), state: 'done' },
        { ...run('nr-000000000003', T1), waiting: null },
        { ...run('nr-000000000004', T1), waiting: 'bored' },
      ],
      tiers: null,
    })
    expect(typeof parsed !== 'string' && parsed.runs.map((r) => r.id)).toEqual(['nr-000000000001'])
  })
})
