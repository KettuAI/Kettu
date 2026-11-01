// Device sessions that outlive their connection, from protocol version 2: resuming on another
// connection with the token of the last welcome, what waits meanwhile, acknowledgements, the
// device's pace, and what the host drops for a device that falls behind. The agent host is a port
// the test answers itself.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PortChannel } from '@shared/port-channel'
import { BYTES_PER_FRAME } from '@shared/remote/channel'
import { generateKeyPair, type KeyPair } from '@shared/remote/noise'
import type { Welcome } from '@shared/remote/protocol'
import { ActivityLog } from './activity'
import { DeviceStore } from './devices'
import type { OutboxLimits } from './outbox'
import { PairingCodes } from './pairing'
import { RemoteServer } from './server'
import { connectDevice, type TestDevice } from './testing/device'
import { memoryPorts, memoryTransports } from './testing/memory'
import { clearUploads } from './uploads'

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

const V2 = { protocol: { min: 1, max: 2 } }

let dirs: string[] = []
let servers: RemoteServer[] = []

afterEach(async () => {
  // Stopped first, so nothing is written into a folder being removed.
  await Promise.all(servers.map((server) => server.stop('stopping')))
  servers = []
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  dirs = []
})

/** The agent host's end of a device's port, which the test speaks for. */
interface AgentEnd {
  port: PortChannel
  received: unknown[]
  closed: boolean
}

async function setup(options: { resumeMs?: number; limits?: Partial<OutboxLimits> } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-resume-'))
  dirs.push(dir)
  const log = () => {}
  const devices = await DeviceStore.load(dir, log)
  const activity = await ActivityLog.load(dir, log)
  const hostKey = await generateKeyPair()
  const keys: Record<string, KeyPair> = {}
  for (const name of ['Phone', 'iPad']) {
    keys[name] = await generateKeyPair()
    await devices.add({
      publicKey: base64(keys[name].publicKey),
      name,
      kind: 'ios',
      platform: 'ios',
      model: name,
    })
  }
  const uploads = path.join(dir, 'uploads')
  await clearUploads(uploads)
  const agents: AgentEnd[] = []
  const server = new RemoteServer({
    staticKey: hostKey,
    devices,
    activity,
    pairing: new PairingCodes({ hostKey: hostKey.publicKey, addresses: () => [], send: () => {} }),
    host: { name: 'Studio', platform: process.platform, version: '0.0.0-test' },
    uploads,
    openAgentPort: async () => {
      const [remoteEnd, agentEnd] = memoryPorts()
      const agent: AgentEnd = { port: agentEnd, received: [], closed: false }
      agentEnd.onMessage((data) => agent.received.push(data))
      agentEnd.onClose(() => (agent.closed = true))
      agents.push(agent)
      return remoteEnd
    },
    changed: () => {},
    log,
    ...(options.resumeMs ? { resumeMs: options.resumeMs } : {}),
    ...(options.limits ? { outboxLimits: options.limits } : {}),
  })
  servers.push(server)
  const connect = async (
    hello: Record<string, unknown> = V2,
    { device = 'Phone', acks = true, received = 0 } = {},
  ): Promise<{ device: TestDevice; welcome: Welcome; drop: () => Promise<void> }> => {
    const [deviceEnd, hostEnd] = memoryTransports()
    const closed = new Promise<void>((resolve) => hostEnd.onClose(resolve))
    server.accept(hostEnd)
    const connected = await connectDevice({
      transport: deviceEnd,
      hostKey: hostKey.publicKey,
      key: keys[device]!,
      hello,
      acks,
      received,
    })
    const welcome = (await connected.first) as Welcome
    return {
      device: connected,
      welcome,
      // The network goes: the device's end closes, and the host notices.
      drop: async () => {
        connected.close()
        await closed
      },
    }
  }
  const resume = (token: string, received: number, extra: { acks?: boolean } = {}) =>
    connect({ ...V2, resume: { token, received } }, { ...extra, received })
  return { server, agents, connect, resume }
}

const event = (n: number) => ({ type: 'event', event: { type: 'usage.status', status: { n } } })
const patches = (sessionId: string, seq: number) => ({
  type: 'event',
  event: {
    type: 'session.patches',
    batch: { sessionId, seq, patches: [{ op: 'entry.appendText', id: 'e:1', text: `${seq}` }] },
  },
})
const summary = (id: string, status: string) => ({
  type: 'event',
  event: { type: 'session.summary', summary: { id, status } },
})

