// The peer-to-peer signaling both sides speak: its messages and their limits, and how the device
// offers and the host answers, against a WebRTC that records what it is asked.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RtcDataChannel } from './datachannel-transport'
import {
  MAX_P2P_CANDIDATES,
  onlyDataSection,
  parseP2p,
  PeerAnswers,
  PeerOffer,
  type P2pMessage,
  type PeerSystem,
  type RtcPeerConnection,
} from './p2p'
import type { Transport } from './transport'

const DATA_SDP =
  'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'
const MEDIA_SDP = `${DATA_SDP}m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n`
const CANDIDATE = 'candidate:1 1 UDP 2114977791 192.168.1.8 61314 typ host'

afterEach(() => {
  vi.useRealTimers()
})

class FakeChannel implements RtcDataChannel {
  readyState = 'connecting'
  binaryType = 'blob'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  closed = false
  onopen: RtcDataChannel['onopen'] = null
  onclose: RtcDataChannel['onclose'] = null
  onbufferedamountlow: RtcDataChannel['onbufferedamountlow'] = null
  onmessage: RtcDataChannel['onmessage'] = null
  constructor(readonly label: string) {}
  send(): void {}
  close(): void {
    this.closed = true
    this.readyState = 'closed'
  }
  open(): void {
    this.readyState = 'open'
    this.onopen?.(null)
  }
}

class FakePeer implements RtcPeerConnection {
  connectionState = 'new'
  localDescription: { sdp: string } | null = null
  remote: { type: string; sdp: string } | null = null
  readonly added: { candidate: string; sdpMid: string }[] = []
  readonly channels: FakeChannel[] = []
  closed = false
  onicecandidate: RtcPeerConnection['onicecandidate'] = null
  ondatachannel: RtcPeerConnection['ondatachannel'] = null
  onconnectionstatechange: RtcPeerConnection['onconnectionstatechange'] = null
  constructor(
    readonly config: { iceServers: { urls: string[] }[] },
    private readonly answerSdp = DATA_SDP,
  ) {}
  createDataChannel(label: string): FakeChannel {
    const channel = new FakeChannel(label)
    this.channels.push(channel)
    return channel
  }
  createOffer(): Promise<{ sdp: string }> {
    return Promise.resolve({ sdp: DATA_SDP })
  }
  createAnswer(): Promise<{ sdp: string }> {
    return Promise.resolve({ sdp: this.answerSdp })
  }
  setLocalDescription(description: { sdp: string }): Promise<void> {
    this.localDescription = { sdp: description.sdp }
    return Promise.resolve()
  }
  setRemoteDescription(description: { type: string; sdp: string }): Promise<void> {
    this.remote = description
    return Promise.resolve()
  }
  addIceCandidate(candidate: { candidate: string; sdpMid: string }): Promise<void> {
    this.added.push(candidate)
    return Promise.resolve()
  }
  close(): void {
    this.closed = true
    this.connectionState = 'closed'
  }
  /** A candidate this side found, as libdatachannel writes it. */
  found(candidate: string): void {
    this.onicecandidate?.({ candidate: { candidate, sdpMid: '0' } })
  }
}

