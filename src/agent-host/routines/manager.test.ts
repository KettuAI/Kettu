import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import type { Routine, RoutineRun, RoutineView } from '@shared/routines'
import { nextRuns } from '@shared/schedule'
import type { JsonFile, RoutinesFile } from '../storage'
import type { ThreadStore } from '../threads/store'
import type { RoutineCallName, RoutineCalls, RoutineRunStats } from './calls'
import type { RoutineSessions, RunTurnResult } from './hooks'
import { RoutinesManager } from './manager'

const ID = 'r-0123456789ab'
const NOW = Date.UTC(2026, 10, 25, 12)

const ROUTINE: Routine = {
  id: ID,
  name: 'Weekly check',
  prompt: 'Check the dependencies',
  agentId: 'claude-code',
  projectPath: '/p',
  options: [],
  trigger: { kind: 'schedule', schedule: { kind: 'weekly', days: [1], time: '09:00' } },
  scope: { level: 'read', web: false },
  timeLimitMinutes: 60,
  keptRunSessions: 100,
  enabled: true,
  createdAt: NOW,
  updatedAt: NOW,
  checkedThrough: NOW,
}

const ENDED: RunTurnResult = {
  stopReason: 'end_turn',
  error: null,
  output: 'Done',
  usage: null,
  changedFiles: [],
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done))
}

const ACTIVE = new Set<RoutineRun['status']>(['queued', 'starting', 'running', 'waiting'])

/** The thread worker's run records, whose calls a test can hold until it releases them. */
class FakeRuns {
  readonly runs = new Map<string, RoutineRun>()
  private readonly gates = new Map<RoutineCallName, Promise<void>>()
  private readonly waits = new Map<RoutineCallName, number>()

  hold(name: RoutineCallName): () => void {
    const gate = deferred()
    this.gates.set(name, gate.promise)
    return () => {
      this.gates.delete(name)
      gate.resolve()
    }
  }

  waiting(name: RoutineCallName): number {
    return this.waits.get(name) ?? 0
  }

  async routine<K extends RoutineCallName>(
    name: K,
    params: RoutineCalls[K]['params'],
  ): Promise<RoutineCalls[K]['result']> {
    const gate = this.gates.get(name)
    if (gate) {
      this.waits.set(name, this.waiting(name) + 1)
      await gate
      this.waits.set(name, this.waiting(name) - 1)
    } else {
      await Promise.resolve()
    }
    return this.answer(name, params) as RoutineCalls[K]['result']
  }

  private answer(name: RoutineCallName, params: unknown): unknown {
    const of = (routineId: string): RoutineRun[] =>
      [...this.runs.values()].filter((run) => run.routineId === routineId)
    switch (name) {
      case 'put': {
        const { run } = params as RoutineCalls['put']['params']
        this.runs.set(run.id, { ...run })
        return { seq: this.runs.size }
      }
      case 'page': {
        const { routineId } = params as RoutineCalls['page']['params']
        return { runs: of(routineId).reverse(), older: null }
      }
      case 'stats': {
        const runs = of((params as RoutineCalls['stats']['params']).routineId)
        const stats: RoutineRunStats = {
          runs: runs.length,
          sessions: runs.filter((run) => run.sessionId !== null).length,
          unseenFailed: runs.filter((run) => !run.seen && run.status === 'failed').length,
          unseenEnded: runs.filter((run) => !run.seen && !ACTIVE.has(run.status)).length,
          last: runs.at(-1) ?? null,
          active: runs.find((run) => ACTIVE.has(run.status)) ?? null,
        }
        return stats
      }
      case 'clearSession': {
        const { sessionId } = params as RoutineCalls['clearSession']['params']
        const cleared: RoutineRun[] = []
        for (const run of this.runs.values()) {
          if (run.sessionId !== sessionId) continue
          run.sessionId = null
          cleared.push({ ...run })
        }
        return cleared
      }
      case 'remove': {
        const { routineId } = params as RoutineCalls['remove']['params']
        for (const run of of(routineId)) this.runs.delete(run.id)
        return null
      }
      case 'active':
      case 'beyond':
        return []
      case 'markSeen':
        return null
    }
  }
}

