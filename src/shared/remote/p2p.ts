// Peer-to-peer paths between a device and its host: a WebRTC DataChannel set up over the session
// the device already has, through the relay. The device offers, the host answers and both trickle
// their ICE candidates; once the DataChannel opens it is one more transport, on which the device
// does the Noise handshake and moves its session as to any other path. ICE uses STUN alone, from
// each side's signed region list, and never TURN: a pair that cannot open stays on the relay.
// Imports no Node.js module, since browsers run it, given their own RTCPeerConnection.

import { dataChannelTransport, type RtcDataChannel } from './datachannel-transport'
import type { Transport } from './transport'

/** The welcome's feature of a host that answers peer-to-peer offers. */
export const P2P_FEATURE = 'p2p'

/** The label of the one DataChannel an attempt opens. */
export const P2P_LABEL = 'kettu'

/** The longest SDP an offer or an answer carries. */
export const MAX_P2P_SDP = 16 * 1024

/** The most candidates either side takes per attempt, and the longest one. */
export const MAX_P2P_CANDIDATES = 32
export const MAX_P2P_CANDIDATE = 512

/** How long an attempt's DataChannel has to open. */
export const P2P_OPEN_TIMEOUT_MS = 15_000

const ATTEMPT_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_MID = 32

export interface P2pOffer {
  type: 'p2p.offer'
  id: string
  sdp: string
}

export interface P2pAnswer {
  type: 'p2p.answer'
  id: string
  sdp: string
}

export interface P2pCandidate {
  type: 'p2p.candidate'
  id: string
  /** The ICE candidate line, `candidate:` included. */
  candidate: string
  /** The candidate's `sdpMid`. */
  mid: string
}

export interface P2pClose {
  type: 'p2p.close'
  id: string
}

export type P2pMessage = P2pOffer | P2pAnswer | P2pCandidate | P2pClose

/** Whether `value` is a `p2p.*` message, well formed or not, which neither side passes on. */
export function isP2pMessage(value: unknown): boolean {
  const type = (value as { type?: unknown } | null)?.type
  return typeof type === 'string' && type.startsWith('p2p.')
}

/** A signaling message within its limits, or null. */
export function parseP2p(value: unknown): P2pMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const { type, id, sdp, candidate, mid } = value as Record<string, unknown>
  if (typeof id !== 'string' || !ATTEMPT_ID.test(id)) return null
  switch (type) {
    case 'p2p.offer':
    case 'p2p.answer':
      if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > MAX_P2P_SDP) return null
      return { type, id, sdp }
    case 'p2p.candidate': {
      if (typeof candidate !== 'string' || typeof mid !== 'string' || mid.length > MAX_MID) {
        return null
      }
      const line = candidateLine(candidate)
      if (!line.startsWith('candidate:') || line.length > MAX_P2P_CANDIDATE) return null
      return { type, id, candidate: line, mid }
    }
    case 'p2p.close':
      return { type, id }
    default:
      return null
  }
}

/** A candidate as browsers write it: libdatachannel's start with the SDP's `a=`. */
export function candidateLine(candidate: string): string {
  return candidate.startsWith('a=') ? candidate.slice(2) : candidate
}

/** Whether the SDP describes exactly one media section, the data one. */
export function onlyDataSection(sdp: string): boolean {
  const sections = sdp.split(/\r?\n/).filter((line) => line.startsWith('m='))
  return sections.length === 1 && sections[0]!.startsWith('m=application ')
}

/** ICE servers from `host:port` STUN servers. */
export function iceServers(stun: readonly string[]): { urls: string[] }[] {
  return stun.length > 0 ? [{ urls: stun.map((server) => `stun:${server}`) }] : []
}

/** A new attempt's id. */
export function attemptId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

type Handler<E> = { bivarianceHack(event: E): void }['bivarianceHack'] | null

interface RtcDescription {
  type: 'offer' | 'answer'
  sdp: string
}

/** The part of a standard RTCPeerConnection either side uses. */
export interface RtcPeerConnection {
  readonly connectionState: string
  readonly localDescription: { readonly sdp: string } | null
  createDataChannel(label: string, init: { ordered: boolean }): RtcDataChannel
  createOffer(): Promise<{ sdp?: string }>
  createAnswer(): Promise<{ sdp?: string }>
  setLocalDescription(description: RtcDescription): Promise<void>
  setRemoteDescription(description: RtcDescription): Promise<void>
  addIceCandidate(candidate: { candidate: string; sdpMid: string }): Promise<void>
  close(): void
  onicecandidate: Handler<{
    readonly candidate: { candidate: string; sdpMid: string | null } | null
  }>
  ondatachannel: Handler<{ readonly channel: RtcDataChannel }>
  onconnectionstatechange: Handler<unknown>
}

