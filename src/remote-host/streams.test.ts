// Byte streams on a device's channel, through the real remote host and an in-process agent host:
// uploads named by requests, results' binary values sent as streams, media read from disk, and
// how streams share the channel with JSON and wait for a device that stops reading.

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostMethod } from '@shared/agent-host'
import type { PortChannel } from '@shared/port-channel'
import { BYTES_PER_FRAME } from '@shared/remote/channel'
import { generateKeyPair } from '@shared/remote/noise'
import {
  MAX_MEDIA_STREAMS,
  MAX_UPLOAD_BYTES,
  MAX_UPLOADS,
  type MediaReadParams,
  type MediaReadResult,
  type StreamRef,
} from '@shared/remote/streams'
import { startTestHost, type TestHost } from '../agent-host/testing/harness'
import { ActivityLog } from './activity'
import { DeviceStore } from './devices'
import { HIGH_WATER } from './downloads'
import { PairingCodes } from './pairing'
import { findPlaces, isBinary } from './places'
import { RemoteServer } from './server'
import { connectDevice, type TestDevice } from './testing/device'
import {
  heldTransports,
  memoryPorts,
  memoryTransports,
  type HeldTransports,
} from './testing/memory'
import { clearUploads } from './uploads'

let agent: TestHost | null = null

afterEach(async () => {
  await agent?.stop()
  agent = null
})

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

/** A PNG's signature and header, 3 by 2 pixels, and a little more. */
const PNG = new Uint8Array([
  ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  ...[0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52],
  ...[0, 0, 0, 3, 0, 0, 0, 2],
  ...[8, 6, 0, 0, 0, 1, 2, 3, 4],
])

/** An MP4's first box, then `size` bytes in all. */
function mp4(size: number): Uint8Array {
  const data = new Uint8Array(randomBytes(size))
  data.set([0, 0, 0, 0x18, ...Buffer.from('ftypisom', 'latin1')])
  return data
}

/** A digest to compare large byte arrays by, so a failure does not print megabytes. */
const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

/** What a request carries in place of a binary value; the TestPort's types want the buffer. */
const upload = (stream: number) => ({ $stream: stream }) as unknown as ArrayBuffer

async function setup(options: { held?: boolean; uploadIdleMs?: number } = {}) {
  agent = await startTestHost()
  const host = agent
  const logs: string[] = []
  const log = (level: string, message: string) => logs.push(`${level}: ${message}`)
  const devices = await DeviceStore.load(host.dir, log)
  const hostKey = await generateKeyPair()
  const phoneKey = await generateKeyPair()
  await devices.add({
    publicKey: base64(phoneKey.publicKey),
    name: 'Phone',
    kind: 'ios',
    platform: 'ios',
    model: 'iPhone 17 Pro',
  })
  const uploads = path.join(host.dir, 'remote', 'uploads')
  await clearUploads(uploads)
  // What reached the agent host from devices' ports, and what it answered on them.
  const toAgent: unknown[] = []
  const fromAgent: unknown[] = []
  const server = new RemoteServer({
    staticKey: hostKey,
    devices,
    activity: await ActivityLog.load(host.dir, log),
    pairing: new PairingCodes({ hostKey: hostKey.publicKey, addresses: () => [], send: () => {} }),
    host: { name: 'Studio', platform: process.platform, version: '0.0.0-test' },
    uploads,
    ...(options.uploadIdleMs ? { uploadIdleMs: options.uploadIdleMs } : {}),
    openAgentPort: async (device) => {
      const [remoteEnd, agentEnd] = memoryPorts()
      const recording: PortChannel = {
        ...agentEnd,
        send: (message) => {
          fromAgent.push(message)
          agentEnd.send(message)
        },
        onMessage: (listener) =>
          agentEnd.onMessage((data) => {
            toAgent.push(data)
            listener(data)
          }),
      }
      host.host.connect(recording as Parameters<typeof host.host.connect>[0], device)
      return remoteEnd
    },
    changed: () => {},
    log,
  })
  let held: HeldTransports | null = null
  const connect = async (): Promise<TestDevice> => {
    held = options.held ? heldTransports() : null
    const [deviceEnd, hostEnd] = held ? [held.device, held.host] : memoryTransports()
    server.accept(hostEnd)
    const device = await connectDevice({
      transport: deviceEnd,
      hostKey: hostKey.publicKey,
      key: phoneKey,
    })
    expect(await device.first).toMatchObject({ type: 'welcome', features: ['bytes'] })
    return device
  }
  const window = host.connect()
  await window.request('projects.add', { path: host.project })
  const project = await realpath(host.project)
  return {
    agent: host,
    server,
    uploads,
    logs,
    toAgent,
    fromAgent,
    connect,
    window,
    project,
    held: () => held!,
    uploadsLeft: () => readdir(uploads),
    methods: () => toAgent.map((message) => (message as { method?: string }).method),
  }
}

