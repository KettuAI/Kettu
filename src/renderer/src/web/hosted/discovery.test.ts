import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Platform } from '@shared/platform'
import { Channel } from '@shared/remote/channel'
import {
  DISCOVER_PROLOGUE,
  discoveryNonce,
  pairCode,
  parsePairCommit,
  parsePairConfirm,
  parsePairReveal,
  revealMatches,
} from '@shared/remote/discovery'
import { FakeRelays } from '@shared/remote/fake-relay'
import type { RelayProblem } from '@shared/remote/hosts'
import { Handshake, generateKeyPair } from '@shared/remote/noise'
import {
  PROTOCOL_VERSION,
  parseHello,
  type ClosingReason,
  type Hello,
  type Welcome,
} from '@shared/remote/protocol'
import {
  HOSTS_FEATURE,
  decodeRelayBytes,
  encodeRelayBytes,
  hostProfile,
  importRelayKey,
  newRelaySeed,
  relayHostId,
} from '@shared/remote/relay'
import { dialRelay } from '@shared/remote/relay-device'
import { RelayHost } from '@shared/remote/relay-host'
import type { Transport } from '@shared/remote/transport'
import { webSocketTransport } from '@shared/remote/websocket-transport'
import type { HostedHost } from './hosts'
import {
  canRetryDiscoveryFailure,
  discoveryFailure,
  listAccountHosts,
  pairDiscoveredHost,
  shouldShowHostedPairing,
  type DiscoveryPairProgress,
  type HostedDiscoveredHost,
} from './discovery'

const MAIN = 'https://relay.kettu.test'
const REGION = 'https://sg.kettu.test'
const ACCOUNT_ID = 'acct_1'
const POLL = { timeout: 15_000 }

vi.setConfig({ testTimeout: 30_000 })

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

class DialMiss extends Error {
  constructor(readonly problem: RelayProblem) {
    super(problem)
  }
}

interface HostRequest {
  code: string
  hello: Hello
  deviceConfirmed: boolean
  cancelled: boolean
  approve(deviceName?: string): void
  reject(): void
}

/**
 * In-memory discovery responder implementing the host side of `kettu-channel/1 discover` over
 * `FakeRelays` + `RelayHost` using only browser-safe `@shared/remote/*` modules.
 */
