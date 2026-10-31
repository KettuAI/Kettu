// A paired device as the host knows it, and the identity the agent host gives a device's port.

/** A device's id: the first 16 bytes of its X25519 public key's SHA-256, in hex. */
export const DEVICE_ID = /^[0-9a-f]{32}$/

/** The longest name a device may have. */
export const DEVICE_NAME_CHARS = 64

const MAX_DEVICE_FIELD = 64

/** A device that may connect to the host. */
export interface PairedDevice {
  id: string
  /** Its X25519 public key, in base64. */
  publicKey: string
  name: string
  /** `ios`, `web` or `desktop`. */
  kind: string
  platform: string
  addedAt: number
  lastConnectedAt: number | null
}

/** What pairing learns of a device; the host derives its id and the times. */
export type NewDevice = Pick<PairedDevice, 'publicKey' | 'name' | 'kind' | 'platform'>

/** The device a port to the agent host serves. */
export interface PortDevice {
  id: string
  name: string
}

export async function deviceId(publicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', publicKey as Uint8Array<ArrayBuffer>),
  )
  return Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function isDeviceName(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) return false
  return [...value].length <= DEVICE_NAME_CHARS && ![...value].some((char) => char < ' ')
}

/** A device's kind or platform: a short word. */
export function isDeviceField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_DEVICE_FIELD
}

/** The device a port names, or null when the value does not name one. */
export function parsePortDevice(value: unknown): PortDevice | null {
  if (typeof value !== 'object' || value === null) return null
  const { id, name } = value as Record<string, unknown>
  if (typeof id !== 'string' || !DEVICE_ID.test(id) || !isDeviceName(name)) return null
  return { id, name }
}
