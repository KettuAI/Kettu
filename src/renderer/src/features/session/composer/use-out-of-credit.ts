import { outOfCreditTurn, type ConfigOption, type ThreadEntry } from '@shared/thread'
import { useThreadsStore } from '@renderer/stores/threads'

export type Notice = Extract<ThreadEntry, { kind: 'notice' }>

export const modelOption = (config: readonly ConfigOption[]) =>
  config.find((o) => o.category === 'model' && o.type === 'select')

/**
 * The notice that ended the latest turn out of credit, while the session is free and still on the
 * model that failed; null otherwise.
 */
export function useOutOfCredit(sessionId: string): Notice | null {
  return useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    const status = state?.session.status
    // Checked first, so a streaming turn never walks the thread here.
    if (!state || (status !== 'ready' && status !== 'closed')) return null
    const notice = outOfCreditTurn(state)?.notice
    if (!notice) return null
    const model = modelOption(state.session.config)?.value
    return notice.model === undefined || notice.model === model ? notice : null
  })
}