function readMedia(device: TestDevice, params: MediaReadParams): Promise<MediaReadResult> {
  return device.port.request(
    'media.read' as HostMethod,
    params as never,
  ) as Promise<MediaReadResult>
}

async function newSession(device: TestDevice, projectPath: string): Promise<string> {
  const session = await device.port.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath,
  })
  await device.port.open(session.id)
  return session.id
}

describe('uploads', () => {
  it('carry the bytes of an attachment, which come back as a stream', async () => {
    const t = await setup()
    const device = await t.connect()
    const stream = await device.upload(PNG, { chunk: 5 })
    const added = await device.port.request('attachments.add', {
      source: { bytes: upload(stream), mimeType: 'image/png', name: 'photo.png' },
      thumb: null,
    })
    expect(added).toMatchObject({ type: 'image', name: 'photo.png', size: PNG.length })
    // The agent host got the bytes in the request's place, as a window sends them.
    const request = t.toAgent.find(
      (message) => (message as { method?: string }).method === 'attachments.add',
    ) as { params: { source: { bytes: ArrayBuffer } } }
    expect(new Uint8Array(request.params.source.bytes)).toEqual(PNG)
    await expect.poll(() => t.uploadsLeft()).toEqual([])

    const read = await device.port.request('attachments.read', { id: added.id })
    const ref = read.bytes as unknown as StreamRef
    expect(read.mimeType).toBe('image/png')
    expect(ref).toEqual({ $stream: 2, size: PNG.length })
    expect(await device.download(2)).toEqual(PNG)

    // A scaled copy replaces them, named by the request before the upload ends.
    const smaller = PNG.slice(0, 24)
    const next = await device.upload(smaller, { end: false })
    const update = device.port.request('attachments.update', {
      id: added.id,
      thumb: null,
      scaled: { bytes: upload(next), mimeType: 'image/png' },
    })
    await device.send({ type: 'stream.end', stream: next })
    expect(await update).toMatchObject({ id: added.id, size: smaller.length })
    const again = await device.port.request('attachments.read', { id: added.id })
    expect(await device.download((again.bytes as unknown as StreamRef).$stream)).toEqual(smaller)
  })

  it('are refused when cancelled, unknown or named twice, and their files go', async () => {
    const t = await setup()
    const device = await t.connect()
    const add = (bytes: ArrayBuffer) =>
      device.port.request('attachments.add', {
        source: { bytes, mimeType: 'image/png', name: 'photo.png' },
        thumb: null,
      })

    // Cancelled midway, before a request names it.
    const first = await device.upload(PNG.slice(0, 10), { size: PNG.length, end: false })
    await expect.poll(() => t.uploadsLeft()).toHaveLength(1)
    await device.send({ type: 'stream.cancel', stream: first })
    await expect.poll(() => t.uploadsLeft()).toEqual([])
    await expect(add(upload(first))).rejects.toMatchObject({
      code: 'invalid_params',
      message: `Stream ${first} is no upload waiting on this connection`,
    })

    // Cancelled while a request waits for it.
    const second = await device.upload(PNG.slice(0, 10), { size: PNG.length, end: false })
    const waiting = add(upload(second))
    await device.send({ type: 'stream.cancel', stream: second })
    await expect(waiting).rejects.toMatchObject({
      code: 'invalid_params',
      message: `Upload ${second} was cancelled`,
    })

    // Named twice in one request, and by an id the device never opened.
    const third = await device.upload(PNG)
    await expect(
      device.port.request('attachments.update', {
        id: 'x',
        thumb: null,
        scaled: { bytes: upload(third), mimeType: 'image/png' },
        again: upload(third),
      } as never),
    ).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(add(upload(99))).rejects.toMatchObject({ code: 'invalid_params' })
    // None of these reached the agent host.
    expect(t.methods()).not.toContain('attachments.add')
    expect(t.methods()).not.toContain('attachments.update')
    await expect.poll(() => t.uploadsLeft()).toEqual([])
  })

  it('go when no request names them in time', async () => {
    const t = await setup({ uploadIdleMs: 100 })
    const device = await t.connect()
    const ended = await device.upload(PNG)
    const stalled = await device.upload(PNG.slice(0, 4), { size: PNG.length, end: false })
    await expect.poll(() => device.cancels.length).toBe(2)
    expect(device.cancels).toEqual([
      {
        type: 'stream.cancel',
        stream: ended,
        error: {
          code: 'invalid_params',
          message: `Upload ${ended} was not named by a request for 0.1 s`,
        },
      },
      {
        type: 'stream.cancel',
        stream: stalled,
        error: { code: 'invalid_params', message: `Upload ${stalled} got no bytes for 0.1 s` },
      },
    ])
    await expect.poll(() => t.uploadsLeft()).toEqual([])
  })

  it('are capped in size, in bytes against their size, and in number for each device', async () => {
    const t = await setup()
    const device = await t.connect()
    await device.upload(new Uint8Array(), { size: MAX_UPLOAD_BYTES + 1, end: false })
    await device.upload(new Uint8Array(5), { size: 4 })
    await device.upload(new Uint8Array(2), { size: 4 })
    await expect.poll(() => device.cancels.length).toBe(3)
    expect(device.cancels.map(({ stream, error }) => [stream, error])).toEqual([
      [1, { code: 'invalid_params', message: `An upload is at most ${MAX_UPLOAD_BYTES} bytes` }],
      [3, { code: 'invalid_params', message: 'Upload 3 carried more than its 4 bytes' }],
      [5, { code: 'invalid_params', message: 'Upload 5 ended after 2 of its 4 bytes' }],
    ])

    // The device's uploads in flight count over its connections.
    const open: number[] = []
    for (let i = 0; i < MAX_UPLOADS - 1; i++) {
      open.push(await device.upload(PNG.slice(0, 4), { size: PNG.length, end: false }))
    }
    const other = await t.connect()
    const last = await other.upload(PNG)
    const refused = await other.upload(PNG)
    await expect.poll(() => other.cancels.length).toBe(1)
    expect(other.cancels[0]).toEqual({
      type: 'stream.cancel',
      stream: refused,
      error: { code: 'busy', message: `A device may have at most ${MAX_UPLOADS} uploads at once` },
    })
    expect(t.server.uploads.of(t.server.options.devices.list()[0]!.id)).toBe(MAX_UPLOADS)
    await expect.poll(() => t.uploadsLeft()).toHaveLength(MAX_UPLOADS)

    // One named frees its place; a connection that ends takes its uploads with it.
    const added = await other.port.request('attachments.add', {
      source: { bytes: upload(last), mimeType: 'image/png', name: 'photo.png' },
      thumb: null,
    })
    expect(added.size).toBe(PNG.length)
    device.close()
    await expect.poll(() => t.uploadsLeft()).toEqual([])
    expect(t.server.uploads.of(t.server.options.devices.list()[0]!.id)).toBe(0)
    expect(t.logs).toContain(
      `warn: Device ${t.server.options.devices.list()[0]!.id}'s upload failed: ` +
        `An upload is at most ${MAX_UPLOAD_BYTES} bytes`,
    )
  })

  it('close a connection whose stream ids are not the next odd ones', async () => {
    const t = await setup()
    const backwards = await t.connect()
    await backwards.send({ type: 'stream.open', stream: 3, size: 1 })
    await backwards.send({ type: 'stream.open', stream: 1, size: 1 })
    expect(await backwards.closing).toEqual({ type: 'closing', reason: 'invalid' })
    const even = await t.connect()
    await even.send({ type: 'stream.open', stream: 2, size: 1 })
    expect(await even.closing).toEqual({ type: 'closing', reason: 'invalid' })
    await expect.poll(() => t.uploadsLeft()).toEqual([])
  })

  it('in the folder at start are deleted', async () => {
    const t = await setup()
    await writeFile(path.join(t.uploads, 'left.part'), 'x')
    await clearUploads(t.uploads)
    expect(await t.uploadsLeft()).toEqual([])
  })
})

