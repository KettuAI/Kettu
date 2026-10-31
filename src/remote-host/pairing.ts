// The pairing code: one at a time, made for whoever opened Add device, valid for five minutes and
// one device. A handshake that fails as Noise IK is tried with its secret; five failures void it.

import type { PairedDevice } from '@shared/remote/device'
import {
  PAIRING_ATTEMPTS,
  PAIRING_SECRET_BYTES,
  PAIRING_TTL_MS,
  PAIRING_VERSION,
  pairingLink,
  type PairingDevice,
  type PairingEnd,
  type PairingState,
} from '@shared/remote/pairing'
import type { DirectAddress } from '@shared/remote/protocol'

export interface PairingAnswer {
  add: boolean
  name: string
}

/**
 * `open` takes handshakes; `claimed` is held by the connection whose secret checked out, until its
 * hello; `asking` waits for the asker's answer.
 */
type CodeState = 'open' | 'claimed' | 'asking'

export interface PairingCode {
  readonly codeId: number
  readonly secret: Uint8Array
}

interface Code extends PairingCode {
  expiresAt: number
  attempts: number
  state: CodeState
  timer: ReturnType<typeof setTimeout> | null
  answer: ((answer: PairingAnswer | null) => void) | null
}

export interface PairingOptions {
  hostKey: Uint8Array
  /** Where devices may connect directly, for the code to carry. */
  addresses(): DirectAddress[]
  /** Tells the asker of `codeId` how its code is doing. */
  send(codeId: number, pairing: PairingState): void
  now?: () => number
  ttlMs?: number
}

export class PairingCodes {
  private code: Code | null = null
  private readonly now: () => number

  constructor(private readonly options: PairingOptions) {
    this.now = options.now ?? Date.now
  }

  /** A new code for the asker `codeId`; the code still open, if any, is void. */
  open(codeId: number): void {
    if (this.code) this.end(this.code, 'replaced')
    const ttl = this.options.ttlMs ?? PAIRING_TTL_MS
    const code: Code = {
      codeId,
      secret: crypto.getRandomValues(new Uint8Array(PAIRING_SECRET_BYTES)),
      expiresAt: this.now() + ttl,
      attempts: 0,
      state: 'open',
      timer: null,
      answer: null,
    }
    this.code = code
    this.wait(code)
  }

  /** The asker closed Add device. */
  close(codeId: number): void {
    if (this.code?.codeId === codeId) this.end(this.code, 'closed')
  }

  /** The code a first message that is not a known device's may be pairing with. */
  current(): PairingCode | null {
    const code = this.code
    return code?.state === 'open' && this.now() < code.expiresAt ? code : null
  }

  /** A handshake with the code's secret failed; the fifth voids it. */
  failed(code: PairingCode): void {
    if (code !== this.code || this.code.state !== 'open') return
    this.code.attempts++
    if (this.code.attempts >= PAIRING_ATTEMPTS) this.end(this.code, 'attempts')
  }

  /** Holds the code for the connection whose secret checked out; false when it is gone. */
  claim(code: PairingCode): boolean {
    if (code !== this.code || this.code.state !== 'open' || this.now() >= this.code.expiresAt) {
      return false
    }
    this.code.state = 'claimed'
    return true
  }

  /** Asks the asker about the device; resolves to its answer, or null once the code is void. */
  ask(code: PairingCode, device: PairingDevice): Promise<PairingAnswer | null> {
    const held = this.code
    if (code !== held || held.state !== 'claimed') return Promise.resolve(null)
    held.state = 'asking'
    return new Promise((resolve) => {
      held.answer = resolve
      this.options.send(held.codeId, { state: 'confirm', device })
    })
  }

  /** The asker's answer; a rejection voids the code. */
  answer(codeId: number, answer: PairingAnswer): void {
    const code = this.code
    if (code?.codeId !== codeId || code.state !== 'asking') return
    const resolve = code.answer!
    code.answer = null
    resolve(answer)
    if (!answer.add) this.end(code, 'rejected')
  }

  /** The device was added: the code has done its one pairing. */
  added(code: PairingCode, device: PairedDevice): void {
    if (code !== this.code) return
    this.clear(this.code)
    this.options.send(code.codeId, { state: 'added', device })
  }

  /** The connection holding the code ended before it was added: the code takes devices again. */
  release(code: PairingCode): void {
    const held = this.code
    if (code !== held || held.state === 'open') return
    held.answer?.(null)
    held.answer = null
    if (this.now() >= held.expiresAt) return this.end(held, 'expired')
    held.state = 'open'
    this.wait(held)
  }

  /** Remote access stops or resets: the code is void. */
  stop(): void {
    if (this.code) this.end(this.code, 'stopped')
  }

  private wait(code: Code): void {
    const link = pairingLink({
      version: PAIRING_VERSION,
      hostKey: this.options.hostKey,
      secret: code.secret,
      addresses: this.options.addresses(),
    })
    if (code.timer) clearTimeout(code.timer)
    code.timer = setTimeout(() => {
      code.timer = null
      // A code held for a device keeps its question; it expires if the device leaves.
      if (this.code === code && code.state === 'open') this.end(code, 'expired')
    }, code.expiresAt - this.now())
    this.options.send(code.codeId, { state: 'waiting', link, expiresAt: code.expiresAt })
  }

  private end(code: Code, reason: PairingEnd): void {
    if (code !== this.code) return
    const answer = code.answer
    this.clear(code)
    answer?.(null)
    this.options.send(code.codeId, { state: 'void', reason })
  }

  private clear(code: Code): void {
    if (code.timer) clearTimeout(code.timer)
    code.timer = null
    code.answer = null
    this.code = null
  }
}