function setup() {
  const store = new FakeRuns()
  const saved: RoutinesFile[] = []
  const file = {
    status: 'ok',
    backupPath: null,
    load: async () => ({ version: 1, routines: [{ ...ROUTINE }] }),
    save: (data: RoutinesFile) => saved.push(structuredClone(data)),
    flush: async () => {},
  } as unknown as JsonFile<RoutinesFile>
  // What a client shows, fed by the events alone.
  const shown = new Map<string, RoutineView>()
  const events: string[] = []
  const attention: string[] = []
  const live = new Set<string>()
  let project: Promise<void> = Promise.resolve()
  let creating: Promise<void> = Promise.resolve()
  let now = NOW
  let timer: (() => void) | null = null
  const sessions: RoutineSessions = {
    // A session starts after its folder is resolved, as the sessions manager starts one.
    createRun: async (params) => {
      await creating
      const id = `s-${live.size + 1}`
      live.add(id)
      manager.hooks.sessionCreated(id, params.routine)
      return { id } as SessionSummary
    },
    cancel: async () => {},
    // A deleted session leaves the index before the delete settles.
    delete: async (sessionId) => {
      live.delete(sessionId)
      manager.hooks.sessionGone(sessionId)
    },
    has: (sessionId) => live.has(sessionId),
    summary: () => null,
  }
  const manager: RoutinesManager = new RoutinesManager({
    userDataPath: '/data',
    file,
    threads: store as unknown as ThreadStore,
    sessions,
    agents: {
      limits: () => [],
      modelOption: () => undefined,
      readLimits: async () => {},
      name: () => 'Claude Code',
    },
    log: () => {},
    events: {
      changed: (view) => {
        events.push(`changed ${view.id}`)
        shown.set(view.id, view)
      },
      removed: (routineId) => {
        events.push(`removed ${routineId}`)
        shown.delete(routineId)
      },
      run: () => {},
      working: () => {},
      attention: (kind, sessionId) => attention.push(`${kind} ${sessionId}`),
      paused: () => {},
    },
    resolveProject: async (folder) => {
      await project
      return folder
    },
    clock: {
      now: () => now,
      setTimeout: (callback) => {
        timer = callback
        return 1
      },
      clearTimeout: () => {
        timer = null
      },
    },
  })
  const holdProject = (): (() => void) => {
    const gate = deferred()
    project = gate.promise
    return gate.resolve
  }
  /** Holds the next sessions' start until it is released or fails. */
  const holdCreate = (): { release: () => void; fail: (error: Error) => void } => {
    let release!: () => void
    let fail!: (error: Error) => void
    creating = new Promise<void>((resolve, reject) => {
      release = resolve
      fail = reject
    })
    return { release, fail }
  }
  /** Moves the clock to `at` and fires the scheduler's timer. */
  const advance = (at: number): void => {
    now = at
    const fire = timer
    timer = null
    fire?.()
  }
  /** Starts a run and its first turn; resolves with its session. */
  const running = async (): Promise<string> => {
    await manager.load()
    await manager.runNow(ID)
    await settle()
    const sessionId = [...live][0]!
    manager.hooks.turnStarted(sessionId)
    await settle()
    expect(shown.get(ID)?.activeRun?.status).toBe('running')
    return sessionId
  }
  return {
    manager,
    store,
    saved,
    shown,
    events,
    attention,
    live,
    holdProject,
    holdCreate,
    advance,
    running,
  }
}