describe('a device session of version 2', () => {
  it('resumes on another connection within the minute, with what it missed in order', async () => {
    const t = await setup()
    const first = await t.connect()
    expect(first.welcome).toMatchObject({ protocol: 2, resume: expect.any(String) })
    expect(first.welcome.resumed).toBeUndefined()
    const agent = t.agents[0]!
    agent.port.send(event(1))
    await expect.poll(() => first.device.messages).toEqual([event(1)])

    await first.drop()
    expect(t.server.online()).toEqual([])
    agent.port.send(event(2))
    agent.port.send(event(3))

    const second = await t.resume(first.welcome.resume!, first.device.received())
    expect(second.welcome.resumed).toEqual({ request: 0 })
    expect(second.welcome.resume).not.toBe(first.welcome.resume)
    await expect.poll(() => second.device.messages).toEqual([event(2), event(3)])
    expect(t.agents).toHaveLength(1)
    expect(agent.closed).toBe(false)
    expect(t.server.online()).toHaveLength(1)
  })

  it('sends again what the device did not acknowledge, from where it says it is', async () => {
    const t = await setup()
    const first = await t.connect(V2, { acks: false })
    const agent = t.agents[0]!
    for (let n = 1; n <= 3; n++) agent.port.send(event(n))
    await expect.poll(() => first.device.received()).toBe(3)
    await first.drop()

    // The third was lost on the way.
    const second = await t.resume(first.welcome.resume!, 2)
    await expect.poll(() => second.device.messages).toEqual([event(3)])
  })

  it('takes the session over from a connection the host still thinks is up', async () => {
    const t = await setup()
    const first = await t.connect()
    const firstClosed = first.device.closing
    const second = await t.resume(first.welcome.resume!, first.device.received())
    expect(second.welcome.resumed).toEqual({ request: 0 })
    expect(await firstClosed).toBeNull()
    t.agents[0]!.port.send(event(1))
    await expect.poll(() => second.device.messages).toEqual([event(1)])
    expect(first.device.messages).toEqual([])
  })

  it('says the last request it read, and answers ones it read after the drop', async () => {
    const t = await setup()
    const first = await t.connect()
    const agent = t.agents[0]!
    await first.device.send({ type: 'request', id: 1, method: 'sessions.list', params: {} })
    await first.device.send({ type: 'request', id: 2, method: 'projects.list', params: {} })
    await expect.poll(() => agent.received).toHaveLength(2)
    await first.drop()
    agent.port.send({ type: 'response', id: 2, result: ['answered while away'] })

    const second = await t.resume(first.welcome.resume!, first.device.received())
    expect(second.welcome.resumed).toEqual({ request: 2 })
    await expect
      .poll(() => second.device.messages)
      .toEqual([{ type: 'response', id: 2, result: ['answered while away'] }])
  })

  it('ends a minute after the drop, as closing a window, and the next hello opens a new one', async () => {
    const t = await setup({ resumeMs: 50 })
    const first = await t.connect()
    await first.drop()
    await expect.poll(() => t.agents[0]!.closed).toBe(true)

    const second = await t.resume(first.welcome.resume!, first.device.received())
    expect(second.welcome.resumed).toBeUndefined()
    expect(second.welcome.resume).toEqual(expect.any(String))
    expect(t.agents).toHaveLength(2)
  })

  it('takes a token once', async () => {
    const t = await setup()
    const first = await t.connect()
    await first.drop()
    const second = await t.resume(first.welcome.resume!, 0)
    expect(second.welcome.resumed).toEqual({ request: 0 })
    await second.drop()
    const third = await t.resume(first.welcome.resume!, 0)
    expect(third.welcome.resumed).toBeUndefined()
    expect(t.agents).toHaveLength(2)
  })

  it("never resumes another device's session", async () => {
    const t = await setup()
    const phone = await t.connect()
    await phone.drop()
    const ipad = await t.connect(
      { ...V2, resume: { token: phone.welcome.resume!, received: 0 } },
      {
        device: 'iPad',
      },
    )
    expect(ipad.welcome.resumed).toBeUndefined()
    expect(ipad.welcome.device.name).toBe('iPad')
    expect(t.agents).toHaveLength(2)
  })

  it('starts anew when the device says it received what the host never sent', async () => {
    const t = await setup()
    const first = await t.connect()
    await first.drop()
    const second = await t.resume(first.welcome.resume!, 5)
    expect(second.welcome.resumed).toBeUndefined()
    await expect.poll(() => t.agents[0]!.closed).toBe(true)
  })

  it('goes on with a download where the dropped connection left it', async () => {
    const t = await setup()
    const first = await t.connect(V2, { acks: false })
    const agent = t.agents[0]!
    const bytes = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251)
    agent.port.send({ type: 'response', id: 1, result: { data: bytes.buffer } })
    // A device that stops acknowledging gets about as much as the window holds.
    await expect.poll(() => first.device.received()).toBeGreaterThan(1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const stream = first.device.streams.get(2)!
    expect(stream.received).toBeLessThan(bytes.length)
    expect(stream.received).toBeLessThanOrEqual(1024 * 1024 + BYTES_PER_FRAME)
    await first.drop()

    const second = await t.resume(first.welcome.resume!, first.device.received())
    const rest = await second.device.download(2)
    expect(Buffer.concat([...stream.parts, rest])).toEqual(Buffer.from(bytes))
  })

  it('drops the patches of a device that falls behind, keeps the latest summaries, asks to resync', async () => {
    const t = await setup({ limits: { inFlight: 2, queued: 8 } })
    const slow = await t.connect(V2, { acks: false })
    const agent = t.agents[0]!
    agent.port.send(summary('a', 'running'))
    for (let seq = 1; seq <= 4; seq++) {
      agent.port.send(patches('a', seq))
      agent.port.send(summary('b', `step ${seq}`))
    }
    for (let seq = 1; seq <= 4; seq++) agent.port.send(summary('a', `step ${seq}`))
    // Everything reaches the host before the device reads on.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(slow.device.received()).toBe(2)
    await slow.device.ack()
    await expect.poll(() => slow.device.received()).toBeGreaterThan(2)
    for (let n = 0; n < 4; n++) {
      await slow.device.ack()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const after = slow.device.messages.slice(2)
    expect(after).toContainEqual({ type: 'resync' })
    expect(after).toContainEqual(summary('b', 'step 4'))
    expect(after).toContainEqual(summary('a', 'step 4'))
    expect(after).not.toContainEqual(summary('b', 'step 3'))
    expect(after.some((message) => JSON.stringify(message).includes('session.patches'))).toBe(false)
  })

  it('falls behind alone: another device gets everything at once', async () => {
    const t = await setup({ limits: { inFlight: 4 } })
    const slow = await t.connect(V2, { acks: false })
    const quick = await t.connect(V2, { device: 'iPad' })
    for (let n = 1; n <= 50; n++) {
      for (const agent of t.agents) agent.port.send(event(n))
    }
    await expect.poll(() => quick.device.messages).toHaveLength(50)
    expect(slow.device.messages).toHaveLength(4)
  })

  it('ends the session of a device behind further than even that', async () => {
    const t = await setup({ limits: { inFlight: 1, queued: 2, kept: 4 } })
    const slow = await t.connect(V2, { acks: false })
    const agent = t.agents[0]!
    for (let id = 1; id <= 6; id++) agent.port.send({ type: 'response', id, result: null })
    expect(await slow.device.closing).toBeNull()
    await expect.poll(() => agent.closed).toBe(true)
    const again = await t.resume(slow.welcome.resume!, slow.device.received())
    expect(again.welcome.resumed).toBeUndefined()
  })

  it('merges patches at the pace the device asks for', async () => {
    const t = await setup()
    const first = await t.connect()
    await first.device.send({ type: 'pace', ms: 100 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const agent = t.agents[0]!
    for (let seq = 1; seq <= 5; seq++) agent.port.send(patches('a', seq))
    await expect.poll(() => first.device.messages).toHaveLength(2)
    expect(first.device.messages[0]).toEqual(patches('a', 1))
    expect(first.device.messages[1]).toMatchObject({
      event: {
        batch: {
          sessionId: 'a',
          from: 2,
          seq: 5,
          patches: [{ op: 'entry.appendText', text: '2345' }],
        },
      },
    })
  })
})

describe('a device session of version 1', () => {
  it('ends with its connection and gets no token', async () => {
    const t = await setup()
    const first = await t.connect({})
    expect(first.welcome.protocol).toBe(1)
    expect(first.welcome).not.toHaveProperty('resume')
    await first.drop()
    await expect.poll(() => t.agents[0]!.closed).toBe(true)
  })
})
