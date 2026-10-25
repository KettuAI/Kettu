// The scheduler, with a clock and timer the tests move by hand.

import { afterEach, describe, expect, it } from 'vitest'
import type { RoutineDraft, RoutineRun, RoutineView, RunPage } from '@shared/routines'
import type { Schedule } from '@shared/routines'
import { startTestHost, type TestHost, type TestPort } from '../testing/harness'
import type { RoutineClock } from './scheduler'

const START = Date.parse('2024-06-03T12:00:00Z')

class FakeClock implements RoutineClock {
  at: number
  private next = 1
  private readonly timers = new Map<number, { at: number; callback: () => void }>()

  constructor(at: number) {
    this.at = at
  }

  now = (): number => this.at

  setTimeout = (callback: () => void, ms: number): unknown => {
    const id = this.next++
    this.timers.set(id, { at: this.at + ms, callback })
    return id
  }

  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number)
  }

  advance(ms: number): void {
    this.at += ms
    this.fire()
  }

  set(at: number): void {
    this.at = at
    this.fire()
  }

  private fire(): void {
    for (let guard = 0; guard < 1000; guard++) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.at)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) return
      this.timers.delete(due[0])
      due[1].callback()
    }
  }
}

let current: TestHost | null = null

afterEach(async () => {
  await current?.stop()
  current = null
})

const every = (minutes: number, from: number): Schedule => ({ kind: 'every', minutes, from })

