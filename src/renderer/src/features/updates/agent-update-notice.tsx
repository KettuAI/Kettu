import { BotIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { errorMessage, host } from '@renderer/lib/host'
import { harnessOf } from '@shared/thread'
import { openHarnessSettings, openSettings } from '@renderer/stores/view'
import { agentUpdateLabel, type AgentUpdateNotice } from './agent-updates'
import { NoticeCard, NoticeVersion } from './update-notice'

/** A newer Claude Code or Codex, or adapter, as a card in the sidebar's notices. */
export function AgentUpdateCard({ notice }: { notice: AgentUpdateNotice }) {
  const { t } = useTranslation('updates')

  const open = () => {
    if (notice.kind === 'one') openHarnessSettings(harnessOf(notice.agentId))
    else openSettings('harnesses')
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
    <NoticeCard
      icon={
        notice.kind === 'one' ? (
          <AgentMark agent={notice.agentId} size={14} />
        ) : (
          <BotIcon className="size-3.5 text-icon" />
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
