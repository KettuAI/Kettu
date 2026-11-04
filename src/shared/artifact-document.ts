// The document type's content: Markdown in `document.md`, with pictures under `images/`. Read alike
// by the host, which checks and exports it, and by the viewer, which shows and edits it.

import { GFM, parser } from '@lezer/markdown'
import { IMAGES_FOLDER } from './artifact-types'

const markdown = parser.configure(GFM)

/** The kinds of picture both types hold: what Word, PowerPoint and every browser show. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif'] as const

/** Whether `path` is where a type keeps a picture: under `images/`, with a picture's extension. */
export function isImagePath(path: string): boolean {
  if (!path.startsWith(IMAGES_FOLDER) || path.length === IMAGES_FOLDER.length) return false
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return path.includes('.') && (IMAGE_EXTENSIONS as readonly string[]).includes(extension)
}

/** A top-level block of the Markdown: where its source starts and ends. */
export interface MarkdownBlock {
  from: number
  to: number
  /** The parser's name for it, such as Paragraph, ATXHeading1 or FencedCode. */
  kind: string
}

/** The top-level blocks, in order; link reference definitions are blocks too. */
export function markdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  for (let node = markdown.parse(text).topNode.firstChild; node; node = node.nextSibling) {
    blocks.push({ from: node.from, to: node.to, kind: node.name })
  }
  return blocks
}

/** A picture the Markdown shows: what it names, and the line it is on, from 1. */
export interface MarkdownImage {
  target: string
  line: number
}

function lineAt(text: string, offset: number): number {
  let line = 1
  for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) line++
  return line
}

function normalLabel(label: string): string {
  return label.slice(1, -1).trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Every picture the Markdown shows, inline or by a reference, in order. */
export function markdownImages(text: string): MarkdownImage[] {
  const tree = markdown.parse(text)
  const references = new Map<string, string>()
  const images: { from: number; url: string | null; label: string | null }[] = []
  tree.iterate({
    enter(node) {
      if (node.name === 'LinkReference') {
        const label = node.node.getChild('LinkLabel')
        const url = node.node.getChild('URL')
        if (label && url) {
          const key = normalLabel(text.slice(label.from, label.to))
          if (!references.has(key)) references.set(key, text.slice(url.from, url.to))
        }
        return false
      }
      if (node.name !== 'Image') return
      const url = node.node.getChild('URL')
      const label = node.node.getChild('LinkLabel')
      images.push({
        from: node.from,
        url: url ? text.slice(url.from, url.to) : null,
        label: label ? text.slice(label.from, label.to) : null,
      })
      return false
    },
  })
  return images.flatMap(({ from, url, label }) => {
    const target = url ?? (label ? references.get(normalLabel(label)) : undefined)
    return target === undefined ? [] : [{ target: unwrap(target), line: lineAt(text, from) }]
  })
}

function unwrap(target: string): string {
  return target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target
}

/**
 * The artifact path a picture's target names, such as `images/chart.png` for `./images/chart.png`
 * or `images/my%20chart.png`; null for a URL, an absolute path or one that leaves the artifact.
 */
export function imagePathOf(target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.startsWith('#')) {
    return null
  }
  let path = target.split(/[?#]/, 1)[0]!
  try {
    path = decodeURIComponent(path)
  } catch {
    return null
  }
  while (path.startsWith('./')) path = path.slice(2)
  return path === '' || path.split('/').some((segment) => segment === '..') ? null : path
}
