import type { ThreadEntry, ThreadState } from '@shared/thread'

// One character per entry, so the thread re-renders only when its shape changes, not on every
// streamed token: u user, s user message steered into a running turn, a agent, h thought, g
// groupable lookup, t other tool, w tool waiting for permission, p compaction, n plan, which the
// thread leaves out for the top bar, e turn end, o anything else, which a new
// site's request and an agent's question are: of their own, never folded into a run.
export function signatureOf(state: ThreadState | null | undefined): string {
  if (!state) return ''
  let signature = ''
  for (const id of state.order) signature += charOf(state.byId[id])
  return signature
}

/** The entries and their signature without the plans, which only the top bar shows. */
export function withoutPlans(
  order: string[],
  signature: string,
): { order: string[]; signature: string } {
  if (!signature.includes('n')) return { order, signature }
  const shown = order.filter((_, i) => signature[i] !== 'n')
  return { order: shown, signature: signature.replaceAll('n', '') }
}

function charOf(entry: ThreadEntry | undefined): string {
  if (!entry) return 'o'
  if (entry.kind === 'user') return entry.steered ? 's' : 'u'
  if (entry.kind === 'agent') return 'a'
  if (entry.kind === 'turn_end') return 'e'
  if (entry.kind === 'thought') return 'h'
  if (entry.kind === 'plan') return 'n'
  if (entry.kind === 'compaction') return 'p'
  if (entry.kind !== 'tool' || entry.question !== undefined) return 'o'
  if (entry.permission) return 'w'
  if (
    entry.status === 'completed' &&
    (entry.toolKind === 'read' || entry.toolKind === 'search' || entry.toolKind === 'fetch')
  ) {
    return 'g'
  }
  return 't'
}

/** Work, as opposed to what an agent says: what a reply's answer comes after. */
const isWork = (char: string | undefined): boolean =>
  char === 'h' || char === 'g' || char === 't' || char === 'w' || char === 'p'

/**
 * Tool calls, compactions and thoughts fold into a run; a request for permission ends it, since
 * it waits for the user below the work before it.
 */
const foldsIntoRun = (char: string | undefined): boolean =>
  char === 'h' || char === 'g' || char === 't' || char === 'p'

/** A step on its own, or a run of completed lookups ("Read a.ts and 2 more"). */
export type Step =
  { key: string; type: 'entry'; id: string } | { key: string; type: 'group'; ids: string[] }

export type Item =
  | {
      key: string
      type: 'entry'
      id: string
      turnStart: boolean
      /** Its character in the signature. */
      char: string
    }
  | { key: string; type: 'group'; ids: string[] }
  // The work between messages, two or more steps or a lone tool call or thought, folded into one
  // line.
  | { key: string; type: 'run'; ids: string[]; signature: string }
  // The actions under a turn's reply, with its turn-end marker when it has one, and the turn's
  // tool calls, whose edits it lists.
  | {
      key: string
      type: 'reply'
      agentIds: string[]
      endId: string | null
      latest: boolean
      toolIds: string[]
    }
  // The running turn's status, where the reply will start: right after a message you sent.
  | { key: string; type: 'status'; afterSent: boolean }

/**
 * The thread's items. Work folds as it happens, so a running turn already reads as it will once it
 * ends: the same rows with the same keys, and a turn ending only adds its reply footer. With
 * `live`, a turn is running and gets its reply footer only when it ends.
 */
