import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONTROL_WAIT_MS,
  ControlWait,
  parseOverlayRequest,
  SurfaceControls,
  type SurfaceControl,
} from './control'

function setup() {
  const changes: [string, SurfaceControl][] = []
  const handed: [string, number][] = []
  const controls = new SurfaceControls({
    changed: (key, state) => changes.push([key, state]),
    handedBack: (key, ms) => handed.push([key, ms]),
  })
  const deadline = () => Date.now() + CONTROL_WAIT_MS
  return { controls, changes, handed, deadline }
}

type Outcome<T> = 'pending' | { value: T } | { error: unknown }
const outcomes = new WeakMap<Promise<unknown>, { result: Outcome<unknown> }>()

/** Watches a promise from the start, so a rejection before it is read is not unhandled. */
function track<T>(promise: Promise<T>): Promise<T> {
  const box: { result: Outcome<unknown> } = { result: 'pending' }
  outcomes.set(promise, box)
  promise.then(
    (value) => (box.result = { value }),
    (error: unknown) => (box.result = { error }),
  )
  return promise
}

async function settled<T>(promise: Promise<T>): Promise<Outcome<T>> {
  if (!outcomes.has(promise)) track(promise)
  await vi.advanceTimersByTimeAsync(0)
  return outcomes.get(promise)!.result as Outcome<T>
}

describe('SurfaceControls', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the agent state from the first call to the end of the turn', async () => {
    const { controls, deadline } = setup()
    expect(controls.state('s')).toEqual({ kind: 'idle' })
    const end = await controls.begin('s', { deadline: deadline() })
    expect(controls.state('s')).toEqual({ kind: 'agent', acting: true })
    expect(controls.holdsInput('s')).toBe(true)
    end()
    // Between calls the turn still uses it: clicks stay held back.
    expect(controls.state('s')).toEqual({ kind: 'agent', acting: false })
    expect(controls.holdsInput('s')).toBe(true)
    controls.turnEnded('s')
    expect(controls.state('s')).toEqual({ kind: 'idle' })
    expect(controls.holdsInput('s')).toBe(false)
  })

  it('takes over only from the agent state, and Hand back stays until pressed', async () => {
    const { controls, deadline, handed } = setup()
    expect(controls.takeOver('s')).toBe(false)
    const end = await controls.begin('s', { deadline: deadline() })
    end()
    expect(controls.takeOver('s')).toBe(true)
    expect(controls.state('s')).toEqual({ kind: 'you', since: 1_000_000 })
    expect(controls.holdsInput('s')).toBe(false)
    // However long the user holds it, it stays theirs.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(controls.state('s').kind).toBe('you')
    expect(controls.handBack('s')).toBe(true)
    expect(controls.state('s')).toEqual({ kind: 'agent', acting: false })
    expect(handed).toEqual([['s', 10 * 60_000]])
    expect(controls.handBack('s')).toBe(false)
  })

  it('makes a call during a takeover wait, then go on after Hand back', async () => {
    const { controls, deadline } = setup()
    ;(await controls.begin('s', { deadline: deadline() }))()
    controls.takeOver('s')
    const waiting = vi.fn()
    const call = track(controls.begin('s', { deadline: deadline(), waiting }))
    expect(await settled(call)).toBe('pending')
    expect(waiting).toHaveBeenLastCalledWith(true)
    await vi.advanceTimersByTimeAsync(20_000)
    controls.handBack('s')
    const result = await settled(call)
    expect(result).not.toBe('pending')
    expect(waiting).toHaveBeenLastCalledWith(false)
    expect(controls.state('s')).toEqual({ kind: 'agent', acting: true })
  })

  it('returns a waiting call before the tool time limit, and the next call waits again', async () => {
    const { controls, deadline } = setup()
    ;(await controls.begin('s', { deadline: deadline() }))()
    controls.takeOver('s')
    const first = track(controls.begin('s', { deadline: deadline() }))
    await vi.advanceTimersByTimeAsync(CONTROL_WAIT_MS)
    const ended = await settled(first)
    expect(ended).toEqual({ error: new ControlWait('held') })
    expect((ended as { error: ControlWait }).error.reason).toBe('held')
    // Called again: it waits on, and a takeover longer than 60 s goes on after Hand back.
    const second = track(controls.begin('s', { deadline: deadline() }))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await settled(second)).toBe('pending')
    controls.handBack('s')
    expect(await settled(second)).not.toBe('pending')
  })

  it('ends a waiting call when the turn ends', async () => {
    const { controls, deadline } = setup()
    ;(await controls.begin('s', { deadline: deadline() }))()
    controls.takeOver('s')
    const call = track(controls.begin('s', { deadline: deadline() }))
    controls.turnEnded('s')
    const result = await settled(call)
    expect((result as { error: ControlWait }).error.reason).toBe('stopped')
    expect(controls.state('s')).toEqual({ kind: 'idle' })
  })

  it('holds a call in flight at its next step while the user has the surface', async () => {
    const { controls, deadline } = setup()
    const end = await controls.begin('s', { deadline: deadline() })
    controls.takeOver('s')
    const step = track(controls.gate('s', { deadline: deadline() }))
    expect(await settled(step)).toBe('pending')
    controls.handBack('s')
    expect(await settled(step)).toEqual({ value: undefined })
    expect(controls.state('s')).toEqual({ kind: 'agent', acting: true })
    end()
    expect(controls.state('s')).toEqual({ kind: 'agent', acting: false })
  })

  it('asks the user for a step and returns what they chose', async () => {
    const { controls, deadline } = setup()
    ;(await controls.begin('s', { deadline: deadline() }))()
    const asked = track(
      controls.ask(
        's',
        { step: 'sign_in', target: 'app.example.com', reason: 'The bug is private.' },
        { deadline: deadline() },
      ),
    )
    expect(controls.state('s')).toMatchObject({
      kind: 'asks',
      ask: { step: 'sign_in', target: 'app.example.com' },
    })
    expect(controls.holdsInput('s')).toBe(false)
    // Another call waits while the step is the user's.
    const other = track(controls.begin('s', { deadline: deadline() }))
    expect(await settled(other)).toBe('pending')
    expect(controls.answer('s', 'done')).toBe(true)
    expect(await settled(asked)).toEqual({ value: 'done' })
    expect(await settled(other)).not.toBe('pending')
    expect(controls.state('s').kind).toBe('agent')
  })

  it('keeps an asked step across segments and gives an answer made between them', async () => {
    const { controls, deadline } = setup()
    const step = { step: 'code' as const, target: 'github.com', reason: 'A code was sent.' }
    const first = track(controls.ask('s', step, { deadline: deadline() }))
    const id = (controls.state('s') as { ask: { id: number } }).ask.id
    await vi.advanceTimersByTimeAsync(CONTROL_WAIT_MS)
    expect(((await settled(first)) as { error: ControlWait }).error.reason).toBe('asking')
    // Still the same step, not a new one.
    expect(controls.state('s')).toMatchObject({ kind: 'asks', ask: { id } })
    controls.answer('s', 'skipped')
    expect(await settled(controls.ask('s', step, { deadline: deadline() }))).toEqual({
      value: 'skipped',
    })
    // The answer is given once; a later ask is a new step.
    const later = track(controls.ask('s', step, { deadline: deadline() }))
    expect(await settled(later)).toBe('pending')
    expect((controls.state('s') as { ask: { id: number } }).ask.id).not.toBe(id)
  })

  it('ends an asked step with the turn', async () => {
    const { controls, deadline } = setup()
    const asked = track(
      controls.ask(
        's',
        { step: 'check', target: null, reason: 'A captcha.' },
        { deadline: deadline() },
      ),
    )
    controls.turnEnded('s')
    expect(((await settled(asked)) as { error: ControlWait }).error.reason).toBe('stopped')
    expect(controls.answer('s', 'done')).toBe(false)
  })

  it('fails what waits on a surface that is gone', async () => {
    const { controls, deadline } = setup()
    ;(await controls.begin('s', { deadline: deadline() }))()
    controls.takeOver('s')
    const call = track(controls.begin('s', { deadline: deadline() }))
    controls.forget('s')
    expect(((await settled(call)) as { error: ControlWait }).error.reason).toBe('gone')
  })

  it('keeps surfaces apart by their key', async () => {
    const { controls, deadline } = setup()
    ;(await controls.begin('a', { deadline: deadline() }))()
    ;(await controls.begin('b', { deadline: deadline() }))()
    controls.takeOver('a')
    expect(controls.state('b').kind).toBe('agent')
    controls.turnEnded('b')
    expect(controls.state('a').kind).toBe('you')
    expect(controls.keys()).toEqual(['a'])
  })
})

