// Requests from devices of the same Kettu account to be added: one at a time, each asked of the
// host's owner for DISCOVERY_ASK_MS, in the host's own windows and on every paired device. The
// first answer counts. A device is added only once the owner said add and the device's user said
// the codes match. DISCOVERY_STRIKES requests in a row that end without one stop the host taking
// any for DISCOVERY_COOLDOWN_MS.

import {
  DISCOVERY_ASK_MS,
  DISCOVERY_COOLDOWN_MS,
  DISCOVERY_STRIKES,
  type DiscoveryEnd,
  type DiscoveryRequestEvent,
  type PairGroup,
  type PairTranscript,
} from '@shared/remote/discovery'
import type { PairingDevice } from '@shared/remote/pairing'

/** How a request ends for its connection: added under `name`, or not and why. */
export type DiscoveryOutcome = { add: true; name: string } | { add: false; reason: DiscoveryEnd }

/** A connection's hold on the one request, from its handshake on. */
export interface DiscoverySlot {
  readonly slotId: number
}

interface Asked {
  device: PairingDevice
  code: string
  startedAt: number
  expiresAt: number
  transcript: PairTranscript
  group: PairGroup | null
}

interface Request extends DiscoverySlot {
  /** Set once the owner is asked. */
  requestId: number | null
  asked: Asked | null
  /** The answer that counted: the name to add under, and the paired device that gave it. */
  owner: { name: string; by: string | null } | null
  confirmed: boolean
  timer: ReturnType<typeof setTimeout> | null
  settle: ((outcome: DiscoveryOutcome) => void) | null
}

export interface DiscoveryOptions {
  /** Tells the owner's windows of a request's progress. */
  send(event: DiscoveryRequestEvent): void
  now?: () => number
  askMs?: number
  cooldownMs?: number
  strikes?: number
}

export class DiscoveryRequests {
  private request: Request | null = null
  private enabled = false
  private strikes = 0
  private coolUntil = 0
  private nextSlot = 1
  private nextRequest = 1
  private readonly now: () => number

  constructor(private readonly options: DiscoveryOptions) {
    this.now = options.now ?? Date.now
  }

  /** Whether the host takes requests: discoverable, on the relay and signed in. */
  get on(): boolean {
    return this.enabled
  }

  /** Turned off, the open request ends as stopped. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) this.stop()
  }

  /** The request the owner is asked about now, for a window that opens after it came. */
  pending(): DiscoveryRequestEvent | null {
    const request = this.request
    if (!request?.requestId || !request.timer || request.owner) return null
    return this.event(request)
  }

  /** Holds the one request for a connection whose handshake was discovery's, or says why not. */
  claim(): DiscoverySlot | 'busy' | 'cooling_down' {
    if (this.now() < this.coolUntil) return 'cooling_down'
    if (this.request) return 'busy'
    const request: Request = {
      slotId: this.nextSlot++,
      requestId: null,
      asked: null,
      owner: null,
      confirmed: false,
      timer: null,
      settle: null,
    }
    this.request = request
    return request
  }

  /** Asks the owner about the device; settles once both sides said yes, or the request ended. */
  ask(
    slot: DiscoverySlot,
    device: PairingDevice,
    code: string,
    transcript: PairTranscript,
    group: PairGroup | null = null,
  ): Promise<DiscoveryOutcome> {
    const request = this.request
    if (request !== slot || request.requestId !== null) {
      return Promise.resolve({ add: false, reason: 'stopped' })
    }
    request.requestId = this.nextRequest++
    const startedAt = this.now()
    const expiresAt = startedAt + (this.options.askMs ?? DISCOVERY_ASK_MS)
    request.timer = setTimeout(() => {
      request.timer = null
      this.end(request, 'expired')
    }, expiresAt - startedAt)
    request.asked = { device, code, startedAt, expiresAt, transcript, group }
    return new Promise((resolve) => {
      request.settle = resolve
      this.options.send(this.event(request))
    })
  }

  /**
   * The owner's answer, from the host itself or from the paired device `by` names; a no ends the
   * request. False when another answer counted already, or the request is over.
   */
  answer(requestId: number, add: boolean, name: string, by: string | null = null): boolean {
    const request = this.request
    if (!request || request.requestId !== requestId || !request.timer || request.owner) return false
    if (!add) {
      this.end(request, 'rejected', by)
      return true
    }
    request.owner = { name, by }
    this.decide(request)
    return true
  }

  /** The device's user said the codes match, which every place asking hears. */
  confirm(slot: DiscoverySlot): void {
    const request = this.request
    if (request !== slot || !request.timer || request.confirmed) return
    request.confirmed = true
    if (!request.owner) this.options.send(this.event(request))
    this.decide(request)
  }

  /** The device was added, which clears the strikes. */
  added(slot: DiscoverySlot): void {
    if (this.request !== slot) return
    this.strikes = 0
    this.close(this.request, 'added')
  }

  /**
   * The connection holding the slot ended or failed: a request the owner was asked about ends as
   * cancelled, one never asked frees the slot without a word.
   */
  release(slot: DiscoverySlot): void {
    const request = this.request
    if (request !== slot) return
    if (request.requestId === null) {
      this.request = null
      return
    }
    this.end(request, 'cancelled')
  }

  /** Remote access stops or discovery is off: the open request ends. */
  stop(): void {
    if (this.request) this.end(this.request, 'stopped')
  }

  private decide(request: Request): void {
    if (!request.owner || !request.confirmed) return
    const settle = request.settle
    request.settle = null
    if (request.timer) clearTimeout(request.timer)
    request.timer = null
    settle?.({ add: true, name: request.owner.name })
  }

  private end(
    request: Request,
    reason: Exclude<DiscoveryEnd, 'added'>,
    by: string | null = null,
  ): void {
    if (this.request !== request) return
    if (reason !== 'stopped' && ++this.strikes >= (this.options.strikes ?? DISCOVERY_STRIKES)) {
      this.strikes = 0
      this.coolUntil = this.now() + (this.options.cooldownMs ?? DISCOVERY_COOLDOWN_MS)
    }
    const settle = request.settle
    request.settle = null
    this.close(request, reason, by)
    settle?.({ add: false, reason })
  }

  private close(request: Request, reason: DiscoveryEnd, by: string | null = null): void {
    if (request.timer) clearTimeout(request.timer)
    request.timer = null
    this.request = null
    if (request.requestId === null) return
    const answeredOn = by ?? (reason === 'added' ? request.owner?.by : null)
    this.options.send({
      requestId: request.requestId,
      request: { state: 'closed', reason, ...(answeredOn ? { answeredOn } : {}) },
    })
  }

  private event(request: Request): DiscoveryRequestEvent {
    const { device, code, startedAt, expiresAt, transcript, group } = request.asked!
    return {
      requestId: request.requestId!,
      request: {
        state: 'confirm',
        device,
        code,
        startedAt,
        expiresAt,
        deviceConfirmed: request.confirmed,
        transcript,
        ...(group ? { group } : {}),
      },
    }
  }
}
