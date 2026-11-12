import { useState } from 'react'
import { retryableTurn } from '@shared/thread'
import { retryTurn } from '@renderer/app/actions'
import { errorMessage } from '@renderer/lib/host'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { FailedActions } from '../session-states'

/**
 * Retry and Report a problem under the notice of a failed turn, while it ends the latest turn and
 * the session is free. Retry sends the turn's message again under its own entry.
 */
export function FailedTurnActions({
  sessionId,
  entryId,
  error,
}: {
  sessionId: string
  entryId: string
  /** What the report carries as the error. */
  error: string
}) {
  const prompt = useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    if (!state || state.session.origin === 'subagent') return null
    const { status } = state.session
    // Checked first, so a streaming turn never walks the thread here.
    if (status !== 'ready' && status !== 'closed') return null
    const turn = retryableTurn(state)
    return turn?.notice.id === entryId ? turn.prompt : null
  })
  const agentId = useThreadsStore((s) => s.replicas[sessionId]?.state?.session.agentId)
  const hostId = useSessionsStore((s) => {
    const summary = s.byId[sessionId]
    return summary ? hostOfSession(summary) : null
  })
  const [retrying, setRetrying] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  if (!prompt) return null
  const retry = () => {
    setRetrying(true)
    setFailed(null)
    // Held after a success: the actions go once the turn that starts reaches the replica.
    retryTurn(sessionId, prompt.content).catch((e: unknown) => {
      setFailed(errorMessage(e))
      setRetrying(false)
    })
  }
  return (
    <>
      <FailedActions
        className="col-start-2 mt-2"
        onRetry={retry}
        retrying={retrying}
        report={{ hostId, sessionId, ...(agentId ? { agentId } : {}) }}
        error={error}
      />
      {failed && <p className="col-start-2 mt-1 text-small text-danger">{failed}</p>}
    </>
  )
}