function once(at: number): Schedule {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return {
    kind: 'once',
    at: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`,
  }
}

function draft(schedule: Schedule, prompt = '/basic-turn'): RoutineDraft {
  return {
    name: 'Scheduled',
    prompt,
    agentId: 'fake-agent',
    projectPath: null,
    options: [],
    trigger: { kind: 'schedule', schedule },
    scope: { level: 'read', web: false },
    timeLimitMinutes: 15,
  }
}

async function setup(clock: FakeClock): Promise<{ t: TestHost; port: TestPort }> {
  current = await startTestHost({ routineClock: clock })
  return { t: current, port: current.connect() }
}

const creates = (port: TestPort, schedule: Schedule, prompt?: string) =>
  port.request('routines.create', draft(schedule, prompt))

function viewOf(port: TestPort, routineId: string): Promise<RoutineView> {
  return port.request('routines.list', undefined).then((list) => {
    const view = list.routines.find((routine) => routine.id === routineId)
    if (!view) throw new Error(`Routine ${routineId} is gone`)
    return view
  })
}

function runEvents(port: TestPort): RoutineRun[] {
  return port.events.flatMap((event) => (event.type === 'routine.run' ? [event.run] : []))
}

function runsFor(port: TestPort, routineId: string): RoutineRun[] {
  const byId = new Map<string, RoutineRun>()
  for (const run of runEvents(port)) {
    if (run.routineId === routineId) byId.set(run.id, run)
  }
  return [...byId.values()]
}

function runsOf(port: TestPort, routineId: string, kind: RoutineRun['trigger']): RoutineRun[] {
  return runsFor(port, routineId).filter((run) => run.trigger === kind)
}

/** Reads until the check has an answer, for what the host records after an event. */
async function poll<T>(check: () => Promise<T | null | undefined | false>): Promise<T> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('Timed out waiting for the host')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function allRuns(port: TestPort, routineId: string): Promise<RoutineRun[]> {
  const runs: RoutineRun[] = []
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

describe('the routine scheduler', () => {
  it('runs an every schedule when it comes due, and shows its next run', async () => {
    const clock = new FakeClock(START)
    const { port } = await setup(clock)
    const routine = await creates(port, every(5, START))

    expect((await viewOf(port, routine.id)).nextRunAt).toBe(START + 5 * 60_000)
    clock.advance(5 * 60_000)

    await port.until(() => runsOf(port, routine.id, 'schedule').length === 1)
    const run = runsOf(port, routine.id, 'schedule')[0]!
    expect(run.scheduledFor).toBe(START + 5 * 60_000)
    expect(run.count).toBe(1)
    expect((await viewOf(port, routine.id)).nextRunAt).toBe(START + 10 * 60_000)
  })

  it('turns a one-time routine off after its run and shows it as done', async () => {
    const clock = new FakeClock(START)
    const { port } = await setup(clock)
    const due = START + 60_000
    const routine = await creates(port, once(due))
    expect((await viewOf(port, routine.id)).nextRunAt).toBe(due)

    clock.advance(60_000)
    await port.until(() => runEvents(port).some((run) => run.status === 'succeeded'))

    const view = await poll(async () => {
      const shown = await viewOf(port, routine.id)
      return shown.state === 'done' ? shown : null
    })
    expect(view.enabled).toBe(false)
    expect(view.state).toBe('done')
    expect(view.nextRunAt).toBeNull()
    expect(runsOf(port, routine.id, 'schedule')).toHaveLength(1)
  })

  it('merges consecutive skips while the last run still works', async () => {
    const clock = new FakeClock(START)
    const { port } = await setup(clock)
    const routine = await creates(port, every(5, START), '/cancel')

    clock.advance(5 * 60_000)
    await port.until(() => !!runsOf(port, routine.id, 'schedule')[0]?.sessionId)
    clock.advance(5 * 60_000)
    await port.until(() => runEvents(port).some((run) => run.status === 'skipped'))
    clock.advance(5 * 60_000)

    const skipped = runsFor(port, routine.id).filter((run) => run.status === 'skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ reason: 'overlap', count: 2 })
    const stored = (await allRuns(port, routine.id)).filter((run) => run.status === 'skipped')
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ reason: 'overlap', count: 2 })
  })

  it('queues runs beyond two at once', async () => {
    const clock = new FakeClock(START)
    const { port } = await setup(clock)
    const first = await creates(port, every(5, START), '/cancel')
    const second = await creates(port, every(5, START), '/cancel')
    const third = await creates(port, every(5, START), '/cancel')

    clock.advance(5 * 60_000)
    const status = (routineId: string) =>
      poll(async () => (await viewOf(port, routineId)).activeRun?.status || null)
    expect(await status(first.id)).toMatch(/starting|running/)
    expect(await status(second.id)).toMatch(/starting|running/)
    expect(await status(third.id)).toBe('queued')
  })

  it('stands for the missed times with one catch-up run after a gap', async () => {
    const clock = new FakeClock(START)
    const { port } = await setup(clock)
    const routine = await creates(port, every(5, START))

    clock.advance(30 * 60_000)
    await port.until(() => runEvents(port).some((run) => run.trigger === 'catch-up'))

    const catchUp = runsOf(port, routine.id, 'catch-up')
    expect(catchUp).toHaveLength(1)
    expect(catchUp[0]).toMatchObject({
      count: 6,
      scheduledFor: START + 5 * 60_000,
    })
    expect(runsOf(port, routine.id, 'schedule')).toHaveLength(0)
  })

  it('catches up once after the computer slept', async () => {
    const clock = new FakeClock(START)
    const { t, port } = await setup(clock)
    const routine = await creates(port, every(5, START))

    t.host.power('suspend')
    clock.advance(20 * 60_000)
    t.host.power('resume')
    await port.until(() => runEvents(port).some((run) => run.trigger === 'catch-up'))

    const catchUp = runsOf(port, routine.id, 'catch-up')
    expect(catchUp).toHaveLength(1)
    expect(catchUp[0]).toMatchObject({ count: 4, scheduledFor: START + 5 * 60_000 })
  })

  it('catches up once when the clock jumps forward, and never runs a time twice', async () => {
    const clock = new FakeClock(START)
    const { port } = await setup(clock)
    const routine = await creates(port, every(5, START))

    clock.set(START + 40 * 60_000)
    await port.until(() => runEvents(port).some((run) => run.trigger === 'catch-up'))
    expect(runsOf(port, routine.id, 'catch-up')[0]?.count).toBe(8)

    // Back past the times already accounted for: nothing runs again.
    clock.set(START + 35 * 60_000)
    clock.set(START + 40 * 60_000)
    expect(runsFor(port, routine.id)).toHaveLength(1)

    clock.set(START + 45 * 60_000)
    await port.until(() => runsOf(port, routine.id, 'schedule').length === 1)
    expect(runsOf(port, routine.id, 'schedule')[0]?.scheduledFor).toBe(START + 45 * 60_000)
  })
})
