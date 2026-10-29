// Integration tests: routines and their runs, through the host and its port, against the fake
// agent running in-process.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RoutineDraft, RoutineRun, RoutineView, RunPage, RunView } from '@shared/routines'
import { startTestHost, type TestHost, type TestPort } from '../testing/harness'

let current: TestHost | null = null

afterEach(async () => {
  await current?.stop()
  current = null
})

async function setup(options: Parameters<typeof startTestHost>[0] = {}) {
  current = await startTestHost(options)
  return { t: current, port: current.connect() }
}

const SCHEDULE = { kind: 'weekly' as const, days: [1, 2, 3, 4, 5], time: '09:00' }

function draft(overrides: Partial<RoutineDraft> = {}): RoutineDraft {
  return {
    name: 'Morning briefing',
    prompt: '/basic-turn',
    agentId: 'fake-agent',
    projectPath: null,
    options: [],
    trigger: { kind: 'schedule', schedule: SCHEDULE },
    scope: { level: 'read', web: false },
    timeLimitMinutes: 15,
    ...overrides,
  }
}

const create = (port: TestPort, overrides: Partial<RoutineDraft> = {}) =>
  port.request('routines.create', draft(overrides))

/** Every event the port got for a run, oldest first. */
function runEvents(port: TestPort, runId: string): RoutineRun[] {
  return port.events.flatMap((event) =>
    event.type === 'routine.run' && event.run.id === runId ? [event.run] : [],
  )
}

function lastRun(port: TestPort, runId: string): RoutineRun | undefined {
  return runEvents(port, runId).at(-1)
}

async function waitRun(port: TestPort, runId: string, ...statuses: RoutineRun['status'][]) {
  await port.until(() => {
    const run = lastRun(port, runId)
    return !!run && statuses.includes(run.status)
  })
  return lastRun(port, runId)!
}

function waitEnded(port: TestPort, runId: string) {
  return waitRun(
    port,
    runId,
    'succeeded',
    'failed',
    'timed_out',
    'cancelled',
    'interrupted',
    'skipped',
  )
}