describe('results', () => {
  it('send each binary value as a stream after the result, which the device may cancel', async () => {
    const t = await setup({ held: true })
    const device = await t.connect()
    const big = new Uint8Array(randomBytes(4 * 1024 * 1024))
    big.set(PNG)
    const stream = await device.upload(big)
    const added = await device.port.request('attachments.add', {
      source: { bytes: upload(stream), mimeType: 'image/png', name: 'big.png' },
      thumb: null,
    })
    const held = t.held()
    held.hold()
    const read = device.port.request('attachments.read', { id: added.id })
    // The device stops it before it has read any of it; the host stops sending soon after.
    await expect.poll(() => held.waiting().length).toBeGreaterThan(1)
    await device.send({ type: 'stream.cancel', stream: 2 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const sent = held.sent()
    held.release()
    expect((await read).bytes).toEqual({ $stream: 2, size: big.length })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(held.sent()).toBe(sent)
    const received = device.streams.get(2)!
    expect(received.ended).toBe(false)
    expect(received.received).toBeLessThan(big.length)
  })
})

describe('media', () => {
  it('streams a file in the project from disk, whole or in parts', async () => {
    const t = await setup()
    const device = await t.connect()
    const clip = mp4(3 * BYTES_PER_FRAME + 17)
    await writeFile(path.join(t.agent.project, 'clip.mp4'), clip)
    const sessionId = await newSession(device, t.agent.project)
    const read = (offset?: number, length?: number) =>
      readMedia(device, {
        projectPath: t.agent.project,
        path: 'clip.mp4',
        sessionId,
        ...(offset === undefined ? {} : { offset }),
        ...(length === undefined ? {} : { length }),
      })

    const whole = await read()
    expect(whole).toEqual({
      kind: 'granted',
      media: { name: 'clip.mp4', kind: 'video', mimeType: 'video/mp4', size: clip.length },
      offset: 0,
      length: clip.length,
      bytes: { $stream: 2, size: clip.length },
    })
    expect(sha(await device.download(2))).toBe(sha(clip))

    // Each part is a stream of its own, as a player asks while it seeks.
    const part = await read(1000, 70_000)
    expect(part).toMatchObject({ offset: 1000, length: 70_000, bytes: { $stream: 4 } })
    expect(await device.download(4)).toEqual(clip.slice(1000, 71_000))
    const tail = await read(clip.length - 5, 100)
    expect(tail).toMatchObject({ length: 5, bytes: { $stream: 6, size: 5 } })
    expect(await device.download(6)).toEqual(clip.slice(-5))
    expect(await read(clip.length)).toMatchObject({ length: 0, bytes: { $stream: 8, size: 0 } })
    expect(await device.download(8)).toEqual(new Uint8Array())
    await expect(read(clip.length + 1)).rejects.toMatchObject({
      code: 'invalid_params',
      message: 'offset is past the end of the file',
    })
    await expect(read(-1)).rejects.toMatchObject({ code: 'invalid_params' })

    // The agent host only checked the file; the device never heard where it is.
    const asked = t.toAgent.filter(
      (message) => (message as { method?: string }).method === 'media.authorize',
    ) as { id: number; params: unknown }[]
    expect(asked).toHaveLength(5)
    expect(asked.every(({ id }) => id < 0)).toBe(true)
    expect(t.methods()).not.toContain('media.read')
    const answers = JSON.stringify([whole, part, tail])
    expect(answers).not.toContain(t.project)
    expect(answers).not.toContain(t.agent.project)
    const binary = (message: unknown) => findPlaces({ message }, 'message', isBinary).length > 0
    expect(t.fromAgent.some(binary)).toBe(false)
    expect(t.agent.sent.some((message) => message.type === 'host:media-grant')).toBe(false)
  })

  it('lets a file outside the project through once the thread names it', async () => {
    const t = await setup()
    const device = await t.connect()
    const outside = path.join(t.agent.dir, 'elsewhere', 'shot.png')
    await mkdir(path.dirname(outside), { recursive: true })
    await writeFile(outside, PNG)
    await writeFile(path.join(t.agent.project, 'notes.txt'), 'not media')
    const sessionId = await newSession(device, t.agent.project)
    const read = (file: string) =>
      readMedia(device, { projectPath: t.agent.project, path: file, sessionId })

    expect(await read(outside)).toEqual({ kind: 'forbidden' })
    expect(await read('missing.png')).toEqual({ kind: 'not_found' })
    expect(await read('notes.txt')).toEqual({ kind: 'not_media' })
    await device.port.request('sessions.prompt', {
      sessionId,
      content: [{ type: 'text', text: `Look at ${outside}` }],
    })
    await device.port.untilEntry(sessionId, (entry) => entry.kind === 'turn_end')
    const granted = await read(outside)
    expect(granted).toMatchObject({
      kind: 'granted',
      media: { name: 'shot.png', kind: 'image', mimeType: 'image/png', width: 3, height: 2 },
    })
    const ref = (granted as Extract<MediaReadResult, { kind: 'granted' }>).bytes
    expect(await device.download(ref.$stream)).toEqual(PNG)
  })

  it('refuses media.authorize to the device, whose answer would name the file', async () => {
    const t = await setup()
    const device = await t.connect()
    const sessionId = await newSession(device, t.agent.project)
    await expect(
      device.port.request('media.authorize', {
        projectPath: t.agent.project,
        path: 'clip.mp4',
        sessionId,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    // A request with an id of the remote host's own gets nowhere either.
    await device.send({ type: 'request', id: -1, method: 'projects.list', params: undefined })
    expect(await device.port.request('projects.list', undefined)).toHaveLength(1)
    expect(t.methods().filter((method) => method === 'projects.list')).toHaveLength(1)
    expect(t.methods()).not.toContain('media.authorize')
  })

  it(`reads at most ${MAX_MEDIA_STREAMS} files at once on a connection`, async () => {
    const t = await setup({ held: true })
    const device = await t.connect()
    const clip = mp4(HIGH_WATER * 2)
    await writeFile(path.join(t.agent.project, 'clip.mp4'), clip)
    const sessionId = await newSession(device, t.agent.project)
    const read = () =>
      readMedia(device, { projectPath: t.agent.project, path: 'clip.mp4', sessionId })
    const held = t.held()
    held.hold()
    const reads = Array.from({ length: MAX_MEDIA_STREAMS + 1 }, read)
    const settled = Promise.allSettled(reads)
    // Every answer waits behind the first streams the device does not read.
    await expect
      .poll(() => held.waiting().filter((length) => length < 4096).length)
      .toBeGreaterThanOrEqual(MAX_MEDIA_STREAMS + 1)
    held.release()
    const results = await settled
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(
      MAX_MEDIA_STREAMS,
    )
    expect(results.at(-1)).toMatchObject({ status: 'rejected', reason: { code: 'busy' } })
    for (let stream = 2; stream <= 2 * MAX_MEDIA_STREAMS; stream += 2) {
      expect(sha(await device.download(stream))).toBe(sha(clip))
    }
    expect(await read()).toMatchObject({ kind: 'granted' })
  })
})

describe('pacing', () => {
  it('lets an event through while a long stream is sending', async () => {
    const t = await setup({ held: true })
    const device = await t.connect()
    const clip = mp4(16 * 1024 * 1024)
    await writeFile(path.join(t.agent.project, 'clip.mp4'), clip)
    const sessionId = await newSession(device, t.agent.project)
    const held = t.held()
    const changes = () => device.port.events.filter((e) => e.type === 'projects.changed').length
    const before = changes()
    // Held, the stream waits once the transport holds a little, and the event goes out behind
    // that little, not behind the whole file.
    held.hold()
    const reading = readMedia(device, { projectPath: t.agent.project, path: 'clip.mp4', sessionId })
    await expect.poll(() => held.waiting().some((length) => length > 4096)).toBe(true)
    const other = path.join(t.agent.dir, 'other')
    await mkdir(other)
    await t.window.request('projects.add', { path: other })
    await expect.poll(() => (held.waiting().at(-1) ?? Infinity) < 4096).toBe(true)
    held.release()
    await reading
    await device.port.until(() => changes() > before)
    const stream = device.streams.get(2)!
    expect(stream.ended).toBe(false)
    expect(stream.received).toBeLessThan(clip.length / 2)
    expect(sha(await device.download(2))).toBe(sha(clip))
  })

  it('stops a stream after a bounded buffer while the device does not read', async () => {
    const t = await setup({ held: true })
    const device = await t.connect()
    const clip = mp4(8 * 1024 * 1024)
    await writeFile(path.join(t.agent.project, 'clip.mp4'), clip)
    const sessionId = await newSession(device, t.agent.project)
    const held = t.held()
    held.hold()
    const before = held.sent()
    const reading = readMedia(device, { projectPath: t.agent.project, path: 'clip.mp4', sessionId })
    // Whatever goes on going, it never gets past the high water and a frame or two.
    let last = -1
    await expect
      .poll(async () => {
        const now = held.sent()
        const settled = now === last && now > before
        last = now
        return settled
      })
      .toBe(true)
    expect(held.sent() - before).toBeLessThan(HIGH_WATER + 3 * (BYTES_PER_FRAME + 1024))
    held.release()
    expect(await reading).toMatchObject({ kind: 'granted', length: clip.length })
    expect(sha(await device.download(2))).toBe(sha(clip))
  })
})
