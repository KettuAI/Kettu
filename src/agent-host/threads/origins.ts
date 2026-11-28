// Who sent a message other than the user at this computer, which the agent's own history never
// says: Kettu keeps it apart from the thread, so a thread rebuilt from that history gets it back.

import { parseFromSession, type ThreadEntry, type UserContent } from '@shared/thread'

type UserEntry = Extract<ThreadEntry, { kind: 'user' }>

/** Another session, a paired device, a card's answer or Kettu itself. */
export type MessageOrigin = Pick<UserEntry, 'from' | 'device' | 'approval' | 'kettu'>

/** A message Kettu marked, as its store keeps it: the text it was sent with and its origin. */
export interface StoredOrigin {
  text: string
  origin: MessageOrigin
}

/** The entry's origin; null for the user's own message from this computer, or another kind. */
export function originOf(entry: ThreadEntry | undefined): MessageOrigin | null {
  if (entry?.kind !== 'user') return null
  const from = entry.from ? parseFromSession(entry.from) : undefined
  const origin: MessageOrigin = {
    ...(from ? { from } : {}),
    ...(entry.device ? { device: entry.device } : {}),
    ...(entry.approval ? { approval: entry.approval } : {}),
    ...(entry.kettu ? { kettu: entry.kettu } : {}),
  }
  return Object.keys(origin).length > 0 ? origin : null
}

/** A message's text parts, the way a rebuilt message is matched to a kept origin. */
export function originText(content: readonly UserContent[]): string {
  return cleaned(content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'))
}

const cleaned = (text: string): string => text.replace(/\r\n/g, '\n').trim()

/**
 * The origins to put back on a rebuilt thread's messages, by entry id. Each message takes the next
 * kept origin, in order, whose text it is, or ends with after a blank line, since Kettu's guide or
 * carried context may have gone to the agent ahead of it. A message that matches none, such as one
 * written outside Kettu, stays the user's.
 */
export function restoredOrigins(
  entries: readonly ThreadEntry[],
  kept: readonly StoredOrigin[],
): Map<string, MessageOrigin> {
  const wanted = kept.map((item) => cleaned(item.text))
  const out = new Map<string, MessageOrigin>()
  let next = 0
  for (const entry of entries) {
    if (entry.kind !== 'user' || originOf(entry)) continue
    const text = originText(entry.content)
    if (!text) continue
    for (let i = next; i < kept.length; i++) {
      const want = wanted[i]!
      if (want && (text === want || text.endsWith(`\n\n${want}`))) {
        out.set(entry.id, kept[i]!.origin)
        next = i + 1
        break
      }
    }
  }
  return out
}
