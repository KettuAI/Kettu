import { useState } from 'react'
import { Clock01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { retryableTurn } from '@shared/thread'
import { retryTurn } from '@renderer/app/actions'
import { Button } from '@renderer/components/ui/button'
import { toast } from '@renderer/components/ui/toast'
import { limitPhrase, resetTime } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
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
        origin="turn"
        error={error}
      />
      {failed && <p className="col-start-2 mt-1 text-small text-danger">{failed}</p>}
    </>
  )
}

/**
 * Under the notice of a turn that a used-up plan window stopped: when Kettu sends the session a
 * message to carry on, or that the user stopped it. Only the thread's last error notice shows it.
 */
export function LimitContinueLine({ sessionId, entryId }: { sessionId: string; entryId: string }) {
  const { t } = useTranslation('session')
  const lastTurn = useSessionsStore((s) => s.byId[sessionId]?.lastTurn)
  const latest = useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    if (!state) return false
    if (state.session.status !== 'ready' && state.session.status !== 'closed') return false
    const { order, byId } = state
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const entry = byId[order[i]!]
      if (entry?.kind === 'notice' && entry.severity === 'error') return entry.id === entryId
    }
    return false
  })
  const [stopping, setStopping] = useState(false)
  const at = lastTurn?.reason === 'limit' ? lastTurn.continuesAt : undefined
  if (!latest || at === undefined) return null
  const limit = lastTurn?.limit ? limitPhrase(lastTurn.limit) : ''
  const stop = (): void => {
    setStopping(true)
    host('sessions.cancelContinue', { sessionId })
      .catch(() => toast(t('continueLimit.cancelFailed')))
      .finally(() => setStopping(false))
  }
  return (
    <div className="ks-settings-line col-start-2 mt-1" data-selectable="">
      <HugeiconsIcon icon={Clock01Icon} strokeWidth={1.9} aria-hidden className="size-3 shrink-0" />
      {typeof at === 'number' ? (
        <>
          <span className="min-w-0 truncate">
            {t('continueLimit.planned', { time: resetTime(at), limit })}
          </span>
          <Button variant="quiet" size="xs" disabled={stopping} onClick={stop}>
            {t('continueLimit.cancel')}
          </Button>
        </>
      ) : (
        <span className="min-w-0 truncate">{t('continueLimit.off')}</span>
      )}
    </div>
  )
}
