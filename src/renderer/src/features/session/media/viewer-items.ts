// What the viewer steps through: the session's images and videos in thread order, as far as the
// loaded pages reach, then the images attached to the composer's draft.

import { GFM, parser } from '@lezer/markdown'
import { mediaKindOfName } from '@shared/media'
import type { Attachment, ContentRef, ThreadEntry, ThreadState, UserContent } from '@shared/thread'
import type { DraftAttachment } from '@renderer/stores/attachments'
import { isLocalImage, spacedImages } from '../markdown/local-images'
import { isLocalLink } from '../markdown/local-links'
import { mediaReference, sameFile, toolMedia } from './named'

const markdown = parser.configure(GFM)
type SyntaxNode = ReturnType<typeof markdown.parse>['topNode']

export type ViewerSource =
  | { kind: 'file'; path: string } // a file the thread names, shown through its grant
  // base64 the thread carries
  | { kind: 'bytes'; media: 'image' | 'video'; mimeType: string; data: string }
  | { kind: 'attachment'; attachment: Attachment } // the user's, from the thread store or a draft

export interface ViewerItem {
  /** The item's place in the thread carries the same key, as `data-viewer-key`. */
  key: string
  source: ViewerSource
  /** Null for a picture, or a clip, the thread carries without a name. */
  name: string | null
  alt: string
}

export const fileKey = (entryId: string, path: string) => `${entryId}:file:${sameFile(path)}`
/** A content ref's key, by its index among the refs its entry shows. */
export const refKey = (entryId: string, index: number) => `${entryId}:ref:${index}`
export const attachmentKey = (entryId: string, id: string) => `${entryId}:attachment:${id}`
export const draftKey = (draft: string, key: string) => `draft:${draft}:${key}`

export function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/** A file a message shows, with the alt text of its Markdown image. */
export interface ShownFile {
  path: string
  alt: string
}

// Blocks whose own inline content names no file for the block around them.
const NESTED = new Set([
  'BulletList',
  'OrderedList',
  'ListItem',
  'Blockquote',
  'FencedCode',
  'CodeBlock',
  'Table',
  'HTMLBlock',
])
const SKIPPED = new Set([
  'FencedCode',
  'CodeBlock',
  'HTMLBlock',
  'CommentBlock',
  'ProcessingInstructionBlock',
  'LinkReference',
])
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** A destination or label as CommonMark reads it: backslash escapes and entities resolved. */
function unescape(text: string): string {
  return text
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/&(#x[\da-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (entity, name: string) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? entity
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : +name.slice(1)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\uFFFD'
    })
}

/**
 * The files a message shows, in its order, each once: a local Markdown image where it is written,
 * and a media file that inline code or a link names under the paragraph, list item or table that
 * first names it, as the thread's renderer places them (`NamedMedia`).
 */
export function markdownFiles(text: string): ShownFile[] {
  const source = spacedImages(text)
  const slice = (node: SyntaxNode) => source.slice(node.from, node.to)
  const events: ({ image: ShownFile } | { under: string[] })[] = []

  const children = (node: SyntaxNode): SyntaxNode[] => {
    const list: SyntaxNode[] = []
    for (let child = node.firstChild; child; child = child.nextSibling) list.push(child)
    return list
  }
  const destination = (node: SyntaxNode): string | null => {
    const url = node.getChild('URL')
    if (!url) return null
    const raw = slice(url)
    return unescape(raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw)
  }
  const codeText = (node: SyntaxNode): string => {
    const marks = node.getChildren('CodeMark')
    const inner = source.slice(marks[0]?.to ?? node.from, marks.at(-1)?.from ?? node.to)
    const line = inner.replace(/\r\n?|\n/g, ' ')
    return /^ .*[^ ].* $/.test(line) ? line.slice(1, -1) : line
  }
  // A blank line between the items, or between the blocks of an item, makes a list loose.
  const loose = (list: SyntaxNode): boolean => {
    const blank = (a: SyntaxNode, b: SyntaxNode) => /\n[ \t]*\r?\n/.test(source.slice(a.to, b.from))
    const items = children(list).filter((child) => child.name === 'ListItem')
    return items.some((item, i) => {
      const next = items[i + 1]
      if (next && blank(item, next)) return true
      const blocks = children(item).filter((child) => child.name !== 'ListMark')
      return blocks.some((block, j) => j > 0 && blank(blocks[j - 1]!, block))
    })
  }
  // The files a block's inline code and links name, as `namedMedia` reads the rendered block. A
  // tight list item's paragraphs render as its own text.
  const named = (block: SyntaxNode, paragraphs: boolean): string[] => {
    const found: string[] = []
    const add = (path: string | null) => {
      if (path !== null && !found.includes(path)) found.push(path)
    }
    const visit = (node: SyntaxNode) => {
      if (NESTED.has(node.name)) return
      if (!paragraphs && (node.name === 'Paragraph' || node.name === 'Task')) return
      if (node.name === 'InlineCode') return add(mediaReference(codeText(node)))
      if (node.name === 'Link') {
        const url = destination(node)
        if (url !== null && isLocalLink(url)) add(mediaReference(url))
      }
      children(node).forEach(visit)
    }
    children(block).forEach(visit)
    return found
  }
  const walk = (node: SyntaxNode, tight: boolean): void => {
    if (SKIPPED.has(node.name)) return
    if (node.name === 'Image') {
      const url = destination(node)
      if (url === null || !isLocalImage(url)) return
      const marks = node.getChildren('LinkMark')
      const alt = source.slice(marks[0]?.to ?? node.from, marks[1]?.from ?? node.from)
      events.push({ image: { path: url, alt: unescape(alt) } })
      return
    }
    if (node.name === 'Paragraph' || node.name === 'Task') {
      children(node).forEach((child) => walk(child, false))
      if (!tight) events.push({ under: named(node, true) })
      return
    }
    if (node.name === 'ListItem') {
      const inTight = !!node.parent && !loose(node.parent)
      children(node).forEach((child) => walk(child, inTight))
      events.push({ under: named(node, inTight) })
      return
    }
    children(node).forEach((child) => walk(child, false))
    if (node.name === 'Table') events.push({ under: named(node, true) })
  }
  walk(markdown.parse(source).topNode, false)

  const images = new Set<string>()
  for (const event of events) if ('image' in event) images.add(sameFile(event.image.path))
  const shown = new Set<string>()
  const files: ShownFile[] = []
  const show = (file: ShownFile) => {
    const same = sameFile(file.path)
    if (shown.has(same)) return
    shown.add(same)
    files.push(file)
  }
  for (const event of events) {
    if ('image' in event) show(event.image)
    else for (const path of event.under) if (!images.has(sameFile(path))) show({ path, alt: '' })
  }
  return files
}

