// The tagged framing serve-sim's `stream.avcc` uses and Kettu's device helpers speak over stdio:
// each message is a 4-byte big-endian length, then that many bytes, a tag byte and its payload.

/** No message on these streams comes near this; a longer length means the stream is broken. */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024

export const FRAME_TAG = {
  description: 0x01,
  keyframe: 0x02,
  delta: 0x03,
  seed: 0x04,
  touch: 0x03,
  button: 0x04,
  key: 0x06,
  orientation: 0x07,
  requestKeyframe: 0x08,
  screen: 0x10,
  status: 0x11,
} as const

export interface Frame {
  tag: number
  payload: Uint8Array
}

export class FramingError extends Error {}

/** Splits a byte stream into frames, keeping a partial frame until the rest arrives. */
export class FrameReader {
  private buffer = new Uint8Array(64 * 1024)
  private length = 0

  push(bytes: Uint8Array): Frame[] {
    this.reserve(bytes.length)
    this.buffer.set(bytes, this.length)
    this.length += bytes.length
    const frames: Frame[] = []
    let offset = 0
    while (this.length - offset >= 4) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, 4)
      const size = view.getUint32(0, false)
      if (size > MAX_FRAME_BYTES) throw new FramingError(`A frame of ${size} bytes is too long`)
      if (this.length - offset - 4 < size) break
      if (size >= 1) {
        frames.push({
          tag: this.buffer[offset + 4]!,
          payload: this.buffer.slice(offset + 5, offset + 4 + size),
        })
      }
      offset += 4 + size
    }
    if (offset > 0) {
      this.buffer.copyWithin(0, offset, this.length)
      this.length -= offset
    }
    return frames
  }

  reset(): void {
    this.length = 0
  }

  private reserve(extra: number): void {
    if (this.length + extra <= this.buffer.length) return
    let capacity = this.buffer.length
    while (capacity < this.length + extra) capacity *= 2
    const grown = new Uint8Array(capacity)
    grown.set(this.buffer.subarray(0, this.length))
    this.buffer = grown
  }
}

export function encodeFrame(tag: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length)
  new DataView(out.buffer).setUint32(0, payload.length + 1, false)
  out[4] = tag
  out.set(payload, 5)
  return out
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeJsonFrame(tag: number, value: unknown): Uint8Array {
  return encodeFrame(tag, encoder.encode(JSON.stringify(value)))
}

/** The JSON a frame carries, or null when it is not JSON. */
export function frameJson(payload: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(payload))
  } catch {
    return null
  }
}

/** serve-sim's input socket takes a tag byte and JSON, without the length. */
export function taggedJson(tag: number, value: unknown): Uint8Array<ArrayBuffer> {
  const json = encoder.encode(JSON.stringify(value))
  const out = new Uint8Array(1 + json.length)
  out[0] = tag
  out.set(json, 1)
  return out
}
