import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import { unarchiveSession } from '@renderer/app/actions'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { DeleteSessionDialog } from '@renderer/features/sidebar/session-menu'
import { errorMessage } from '@renderer/lib/host'
import { longAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { sessionTitle } from '@renderer/stores/sessions'
import { RowLine, RowText } from './rows'
import { ControlError } from './controls'

export function ArchivedRow({ summary, where }: { summary: SessionSummary; where: string }) {
  const { t } = useTranslation('settings')
  const now = useNow()
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const title = sessionTitle(summary)
  const restore = async () => {
    setError(null)
    try {
      await unarchiveSession(summary.id)
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <div className="px-1">
      <RowLine
        text={
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="grid h-5 shrink-0 place-items-center">
              <AgentMark agent={summary.agentId} size={14} />
            </span>
            <RowText
              name={<span className="block truncate">{title}</span>}
              description={t('archived.description', {
                project: where,
                when: summary.archivedAt ? longAgo(summary.archivedAt, now) : '',
              })}
            />
          </div>
        }
      >
        <ControlError error={error} />
        <Button variant="outline" size="compact" onClick={() => void restore()}>
          {t('archived.restore')}
        </Button>
        <Button variant="destructive" size="compact" onClick={() => setDeleting(true)}>
          {t('archived.delete')}
        </Button>
      </RowLine>
      <DeleteSessionDialog
        sessionId={summary.id}
        title={title}
        open={deleting}
        onOpenChange={setDeleting}
      />
    </div>
  )
}
