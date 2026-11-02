// Byte streams on a device's channel: where the window's host protocol has an ArrayBuffer, a
// device's request names a stream it uploaded and the host's result names one it sends. Media
// reads, which a window gets from main's media scheme, are answered the same way.

import { ATTACHMENT_BYTES } from '../attachments'
import type { BrowserForward } from '../browser'
import type { MediaFile } from '../media'
import type { PortError } from '../port-rpc'

/** The welcome's feature for byte streams. */
export const BYTES_FEATURE = 'bytes'

/** The largest upload, as large as the agent host takes an attachment's bytes. */
export const MAX_UPLOAD_BYTES = ATTACHMENT_BYTES

/** Uploads a device may have open or waiting for a request at once, over all its connections. */
export const MAX_UPLOADS = 8

/** How long an upload may go without bytes, or wait for a request to name it, before it goes. */
export const UPLOAD_IDLE_MS = 60_000

/** Media streams a connection may have open at once. */
export const MAX_MEDIA_STREAMS = 16

/** The device opens an upload of `size` bytes; its ids are odd, each larger than the last. */
export interface StreamOpen {
  type: 'stream.open'
  stream: number
  size: number
}

/** The side sending a stream has sent all of it. */
export interface StreamEnd {
  type: 'stream.end'
  stream: number
}

/**
 * Either side gives a stream up: the device its upload or a download it no longer wants, the host
 * one it cannot take or finish, saying why.
 */
export interface StreamCancel {
  type: 'stream.cancel'
  stream: number
  error?: PortError
}

/**
 * A binary value carried as a stream: in a device's request the upload to put there, in a result
 * a download of `size` bytes that follows the result on the channel.
 */
export interface StreamRef {
  $stream: number
  size?: number
}

/**
 * A device's `media.read`: a file named as `media.open` names one, or a part of it. Without
 * `sessionId`, only a file in the project is read, as the Files pane finds one.
 */
export interface MediaReadParams {
  projectPath: string
  path: string
  sessionId?: string
  /** The first byte, 0 unless given. */
  offset?: number
  /** How many bytes, to the end of the file unless given. */
  length?: number
}

export type MediaReadResult =
  | {
      kind: 'granted'
      media: Omit<MediaFile, 'path'>
      offset: number
      /** The bytes the stream carries, fewer than asked when the file ends first. */
      length: number
      bytes: StreamRef
    }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'not_media' }

/** A forward's connections a device may have open at once, on one session. */
export const MAX_FORWARDS = 32

/**
 * The device opens a forward: one TCP connection to a dev server on the host, at a port an agent
 * of the session navigated the device's page to. `stream` is an id the device opens, as for an
 * upload; the bytes go both ways under it, `stream.end` from either side ends that side's
 * direction, and `stream.cancel` from either side ends the connection.
 */
export interface ForwardOpen {
  type: 'forward.open'
  stream: number
  sessionId: string
  host: BrowserForward['host']
  port: number
}

/** Whether a stream id is one a device opens: odd, and 32 bits. */
export function isDeviceStream(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) % 2 === 1 && (value as number) <= 0xffffffff
}

/** Whether a value in a request names an upload in place of a binary value: `$stream` alone. */
export function isUploadRef(value: unknown): value is { $stream: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0] === '$stream'
}
