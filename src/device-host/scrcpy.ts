// The wire protocol of scrcpy's server (Apache-2.0), pinned to the version Kettu ships: the video
// socket's metadata and packets, and the control messages Kettu sends. There is no compatibility
// between versions, so the server's version is part of how it is started.
// https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/develop.md

export const SCRCPY_VERSION = '5.0.1'

const DEVICE_NAME_BYTES = 64
const HEADER_BYTES = 12
const FLAG_SESSION = 0x80
const FLAG_CONFIG = 0x40
const FLAG_KEY = 0x20

export const SCRCPY_CODEC_H264 = 0x68323634

export type ScrcpyVideoEvent =
  | { type: 'meta'; deviceName: string }
  | { type: 'codec'; codec: number }
  | { type: 'disabled'; error: boolean }
  | { type: 'session'; width: number; height: number }
  | { type: 'packet'; config: boolean; key: boolean; data: Uint8Array }

export class ScrcpyProtocolError extends Error {}

/**
 * Reads the video socket of a forward tunnel: the dummy byte and the device name (it is the first
 * socket), the codec id, then session and media packets.
 */
export class ScrcpyVideoReader {
  private buffer = new Uint8Array(256 * 1024)
  private length = 0
  private stage: 'dummy' | 'meta' | 'codec' | 'packets' = 'dummy'

  constructor(options: { dummyByte?: boolean; deviceMeta?: boolean } = {}) {
    if (options.dummyByte === false) this.stage = options.deviceMeta === false ? 'codec' : 'meta'
  }

  push(bytes: Uint8Array): ScrcpyVideoEvent[] {
    this.append(bytes)
    const events: ScrcpyVideoEvent[] = []
    let offset = 0
    for (;;) {
      const available = this.length - offset
      if (this.stage === 'dummy') {
        if (available < 1) break
        offset += 1
        this.stage = 'meta'
      } else if (this.stage === 'meta') {
        if (available < DEVICE_NAME_BYTES) break
        const raw = this.buffer.subarray(offset, offset + DEVICE_NAME_BYTES)
        const end = raw.indexOf(0)
        const deviceName = new TextDecoder().decode(end === -1 ? raw : raw.subarray(0, end))
        events.push({ type: 'meta', deviceName })
        offset += DEVICE_NAME_BYTES
        this.stage = 'codec'
      } else if (this.stage === 'codec') {
        if (available < 4) break
        const codec = this.view(offset).getUint32(0, false)
        offset += 4
        if (codec === 0 || codec === 1) {
          events.push({ type: 'disabled', error: codec === 1 })
          this.length = 0
          return events
        }
        events.push({ type: 'codec', codec })
        this.stage = 'packets'
      } else {
        if (available < HEADER_BYTES) break
        const first = this.buffer[offset]!
        const view = this.view(offset)
        if (first & FLAG_SESSION) {
          events.push({
            type: 'session',
            width: view.getUint32(4, false),
            height: view.getUint32(8, false),
          })
          offset += HEADER_BYTES
          continue
        }
        const size = view.getUint32(8, false)
        if (size > 32 * 1024 * 1024) throw new ScrcpyProtocolError(`A packet of ${size} bytes`)
        if (available < HEADER_BYTES + size) break
        events.push({
          type: 'packet',
          config: (first & FLAG_CONFIG) !== 0,
          key: (first & FLAG_KEY) !== 0,
          data: this.buffer.slice(offset + HEADER_BYTES, offset + HEADER_BYTES + size),
        })
        offset += HEADER_BYTES + size
      }
    }
    if (offset > 0) {
      this.buffer.copyWithin(0, offset, this.length)
      this.length -= offset
    }
    return events
  }

  private view(offset: number): DataView {
    return new DataView(this.buffer.buffer, this.buffer.byteOffset + offset)
  }

  private append(bytes: Uint8Array): void {
    if (this.length + bytes.length > this.buffer.length) {
      let capacity = this.buffer.length
      while (capacity < this.length + bytes.length) capacity *= 2
      const grown = new Uint8Array(capacity)
      grown.set(this.buffer.subarray(0, this.length))
      this.buffer = grown
    }
    this.buffer.set(bytes, this.length)
    this.length += bytes.length
  }
}

const TYPE_INJECT_KEYCODE = 0
const TYPE_INJECT_TEXT = 1
const TYPE_INJECT_TOUCH = 2
const TYPE_INJECT_SCROLL = 3
const TYPE_BACK_OR_SCREEN_ON = 4
const TYPE_SET_CLIPBOARD = 9
const TYPE_ROTATE_DEVICE = 11
const TYPE_RESET_VIDEO = 17

/** The server truncates longer text; Kettu splits before that. */
export const SCRCPY_MAX_TEXT_BYTES = 300

