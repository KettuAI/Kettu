import { BotIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { errorMessage, host } from '@renderer/lib/host'
import { openAgentSettings, openSettings } from '@renderer/stores/view'
import { agentUpdateLabel, type AgentUpdateNotice } from './agent-updates'
import { NoticeRow, NoticeVersion } from './update-notice'

/** A newer Claude Code or Codex, or adapter, as a row in the sidebar's notices. */
export function AgentUpdateRow({ notice }: { notice: AgentUpdateNotice }) {
  const { t } = useTranslation('updates')

  const open = () => {
    if (notice.kind === 'one') openAgentSettings(notice.agentId)
    else openSettings('agents')
  }

  const dismiss = () => {
    const agentIds = notice.kind === 'one' ? [notice.agentId] : notice.agentIds
    for (const agentId of agentIds) {
      void host('agents.skipUpdate', { agentId }).catch((error: unknown) =>
        console.warn(`Could not skip the agent update: ${errorMessage(error)}`),
      )
    }
  }

  return (
    <NoticeRow
      icon={
        notice.kind === 'one' ? (
          <AgentMark agent={notice.agentId} size={16} />
        ) : (
          <BotIcon className="size-4 text-icon" />
        )
      }
      text={
        notice.kind === 'one' ? (
          <>
            {t('agentNotice.one', { name: notice.name })}{' '}
            <NoticeVersion>{notice.version}</NoticeVersion>
          </>
        ) : (
          <>
            {t('agentNotice.many')} <NoticeVersion>{notice.agentIds.length}</NoticeVersion>
          </>
        )
      }
      label={agentUpdateLabel(notice)}
      detail={t('agentNotice.detail')}
      onOpen={open}
      onDismiss={dismiss}
    />
  )
}
