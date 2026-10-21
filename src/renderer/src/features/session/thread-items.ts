import type { ThreadEntry, ThreadState } from '@shared/thread'

// One character per entry, so the thread re-renders only when its shape changes, not on every
// streamed token: u user, g groupable lookup, e edit, t other tool, o anything else.
export function signatureOf(state: ThreadState | null | undefined): string {
  if (!state) return ''
  let signature = ''
  for (const id of state.order) signature += charOf(state.byId[id])
  return signature
}

function charOf(entry: ThreadEntry | undefined): string {
  if (!entry) return 'o'
  if (entry.kind === 'user') return 'u'
  if (entry.kind !== 'tool') return 'o'
  if (
    entry.status === 'completed' &&
    !entry.permission &&
    (entry.toolKind === 'read' || entry.toolKind === 'search' || entry.toolKind === 'fetch')
  ) {
    return 'g'
  }
  if (entry.toolKind === 'edit' || entry.toolKind === 'delete' || entry.toolKind === 'move') {
    return 'e'
  }
  return 't'
}

export type Item =
  | {
      key: string
      type: 'entry'
      id: string
      turnStart: boolean
      // Only the latest turn's start: when an update keeps the item count, MessageScroller
      // scrolls to the first anchor it has not handled, which any anchor from history or a
      // remounted item is, so an older one would throw the view back to it.
      scrollAnchor: boolean
      keepOpen: boolean
    }
  | { key: string; type: 'group'; ids: string[] }

export function buildItems(order: string[], signature: string): Item[] {
  const items: Item[] = []
  const latestTurn = signature.lastIndexOf('u')
  const lastEdit = signature.lastIndexOf('e')
  const keepOpenAt = lastEdit > latestTurn ? lastEdit : -1
  for (let i = 0; i < order.length; i++) {
    if (signature[i] === 'g') {
      let end = i
      while (signature[end + 1] === 'g') end++
      if (end > i) {
        const ids = order.slice(i, end + 1)
        items.push({ key: `group:${ids[0]}`, type: 'group', ids })
        i = end
        continue
      }
    }
    const id = order[i]!
    items.push({
      key: id,
      type: 'entry',
      id,
      turnStart: signature[i] === 'u',
      scrollAnchor: i === latestTurn,
      keepOpen: i === keepOpenAt,
    })
  }
  return items
}