async function setupHost(
  relays: FakeRelays,
  options: {
    name?: string
    platform?: Platform
    token?: string
    refusal?: 'busy' | 'cooling_down' | 'drop'
  } = {},
) {
  const hostKey = await generateKeyPair()
  const relayKey = await importRelayKey(await newRelaySeed())
  const relayId = await relayHostId(relayKey.publicKey)
  const name = options.name ?? 'Studio'
  const platform = options.platform ?? 'darwin'
  let discoverable = true
  let refusal = options.refusal ?? null
  const requests: HostRequest[] = []

  const accept = (transport: Transport): void => {
    let channel: Channel | null = null
    let stage: 'handshake' | 'commit' | 'reveal' | 'hello' | 'confirming' | 'closed' = 'handshake'
    let handshakeHash: Uint8Array | null = null
    let commit = ''
    let hostNonce: Uint8Array | null = null
    let code = ''
    let activeReq: HostRequest | null = null
    let ownerApproved: string | null = null
    let steps = Promise.resolve()

    const closeWith = async (reason: ClosingReason): Promise<void> => {
      if (stage === 'closed') return
      stage = 'closed'
      await channel?.send({ kind: 'json', value: { type: 'closing', reason } }).catch(() => {})
      transport.close()
    }

    const maybeWelcome = async (): Promise<void> => {
      if (stage !== 'confirming' || !activeReq || !ownerApproved || !activeReq.deviceConfirmed) {
        return
      }
      stage = 'closed'
      const welcome: Welcome = {
        type: 'welcome',
        protocol: PROTOCOL_VERSION,
        host: { name, platform, version: '0.1.0-test' },
        features: [],
        role: 'owner',
        device: { id: '0123456789abcdef0123456789abcdef', name: ownerApproved },
        terminal: false,
        addresses: [],
        relay: { id: relayId, urls: [MAIN] },
        account: ACCOUNT_ID,
      }
      await channel?.send({ kind: 'json', value: welcome })
    }

    transport.onClose(() => {
      if (activeReq && stage === 'confirming') activeReq.cancelled = true
      stage = 'closed'
    })

    transport.onMessage((frame) => {
      steps = steps.then(async () => {
        if (stage === 'closed') return
        if (stage === 'handshake') {
          if (!discoverable || refusal === 'drop') return transport.close()
          const responder = await Handshake.create({
            pattern: 'IK',
            role: 'responder',
            staticKey: hostKey,
            prologue: DISCOVER_PROLOGUE,
            accept: () => true,
          })
          try {
            await responder.readMessage(frame)
            const reply = await responder.writeMessage()
            const ciphers = await responder.split()
            handshakeHash = responder.handshakeHash
            channel = new Channel(ciphers, {
              write: (out) => transport.send(out),
              message: (msg) => {
                if (msg.kind !== 'json') return
                steps = steps.then(() => handleJson(msg.value))
              },
              end: () => transport.close(),
            })
            stage = 'commit'
            transport.send(reply)
            if (refusal === 'busy' || refusal === 'cooling_down') {
              await closeWith(refusal)
            }
          } catch {
            transport.close()
          }
          return
        }
        if (channel) await channel.receive(frame)
      })
    })

    const handleJson = async (value: unknown): Promise<void> => {
      if (stage === 'closed') return
      if (stage === 'commit') {
        const parsed = parsePairCommit(value)
        if (!parsed) return closeWith('invalid')
        commit = parsed.commit
        hostNonce = discoveryNonce()
        stage = 'reveal'
        await channel?.send({
          kind: 'json',
          value: { type: 'pair-nonce', nonce: encodeRelayBytes(hostNonce) },
        })
        return
      }
      if (stage === 'reveal') {
        const parsed = parsePairReveal(value)
        const deviceNonce = parsed && decodeRelayBytes(parsed.nonce)
        if (!deviceNonce || !(await revealMatches(commit, deviceNonce))) {
          return closeWith('invalid')
        }
        code = await pairCode(handshakeHash!, hostNonce!, deviceNonce)
        stage = 'hello'
        return
      }
      if (stage === 'hello') {
        const hello = parseHello(value)
        if (!hello?.device) return closeWith('invalid')
        if (hello.account && hello.account !== ACCOUNT_ID) return closeWith('other_account')
        stage = 'confirming'
        const req: HostRequest = {
          code,
          hello,
          deviceConfirmed: false,
          cancelled: false,
          approve: (deviceName) => {
            ownerApproved = deviceName ?? hello.device!.name
            void maybeWelcome()
          },
          reject: () => {
            void closeWith('rejected')
          },
        }
        activeReq = req
        requests.push(req)
        return
      }
      if (stage === 'confirming') {
        if (!parsePairConfirm(value) || !activeReq) return closeWith('invalid')
        activeReq.deviceConfirmed = true
        await maybeWelcome()
      }
    }
  }

  const relay = new RelayHost({
    main: MAIN,
    id: relayId,
    key: relayKey,
    openSocket: relays.openSocket,
    fetchInfo: relays.fetchInfo,
    accepted: (socket) => void webSocketTransport(socket, true).then(accept),
    profile: () => (discoverable ? hostProfile(hostKey.publicKey, name, platform) : null),
    changed: () => {},
    log: () => {},
  })
  relay.start()
  relay.setToken(options.token ?? 'host-token')
  relay.profileChanged()
  cleanups.push(() => relay.stop())
  await expect.poll(() => relays.relay(MAIN).hosts.get(relayId)?.profile, POLL).toBeTruthy()

  return {
    hostKey,
    relayId,
    requests,
    setDiscoverable: (on: boolean) => {
      discoverable = on
      relay.profileChanged()
    },
    setRefusal: (next: 'busy' | 'cooling_down' | 'drop' | null) => {
      refusal = next
    },
  }
}