describe('parseOverlayRequest', () => {
  it("takes the overlay page's requests", () => {
    expect(parseOverlayRequest({ type: 'take-over' })).toEqual({ type: 'take-over' })
    expect(parseOverlayRequest({ type: 'answer', outcome: 'skipped' })).toEqual({
      type: 'answer',
      outcome: 'skipped',
    })
    expect(parseOverlayRequest({ type: 'wheel', x: 10, y: 20, deltaX: 0, deltaY: -120 })).toEqual({
      type: 'wheel',
      x: 10,
      y: 20,
      deltaX: 0,
      deltaY: -120,
    })
    expect(parseOverlayRequest({ type: 'pill', width: 320, height: 60, extra: 1 })).toEqual({
      type: 'pill',
      width: 320,
      height: 60,
    })
  })

  it('refuses anything else', () => {
    for (const value of [
      null,
      'take-over',
      { type: 'navigate', url: 'https://example.com' },
      { type: 'answer', outcome: 'ended' },
      { type: 'wheel', x: 'a', y: 1, deltaX: 0, deltaY: 0 },
      { type: 'wheel', x: 1, y: 1, deltaX: Infinity, deltaY: 0 },
      { type: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 1e9 },
      { type: 'pill', width: 0, height: 10 },
    ]) {
      expect(parseOverlayRequest(value)).toBeNull()
    }
  })
})
