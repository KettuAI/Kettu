import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Workflow } from '@shared/tasks'
import type { StageRunRecord, TaskRecord, TasksFile } from './api'
import { parseTasksFile, tasksFile } from './store'

const workflow: Workflow = {
  format: 1,
  id: 'dev',
  name: 'Development',
  description: '',
  kind: 'development',
  version: '1',
  worktree: true,
  start: 'build',
  limits: { rounds: 3, stageMinutes: 60, budgetUsd: null },
  stages: [
    {
      kind: 'agent',
      id: 'build',
      name: 'Build',
      next: 'accept',
      prompt: 'Build it.',
      tier: { S: 'fast', default: 'standard' },
      scope: { level: 'commands', web: false },
      session: 'resume',
      contract: [{ name: 'commands', type: 'list', required: true, description: 'run' }],
      evidence: ['reported-commands-ran'],
      gate: 'contract',
      when: { size: ['M', 'L'], risk: true },
    },
    { kind: 'human', id: 'accept', name: 'Accept', next: 'pr', prompt: 'OK?', sendBack: ['build'] },
    { kind: 'handover', id: 'pr', name: 'PR', next: null, action: 'pull-request' },
  ],
}

function task(id: string): TaskRecord {
  return {
    id,
    title: 'Dark mode',
    requirement: 'Add dark mode',
    projectPath: '/projects/app',
    workflow: { source: 'official', id: 'dev', version: '1', hash: 'abc', name: 'Development' },
    snapshot: workflow,
    state: 'running',
    reason: null,
    stageId: 'build',
    priority: 'normal',
    after: [],
    size: 'M',
    risk: false,
    worktree: { path: '/wt/x', branch: 'task/x', base: 'main', baseOid: 'a'.repeat(40) },
    pullRequest: null,
    costUsd: 0.25,
    createdBy: 'user',
    createdAt: 1,
    updatedAt: 2,
    startedAt: 2,
    endedAt: null,
    lastViewedAt: null,
    rounds: { check: 1 },
    pausedByUser: false,
    notes: 'Use tabs.',
  }
}

function run(id: string, taskId: string): StageRunRecord {
  return {
    id,
    taskId,
    stageId: 'build',
    round: 1,
    kind: 'agent',
    state: 'running',
    sessionId: 's1',
    agentId: 'claude-code',
    model: 'opus',
    tier: 'standard',
    summary: null,
    fields: { commands: ['pnpm test'], risk: false, notes: 'x' },
    evidence: { commands: ['pnpm test'], changedFiles: ['a.ts'] },
    note: null,
    costUsd: 0.25,
    startedAt: 2,
    endedAt: null,
    fromTurn: 0,
    nudged: false,
    workedMs: 1000,
    escalate: true,
  }
}

const T1 = 't-000000000001'
const T2 = 't-000000000002'

describe('tasks file', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'kettu-tasks-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips tasks, runs and tiers', async () => {
    const data: TasksFile = {
      version: 1,
      tasks: [task(T1)],
      runs: [run('sr-000000000001', T1)],
      tiers: {
        deep: [{ agentId: 'claude-code', options: [{ id: 'model', value: 'opus' }] }],
        standard: [{ agentId: 'codex', options: [] }],
        fast: [],
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
    const bad = { ...task(T2), state: 'flying' }
    const raw = {
      version: 1,
      tasks: [task(T1), bad, { ...task('t-000000000003'), snapshot: { id: 'x' } }],
      runs: [
        run('sr-000000000001', T1),
        run('sr-000000000002', T2),
        { ...run('sr-000000000003', T1), round: 0 },
      ],
      tiers: { deep: 'nope' },
    }
    await mkdir(path.join(dir, 'state'), { recursive: true })
    await writeFile(path.join(dir, 'state', 'tasks.json'), JSON.stringify(raw))
    const warnings: string[] = []
    const file = tasksFile(dir, (_level, message) => warnings.push(message))
    const loaded = await file.load()
    expect(file.status).toBe('ok')
    expect(loaded.tasks.map((t) => t.id)).toEqual([T1])
    expect(loaded.runs.map((r) => r.id)).toEqual(['sr-000000000001'])
    expect(loaded.tiers).toBeNull()
    expect(warnings.length).toBe(5)
  })

  it('reads a task written before notes existed', () => {
    const older: Partial<TaskRecord> = task(T1)
    delete older.notes
    const parsed = parseTasksFile({ version: 1, tasks: [older], runs: [], tiers: null })
    expect(typeof parsed !== 'string' && parsed.tasks[0]!.notes).toBeNull()
  })

  it('leaves a file from a newer app untouched', async () => {
    await mkdir(path.join(dir, 'state'), { recursive: true })
    const target = path.join(dir, 'state', 'tasks.json')
    await writeFile(target, JSON.stringify({ version: 2, tasks: [], runs: [], tiers: null }))
    const file = tasksFile(dir, () => {})
    await file.load()
    expect(file.readOnly).toBe(true)
    file.save({ version: 1, tasks: [task(T1)], runs: [], tiers: null })
    await file.flush()
    expect(JSON.parse(await readFile(target, 'utf8')).version).toBe(2)
  })

  it('fails the file only when its lists are missing', () => {
    expect(typeof parseTasksFile({ version: 1, runs: [] })).toBe('string')
  })
})
