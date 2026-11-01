import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChannelMessage } from '@shared/remote/channel'
import type { Patch } from '@shared/thread'
import { Outbox, type OutboxConnection, type OutboxLimits } from './outbox'

afterEach(() => {
  vi.useRealTimers()
})

function connection(): OutboxConnection & { sent: unknown[] } {
  const sent: unknown[] = []
  return {
    sent,
    channel: {
      send: async (message: ChannelMessage) => {
        sent.push(message.kind === 'json' ? message.value : { bytes: message.data.length })
      },
    },
    transport: { buffered: () => 0, drained: () => Promise.resolve() },
  }
}

function outbox(limits: Partial<OutboxLimits> = {}, acks = true) {
  const events = { overflowed: 0, dropped: 0 }
  const box = new Outbox({
    acks,
    limits,
    overflowed: () => events.overflowed++,
    dropped: (count) => (events.dropped += count),
  })
  const json = (value: unknown) => box.push({ kind: 'json', value })
  return { box, json, events }
}

const event = (type: string, fields: Record<string, unknown>) => ({
  type: 'event',
  event: { type, ...fields },
})
const summary = (id: string, title: string) => event('session.summary', { summary: { id, title } })
const text = (id: string, value: string): Patch => ({ op: 'entry.appendText', id, text: value })
const patches = (sessionId: string, seq: number, list: Patch[] = [text('e:1', `${seq}`)]) =>
  event('session.patches', { batch: { sessionId, seq, patches: list } })

