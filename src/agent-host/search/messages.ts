// What the search index keeps of a thread: the text of finished user messages and agent replies.

import type { ThreadEntry } from '@shared/thread'

export interface IndexedMessage {
  pos: number
  entryId: string
  role: 'user' | 'agent'
  text: string
}

/**
 * The text of a user message or an agent reply as Search reads it: the text parts of a message
 * joined by lines, the Markdown of a reply. Empty for every other entry, and for the answer Kettu
 * sends for a card or a message Kettu wrote itself, which are no messages of the user's own.
 */
export function messageText(entry: ThreadEntry): string {
  if (entry.kind === 'agent') return entry.markdown.trim()
  if (entry.kind !== 'user' || entry.approval || entry.kettu) return ''
  return entry.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
    .trim()
}

/**
 * What a write of entries changes in the index: the messages to put at their positions, and the
 * positions that no longer hold one. A reply still streaming is left alone until it is final.
 */
export function messageChanges(entries: readonly { pos: number; entry: ThreadEntry }[]): {
  upserts: IndexedMessage[]
  removed: number[]
} {
  const upserts: IndexedMessage[] = []
  const removed: number[] = []
  for (const { pos, entry } of entries) {
    if (entry.kind !== 'user' && entry.kind !== 'agent') continue
    if (entry.kind === 'agent' && entry.streaming) continue
    const text = messageText(entry)
    if (text) upserts.push({ pos, entryId: entry.id, role: entry.kind, text })
    else removed.push(pos)
  }
  return { upserts, removed }
}
