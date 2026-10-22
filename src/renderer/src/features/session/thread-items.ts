import type { ThreadEntry, ThreadState } from '@shared/thread'

// One character per entry, so the thread re-renders only when its shape changes, not on every
// streamed token: u user, s user message steered into a running turn, a agent, h thought, g
// groupable lookup, t other tool, e turn end, o anything else.
export function signatureOf(state: ThreadState | null | undefined): string {
  if (!state) return ''
  let signature = ''
  for (const id of state.order) signature += charOf(state.byId[id])
  return signature
}

function charOf(entry: ThreadEntry | undefined): string {
  if (!entry) return 'o'
  if (entry.kind === 'user') return entry.steered ? 's' : 'u'
  if (entry.kind === 'agent') return 'a'
  if (entry.kind === 'turn_end') return 'e'
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

/**
 * The work of each finished turn: what comes before its answer, the trailing agent messages,
 * from its start or a message steered into it. It folds as one run when it holds a step and
 * more than one entry. The running turn is left out, so it shows as it goes. Start to end index.
 */
function turnWork(signature: string, live: boolean): Map<number, number> {
  const ranges = new Map<number, number>()
  const starts = [0]
  for (let i = 1; i < signature.length; i++) if (signature[i] === 'u') starts.push(i)
  starts.forEach((start, n) => {
    const end = starts[n + 1] ?? signature.length
    if (live && end === signature.length) return
    let answer = signature.lastIndexOf('a', end - 1)
    if (answer < start) return
    while (answer - 1 >= start && signature[answer - 1] === 'a') answer--
    let from = start
    for (let i = start; i <= answer; i++) {
      if (i < answer && signature[i] !== 'u' && signature[i] !== 's') continue
      const work = signature.slice(from, i)
      if (work.length > 1 && [...work].some(isStep)) ranges.set(from, i - 1)
      from = i + 1
    }
  })
  return ranges
}

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
  // Two or more steps between messages, or a finished turn's work before its answer, folded
  // into one summary line.
  | { key: string; type: 'run'; ids: string[]; signature: string }
  // The actions under a turn's reply, with its turn-end marker when it has one.
  | { key: string; type: 'reply'; agentIds: string[]; endId: string | null; latest: boolean }

/**
 * The thread's items. With `live`, a turn is running and the run at the thread's end is still
 * growing, so it shows step by step; it folds once a message or the turn's end follows it, and
 * once the turn ends, all its work before the answer folds into one run.
 */
export function buildItems(order: string[], signature: string, live = false): Item[] {
  const items: Item[] = []
  const latestTurn = signature.lastIndexOf('u')
  const { replacing, after } = replyFooters(order, signature, live)
  const work = turnWork(signature, live)
  for (let i = 0; i < order.length; i++) {
    const footer = replacing.get(i)
    if (footer) {
      items.push(footer)
      continue
    }
    const workEnd = work.get(i)
    if (workEnd !== undefined) {
      const ids = order.slice(i, workEnd + 1)
      items.push({
        key: `run:${ids[0]}`,
        type: 'run',
        ids,
        signature: signature.slice(i, workEnd + 1),
      })
      i = workEnd
      const closing = after.get(i)
      if (closing) items.push(closing)
      continue
    }
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
      const closing = after.get(i)
      if (closing) items.push(closing)
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
    const closing = after.get(i)
    if (closing) items.push(closing)
  }
  return items
}

/**
 * One footer per turn with a message, a turn running from a user message to the next. It takes
 * the place of the turn's end marker, or closes a turn from history that has none; the turn still
 * running gets its footer when it ends.
 */
function replyFooters(
  order: string[],
  signature: string,
  live: boolean,
): { replacing: Map<number, Item>; after: Map<number, Item> } {
  const replacing = new Map<number, Item>()
  const after = new Map<number, Item>()
  const starts = [0]
  for (let i = 1; i < signature.length; i++) if (signature[i] === 'u') starts.push(i)
  starts.forEach((start, n) => {
    const end = starts[n + 1] ?? signature.length
    const latest = end === signature.length
    const agentIds: string[] = []
    let endAt = -1
    for (let i = start; i < end; i++) {
      if (signature[i] === 'a') agentIds.push(order[i]!)
      else if (signature[i] === 'e') endAt = i
    }
    if (agentIds.length === 0 || (latest && live && endAt === -1)) return
    const footer: Item = {
      key: `reply:${order[start]}`,
      type: 'reply',
      agentIds,
      endId: endAt === -1 ? null : order[endAt]!,
      latest,
    }
    if (endAt === -1) after.set(end - 1, footer)
    else replacing.set(endAt, footer)
  })
  return { replacing, after }
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

/** What an opened run lists. A step's part is a step; an earlier message of the turn is not. */
export type RunPart =
  | { key: string; type: 'entry'; id: string; step: boolean }
  | { key: string; type: 'group'; ids: string[] }
  | { key: string; type: 'run'; ids: string[]; signature: string }

/**
 * An opened run's parts: its steps, with lookups grouped; in a turn's work, its earlier messages
 * too, with two or more steps between them folded again.
 */
export function runParts(ids: string[], signature: string): RunPart[] {
  if ([...signature].every(isStep)) {
    return stepItems(ids, signature).map((step) =>
      step.type === 'entry' ? { ...step, step: true } : step,
    )
  }
  const parts: RunPart[] = []
  for (let i = 0; i < ids.length; i++) {
    if (!isStep(signature[i])) {
      parts.push({ key: ids[i]!, type: 'entry', id: ids[i]!, step: false })
      continue
    }
    let end = i
    while (isStep(signature[end + 1])) end++
    if (end > i) {
      parts.push({
        key: `run:${ids[i]}`,
        type: 'run',
        ids: ids.slice(i, end + 1),
        signature: signature.slice(i, end + 1),
      })
    } else {
      parts.push({ key: ids[i]!, type: 'entry', id: ids[i]!, step: true })
    }
    i = end
  }
  return parts
}
