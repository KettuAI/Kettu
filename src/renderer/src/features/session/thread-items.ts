import type { ThreadEntry, ThreadState } from '@shared/thread'

// One character per entry, so the thread re-renders only when its shape changes, not on every
// streamed token: u user, h thought, g groupable lookup, t other tool, o anything else.
export function signatureOf(state: ThreadState | null | undefined): string {
  if (!state) return ''
  let signature = ''
  for (const id of state.order) signature += charOf(state.byId[id])
  return signature
}

function charOf(entry: ThreadEntry | undefined): string {
  if (!entry) return 'o'
  if (entry.kind === 'user') return 'u'
  if (entry.kind === 'thought') return 'h'
  if (entry.kind !== 'tool') return 'o'
  if (
    entry.status === 'completed' &&
    !entry.permission &&
    (entry.toolKind === 'read' || entry.toolKind === 'search' || entry.toolKind === 'fetch')
  ) {
    return 'g'
  }
  return 't'
}

/** Thoughts and tool calls: the steps a run of work is made of. */
const isStep = (char: string | undefined): boolean => char === 'h' || char === 'g' || char === 't'

/** A step on its own, or a run of completed lookups ("Explored 4 files"). */
export type Step =
  { key: string; type: 'entry'; id: string } | { key: string; type: 'group'; ids: string[] }

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
    }
  | { key: string; type: 'group'; ids: string[] }
  // Two or more steps between messages, folded into one summary line.
  | { key: string; type: 'run'; ids: string[]; signature: string }

/**
 * The thread's items. With `live`, a turn is running and the run at the thread's end is still
 * growing, so it shows step by step; it folds once a message or the turn's end follows it.
 */
export function buildItems(order: string[], signature: string, live = false): Item[] {
  const items: Item[] = []
  const latestTurn = signature.lastIndexOf('u')
  for (let i = 0; i < order.length; i++) {
    if (isStep(signature[i])) {
      let end = i
      while (isStep(signature[end + 1])) end++
      const ids = order.slice(i, end + 1)
      const growing = live && end === order.length - 1
      if (end > i && !growing) {
        items.push({
          key: `run:${ids[0]}`,
          type: 'run',
          ids,
          signature: signature.slice(i, end + 1),
        })
      } else {
        for (const step of stepItems(ids, signature.slice(i, end + 1))) {
          items.push(
            step.type === 'group' ? step : { ...step, turnStart: false, scrollAnchor: false },
          )
        }
      }
      i = end
      continue
    }
    const id = order[i]!
    items.push({
      key: id,
      type: 'entry',
      id,
      turnStart: signature[i] === 'u',
      scrollAnchor: i === latestTurn,
    })
  }
  return items
}

/** A run's steps, with consecutive completed lookups grouped. */
export function stepItems(ids: string[], signature: string): Step[] {
  const steps: Step[] = []
  for (let i = 0; i < ids.length; i++) {
    if (signature[i] === 'g') {
      let end = i
      while (signature[end + 1] === 'g') end++
      if (end > i) {
        const group = ids.slice(i, end + 1)
        steps.push({ key: `group:${group[0]}`, type: 'group', ids: group })
        i = end
        continue
      }
    }
    steps.push({ key: ids[i]!, type: 'entry', id: ids[i]! })
  }
  return steps
}
