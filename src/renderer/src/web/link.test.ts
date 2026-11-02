// The web client's connection against the real remote host in process, running the fake agent:
// pairing with a code, the host protocol with uploads and downloads, reconnecting and resuming,
// acknowledgements, and removal.

import { realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PortChannel } from '@shared/port-channel'
import type { KeepaliveTimings } from '@shared/remote/keepalive'
import { generateKeyPair, type KeyPair } from '@shared/remote/noise'
import { parsePairingLink, type PairingPayload, type PairingState } from '@shared/remote/pairing'
import type { Transport } from '@shared/remote/transport'
import { startTestHost, type TestHost } from '../../../agent-host/testing/harness'
import { ActivityLog } from '../../../remote-host/activity'
import { DeviceStore } from '../../../remote-host/devices'
import { PairingCodes } from '../../../remote-host/pairing'
import type { OutboxLimits } from '../../../remote-host/outbox'
import { RemoteServer } from '../../../remote-host/server'
import { clearUploads } from '../../../remote-host/uploads'
import {
  hangingTransports,
  memoryPorts,
  type HangingTransports,
} from '../../../remote-host/testing/memory'
import { hello, HostLink, type LinkState } from './link'
import { pair, type PairProgress } from './pair'

const CLIENT = { kind: 'web', version: '0.0.0-test', platform: 'Mac' }
const DEVICE = { name: 'Safari · Mac', model: 'Safari' }

const PNG = new Uint8Array([
  ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  ...[0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52],
  ...[0, 0, 0, 3, 0, 0, 0, 2],
  ...[8, 6, 0, 0, 0, 1, 2, 3, 4],
])

let agent: TestHost | null = null
const links: HostLink[] = []

afterEach(async () => {
  for (const link of links.splice(0)) link.stop()
  await agent?.stop()
  agent = null
})

async function setup(options: { resumeMs?: number; limits?: Partial<OutboxLimits> } = {}) {
  agent = await startTestHost()
  const log = () => {}
  const devices = await DeviceStore.load(agent.dir, log)
  const activity = await ActivityLog.load(agent.dir, log)
  const hostKey = await generateKeyPair()
  const heard: PairingState[] = []
  const pairing = new PairingCodes({
    hostKey: hostKey.publicKey,
    addresses: () => [{ host: '192.168.1.8', port: 47821 }],
    send: (_, state) => heard.push(state),
  })
  const host = agent.host
  const uploads = path.join(agent.dir, 'remote', 'uploads')
  await clearUploads(uploads)
  // In the list before the browser connects, as the window would have added it.
  await agent.connect().request('projects.add', { path: agent.project })
  const project = await realpath(agent.project)
  let agentPorts = 0
  const server = new RemoteServer({
    staticKey: hostKey,
    devices,
    activity,
    pairing,
    host: { name: 'Studio', platform: 'darwin', version: '0.0.0-test' },
    uploads,
    openAgentPort: async (device) => {
      agentPorts++
      const [remoteEnd, agentEnd] = memoryPorts()
      host.connect(agentEnd as Parameters<typeof host.connect>[0], device)
      return remoteEnd as PortChannel
    },
    changed: () => {},
    log,
    ...(options.resumeMs ? { resumeMs: options.resumeMs } : {}),
    ...(options.limits ? { outboxLimits: options.limits } : {}),
  })
  // Every connection the page dials, each one's host end kept to cut it.
  const hostEnds: Transport[] = []
  const wires: HangingTransports[] = []
  // While the host's process is stopped, the dials that wait for it to answer.
  let stopped: (() => void)[] | null = null
  const dial = async (): Promise<Transport> => {
    if (stopped) await new Promise<void>((resolve) => stopped!.push(resolve))
    const wire = hangingTransports()
    wires.push(wire)
    hostEnds.push(wire.host)
    server.accept(wire.host)
    return wire.device
  }
  /** The host's process stops: its connections answer and close nothing, and new ones wait. */
  const stop = () => {
    stopped = []
    for (const wire of wires) wire.hang()
  }
  const go = () => {
    for (const wire of wires) wire.wake()
    for (const resolve of stopped?.splice(0) ?? []) resolve()
    stopped = null
  }
  const openCode = (): PairingPayload => {
    pairing.open(1)
    const waiting = heard.at(-1)!
    if (waiting.state !== 'waiting') throw new Error('The code is not waiting')
    return parsePairingLink(waiting.link)!
  }
  const answered = async (add: boolean): Promise<void> => {
    await expect.poll(() => heard.at(-1)?.state).toBe('confirm')
    pairing.answer(1, { add, name: DEVICE.name })
  }
  const pairBrowser = async (key: KeyPair, keepalive?: KeepaliveTimings) => {
    const payload = openCode()
    const progress: PairProgress[] = []
    const pairing = pair({ dial, payload, key, client: CLIENT, device: DEVICE }, (state) =>
      progress.push(state),
    )
    await answered(true)
    const paired = (await pairing)!
    const link = new HostLink({
      dial,
      hostKey: payload.hostKey,
      key,
      hello: hello(CLIENT),
      adopt: paired,
      retryDelay: () => 200,
      ...(keepalive ? { keepalive } : {}),
    })
    links.push(link)
    const states: LinkState[] = []
    link.onState((state) => states.push(state))
    link.start()
    return { link, states, paired, progress }
  }
  return {
    agent,
    project,
    server,
    devices,
    hostKey,
    heard,
    dial,
    hostEnds,
    stop,
    go,
    openCode,
    answered,
    pairBrowser,
    agentPorts: () => agentPorts,
  }
}

