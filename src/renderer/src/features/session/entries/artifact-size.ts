// Which artifact cards a thread draws large: a turn's main output, and no other.

import type { ThreadEntry, ThreadState } from '@shared/thread'

export type ArtifactCardSize = 'large' | 'compact'

type Thread = Pick<ThreadState, 'order' | 'byId'>

interface Cards {
  size: Map<string, ArtifactCardSize>
  /** The id of each artifact's last entry in the thread. */
  last: Map<string, string>
}

// Read once per order: an entry's kind, action and artifact and a message's steering never change
// after it is added, so only a new entry, which makes a new order, changes the answer.
const read = new WeakMap<readonly string[], Cards>()

/** Whether an entry opens a turn: a prompt of its own, or whatever follows the end of one. */
function opensTurn(entry: ThreadEntry | undefined, previous: ThreadEntry | undefined): boolean {
  if (entry?.kind === 'user') return entry.steered !== true
  return previous?.kind === 'turn_end'
}

function cardsOf({ order, byId }: Thread): Cards {
  const cached = read.get(order)
  if (cached) return cached
  const size = new Map<string, ArtifactCardSize>()
  const last = new Map<string, string>()
  let turn: Extract<ThreadEntry, { kind: 'artifact' }>[] = []
  const close = () => {
    for (const entry of turn) {
      size.set(entry.id, turn.length === 1 && entry.action === 'create' ? 'large' : 'compact')
    }
    turn = []
  }
  for (let i = 0; i < order.length; i++) {
    const entry = byId[order[i]!]
    if (opensTurn(entry, byId[order[i - 1]!])) close()
    if (entry?.kind !== 'artifact') continue
    last.set(entry.artifactId, entry.id)
    if (entry.action !== 'delete') turn.push(entry)
  }
  close()
  const cards = { size, last }
  read.set(order, cards)
  return cards
}

/**
 * An artifact card's size. Large for a turn's main output: what the turn created when it is the
 * only artifact the turn wrote. Compact for a later update or a restore, and for every artifact of
 * a turn that wrote several; a deletion's line does not count.
 */
export function artifactCardSize(thread: Thread, entryId: string): ArtifactCardSize {
  return cardsOf(thread).size.get(entryId) ?? 'compact'
}

/** Whether the entry is its artifact's last in the thread, the one a running turn writes to. */
export function isLastArtifactEntry(thread: Thread, entryId: string): boolean {
  const entry = thread.byId[entryId]
  return entry?.kind === 'artifact' && cardsOf(thread).last.get(entry.artifactId) === entryId
}
