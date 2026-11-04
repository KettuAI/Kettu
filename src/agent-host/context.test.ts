import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContextBreakdown } from '@shared/context'
import type { PromptResult, SessionTarget } from './connection'
import { ACP_DRIVER } from './acp/driver'
import { startTestHost, type TestHost } from './testing/harness'

const hosts: TestHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()))
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function breakdown(used: number): ContextBreakdown {
  return {
    used,
    size: 200_000,
    model: 'test',
    categories: [{ name: 'Messages', tokens: used, share: used / 200_000 }],
    lists: [],
    observedAt: Date.now(),
  }
}

async function setup() {
  let used = 20_000
  const read = vi.fn(async () => breakdown(used))
  const turn = deferred<PromptResult>()
  let target!: SessionTarget
  const host = await startTestHost({
    sessionTimings: { flushMs: 0, contextRefreshMs: 40, contextDebounceMs: 10 },
    drivers: {
      acp: {
        ...ACP_DRIVER,
        reads: { context: true },
        connect: (transport, ctx) => {
          const connection = ACP_DRIVER.connect(transport, ctx)
          const register = connection.register.bind(connection)
          connection.register = (id, value) => {
            target = value
            register(id, value)
          }
          connection.readContext = read
          connection.prompt = () => turn.promise
          connection.cancel = async () => {
            turn.resolve({ stopReason: 'cancelled', tokens: null, models: [] })
          }
          return connection
        },
      },
    },
  })
  hosts.push(host)
  const port = host.connect()
  const session = await port.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await port.untilStatus(session.id, 'ready')
  await port.open(session.id)
  return {
    host,
    port,
    id: session.id,
    read,
    turn,
    setUsed: (value: number) => {
      used = value
    },
    activity: () => target.apply({ patches: [], effects: [{ kind: 'request' }] }),
    usage: (value: number) =>
      target.apply({
        patches: [
          {
            op: 'session.update',
            changes: {
              usage: {
                used: value,
                size: 200_000,
                cost: null,
                tokens: null,
              },
            },
          },
        ],
        effects: [],
      }),
    start: () =>
      port.request('sessions.prompt', {
        sessionId: session.id,
        content: [{ type: 'text', text: 'Work while reporting no token counts' }],
      }),
  }
}

describe('context snapshots over the session protocol', () => {
  it('updates a running session without opening its context popover', async () => {
    const h = await setup()
    await h.port.until(() => h.port.thread(h.id).session.usage?.used === 20_000)
    await h.start()
    h.setUsed(160_000)
    await h.port.until(() => h.port.thread(h.id).session.usage?.used === 160_000)
    expect(h.port.thread(h.id).session.context?.breakdown?.used).toBe(160_000)
    const calls = h.read.mock.calls.length
    await h.port.request('sessions.context', { sessionId: h.id })
    expect(h.read.mock.calls.length).toBe(calls)
  })

  it('keeps the last snapshot on a failed read and recovers automatically', async () => {
    const h = await setup()
    await h.port.until(() => h.port.thread(h.id).session.context?.breakdown?.used === 20_000)
    await h.start()
    h.read.mockRejectedValueOnce(new Error('Temporary context failure'))
    await h.port.until(() => !!h.port.thread(h.id).session.context?.error)
    expect(h.port.thread(h.id).session.usage?.used).toBe(20_000)
    expect(h.port.thread(h.id).session.context?.breakdown?.used).toBe(20_000)
    h.setUsed(80_000)
    await h.port.until(() => h.port.thread(h.id).session.usage?.used === 80_000)
    expect(h.port.thread(h.id).session.context?.error).toBeNull()
  })

  it('reads final changes after an in-flight read without overlapping requests', async () => {
    const h = await setup()
    await h.port.until(() => h.port.thread(h.id).session.context?.breakdown?.used === 20_000)
    const pending = deferred<ContextBreakdown>()
    h.read.mockImplementationOnce(() => pending.promise)
    await h.start()
    await h.port.until(() => h.port.thread(h.id).session.context?.loading === true)
    h.setUsed(160_000)
    h.turn.resolve({ stopReason: 'end_turn', tokens: null, models: [] })
    await h.port.untilStatus(h.id, 'ready')
    const calls = h.read.mock.calls.length
    h.activity()
    expect(h.read.mock.calls.length).toBe(calls)
    pending.resolve(breakdown(30_000))
    await h.port.until(() => h.port.thread(h.id).session.usage?.used === 160_000)
    expect(h.read.mock.calls.length).toBe(calls + 1)
  })

  it('calibrates after a failed turn and stops polling when idle', async () => {
    const h = await setup()
    await h.port.until(() => h.port.thread(h.id).session.context?.breakdown?.used === 20_000)
    await h.start()
    h.setUsed(90_000)
    h.turn.reject(new Error('Provider failed'))
    await h.port.until(() => h.port.thread(h.id).session.usage?.used === 90_000)
    const calls = h.read.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(h.read.mock.calls.length).toBe(calls)
  })

  it('coalesces activity even when numeric usage has not changed', async () => {
    const h = await setup()
    await h.port.until(() => h.port.thread(h.id).session.context?.breakdown?.used === 20_000)
    const calls = h.read.mock.calls.length
    h.setUsed(100_000)
    for (let i = 0; i < 100; i++) h.activity()
    await h.port.until(() => h.port.thread(h.id).session.usage?.used === 100_000)
    expect(h.read.mock.calls.length).toBe(calls + 1)
  })

  it('keeps newer live usage when an older context read arrives', async () => {
    const h = await setup()
    await h.port.until(() => h.port.thread(h.id).session.context?.breakdown?.used === 20_000)
    const pending = deferred<ContextBreakdown>()
    h.read.mockImplementationOnce(() => pending.promise)
    await h.start()
    await h.port.until(() => h.port.thread(h.id).session.context?.loading === true)
    h.usage(140_000)
    h.setUsed(160_000)
    pending.resolve(breakdown(30_000))
    await h.port.until(() => h.port.thread(h.id).session.context?.breakdown?.used === 30_000)
    expect(h.port.thread(h.id).session.usage?.used).toBe(140_000)
    await h.port.until(() => h.port.thread(h.id).session.usage?.used === 160_000)
  })

  it('calibrates after cancellation without requiring another click', async () => {
    const h = await setup()
    await h.port.until(() => h.port.thread(h.id).session.context?.breakdown?.used === 20_000)
    await h.start()
    h.setUsed(100_000)
    await h.port.request('sessions.cancel', { sessionId: h.id })
    await h.port.until(() => h.port.thread(h.id).session.usage?.used === 100_000)
    expect(h.port.thread(h.id).session.status).toBe('ready')
  })

  it('drops late reads and their timers after the session closes', async () => {
    const h = await setup()
    await h.port.until(() => h.port.thread(h.id).session.context?.breakdown?.used === 20_000)
    const pending = deferred<ContextBreakdown>()
    h.read.mockImplementationOnce(() => pending.promise)
    await h.start()
    await h.port.until(() => h.port.thread(h.id).session.context?.loading === true)
    await h.port.request('sessions.close', { sessionId: h.id })
    const calls = h.read.mock.calls.length
    pending.resolve(breakdown(160_000))
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(h.read.mock.calls.length).toBe(calls)
    expect(h.port.thread(h.id).session.usage?.used).toBe(20_000)
  })
})
