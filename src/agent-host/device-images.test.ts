import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import type { HostEvent } from '@shared/agent-host'
import type { PortDevice } from '@shared/remote/device'
import { PortHub, type Handlers, type Validators } from './rpc'
import { startTestHost, TestPort, type TestHost } from './testing/harness'
import { tempFolder } from './testing/temp'

const hosts: TestHost[] = []
let dir: string | null = null

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  dir = null
})

const DEVICE = { id: 'a'.repeat(32), name: 'Phone' }

/** Every image ref a value holds. */
function imagesIn(
  value: unknown,
  found: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const item of value) imagesIn(item, found)
  else if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    if (record.kind === 'image') found.push(record)
    for (const item of Object.values(record)) imagesIn(item, found)
  }
  return found
}

function patchesOf(port: TestPort, sessionId: string): HostEvent[] {
  return port.events.filter(
    (event) => event.type === 'session.patches' && event.batch.sessionId === sessionId,
  )
}

it('gives a device without image refs the bytes of a stored image, never its hash', async () => {
  dir = await tempFolder('kettu-device-images-')
  const first = await startTestHost({ userDataPath: dir, sessionTimings: { checkpointMs: 10 } })
  hosts.push(first)
  const window = first.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: first.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  // Large enough for the thread store to keep it apart, by hash.
  const data = randomBytes(30_000).toString('base64')
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [
      { type: 'text', text: '/error --silent' },
      { type: 'ref', ref: { kind: 'image', mimeType: 'image/png', data } },
    ],
  })
  await window.untilEntry(id, (entry) => entry.kind === 'notice' && entry.cause === 'turn_failed')
  await window.until(() => window.events.some((event) => event.type === 'session.returned'))
  await window.request('sessions.takeReturned', { sessionId: id })
  await first.stop()
  hosts.splice(0)

  // After a restart the thread comes back from the store, its image by hash, and Retry sends the
  // message again, which fails again and comes back to the device that sent it.
  const second = await startTestHost({ userDataPath: dir, sessionTimings: { checkpointMs: 10 } })
  hosts.push(second)
  const phone = second.connect(DEVICE)
  const opened = await phone.open(id)
  expect(imagesIn(opened.entries).map((image) => image.data)).toEqual([data])
  await phone.request('sessions.retry', { sessionId: id })
  await phone.until(() => phone.events.some((event) => event.type === 'session.returned'))
  const returned = await phone.request('sessions.takeReturned', { sessionId: id })

  const images = [...imagesIn(returned), ...imagesIn(patchesOf(phone, id))]
  expect(images.length).toBeGreaterThan(0)
  for (const image of images) expect(image).toEqual({ kind: 'image', mimeType: 'image/png', data })
})

it('names no stored image by hash to a device that did not say it reads them', async () => {
  const hash = 'b'.repeat(64)
  const stored = { kind: 'image', mimeType: 'image/png', blob: hash }
  const message = [{ type: 'ref', ref: stored }]
  const hub = new PortHub({
    handlers: {
      'sessions.takeReturned': () => [{ sessionId: 's', content: message }],
    } as unknown as Handlers,
    validators: { 'sessions.takeReturned': (params: unknown) => params } as unknown as Validators,
    closed: () => {},
    log: () => {},
  })
  const connect = (device: PortDevice | null) => {
    const port = new TestPort()
    hub.add(port, device)
    return port
  }
  const window = connect(null)
  const desktop = connect({ id: 'c'.repeat(32), name: 'Laptop', imageRefs: true })
  const phone = connect(DEVICE)
  const event: HostEvent = {
    type: 'session.patches',
    batch: {
      sessionId: 's',
      seq: 1,
      patches: [{ op: 'entry.add', entry: { kind: 'user', id: 'u', content: message } as never }],
    },
  }
  hub.broadcast(event)
  hub.send(['port-1', 'port-2', 'port-3'], event)
  const answers = await Promise.all(
    [window, desktop, phone].map((port) => port.request('sessions.takeReturned', {})),
  )

  for (const port of [window, desktop]) expect(imagesIn(port.events)).toEqual([stored, stored])
  expect(imagesIn(phone.events)).toEqual([])
  expect(JSON.stringify(phone.events)).not.toContain(hash)
  expect(phone.events.map((sent) => JSON.stringify(sent))).toEqual(
    Array(2).fill(
      JSON.stringify(event).replace(
        JSON.stringify(stored),
        JSON.stringify({ kind: 'unsupported', label: 'image/png' }),
      ),
    ),
  )
  expect(imagesIn(answers[0])).toEqual([stored])
  expect(imagesIn(answers[1])).toEqual([stored])
  expect(answers[2]).toEqual([
    {
      sessionId: 's',
      content: [{ type: 'ref', ref: { kind: 'unsupported', label: 'image/png' } }],
    },
  ])
})