describe('Outbox', () => {
  it('keeps what it wrote until the device acknowledges it, and sends the rest again', async () => {
    const { box, json } = outbox()
    const first = connection()
    box.attach(first)
    await json({ n: 1 })
    await json({ n: 2 })
    await json({ n: 3 })
    expect(first.sent).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    box.ack(1)
    box.detach()
    await json({ n: 4 })

    expect(box.canResume(2)).toBe(true)
    const second = connection()
    box.attach(second, 2)
    expect(second.sent).toEqual([{ n: 3 }, { n: 4 }])
  })

  it('takes over only a device that received what it could have', async () => {
    const { box, json } = outbox()
    box.attach(connection())
    await json({ n: 1 })
    await json({ n: 2 })
    box.ack(1)
    expect(box.canResume(0)).toBe(false)
    expect(box.canResume(3)).toBe(false)
    expect(box.canResume(1)).toBe(true)
    expect(box.canResume(2)).toBe(true)
  })

  it('holds the rest back past its window and goes on as the device acknowledges', async () => {
    const { box, json } = outbox({ inFlight: 2 })
    const link = connection()
    box.attach(link)
    for (let n = 1; n <= 5; n++) await json({ n })
    expect(link.sent).toHaveLength(2)
    box.ack(2)
    expect(link.sent).toHaveLength(4)
    box.ack(3)
    expect(link.sent).toHaveLength(5)
  })

  it('merges the waiting patches of a session into one batch that says where it starts', async () => {
    const { box, json } = outbox({ inFlight: 1 })
    const link = connection()
    box.attach(link)
    await json(summary('s', 'Fix the build'))
    await json(patches('s', 1, [text('e:1', 'Hel')]))
    await json(patches('t', 7))
    await json(patches('s', 2, [text('e:1', 'lo')]))
    await json(patches('s', 3, [{ op: 'session.update', changes: { title: 'x' } }]))
    box.ack(1)
    box.ack(2)
    expect(link.sent.slice(1)).toEqual([
      event('session.patches', {
        batch: {
          sessionId: 's',
          seq: 3,
          from: 1,
          patches: [text('e:1', 'Hello'), { op: 'session.update', changes: { title: 'x' } }],
        },
      }),
      patches('t', 7),
    ])
  })

  it('never merges patches across anything else, which keeps its place', async () => {
    const { box, json } = outbox({ inFlight: 1 })
    const link = connection()
    box.attach(link)
    await json({ n: 0 })
    await json(patches('s', 1))
    await json(summary('s', 'Fix the build'))
    await json(patches('s', 2))
    for (let n = 1; n <= 3; n++) box.ack(n)
    expect(link.sent.slice(1)).toEqual([
      patches('s', 1),
      summary('s', 'Fix the build'),
      patches('s', 2),
    ])
  })

  it('sends patches at the pace the device asks for, and anything else at once', async () => {
    vi.useFakeTimers()
    const { box, json } = outbox()
    const link = connection()
    box.attach(link)
    box.pace(1000)
    await json(patches('s', 1))
    await json(patches('s', 2))
    await json(patches('s', 3))
    expect(link.sent).toEqual([patches('s', 1)])
    vi.advanceTimersByTime(999)
    expect(link.sent).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(link.sent[1]).toMatchObject({ event: { batch: { from: 2, seq: 3 } } })

    await json(patches('s', 4))
    await json({ type: 'response', id: 1, result: null })
    expect(link.sent.slice(2)).toEqual([patches('s', 4), { type: 'response', id: 1, result: null }])
  })

  it('drops the patches once too much waits, keeps the latest of each state and asks to resync', async () => {
    const { box, json, events } = outbox({ queued: 5 })
    await json(summary('s', 'One'))
    await json(patches('s', 1))
    await json({ type: 'response', id: 1, result: 'kept' })
    await json(summary('t', 'Other'))
    await json(event('session.removed', { sessionId: 'u' }))
    await json(summary('s', 'Two'))

    const link = connection()
    box.attach(link)
    expect(link.sent).toEqual([
      { type: 'response', id: 1, result: 'kept' },
      summary('t', 'Other'),
      event('session.removed', { sessionId: 'u' }),
      summary('s', 'Two'),
      { type: 'resync' },
    ])
    expect(events.dropped).toBe(2)
    expect(events.overflowed).toBe(0)
  })

  it('asks to resync only once while the request to is still waiting', async () => {
    const { box, json } = outbox({ queued: 2 })
    await json(patches('s', 1))
    await json(patches('t', 1))
    await json({ n: 1 })
    await json(patches('s', 2))
    await json(patches('t', 2))
    await json({ n: 2 })
    const link = connection()
    box.attach(link)
    expect(
      link.sent.filter((value) => (value as { type?: string }).type === 'resync'),
    ).toHaveLength(1)
  })

  it('says the device cannot keep up once even what it keeps is too much', async () => {
    const { json, events } = outbox({ queued: 2, kept: 3 })
    for (let id = 1; id <= 4; id++) await json({ type: 'response', id, result: null })
    expect(events.overflowed).toBe(1)
  })

  it('paces downloads on the stream bytes the device has not acknowledged', async () => {
    const { box } = outbox()
    const link = connection()
    box.attach(link)
    await box.push({ kind: 'bytes', stream: 2, data: new Uint8Array(1000) })
    await box.push({ kind: 'bytes', stream: 2, data: new Uint8Array(500) })
    expect(box.buffered()).toBe(1500)
    let drained = false
    void box.drained().then(() => (drained = true))
    await Promise.resolve()
    expect(drained).toBe(false)
    box.ack(1)
    await Promise.resolve()
    expect(drained).toBe(true)
    expect(box.buffered()).toBe(500)
  })

  it('refuses a message that cannot go without giving it a number', async () => {
    const { box, json } = outbox()
    const link = connection()
    box.attach(link)
    await expect(json(undefined)).rejects.toThrow('not JSON')
    await json({ n: 1 })
    box.detach()
    expect(box.canResume(1)).toBe(true)
    expect(box.canResume(2)).toBe(false)
  })

  it('writes straight to the channel when the device does not acknowledge', async () => {
    const { box, json } = outbox({ inFlight: 1 }, false)
    const link = connection()
    box.attach(link)
    await json({ n: 1 })
    await json({ n: 2 })
    expect(link.sent).toEqual([{ n: 1 }, { n: 2 }])
    expect(box.canResume(0)).toBe(false)
  })
})
