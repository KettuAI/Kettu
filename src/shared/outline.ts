// The text the message outline shows for a user message, the same in the host and the renderer.

import type { UserContent } from './thread'

/** How much of a message's text the outline reads: enough for its summary. */
export const OUTLINE_TEXT = 500
const LINE_CHARS = 120

/** A message's text parts, or the names of what it attached when it has none; cut short. */
export function outlineText(content: readonly UserContent[]): string {
  const text = content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
  if (text) return text.slice(0, OUTLINE_TEXT)
  return content
    .flatMap((part) => {
      if (part.type !== 'ref') return []
      const { ref } = part
      if (ref.kind === 'attachment') return [ref.attachment.name]
      return ref.kind === 'link' ? [ref.name] : []
    })
    .join(', ')
}

/** The first line with text, as a row shows it before the message has a title. */
export function firstLine(text: string): string {
  const line = text.split('\n').find((part) => part.trim() !== '') ?? ''
  return Array.from(line.trim()).slice(0, LINE_CHARS).join('')
}
