import { create } from 'zustand'
import { terminalsAtStake } from '@renderer/app/actions'

export interface ArchiveQuestion {
  sessions: number
  commands: string[]
  answer: (archive: boolean) => void
}

export const useArchiveQuestion = create<{ question: ArchiveQuestion | null }>(() => ({
  question: null,
}))

/**
 * Whether to archive these sessions: at once when none of their terminals runs a command, since
 * archiving ends them; otherwise as the user answers the dialog that names the commands.
 */
export async function confirmArchive(sessionIds: readonly string[]): Promise<boolean> {
  const running = await terminalsAtStake(sessionIds)
  if (running.length === 0) return true
  return new Promise((resolve) => {
    useArchiveQuestion.getState().question?.answer(false)
    useArchiveQuestion.setState({
      question: {
        sessions: sessionIds.length,
        commands: [...new Set(running.map((t) => t.name ?? t.title))],
        answer: resolve,
      },
    })
  })
}
