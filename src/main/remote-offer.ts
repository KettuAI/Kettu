// Asks once whether to turn remote access on, while this computer is signed in with it off and
// has no device, for each phone, tablet or other computer that signs in to the account: remote
// access is off by default, and the user is at this computer then. Read at start and every 10
// minutes while that holds; the clients asked about are kept here.

import type { AccountClient } from '@shared/account-api'
import type { RemoteOffer } from '@shared/remote/discovery'

/** How often the account's clients are read while an offer could be made. */
export const OFFER_CHECK_MS = 10 * 60_000

/** The kinds of client that use another computer: phones, tablets, browsers and desktop apps. */
const USERS: ReadonlySet<AccountClient['kind']> = new Set(['ios', 'web', 'desktop'])

export interface RemoteOffersOptions {
  /** Signed in with Kettu's services on, remote access off and no paired device. */
  eligible(): boolean
  /** The account's signed-in clients; rejects when they cannot be read now. */
  clients(): Promise<AccountClient[]>
  /** The clients asked about before, kept between runs. */
  asked(): readonly string[]
  keepAsked(ids: string[]): void
  /** The offer shown changed, null once there is none. */
  changed(offer: RemoteOffer | null): void
  checkMs?: number
}

export class RemoteOffers {
  private offer: RemoteOffer | null = null
  /** The clients listed when the offer was made, all answered with it. */
  private listed: string[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private reading = false

  constructor(private readonly options: RemoteOffersOptions) {}

  get current(): RemoteOffer | null {
    return this.offer
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.check(), this.options.checkMs ?? OFFER_CHECK_MS)
    this.timer.unref?.()
    void this.check()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Something it depends on changed: an offer that no longer holds goes. */
  refresh(): void {
    if (this.offer && !this.options.eligible()) this.set(null)
  }

  /**
   * Reads the account's clients for an offer; one shown stays while its client is signed in, and
   * gives way to another once it signed out.
   */
  async check(): Promise<void> {
    if (!this.options.eligible()) return this.set(null)
    if (this.reading) return
    this.reading = true
    try {
      const clients = await this.options.clients()
      if (!this.options.eligible()) return this.set(null)
      const asked = new Set(this.options.asked())
      const others = clients
        .filter((client) => !client.current && USERS.has(client.kind))
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      this.listed = others.map((client) => client.id)
      const shown = this.offer && others.find((client) => client.id === this.offer?.clientId)
      // The most recently used one names the offer; answering it answers for the others listed.
      const named = shown || others.find((client) => !asked.has(client.id))
      this.set(named ? { clientId: named.id, name: named.name, kind: named.kind } : null)
    } catch {
      // Read again at the next check.
    } finally {
      this.reading = false
    }
  }

  /** The user answered; every client listed with it counts as asked about. */
  answer(clientId: string): boolean {
    if (this.offer?.clientId !== clientId) return false
    const asked = new Set(this.options.asked())
    for (const id of [...this.listed, clientId]) asked.add(id)
    this.options.keepAsked([...asked])
    this.listed = []
    this.set(null)
    return true
  }

  private set(offer: RemoteOffer | null): void {
    if (JSON.stringify(offer) === JSON.stringify(this.offer)) return
    this.offer = offer
    this.options.changed(offer)
  }
}