/** Reads until the check has an answer, for what the host records after an event. */
async function poll<T>(check: () => Promise<T | null | undefined | false>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('Timed out waiting for the host')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function viewOf(port: TestPort, routineId: string): Promise<RoutineView> {
  const list = await port.request('routines.list', undefined)
  const view = list.routines.find((routine) => routine.id === routineId)
  if (!view) throw new Error(`Routine ${routineId} is gone`)
  return view
}

/** A run's page, following the cursor back to the run when it is old. */
async function runOf(port: TestPort, routineId: string, runId: string): Promise<RunView | null> {
  let before: number | null = null
  for (;;) {
    const page: RunPage = await port.request(
      'routines.runs',
      before === null ? { routineId } : { routineId, before },
    )
    const run = page.runs.find((item) => item.id === runId)
    if (run) return run
    if (page.older === null) return null
    before = page.older
  }
}

async function allRuns(port: TestPort, routineId: string): Promise<RunView[]> {
  const runs: RunView[] = []
  let before: number | null = null
  for (;;) {
    const page: RunPage = await port.request(
      'routines.runs',
      before === null ? { routineId } : { routineId, before },
    )
    runs.push(...page.runs)
    if (page.older === null) return runs
    before = page.older
  }
}

describe('routines', () => {
  it('creates a routine and runs it to a succeeded run with its output', async () => {
    const { port } = await setup()
    const routine = await create(port)

    const run = await port.request('routines.runNow', { routineId: routine.id })
    const ended = await waitEnded(port, run.id)
    expect(ended.status).toBe('succeeded')
    expect(ended.output).toContain('## Plan')
    expect(ended.stopReason).toBe('end_turn')
    // The host reports a run's files with the platform's own separators.
    const own = (file: string) => file.split('/').join(path.sep)
    expect(ended.changedFiles).toEqual(
      expect.arrayContaining([own('src/clock.ts'), own('test/clock.test.ts')]),
    )

    const stored = await runOf(port, routine.id, run.id)
    expect(stored).toMatchObject({ status: 'succeeded', seen: false })
    expect(stored?.session?.origin).toBe('routine')
    expect(stored?.session?.routine).toMatchObject({
      routineId: routine.id,
      runId: run.id,
      trigger: 'manual',
    })
    expect((await viewOf(port, routine.id)).lastRun?.status).toBe('succeeded')
  })

  it('names a routine from its prompt when it has no name', async () => {
    const { port } = await setup()
    const routine = await create(port, {
      name: '',
      prompt: 'Summarize the open pull requests\nand their checks',
    })
    expect(routine.name).toBe('Summarize the open pull requests')
  })

  it('pauses a run on a permission request and marks it waiting', async () => {
    const { t, port } = await setup()
    const routine = await create(port, { prompt: '/permission' })
    const run = await port.request('routines.runNow', { routineId: routine.id })

    const waiting = await waitRun(port, run.id, 'waiting')
    expect((await viewOf(port, routine.id)).activeRun?.status).toBe('waiting')
    const stored = await runOf(port, routine.id, run.id)
    expect(stored?.session?.status).toBe('awaiting_permission')
    expect(t.sent).toContainEqual(
      expect.objectContaining({ type: 'host:attention', kind: 'permission' }),
    )
    expect(waiting.sessionId).not.toBeNull()
    const snapshot = await port.open(waiting.sessionId!)
    const tool = snapshot.entries.find((entry) => entry.kind === 'tool' && entry.permission)
    expect(tool).toMatchObject({ permissionResult: null })
  })

  it('answers a permission request inside the scope as the routine', async () => {
    const { t, port } = await setup()
    const routine = await create(port, {
      prompt: '/permission',
      scope: { level: 'commands', web: false },
    })
    const run = await port.request('routines.runNow', { routineId: routine.id })

    const ended = await waitEnded(port, run.id)
    expect(ended.status).toBe('succeeded')
    expect(ended.output).toContain('All 12 login tests pass')
    expect(runEvents(port, run.id).map((event) => event.status)).not.toContain('waiting')
    expect(t.sent).not.toContainEqual(
      expect.objectContaining({ type: 'host:attention', kind: 'permission' }),
    )

    const snapshot = await port.open(ended.sessionId!)
    expect(snapshot.entries.find((entry) => entry.kind === 'tool')).toMatchObject({
      toolKind: 'execute',
      permission: null,
      permissionResult: { optionId: 'allow-once', kind: 'allow_once', by: 'routine' },
    })
  })

  it('pauses a permission request in a run session after the run ended', async () => {
    const { port } = await setup()
    const routine = await create(port, {
      prompt: '/basic-turn',
      scope: { level: 'commands', web: false },
    })
    const run = await port.request('routines.runNow', { routineId: routine.id })
    const ended = await waitEnded(port, run.id)
    expect(ended.status).toBe('succeeded')

    const sessionId = ended.sessionId!
    await port.open(sessionId)
    await port.request('sessions.prompt', {
      sessionId,
      content: [{ type: 'text', text: '/permission' }],
    })
    await port.untilStatus(sessionId, 'awaiting_permission')
    expect(
      port.entries(sessionId).find((entry) => entry.kind === 'tool' && entry.permission),
    ).toMatchObject({ permissionResult: null })
  })

  it('stops a run at its time limit and ends it timed out', async () => {
    const { port } = await setup({ routineTimings: { minuteMs: 50 } })
    const routine = await create(port, { prompt: '/cancel', timeLimitMinutes: 15 })
    const run = await port.request('routines.runNow', { routineId: routine.id })

    const ended = await waitEnded(port, run.id)
    expect(ended.status).toBe('timed_out')
    expect(ended.stopReason).toBe('cancelled')
    expect(ended.workingMs).toBeGreaterThanOrEqual(500)
    expect(ended.endedAt).not.toBeNull()
  })

  it('fails a run whose agent exits', async () => {
    const { port } = await setup()
    const routine = await create(port, { prompt: '/crash' })
    const run = await port.request('routines.runNow', { routineId: routine.id })

    const ended = await waitEnded(port, run.id)
    expect(ended.status).toBe('failed')
    expect(ended.error?.message).toBeTruthy()
    expect((await viewOf(port, routine.id)).lastRun?.status).toBe('failed')
  })

  it('refuses a second run while one is active, and queues a third routine', async () => {
    const { port } = await setup()
    const first = await create(port, { name: 'First', prompt: '/cancel' })
    const second = await create(port, { name: 'Second', prompt: '/cancel' })
    const third = await create(port, { name: 'Third', prompt: '/cancel' })

    const runA = await port.request('routines.runNow', { routineId: first.id })
    await waitRun(port, runA.id, 'starting', 'running')
    await expect(port.request('routines.runNow', { routineId: first.id })).rejects.toMatchObject({
      code: 'busy',
    })
    const runB = await port.request('routines.runNow', { routineId: second.id })
    await waitRun(port, runB.id, 'starting', 'running')
    const runC = await port.request('routines.runNow', { routineId: third.id })

    expect(runC.status).toBe('queued')
    expect((await viewOf(port, third.id)).activeRun?.status).toBe('queued')
  })

  it('leaves a run session out of the session list, keeping its origin and routine', async () => {
    const { port } = await setup()
    const routine = await create(port)
    const run = await port.request('routines.runNow', { routineId: routine.id })
    const ended = await waitEnded(port, run.id)
    expect(ended.sessionId).not.toBeNull()

    const listed = await port.request('sessions.list', {})
    expect(listed.map((summary) => summary.id)).not.toContain(ended.sessionId)
    const opened = await port.request('sessions.open', { sessionId: ended.sessionId! })
    expect(opened.session.origin).toBe('routine')
    expect(opened.session.routine).toMatchObject({ routineId: routine.id, runId: run.id })
  })

  it('keeps the sessions of the latest 100 runs and their records', async () => {
    const { t, port } = await setup()
    const routine = await create(port, { name: 'Daily', prompt: '/basic-turn' })
    let oldest: RoutineRun | null = null
    let oldestSession: string | null = null

    for (let i = 0; i < 101; i++) {
      const run = await port.request('routines.runNow', { routineId: routine.id })
      const ended = await waitEnded(port, run.id)
      expect(ended.status).toBe('succeeded')
      if (i === 0) {
        oldest = ended
        oldestSession = ended.sessionId
      }
    }
    expect(oldestSession).not.toBeNull()

    // The 101st run's start removes the oldest session; its record stays, without it.
    await port.until(() => lastRun(port, oldest!.id)?.sessionId === null)
    expect(t.host.sessions.has(oldestSession!)).toBe(false)
    const record = await runOf(port, routine.id, oldest!.id)
    expect(record).toMatchObject({ status: 'succeeded', sessionId: null, session: null })
    const stored = await allRuns(port, routine.id)
    expect(stored).toHaveLength(101)
    expect(stored.filter((run) => run.sessionId !== null)).toHaveLength(100)
    expect((await viewOf(port, routine.id)).sessions).toBe(100)
  }, 120_000)

  it('deletes a routine with its runs and sessions', async () => {
    const { t, port } = await setup()
    const routine = await create(port)
    const run = await port.request('routines.runNow', { routineId: routine.id })
    const ended = await waitEnded(port, run.id)
    const sessionId = ended.sessionId!
    expect(t.host.sessions.has(sessionId)).toBe(true)

    await port.request('routines.delete', { routineId: routine.id })
    expect((await port.request('routines.list', undefined)).routines).toEqual([])
    await expect(port.request('routines.runs', { routineId: routine.id })).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(t.host.sessions.has(sessionId)).toBe(false)
    expect(port.events).toContainEqual(
      expect.objectContaining({ type: 'routine.removed', routineId: routine.id }),
    )
  })

  it('marks a working run interrupted when the host stops', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-routines-'))
    try {
      const { t, port } = await setup({ userDataPath: dir })
      const routine = await create(port, { prompt: '/cancel' })
      const run = await port.request('routines.runNow', { routineId: routine.id })
      await waitRun(port, run.id, 'running')

      await t.stop()
      current = null
      const again = await startTestHost({ userDataPath: dir })
      current = again
      const reopened = again.connect()
      const stored = await poll(() => runOf(reopened, routine.id, run.id))
      expect(stored.status).toBe('interrupted')
      expect(stored.endedAt).not.toBeNull()
    } finally {
      await current?.stop()
      current = null
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('counts failed runs unseen until the routine is marked seen', async () => {
    const { port } = await setup()
    const routine = await create(port, { prompt: '/error' })
    const run = await port.request('routines.runNow', { routineId: routine.id })
    const ended = await waitEnded(port, run.id)
    expect(ended.status).toBe('failed')

    const unseen = await poll(async () => {
      const view = await viewOf(port, routine.id)
      return view.unseen.failed === 1 && view.lastRun?.status === 'failed' ? view : null
    })
    expect(unseen.unseen.ended).toBe(1)

    await port.request('routines.markSeen', { routineId: routine.id })
    const seen = await poll(async () => {
      const view = await viewOf(port, routine.id)
      return view.unseen.failed === 0 && view.unseen.ended === 0 ? view : null
    })
    expect(seen.unseen).toEqual({ failed: 0, ended: 0 })
  })
})
