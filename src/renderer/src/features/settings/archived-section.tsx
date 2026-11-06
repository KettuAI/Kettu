import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import { unarchiveSession } from '@renderer/app/actions'
import { AgentTile } from '@renderer/components/agents/agent-mark'
import { toast } from '@renderer/components/ui/toast'
import { DeleteSessionDialog } from '@renderer/features/sidebar/session-menu'
import { errorMessage } from '@renderer/lib/host'
import { mediumAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { sessionTitle } from '@renderer/stores/sessions'
import { ItemLine, Thing } from './rows'
import { ControlError, DangerButton, SetButton } from './controls'

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
    <div className="ui-sg-row">
      <Thing
        mark={<AgentTile agent={summary.agentId} size={32} />}
        name={<span className="k-name">{title}</span>}
      >
        <ItemLine>
          {t('archived.description', {
            project: where,
            when: summary.archivedAt ? mediumAgo(summary.archivedAt, now) : '',
          })}
        </ItemLine>
      </Thing>
      <ControlError error={error} />
      <span className="ui-sg-control">
        <SetButton onClick={() => void restore()}>{t('archived.restore')}</SetButton>
        <DangerButton onClick={() => setDeleting(true)}>{t('archived.delete')}</DangerButton>
      </span>
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
