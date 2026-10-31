// Where in a host protocol message a value sits that the channel carries as a stream: an upload a
// device's request names, or a binary value in the agent host's result.

/** Deeper than any request or result nests, so nothing below it is looked for. */
const MAX_DEPTH = 64

export interface Place {
  holder: Record<string | number, unknown>
  key: string | number
}

/** Every place below `holder[key]` whose value `matches`, itself included; none inside those. */
export function findPlaces(
  holder: Record<string | number, unknown>,
  key: string | number,
  matches: (value: unknown) => boolean,
): Place[] {
  const found: Place[] = []
  const visit = (parent: Record<string | number, unknown>, at: string | number, depth: number) => {
    const value = parent[at]
    if (typeof value !== 'object' || value === null) return
    if (matches(value)) {
      found.push({ holder: parent, key: at })
      return
    }
    if (depth >= MAX_DEPTH || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return
    const record = value as Record<string | number, unknown>
    if (Array.isArray(value)) for (let i = 0; i < value.length; i++) visit(record, i, depth + 1)
    else for (const name of Object.keys(value)) visit(record, name, depth + 1)
  }
  visit(holder, key, 0)
  return found
}

/** Whether a value is binary, as the agent host's results carry bytes. */
export function isBinary(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
}

/** A binary value's bytes, without copying them. */
export function bytesOf(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}
