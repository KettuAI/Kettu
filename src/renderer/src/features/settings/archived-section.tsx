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
import { ItemLine } from './rows'
import { ControlError, GROUP_ACTION, ROW_BUTTON } from './controls'

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
    <div className="flex items-center gap-3.5 py-3.25">
      <AgentTile agent={summary.agentId} size={22} glyph={13} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-label leading-[normal]">{title}</span>
        <ItemLine>
          {t('archived.description', {
            project: where,
            when: summary.archivedAt ? longAgo(summary.archivedAt, now) : '',
          })}
        </ItemLine>
      </div>
      <ControlError error={error} />
      <Button className={ROW_BUTTON} variant="outline" onClick={() => void restore()}>
        {t('archived.restore')}
      </Button>
      <Button variant="ghost" className={GROUP_ACTION} onClick={() => setDeleting(true)}>
        {t('archived.delete')}
      </Button>
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