function dialThroughFakeRelay(
  relays: FakeRelays,
  host: HostedDiscoveredHost,
  token: string,
): (signal: AbortSignal) => Promise<Transport> {
  return async (signal) => {
    const result = await dialRelay({
      relays: host.relays,
      id: host.relayId,
      token,
      openSocket: relays.openSocket,
      timeoutMs: 5000,
      signal,
    })
    if (result.kind === 'aborted') throw new DOMException('The request was aborted', 'AbortError')
    if (result.kind === 'joined') return webSocketTransport(result.socket, true)
    if (result.kind === 'offline') throw new DialMiss('host_offline')
    if (result.kind === 'forbidden') throw new DialMiss('wrong_account')
    throw new DialMiss('unreachable')
  }
}

describe('shouldShowHostedPairing', () => {
  it('opens pairing on initial setup, Settings Add computer (/pair), and missing device key', () => {
    expect(shouldShowHostedPairing('/', false, false)).toBe(true)
    expect(shouldShowHostedPairing('/', false, true)).toBe(true)
    expect(shouldShowHostedPairing('/', true, false)).toBe(true)
    expect(shouldShowHostedPairing('/pair', true, true)).toBe(true)
    expect(shouldShowHostedPairing('/', true, true)).toBe(false)
  })
})

describe('listAccountHosts', () => {
  it('fetches online account computers across regions, deduplicates relays, and excludes paired hosts', async () => {
    const relays = new FakeRelays()
    relays.accounts.set('host-token', ACCOUNT_ID)
    relays.accounts.set('web-token', ACCOUNT_ID)
    relays.relay(MAIN).regions = [{ id: 'sg', url: REGION }]
    relays.relay(REGION).features = [HOSTS_FEATURE]

    const studio = await setupHost(relays, { name: 'Studio', platform: 'darwin' })
    const mini = await setupHost(relays, { name: 'Mini', platform: 'linux' })
    const workstation = await setupHost(relays, { name: 'Workstation', platform: 'win32' })

    await expect
      .poll(() => relays.relay(REGION).hosts.get(studio.relayId)?.profile, POLL)
      .toBeTruthy()

    const alreadyPairedByKey: HostedHost = {
      hostKey: mini.hostKey.publicKey,
      relay: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', urls: [MAIN] },
      name: 'Mini',
      deviceName: 'Chrome',
    }
    const alreadyPairedById: HostedHost = {
      hostKey: new Uint8Array(32).fill(9),
      relay: { id: workstation.relayId, urls: [MAIN] },
      name: 'Workstation',
      deviceName: 'Chrome',
    }

    const result = await listAccountHosts({
      main: MAIN,
      token: async () => 'web-token',
      allowed: (urls) => urls,
      paired: [alreadyPairedByKey, alreadyPairedById],
      accountId: ACCOUNT_ID,
      fetchJson: relays.fetchJson,
    })

    expect(result.state).toBe('ok')
    if (result.state !== 'ok') throw new Error('expected ok')
    expect(result.hosts).toHaveLength(1)
    expect(result.hosts[0]).toMatchObject({
      relayId: studio.relayId,
      key: encodeRelayBytes(studio.hostKey.publicKey),
      name: 'Studio',
      platform: 'darwin',
    })
    expect(result.hosts[0]!.relays).toEqual([MAIN, REGION])
  })

  it('does not exclude hosts folded under another account', async () => {
    const relays = new FakeRelays()
    relays.accounts.set('host-token', ACCOUNT_ID)
    relays.accounts.set('web-token', ACCOUNT_ID)
    const studio = await setupHost(relays, { name: 'Studio' })

    const folded: HostedHost = {
      hostKey: studio.hostKey.publicKey,
      relay: { id: studio.relayId, urls: [MAIN] },
      name: 'Studio',
      deviceName: 'Chrome',
      otherAccount: true,
    }

    const result = await listAccountHosts({
      main: MAIN,
      token: async () => 'web-token',
      allowed: (urls) => urls,
      paired: [folded],
      accountId: ACCOUNT_ID,
      fetchJson: relays.fetchJson,
    })
    expect(result.state).toBe('ok')
    if (result.state === 'ok') expect(result.hosts.map((h) => h.relayId)).toEqual([studio.relayId])
  })

  it('returns unavailable when relay does not advertise HOSTS_FEATURE or cannot be reached', async () => {
    const relays = new FakeRelays()
    relays.accounts.set('web-token', ACCOUNT_ID)
    relays.relay(MAIN).features = []

    expect(
      await listAccountHosts({
        main: MAIN,
        token: async () => 'web-token',
        allowed: (urls) => urls,
        paired: [],
        accountId: ACCOUNT_ID,
        fetchJson: relays.fetchJson,
      }),
    ).toEqual({ state: 'unavailable' })

    relays.relay(MAIN).features = [HOSTS_FEATURE]
    relays.relay(MAIN).mode = 'down'
    expect(
      await listAccountHosts({
        main: MAIN,
        token: async () => 'web-token',
        allowed: (urls) => urls,
        paired: [],
        accountId: ACCOUNT_ID,
        fetchJson: relays.fetchJson,
      }),
    ).toEqual({ state: 'unavailable' })
  })

  it('returns signed_out and notifies onUnauthorized on 401, and distinguishes offline token failure', async () => {
    const relays = new FakeRelays()
    const onUnauthorized = vi.fn()

    expect(
      await listAccountHosts({
        main: MAIN,
        token: async () => 'bad-token',
        allowed: (urls) => urls,
        paired: [],
        accountId: ACCOUNT_ID,
        onUnauthorized,
        fetchJson: relays.fetchJson,
      }),
    ).toEqual({ state: 'signed_out' })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)

    expect(
      await listAccountHosts({
        main: MAIN,
        token: async () => null,
        allowed: (urls) => urls,
        paired: [],
        accountId: ACCOUNT_ID,
        isSignedIn: () => true,
        fetchJson: relays.fetchJson,
      }),
    ).toEqual({ state: 'unavailable' })

    expect(
      await listAccountHosts({
        main: MAIN,
        token: async () => null,
        allowed: (urls) => urls,
        paired: [],
        accountId: ACCOUNT_ID,
        isSignedIn: () => false,
        fetchJson: relays.fetchJson,
      }),
    ).toEqual({ state: 'signed_out' })
  })
})

