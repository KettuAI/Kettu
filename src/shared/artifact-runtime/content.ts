// The `content` capability as a type's viewer uses it: it reads and writes the content of the
// artifact it shows, and nothing else. Only the viewers of artifacts made from a type get it.

import type { ArtifactTypeName } from '../artifact-types'
import type { CapabilityTransport } from './capabilities'

export const CONTENT_CAPABILITY = 'content'

export const CONTENT_OPS = ['read', 'write'] as const

/** A version's content: its content file's text, with the version's files listed. */
export interface ContentRead {
  type: ArtifactTypeName
  format: number
  version: number
  /** The latest version; only it may be written from. */
  head: number
  entry: string
  text: string
  files: { path: string; size: number }[]
}

export interface ContentNamespace {
  read(version: number): Promise<ContentRead>
  /** A new version of the user's with the content file's text, from `baseVersion`, the latest. */
  write(baseVersion: number, text: string): Promise<{ version: number }>
}

/** The namespace `kettu.use('content')` gives, with the operations the host offers; frozen. */
export function contentNamespace(
  ops: readonly string[],
  transport: CapabilityTransport,
): Readonly<ContentNamespace> | null {
  if (!CONTENT_OPS.every((op) => ops.includes(op))) return null
  return Object.freeze({
    read: (version: number) =>
      transport.call(CONTENT_CAPABILITY, 'read', { version }) as Promise<ContentRead>,
    write: (baseVersion: number, text: string) =>
      transport.call(CONTENT_CAPABILITY, 'write', { baseVersion, text }) as Promise<{
        version: number
      }>,
  })
}
