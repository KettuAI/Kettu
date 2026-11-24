// Switching a host to the owner's own relay: the relay and its key are checked first, and only a
// check that passed keeps the key, like the host's private key, and makes the relay the one in
// use. The desktop app and the daemon both run it, for this computer's page and for a device's.

import {
  isAccessKey,
  isRelayPin,
  parseRelayLink,
  type OwnRelayCheck,
  type OwnRelayCheckOptions,
  type OwnRelayInput,
} from '@shared/remote/own-relay'
import type { OwnRelaySettings } from '@shared/settings'

/** The input as a renderer or a device sent it, or null when it is not one. */
export function parseOwnRelayInput(value: unknown): OwnRelayInput | null {
  if (typeof value !== 'object' || value === null) return null
  const { url, key, pin } = value as Record<string, unknown>
  if (typeof url !== 'string' || url.length > 2048) return null
  if (key !== null && typeof key !== 'string') return null
  if (pin !== null && pin !== undefined && typeof pin !== 'string') return null
  return { url, key: key as string | null, pin: (pin as string | null | undefined) ?? null }
}

export interface OwnRelayDeps {
  /** The access key kept now, null for none. */
  key(): string | null
  /** Keeps the key that passed, in place of the one before. */
  saveKey(key: string): Promise<void>
  /** The relay kept in the settings now, null for none. */
  current(): OwnRelaySettings | null
  /** Makes the relay the one in use, in the settings. */
  apply(own: OwnRelaySettings): void
  /** Tells the remote host, as when only the key changed and the settings did not. */
  changed(): void
  /** Checks the relay from this computer. */
  check(options: Omit<OwnRelayCheckOptions, 'fetchInfo' | 'openSocket'>): Promise<OwnRelayCheck>
}

/**
 * Checks the relay and the key and switches to it once both pass; a failure changes nothing. A
 * null key keeps the one kept, for a new address of the same relay.
 */
export async function useOwnRelay(
  input: OwnRelayInput,
  deps: OwnRelayDeps,
): Promise<OwnRelayCheck> {
  const link = parseRelayLink(input.url)
  if (!link || link.key !== null) return { ok: false, problem: 'address' }
  const pin = input.pin === null || input.pin === '' ? null : input.pin
  if (pin !== null && !isRelayPin(pin)) return { ok: false, problem: 'certificate' }
  const key = input.key ?? deps.key()
  if (!isAccessKey(key)) return { ok: false, problem: 'key' }
  const result = await deps.check({ url: link.url, key, pin })
  if (!result.ok) return result
  const keyChanged = key !== deps.key()
  if (keyChanged) await deps.saveKey(key)
  const before = deps.current()
  deps.apply({ url: link.url, pin })
  // The settings stay the same when only the key changed, so the host hears it here.
  if (keyChanged && before?.url === link.url && before.pin === pin) deps.changed()
  return result
}