describe('pairing a browser', () => {
  it('adds the browser once the owner says yes, the welcome naming it', async () => {
    const t = await setup()
    const key = await generateKeyPair()
    const { paired, progress, link } = await t.pairBrowser(key)
    expect(progress.map((p) => p.state)).toEqual(['connecting', 'waiting'])
    expect(paired.welcome).toMatchObject({
      host: { name: 'Studio' },
      device: { name: DEVICE.name },
    })
    expect(t.devices.list()).toEqual([
      expect.objectContaining({ name: DEVICE.name, kind: 'web', model: 'Safari', platform: 'Mac' }),
    ])
    expect(link.state.kind).toBe('connected')
  })

  it('fails as rejected when the owner says no, and as void for a code the host does not hold', async () => {
    const t = await setup()
    const key = await generateKeyPair()
    const payload = t.openCode()
    const progress: PairProgress[] = []
    const rejected = pair({ dial: t.dial, payload, key, client: CLIENT, device: DEVICE }, (s) =>
      progress.push(s),
    )
    await t.answered(false)
    expect(await rejected).toBeNull()
    expect(progress.at(-1)).toEqual({ state: 'failed', reason: 'rejected' })

    const wrong = { ...payload, secret: new Uint8Array(32) }
    expect(
      await pair({ dial: t.dial, payload: wrong, key, client: CLIENT, device: DEVICE }, (s) =>
        progress.push(s),
      ),
    ).toBeNull()
    expect(progress.at(-1)).toEqual({ state: 'failed', reason: 'void' })
  })

  it('fails as unreachable when no connection opens', async () => {
    const key = await generateKeyPair()
    const progress: PairProgress[] = []
    const dial = () => Promise.reject(new Error('refused'))
    const payload = {
      version: 1,
      hostKey: (await generateKeyPair()).publicKey,
      secret: new Uint8Array(32),
      addresses: [],
    }
    expect(
      await pair({ dial, payload, key, client: CLIENT, device: DEVICE }, (s) => progress.push(s)),
    ).toBeNull()
    expect(progress.at(-1)).toEqual({ state: 'failed', reason: 'unreachable' })
  })
})

