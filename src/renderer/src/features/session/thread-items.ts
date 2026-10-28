import type { ThreadEntry, ThreadState } from '@shared/thread'

// One character per entry, so the thread re-renders only when its shape changes, not on every
// streamed token: u user, s user message steered into a running turn, a agent, h thought shown in
// place, r long thought, q short thought still streaming, g groupable lookup, t other tool, w tool
// waiting for permission, p plan or compaction, c progress note, e turn end, o anything else,
// which a new site's request is: a card of its own, never folded into a run.
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
  if (entry.kind === 'thought') return longThought(entry) ? 'r' : entry.streaming ? 'q' : 'h'
  if (entry.kind === 'plan' || entry.kind === 'compaction') return 'p'
  if (entry.kind !== 'tool') return 'o'
  if (entry.permission) return 'w'
  if (
    entry.status === 'completed' &&
    (entry.toolKind === 'read' || entry.toolKind === 'search' || entry.toolKind === 'fetch')
  ) {
    return 'g'
  }
  return 't'
}

/** A thought wider than this is raw reasoning, which folds into the run of work around it. */
const LONG_THOUGHT = 300

// Chinese, Japanese and Korean characters, which count two toward a thought's width.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

// The signature is read on every update, and a changed entry is a new object, so each version of
// a thought is measured once: scanning a long thread's Chinese thoughts each time took over 1 ms.
const measured = new WeakMap<object, boolean>()

/**
 * Whether a thought is wider than LONG_THOUGHT: the length of its trimmed Markdown, a Chinese,
 * Japanese or Korean character counting two. Only a length that could go either way is scanned
 * for those characters.
 */
function longThought(thought: { markdown: string }): boolean {
  if (thought.markdown.length <= LONG_THOUGHT / 2) return false
  let long = measured.get(thought)
  if (long === undefined) {
    const text = thought.markdown.trim()
    long =
      text.length > LONG_THOUGHT ||
      (text.length > LONG_THOUGHT / 2 &&
        text.length + (text.match(CJK)?.length ?? 0) > LONG_THOUGHT)
    measured.set(thought, long)
  }
  return long
}

/** Work after a message makes that message a progress note. Thoughts count as work here. */
const isWork = (char: string | undefined): boolean =>
  char === 'h' ||
  char === 'r' ||
  char === 'q' ||
  char === 'g' ||
  char === 't' ||
  char === 'w' ||
  char === 'p'

/** Tool calls, plans, compactions and long thoughts fold into a run; other thoughts end it. */
const foldsIntoRun = (char: string | undefined): boolean =>
  char === 'r' || char === 'g' || char === 't' || char === 'w' || char === 'p'

/**
 * Marks progress notes as c: an agent message that more work in its turn follows, as Codex's
 * commentary, which it writes before its tool calls and never after its final answer. In the turn
 * still running, the latest message may be the answer, so it stays one until work follows it.
 */
function markNotes(signature: string): string {
  const chars = [...signature]
  const starts = [0]
  for (let i = 1; i < chars.length; i++) if (chars[i] === 'u') starts.push(i)
  starts.forEach((start, n) => {
    const end = starts[n + 1] ?? chars.length
    let workEnd = end
    while (workEnd > start && !isWork(chars[workEnd - 1])) workEnd--
    for (let i = start; i < workEnd; i++) if (chars[i] === 'a') chars[i] = 'c'
  })
  return chars.join('')
}

/** A step on its own, or a run of completed lookups ("Read a.ts and 2 more"). */
export type Step =
  { key: string; type: 'entry'; id: string } | { key: string; type: 'group'; ids: string[] }

export type Item =
  | {
      key: string
      type: 'entry'
      id: string
      turnStart: boolean
      note: boolean
      /** Its character in the signature. */
      char: string
    }
  | { key: string; type: 'group'; ids: string[] }
  // The work between messages, two or more steps or a lone tool call, folded into one line.
  | { key: string; type: 'run'; ids: string[]; signature: string }
  // The actions under a turn's reply, with its turn-end marker when it has one.
  | { key: string; type: 'reply'; agentIds: string[]; endId: string | null; latest: boolean }
  // The running turn's status, where the reply will start: right after a message you sent.
  | { key: string; type: 'status'; afterSent: boolean }

/**
 * The thread's items. Work folds as it happens, so a running turn already reads as it will once it
 * ends. With `live`, a turn is running and gets its reply footer only when it ends. With `notes`,
 * the agent's messages that more work follows are progress notes and show between the runs.
 */
export function buildItems(order: string[], shape: string, live = false, notes = false): Item[] {
  const signature = notes ? markNotes(shape) : shape
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
      // A lone tool call or long thought folds too, so every piece of work reads as one quiet
      // line; a request for permission and a plan or compaction show as they are.
      const lone =
        end === i && (signature[i] === 'g' || signature[i] === 't' || signature[i] === 'r')
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
            step.type === 'group'
              ? step
              : { ...step, turnStart: false, note: false, char: signature[i]! },
          )
        }
      }
      i = end
      const closing = after.get(i)
      if (closing) items.push(closing)
      continue
    }
    // A short thought shows once it closes, so none shows in place and then moves into a run.
    if (signature[i] !== 'q') {
      const id = order[i]!
      items.push({
        key: id,
        type: 'entry',
        id,
        turnStart: signature[i] === 'u',
        note: signature[i] === 'c',
        char: signature[i] ?? 'o',
      })
    }
    const closing = after.get(i)
    if (closing) items.push(closing)
  }
  if (live) items.push({ key: 'status', type: 'status', afterSent: sentItem(items.at(-1)) })
  return items
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
    // One line of bubble and the row under it.
    case 'u':
    case 's':
      return 69
    case 'a':
      return 20
    // A progress note is muted like a thought, in the same smaller type.
    case 'c':
    case 'h':
    case 'r':
    case 'q':
      return 18
    case 'g':
    case 't':
    case 'w':
      return 24
    // A plan or a compaction on its own.
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
