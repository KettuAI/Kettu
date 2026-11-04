// What a comment or a selection points at, as the interface names it and as a session is told it:
// the user's words as they are, and what the page reported inside a block whose random boundary
// says it is data, so a page's text cannot pass for the user's.

import { isAnswered, type CommentAnchor, type CommentThread } from '@shared/artifact-comments'
import { ARTIFACT_ENTRY } from '@shared/artifact-files'
import { snippet } from '@shared/artifact-runtime/page-messages'
import { i18n } from '@renderer/lib/i18n'
import type { Picked } from './editor'
import type { ShownVersion } from './use-artifact'

/** The anchor of a pick in the version shown: its page by number and name, and its element. */
export function anchorOf(picked: Picked, shown: ShownVersion): CommentAnchor {
  const page = picked.page === null ? null : (shown.canvas?.pages[picked.page] ?? null)
  const { selection } = picked
  return {
    version: shown.version,
    path: selection.path,
    page: page ? { number: page.number, name: page.name } : null,
    offset: selection.src,
    tag: selection.tag,
    text: selection.text,
    missing: false,
  }
}

/** "General › button “Save changes”", or the page alone, or the element alone. */
export function anchorLabel(anchor: CommentAnchor): string {
  const page = anchor.page
    ? (anchor.page.name ?? i18n.t('artifacts:canvas.page', { number: anchor.page.number }))
    : null
  const element =
    anchor.tag === null
      ? null
      : anchor.text
        ? i18n.t('artifacts:anchor.element', { tag: anchor.tag, text: snippet(anchor.text) })
        : anchor.tag
  if (page && element) return i18n.t('artifacts:anchor.inPage', { page, element })
  return element ?? page ?? i18n.t('artifacts:anchor.page')
}

/** The pins each page of the version shows: its open threads, numbered as their cards. */
export function pinsOf(
  threads: readonly CommentThread[] | null,
  shown: ShownVersion,
): (page: number | null) => { n: number; src: number | null; answered: boolean }[] {
  const open = threads?.filter((thread) => thread.resolvedAt === null) ?? []
  return (page) =>
    open.flatMap((thread, i) => {
      const { anchor } = thread
      const number = page === null ? null : (shown.canvas?.pages[page]?.number ?? null)
      if (page !== null && anchor.page?.number !== number) return []
      // Frames show the entry page, so an element of another file pins its page.
      const src = anchor.missing || anchor.path !== ARTIFACT_ENTRY ? null : anchor.offset
      return [{ n: i + 1, src, answered: isAnswered(thread) }]
    })
}

function boundary(texts: readonly string[]): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(8))
    const mark = `kettu-data-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
    if (!texts.some((text) => text.includes(mark))) return mark
  }
}

/** One line of what the page reported about an anchor, for inside the data block. */
function dataLine(anchor: CommentAnchor): string {
  const parts = [anchor.path]
  if (anchor.page) {
    const name = anchor.page.name === null ? '' : ` "${snippet(anchor.page.name)}"`
    parts.push(`page ${anchor.page.number}${name}`)
  }
  if (anchor.tag !== null) {
    const at =
      anchor.offset === null || anchor.missing
        ? ', made by a script'
        : ` at offset ${anchor.offset}`
    parts.push(`<${anchor.tag}>${at}`)
  }
  const text = snippet(anchor.text)
  return `${parts.join(', ')}${text ? `: "${text}"` : ''}`
}

function block(mark: string, lines: string[]): string {
  return [mark, ...lines, mark].join('\n')
}

/** The message that sends comment threads to a session. */
export function commentsPrompt(
  artifact: { id: string; title: string; version: number },
  threads: readonly CommentThread[],
): string {
  const bodies = threads.map((thread) => thread.comments.map((c) => c.body).join('\n'))
  const data = [
    `artifact: "${snippet(artifact.title)}"`,
    ...threads.map((thread, i) => `${i + 1}. ${dataLine(thread.anchor)}`),
  ]
  const mark = boundary([...bodies, ...data])
  const comments = threads.map((thread, i) => `${i + 1}. (${thread.id}) ${bodies[i]}`)
  return [
    i18n.t('artifacts:prompt.comments', { id: artifact.id, version: artifact.version }),
    comments.join('\n'),
    i18n.t('artifacts:prompt.data', { mark }),
    block(mark, data),
  ].join('\n\n')
}

/** The user's message with the element they selected beside the session. */
export function selectionPrompt(
  text: string,
  selected: { artifactId: string; title: string; anchor: CommentAnchor },
): string {
  const data = [`artifact: "${snippet(selected.title)}"`, dataLine(selected.anchor)]
  const mark = boundary([text, ...data])
  return [
    text,
    i18n.t('artifacts:prompt.selection', {
      id: selected.artifactId,
      version: selected.anchor.version,
    }),
    i18n.t('artifacts:prompt.data', { mark }),
    block(mark, data),
  ].join('\n\n')
}
