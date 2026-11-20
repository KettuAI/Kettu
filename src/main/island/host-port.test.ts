import { expect, it } from 'vitest'
import type { HostEvent } from '@shared/agent-host'
import { ISLAND_HOST_METHODS } from './host-feed'
import { IslandHostPort, type IslandPort } from './host-port'

function port() {
  const posted: { id: number; method: string; params: unknown }[] = []
  let deliver: ((event: { data: unknown }) => void) | null = null
  let close: (() => void) | null = null
  const fake: IslandPort = {
    postMessage: (message) => posted.push(message as (typeof posted)[number]),
    on: ((event: string, listener: never) => {
      if (event === 'message') deliver = listener
      else close = listener
    }) as IslandPort['on'],
    start: () => {},
    close: () => close?.(),
  }
  return { fake, posted, deliver: (data: unknown) => deliver!({ data }), close: () => close!() }
}

it('asks the host only for the island’s methods', async () => {
  const p = port()
  const events: HostEvent[] = []
  const client = new IslandHostPort(
    p.fake,
    (event) => events.push(event),
    () => {},
  )
  const refused = [
    'sessions.show',
    'sessions.snapshot',
    'sessions.prompt',
    'git.status',
    'tasks.get',
  ]
  for (const method of [...refused, 'tasks.start', 'tasks.sessions']) {
    await expect(client.request(method as never, {} as never)).rejects.toMatchObject({
      code: 'forbidden',
    })
  }
  expect(p.posted).toEqual([])
  expect(ISLAND_HOST_METHODS).toEqual([
    'agents.list',
    'agents.options',
    'agents.refreshLimits',
    'sessions.list',
    'sessions.requests',
    'tasks.list',
    'permissions.respond',
    'browser.answerOrigin',
    'computer.answerApp',
  ])

  const listed = client.request('sessions.list', {})
  expect(p.posted).toEqual([{ type: 'request', id: 1, method: 'sessions.list', params: {} }])
  p.deliver({ type: 'response', id: 1, result: [] })
  await expect(listed).resolves.toEqual([])
  p.deliver({ type: 'event', event: { type: 'session.removed', sessionId: 's' } })
  expect(events).toEqual([{ type: 'session.removed', sessionId: 's' }])
})

it('fails what waits once the host’s port closes, and every request after', async () => {
  const p = port()
  let closed = 0
  const client = new IslandHostPort(
    p.fake,
    () => {},
    () => closed++,
  )
  const waiting = client.request('agents.list', undefined)
  p.close()
  await expect(waiting).rejects.toMatchObject({ code: 'host_restarted' })
  await expect(client.request('agents.list', undefined)).rejects.toMatchObject({
    code: 'host_restarted',
  })
  expect(closed).toBe(1)
})