function fakeSystem(stun: string[] = []): PeerSystem & { peers: FakePeer[] } {
  const peers: FakePeer[] = []
  return {
    peers,
    stun: () => stun,
    create: (config) => {
      const peer = new FakePeer(config)
      peers.push(peer)
      return peer
    },
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('peer-to-peer signaling messages', () => {
  it('reads each message within its limits', () => {
    expect(parseP2p({ type: 'p2p.offer', id: 'a1_B-', sdp: DATA_SDP })).toEqual({
      type: 'p2p.offer',
      id: 'a1_B-',
      sdp: DATA_SDP,
    })
    expect(parseP2p({ type: 'p2p.answer', id: 'x', sdp: DATA_SDP })?.type).toBe('p2p.answer')
    expect(parseP2p({ type: 'p2p.close', id: 'x', extra: 1 })).toEqual({
      type: 'p2p.close',
      id: 'x',
    })
    expect(parseP2p({ type: 'p2p.candidate', id: 'x', candidate: CANDIDATE, mid: '0' })).toEqual({
      type: 'p2p.candidate',
      id: 'x',
      candidate: CANDIDATE,
      mid: '0',
    })
  })

  it('writes a candidate as browsers do, without the SDP line prefix', () => {
    const message = parseP2p({
      type: 'p2p.candidate',
      id: 'x',
      candidate: `a=${CANDIDATE}`,
      mid: '0',
    })
    expect(message).toMatchObject({ candidate: CANDIDATE })
  })

  it('refuses ids, descriptions and candidates outside the limits', () => {
    const offer = (fields: Record<string, unknown>) =>
      parseP2p({ type: 'p2p.offer', id: 'x', sdp: DATA_SDP, ...fields })
    expect(offer({ id: '' })).toBeNull()
    expect(offer({ id: 'a'.repeat(65) })).toBeNull()
    expect(offer({ id: 'a'.repeat(64) })).not.toBeNull()
    expect(offer({ id: 'a b' })).toBeNull()
    expect(offer({ id: 7 })).toBeNull()
    expect(offer({ sdp: '' })).toBeNull()
    expect(offer({ sdp: 'v'.repeat(16 * 1024 + 1) })).toBeNull()
    expect(offer({ sdp: 'v'.repeat(16 * 1024) })).not.toBeNull()

    const candidate = (fields: Record<string, unknown>) =>
      parseP2p({ type: 'p2p.candidate', id: 'x', candidate: CANDIDATE, mid: '0', ...fields })
    expect(candidate({ candidate: 'typ host' })).toBeNull()
    expect(candidate({ candidate: `candidate:${'1'.repeat(503)}` })).toBeNull()
    expect(candidate({ candidate: `candidate:${'1'.repeat(502)}` })).not.toBeNull()
    expect(candidate({ mid: 0 })).toBeNull()
    expect(candidate({ mid: 'm'.repeat(33) })).toBeNull()

    expect(parseP2p({ type: 'p2p.renegotiate', id: 'x' })).toBeNull()
    expect(parseP2p(null)).toBeNull()
  })

  it('takes a description with the data section alone', () => {
    expect(onlyDataSection(DATA_SDP)).toBe(true)
    expect(onlyDataSection(MEDIA_SDP)).toBe(false)
    expect(onlyDataSection(`${DATA_SDP}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`)).toBe(
      false,
    )
    expect(onlyDataSection('v=0\r\n')).toBe(false)
  })
})

describe('the host answering offers', () => {
  function answers(system = fakeSystem(['stun.example.com:3478', '[2001:db8::1]:3478'])) {
    const sent: P2pMessage[] = []
    const accepted: Transport[] = []
    const host = new PeerAnswers({
      system,
      send: (message) => sent.push(message),
      accept: (transport) => accepted.push(transport),
      timeoutMs: 1000,
    })
    return { system, sent, accepted, host }
  }

  it('answers with its own STUN servers, then trickles its candidates', async () => {
    const t = answers()
    t.host.signal({ type: 'p2p.offer', id: 'one', sdp: DATA_SDP })
    const peer = t.system.peers[0]!
    expect(peer.config.iceServers).toEqual([
      { urls: ['stun:stun.example.com:3478', 'stun:[2001:db8::1]:3478'] },
    ])
    // Found before the answer went, it waits for it.
    peer.found(`a=${CANDIDATE}`)
    await flush()
    expect(peer.remote).toEqual({ type: 'offer', sdp: DATA_SDP })
    expect(t.sent).toEqual([
      { type: 'p2p.answer', id: 'one', sdp: DATA_SDP },
      { type: 'p2p.candidate', id: 'one', candidate: CANDIDATE, mid: '0' },
    ])
  })

  it('refuses an offer with any section but the data one', () => {
    const t = answers()
    t.host.signal({ type: 'p2p.offer', id: 'one', sdp: MEDIA_SDP })
    expect(t.system.peers).toHaveLength(0)
    expect(t.sent).toEqual([{ type: 'p2p.close', id: 'one' }])
  })

  it('takes at most 32 candidates, and none for another attempt', async () => {
    const t = answers()
    t.host.signal({ type: 'p2p.offer', id: 'one', sdp: DATA_SDP })
    t.host.signal({ type: 'p2p.candidate', id: 'other', candidate: CANDIDATE, mid: '0' })
    for (let i = 0; i < MAX_P2P_CANDIDATES + 5; i++) {
      t.host.signal({ type: 'p2p.candidate', id: 'one', candidate: `${CANDIDATE} ${i}`, mid: '0' })
    }
    await flush()
    const added = t.system.peers[0]!.added
    expect(added).toHaveLength(MAX_P2P_CANDIDATES)
    expect(added[0]).toEqual({ candidate: `${CANDIDATE} 0`, sdpMid: '0' })
  })

  it('replaces an attempt that did not open with a newer offer', () => {
    const t = answers()
    t.host.signal({ type: 'p2p.offer', id: 'one', sdp: DATA_SDP })
    t.host.signal({ type: 'p2p.offer', id: 'two', sdp: DATA_SDP })
    expect(t.system.peers[0]!.closed).toBe(true)
    expect(t.system.peers[1]!.closed).toBe(false)
  })

  it('gives an attempt up when its DataChannel does not open in time', () => {
    vi.useFakeTimers()
    const t = answers()
    t.host.signal({ type: 'p2p.offer', id: 'one', sdp: DATA_SDP })
    vi.advanceTimersByTime(1000)
    expect(t.system.peers[0]!.closed).toBe(true)
    expect(t.sent.at(-1)).toEqual({ type: 'p2p.close', id: 'one' })
  })

  it('hands over the kettu DataChannel alone once it opens', async () => {
    const t = answers()
    t.host.signal({ type: 'p2p.offer', id: 'one', sdp: DATA_SDP })
    await flush()
    const peer = t.system.peers[0]!
    const other = new FakeChannel('other')
    peer.ondatachannel?.({ channel: other })
    expect(other.closed).toBe(true)
    const channel = new FakeChannel('kettu')
    peer.ondatachannel?.({ channel })
    channel.open()
    expect(t.accepted).toHaveLength(1)
    expect(channel.binaryType).toBe('arraybuffer')
    // Opened, the peer connection is the transport's: neither a close nor a new offer ends it.
    t.host.signal({ type: 'p2p.close', id: 'one' })
    t.host.signal({ type: 'p2p.offer', id: 'two', sdp: DATA_SDP })
    expect(peer.closed).toBe(false)
    t.accepted[0]!.close()
    expect(peer.closed).toBe(true)
  })

  it('closes what is open when the session ends, and answers nothing after', () => {
    const t = answers()
    t.host.signal({ type: 'p2p.offer', id: 'one', sdp: DATA_SDP })
    t.host.close()
    expect(t.system.peers[0]!.closed).toBe(true)
    t.host.signal({ type: 'p2p.offer', id: 'two', sdp: DATA_SDP })
    expect(t.system.peers).toHaveLength(1)
  })

  it('gives an attempt up when the device does', () => {
    const t = answers()
    t.host.signal({ type: 'p2p.offer', id: 'one', sdp: DATA_SDP })
    t.host.signal({ type: 'p2p.close', id: 'other' })
    expect(t.system.peers[0]!.closed).toBe(false)
    t.host.signal({ type: 'p2p.close', id: 'one' })
    expect(t.system.peers[0]!.closed).toBe(true)
  })
})

describe('the device offering', () => {
  function offering(timeoutMs = 1000) {
    const system = fakeSystem()
    const sent: P2pMessage[] = []
    const offer = new PeerOffer({ system, send: (message) => sent.push(message), timeoutMs })
    return { system, sent, offer, peer: system.peers[0]! }
  }

  it('opens one ordered DataChannel and offers it, its candidates after the offer', async () => {
    const t = offering()
    expect(t.peer.channels.map((channel) => channel.label)).toEqual(['kettu'])
    expect(t.offer.id).toMatch(/^[0-9a-f]{32}$/)
    t.peer.found(CANDIDATE)
    await flush()
    expect(t.sent).toEqual([
      { type: 'p2p.offer', id: t.offer.id, sdp: DATA_SDP },
      { type: 'p2p.candidate', id: t.offer.id, candidate: CANDIDATE, mid: '0' },
    ])
  })

  it('takes the answer and its candidates, and settles once the DataChannel opens', async () => {
    const t = offering()
    await flush()
    t.offer.signal({ type: 'p2p.candidate', id: t.offer.id, candidate: CANDIDATE, mid: '0' })
    t.offer.signal({ type: 'p2p.answer', id: 'other', sdp: DATA_SDP })
    expect(t.peer.remote).toBeNull()
    t.offer.signal({ type: 'p2p.answer', id: t.offer.id, sdp: DATA_SDP })
    await flush()
    expect(t.peer.remote).toEqual({ type: 'answer', sdp: DATA_SDP })
    // The candidate that came first waited for the answer.
    expect(t.peer.added).toEqual([{ candidate: CANDIDATE, sdpMid: '0' }])
    t.peer.channels[0]!.open()
    await expect(t.offer.opened).resolves.toBeDefined()
  })

  it('gives up on an answer with any section but the data one', async () => {
    const t = offering()
    await flush()
    t.offer.signal({ type: 'p2p.answer', id: t.offer.id, sdp: MEDIA_SDP })
    await expect(t.offer.opened).rejects.toThrow()
    expect(t.peer.closed).toBe(true)
    expect(t.sent.at(-1)).toEqual({ type: 'p2p.close', id: t.offer.id })
  })

  it('gives up when the host does, or when the DataChannel does not open in time', async () => {
    const closed = offering()
    closed.offer.signal({ type: 'p2p.close', id: closed.offer.id })
    await expect(closed.offer.opened).rejects.toThrow()
    expect(closed.peer.closed).toBe(true)

    vi.useFakeTimers()
    const late = offering(1000)
    vi.advanceTimersByTime(1000)
    await expect(late.offer.opened).rejects.toThrow()
    expect(late.peer.closed).toBe(true)
    expect(late.sent.at(-1)).toEqual({ type: 'p2p.close', id: late.offer.id })
  })

  it('gives up when its peer connection fails', async () => {
    const t = offering()
    t.peer.connectionState = 'failed'
    t.peer.onconnectionstatechange?.(null)
    await expect(t.offer.opened).rejects.toThrow()
    expect(t.peer.closed).toBe(true)
  })
})
