import type { ThreadEntry, ThreadState } from '@shared/thread'
import { FOLDED_LINES, FOLD_OVER } from './markdown/code-meta'

// One character per entry, so the thread re-renders only when its shape changes, not on every
// streamed token: u user, s user message steered into a running turn, a agent, h thought, g
// groupable lookup, t other tool, w tool waiting for permission, r tool whose request was answered,
// p compaction, n plan, which the thread leaves out for the top bar, e turn end, o anything else,
// which a new site's request and an agent's question are: of their own, never folded into a run.
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
  // A question, a plan and an MCP server's request are the user's to answer, never folded work.
  if (
    entry.kind !== 'tool' ||
    entry.question !== undefined ||
    entry.planVersion !== undefined ||
    entry.elicitation !== undefined
  ) {
    return 'o'
  }
  if (entry.permission) return 'w'
  // An answered request keeps its folded card, so it stands on its own as the request did; a
  // routine's own answer is the routine's, and folds as work.
  const result = entry.permissionResult
  if (result && (typeof result !== 'object' || result.by !== 'routine')) return 'r'
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
  char === 'h' || char === 'g' || char === 't' || char === 'w' || char === 'r' || char === 'p'

/**
 * Tool calls and thoughts fold into a run. A request for permission ends it, since it waits for
 * the user below the work before it, and keeps standing apart once answered; so does a
 * compaction, which divides the thread.
 */
const foldsIntoRun = (char: string | undefined): boolean =>
  char === 'h' || char === 'g' || char === 't'

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
      // A lone tool call or thought folds too, so every piece of work reads as one quiet line.
      items.push({
        key: `run:${ids[0]}`,
        type: 'run',
        ids,
        signature: signature.slice(i, end + 1),
      })
      i = end
      const closing = after.get(i)
      if (closing) items.push(closing)
      continue
    }
    // Compactions in a row read as one divider: the latest stands for them all.
    if (signature[i] === 'p' && signature[i + 1] === 'p') continue
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
const isTool = (char: string | undefined): boolean =>
  char === 'g' || char === 't' || char === 'w' || char === 'r'

/**
 * The turns: [start, end) indexes into the signature. Each starts at a user message, or after a
 * turn's end where the agent goes on with no message, as when its background command ended.
 */
function turnsOf(signature: string): [number, number][] {
  const starts = [0]
  let ended = -1
  for (let i = 1; i < signature.length; i++) {
    const char = signature[i]
    if (char === 'u') {
      starts.push(i)
      ended = -1
    } else if (char === 'e') {
      ended = i
    } else if (ended !== -1 && (char === 'a' || isWork(char))) {
      starts.push(ended + 1)
      ended = -1
    }
  }
  return starts.map((start, n) => [start, starts[n + 1] ?? signature.length])
}

/** The item before the status: a message you sent, steered or not, sets its gap. */
function sentItem(item: Item | undefined): boolean {
  return item?.type === 'entry' && (item.char === 'u' || item.char === 's')
}

// An item's height before it renders, laid out at the default text size in a full column: a line
// of prose is 23 px and holds about 100 Latin characters or 55 Chinese ones, a line of code 20 px.
const LINE_PX = 23
const LINE_UNITS = 100
const BLOCK_GAP_PX = 14
const HEADING_PX = 40
const CODE_LINE_PX = 20
// A code block's header and padding, and the row that shows a folded block's other lines.
const CODE_FRAME_PX = 60
const CODE_MORE_PX = 36
const TABLE_ROW_PX = 37
const TABLE_FOOT_PX = 36
const DIAGRAM_PX = 220
// A reply's actions, and its changes card: the head, a row per file up to three, then one more.
const FOOTER_PX = 24
const CHANGES_HEAD_PX = 62
const CHANGE_ROW_PX = 36
const SHOWN_CHANGES = 3

/** A line's width in Latin characters, where a character of a wide script takes about two. */
function lineUnits(line: string): number {
  let units = 0
  for (const char of line) {
    const code = char.codePointAt(0)!
    units += (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xff00 && code <= 0xffef) ? 1.8 : 1
  }
  return units
}

/**
 * About the height an agent's Markdown renders at, from its blocks: wrapped lines of prose,
 * headings, code blocks folded past FOLD_OVER lines, tables and diagrams.
 */
export function markdownHeight(markdown: string): number {
  const lines = markdown.split('\n')
  let height = 0
  let blocks = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line.startsWith('```')) {
      const lang = line.slice(3).split(' ')[0]
      let end = i + 1
      while (end < lines.length && !lines[end]!.trim().startsWith('```')) end++
      const count = end - i - 1
      if (lang === 'mermaid' || lang === 'svg') height += DIAGRAM_PX
      else {
        const folded = count > FOLD_OVER
        height += CODE_FRAME_PX + (folded ? FOLDED_LINES : count) * CODE_LINE_PX
        if (folded) height += CODE_MORE_PX
      }
      blocks++
      i = end
    } else if (line.startsWith('|')) {
      let end = i
      while (end + 1 < lines.length && lines[end + 1]!.trim().startsWith('|')) end++
      // Less the line under the header.
      height += (end - i) * TABLE_ROW_PX + TABLE_FOOT_PX
      blocks++
      i = end
    } else if (line.startsWith('#')) {
      height += HEADING_PX
      blocks++
    } else if (line) {
      height += LINE_PX * Math.max(1, Math.ceil(lineUnits(line) / LINE_UNITS))
      if (i === 0 || !lines[i - 1]!.trim()) blocks++
    }
  }
  return Math.max(LINE_PX, height + BLOCK_GAP_PX * Math.max(0, blocks - 1))
}

/** The changed files a reply's changes card lists. */
function changedFiles(toolIds: string[], byId: Record<string, ThreadEntry>): number {
  const paths = new Set<string>()
  for (const id of toolIds) {
    const entry = byId[id]
    if (entry?.kind !== 'tool') continue
    for (const content of entry.content) if (content.type === 'diff') paths.add(content.path)
  }
  return paths.size
}

// By entry, which a change replaces, so the thread's renders scan each message once.
const agentHeights = new WeakMap<ThreadEntry, number>()

/**
 * The height an item is laid out at until it renders: from its content where that varies, an
 * agent's message and a reply with its changes card, else the shortest its kind renders at,
 * measured on macOS and rounded down. A close estimate keeps the scrollbar steady as the thread
 * scrolls back through items not rendered yet.
 */
export function estimateOf(item: Item, byId: Record<string, ThreadEntry> | undefined): number {
  if (item.type === 'run') return 28
  if (item.type === 'group' || item.type === 'status') return 24
  if (item.type === 'reply') {
    const files = byId ? changedFiles(item.toolIds, byId) : 0
    if (files === 0) return FOOTER_PX
    const rows = Math.min(files, SHOWN_CHANGES) + (files > SHOWN_CHANGES ? 1 : 0)
    return FOOTER_PX + CHANGES_HEAD_PX + rows * CHANGE_ROW_PX
  }
  switch (item.char) {
    // One line of bubble and the row under it: the time, Copy and the steered label.
    case 'u':
    case 's':
      return 69
    case 'a': {
      const entry = byId?.[item.id]
      if (entry?.kind !== 'agent') return 20
      let height = agentHeights.get(entry)
      if (height === undefined) agentHeights.set(entry, (height = markdownHeight(entry.markdown)))
      return height
    }
    case 'g':
    case 't':
    case 'w':
    case 'r':
      return 24
    // A compaction's divider.
    case 'p':
      return 28
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
