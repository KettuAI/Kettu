import { create } from 'zustand'
import { workAtStake, type WorkItem } from './running-work'

export interface ArchiveQuestion {
  items: WorkItem[]
  answer: (archive: boolean) => void
}

export const useArchiveQuestion = create<{ question: ArchiveQuestion | null }>(() => ({
  question: null,
}))

/**
 * Whether to archive these sessions: at once when nothing of theirs runs, since archiving stops
 * their agents' work and ends their terminals; otherwise as the user answers the dialog that
 * lists what stops.
 */
export async function confirmArchive(sessionIds: readonly string[]): Promise<boolean> {
  const items = await workAtStake(sessionIds)
  if (items.length === 0) return true
  return new Promise((resolve) => {
    useArchiveQuestion.getState().question?.answer(false)
    useArchiveQuestion.setState({ question: { items, answer: resolve } })
  })
}