describe('RoutinesManager', () => {
  it('keeps a routine deleted during a run out of the list', async () => {
    const h = setup()
    await h.running()
    const releaseStats = h.store.hold('stats')
    const releaseRemove = h.store.hold('remove')
    // Deleting ends the run, whose view is counted while the delete finishes.
    const deleting = h.manager.delete(ID)
    await vi.waitFor(() => expect(h.store.waiting('remove')).toBe(1))
    await settle()
    releaseRemove()
    await deleting
    releaseStats()
    await settle()
    expect(h.events.at(-1)).toBe(`removed ${ID}`)
    expect(h.shown.has(ID)).toBe(false)
  })

  it('drops a view counted while its routine was deleted', async () => {
    const h = setup()
    const sessionId = await h.running()
    const releaseStats = h.store.hold('stats')
    h.manager.hooks.turnEnded(sessionId, ENDED)
    await settle()
    expect(h.store.waiting('stats')).toBe(1)
    await h.manager.delete(ID)
    releaseStats()
    await settle()
    expect(h.events.at(-1)).toBe(`removed ${ID}`)
    expect(h.shown.has(ID)).toBe(false)
  })

  it('keeps a routine turned off while its run ends off', async () => {
    const h = setup()
    const sessionId = await h.running()
    const releasePut = h.store.hold('put')
    h.manager.hooks.turnEnded(sessionId, ENDED)
    await settle()
    expect(h.store.waiting('put')).toBe(1)
    await h.manager.update(ID, { enabled: false })
    releasePut()
    await settle()
    expect(h.shown.get(ID)?.enabled).toBe(false)
    expect(h.shown.get(ID)?.activeRun).toBeNull()
  })

  it('fails an update whose routine was deleted before it applied', async () => {
    const h = setup()
    await h.manager.load()
    const release = h.holdProject()
    const updating = h.manager.update(ID, { projectPath: '/q' })
    await h.manager.delete(ID)
    release()
    await expect(updating).rejects.toMatchObject({ code: 'not_found' })
    expect((await h.manager.list()).routines).toEqual([])
    expect(h.saved.at(-1)?.routines).toEqual([])
    expect(h.shown.has(ID)).toBe(false)
  })

  it('fails an update whose routine was deleted while it was counted', async () => {
    const h = setup()
    await h.manager.load()
    const releaseStats = h.store.hold('stats')
    const updating = h.manager.update(ID, { name: 'Daily check' })
    await settle()
    expect(h.store.waiting('stats')).toBe(1)
    await h.manager.delete(ID)
    releaseStats()
    await expect(updating).rejects.toMatchObject({ code: 'not_found' })
    expect(h.events.at(-1)).toBe(`removed ${ID}`)
    expect(h.shown.has(ID)).toBe(false)
  })

  it('starts no run now for a routine being deleted', async () => {
    const h = setup()
    await h.manager.load()
    const releaseRemove = h.store.hold('remove')
    const deleting = h.manager.delete(ID)
    await vi.waitFor(() => expect(h.store.waiting('remove')).toBe(1))
    await expect(h.manager.runNow(ID)).rejects.toMatchObject({ code: 'not_found' })
    releaseRemove()
    await deleting
    await settle()
    expect(h.live.size).toBe(0)
    expect(h.store.runs.size).toBe(0)
    expect(h.attention).toEqual([])
    expect(h.events.at(-1)).toBe(`removed ${ID}`)
  })

  it('starts no scheduled run for a routine being deleted', async () => {
    const h = setup()
    await h.manager.load()
    h.manager.start()
    const releaseRemove = h.store.hold('remove')
    const deleting = h.manager.delete(ID)
    await vi.waitFor(() => expect(h.store.waiting('remove')).toBe(1))
    h.advance(nextRuns(ROUTINE.trigger.schedule, NOW, { count: 1 })[0]!.at)
    await settle()
    releaseRemove()
    await deleting
    for (const sessionId of [...h.live]) h.manager.hooks.turnEnded(sessionId, ENDED)
    await settle()
    expect(h.live.size).toBe(0)
    expect(h.store.runs.size).toBe(0)
    expect(h.attention).toEqual([])
    expect(h.events.at(-1)).toBe(`removed ${ID}`)
  })

  it('removes a session that started while its routine was deleted', async () => {
    const h = setup()
    await h.manager.load()
    const create = h.holdCreate()
    await h.manager.runNow(ID)
    await settle()
    const releaseRemove = h.store.hold('remove')
    const deleting = h.manager.delete(ID)
    await vi.waitFor(() => expect(h.store.waiting('remove')).toBe(1))
    create.release()
    await settle()
    releaseRemove()
    await deleting
    h.manager.hooks.turnEnded('s-1', ENDED)
    await settle()
    expect(h.live.size).toBe(0)
    expect(h.store.runs.size).toBe(0)
    expect(h.attention).toEqual([])
    expect(h.events.at(-1)).toBe(`removed ${ID}`)
  })

  it('records nothing for a run that ends after its routine went', async () => {
    const h = setup()
    await h.manager.load()
    const create = h.holdCreate()
    await h.manager.runNow(ID)
    await settle()
    await h.manager.delete(ID)
    create.fail(new Error('The agent is not installed'))
    await settle()
    expect(h.store.runs.size).toBe(0)
    expect(h.attention).toEqual([])
    expect(h.events.at(-1)).toBe(`removed ${ID}`)
  })
})
