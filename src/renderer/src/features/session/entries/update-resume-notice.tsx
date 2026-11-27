import { useState } from 'react'
import { Alert02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { errorMessage, host } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { useThreadsStore } from '@renderer/stores/threads'
import { canManualResumeUpdate } from './update-resume'

/**
 * Notice shown when a session interrupted by an update restart could not resume automatically.
 * Explains why and offers a one-click button to send a manual continue prompt.
 */
export function UpdateResumeBlockedNotice({
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
  const resumable = useThreadsStore((s) =>
    canManualResumeUpdate(s.replicas[sessionId]?.state, entryId),
  )
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resume = () => {
    setSending(true)
    setError(null)
    // Kept disabled once a turn begins; cleared if the call fails or only queues a paused item.
    host('sessions.queue', {
      sessionId,
      content: [{ type: 'text', text: t('thread.continuePrompt') }],
    })
      .then((result) => {
        if (result.itemId !== null) setSending(false)
      })
      .catch((e: unknown) => {
        setError(errorMessage(e))
        setSending(false)
      })
  }
  const hasDetail = Boolean(description || error)
  return (
    <Alert variant="warning" className={cn('ks-notice py-2', className)}>
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.9} aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      {description && (
        <AlertDescription
          className="col-start-2 text-small break-words whitespace-pre-wrap"
          data-selectable=""
        >
          {description}
        </AlertDescription>
      )}
      {error && (
        <AlertDescription className="col-start-2 text-small text-danger">{error}</AlertDescription>
      )}
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
