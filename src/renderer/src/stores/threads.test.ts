import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostMethod } from '@shared/agent-host'
import type { SessionSnapshot, SessionView, ThreadEntry } from '@shared/thread'

const request = vi.fn()
let frames: FrameRequestCallback[] = []
vi.stubGlobal('window', { overbench: { agents: { request } } })
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
  frames.push(callback)
  return frames.length
})
vi.stubGlobal('cancelAnimationFrame', () => {
  frames = []
})

const { focusSession, loadOlder, receiveBatch, useThreadsStore } = await import('./threads')

const session = { id: 's1', status: 'closed' } as SessionView
const user = (id: string): ThreadEntry => ({ kind: 'user', id, content: [] })
const agent = (id: string, markdown = ''): ThreadEntry => ({
  kind: 'agent',
  id,
  markdown,
  attachments: [],
  streaming: false,
})

const snapshot = (entries: ThreadEntry[], older: number | null): SessionSnapshot => ({
  session,
  entries,
  seq: 1,
  older,
  plan: null,
})

function answer(handlers: Partial<Record<HostMethod, (params: never) => unknown>>) {
  request.mockImplementation((method: HostMethod, params: never) =>
    Promise.resolve(handlers[method]?.(params)),
  )
}

const replica = () => useThreadsStore.getState().replicas.s1!
const order = () => replica().state!.order
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  request.mockReset()
  frames = []
  useThreadsStore.setState({ replicas: {} })
})

describe('older pages', () => {
  it('opens on the latest page and prepends older ones', async () => {
    answer({
      'sessions.open': () => snapshot([user('e:3'), agent('e:4')], 3),
      'sessions.page': () => ({ entries: [user('e:1'), agent('e:2')], older: null }),
    })
    await focusSession('s1')
    expect(order()).toEqual(['e:3', 'e:4'])
    expect(replica().older).toBe(3)

    loadOlder('s1')
    expect(replica().loadingOlder).toBe(true)
    loadOlder('s1')
    await settle()
    expect(request).toHaveBeenCalledWith('sessions.page', { sessionId: 's1', before: 3 })
    expect(request.mock.calls.filter(([method]) => method === 'sessions.page')).toHaveLength(1)
    expect(order()).toEqual(['e:1', 'e:2', 'e:3', 'e:4'])
    expect(replica()).toMatchObject({ older: null, loadingOlder: false })
  })

  it('applies the patches sent before a page first, and skips those for entries not loaded', async () => {
    answer({ 'sessions.open': () => snapshot([user('e:3'), agent('e:4')], 3) })
    await focusSession('s1')
    receiveBatch({
      sessionId: 's1',
      seq: 2,
      patches: [
        { op: 'entry.appendText', id: 'e:2', text: 'changed on an older page' },
        { op: 'entry.add', entry: agent('e:5') },
      ],
    })
    answer({ 'sessions.page': () => ({ entries: [agent('e:2', 'as patched')], older: 1 }) })
    loadOlder('s1')
    await settle()
    expect(order()).toEqual(['e:2', 'e:3', 'e:4', 'e:5'])
    expect(replica().state!.byId['e:2']).toMatchObject({ markdown: 'as patched' })
    expect(replica().seq).toBe(2)
  })

  it('refetches from the oldest loaded page after a gap', async () => {
    answer({ 'sessions.open': () => snapshot([user('e:3')], 3) })
    await focusSession('s1')
    answer({ 'sessions.snapshot': () => snapshot([user('e:3'), agent('e:4')], 3) })
    receiveBatch({ sessionId: 's1', seq: 5, patches: [] })
    frames.shift()!(0)
    await settle()
    expect(request).toHaveBeenCalledWith('sessions.snapshot', { sessionId: 's1', from: 3 })
    expect(order()).toEqual(['e:3', 'e:4'])
  })
})