export type RtcFactory = (config: { iceServers: { urls: string[] }[] }) => RtcPeerConnection

/** What a side needs to open peer-to-peer paths: its WebRTC, and the STUN servers it may use. */
export interface PeerSystem {
  create: RtcFactory
  /** STUN servers, `host:port`, from the signed region list; none without one. */
  stun(): readonly string[]
}

/** One attempt's peer connection, its candidates and the DataChannel it waits for. */
class Attempt {
  readonly pc: RtcPeerConnection
  private candidates = 0
  /** Remote candidates wait for the remote description, and ours for our offer or answer. */
  private remoteSet = false
  private readonly early: { candidate: string; sdpMid: string }[] = []
  private localSent = false
  private readonly ours: P2pCandidate[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private done = false
  private transport: Transport | null = null

  constructor(
    readonly id: string,
    system: PeerSystem,
    private readonly send: (message: P2pMessage) => void,
    timeoutMs: number,
    private readonly failed: () => void,
  ) {
    this.pc = system.create({ iceServers: iceServers(system.stun()) })
    this.pc.onicecandidate = (event) => {
      const found = event.candidate
      if (!found || this.done || !found.candidate) return
      const line = candidateLine(found.candidate)
      const message: P2pCandidate = {
        type: 'p2p.candidate',
        id,
        candidate: line,
        mid: found.sdpMid ?? '0',
      }
      if (this.localSent) send(message)
      else this.ours.push(message)
    }
    // A path that failed under an open DataChannel ends it now, not at the next missed ping.
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState
      if (state !== 'failed' && state !== 'closed') return
      if (this.transport) this.transport.close()
      else this.fail()
    }
    this.timer = setTimeout(() => this.fail(true), timeoutMs)
  }

  /** Sends our description, then the candidates found before it. */
  sendLocal(message: P2pOffer | P2pAnswer): void {
    if (this.done) return
    this.send(message)
    this.localSent = true
    for (const candidate of this.ours.splice(0)) this.send(candidate)
  }

  async setRemote(description: RtcDescription): Promise<void> {
    await this.pc.setRemoteDescription(description)
    this.remoteSet = true
    for (const candidate of this.early.splice(0)) this.addCandidate(candidate)
  }

  remoteCandidate(message: P2pCandidate): void {
    if (this.done || ++this.candidates > MAX_P2P_CANDIDATES) return
    const candidate = { candidate: message.candidate, sdpMid: message.mid }
    if (this.remoteSet) this.addCandidate(candidate)
    else this.early.push(candidate)
  }

  /** The DataChannel opened: the transport is its owner's, and the attempt is over. */
  opened(channel: RtcDataChannel): Transport | null {
    if (this.done) return null
    this.settle()
    this.transport = dataChannelTransport(channel, () => this.pc.close())
    return this.transport
  }

  /** Gives the attempt up, telling the other side when `tell`. */
  fail(tell = false): void {
    if (this.done) return
    this.settle()
    if (tell) this.send({ type: 'p2p.close', id: this.id })
    this.pc.close()
    this.failed()
  }

  /** The other side gave it up. */
  closed(): void {
    this.fail(false)
  }

  get over(): boolean {
    return this.done
  }

  private settle(): void {
    this.done = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private addCandidate(candidate: { candidate: string; sdpMid: string }): void {
    // A candidate this side cannot use is skipped; the others may still connect.
    this.pc.addIceCandidate(candidate).catch(() => {})
  }
}

export interface PeerOfferOptions {
  system: PeerSystem
  /** Sends a signaling message on the session. */
  send(message: P2pMessage): void
  timeoutMs?: number
}

/**
 * The device's side of one attempt: offers, takes the host's answer and candidates, and settles
 * with the open DataChannel's transport, or rejects once given up.
 */
export class PeerOffer {
  readonly id = attemptId()
  readonly opened: Promise<Transport>
  private readonly attempt: Attempt