export function buildItems(order: string[], signature: string, live = false): Item[] {
  const items: Item[] = []
  const { replacing, after } = replyFooters(order, signature, live)
  for (let i = 0; i < order.length; i++) {
    const footer = replacing.get(i)
    if (footer) {
      items.push(footer)
      continue
    }
    if (foldsIntoRun(signature[i])) {
      let end = i
      while (foldsIntoRun(signature[end + 1])) end++
      const ids = order.slice(i, end + 1)
      // A lone tool call or thought folds too, so every piece of work reads as one quiet line; a
      // compaction shows as it is.
      const lone =
        end === i && (signature[i] === 'g' || signature[i] === 't' || signature[i] === 'h')
      if (end > i || lone) {
        items.push({
          key: `run:${ids[0]}`,
          type: 'run',
          ids,
          signature: signature.slice(i, end + 1),
        })
      } else {
        for (const step of stepItems(ids, signature.slice(i, end + 1))) {
          items.push(
            step.type === 'group' ? step : { ...step, turnStart: false, char: signature[i]! },
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
      char: signature[i] ?? 'o',
    })
    const closing = after.get(i)
    if (closing) items.push(closing)
  }
  if (live) items.push({ key: 'status', type: 'status', afterSent: sentItem(items.at(-1)) })
  return items
}

/** A tool call's character in the signature. */
const isTool = (char: string | undefined): boolean => char === 'g' || char === 't' || char === 'w'

/** The turns starting at each user message: [start, end) indexes into the signature. */
function turnsOf(signature: string): [number, number][] {
  const starts = [0]
  for (let i = 1; i < signature.length; i++) if (signature[i] === 'u') starts.push(i)
  return starts.map((start, n) => [start, starts[n + 1] ?? signature.length])
}

/** The item before the status: a message you sent, steered or not, sets its gap. */
function sentItem(item: Item | undefined): boolean {
  return item?.type === 'entry' && (item.char === 'u' || item.char === 's')
}

/** An item's height in px before it renders: its kind's shortest rendered height. */
export type Estimate = 16 | 18 | 20 | 24 | 28 | 69

/**
 * The height an item is laid out at until it renders: the shortest its kind renders at, at any
 * text size, measured on macOS and rounded down. It is a lower bound, so an item not rendered yet
 * never takes more room than it will.
 */
export function estimateOf(item: Item): Estimate {
  if (item.type === 'run') return 28
  if (item.type === 'group' || item.type === 'reply' || item.type === 'status') return 24
  switch (item.char) {
    // One line of bubble and the row under it: the time, Copy and the steered label.
    case 'u':
    case 's':
      return 69
    case 'a':
      return 20
    case 'g':
    case 't':
    case 'w':
      return 24
    // A compaction on its own.
    case 'p':
      return 16
    // A notice, a marker, a git event or a card.
    default:
      return 20
  }
}

/** The latest message you sent, steered into a running turn or not; null before the first. */
export function lastSent(order: string[], signature: string): string | null {
  const at = Math.max(signature.lastIndexOf('u'), signature.lastIndexOf('s'))
  return at < 0 ? null : (order[at] ?? null)
}

/**
 * Each item's reply, by its footer's key: everything a turn shows after its user message. A user
 * message has none.
 */
export function replyKeys(items: Item[]): (string | null)[] {
  const keys: (string | null)[] = new Array(items.length).fill(null)
  let reply: string | null = null
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.type === 'reply') reply = item.key
    else if (item.type === 'entry' && item.turnStart) {
      reply = null
      continue
    }
    keys[i] = reply
  }
  return keys
}

/**
 * One footer per turn with a message, a turn running from a user message to the next. It takes
 * the place of the turn's end marker, or closes a turn from history that has none; the turn still
 * running gets its footer when it ends. Its messages are the answer, those after the turn's last
 * work, or all of them when the turn ended on work.
 */
function replyFooters(
  order: string[],
  signature: string,
  live: boolean,
): { replacing: Map<number, Item>; after: Map<number, Item> } {
  const replacing = new Map<number, Item>()
  const after = new Map<number, Item>()
  for (const [start, end] of turnsOf(signature)) {
    const latest = end === signature.length
    const messageIds: string[] = []
    const answerIds: string[] = []
    const toolIds: string[] = []
    let endAt = -1
    let lastWork = -1
    for (let i = start; i < end; i++) if (isWork(signature[i])) lastWork = i
    for (let i = start; i < end; i++) {
      if (signature[i] === 'a') {
        messageIds.push(order[i]!)
        if (i > lastWork) answerIds.push(order[i]!)
      } else if (signature[i] === 'e') endAt = i
      else if (isTool(signature[i])) toolIds.push(order[i]!)
    }
    if (messageIds.length === 0 || (latest && live && endAt === -1)) continue
    const footer: Item = {
      key: `reply:${order[start]}`,
      type: 'reply',
      agentIds: answerIds.length > 0 ? answerIds : messageIds,
      endId: endAt === -1 ? null : order[endAt]!,
      latest,
      toolIds,
    }
    if (endAt === -1) after.set(end - 1, footer)
    else replacing.set(endAt, footer)
  }
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
