// The host's relay exists only while Use the Kettu relay is on: off, it neither reads the region
// list nor opens a socket, so a computer with Kettu's services off never reaches the relay.

import type { RelayHost } from '@shared/remote/relay-host'

export class RelaySwitch {
  private relay: RelayHost | null = null

  /** `make` gives a relay not yet started, or null when the host has none, as without its key. */
  constructor(private readonly make: () => RelayHost | null) {}

  /** The running relay; null while it is off. */
  get current(): RelayHost | null {
    return this.relay
  }

  /** Starts a new relay with the token when it turns on; stops it, timers and all, when off. */
  set(enabled: boolean, token: string | null): void {
    if (!enabled) return this.stop()
    if (this.relay) return
    this.relay = this.make()
    this.relay?.start()
    this.relay?.setToken(token)
  }

  stop(): void {
    this.relay?.stop()
    this.relay = null
  }
}