  constructor(options: PeerOfferOptions) {
    let resolve!: (transport: Transport) => void
    let reject!: (error: Error) => void
    this.opened = new Promise((ok, fail) => {
      resolve = ok
      reject = fail
    })
    this.opened.catch(() => {})
    this.attempt = new Attempt(
      this.id,
      options.system,
      options.send,
      options.timeoutMs ?? P2P_OPEN_TIMEOUT_MS,
      () => reject(new Error('The peer-to-peer path did not open')),
    )
    const channel = this.attempt.pc.createDataChannel(P2P_LABEL, { ordered: true })
    channel.onopen = () => {
      const transport = this.attempt.opened(channel)
      if (transport) resolve(transport)
    }
    void this.offer()
  }

  /** A message from the host for this attempt. */
  signal(message: P2pMessage): void {
    if (message.id !== this.id || this.attempt.over) return
    switch (message.type) {
      case 'p2p.answer':
        if (!onlyDataSection(message.sdp)) return this.attempt.fail(true)
        this.attempt.setRemote({ type: 'answer', sdp: message.sdp }).catch(() => {
          this.attempt.fail(true)
        })
        return
      case 'p2p.candidate':
        return this.attempt.remoteCandidate(message)
      case 'p2p.close':
        return this.attempt.closed()
    }
  }

  /** Gives the attempt up unless its DataChannel opened, which then is the transport's. */
  close(): void {
    this.attempt.fail(true)
  }

  private async offer(): Promise<void> {
    try {
      const offer = await this.attempt.pc.createOffer()
      await this.attempt.pc.setLocalDescription({ type: 'offer', sdp: offer.sdp ?? '' })
      const sdp = this.attempt.pc.localDescription?.sdp ?? offer.sdp ?? ''
      this.attempt.sendLocal({ type: 'p2p.offer', id: this.id, sdp })
    } catch {
      this.attempt.fail(false)
    }
  }
}

export interface PeerAnswersOptions {
  system: PeerSystem
  /** Sends a signaling message on the session. */
  send(message: P2pMessage): void
  /** A DataChannel opened: a connection like any other, its Noise handshake still to come. */
  accept(transport: Transport): void
  timeoutMs?: number
}

/**
 * The host's side of a session's attempts: answers each offer, the latest replacing one that did
 * not open yet, and hands the DataChannel over once it opens.
 */
export class PeerAnswers {
  private attempt: Attempt | null = null
  private ended = false

  constructor(private readonly options: PeerAnswersOptions) {}

  /** A message from the device. */
  signal(message: P2pMessage): void {
    if (this.ended) return
    const attempt = this.attempt
    switch (message.type) {
      case 'p2p.offer':
        return this.answer(message)
      case 'p2p.candidate':
        if (attempt?.id === message.id) attempt.remoteCandidate(message)
        return
      case 'p2p.close':
        if (attempt?.id === message.id) attempt.closed()
        return
    }
  }

  /** The session ended: an attempt still open goes with it. */
  close(): void {
    this.ended = true
    this.attempt?.fail(false)
    this.attempt = null
  }

  private answer(offer: P2pOffer): void {
    this.attempt?.fail(false)
    this.attempt = null
    const { system, send, accept } = this.options
    if (!onlyDataSection(offer.sdp)) return send({ type: 'p2p.close', id: offer.id })
    let attempt: Attempt
    try {
      attempt = new Attempt(
        offer.id,
        system,
        send,
        this.options.timeoutMs ?? P2P_OPEN_TIMEOUT_MS,
        () => {
          if (this.attempt === attempt) this.attempt = null
        },
      )
    } catch {
      return send({ type: 'p2p.close', id: offer.id })
    }
    this.attempt = attempt
    let taken = false
    attempt.pc.ondatachannel = ({ channel }) => {
      if (taken || channel.label !== P2P_LABEL) return channel.close()
      taken = true
      const open = (): void => {
        const transport = attempt.opened(channel)
        if (this.attempt === attempt) this.attempt = null
        if (transport) accept(transport)
      }
      if (channel.readyState === 'open') open()
      else channel.onopen = open
    }
    void (async () => {
      try {
        await attempt.setRemote({ type: 'offer', sdp: offer.sdp })
        const answer = await attempt.pc.createAnswer()
        await attempt.pc.setLocalDescription({ type: 'answer', sdp: answer.sdp ?? '' })
        const sdp = attempt.pc.localDescription?.sdp ?? answer.sdp ?? ''
        attempt.sendLocal({ type: 'p2p.answer', id: offer.id, sdp })
      } catch {
        attempt.fail(true)
      }
    })()
  }
}
