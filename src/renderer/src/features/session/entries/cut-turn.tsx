import { useState } from 'react'
import { AlertCircleIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useThreadsStore } from '@renderer/stores/threads'
import { inLatestTurn } from '../turn-phase'

/**
 * The line that ends a turn the agent's exit cut short. While it ends the latest turn and the
 * session is free, **Resume** sends "Continue" through the queue, which attaches the session.
 */
export function CutTurnEnd({
  sessionId,
  entryId,
  title,
  description,
  className,
}: {
  sessionId: string
  entryId: string
  title: string
  description?: string
  className?: string
}) {
  const { t } = useTranslation('session')
  const resumable = useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    if (!state || state.session.origin !== 'user') return false
    const { status } = state.session
    return (status === 'ready' || status === 'closed') && inLatestTurn(state, entryId)
  })
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resume = () => {
    setSending(true)
    setError(null)
    // Held after a success: the button goes once the turn that starts reaches the replica.
    host('sessions.queue', {
      sessionId,
      content: [{ type: 'text', text: t('thread.continuePrompt') }],
    }).catch((e: unknown) => {
      setError(errorMessage(e))
      setSending(false)
    })
  }
  const hasDetail = Boolean(description || error)
  return (
    <Alert variant="error" className={cn('ks-notice py-2', className)}>
      <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={1.9} aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      {description && (
        <AlertDescription
          className="col-start-2 text-small break-words whitespace-pre-wrap"
          data-selectable=""
        >
          {description}
        </AlertDescription>
      )}
      {error && <AlertDescription className="col-start-2 text-small">{error}</AlertDescription>}
      {resumable && (
        <AlertAction className={hasDetail ? 'top-2' : 'top-1/2 -translate-y-1/2'}>
          <Button size="xs" variant="outline" disabled={sending} onClick={resume}>
            {t('thread.resume')}
          </Button>
        </AlertAction>
      )}
    </Alert>
  )
}