describe('the host link', () => {
  it('runs a session with the fake agent, its events coming back', async () => {
    const t = await setup()
    const { link } = await t.pairBrowser(await generateKeyPair())
    const events: { type: string }[] = []
    link.onHostEvent((event) => events.push(event as { type: string }))
    const session = (await link.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
    })) as { id: string }
    await expect.poll(() => events.some((e) => e.type === 'session.summary')).toBe(true)
    expect(session.id).toEqual(expect.any(String))
    // A device adds a project by typing its folder, as the web client's Open project does; a path
    // that is no folder there is refused.
    await expect(link.request('projects.add', { path: t.agent.project })).resolves.toMatchObject({
      path: t.project,
    })
    await expect(
      link.request('projects.add', { path: path.join(t.agent.project, 'missing') }),
    ).rejects.toMatchObject({ name: 'PortRequestError' })
  })

  it('uploads binary values in requests and downloads them in results', async () => {
    const t = await setup()
    const { link } = await t.pairBrowser(await generateKeyPair())
    const added = (await link.request('attachments.add', {
      source: { bytes: PNG.slice().buffer, mimeType: 'image/png', name: 'photo.png' },
      thumb: null,
    })) as { id: string; type: string; size: number }
    expect(added).toMatchObject({ type: 'image', size: PNG.length })
    const read = (await link.request('attachments.read', { id: added.id })) as {
      bytes: ArrayBuffer
    }
    expect(new Uint8Array(read.bytes)).toEqual(PNG)
  })

  it('reads media with its bytes', async () => {
    const t = await setup()
    await writeFile(path.join(t.project, 'shot.png'), PNG)
    const { link } = await t.pairBrowser(await generateKeyPair())
    const read = (await link.request('media.read', {
      projectPath: t.project,
      path: 'shot.png',
    })) as { kind: string; media: { kind: string }; bytes: ArrayBuffer }
    expect(read).toMatchObject({ kind: 'granted', media: { kind: 'image' } })
    expect(new Uint8Array(read.bytes)).toEqual(PNG)
  })

  it('reconnects with its key once the connection drops, and holds requests meanwhile', async () => {
    const t = await setup()
    const { link, states } = await t.pairBrowser(await generateKeyPair())
    t.hostEnds[0]!.close()
    await expect.poll(() => states.some((state) => state.kind === 'reconnecting')).toBe(true)
    // Asked while away, it waits for the next connection.
    const listed = link.request('agents.list', undefined)
    await expect.poll(() => states.at(-1)?.kind).toBe('connected')
    expect(states.map((state) => state.kind)).toEqual([
      'connecting',
      'connected',
      'reconnecting',
      'connected',
    ])
    expect(t.hostEnds).toHaveLength(2)
    expect(await listed).toEqual(expect.any(Array))
  })

  it('resumes the session the host kept, answering a request that was on its way', async () => {
    const t = await setup()
    const { link, states } = await t.pairBrowser(await generateKeyPair())
    const listed = link.request('agents.list', undefined)
    t.hostEnds[0]!.close()
    await expect.poll(() => states.at(-1)?.kind).toBe('reconnecting')
    expect(states.at(-1)).toEqual({ kind: 'reconnecting', reason: null, kept: true })
    expect(await listed).toEqual(expect.any(Array))
    await expect.poll(() => states.at(-1)?.kind).toBe('connected')
    expect(t.hostEnds).toHaveLength(2)
    expect(t.agentPorts()).toBe(1)
  })

  it('notices a host that stops answering, and resumes the session once it answers', async () => {
    const t = await setup()
    const { link, states } = await t.pairBrowser(await generateKeyPair(), {
      quietMs: 50,
      answerMs: 50,
    })
    // Pings and their answers keep a quiet connection up.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(states.map((state) => state.kind)).toEqual(['connecting', 'connected'])
    // The host's process is stopped: the connection stays open but nothing on it is read, and
    // it never closes.
    t.stop()
    await expect
      .poll(() => states.at(-1))
      .toEqual({ kind: 'reconnecting', reason: null, kept: true })
    const listed = link.request('agents.list', undefined)
    t.go()
    await expect.poll(() => states.at(-1)?.kind).toBe('connected')
    expect(await listed).toEqual(expect.any(Array))
    expect(t.hostEnds).toHaveLength(2)
    expect(t.agentPorts()).toBe(1)
  })

  it('starts anew once the host no longer keeps the session', async () => {
    const t = await setup({ resumeMs: 50 })
    const { link, states } = await t.pairBrowser(await generateKeyPair())
    t.hostEnds[0]!.close()
    // The host gives the session up before the link is back.
    await new Promise((resolve) => setTimeout(resolve, 100))
    await expect.poll(() => states.at(-1)?.kind).toBe('connected')
    expect(states.slice(2).map((state) => state.kind === 'reconnecting' && state.kept)).toEqual([
      true,
      false,
      false,
    ])
    expect(t.agentPorts()).toBe(2)
    expect(await link.request('agents.list', undefined)).toEqual(expect.any(Array))
  })

  it('acknowledges what it receives, so a small window keeps going', async () => {
    const t = await setup({ limits: { inFlight: 2 } })
    const { link } = await t.pairBrowser(await generateKeyPair())
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => link.request('agents.list', undefined)),
    )
    expect(answers).toHaveLength(20)
  })

  it('stops for good once the owner removes the browser', async () => {
    const t = await setup()
    const { link, states } = await t.pairBrowser(await generateKeyPair())
    const [device] = t.devices.list()
    await t.server.removeDevice(device!.id)
    await expect.poll(() => states.at(-1)).toEqual({ kind: 'stopped', reason: 'removed' })
    await expect(link.request('agents.list', undefined)).rejects.toMatchObject({
      code: 'host_restarted',
    })
  })
})

