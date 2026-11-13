import { describe, expect, it } from 'vitest'
import type { PortChannel } from '@shared/port-channel'
import type { PortDevice } from '@shared/remote/device'
import { DEVICE_RUNNING, DEVICE_WAITING, PortHub, type Handlers, type Validators } from './rpc'

const DEVICE: PortDevice = { id: 'a'.repeat(32), name: 'Phone' }

interface Answer {
  type: string
  id: number
  result?: unknown
  error?: { code: string }
}

class FakePort implements PortChannel<unknown> {
  readonly sent: Answer[] = []
  private listener: ((data: unknown) => void) | null = null
  send(message: unknown): void {
    this.sent.push(message as Answer)
  }
  onMessage(listener: (data: unknown) => void): void {
    this.listener = listener
  }
  onClose(): void {}
  close(): void {}
  request(id: number, method: string, params: unknown): void {
    this.listener?.({ type: 'request', id, method, params })
  }
  answer(id: number): Answer | undefined {
    return this.sent.find((message) => message.id === id)
  }
}

/** A handler per method that waits until released, counting its calls. */
function hub(): {
  hub: PortHub
  calls: { method: string; params: unknown }[]
  release: (index?: number) => void
} {
  const calls: { method: string; params: unknown }[] = []
  const waiting: (() => void)[] = []
  const handler = (method: string) => (params: unknown) => {
    calls.push({ method, params })
    return new Promise((resolve) =>
      waiting.push(() => resolve({ method, params, n: calls.length })),
    )
  }
  const handlers = new Proxy({} as Handlers, { get: (_, method: string) => handler(method) })
  const validators = new Proxy({} as Validators, { get: () => (params: unknown) => params })
  return {
    hub: new PortHub({ handlers, validators, closed: () => {}, log: () => {} }),
    calls,
    release: (index = 0) => waiting.splice(index, 1)[0]?.(),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const SUMMARY = { dayStarts: [1, 2, 3], from: 1, to: 4, scope: 'computer' }

describe("a paired device's requests", () => {
  it('share one answer while the same read with the same params is in flight', async () => {
    const { hub: h, calls, release } = hub()
    const port = new FakePort()
    h.add(port, DEVICE)
    for (let id = 1; id <= 25; id++) port.request(id, 'usage.summary', SUMMARY)
    await settle()
    expect(calls).toHaveLength(1)
    release()
    await settle()
    expect(port.sent).toHaveLength(25)
    const first = port.answer(1)!.result
    for (let id = 1; id <= 25; id++) {
      expect(port.answer(id)).toMatchObject({ type: 'response', id, result: first })
    }
    // Once answered, the same read runs again.
    port.request(26, 'usage.summary', SUMMARY)
    await settle()
    expect(calls).toHaveLength(2)
  })

  it('run apart when their params differ, and actions always run', async () => {
    const { hub: h, calls } = hub()
    const port = new FakePort()
    h.add(port, DEVICE)
    port.request(1, 'usage.summary', SUMMARY)
    port.request(2, 'usage.summary', { ...SUMMARY, to: 5 })
    port.request(3, 'sessions.rename', { sessionId: 's', title: 't' })
    port.request(4, 'sessions.rename', { sessionId: 's', title: 't' })
    await settle()
    expect(calls.map((call) => call.method)).toEqual([
      'usage.summary',
      'usage.summary',
      'sessions.rename',
      'sessions.rename',
    ])
  })

  it('run at most a bounded number at once, the rest in the order they came', async () => {
    const { hub: h, calls, release } = hub()
    const port = new FakePort()
    h.add(port, DEVICE)
    for (let id = 1; id <= DEVICE_RUNNING + 3; id++) {
      port.request(id, 'usage.summary', { ...SUMMARY, to: 10 + id })
    }
    await settle()
    expect(calls).toHaveLength(DEVICE_RUNNING)
    release()
    await settle()
    expect(calls).toHaveLength(DEVICE_RUNNING + 1)
    expect(calls.at(-1)!.params).toMatchObject({ to: 10 + DEVICE_RUNNING + 1 })
    expect(port.answer(1)).toMatchObject({ type: 'response' })
  })

  it('leave long operations out of the bound, so they never hold the rest back', async () => {
    const { hub: h, calls } = hub()
    const port = new FakePort()
    h.add(port, DEVICE)
    for (let id = 1; id <= DEVICE_RUNNING; id++) {
      port.request(id, 'agents.install', { harnessId: 'codex', id })
    }
    port.request(100, 'usage.summary', SUMMARY)
    await settle()
    expect(calls).toHaveLength(DEVICE_RUNNING + 1)
    expect(calls.at(-1)!.method).toBe('usage.summary')
  })

  it('are refused as busy past the bound of those waiting, with the code clients know', async () => {
    const { hub: h } = hub()
    const port = new FakePort()
    h.add(port, DEVICE)
    const total = DEVICE_RUNNING + DEVICE_WAITING + 2
    for (let id = 1; id <= total; id++) port.request(id, 'usage.summary', { ...SUMMARY, to: id })
    await settle()
    const busy = port.sent.filter((message) => message.error?.code === 'busy')
    expect(busy.map((message) => message.id)).toEqual([total - 1, total])
  })

  it("leave a window's requests as they are", async () => {
    const { hub: h, calls } = hub()
    const port = new FakePort()
    h.add(port)
    for (let id = 1; id <= DEVICE_RUNNING + 5; id++) port.request(id, 'usage.summary', SUMMARY)
    await settle()
    expect(calls).toHaveLength(DEVICE_RUNNING + 5)
  })

  it('do not hold back another device', async () => {
    const { hub: h, calls } = hub()
    const phone = new FakePort()
    const tablet = new FakePort()
    h.add(phone, DEVICE)
    h.add(tablet, { id: 'b'.repeat(32), name: 'Tablet' })
    for (let id = 1; id <= DEVICE_RUNNING + 2; id++) {
      phone.request(id, 'usage.summary', { ...SUMMARY, to: id })
    }
    tablet.request(1, 'usage.summary', SUMMARY)
    await settle()
    expect(calls).toHaveLength(DEVICE_RUNNING + 1)
  })
})
