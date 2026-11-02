// A paired device as the host knows it, and the identity the agent host and the terminal host give a
// device's port.

import type { PortChannel } from '../port-channel'
import { currentPrimitives } from './primitives'

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
  /** What the device runs, as "iOS 26.1". */
  platform: string
  /** The device's model, as "iPhone 17 Pro"; empty when it named none. */
  model: string
  addedAt: number
  /** When a session last opened or ended; while one is open, when it opened. */
  lastConnectedAt: number | null
}

/** What pairing learns of a device; the host derives its id and the times. */
export type NewDevice = Pick<PairedDevice, 'publicKey' | 'name' | 'kind' | 'platform' | 'model'>

/** Main could not rename or remove a device, as when the device files could not be read. */
export type DeviceChangeFailure = 'not_renamed' | 'not_removed'

/** The device a port to the agent host serves. */
export interface PortDevice {
  id: string
  name: string
  /** The device is a desktop app, whose main runs the browser calls of the turns it sends. */
  browser?: true
}

export async function deviceId(publicKey: Uint8Array): Promise<string> {
  const digest = await currentPrimitives().sha256(publicKey)
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

/** A device's model: a short word, or empty when the device named none. */
export function isDeviceModel(value: unknown): value is string {
  return value === '' || (isDeviceField(value) && ![...value].some((char) => char < ' '))
}

// Longer text is refused outright rather than cut, so a device cannot make the host scan megabytes.
const MAX_NAME_INPUT = 1024

/**
 * A name a device or the owner typed, made one the host keeps: control characters dropped, the
 * ends trimmed and cut to `DEVICE_NAME_CHARS`; null when nothing is left.
 */
export function normalizeDeviceName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_NAME_INPUT) return null
  const chars = [...value].filter((char) => char >= ' ' && char !== '\u007f')
  const name = chars.join('').trim()
  const cut = [...name].slice(0, DEVICE_NAME_CHARS).join('').trim()
  return cut.length > 0 ? cut : null
}

/** The device a port names, or null when the value does not name one. */
export function parsePortDevice(value: unknown): PortDevice | null {
  if (typeof value !== 'object' || value === null) return null
  const { id, name, browser } = value as Record<string, unknown>
  if (typeof id !== 'string' || !DEVICE_ID.test(id) || !isDeviceName(name)) return null
  return browser === true ? { id, name, browser } : { id, name }
}

/**
 * Reads who a port on a host's socket serves from its first message: a paired device's port starts
 * with a message of type `connect` that names it, as main sends it in the desktop app; any other
 * first message is a window's first request, which the port still carries.
 */
export function identifyPort(
  port: PortChannel,
  connect: string,
  serve: (port: PortChannel, device: PortDevice | null) => void,
): void {
  let identified = false
  let listener: ((data: unknown) => void) | null = null
  const waiting: unknown[] = []
  const rest: PortChannel = {
    send: (message) => port.send(message),
    onMessage: (next) => {
      listener = next
      for (const message of waiting.splice(0)) next(message)
    },
    onClose: (next) => port.onClose(next),
    close: () => port.close(),
  }
  port.onMessage((data) => {
    if (identified) {
      if (listener) listener(data)
      else waiting.push(data)
      return
    }
    identified = true
    if ((data as { type?: unknown } | null)?.type !== connect) {
      waiting.push(data)
      return serve(rest, null)
    }
    // A device's port that does not name one validly is never served as a window's.
    const device = parsePortDevice((data as { device?: unknown }).device)
    if (device) serve(rest, device)
    else port.close()
  })
}
