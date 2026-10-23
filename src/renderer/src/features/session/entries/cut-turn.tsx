import { useState } from 'react'
import { CircleAlertIcon } from 'lucide-react'
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
  className,
}: {
  sessionId: string
  entryId: string
  title: string
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
  return (
    <Alert variant="error" className={cn('py-2 text-small', className)}>
      <CircleAlertIcon />
      <AlertTitle>{title}</AlertTitle>
      {error && <AlertDescription className="text-small">{error}</AlertDescription>}
      {resumable && (
        <AlertAction className="top-1/2 -translate-y-1/2">
          <Button size="xs" variant="outline" disabled={sending} onClick={resume}>
            {t('thread.resume')}
          </Button>
        </AlertAction>
      )}
    </Alert>
  )
}
