import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import { unarchiveSession } from '@renderer/app/actions'
import { AgentTile } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { toast } from '@renderer/components/ui/toast'
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
      toast(t('archived.restored', { project: where }))
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <div className="pl-1">
      <RowLine
        text={
          <div className="flex min-w-0 items-center gap-3">
            <AgentTile agent={summary.agentId} size={30} glyph={16} />
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
        <Button variant="outline" size="sm" onClick={() => void restore()}>
          {t('archived.restore')}
        </Button>
        <Button
          variant="quiet"
          size="sm"
          className="text-danger hover:bg-danger-tint hover:text-danger aria-expanded:bg-danger-tint aria-expanded:text-danger"
          onClick={() => setDeleting(true)}
        >
          {t('archived.delete')}
        </Button>
      </RowLine>
      <DeleteSessionDialog
        sessionId={summary.id}
        title={title}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={() => toast(t('archived.deleted'))}
      />
    </div>
  )
}