describe('HostLink acknowledgements and pace', () => {
  function adopted(protocol: number, later: unknown[]) {
    const sent: unknown[] = []
    const channel = {
      onMessage: () => {},
      onBytes: () => {},
      closed: new Promise<void>(() => {}),
      send: async (value: unknown) => void sent.push(value),
      sendBytes: async () => {},
      close: () => {},
    }
    const welcome = {
      type: 'welcome' as const,
      protocol,
      host: { name: 'Studio', platform: 'darwin' as const, version: '0.0.0-test' },
      features: [],
      role: 'owner' as const,
      device: { id: 'c'.repeat(32), name: 'Safari · Mac' },
      terminal: false,
      addresses: [],
      ...(protocol >= 2 ? { resume: 'token' } : {}),
    }
    return {
      sent,
      channel,
      welcome,
      later: later.map((value) => ({ kind: 'json' as const, value })),
    }
  }

  it('acknowledges a burst at once and the rest a moment later, and sends its pace', async () => {
    const events = Array.from({ length: 40 }, (_, n) => ({
      type: 'event',
      event: { type: 'usage.status', status: { n } },
    }))
    const { sent, channel, welcome, later } = adopted(2, events)
    const link = new HostLink({
      dial: () => Promise.reject(new Error('Not dialed')),
      hostKey: new Uint8Array(32),
      key: await generateKeyPair(),
      hello: hello(CLIENT),
      adopt: { opened: { channel, transport: {} as Transport }, welcome, later },
    })
    links.push(link)
    link.start()
    expect(sent).toEqual([{ type: 'ack', received: 32 }])
    await expect.poll(() => sent.at(-1)).toEqual({ type: 'ack', received: 40 })
    link.setPace(1000)
    expect(sent.at(-1)).toEqual({ type: 'pace', ms: 1000 })
  })

  it('says nothing of the kind to a host of version 1', async () => {
    const { sent, channel, welcome, later } = adopted(1, [{ type: 'event', event: { type: 'x' } }])
    const link = new HostLink({
      dial: () => Promise.reject(new Error('Not dialed')),
      hostKey: new Uint8Array(32),
      key: await generateKeyPair(),
      hello: hello(CLIENT),
      adopt: { opened: { channel, transport: {} as Transport }, welcome, later },
    })
    links.push(link)
    link.start()
    link.setPace(1000)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(sent).toEqual([])
  })
})

describe('HostLink events', () => {
  it("keeps the host's own events for its owner apart from the agent and terminal hosts'", async () => {
    const fromHost = [
      { type: 'event', event: { type: 'sessions.changed' } },
      { type: 'event', event: { type: 'settings.changed', settings: {} } },
      { type: 'event', event: { type: 'terminal.output', id: 't1' } },
      { type: 'event', event: { type: 'remote.pairing', event: { codeId: 1 } } },
    ]
    const channel = {
      onMessage: () => {},
      onBytes: () => {},
      closed: new Promise<void>(() => {}),
      send: async () => {},
      sendBytes: async () => {},
      close: () => {},
    }
    const welcome = {
      type: 'welcome' as const,
      protocol: 1,
      host: { name: 'Studio', platform: 'darwin' as const, version: '0.0.0-test' },
      features: [],
      role: 'owner' as const,
      device: { id: 'c'.repeat(32), name: 'Safari · Mac' },
      terminal: true,
      addresses: [],
    }
    const link = new HostLink({
      dial: () => Promise.reject(new Error('Not dialed')),
      hostKey: new Uint8Array(32),
      key: await generateKeyPair(),
      hello: hello(CLIENT),
      adopt: {
        opened: { channel, transport: {} as Transport },
        welcome,
        later: fromHost.map((value) => ({ kind: 'json' as const, value })),
      },
    })
    links.push(link)
    const heard: Record<'host' | 'terminal' | 'admin', string[]> = {
      host: [],
      terminal: [],
      admin: [],
    }
    link.onHostEvent((event) => heard.host.push((event as { type: string }).type))
    link.onTerminalEvent((event) => heard.terminal.push((event as { type: string }).type))
    link.onAdminEvent((event) => heard.admin.push(event.type))
    link.start()
    expect(heard).toEqual({
      host: ['sessions.changed'],
      terminal: ['terminal.output'],
      admin: ['settings.changed', 'remote.pairing'],
    })
  })
})
