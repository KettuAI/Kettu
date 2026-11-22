// Edit from here: which sent messages an edit can start from, and what an edit from one takes away.

import type { ThreadEntry, ThreadState, UserContent } from './thread'

type UserEntry = Extract<ThreadEntry, { kind: 'user' }>
type Thread = Pick<ThreadState, 'order' | 'byId'>

/**
 * A message the user sent as a turn of its own: not one steered into a running turn, nor one
 * another session's agent, Kettu or a card's answer wrote.
 */
export function isOwnPrompt(entry: ThreadEntry | undefined): entry is UserEntry {
  return (
    entry?.kind === 'user' &&
    !entry.steered &&
    entry.from === undefined &&
    entry.approval === undefined &&
    entry.kettu === undefined
  )
}

/** Where the latest agent switch is in the thread, -1 for none: an edit goes back no further. */
export function lastSwitchAt(thread: Thread): number {
  for (let i = thread.order.length - 1; i >= 0; i--) {
    if (thread.byId[thread.order[i]!]?.kind === 'takeover') return i
  }
  return -1
}

/** Whether an edit can start from the entry at `at`, with the latest agent switch at `switchAt`. */
export function canEditAt(thread: Thread, at: number, switchAt = lastSwitchAt(thread)): boolean {
  return at > switchAt && isOwnPrompt(thread.byId[thread.order[at]!])
}

/** The turns an edit from the entry at `at` takes away: every message from it on that opened one. */
export function turnsFrom(thread: Thread, at: number): number {
  let turns = 0
  for (let i = Math.max(0, at); i < thread.order.length; i++) {
    const entry = thread.byId[thread.order[i]!]
    if (entry?.kind === 'user' && !entry.steered) turns++
  }
  return turns
}

/** The first line of a message's text, which finds its prompt in an agent's history without an id. */
export function promptLine(content: readonly UserContent[]): string {
  for (const item of content) {
    if (item.type !== 'text') continue
    const line = item.text
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part !== '')
    if (line) return line.slice(0, 200)
  }
  return ''
}

/**
 * Which of the messages before it, and including it, with the same first line the entry at `at`
 * is, 1-based: every message the agent got since the latest switch counts, steered ones too.
 */
export function promptOccurrence(thread: Thread, at: number): number {
  const line = promptLine(userContent(thread.byId[thread.order[at]!]))
  let count = 0
  for (let i = lastSwitchAt(thread) + 1; i <= at && i < thread.order.length; i++) {
    const entry = thread.byId[thread.order[i]!]
    if (entry?.kind !== 'user') continue
    if (line === '' || userText(entry.content).includes(line)) count++
  }
  return Math.max(1, count)
}

/** The context in tokens as the last turn of the thread ended, when it said; null when unknown. */
export function usedAtEnd(thread: Thread): number | null {
  for (let i = thread.order.length - 1; i >= 0; i--) {
    const entry = thread.byId[thread.order[i]!]
    if (entry?.kind === 'turn_end') return entry.used ?? null
  }
  return 0
}

function userContent(entry: ThreadEntry | undefined): readonly UserContent[] {
  return entry?.kind === 'user' ? entry.content : []
}

function userText(content: readonly UserContent[]): string {
  return content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n')
}
