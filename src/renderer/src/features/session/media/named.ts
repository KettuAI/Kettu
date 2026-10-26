// Media files a reply names by file reference, shown under the block that names them.

import { createContext } from 'react'
import { mediaKindOfName } from '@shared/media'
import { localTarget } from '@renderer/features/session/markdown/local-links'

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

const SCHEME = /^[a-z][a-z\d+.-]*:/i
const DRIVE = /^[a-z]:[\\/]/i
const FILE_URI = /^file:/i
const PATH_START = /^(?:\/(?!\/)|~[\\/]|\.{1,2}[\\/]|[a-z]:[\\/]|file:)/i

/**
 * A file reference's text when it names a media file: a path relative to the session's folder,
 * absolute, `~/` or a `file:` URI, ending in a media file's extension. Text with a space counts
 * only from an explicit path start, so a command such as `ffmpeg -i a.mp4` stays text.
 */
export function mediaReference(text: string): string | null {
  const value = text.trim()
  if (!value || value.includes('\n') || value.startsWith('#') || value.startsWith('//')) {
    return null
  }
  if (SCHEME.test(value) && !DRIVE.test(value) && !FILE_URI.test(value)) return null
  if (/\s/.test(value) && !PATH_START.test(value)) return null
  return mediaKindOfName(value) ? value : null
}

/** Blocks that show their own media, so a block above them leaves theirs alone. */
const BLOCKS = new Set(['p', 'li', 'ul', 'ol', 'table', 'pre', 'blockquote'])

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

/** The media files a block's inline code and links name, in order, each once. */
export function namedMedia(block: HastNode | undefined): string[] {
  const found: string[] = []
  const add = (path: string | null) => {
    if (path !== null && !found.includes(path)) found.push(path)
  }
  const visit = (node: HastNode, top: boolean) => {
    if (node.type !== 'element') return
    if (!top && BLOCKS.has(node.tagName ?? '')) return
    if (node.tagName === 'code') {
      add(mediaReference(textOf(node)))
      return
    }
    if (node.tagName === 'a') {
      const href = node.properties?.href
      const local = typeof href === 'string' ? localTarget(href) : null
      if (local !== null) add(mediaReference(local))
    }
    for (const child of node.children ?? []) visit(child, false)
  }
  if (block) visit(block, true)
  return found
}

/** A block's claim on the files it names. */
export interface MediaClaim<T> {
  at: T
  paths: readonly string[]
}

/** A path as written, the same for two ways a message writes one file. */
export const sameFile = (path: string) => path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')

/**
 * The files one message names, so each shows once: in place for a Markdown image, else under the
 * first block that names it. `before` orders two blocks as the message reads.
 */
export class NamedMedia<T = Element> {
  private readonly claims = new Set<MediaClaim<T>>()
  private readonly images = new Map<string, number>()
  private readonly listeners = new Set<() => void>()
  private version = 0

  constructor(
    private readonly before: (a: T, b: T) => boolean = (a, b) =>
      !!((a as Element).compareDocumentPosition(b as Element) & Node.DOCUMENT_POSITION_FOLLOWING),
  ) {}

  claim(claim: MediaClaim<T>): () => void {
    this.claims.add(claim)
    this.changed()
    return () => {
      this.claims.delete(claim)
      this.changed()
    }
  }

  /** A Markdown image of the file, which shows where it is written. */
  image(path: string): () => void {
    const file = sameFile(path)
    this.images.set(file, (this.images.get(file) ?? 0) + 1)
    this.changed()
    return () => {
      const left = (this.images.get(file) ?? 1) - 1
      if (left > 0) this.images.set(file, left)
      else this.images.delete(file)
      this.changed()
    }
  }

  /** The paths a block shows: those no image shows and no earlier block names. */
  shown(claim: MediaClaim<T>): string[] {
    return claim.paths.filter((path) => {
      const file = sameFile(path)
      if (this.images.has(file)) return false
      for (const other of this.claims) {
        if (other === claim || !other.paths.some((p) => sameFile(p) === file)) continue
        if (this.before(other.at, claim.at)) return false
      }
      return true
    })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  private changed(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }
}

/** The message being rendered, whose blocks share out the media they name. */
export const NamedMediaContext = createContext<NamedMedia | null>(null)