describe('pairDiscoveredHost', () => {
  it('completes one-click discovery pairing with matching six-digit code and returns a live Paired session', async () => {
    const relays = new FakeRelays()
    relays.accounts.set('host-token', ACCOUNT_ID)
    relays.accounts.set('web-token', ACCOUNT_ID)
    const studio = await setupHost(relays, { name: 'Studio', platform: 'darwin' })

    const listed = await listAccountHosts({
      main: MAIN,
      token: async () => 'web-token',
      allowed: (urls) => urls,
      paired: [],
      accountId: ACCOUNT_ID,
      fetchJson: relays.fetchJson,
    })
    if (listed.state !== 'ok' || listed.hosts.length !== 1) throw new Error('expected one host')
    const target = listed.hosts[0]!

    const states: DiscoveryPairProgress[] = []
    const session = pairDiscoveredHost(
      {
        host: target,
        dial: dialThroughFakeRelay(relays, target, 'web-token'),
        key: await generateKeyPair(),
        client: { kind: 'web', version: '0.1.0', platform: 'macOS' },
        device: { name: 'Chrome · macOS', model: 'Chrome' },
        account: ACCOUNT_ID,
      },
      (state) => states.push(state),
    )

    await expect.poll(() => states.at(-1)?.state, POLL).toBe('compare')
    await expect.poll(() => studio.requests.length, POLL).toBe(1)

    const asked = studio.requests[0]!
    const compare = states.at(-1)!
    if (compare.state !== 'compare') throw new Error('expected compare')
    expect(compare.code).toBe(asked.code)
    expect(compare.code).toMatch(/^\d{6}$/)
    expect(compare.matched).toBe(false)
    expect(asked.hello.device).toEqual({ name: 'Chrome · macOS', model: 'Chrome' })
    expect(asked.hello.client.kind).toBe('web')

    session.confirm()
    expect(states.at(-1)).toEqual({ state: 'compare', code: asked.code, matched: true })
    await expect.poll(() => asked.deviceConfirmed, POLL).toBe(true)

    asked.approve('Chrome · macOS')
    const paired = await session.done
    expect(paired).not.toBeNull()
    expect(paired!.welcome.host.name).toBe('Studio')
    expect(paired!.welcome.device.name).toBe('Chrome · macOS')
    paired!.opened.channel.close()
  })

  it('completes even when the computer approves before the browser confirms the code', async () => {
    const relays = new FakeRelays()
    relays.accounts.set('host-token', ACCOUNT_ID)
    relays.accounts.set('web-token', ACCOUNT_ID)
    const studio = await setupHost(relays, { name: 'Studio' })

    const target: HostedDiscoveredHost = {
      relayId: studio.relayId,
      hostKey: studio.hostKey.publicKey,
      key: encodeRelayBytes(studio.hostKey.publicKey),
      name: 'Studio',
      platform: 'darwin',
      relays: [MAIN],
    }

    const states: DiscoveryPairProgress[] = []
    const session = pairDiscoveredHost(
      {
        host: target,
        dial: dialThroughFakeRelay(relays, target, 'web-token'),
        key: await generateKeyPair(),
        client: { kind: 'web', version: '0.1.0', platform: 'macOS' },
        device: { name: 'Safari · iPhone', model: 'Safari' },
        account: ACCOUNT_ID,
      },
      (state) => states.push(state),
    )

    await expect.poll(() => states.at(-1)?.state, POLL).toBe('compare')
    await expect.poll(() => studio.requests.length, POLL).toBe(1)

    studio.requests[0]!.approve('Safari · iPhone')
    session.confirm()

    const paired = await session.done
    expect(paired?.welcome.host.name).toBe('Studio')
    paired?.opened.channel.close()
  })

  it('reports rejected when the computer declines the pairing request', async () => {
    const relays = new FakeRelays()
    relays.accounts.set('host-token', ACCOUNT_ID)
    relays.accounts.set('web-token', ACCOUNT_ID)
    const studio = await setupHost(relays, { name: 'Studio' })
    const target: HostedDiscoveredHost = {
      relayId: studio.relayId,
      hostKey: studio.hostKey.publicKey,
      key: encodeRelayBytes(studio.hostKey.publicKey),
      name: 'Studio',
      platform: 'darwin',
      relays: [MAIN],
    }

    const states: DiscoveryPairProgress[] = []
    const session = pairDiscoveredHost(
      {
        host: target,
        dial: dialThroughFakeRelay(relays, target, 'web-token'),
        key: await generateKeyPair(),
        client: { kind: 'web', version: '0.1.0', platform: 'macOS' },
        device: { name: 'Chrome', model: 'Chrome' },
        account: ACCOUNT_ID,
      },
      (state) => states.push(state),
    )

    await expect.poll(() => studio.requests.length, POLL).toBe(1)
    studio.requests[0]!.reject()

    expect(await session.done).toBeNull()
    expect(states.at(-1)).toEqual({ state: 'failed', reason: 'rejected' })
  })

  it('cancels cleanly from the browser and closes the host request without emitting a failure state', async () => {
    const relays = new FakeRelays()
    relays.accounts.set('host-token', ACCOUNT_ID)
    relays.accounts.set('web-token', ACCOUNT_ID)
    const studio = await setupHost(relays, { name: 'Studio' })
    const target: HostedDiscoveredHost = {
      relayId: studio.relayId,
      hostKey: studio.hostKey.publicKey,
      key: encodeRelayBytes(studio.hostKey.publicKey),
      name: 'Studio',
      platform: 'darwin',
      relays: [MAIN],
    }

    const states: DiscoveryPairProgress[] = []
    const session = pairDiscoveredHost(
      {
        host: target,
        dial: dialThroughFakeRelay(relays, target, 'web-token'),
        key: await generateKeyPair(),
        client: { kind: 'web', version: '0.1.0', platform: 'macOS' },
        device: { name: 'Chrome', model: 'Chrome' },
        account: ACCOUNT_ID,
      },
      (state) => states.push(state),
    )

    await expect.poll(() => states.at(-1)?.state, POLL).toBe('compare')
    await expect.poll(() => studio.requests.length, POLL).toBe(1)
    session.cancel()
    expect(await session.done).toBeNull()
    expect(states.some((s) => s.state === 'failed')).toBe(false)
    await expect.poll(() => studio.requests[0]?.cancelled, POLL).toBe(true)
  })

  it('surfaces busy, cooling_down, host_offline, and other_account failures cleanly', async () => {
    const relays = new FakeRelays()
    relays.accounts.set('host-token', ACCOUNT_ID)
    relays.accounts.set('web-token', ACCOUNT_ID)
    const studio = await setupHost(relays, { name: 'Studio', refusal: 'busy' })
    const target: HostedDiscoveredHost = {
      relayId: studio.relayId,
      hostKey: studio.hostKey.publicKey,
      key: encodeRelayBytes(studio.hostKey.publicKey),
      name: 'Studio',
      platform: 'darwin',
      relays: [MAIN],
    }

    const runAttempt = async (account = ACCOUNT_ID): Promise<DiscoveryPairProgress | undefined> => {
      const states: DiscoveryPairProgress[] = []
      const session = pairDiscoveredHost(
        {
          host: target,
          dial: dialThroughFakeRelay(relays, target, 'web-token'),
          key: await generateKeyPair(),
          client: { kind: 'web', version: '0.1.0', platform: 'macOS' },
          device: { name: 'Chrome', model: 'Chrome' },
          account,
          dialFailure: (error) => (error instanceof DialMiss ? error.problem : null),
        },
        (state) => states.push(state),
      )
      expect(await session.done).toBeNull()
      return states.at(-1)
    }

    expect(await runAttempt()).toEqual({ state: 'failed', reason: 'busy' })
    expect(canRetryDiscoveryFailure('busy')).toBe(true)

    studio.setRefusal('cooling_down')
    expect(await runAttempt()).toEqual({ state: 'failed', reason: 'cooling_down' })
    expect(canRetryDiscoveryFailure('cooling_down')).toBe(false)

    studio.setRefusal(null)
    expect(await runAttempt('other_acct')).toEqual({ state: 'failed', reason: 'other_account' })

    studio.setDiscoverable(false)
    expect(await runAttempt()).toEqual({ state: 'failed', reason: 'host_offline' })

    expect(discoveryFailure('stopping')).toBe('host_offline')
    expect(discoveryFailure(null)).toBe('void')
  })

  it('aborts an in-flight dial when cancelled before connection opens', async () => {
    const hostKey = await generateKeyPair()
    const target: HostedDiscoveredHost = {
      relayId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
      hostKey: hostKey.publicKey,
      key: encodeRelayBytes(hostKey.publicKey),
      name: 'Studio',
      platform: 'darwin',
      relays: [MAIN],
    }

    let aborted = false
    const states: DiscoveryPairProgress[] = []
    const session = pairDiscoveredHost(
      {
        host: target,
        dial: (signal) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              aborted = true
              reject(new DOMException('The request was aborted', 'AbortError'))
            })
          }),
        key: await generateKeyPair(),
        client: { kind: 'web', version: '0.1.0', platform: 'macOS' },
        device: { name: 'Chrome', model: 'Chrome' },
        account: ACCOUNT_ID,
      },
      (state) => states.push(state),
    )

    session.cancel()
    expect(await session.done).toBeNull()
    expect(aborted).toBe(true)
    expect(states).toEqual([{ state: 'connecting' }])
  })
})