function fileItems(entryId: string, files: ShownFile[]): ViewerItem[] {
  return files
    .filter(({ path }) => mediaKindOfName(fileName(path)) !== 'audio')
    .map(({ path, alt }) => ({
      key: fileKey(entryId, path),
      source: { kind: 'file', path },
      name: fileName(path),
      alt,
    }))
}

function byteItem(entryId: string, index: number, ref: ContentRef): ViewerItem[] {
  if (ref.kind !== 'image' && ref.kind !== 'video') return []
  return [
    {
      key: refKey(entryId, index),
      source: { kind: 'bytes', media: ref.kind, mimeType: ref.mimeType, data: ref.data },
      name: ref.kind === 'video' ? ref.name : null,
      alt: '',
    },
  ]
}

const refItems = (entryId: string, refs: ContentRef[]) =>
  refs.flatMap((ref, i) => byteItem(entryId, i, ref))

const refsOf = (content: UserContent[]) => content.flatMap((c) => (c.type === 'ref' ? [c.ref] : []))

function entryItems(entry: ThreadEntry): ViewerItem[] {
  switch (entry.kind) {
    case 'user': {
      // The attachments show above the bubble, its pictures after its text.
      const refs = refsOf(entry.content)
      const attachments = refs.flatMap((ref) =>
        ref.kind === 'attachment' && ref.attachment.type === 'image'
          ? [
              {
                key: attachmentKey(entry.id, ref.attachment.id),
                source: { kind: 'attachment', attachment: ref.attachment },
                name: ref.attachment.name,
                alt: '',
              } satisfies ViewerItem,
            ]
          : [],
      )
      return [
        ...attachments,
        ...refItems(
          entry.id,
          refs.filter((ref) => ref.kind !== 'attachment'),
        ),
      ]
    }
    case 'session_message':
      return refItems(entry.id, refsOf(entry.content))
    case 'agent':
      return [
        ...fileItems(entry.id, markdownFiles(entry.markdown)),
        ...refItems(entry.id, entry.attachments),
      ]
    case 'thought':
      return fileItems(entry.id, markdownFiles(entry.markdown))
    case 'tool':
      // Its pictures by their index among the call's content, then the files it names.
      return [
        ...entry.content.flatMap((content, i) =>
          content.type === 'ref' ? byteItem(entry.id, i, content.ref) : [],
        ),
        ...fileItems(
          entry.id,
          toolMedia(entry).map((path) => ({ path, alt: '' })),
        ),
      ]
    default:
      return []
  }
}

// Entries are replaced when they change, so a streamed reply reads its text again and no other.
const byEntry = new WeakMap<ThreadEntry, ViewerItem[]>()

/** The thread's images and videos, in its order, folded runs and attachments included. */
export function threadItems(state: ThreadState): ViewerItem[] {
  const items: ViewerItem[] = []
  for (const id of state.order) {
    const entry = state.byId[id]
    if (!entry) continue
    let found = byEntry.get(entry)
    if (!found) {
      found = entryItems(entry)
      byEntry.set(entry, found)
    }
    items.push(...found)
  }
  return items
}

/** The images a composer's draft holds once added, in the order of its tiles. */
export function draftItems(draft: string, attachments: readonly DraftAttachment[]): ViewerItem[] {
  return attachments.flatMap((item) =>
    item.kind === 'image' && item.status === 'ready' && item.attachment
      ? [
          {
            key: draftKey(draft, item.key),
            source: { kind: 'attachment', attachment: item.attachment },
            name: item.name,
            alt: '',
          } satisfies ViewerItem,
        ]
      : [],
  )
}