export const ANDROID_KEYCODE = {
  home: 3,
  back: 4,
  dpadUp: 19,
  dpadDown: 20,
  dpadLeft: 21,
  dpadRight: 22,
  volumeUp: 24,
  volumeDown: 25,
  power: 26,
  tab: 61,
  space: 62,
  enter: 66,
  del: 67,
  pageUp: 92,
  pageDown: 93,
  escape: 111,
  forwardDel: 112,
  moveHome: 122,
  moveEnd: 123,
  appSwitch: 187,
} as const

export type AndroidKeyAction = 'down' | 'up'
export type TouchAction = 'down' | 'up' | 'move'

const TOUCH_ACTION: Record<TouchAction, number> = { down: 0, up: 1, move: 2 }

export interface ScreenPoint {
  x: number
  y: number
  /** The size of the video frame the point is in, which the server maps to the display. */
  width: number
  height: number
}

function position(view: DataView, offset: number, point: ScreenPoint): void {
  view.setInt32(offset, Math.round(point.x), false)
  view.setInt32(offset + 4, Math.round(point.y), false)
  view.setUint16(offset + 8, point.width, false)
  view.setUint16(offset + 10, point.height, false)
}

export function keycodeMessage(
  action: AndroidKeyAction,
  keycode: number,
  metaState = 0,
): Uint8Array {
  const out = new Uint8Array(14)
  const view = new DataView(out.buffer)
  out[0] = TYPE_INJECT_KEYCODE
  out[1] = action === 'down' ? 0 : 1
  view.setUint32(2, keycode, false)
  view.setUint32(6, 0, false)
  view.setUint32(10, metaState, false)
  return out
}

function stringMessage(prefix: Uint8Array, text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text)
  const out = new Uint8Array(prefix.length + 4 + bytes.length)
  out.set(prefix)
  new DataView(out.buffer).setUint32(prefix.length, bytes.length, false)
  out.set(bytes, prefix.length + 4)
  return out
}

export function textMessage(text: string): Uint8Array {
  return stringMessage(Uint8Array.of(TYPE_INJECT_TEXT), text)
}

/** Splits text on character boundaries into pieces the server injects whole. */
export function textChunks(text: string, maxBytes = SCRCPY_MAX_TEXT_BYTES): string[] {
  const chunks: string[] = []
  let chunk = ''
  let size = 0
  for (const character of text) {
    const bytes = new TextEncoder().encode(character).length
    if (size + bytes > maxBytes && chunk) {
      chunks.push(chunk)
      chunk = ''
      size = 0
    }
    chunk += character
    size += bytes
  }
  if (chunk) chunks.push(chunk)
  return chunks
}

export function touchMessage(
  action: TouchAction,
  pointerId: number,
  point: ScreenPoint,
): Uint8Array {
  const out = new Uint8Array(32)
  const view = new DataView(out.buffer)
  out[0] = TYPE_INJECT_TOUCH
  out[1] = TOUCH_ACTION[action]
  view.setBigUint64(2, BigInt(pointerId), false)
  position(view, 10, point)
  view.setUint16(22, action === 'up' ? 0 : 0xffff, false)
  view.setUint32(24, 0, false)
  view.setUint32(28, 0, false)
  return out
}

/** `dx` and `dy` in notches, -16 to 16. */
export function scrollMessage(point: ScreenPoint, dx: number, dy: number): Uint8Array {
  const out = new Uint8Array(21)
  const view = new DataView(out.buffer)
  out[0] = TYPE_INJECT_SCROLL
  position(view, 1, point)
  const fixed = (value: number): number => {
    const normalized = Math.max(-1, Math.min(1, value / 16))
    return normalized >= 1 ? 0x7fff : Math.round(normalized * 0x8000)
  }
  view.setInt16(13, fixed(dx), false)
  view.setInt16(15, fixed(dy), false)
  view.setUint32(17, 0, false)
  return out
}

export function backMessage(action: AndroidKeyAction): Uint8Array {
  return Uint8Array.of(TYPE_BACK_OR_SCREEN_ON, action === 'down' ? 0 : 1)
}

/** Sets the device's clipboard, and pastes it when `paste` is set. */
export function clipboardMessage(sequence: number, text: string, paste: boolean): Uint8Array {
  const prefix = new Uint8Array(10)
  const view = new DataView(prefix.buffer)
  prefix[0] = TYPE_SET_CLIPBOARD
  view.setBigUint64(1, BigInt(sequence), false)
  prefix[9] = paste ? 1 : 0
  return stringMessage(prefix, text)
}

export function rotateMessage(): Uint8Array {
  return Uint8Array.of(TYPE_ROTATE_DEVICE)
}

/** Asks the encoder for a new keyframe. */
export function resetVideoMessage(): Uint8Array {
  return Uint8Array.of(TYPE_RESET_VIDEO)
}
